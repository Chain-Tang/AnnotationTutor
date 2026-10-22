import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TutorCommunicationController, type TutorCommunicationControllerOptions, type CommunicationPeerClient } from "../src/tutor-communication-controller.js";
import { TutorCommunicationHub, type CommunicationTutorScope } from "../src/tutor-communication-hub.js";
import { communicationFailureDetail, type CommunicationContextInput, type CommunicationIdentity } from "../src/tutor-communication.js";
import type { TutorClientGrant } from "../src/tutor-mcp.js";

const instanceId="a".repeat(24),vaultId="7e3b4f12-b87e-4ac6-8ef0-3c2f0ac84220";
const local:CommunicationIdentity={kind:"tutor",vaultId,agentId:`tutor-${vaultId}`};
const remote:CommunicationIdentity={kind:"tutor",vaultId:"remote-vault",agentId:"remote-tutor"};
const former:CommunicationIdentity={kind:"tutor",vaultId:"former-vault",agentId:"former-tutor"};
const context:CommunicationContextInput={goal:"Teach process and relationship",background:"A beginner has read Pirsig",summary:"Do not infer acceptance of suggestions",sources:[{vaultId:"remote-vault",path:"self.md",revision:"r1"}]};
const grant=(identity:CommunicationIdentity,clientId="paired")=>({clientId,read:true,write:false,targets:[],humanObjectIds:[],learningMemory:false,name:"Paired Tutor",documents:[],createdAt:"2026-10-17T00:00:00Z",communication:true,communicationIdentity:identity}) as TutorClientGrant;
const closers:{close():Promise<void>}[]=[];
afterEach(async()=>{for(const closer of closers.splice(0))await closer.close().catch(()=>{});});
const memoryIO=(files:Map<string,string>)=>({read:async(path:string)=>files.get(path)??null,compareWrite:async(path:string,previous:string|null,next:string)=>{if((files.get(path)??null)!==previous)throw Error("cas-conflict");files.set(path,next);}});

async function fixture(input:{context?:CommunicationContextInput;credentialFailure?:boolean;peerAvailable?:boolean}={}){
 const stateFiles=new Map<string,string>([["communication-identity.json",JSON.stringify({version:1,vaultId})]]),localFiles=new Map<string,string>(),remoteFiles=new Map<string,string>();
 const modelCalls:{prompt:string;context:string;signal:AbortSignal;scope:CommunicationTutorScope}[]=[],requests:{name:string;args:Record<string,unknown>}[]=[],records=new Map([[instanceId,{instanceId,name:"Remote Tutor"}]]);
 let credentialFailure=input.credentialFailure??false,paired=0,peerCreations=0;
 let runner=async(prompt:string,material:string,signal:AbortSignal,scope:CommunicationTutorScope)=>{modelCalls.push({prompt,context:material,signal,scope});return "Local Tutor answer";};
 let intercept:((name:string,args:Record<string,unknown>,normal:()=>Promise<CallToolResult>)=>Promise<CallToolResult>)|undefined;
 const remoteHub=new TutorCommunicationHub({io:memoryIO(remoteFiles),root:"remote-memory",identity:remote,runTutor:async()=>{throw Error("Unexpected remote model execution");},makeChannel:()=>{throw Error("No Codex creation in this test");}});closers.push(remoteHub);
 await remoteHub.createSpace({spaceId:"shared",title:"Shared",context:input.context??context,members:[{identity:local,read:true,write:true},{identity:former,read:true,write:true}]});
 const credentials={available:()=>input.peerAvailable!==false,list:async()=>{if(credentialFailure)throw Error("encrypted-registry-unreadable");return [...records.values()];},read:async()=>undefined,write:async()=>{},revoke:async(id:string)=>{records.delete(id);},flush:async()=>{}};
 const options:TutorCommunicationControllerOptions={app:{vault:{getName:()=>"Local Vault"},workspace:{openLinkText:async()=>{}}} as unknown as App,root:"local-memory",state:memoryIO(stateFiles),vaultPath:"/test/local-vault",command:"not-used",pairings:()=>[{grant:grant(remote),tokenHash:"never-a-real-token"}],runTutor:(...args)=>runner(...args),io:memoryIO(localFiles),credentials,pollIntervalMs:false,discover:async()=>[{id:instanceId,name:"Remote Tutor",port:32123,pid:1,identity:remote}],makeChannel:()=>{throw Error("No Codex creation in this test");},makePeer:()=>{
  peerCreations++;let closed=false;
  const peer:CommunicationPeerClient={pair:async()=>{paired++;return {host:remote,caller:local};},close:async()=>{closed=true;},call:async(name,args={},signal)=>{
   signal?.throwIfAborted();if(closed)throw Error("peer-closed");requests.push({name,args});
   const normal=async():Promise<CallToolResult>=>{try{const operation=name.replace("tutor_communication_","");const result=await remoteHub.invoke(grant(local),operation,args,signal??new AbortController().signal);return {content:[],structuredContent:{value:result}};}catch{return {isError:true,content:[]};}};
   return intercept?intercept(name,args,normal):normal();
  }};return peer;
 }};
 const controller=await TutorCommunicationController.create(options);closers.push(controller);
 return {controller,options,remoteHub,modelCalls,requests,records,localFiles,remoteFiles,stateFiles,credentials,peerCreations:()=>peerCreations,paired:()=>paired,setCredentialFailure:(value:boolean)=>{credentialFailure=value;},setRunner:(value:typeof runner)=>{runner=value;},intercept:(value:typeof intercept)=>{intercept=value;},queue:async(id="request",sender=remote)=>remoteHub.send(sender,{spaceId:"shared",recipients:[local],text:"Please review identity",messageId:id})};
}

describe("communication controller authorization and remote consumers",()=>{
 it.each(["model-selection-unconfirmed","provider-access-403","provider-rate-limit-429","provider-error","unknown-error"])("returns a safe %s receipt to the remote host without leaking runtime details or retrying",async prefix=>{
  const f=await fixture(),error=Error(`${prefix}: Bearer sk-secret https://private.example/token model=private-model prompt=private-prompt`);let count=0;
  f.setRunner(async()=>{count++;throw error;});await f.queue();await f.controller.tick();
  expect((await f.remoteHub.core.getMessage(remote,"shared","request")).deliveries[0]).toMatchObject({status:"failed",...communicationFailureDetail(error)});
  expect(f.requests.find(request=>request.name.endsWith("transition")&&request.args.status==="failed")?.args.detail).toEqual(communicationFailureDetail(error));
  expect(f.requests.filter(request=>request.name.endsWith("send"))).toEqual([]);
  expect(JSON.stringify(f.requests)+[...f.localFiles.values(),...f.remoteFiles.values()].join("\n")).not.toMatch(/sk-secret|private\.example|private-model|private-prompt/);
  await f.controller.tick();expect(count).toBe(1);
 });
 it("claims only accepted requests, returns a scoped result, and does not repeat after restart",async()=>{
  const f=await fixture();await f.queue();await f.controller.tick();expect(f.modelCalls).toHaveLength(1);
  expect(f.modelCalls[0]?.scope).toEqual({hostKey:instanceId,spaceId:"shared"});
  const request=await f.remoteHub.core.getMessage(remote,"shared","request");expect(request.deliveries[0]?.status).toBe("completed");
  const responses=(await f.remoteHub.core.mailbox(remote,"shared",{direction:"inbox"})).messages;expect(responses).toHaveLength(1);expect(responses[0]?.envelope).toMatchObject({sender:local,replyTo:"request",contextRevision:1,kind:"result"});
  await f.controller.close();const restarted=await TutorCommunicationController.create(f.options);closers.push(restarted);await restarted.tick();expect(f.modelCalls).toHaveLength(1);
 });
 it("does not execute processing tasks or auto-answer a result message",async()=>{
  const f=await fixture();await f.queue("processing");await f.remoteHub.core.transition(local,"shared","processing","processing");
  await f.remoteHub.send(local,{spaceId:"shared",recipients:[remote],text:"Question for host",messageId:"parent"});
  await f.remoteHub.send(remote,{spaceId:"shared",recipients:[local],text:"An answer",messageId:"result",kind:"result",replyTo:"parent"});
  await f.controller.tick();expect(f.modelCalls).toEqual([]);
 });
 it("requires an actual processing acknowledgment before making a model call",async()=>{
  const f=await fixture();await f.queue();f.intercept(async(name,args,normal)=>name.endsWith("transition")&&args.status==="processing"?{isError:true,content:[]}:normal());
  await f.controller.tick();expect(f.modelCalls).toEqual([]);expect((await f.remoteHub.core.getMessage(remote,"shared","request")).deliveries[0]?.status).toBe("accepted");
  expect(f.requests.filter(request=>request.name.endsWith("send"))).toEqual([]);
 });
 it("rejects malformed or wrongly addressed MCP mailbox messages before claiming them",async()=>{
  const f=await fixture();await f.queue();const original=await f.remoteHub.core.getMessage(remote,"shared","request");
  f.intercept(async(name,_args,normal)=>name.endsWith("mailbox")?{content:[],structuredContent:{value:{messages:[{...original,envelope:{...original.envelope,recipients:[former]},deliveries:[{recipient:former,status:"accepted",updatedAt:100}]}]}}}:normal());
  await f.controller.tick();expect(f.modelCalls).toEqual([]);expect(f.requests.filter(request=>request.name.endsWith("transition"))).toEqual([]);
 });
 it("rechecks remote sender permissions after a durable claim and fails revoked requests without execution",async()=>{
  const f=await fixture();await f.queue("revoked",former);await f.remoteHub.setMembers("shared",[{identity:local,read:true,write:true}]);
  await f.controller.tick();expect(f.modelCalls).toEqual([]);expect((await f.remoteHub.core.getMessage(local,"shared","revoked")).deliveries[0]?.status).toBe("failed");
 });
 it("rechecks remote membership before publishing a model result that finished after revocation",async()=>{
  const f=await fixture();await f.queue("revoked-after-start",former);let startResolve=()=>{},finish=(value:string)=>{};const started=new Promise<void>(resolve=>{startResolve=resolve;});
  f.setRunner(async()=>new Promise<string>(resolve=>{finish=resolve;startResolve();}));const pending=f.controller.tick();await started;
  await f.remoteHub.setMembers("shared",[{identity:local,read:true,write:true}]);finish("A completed but no longer authorized result");await pending;
  expect(f.requests.filter(request=>request.name.endsWith("send"))).toEqual([]);expect((await f.remoteHub.core.getMessage(local,"shared","revoked-after-start")).deliveries[0]?.status).toBe("failed");
 });
 it("cancels an active peer model on disconnect and prevents a late result or stale UI reconnect",async()=>{
  const f=await fixture();await f.queue();const entry=(await f.controller.ui().spaces()).find(space=>!space.local)!;
  let startedResolve=()=>{};const started=new Promise<void>(resolve=>{startedResolve=resolve;});let captured:AbortSignal|undefined;
  f.setRunner(async(_prompt,_material,signal)=>new Promise<string>((_resolve,reject)=>{captured=signal;startedResolve();signal.addEventListener("abort",()=>reject(Error("cancelled")),{once:true});}));
  const pending=f.controller.tick();await started;await f.controller.disconnect(instanceId);await pending;
  expect(captured?.aborted).toBe(true);expect(f.records.size).toBe(0);expect(f.requests.filter(request=>request.name.endsWith("send"))).toEqual([]);
  await expect(f.controller.ui().send(entry,remote,"A stale view message")).rejects.toThrow("communication-peer-disconnected");expect(f.peerCreations()).toBe(1);
 });
 it("cancels an active model during shutdown and never sends a late successful result",async()=>{
  const f=await fixture();await f.queue();let startedResolve=()=>{};const started=new Promise<void>(resolve=>{startedResolve=resolve;});let captured:AbortSignal|undefined;
  f.setRunner(async(_prompt,_material,signal)=>new Promise<string>((_resolve,reject)=>{captured=signal;startedResolve();signal.addEventListener("abort",()=>reject(Error("cancelled")),{once:true});}));
  const pending=f.controller.tick();await started;await f.controller.close();await pending;expect(captured?.aborted).toBe(true);
  expect(f.requests.filter(request=>request.name.endsWith("send"))).toEqual([]);expect((await f.remoteHub.core.getMessage(remote,"shared","request")).deliveries[0]?.status).toBe("processing");
 });
 it("fails closed on an unreadable encrypted registry during startup, peer listing and pairing",async()=>{
  const f=await fixture();await f.controller.close();f.setCredentialFailure(true);
  await expect(TutorCommunicationController.create(f.options)).rejects.toThrow("encrypted-registry-unreadable");expect(f.peerCreations()).toBe(1);expect(f.records.size).toBe(1);
  await expect(f.controller.ui().peers()).rejects.toThrow("encrypted-registry-unreadable");
  const fresh=await fixture();fresh.setCredentialFailure(true);await expect(fresh.controller.connect(instanceId)).rejects.toThrow("encrypted-registry-unreadable");expect(fresh.paired()).toBe(0);expect(fresh.records.size).toBe(1);
 });
 it("keeps local Markdown spaces available when secure peer storage capability is unavailable",async()=>{
  const f=await fixture({peerAvailable:false,credentialFailure:true});await f.controller.ui().create("Local study","Understand continuity","Explicitly shared local background");
  expect(await f.controller.hub.localSpaces()).toHaveLength(1);expect(f.peerCreations()).toBe(0);expect(f.records.size).toBe(1);expect(await f.controller.ui().peers()).toEqual([]);
  await expect(f.controller.connect(instanceId)).rejects.toThrow("communication-peer-credentials-unavailable");
 });
 it("labels an oversized model reply as a bounded excerpt rather than a complete answer",async()=>{
  const f=await fixture();f.setRunner(async()=>"答".repeat(17000));await f.queue();await f.controller.tick();
  const result=(await f.remoteHub.core.mailbox(remote,"shared",{direction:"inbox"})).messages[0]!.envelope.payload.text;
  expect(result.length).toBeLessThanOrEqual(16000);expect(result).toContain("[回复已截断至 16000 字符以内；请索取后续内容。]");
 });
 it("marks truncated shared context explicitly and keeps the source revision bound to the request",async()=>{
  const large={...context,sources:Array.from({length:32},(_,index)=>({vaultId:"remote-vault",path:`${index}-${"p".repeat(990)}`,revision:`r${index}`}))};
  const f=await fixture({context:large});await f.queue();await f.controller.tick();expect(f.modelCalls[0]?.context).toContain("[Context excerpt truncated at 24000 characters");
  expect(f.modelCalls[0]?.context).toContain("Shared collaboration context v1");expect(f.modelCalls[0]!.context.length).toBeLessThan(25_000);
 });
 it("rejects a UI caller override and a forged/removed grant without borrowing the host identity",async()=>{
  const f=await fixture();const entry=(await f.controller.ui().spaces()).find(space=>!space.local)!;
  await expect(f.controller.ui().send({...entry,caller:remote},remote,"Spoof sender")).rejects.toThrow("communication-ui-identity-mismatch");
  await expect(f.controller.gateway.identity(grant(local))).rejects.toThrow("communication-reserved-identity");
  await expect(f.controller.gateway.identity(grant(remote,"wrong-client"))).rejects.toThrow("communication-identity-revoked");
  expect(f.requests.filter(request=>request.name.endsWith("send"))).toEqual([]);
 });
});
