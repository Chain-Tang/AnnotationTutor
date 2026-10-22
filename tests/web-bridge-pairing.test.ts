import http from "node:http";
import { parseAskPayload } from "../src/web-bridge/protocol.js";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipperPairingStore, clipperDigest, type ClipperClient, type ClipperApproval } from "../src/web-bridge/pairing.js";
import { WebBridgeServer, type WebBridgeOptions, type ClipperRequestReceipt } from "../src/web-bridge/server.js";

const origin="chrome-extension://abcdefghijklmnop",otherOrigin="chrome-extension://ponmlkjihgfedcba";
const proof=()=>randomBytes(32).toString("hex");
function makeStore(now?:()=>number){
  let records:ClipperClient[]=[];
  const persist=vi.fn(async(clients:ClipperClient[])=>{records=structuredClone(clients);});
  const auth=new ClipperPairingStore({vaultId:"test-vault",targetDirectory:"Clippings",clients:[],persist,...(now?{now}:{})});
  return {auth,persist,records:()=>records};
}
async function grant(auth:ClipperPairingStore,capabilities:ClipperApproval["capabilities"]=["capture","ask"],extensionOrigin=origin){
  const secret=proof(),challenge=auth.request({v:2,name:"Untrusted display name",capabilities,proofHash:clipperDigest(secret)},extensionOrigin);
  auth.approve(challenge.challengeId,{capabilities,targetDirectory:"Approved"});
  const result=await auth.claim(challenge.challengeId,secret,extensionOrigin);if(result.state!=="paired")throw new Error("grant not approved");return result;
}
describe("Clipper host approval",()=>{
  it("name and extension origin create only a challenge; host persists only independent token hashes",async()=>{
    const {auth,persist,records}=makeStore(),secret=proof();
    const challenge=auth.request({v:2,name:"Tutor trusted admin",capabilities:["capture","ask"],proofHash:clipperDigest(secret)},origin);
    expect(challenge).not.toHaveProperty("token");
    expect(await auth.claim(challenge.challengeId,secret,origin)).toMatchObject({state:"pending"});expect(persist).not.toHaveBeenCalled();
    auth.approve(challenge.challengeId,{capabilities:["capture"],targetDirectory:"Only here"});
    const one=await auth.claim(challenge.challengeId,secret,origin);if(one.state!=="paired")throw new Error("not paired");
    const two=await grant(auth);expect(one.token).not.toBe(two.token);
    expect(JSON.stringify(records())).not.toContain(one.token);expect(records()[0]?.tokenHash).toBe(clipperDigest(one.token));
    expect(auth.authorize(`Bearer ${one.token}`,origin,"capture").targetDirectory).toBe("Only here");
    expect(()=>auth.authorize(`Bearer ${one.token}`,origin,"ask")).toThrow("capability-not-granted");
    expect(()=>auth.authorize(`Bearer ${one.token}`,otherOrigin)).toThrow("unauthorized");
    expect(()=>auth.authorize("Bearer old-shared-token",origin)).toThrow("unauthorized");
    await expect(auth.claim(challenge.challengeId,secret,origin)).rejects.toThrow("pairing-consumed");
  });
  it("rejects stolen challenge ids, denied/expired approval, expansion and pairing floods",async()=>{
    let now=Date.now();const {auth}=makeStore(()=>now),secret=proof();
    const challenge=auth.request({v:2,name:"Browser",capabilities:["capture"],proofHash:clipperDigest(secret)},origin);
    await expect(auth.claim(challenge.challengeId,proof(),origin)).rejects.toThrow("pairing-proof-denied");
    await expect(auth.claim(challenge.challengeId,secret,otherOrigin)).rejects.toThrow("pairing-proof-denied");
    expect(()=>auth.approve(challenge.challengeId,{capabilities:["ask"],targetDirectory:"A"})).toThrow("capability-expansion-denied");
    auth.approve(challenge.challengeId,null);await expect(auth.claim(challenge.challengeId,secret,origin)).rejects.toThrow("pairing-denied");
    now+=300000;await expect(auth.claim(challenge.challengeId,secret,origin)).rejects.toThrow("pairing-expired");
    for(let i=0;i<3;i++)auth.request({v:2,name:"Browser",capabilities:["capture"],proofHash:clipperDigest(secret)},origin);
    expect(()=>auth.request({v:2,name:"Browser",capabilities:["capture"],proofHash:clipperDigest(secret)},origin)).toThrow("pairing-rate-limited");
  });
  it("does not disclose tokens before successful persistence and keeps revocation effective on save failure",async()=>{
    const {auth,persist}=makeStore();const client=await grant(auth);const revoked=vi.fn();auth.subscribeRevocations(revoked);
    persist.mockRejectedValueOnce(new Error("disk full"));await expect(auth.revoke(client.clientId)).rejects.toThrow("disk full");
    expect(revoked).toHaveBeenCalledWith(client.clientId);expect(()=>auth.authorize(`Bearer ${client.token}`,origin)).toThrow("authorization-storage-unavailable");
    persist.mockRejectedValueOnce(new Error("disk still full"));await expect(auth.revoke(client.clientId)).rejects.toThrow("disk still full");
    await auth.revoke(client.clientId);expect(auth.persistenceBlocked).toBe(false);expect(()=>auth.authorize(`Bearer ${client.token}`,origin)).toThrow("unauthorized");
    const secret=proof(),challenge=auth.request({v:2,name:"Browser",capabilities:["ask"],proofHash:clipperDigest(secret)},origin);
    auth.approve(challenge.challengeId,{capabilities:["ask"],targetDirectory:"A"});persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(auth.claim(challenge.challengeId,secret,origin)).rejects.toThrow("disk full");expect(auth.listClients()).toHaveLength(1);
  });
});
const servers:WebBridgeServer[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>server.stop()));});
async function host(options:Partial<WebBridgeOptions>={}){
  const store=makeStore();let records:ClipperRequestReceipt[]=structuredClone([...(options.requestJournal?.records??[])]);
  const persist=vi.fn(async(value:ClipperRequestReceipt[])=>{records=structuredClone(value);});
  const server=new WebBridgeServer({port:0,auth:store.auth,onPairingRequest:async()=>null,requestJournal:{records,persist},onCapture:()=>{},...options});servers.push(server);await server.start();
  const auth=options.auth??store.auth;
  const client=await grant(auth);
  const send=(path:string,init:RequestInit={},token=client.token)=>fetch(`http://127.0.0.1:${server.port}${path}`,{...init,headers:{Origin:origin,Authorization:`Bearer ${token}`,...init.headers}});
  return {server,auth,client,send,records:()=>records,persist,authPersist:store.persist};
}
const ask=(requestId=randomUUID(),question="Explain this synthetic passage")=>({v:1,kind:"ask",requestId,url:"https://example.com/test",title:"Synthetic",question,markdown:"Synthetic material"});
const capture=(requestId=randomUUID())=>({v:1,kind:"selection",requestId,url:"https://example.com",title:"Synthetic",capturedAt:new Date().toISOString(),markdown:"text",selections:[{exact:"text",prefix:"",suffix:""}]});
const post=(body:unknown,signal?:AbortSignal):RequestInit=>({method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),...(signal?{signal}:{})});
async function waitFor(check:()=>boolean){await vi.waitFor(()=>expect(check()).toBe(true),{timeout:1500,interval:5});}

describe("Clipper HTTP isolation and task lifecycle",()=>{
  it("fails closed for old configuration and never auto-approves a fixed marker",async()=>{
    await expect(new WebBridgeServer({port:0,token:"old-shared-token",onCapture:()=>{}}).start()).rejects.toThrow("clipper-explicit-pairing-not-configured");
    let approve!:(value:ClipperApproval|null)=>void;
    const h=await host({onPairingRequest:()=>new Promise(resolve=>{approve=resolve;})});
    const secret=proof();const response=await h.send("/pair",{...post({v:2,name:"Trusted admin",capabilities:["capture"],proofHash:clipperDigest(secret)}),headers:{"Content-Type":"application/json","X-Tutor-Bridge-Client":"tutor-advanced-clipper-v1"}});
    expect(response.status).toBe(202);const challenge=await response.json() as {challengeId:string};expect(challenge).not.toHaveProperty("token");
    expect((await h.send("/pair/claim",post({challengeId:challenge.challengeId,proof:secret}))).status).toBe(202);
    approve({capabilities:["capture"],targetDirectory:"Approved"});
    const paired=await h.send("/pair/claim",post({challengeId:challenge.challengeId,proof:secret}));expect(paired.status).toBe(200);
    expect((await h.send("/ping",{},"old-shared-token")).status).toBe(401);
    expect((await h.send("/ping",{headers:{Origin:"https://example.com"}})).status).toBe(403);
    expect(await new Promise<number|undefined>((resolve,reject)=>{const request=http.get({hostname:"127.0.0.1",port:h.server.port!,path:"/ping",headers:{Host:"evil.example",Origin:origin}},response=>{response.resume();resolve(response.statusCode);});request.on("error",reject);})).toBe(421);
  });
  it("separates capture and ask, deduplicates requests and scopes handles by client",async()=>{
    const onAsk=vi.fn<NonNullable<WebBridgeOptions["onAsk"]>>(async(_payload,emit)=>emit({type:"done",text:"Synthetic answer"}));
    const h=await host({onAsk});const captureOnly=await grant(h.auth,["capture"]);
    expect((await h.send("/ask",post(ask()),captureOnly.token)).status).toBe(403);
    const payload=ask();const result=await h.send("/ask",post(payload));expect(await result.text()).toContain('"type":"done"');
    expect(await (await h.send("/ask",post(payload))).json()).toMatchObject({state:"completed",replayed:true});expect(onAsk).toHaveBeenCalledTimes(1);
    expect((await h.send("/ask",post({...payload,question:"different"}))).status).toBe(409);
    expect((await h.send(`/requests/${payload.requestId}`,{},captureOnly.token)).status).toBe(404);
    expect((await h.send(`/requests/${payload.requestId}/cancel`,{method:"POST"},captureOnly.token)).status).toBe(404);
  });
  it("disconnect aborts the provider signal and reconnect queries never restart it",async()=>{
    let signal:AbortSignal|undefined;
    const onAsk=vi.fn<NonNullable<WebBridgeOptions["onAsk"]>>(async(_payload,_emit,context)=>{signal=context.signal;await new Promise<void>(resolve=>context.signal.addEventListener("abort",()=>resolve(),{once:true}));});
    const h=await host({onAsk}),payload=ask(),controller=new AbortController();
    const response=await h.send("/ask",post(payload,controller.signal));await waitFor(()=>!!signal);controller.abort();await response.text().catch(()=>{});
    await waitFor(()=>signal!.aborted);await waitFor(()=>h.records().some(record=>record.requestId===payload.requestId&&record.state==="cancelled"));
    expect(await (await h.send(`/requests/${payload.requestId}`)).json()).toMatchObject({state:"cancelled"});
    await h.send("/ask",post(payload));expect(onAsk).toHaveBeenCalledTimes(1);
  });
  it("limits a client to one running task, vault to two, and removes a cancelled queued request",async()=>{
    const releases=new Map<string,()=>void>();const started:string[]=[];
    const onAsk=vi.fn<NonNullable<WebBridgeOptions["onAsk"]>>(async(payload,emit,context)=>{started.push(payload.requestId!);await new Promise<void>(resolve=>{releases.set(payload.requestId!,resolve);context.signal.addEventListener("abort",()=>resolve(),{once:true});});emit({type:"done",text:"answer"});});
    const h=await host({onAsk}),second=await grant(h.auth),third=await grant(h.auth);
    const first=ask(),queued=ask(),two=ask(),three=ask();
    const streams=await Promise.all([h.send("/ask",post(first)),h.send("/ask",post(queued)),h.send("/ask",post(two),second.token),h.send("/ask",post(three),third.token)]);
    await waitFor(()=>started.length===2);expect(started).toEqual(expect.arrayContaining([first.requestId,two.requestId]));
    await h.send(`/requests/${queued.requestId}/cancel`,{method:"POST"});releases.get(first.requestId)!();
    await waitFor(()=>started.includes(three.requestId));expect(started).not.toContain(queued.requestId);
    releases.get(two.requestId)!();releases.get(three.requestId)!();await Promise.all(streams.map(stream=>stream.text()));
  });
  it("revocation and service stop cancel running work without accepting late results",async()=>{
    let signal:AbortSignal|undefined;
    const h=await host({onAsk:async(_payload,emit,context)=>{signal=context.signal;await new Promise<void>(resolve=>context.signal.addEventListener("abort",()=>resolve(),{once:true}));emit({type:"done",text:"late answer"});}});
    const response=await h.send("/ask",post(ask()));await waitFor(()=>!!signal);await h.auth.revoke(h.client.clientId);
    expect(signal!.aborted).toBe(true);expect(await response.text()).not.toContain("late answer");expect((await h.send("/ping")).status).toBe(401);
    const h2=await host({onAsk:async(_p,_e,context)=>{signal=context.signal;await new Promise<void>(resolve=>context.signal.addEventListener("abort",()=>resolve(),{once:true}));}});
    signal=undefined;const response2=await h2.send("/ask",post(ask()));await waitFor(()=>!!signal);await h2.server.stop();expect(signal!.aborted).toBe(true);await response2.text().catch(()=>{});
  });
  it("persists interrupted work on restart and refuses durable replay or journal failure",async()=>{
    const {auth}=makeStore(),client=await grant(auth),payload=ask();let stored:ClipperRequestReceipt[]=[{clientId:client.clientId,requestId:payload.requestId,digest:clipperDigest(JSON.stringify(parseAskPayload(payload))),kind:"ask",state:"running",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}];
    const onAsk=vi.fn();const h=await host({auth,onAsk,requestJournal:{records:stored,persist:async(value)=>{stored=value;}}});
    expect(stored[0]?.state).toBe("interrupted");const response=await h.send(`/requests/${payload.requestId}`,{},client.token);expect(await response.json()).toMatchObject({state:"interrupted"});
    // Querying or replaying the original body must never invoke a provider.
    const replay=await h.send("/ask",post(payload),client.token);expect((await replay.json() as {replayed?:boolean}).replayed).toBe(true);expect(onAsk).not.toHaveBeenCalled();
    const h2=await host({onAsk});h2.persist.mockRejectedValueOnce(new Error("disk full"));expect((await h2.send("/ask",post(ask()))).status).toBe(500);expect(onAsk).not.toHaveBeenCalled();
  });
  it("limits request rates and bodies before invoking a provider",async()=>{
    const onAsk=vi.fn<NonNullable<WebBridgeOptions["onAsk"]>>(async(_payload,emit)=>emit({type:"done",text:"answer"}));
    const h=await host({onAsk});
    const oversized=await h.send("/ask",post(ask(randomUUID(),"x".repeat(2*1024*1024))));expect(oversized.status).toBe(413);expect(onAsk).not.toHaveBeenCalled();
    for(let i=0;i<9;i++)await (await h.send("/ask",post(ask()))).text();
    expect((await h.send("/ask",post(ask()))).status).toBe(429);expect(onAsk).toHaveBeenCalledTimes(9);
    expect((await h.send("/pair",post({name:"x".repeat(8192)}))).status).toBe(413);
  });
  it("stops the service if revocation cannot be persisted and never reports a false success",async()=>{
    const h=await host();h.authPersist.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.auth.revoke(h.client.clientId)).rejects.toThrow("disk full");
    await waitFor(()=>!h.server.running);expect(h.auth.persistenceBlocked).toBe(true);
    expect(()=>h.auth.authorize(`Bearer ${h.client.token}`,origin)).toThrow("authorization-storage-unavailable");
  });
  it("distinguishes no write, partial write and completed capture after a later exception",async()=>{
    for(const stage of ["none","applied","committed"] as const){
      const onCapture=vi.fn<NonNullable<WebBridgeOptions["onCapture"]>>(async(_payload,context)=>{
        if(stage!=="none")context.markApplied();
        if(stage==="committed")context.markCommitted();
        throw new Error(stage==="committed"?"openFile or analysis failed":"capture write failed");
      });
      const h=await host({onCapture}),payload=capture();
      const response=await h.send("/capture",post(payload)),state=stage==="committed"?"completed":stage==="applied"?"outcome-unknown":"failed";
      expect(await response.json()).toMatchObject({ok:stage==="committed",state,requestId:payload.requestId});
      expect(response.status).toBe(stage==="committed"?200:409);
      expect(h.records().find(item=>item.requestId===payload.requestId)?.state).toBe(state);
      const replay=await h.send("/capture",post(payload));expect(await replay.json()).toMatchObject({state,replayed:true});expect(onCapture).toHaveBeenCalledTimes(1);
    }
  });
  it("does not report an uncommitted callback return as a complete capture",async()=>{
    const h=await host({onCapture:(_payload,context)=>{context.markApplied();}});
    expect(await (await h.send("/capture",post(capture()))).json()).toMatchObject({ok:false,state:"outcome-unknown"});
  });
  it("keeps partial writes outcome-unknown on cancel and drains in-flight writes before stop resolves",async()=>{
    let release!:()=>void,started=false;
    const h=await host({onCapture:async(_payload,context)=>{
      context.markApplied();started=true;await new Promise<void>(resolve=>{release=resolve;});throw new Error("cancelled after partial write");
    }});
    const payload=capture(),response=h.send("/capture",post(payload)).then(value=>value.json()).catch(()=>null);await waitFor(()=>started);
    let stopped=false;const stopping=h.server.stop().then(()=>{stopped=true;});
    await waitFor(()=>h.records().some(item=>item.requestId===payload.requestId&&item.state==="outcome-unknown"));
    expect(stopped).toBe(false);release();await stopping;await response;
    expect(h.records().find(item=>item.requestId===payload.requestId)?.state).toBe("outcome-unknown");
  });
  it("does not let a stopped instance reset its journal from stale constructor records",async()=>{
    const h=await host({onCapture:(_payload,context)=>context.markCommitted()}),payload=capture();
    await (await h.send("/capture",post(payload))).json();await h.server.stop();
    await expect(h.server.start()).rejects.toThrow("clipper-bridge-instance-not-reusable");
    expect(h.records()).toEqual([expect.objectContaining({requestId:payload.requestId,state:"completed"})]);
  });
  it("records an already durable capture as completed after disconnect",async()=>{
    let signal:AbortSignal|undefined;
    const h=await host({onCapture:async(_payload,context)=>{signal=context.signal;context.markCommitted();await new Promise<void>(resolve=>context.signal.addEventListener("abort",()=>resolve(),{once:true}));}});
    const controller=new AbortController(),requestId=randomUUID();const response=h.send("/capture",post({v:1,kind:"selection",requestId,url:"https://example.com",title:"Synthetic",capturedAt:new Date().toISOString(),markdown:"text",selections:[{exact:"text",prefix:"",suffix:""}]},controller.signal)).catch(()=>null);
    await waitFor(()=>!!signal);controller.abort();await response;await waitFor(()=>h.records().some(item=>item.requestId===requestId&&item.state==="completed"));
  });
});
