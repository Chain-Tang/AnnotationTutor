import http from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { bridgeCorsHeaders, isTrustedBridgeOrigin, parseAskPayload, parseCapturePayload, type AskPayload, type AskStreamEvent, type CapturePayload } from "./protocol.js";
import { ClipperAccessError, ClipperPairingStore, clipperDigest, type ClipperApproval, type ClipperClient, type ClipperPairChallenge } from "./pairing.js";

export const requestReceiptSchema=z.object({clientId:z.string().uuid(),requestId:z.string().uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(["capture","ask"]),
  state:z.enum(["queued","running","completed","cancelled","failed","interrupted","outcome-unknown"]),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export type ClipperRequestReceipt=z.infer<typeof requestReceiptSchema>;
export type ClipperRequestContext={clientId:string;vaultId:string;targetDirectory:string;capabilities:ClipperClient["capabilities"];requestId:string;signal:AbortSignal;
  /** A real write completed, but the full capture may still be incomplete. */ markApplied:()=>void;
  /** The complete capture was durably saved; later UI/analysis failures cannot undo it. */ markCommitted:()=>void};
export type WebBridgeOptions={port:number;/** Deprecated and deliberately never accepted as authority. */token?:string;
  auth?:ClipperPairingStore;
  onPairingRequest?:(challenge:ClipperPairChallenge)=>Promise<ClipperApproval|null>;
  requestJournal?:{records:readonly ClipperRequestReceipt[];persist:(records:ClipperRequestReceipt[])=>Promise<void>};
  onCapture:(payload:CapturePayload,context:ClipperRequestContext)=>Promise<void>|void;
  onAsk?:(payload:AskPayload,emit:(event:AskStreamEvent)=>void,context:ClipperRequestContext)=>Promise<void>|void;
  onError?:(error:unknown)=>void;requestTimeoutMs?:number;
};
type Job={receipt:ClipperRequestReceipt;client:ClipperClient;payload:CapturePayload|AskPayload;abort:AbortController;res:http.ServerResponse;
  active:boolean;effects:boolean;committed:boolean;failure:boolean;finalText?:string;emittedBytes:number;timer?:ReturnType<typeof setTimeout>};
const JSON_HEADERS={"Content-Type":"application/json","Cache-Control":"no-store"};
const keyOf=(clientId:string,requestId:string)=>`${clientId}:${requestId}`;

/** Loopback transport with explicit host approval, durable replay barriers and bounded generation concurrency. */
export class WebBridgeServer {
  private server:http.Server|null=null;
  private sockets=new Set<Socket>();
  private receipts=new Map<string,ClipperRequestReceipt>();
  private jobs=new Map<string,Job>();
  private queue:Job[]=[];
  private runs=new Set<Promise<void>>();
  private active=new Map<string,number>();
  private rates=new Map<string,number[]>();
  private journalTail:Promise<unknown>=Promise.resolve();
  private storageFailed=false;
  private stopped=true;
  private startedOnce=false;
  private stopRevocations?:()=>void;
  private stopFailures?:()=>void;
  constructor(private readonly options:WebBridgeOptions){}
  get running(){return this.server!==null;}
  get port(){const address=this.server?.address();return address&&typeof address==="object"?address.port:null;}
  async start():Promise<void>{
    if(this.server)return;
    // Restart through a new instance loaded from the durable journal. Reusing
    // constructor records here would erase requests written since first start.
    if(this.startedOnce)throw new Error("clipper-bridge-instance-not-reusable");
    this.startedOnce=true;
    if(!this.options.auth||!this.options.onPairingRequest||!this.options.requestJournal)throw new Error("clipper-explicit-pairing-not-configured");
    if(this.options.auth.persistenceBlocked)throw new Error("clipper-authorization-storage-unavailable");
    this.receipts.clear();
    for(const record of z.array(requestReceiptSchema).max(4096).parse(this.options.requestJournal.records)){
      const key=keyOf(record.clientId,record.requestId);if(this.receipts.has(key))throw new Error("clipper-request-identity-conflict");
      this.receipts.set(key,{...record,...(["running","queued"].includes(record.state)?{state:"interrupted" as const,updatedAt:new Date().toISOString()}:{})});
    }
    await this.persist();this.stopped=false;
    this.stopFailures=this.options.auth.subscribePersistenceFailures(()=>{void this.stop();});
    this.stopRevocations=this.options.auth.subscribeRevocations(clientId=>{for(const job of this.jobs.values())if(job.client.clientId===clientId)void this.cancel(job).catch(()=>{});});
    await new Promise<void>((resolve,reject)=>{
      const server=http.createServer((req,res)=>{void this.handle(req,res).catch(()=>this.json(res,500,{ok:false,error:"bridge-request-failed"}));});
      server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
      server.on("connection",socket=>{this.sockets.add(socket);socket.once("close",()=>this.sockets.delete(socket));});
      server.once("error",error=>{this.stopped=true;this.options.onError?.(error);reject(error);});
      server.listen(this.options.port,"127.0.0.1",()=>{this.server=server;resolve();});
    });
  }
  async stop():Promise<void>{
    this.stopped=true;this.stopRevocations?.();this.stopRevocations=undefined;this.stopFailures?.();this.stopFailures=undefined;
    await Promise.all([...this.jobs.values()].map(job=>this.cancel(job).catch(()=>{})));
    const server=this.server;this.server=null;
    if(server){const closed=new Promise<void>(resolve=>server.close(()=>resolve()));for(const socket of this.sockets)socket.destroy();await closed;}
    // A capture may finish an already-started filesystem write after abort.
    // Stop does not release the lifecycle boundary until its final receipt is known.
    await Promise.allSettled([...this.runs]);
    await this.journalTail.catch(()=>{});
  }
  private persist():Promise<void>{
    const records=structuredClone([...this.receipts.values()]);
    const next=this.journalTail.catch(()=>{}).then(()=>this.options.requestJournal!.persist(records)).catch(error=>{this.storageFailed=true;throw error;});
    this.journalTail=next;return next;
  }
  private json(res:http.ServerResponse,status:number,value:unknown){if(res.destroyed||res.writableEnded)return;if(!res.headersSent)res.writeHead(status,JSON_HEADERS);res.end(JSON.stringify(value));}
  private rate(key:string,limit:number){
    const now=Date.now();for(const [name,times] of this.rates)if(times.every(time=>now-time>=60000))this.rates.delete(name);
    const times=(this.rates.get(key)??[]).filter(time=>now-time<60000);
    if(times.length>=limit||(!this.rates.has(key)&&this.rates.size>=256))throw new ClipperAccessError("rate-limited",429);
    this.rates.set(key,[...times,now]);
  }
  private async handle(req:http.IncomingMessage,res:http.ServerResponse){
    const origin=typeof req.headers.origin==="string"?req.headers.origin:"";
    const host=(req.headers.host??"").toLowerCase(),port=this.port;
    if(!["127.0.0.1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress??"")||![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return this.json(res,421,{ok:false,error:"loopback-host-required"});
    if(!isTrustedBridgeOrigin(origin))return this.json(res,403,{ok:false,error:"origin-denied"});
    for(const [key,value] of Object.entries(bridgeCorsHeaders(origin)))res.setHeader(key,value);
    if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
    try{
      this.rate("all",240);this.rate(`origin:${origin}`,120);
      if(this.stopped||this.storageFailed)throw new ClipperAccessError("bridge-unavailable",503);
      const auth=this.options.auth!;
      if(req.method==="POST"&&req.url==="/pair"){
        const challenge=auth.request(await readJson(req,8192),origin);
        this.json(res,202,{ok:true,v:2,challengeId:challenge.challengeId,expiresAt:challenge.expiresAt,vaultId:challenge.vaultId});
        void Promise.resolve().then(()=>this.options.onPairingRequest!(challenge)).then(decision=>auth.approve(challenge.challengeId,decision)).catch(()=>auth.approve(challenge.challengeId,null));
        return;
      }
      if(req.method==="POST"&&req.url==="/pair/claim"){
        const body=z.object({challengeId:z.string().uuid(),proof:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(await readJson(req,8192));
        if(!body.success)throw new ClipperAccessError("invalid-pairing-claim",400);
        const result=await auth.claim(body.data.challengeId,body.data.proof,origin);this.json(res,result.state==="pending"?202:200,{ok:true,...result});return;
      }
      const client=auth.authorize(req.headers.authorization,origin);this.rate(`client:${client.clientId}`,120);
      if(req.method==="GET"&&req.url==="/ping")return this.json(res,200,{ok:true,v:2,clientId:client.clientId,vaultId:client.vaultId,capabilities:client.capabilities,targetDirectory:client.targetDirectory});
      const status=/^\/requests\/([\da-f-]{36})(\/cancel)?$/i.exec(req.url??"");
      if(status){
        const key=keyOf(client.clientId,status[1]!),receipt=this.receipts.get(key);if(!receipt)return this.json(res,404,{ok:false,error:"request-not-found"});
        if(req.method==="POST"&&status[2]){const job=this.jobs.get(key);if(job)await this.cancel(job);return this.json(res,200,{ok:true,requestId:receipt.requestId,state:receipt.state});}
        if(req.method==="GET"&&!status[2])return this.json(res,200,{ok:true,requestId:receipt.requestId,state:receipt.state});
        throw new ClipperAccessError("method-not-allowed",405);
      }
      const kind=req.method==="POST"&&req.url==="/ask"?"ask":req.method==="POST"&&req.url==="/capture"?"capture":undefined;
      if(!kind)return this.json(res,404,{ok:false,error:"not-found"});
      auth.authorize(req.headers.authorization,origin,kind);this.rate(`${kind}:${client.clientId}`,10);
      if(kind==="ask"&&!this.options.onAsk)throw new ClipperAccessError("ask-disabled",404);
      const input=await readJson(req,kind==="ask"?2*1024*1024:32*1024*1024),payload=kind==="ask"?parseAskPayload(input):parseCapturePayload(input);
      if(!payload?.requestId)throw new ClipperAccessError("request-id-required",400);
      if(req.aborted||res.destroyed)return;
      const key=keyOf(client.clientId,payload.requestId),digest=clipperDigest(JSON.stringify(payload)),prior=this.receipts.get(key);
      if(prior){if(prior.digest!==digest||prior.kind!==kind)throw new ClipperAccessError("request-id-content-conflict",409);return this.json(res,200,{ok:true,requestId:prior.requestId,state:prior.state,replayed:true});}
      if(this.receipts.size>=4096)throw new ClipperAccessError("request-history-capacity-reached",429);
      if(this.queue.length>=16||[...this.jobs.values()].filter(job=>job.client.clientId===client.clientId&&!job.active).length>=2)throw new ClipperAccessError("request-queue-full",429);
      const now=new Date().toISOString(),receipt:ClipperRequestReceipt={clientId:client.clientId,requestId:payload.requestId,digest,kind,state:"queued",createdAt:now,updatedAt:now};
      const job:Job={receipt,client,payload,abort:new AbortController(),res,active:false,effects:false,committed:false,failure:false,emittedBytes:0};
      this.receipts.set(key,receipt);this.jobs.set(key,job);
      res.once("close",()=>{if(!res.writableEnded)void this.cancel(job).catch(()=>{});});
      await this.persist();
      try{auth.authorize(req.headers.authorization,origin,kind);}catch(error){await this.cancel(job);throw error;}
      if(job.abort.signal.aborted||res.destroyed)return;
      if(kind==="ask"){
        res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store",Connection:"keep-alive"});res.flushHeaders();
        this.event(job,{type:"accepted",requestId:receipt.requestId,state:"queued"});
      }
      this.queue.push(job);this.pump();
    }catch(error){const failure=error instanceof ClipperAccessError?error:new ClipperAccessError("bridge-request-failed",500);this.json(res,failure.status,{ok:false,error:failure.code});}
  }
  private event(job:Job,event:AskStreamEvent){if(job.abort.signal.aborted||job.res.destroyed||job.res.writableEnded)return;job.res.write(`data: ${JSON.stringify(event)}\n\n`);}
  private pump(){
    if(this.stopped||this.storageFailed)return;
    while([...this.active.values()].reduce((a,b)=>a+b,0)<2){
      const index=this.queue.findIndex(job=>!job.abort.signal.aborted&&!(this.active.get(job.client.clientId)??0));if(index<0)return;
      const [job]=this.queue.splice(index,1);if(!job)return;job.active=true;this.active.set(job.client.clientId,1);
      const running=this.run(job).finally(()=>{this.runs.delete(running);this.active.delete(job.client.clientId);this.jobs.delete(keyOf(job.client.clientId,job.receipt.requestId));this.pump();});
      this.runs.add(running);
    }
  }
  private async cancel(job:Job){
    if(["completed","failed","cancelled","interrupted","outcome-unknown"].includes(job.receipt.state))return;
    job.abort.abort();job.receipt.state=job.committed?"completed":job.receipt.kind==="capture"&&(job.effects||job.active)?"outcome-unknown":"cancelled";job.receipt.updatedAt=new Date().toISOString();
    this.queue=this.queue.filter(item=>item!==job);if(!job.active)this.jobs.delete(keyOf(job.client.clientId,job.receipt.requestId));
    await this.persist();
    if(!job.res.writableEnded&&!job.res.destroyed){if(job.receipt.kind==="ask"&&job.res.headersSent){job.res.write(`data: ${JSON.stringify({type:"error",error:"cancelled"})}\n\n`);job.res.end();}else this.captureResponse(job);}
  }
  private captureResponse(job:Job){
    const ok=job.receipt.state==="completed";
    this.json(job.res,ok?200:409,{ok,state:job.receipt.state,requestId:job.receipt.requestId,...(!ok?{error:job.receipt.state}:{})});
  }
  private async reconcileCancelledCapture(job:Job){
    if(job.receipt.kind!=="capture"||(!job.effects&&!job.committed))return;
    job.receipt.state=job.committed&&!this.storageFailed?"completed":"outcome-unknown";
    job.receipt.updatedAt=new Date().toISOString();await this.persist().catch(()=>{});
  }
  private async run(job:Job){
    try{
      if(job.abort.signal.aborted)return;
      job.receipt.state="running";job.receipt.updatedAt=new Date().toISOString();await this.persist();if(job.abort.signal.aborted)return;
      job.timer=setTimeout(()=>{void this.cancel(job).catch(()=>{});},this.options.requestTimeoutMs??180000);
      const context:ClipperRequestContext={clientId:job.client.clientId,vaultId:job.client.vaultId,targetDirectory:job.client.targetDirectory,capabilities:job.client.capabilities,requestId:job.receipt.requestId,
        signal:job.abort.signal,markApplied:()=>{job.effects=true;},markCommitted:()=>{job.effects=true;job.committed=true;}};
      if(job.receipt.kind==="capture")await this.options.onCapture(job.payload as CapturePayload,context);
      else await this.options.onAsk!(job.payload as AskPayload,event=>{
        if(job.abort.signal.aborted)return;
        if(event.type==="done"){if(event.text.length>1000000){job.failure=true;return;}job.finalText=event.text;return;}
        if(event.type==="error"){job.failure=true;return;}
        if(event.type==="delta"){job.emittedBytes+=event.text.length;if(job.emittedBytes>1000000){void this.cancel(job).catch(()=>{});return;}this.event(job,event);}
      },context);
      if(job.abort.signal.aborted){await this.reconcileCancelledCapture(job);return;}
      if(job.receipt.kind==="ask"&&job.finalText===undefined)job.failure=true;
      job.receipt.state=job.receipt.kind==="capture"&&!job.committed?(job.effects?"outcome-unknown":"failed"):job.failure?"failed":"completed";job.receipt.updatedAt=new Date().toISOString();await this.persist();
      if(job.receipt.kind==="capture")this.captureResponse(job);
      else{this.event(job,job.failure?{type:"error",error:"ask-failed"}:{type:"done",text:job.finalText??""});job.res.end();}
    }catch{
      if(job.abort.signal.aborted){await this.reconcileCancelledCapture(job);return;}
      job.receipt.state=job.receipt.kind==="capture"&&job.committed&&!this.storageFailed?"completed":job.effects||job.committed?"outcome-unknown":"failed";
      job.receipt.updatedAt=new Date().toISOString();await this.persist().catch(()=>{});
      if(this.storageFailed&&job.effects)job.receipt.state="outcome-unknown";
      if(job.receipt.kind==="ask"){this.event(job,{type:"error",error:this.storageFailed?"outcome-unknown":"ask-failed"});job.res.end();}
      else this.captureResponse(job);
    }finally{if(job.timer)clearTimeout(job.timer);}
  }
}

function readJson(req:http.IncomingMessage,limit:number):Promise<unknown>{return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let size=0,finished=false;
  const fail=(error:Error)=>{if(!finished){finished=true;reject(error);}};
  req.on("data",(chunk:Buffer)=>{if(finished)return;size+=chunk.length;if(size>limit){fail(new ClipperAccessError("payload-too-large",413));return;}chunks.push(chunk);});
  req.once("end",()=>{if(finished)return;finished=true;try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{reject(new ClipperAccessError("invalid-json",400));}});
  req.once("aborted",()=>fail(new ClipperAccessError("request-disconnected",400)));req.once("error",()=>fail(new ClipperAccessError("request-read-failed",400)));
});}
