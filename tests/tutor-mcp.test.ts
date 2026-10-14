import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TutorMcpTools, type TutorClientGrant } from "../src/tutor-mcp.js";
import { TutorTaskCoordinator } from "../src/tutor-task.js";
import { LocalBoardMcpAdapter } from "../src/board-mcp.js";
import { DefaultBoardToolRuntime } from "../src/board-tools.js";
import { SurfaceCommitError, surfaceCommitResult, type ChangeSet, type SurfaceAdapter } from "../src/tutor-surface.js";
import type { ExcalidrawOperation } from "../src/excalidraw-surface.js";
import { surfaceJournalFixture } from "./surface-journal-fixture.js";
import { authenticateTutorClient, createTutorPairing } from "../src/tutor-access.js";
import { BoardHistory, createBoardDocument } from "../src/board-model.js";
import { TutorBoardSurface } from "../src/tutor-board-surface.js";
import type { BoardObject } from "../src/board-types.js";
const cleanup:(()=>unknown)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function fixture(objectCount=0){
  const tasks=new TutorTaskCoordinator();cleanup.push(()=>tasks.dispose());let commits=0;const {journal:transactions}=surfaceJournalFixture();
  const surface:SurfaceAdapter={id:"board",capabilities:()=>({available:true,operations:["add"]}),read:async()=>({target:{id:"board",source:"a.md",revision:String(commits),surface:"excalidraw"},selection:[],objects:Array.from({length:objectCount},(_,i)=>({id:`object-${i}`,text:"x".repeat(20000)}))}),preview:async()=>"<svg/>",commit:async(changes,grant)=>{
    const scene=await surface.read(),result=surfaceCommitResult(changes,grant,{...scene.target,revision:String(commits+1)},[],[]);
    await transactions.prepare(changes,grant,"excalidraw",result.receipt,[]);await transactions.transition(result.receipt,"applying");commits++;
    await transactions.transition(result.receipt,"applied");await transactions.transition(result.receipt,"saving");result.receipt=(await transactions.transition(result.receipt,"committed")).receipt;return result;
  }};
  const tools=new TutorMcpTools({transactions,tasks,surfaces:async()=>[surface],context:async(source,start,length)=>({source,start,end:length,text:"authorized",revision:"1"}),memory:async()=>[],run:async input=>{await new Promise<void>(resolve=>setTimeout(resolve,20));if(input.signal.aborted)throw new Error("cancelled");return [{id:"answer",type:"text",data:{text:"Tutor response"}}];}});
  const grant:TutorClientGrant={clientId:"a",name:"Codex",documents:["a.md"],targets:["board"],humanObjectIds:[],read:true,write:true,learningMemory:false,createdAt:new Date().toISOString()};
  const client=async(g=grant)=>{const [a,b]=InMemoryTransport.createLinkedPair(),server=tools.server(g),client=new Client({name:"test",version:"1"});await server.connect(b);await client.connect(a);cleanup.push(()=>client.close());cleanup.push(()=>server.close());return client;};
  return {tools,tasks,grant,client,commits:()=>commits};
}
async function call(client:Client,name:string,args:Record<string,unknown>={}){return client.callTool({name,arguments:args});}
const data=(value:Awaited<ReturnType<typeof call>>)=>value.structuredContent as Record<string,any>;
describe("official Tutor MCP service",()=>{
  it("advertises typed operation schemas and isolates contexts and tasks by paired client",async()=>{
    const f=fixture(),a=await f.client(),b=await f.client({...f.grant,clientId:"b",documents:[],targets:[]});
    const list=await a.listTools();expect(JSON.stringify(list)).toContain("strokeWidth");expect(JSON.stringify(list)).toContain("expectedRevision");
    expect((await call(b,"tutor_get_context",{source:"a.md"})).isError).toBe(true);
    const started=data(await call(a,"tutor_start_task",{prompt:"Explain",key:"k",source:"a.md"})).task;
    expect((await call(b,"tutor_task_status",{taskId:started.id})).isError).toBe(true);
    expect(data(await call(a,"tutor_start_task",{prompt:"Explain",key:"k"})).task.id).toBe(started.id);
    await new Promise(resolve=>setTimeout(resolve,30));expect(data(await call(a,"tutor_task_status",{taskId:started.id})).task.state).toBe("completed");
  });
  it("cancels long tasks and never accepts their late answer",async()=>{
    const f=fixture(),client=await f.client();const task=data(await call(client,"tutor_start_task",{prompt:"Explain",key:"cancel"})).task;
    await call(client,"tutor_cancel_task",{taskId:task.id});await new Promise(resolve=>setTimeout(resolve,30));
    expect(data(await call(client,"tutor_task_status",{taskId:task.id})).task).toMatchObject({state:"cancelled",artifacts:[]});
  });
  it("deduplicates a completed commit and rejects reuse with different contents",async()=>{
    const f=fixture(),client=await f.client(),task=data(await call(client,"tutor_begin_change",{targetId:"board",key:"draft"})).task;
    const changes={id:"change",taskId:task.id,targetId:"board",baseRevision:"0",dependencies:[],operations:[{type:"add",id:"rect",shape:"rectangle",x:0,y:0,width:50,height:50}]};
    expect((await call(client,"tutor_commit_change",{changes})).isError).toBeFalsy();
    expect((await call(client,"tutor_commit_change",{changes})).isError).toBeFalsy();expect(f.commits()).toBe(1);
    expect((await call(client,"tutor_commit_change",{changes:{...changes,baseRevision:"1"}})).isError).toBe(true);
  });
  it("paginates large scenes and returns successful bounded receipts after a committed change",async()=>{
    const f=fixture(210),client=await f.client();
    const first=data(await call(client,"tutor_read_scene",{targetId:"board"}));expect(first.total).toBe(210);expect(first.nextOffset).toBeGreaterThan(0);expect(first.scene.objects.length).toBeLessThan(50);
    const second=data(await call(client,"tutor_read_scene",{targetId:"board",offset:first.nextOffset,expectedRevision:first.scene.target.revision}));expect(second.scene.objects[0].id).not.toBe(first.scene.objects[0].id);
    const task=data(await call(client,"tutor_begin_change",{targetId:"board",key:"large"})).task;
    const result=await call(client,"tutor_commit_change",{changes:{id:"large-change",taskId:task.id,targetId:"board",baseRevision:"0",dependencies:[],operations:[{type:"add",id:"rect",shape:"rectangle",x:0,y:0,width:50,height:50}]}});
    expect(result.isError).toBeFalsy();expect(data(result).scene.target.revision).toBe("1");expect(JSON.stringify(result).length).toBeLessThan(1000);expect(f.commits()).toBe(1);
    expect((await call(client,"tutor_read_scene",{targetId:"board",offset:first.nextOffset,expectedRevision:"0"})).isError).toBe(true);
  });
  it("connects through real HTTP using SDK negotiation and revocable hashed pairing",async()=>{
    const f=fixture(),paired=createTutorPairing(f.grant);let records=[paired.record];
    const adapter=new LocalBoardMcpAdapter(new DefaultBoardToolRuntime(),{tutor:f.tools,authenticate:token=>authenticateTutorClient(token,records)});
    const endpoint=await adapter.start();cleanup.push(()=>adapter.stop());const client=new Client({name:"formal-client",version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${paired.token}`}}}));cleanup.unshift(()=>client.close());
    expect(data(await call(client,"tutor_status")).clientId).toBe("a");records=[];
    await expect(call(client,"tutor_status")).rejects.toThrow();
  });
});
it('denies source reads without read permission and immediately invalidates existing client sessions',async()=>{
 const f=fixture(),denied=await f.client({...f.grant,read:false});expect((await call(denied,'tutor_start_task',{prompt:'Explain',key:'no-read',source:'a.md'})).isError).toBe(true);
 const client=await f.client(),task=data(await call(client,'tutor_start_task',{prompt:'Explain',key:'pending'})).task;f.tools.revoke('a');
 expect((await call(client,'tutor_status')).isError).toBe(true);await new Promise(r=>setTimeout(r,30));expect(f.tasks.get(task.id,'a')).toMatchObject({state:'cancelled',artifacts:[]});
});
it('discard late results when the consented learning snapshot changes',async()=>{
 const tasks=new TutorTaskCoordinator();cleanup.push(()=>tasks.dispose());let revision='1';
 const tools=new TutorMcpTools({tasks,surfaces:async()=>[],context:async source=>({source,revision:'1',start:0,end:1,text:'math'}),memory:async()=>[],learningContext:async()=>({version:1,revision,episodes:[],summary:'evidence'}),run:async()=>{revision='2';return [{id:'a',type:'text',data:{text:'stale'}}];}});
 const grant:TutorClientGrant={clientId:'a',name:'QA',createdAt:new Date().toISOString(),read:true,write:false,documents:['a.md'],targets:[],humanObjectIds:[],learningMemory:false,learningEvidence:true};
 const {task}=await tools.invoke(grant,'tutor_start_task',{prompt:'Explain',key:'stale',source:'a.md'}) as {task:{id:string}};
 await new Promise(r=>setTimeout(r,10));expect(tasks.get(task.id,'a')).toMatchObject({state:'failed',artifacts:[],error:{message:'learning-evidence-changed'}});
});

function concurrentSurface(options:{failure?:"applied-not-durable"|"outcome-unknown";duringSave?:()=>Promise<void>;wrongClient?:boolean}={}){
  const tasks=new TutorTaskCoordinator();cleanup.push(()=>tasks.dispose());
  const {journal:transactions}=surfaceJournalFixture();
  const objects:{id:string;type:string;createdBy?:string;color?:string}[]=[{id:"historical-tutor",type:"rectangle",createdBy:"tutor"}];
  const grants:{clientId:string;ids:string[]}[]=[];let revision=0,commits=0;
  const surface:SurfaceAdapter<ExcalidrawOperation>={id:"board",capabilities:()=>({available:true,operations:["add","update"]}),read:async()=>({target:{id:"board",source:"a.md",revision:String(revision),surface:"excalidraw"},selection:[],objects:structuredClone(objects)}),preview:async()=>"<svg/>",commit:async(changes,grant)=>{
    grant=await transactions.authorizedGrant(grant,"board",objects);grants.push({clientId:grant.clientId,ids:[...grant.humanObjectIds]});
    const before=structuredClone(objects),draft=structuredClone(objects);
    for(const operation of changes.operations){
      if(operation.type==="add")draft.push({id:`${grant.clientId}-${operation.id}`,type:"rectangle"},{id:`${grant.clientId}-${operation.id}-label`,type:"text"});
      else if(operation.type==="update"){
        if(!grant.humanObjectIds.includes(operation.id))throw new Error("object-outside-grant");
        draft.find(object=>object.id===operation.id)!.color="#ff0000";
      }
    }
    const result=surfaceCommitResult(changes,grant,{id:"board",source:"a.md",revision:String(revision+1),surface:"excalidraw"},before,draft);
    await transactions.prepare(changes,grant,"excalidraw",result.receipt,before);await transactions.transition(result.receipt,"applying");
    objects.splice(0,objects.length,...draft);revision++;commits++;
    result.receipt=(await transactions.transition(result.receipt,"applied")).receipt;grant.onSurfaceCommit?.(result.receipt);
    // This object is visible in every later read; it was never in the compiled transaction.
    objects.push({id:`human-${revision}`,type:"freedraw",createdBy:"human"});
    await transactions.transition(result.receipt,"saving");
    await options.duringSave?.();
    if(options.wrongClient){result.receipt.clientId="wrong-client";result.receipt.durability="committed";return result;}
    if(options.failure){result.receipt=(await transactions.transition(result.receipt,options.failure==="applied-not-durable"?"applied":"unknown")).receipt;throw new SurfaceCommitError("save-needs-reconciliation",result);}
    result.receipt=(await transactions.transition(result.receipt,"committed")).receipt;return result;
  }};
  const tools=new TutorMcpTools({transactions,tasks,surfaces:async()=>[surface as SurfaceAdapter],context:async source=>({source,start:0,end:0,text:"",revision:"1"}),memory:async()=>[],run:async()=>[]});
  const grant:TutorClientGrant={clientId:"a",name:"A",createdAt:new Date().toISOString(),documents:["a.md"],targets:["board"],humanObjectIds:[],read:true,write:true,learningMemory:false};
  const client=async(g=grant)=>{const [a,b]=InMemoryTransport.createLinkedPair(),server=tools.server(g),client=new Client({name:"R04",version:"1"});await server.connect(b);await client.connect(a);cleanup.push(()=>client.close());cleanup.push(()=>server.close());return client;};
  let request=0;
  const change=async(client:Client,operations:ExcalidrawOperation[],id?:string):Promise<ChangeSet<ExcalidrawOperation>>=>{
    const task=data(await call(client,"tutor_begin_change",{targetId:"board",key:`draft-${++request}`})).task;
    return {id:id??`change-${request}`,taskId:task.id,targetId:"board",baseRevision:task.target.revision,dependencies:[],operations};
  };
  return {tasks,tools,surface,grant,client,change,grants,objects,commits:()=>commits};
}
const addOperation:ExcalidrawOperation={type:"add",id:"shape",shape:"rectangle",x:0,y:0,width:50,height:50};
describe("R04 MCP transaction ownership",()=>{
  it("grants only the client's compiled IDs across human additions and interleaved clients",async()=>{
    const f=concurrentSurface(),a=await f.client(),b=await f.client({...f.grant,clientId:"b"});
    expect(data(await call(a,"tutor_status")).surfaceCommitReceiptVersions).toEqual([1]);
    const first=await call(a,"tutor_commit_change",{changes:await f.change(a,[addOperation]),receiptVersion:1});
    expect(first.isError).toBeFalsy();expect(data(first).receipt.createdIds).toEqual(["a-shape","a-shape-label"]);
    expect((await call(b,"tutor_commit_change",{changes:await f.change(b,[addOperation])})).isError).toBeFalsy();
    for(const id of ["human-1","b-shape","historical-tutor"]){
      expect((await call(a,"tutor_commit_change",{changes:await f.change(a,[{type:"update",id,style:{strokeColor:"#ff0000"}}])})).isError).toBe(true);
    }
    expect((await call(a,"tutor_commit_change",{changes:await f.change(a,[{type:"update",id:"a-shape-label",text:"updated"}])})).isError).toBeFalsy();
    for(const grant of f.grants.filter(grant=>grant.clientId==="a").slice(1))expect(grant.ids.sort()).toEqual(["a-shape","a-shape-label"]);
    expect(f.grants.find(grant=>grant.clientId==="b")!.ids).toEqual([]);
  });
  it.each(["applied-not-durable","outcome-unknown"] as const)("returns the negotiated %s receipt without granting IDs or reapplying",async failure=>{
    const f=concurrentSurface({failure}),client=await f.client(),changes=await f.change(client,[addOperation]);
    const first=await call(client,"tutor_commit_change",{changes,receiptVersion:1});
    expect(first.isError).toBe(true);expect(data(first).receipt).toMatchObject({durability:failure,createdIds:["a-shape","a-shape-label"]});
    expect(data(first).receipt.createdIds).not.toContain("human-1");
    const second=await call(client,"tutor_commit_change",{changes,receiptVersion:1});
    expect(second.isError).toBe(true);expect(data(second).receipt).toEqual(data(first).receipt);expect(f.commits()).toBe(1);
    expect((await call(client,"tutor_commit_change",{changes:await f.change(client,[{type:"update",id:"a-shape"}])})).isError).toBe(true);
    expect(f.grants.at(-1)!.ids).toEqual([]);expect(f.commits()).toBe(1);
  });
  it("coalesces concurrent retries before the first asynchronous commit has completed",async()=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),saved=new Promise<void>(resolve=>{release=resolve;});
    const f=concurrentSurface({duringSave:async()=>{entered();await saved;}}),client=await f.client(),changes=await f.change(client,[addOperation]);
    const first=call(client,"tutor_commit_change",{changes,receiptVersion:1});await started;
    const second=call(client,"tutor_commit_change",{changes,receiptVersion:1});release();
    const results=await Promise.all([first,second]);
    expect(results.every(result=>!result.isError)).toBe(true);expect(data(results[0]!).receipt).toEqual(data(results[1]!).receipt);expect(f.commits()).toBe(1);
  });
  it("merges two distinct concurrent transactions for the same client and target",async()=>{
    let entered!:()=>void,release!:()=>void,saves=0;
    const started=new Promise<void>(resolve=>{entered=resolve;}),saved=new Promise<void>(resolve=>{release=resolve;});
    const f=concurrentSurface({duringSave:async()=>{if(++saves===1){entered();await saved;}}}),client=await f.client();
    const firstChange=await f.change(client,[{...addOperation,id:"first"}]);
    const first=call(client,"tutor_commit_change",{changes:firstChange,receiptVersion:1});await started;
    // The first application has advanced the scene, while its save and ownership update remain pending.
    const second=await call(client,"tutor_commit_change",{changes:await f.change(client,[{...addOperation,id:"second"}]),receiptVersion:1});
    expect(second.isError).toBeFalsy();release();expect((await first).isError).toBeFalsy();
    const edit=await call(client,"tutor_commit_change",{changes:await f.change(client,[{type:"update",id:"a-first-label"},{type:"update",id:"a-second-label"}])});
    expect(edit.isError).toBeFalsy();expect(f.grants.at(-1)!.ids.sort()).toEqual(["a-first","a-first-label","a-second","a-second-label"]);
    expect(f.grants.at(-1)!.ids.some(id=>id.startsWith("human-"))).toBe(false);
  });
  it("does not accept a receipt belonging to another client",async()=>{
    const f=concurrentSurface({wrongClient:true}),client=await f.client();
    const result=await call(client,"tutor_commit_change",{changes:await f.change(client,[addOperation]),receiptVersion:1});
    expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain("surface-commit-receipt-mismatch");
    const edit=await call(client,"tutor_commit_change",{changes:await f.change(client,[{type:"update",id:"a-shape"}])});
    expect(edit.isError).toBe(true);expect(f.grants.at(-1)!.ids).toEqual([]);
  });
});

describe("R04 MCP persisted recovery",()=>{
  function persistentFixture(){
    const disk=surfaceJournalFixture();let failSave=false,saves=0,applications=0;
    const history=new BoardHistory(createBoardDocument("a.tutorboard.md","standalone","board"));
    const grant:TutorClientGrant={clientId:"persisted-client",name:"A",createdAt:new Date().toISOString(),documents:[],targets:["board"],humanObjectIds:[],read:true,write:true,learningMemory:false};
    const boot=()=>{
      const tasks=new TutorTaskCoordinator(),transactions=disk.reload();cleanup.push(()=>tasks.dispose());
      const surface=new TutorBoardSurface("board","studio",{history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>[],preview:async()=>"<svg/>",changed:()=>{applications++;},save:async()=>{saves++;if(failSave)throw new Error("disk-full");}},transactions);
      const tools=new TutorMcpTools({tasks,transactions,surfaces:async()=>[surface],context:async source=>({source,start:0,end:0,text:"",revision:"0"}),memory:async()=>[],run:async()=>[]});
      const client=async(g=grant)=>{const [a,b]=InMemoryTransport.createLinkedPair(),server=tools.server(g),client=new Client({name:"restart-test",version:"1"});await server.connect(b);await client.connect(a);cleanup.push(()=>client.close());cleanup.push(()=>server.close());return client;};
      return {tasks,tools,client};
    };
    const object:BoardObject={id:"persistent-object",kind:"text",anchor:{kind:"canvas",pageId:"main"},x:0,y:0,width:100,height:60,color:"#111111",strokeWidth:2,text:"private content",createdBy:"human",editedBy:"human",revision:1,groupId:"original"};
    const begin=async(client:Client)=>{const task=data(await call(client,"tutor_begin_change",{targetId:"board",key:crypto.randomUUID()})).task;return {id:crypto.randomUUID(),taskId:task.id,targetId:"board",baseRevision:task.target.revision,dependencies:[],operations:[{type:"add",object}]};};
    return {boot,grant,begin,history,counts:()=>({saves,applications}),failSave:(fail:boolean)=>{failSave=fail;}};
  }
  it("returns the recorded receipt and task after restart without reapplying or reacquiring human ownership",async()=>{
    const f=persistentFixture(),first=f.boot(),client=await first.client(),changes=await f.begin(client);
    const original=await call(client,"tutor_commit_change",{changes,receiptVersion:1});expect(original.isError).toBeFalsy();
    const reboot=f.boot(),reconnected=await reboot.client(),other=await reboot.client({...f.grant,clientId:"another-client"});
    expect(data(await call(reconnected,"tutor_task_status",{taskId:changes.taskId})).task).toMatchObject({state:"completed",phase:"completed",commit:{transactionId:changes.id}});
    expect((await call(other,"tutor_task_status",{taskId:changes.taskId})).isError).toBe(true);
    expect(data(await call(reconnected,"tutor_commit_change",{changes,receiptVersion:1})).receipt).toEqual(data(original).receipt);
    expect(f.counts()).toEqual({saves:1,applications:1});
    const draft=data(await call(reconnected,"tutor_begin_change",{targetId:"board",key:"edit"})).task,object=f.history.document.objects[0]!;
    const edited=await call(reconnected,"tutor_commit_change",{changes:{id:"edit",taskId:draft.id,targetId:"board",baseRevision:draft.target.revision,dependencies:[],operations:[{type:"update",objectId:object.id,expectedRevision:object.revision,object:{...object,x:12}}]},receiptVersion:1});
    expect(edited.isError).toBeFalsy();expect(data(edited).receipt.updatedIds).toEqual([object.id]);
  });
  it("exposes save-only recovery after restart and scopes it to the original client",async()=>{
    const f=persistentFixture(),first=f.boot(),client=await first.client(),changes=await f.begin(client);f.failSave(true);
    const failed=await call(client,"tutor_commit_change",{changes,receiptVersion:1});expect(failed.isError).toBe(true);expect(data(failed).receipt.durability).toBe("applied-not-durable");
    const reboot=f.boot(),reconnected=await reboot.client(),other=await reboot.client({...f.grant,clientId:"another-client"}),readonly=await reboot.client({...f.grant,write:false});
    expect(data(await call(reconnected,"tutor_task_status",{taskId:changes.taskId})).task).toMatchObject({state:"input-required",phase:"applied-not-saved"});
    expect((await call(reconnected,"tutor_commit_change",{changes,receiptVersion:1})).isError).toBe(true);
    const recover={targetId:"board",transactionId:changes.id,receiptVersion:1};
    expect((await call(other,"tutor_recover_change",recover)).isError).toBe(true);
    expect(data(await call(readonly,"tutor_recover_change",recover)).receipt.durability).toBe("applied-not-durable");
    expect((await call(readonly,"tutor_recover_change",{...recover,action:"retry-save"})).isError).toBe(true);
    expect(f.counts()).toEqual({saves:1,applications:1});f.failSave(false);
    const recovered=await call(reconnected,"tutor_recover_change",{...recover,action:"retry-save"});expect(recovered.isError).toBeFalsy();expect(data(recovered).receipt.durability).toBe("committed");
    expect(f.counts()).toEqual({saves:2,applications:1});expect(data(await call(reconnected,"tutor_task_status",{taskId:changes.taskId})).task.state).toBe("completed");
  });
});
