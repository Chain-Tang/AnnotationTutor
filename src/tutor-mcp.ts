import { learningContextSchema, type LearningContextQuery, type LearningContextSnapshot } from "./learning-context.js";
import {CallToolResultSchema} from "@modelcontextprotocol/sdk/types.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { excalidrawOperationSchema } from "./excalidraw-surface.js";
import { boardChangeOperations } from "./tutor-board-surface.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextGrant, TaskArtifact, TutorTask, TutorTaskCoordinator } from "./tutor-task.js";
import { SurfaceCommitError, requireDurableSurfaceCommit, surfaceDigest, surfaceSignature, type ChangeSet, type SurfaceAdapter, type SurfaceCommitResult } from "./tutor-surface.js";
import { surfaceReceiptSchema, SURFACE_TRANSACTION_POLICY, type SurfaceTransactionJournal, type SurfaceTransactionRecord } from "./surface-transaction-journal.js";
import { ServiceWork } from "./service-work.js";

export type TutorClientGrant = ContextGrant & { learningEvidence?:boolean; name:string; documents:string[]; createdAt:string };
export type TutorMcpHost = {
  transactions?:SurfaceTransactionJournal;
  learningContext?(query:LearningContextQuery):Promise<LearningContextSnapshot>;
  tasks:TutorTaskCoordinator;
  surfaces():Promise<SurfaceAdapter[]>;
  context(source:string,start:number,length:number):Promise<{source:string;start:number;end:number;text:string;revision:string}>;
  memory(sources:string[],offset:number):Promise<{id:string;source:string;text:string}[]>;
  run(input:{task:TutorTask;prompt:string;context:string;surface?:SurfaceAdapter;signal:AbortSignal;emit:(text:string)=>void}):Promise<TaskArtifact[]>;
};
const id=z.string().min(1).max(200),page=z.number().int().nonnegative().max(100000).default(0);
const taskSchema=z.object({id,clientId:id,lead:id,agent:id,state:z.enum(["queued","working","input-required","completed","failed","cancelled"]),phase:z.string(),createdAt:z.number(),updatedAt:z.number(),artifacts:z.array(z.object({id,type:z.enum(["text","changes","image"]),data:z.unknown()}))}).passthrough();
const targetSchema=z.object({id,source:z.string(),revision:z.string(),surface:z.enum(["document","studio","excalidraw"])});
const sceneSchema=z.object({target:targetSchema,selection:z.array(z.string()),objects:z.array(z.unknown()),vectorAssets:z.array(z.unknown()).optional()});
const receiptSchema=surfaceReceiptSchema;
const changesSchema=z.object({id,taskId:id,targetId:id,baseRevision:z.string().max(200),operations:z.array(z.union([excalidrawOperationSchema,boardChangeOperations.element])).min(1).max(128),dependencies:z.array(z.string()).max(128)}).strict();

/** All clients get their own grant closure. Neither tool arguments nor task ids select an identity. */
export class TutorMcpTools {
  private readonly revoked=new Set<string>();
  private readonly inputs=new Map<string,{prompt:string;source?:string}>();
  private readonly pendingCommits=new Map<string,{signature:string;promise:Promise<SurfaceCommitResult>}>();
  private readonly recovering=new Map<string,Set<AbortController>>();
  private readonly work=new ServiceWork();
  private readonly clients=new Set<string>();
  constructor(private readonly host:TutorMcpHost){}
  revoke(clientId:string):void{this.revoked.add(clientId);this.host.tasks.cancelAll(clientId);for(const abort of this.recovering.get(clientId)??[])abort.abort();}
  /** Permanent closure. Restart with a new service; old grant closures stay closed. */
  close():Promise<void>{
    if(this.work.closed)return this.work.close();
    const drained=this.work.close();
    for(const clientId of this.clients)this.host.tasks.cancelAll(clientId);
    return drained;
  }

  async invoke(grant:TutorClientGrant,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
    const server=this.server(grant),client=new Client({name:"tutor-a2a-transport",version:"0.3.0"}),[a,b]=InMemoryTransport.createLinkedPair();
    try{await server.connect(b);await client.connect(a);const result=CallToolResultSchema.parse(await client.callTool({name,arguments:args}));if(result.isError)throw new Error(result.content.filter(c=>c.type==="text").map(c=>c.text).join(" "));return result.structuredContent??{};}
    finally{await client.close();await server.close();}
  }
  private async surface(grant:TutorClientGrant,id:string){
    if(!grant.read || !grant.targets.includes(id))throw new Error("surface-access-denied");
    const surface=(await this.host.surfaces()).find(surface=>surface.id===id);
    if(!surface?.capabilities().available)throw new Error("surface-unavailable");if(this.host.transactions)surface.useTransactions?.(this.host.transactions);return surface;
  }
  private commit(grant:TutorClientGrant,changes:ChangeSet,signal:AbortSignal):Promise<SurfaceCommitResult>{
    if(!grant.write)throw new Error("client-read-only");
    if(!this.host.transactions)throw new Error("surface-transaction-journal-unavailable");
    const key=JSON.stringify([grant.clientId,changes.targetId,changes.id]),signature=surfaceSignature(changes),pending=this.pendingCommits.get(key);
    if(pending){if(pending.signature!==signature)throw new Error("changeset-id-reused");return pending.promise;}
    const promise=(async()=>{
      const journal=this.host.transactions!,ref={clientId:grant.clientId,targetId:changes.targetId,transactionId:changes.id};
      if(!grant.read||!grant.targets.includes(changes.targetId))throw new Error("surface-access-denied");
      const prior=await journal.lookup(ref,surfaceDigest(changes));
      if(prior){const result=this.recordResult(prior);this.restoreTask(prior);this.host.tasks.recordSurfaceCommit(result.receipt,true);return requireDurableSurfaceCommit(result);}
      const task=this.host.tasks.get(changes.taskId,grant.clientId);
      if(task.target?.id!==changes.targetId||task.target.revision!==changes.baseRevision||!["queued","input-required"].includes(task.state)||task.commit)throw new Error("change-task-not-active");
      const surface=await this.surface(grant,changes.targetId);
      const abort=new AbortController(),cancel=()=>abort.abort(),taskSignal=this.host.tasks.signal(task.id,grant.clientId);
      signal.addEventListener("abort",cancel,{once:true});taskSignal.addEventListener("abort",cancel,{once:true});
      if(signal.aborted||taskSignal.aborted||this.revoked.has(grant.clientId))cancel();
      const validate=(result:SurfaceCommitResult)=>{
        const receipt=receiptSchema.parse(result.receipt);
        if(receipt.clientId!==grant.clientId||receipt.targetId!==surface.id||result.target.id!==surface.id||receipt.transactionId!==changes.id||receipt.requestId!==changes.taskId||receipt.baseRevision!==changes.baseRevision||receipt.operationDigest!==surfaceDigest(changes))throw new Error("surface-commit-receipt-mismatch");
        const ids=[...receipt.createdIds,...receipt.updatedIds,...receipt.deletedIds];
        if(new Set(ids).size!==ids.length)throw new Error("surface-commit-receipt-duplicate-id");
        return result;
      };
      try{
        this.host.tasks.phase(task.id,grant.clientId,"committing");this.host.tasks.consume(task.id,grant.clientId,"toolCalls");
        const result=validate(await surface.commit(changes,{...grant,onSurfaceCommit:receipt=>this.host.tasks.recordSurfaceCommit(receipt)},abort.signal));
        const stored=await journal.lookup(ref,surfaceDigest(changes));
        if(!stored||stored.phase!=="committed"||surfaceDigest(stored.receipt)!==surfaceDigest(result.receipt))throw new Error("surface-commit-not-durably-journaled");
        requireDurableSurfaceCommit(result);
        this.host.tasks.recordSurfaceCommit(result.receipt,true);
        return result;
      }catch(error){
        let failure=error;
        if(error instanceof SurfaceCommitError){
          try{validate(error.result);this.host.tasks.recordSurfaceCommit(error.result.receipt,true);}catch(rejected){failure=rejected;}
        }
        if(!(failure instanceof SurfaceCommitError))this.host.tasks.fail(task.id,grant.clientId,"commit-failed","Commit did not complete; read the transaction before retrying.");
        throw failure;
      }finally{signal.removeEventListener("abort",cancel);taskSignal.removeEventListener("abort",cancel);}
    })();
    this.pendingCommits.set(key,{signature,promise});
    void promise.finally(()=>this.pendingCommits.delete(key)).catch(()=>{});
    return promise;
  }
  private recordResult(record:SurfaceTransactionRecord):SurfaceCommitResult{
    const receipt=structuredClone(record.receipt);if(["applying","saving","unknown"].includes(record.phase))receipt.durability="outcome-unknown";
    return {target:{id:receipt.targetId,source:"",revision:receipt.committedRevision??receipt.appliedRevision,surface:record.surface},selection:[],objects:[],receipt};
  }
  private restoreTask(record:SurfaceTransactionRecord):void{
    const receipt=record.receipt;
    try{this.host.tasks.get(receipt.requestId,receipt.clientId);return;}catch{/* Recover metadata only; no model is restarted. */}
    this.host.tasks.restore([{id:receipt.requestId,clientId:receipt.clientId,lead:"restored-client",agent:"restored-client",state:"failed",phase:"restored-transaction",target:{id:receipt.targetId,source:"",revision:receipt.baseRevision,surface:record.surface},createdAt:record.createdAt,updatedAt:record.updatedAt,artifacts:[],children:[],metrics:{modelCalls:0,toolCalls:0},commit:structuredClone(receipt)}]);
    this.host.tasks.recordSurfaceCommit(this.recordResult(record).receipt,true);
  }
  server(grant:TutorClientGrant):McpServer{
    this.work.assertOpen();
    const server=new McpServer({name:"tutor",version:"0.3.0"},{instructions:"Tutor has independent reasoning and learning context. Work only with granted documents and surfaces. Start long tasks then query their status. Changes require the original scene revision; never retry a stale commit blindly. A completed reasoning task is not a committed drawing."});
    const tool=<I extends z.ZodRawShape,O extends z.ZodRawShape>(name:string,description:string,inputSchema:I,outputSchema:O,readOnlyHint:boolean,run:(input:z.infer<z.ZodObject<I>>,signal:AbortSignal)=>Promise<z.infer<z.ZodObject<O>>>)=>{
      const callback: ToolCallback<z.ZodRawShape> = async(input,extra):Promise<CallToolResult>=>{
        try{
          if(this.revoked.has(grant.clientId))throw new Error("client-grant-revoked");
          this.clients.add(grant.clientId);
          const data=await this.work.run(extra.signal,signal=>run(input as z.infer<z.ZodObject<I>>,signal));
          if(JSON.stringify(data).length>3_000_000)throw new Error("tool-output-too-large");
          return {content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:data as Record<string,unknown>};
        }catch(error){
          const structured=error instanceof SurfaceCommitError&&input.receiptVersion===1?{scene:{target:error.result.target,selection:[],objects:[]},receipt:error.result.receipt}:undefined;
          return {isError:true,content:[{type:"text" as const,text:error instanceof Error?error.message.slice(0,2000):"Tutor tool failed"}],...(structured?{structuredContent:structured}:{})};
        }
      };
      server.registerTool(name,{description,inputSchema,outputSchema,annotations:{readOnlyHint,destructiveHint:!readOnlyHint,openWorldHint:false}},callback as ToolCallback<I>);
    };
    tool("tutor_status","Inspect this paired client and its permissions.",{}, {clientId:id,name:z.string(),write:z.boolean(),learningMemory:z.boolean(),surfaceCommitReceiptVersions:z.array(z.literal(1)),surfaceTransactions:z.object({available:z.boolean(),reason:z.string().optional(),receiptRetentionDays:z.literal(30),maxReceipts:z.number(),maxOwnedObjects:z.number(),barrierSaturationPolicy:z.literal("reject-new-writes-retain-barrier")})},true,async()=>({clientId:grant.clientId,name:grant.name,write:grant.write,learningMemory:grant.learningMemory,surfaceCommitReceiptVersions:[1 as const],surfaceTransactions:{...(this.host.transactions?.status()??{available:false,reason:"surface-transaction-journal-unavailable"}),receiptRetentionDays:30 as const,maxReceipts:SURFACE_TRANSACTION_POLICY.maxReceipts,maxOwnedObjects:SURFACE_TRANSACTION_POLICY.maxOwnedObjects,barrierSaturationPolicy:"reject-new-writes-retain-barrier" as const}}));
    tool("tutor_list_documents","List only documents authorized for this client.",{offset:page},{documents:z.array(z.object({source:z.string()})),nextOffset:z.number().nullable()},true,async({offset})=>({documents:grant.documents.slice(offset,offset+30).map(source=>({source})),nextOffset:offset+30<grant.documents.length?offset+30:null}));
    tool("tutor_get_context","Read a bounded text slice. It does not include a screenshot.",{source:z.string().min(1).max(1000),start:page,length:z.number().int().min(1).max(16000).default(8000)},{source:z.string(),start:z.number(),end:z.number(),text:z.string(),revision:z.string()},true,async({source,start,length})=>{if(!grant.read||!grant.documents.includes(source))throw new Error("document-access-denied");return this.host.context(source,start,length);});
    tool("tutor_get_learning_context","Read consented learning evidence for one authorized document. Separate permission is required; self reports are not verified mastery.",{source:z.string().min(1).max(1000),episodeId:id.optional(),annotationId:id.optional()},learningContextSchema.shape,true,async({source,episodeId,annotationId})=>{if(!grant.read||!grant.learningEvidence||!grant.documents.includes(source))throw new Error("learning-evidence-not-granted");if(!this.host.learningContext)throw new Error("learning-context-unavailable");return this.host.learningContext({source,episodeId,annotationId,allowedSources:[source]});});
    tool("tutor_read_learning","Read authorized learning records without modifying learner memory.",{offset:page},{records:z.array(z.object({id:z.string(),source:z.string(),text:z.string()}))},true,async({offset})=>{if(!grant.learningMemory)throw new Error("learning-memory-not-granted");return {records:await this.host.memory(grant.documents,offset)};});
    tool("tutor_list_surfaces","List granted drawing targets and their supported operations.",{offset:page},{surfaces:z.array(z.object({id,capabilities:z.object({available:z.boolean(),operations:z.array(z.string()),reason:z.string().optional(),version:z.string().optional(),writeAvailable:z.boolean().optional(),writeReason:z.string().optional()})})),nextOffset:z.number().nullable()},true,async({offset})=>{const surfaces=(await this.host.surfaces()).filter(s=>grant.targets.includes(s.id));return {surfaces:surfaces.slice(offset,offset+30).map(s=>({id:s.id,capabilities:s.capabilities()})),nextOffset:offset+30<surfaces.length?offset+30:null};});
    tool("tutor_read_scene","Read a page of objects and the exact scene revision. Supply expectedRevision for later pages. Fetch vector nodes with tutor_read_vector_asset.",{targetId:id,offset:page,limit:z.number().int().min(1).max(100).default(50),expectedRevision:z.string().max(200).optional()},{scene:sceneSchema,nextOffset:z.number().nullable(),total:z.number()},true,async({targetId,offset,limit,expectedRevision})=>{
      const scene=await(await this.surface(grant,targetId)).read();if(expectedRevision&&scene.target.revision!==expectedRevision)throw new Error("scene-revision-conflict");
      const objects:unknown[]=[];let bytes=0;for(const object of scene.objects.slice(offset,offset+limit)){const size=JSON.stringify(object).length;if(bytes+size>1_000_000){if(!objects.length)throw new Error("object-payload-too-large-use-preview");break;}objects.push(object);bytes+=size;}
      return {scene:{target:scene.target,selection:scene.selection,objects},total:scene.objects.length,nextOffset:offset+objects.length<scene.objects.length?offset+objects.length:null};
    });
    tool("tutor_read_vector_asset","Read nodes of an immutable vector asset version referenced by a granted scene.",{targetId:id,assetId:id,version:z.number().int().positive(),offset:page},{asset:z.unknown(),nextOffset:z.number().nullable()},true,async({targetId,assetId,version,offset})=>{
      const scene=await(await this.surface(grant,targetId)).read(),asset=scene.vectorAssets?.find(a=>a.id===assetId&&a.version===version);
      if(!asset||!scene.objects.some(o=>(o as {vectorAssetId?:string;vectorAssetVersion?:number}).vectorAssetId===assetId&&(o as {vectorAssetVersion?:number}).vectorAssetVersion===version))throw new Error("vector-asset-unavailable");
      const nodes=asset.nodes.slice(offset,offset+32);return {asset:{...asset,nodes},nextOffset:offset+nodes.length<asset.nodes.length?offset+nodes.length:null};
    });
    tool("tutor_preview_change","Preview a typed change without committing it; use an empty changes field to export the existing scene.",{targetId:id,changes:changesSchema.optional()},{format:z.literal("svg"),data:z.string()},true,async({targetId,changes})=>({format:"svg" as const,data:await(await this.surface(grant,targetId)).preview(changes as ChangeSet|undefined)}));
    tool("tutor_begin_change","Create a cancellable draft task without calling a model.",{targetId:id,key:id},{task:taskSchema},false,async({targetId,key},signal)=>{
      if(!grant.write)throw new Error("client-read-only");const scene=await(await this.surface(grant,targetId)).read();
      signal.throwIfAborted();
      return {task:this.host.tasks.start({clientId:grant.clientId,lead:grant.name,agent:grant.name,target:scene.target,key:`draft:${key}`})};
    });
    tool("tutor_commit_change","Apply one validated undo transaction. Returns the durable revision; read scene pages afterwards. Only explicitly granted objects or this client's receipted additions may be changed. Opt in with receiptVersion after checking tutor_status.",{changes:changesSchema,receiptVersion:z.literal(1).optional()},{scene:sceneSchema,receipt:receiptSchema.optional()},false,async({changes,receiptVersion},signal)=>{
      const result=await this.commit(grant,changes as ChangeSet,signal);
      return {scene:{target:result.target,selection:[],objects:[]},...(receiptVersion===1?{receipt:result.receipt}:{})};
    });
    tool("tutor_recover_change","Inspect a recorded transaction before reconnecting or retrying. retry-save is an explicit save-only action for an inspected, unchanged applied difference; it never regenerates or reinserts objects. Unknown results require inspection first.",{targetId:id,transactionId:id,action:z.enum(["inspect","retry-save"]).default("inspect"),receiptVersion:z.literal(1)},{scene:sceneSchema,receipt:receiptSchema},false,async({targetId,transactionId,action},signal)=>{
      if(!grant.read||!grant.targets.includes(targetId))throw new Error("surface-access-denied");if(action==="retry-save"&&!grant.write)throw new Error("client-read-only");
      if(!this.host.transactions)throw new Error("surface-transaction-journal-unavailable");
      const recorded=await this.host.transactions.lookup({clientId:grant.clientId,targetId,transactionId});if(!recorded)throw new Error("surface-transaction-not-found");
      this.restoreTask(recorded);
      const abort=new AbortController(),cancel=()=>abort.abort(),active=this.recovering.get(grant.clientId)??new Set<AbortController>();active.add(abort);this.recovering.set(grant.clientId,active);
      signal.addEventListener("abort",cancel,{once:true});if(signal.aborted||this.revoked.has(grant.clientId))cancel();
      try{
        let surface:SurfaceAdapter|undefined;
        try{surface=await this.surface(grant,targetId);}catch(error){if(action!=="inspect")throw error;}
        const result=surface?.recoverCommit?await surface.recoverCommit(transactionId,grant,abort.signal,action):action==="inspect"?this.recordResult(recorded):undefined;
        if(!result)throw new Error("surface-recovery-unavailable");this.host.tasks.recordSurfaceCommit(result.receipt,true);
        return {scene:{target:result.target,selection:[],objects:[]},receipt:result.receipt};
      }catch(error){if(error instanceof SurfaceCommitError)this.host.tasks.recordSurfaceCommit(error.result.receipt,true);throw error;}
      finally{signal.removeEventListener("abort",cancel);active.delete(abort);if(!active.size)this.recovering.delete(grant.clientId);}
    });
    tool("tutor_start_task","Ask the independent Tutor to reason, teach, review or propose a drawing. Returns a handle immediately; it does not commit drafts.",{prompt:z.string().trim().min(1).max(16000),targetId:id.optional(),source:z.string().max(1000).optional(),key:id},{task:taskSchema},false,async({prompt,targetId,source,key},signal)=>{
      if(source&&(!grant.read||!grant.documents.includes(source)))throw new Error("document-access-denied");
      const surface=targetId?await this.surface(grant,targetId):undefined,scene=surface?await surface.read():undefined;
      signal.throwIfAborted();
      const task=this.host.tasks.start({clientId:grant.clientId,lead:grant.name,agent:"tutor",target:scene?.target,key:`tutor:${key}`});
      if(task.state!=="queued")return {task};
      this.inputs.set(task.id,{prompt,source:source??scene?.target.source});if(this.inputs.size>200)this.inputs.delete(this.inputs.keys().next().value!);
      this.host.tasks.phase(task.id,grant.clientId,"reasoning");
      void this.work.run(this.host.tasks.signal(task.id,grant.clientId),async backgroundSignal=>{
        try{
          const contextSource=source??scene?.target.source;
          let context=contextSource&&grant.documents.includes(contextSource)?(await this.host.context(contextSource,0,16000)).text:"";
          const evidence=contextSource&&grant.learningEvidence&&grant.read&&grant.documents.includes(contextSource)&&this.host.learningContext?await this.host.learningContext({source:contextSource,allowedSources:[contextSource]}):undefined;
          if(evidence)context+="\n"+evidence.summary;
          backgroundSignal.throwIfAborted();
          const artifacts=await this.host.run({task,prompt,context,surface,signal:backgroundSignal,emit:text=>this.host.tasks.emit(task.id,grant.clientId,{type:"text",data:{text}})});
          backgroundSignal.throwIfAborted();
          if(evidence&&contextSource&&(await this.host.learningContext!({source:contextSource,allowedSources:[contextSource]})).revision!==evidence.revision)throw new Error("learning-evidence-changed");
          if(artifacts.some(artifact=>artifact.type==="changes"))this.host.tasks.propose(task.id,grant.clientId,artifacts);
          else this.host.tasks.complete(task.id,grant.clientId,artifacts);
        }catch(error){this.host.tasks.fail(task.id,grant.clientId,"tutor-execution-failed",error instanceof Error?error.message.slice(0,1000):"Tutor execution failed");}
      }).catch(()=>{});return {task:this.host.tasks.get(task.id,grant.clientId)};
    });
    tool("tutor_supply_input","Refine an awaiting Tutor draft within the same target and budget. A changed target revision requires a new task.",{taskId:id,text:z.string().trim().min(1).max(8000)},{task:taskSchema},false,async({taskId,text},signal)=>{
      const task=this.host.tasks.get(taskId,grant.clientId),prior=this.inputs.get(taskId);
      if(task.state!=="input-required"||!prior)throw new Error("task-not-awaiting-input");
      const surface=task.target?await this.surface(grant,task.target.id):undefined;
      if(surface&&(await surface.read()).target.revision!==task.target?.revision)throw new Error("scene-revision-conflict");
      signal.throwIfAborted();
      this.host.tasks.phase(task.id,grant.clientId,"refining");
      void this.work.run(this.host.tasks.signal(taskId,grant.clientId),async backgroundSignal=>{try{
        let context=prior.source&&grant.documents.includes(prior.source)?(await this.host.context(prior.source,0,16000)).text:"";
        const evidence=prior.source&&grant.learningEvidence&&grant.read&&grant.documents.includes(prior.source)&&this.host.learningContext?await this.host.learningContext({source:prior.source,allowedSources:[prior.source]}):undefined;
        if(evidence)context+="\n"+evidence.summary;
        backgroundSignal.throwIfAborted();
        const artifacts=await this.host.run({task,prompt:`${prior.prompt}\nAdditional user input: ${text}`,context,surface,signal:backgroundSignal,emit:text=>this.host.tasks.emit(taskId,grant.clientId,{type:"text",data:{text}})});
        backgroundSignal.throwIfAborted();
        if(evidence&&prior.source&&(await this.host.learningContext!({source:prior.source,allowedSources:[prior.source]})).revision!==evidence.revision)throw new Error("learning-evidence-changed");
        if(artifacts.some(a=>a.type==="changes"))this.host.tasks.propose(taskId,grant.clientId,artifacts);else this.host.tasks.complete(taskId,grant.clientId,artifacts);
      }catch(error){this.host.tasks.fail(taskId,grant.clientId,"tutor-execution-failed",error instanceof Error?error.message.slice(0,1000):"Tutor failed");}}).catch(()=>{});
      return {task:this.host.tasks.get(taskId,grant.clientId)};
    });
    tool("tutor_task_status","Get this client's task progress, result or failure.",{taskId:id},{task:taskSchema},true,async({taskId})=>{
      try{return {task:this.host.tasks.get(taskId,grant.clientId)};}catch(error){
        const record=this.host.transactions?(await this.host.transactions.recordsForClient(grant.clientId)).find(record=>record.receipt.requestId===taskId&&grant.read&&grant.targets.includes(record.receipt.targetId)):undefined;
        if(!record)throw error;this.restoreTask(record);return {task:this.host.tasks.get(taskId,grant.clientId)};
      }
    });
    tool("tutor_list_tasks","List this client's recent tasks.",{offset:page},{tasks:z.array(taskSchema)},true,async({offset})=>({tasks:this.host.tasks.list(grant.clientId,offset)}));
    tool("tutor_task_events","Read bounded progress events after a sequence number.",{taskId:id,after:page},{events:z.array(z.object({sequence:z.number(),at:z.number(),type:z.string(),data:z.unknown()}))},true,async({taskId,after})=>({events:this.host.tasks.events(taskId,grant.clientId,after)}));
    tool("tutor_cancel_task","Cancel a task and all its children. Late results cannot commit.",{taskId:id},{task:taskSchema},false,async({taskId})=>{this.host.tasks.cancel(taskId,grant.clientId);return {task:this.host.tasks.get(taskId,grant.clientId)};});
    return server;
  }
}
