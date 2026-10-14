import { afterEach, expect, it, vi } from "vitest";
import { ServiceWork } from "../src/service-work.js";
import { TutorMcpTools, type TutorClientGrant, type TutorMcpHost } from "../src/tutor-mcp.js";
import { TutorTaskCoordinator } from "../src/tutor-task.js";
import { TutorBoardSurface } from "../src/tutor-board-surface.js";
import { BoardHistory, createBoardDocument } from "../src/board-model.js";
import { LocalBoardMcpAdapter } from "../src/board-mcp.js";
import { DefaultBoardToolRuntime } from "../src/board-tools.js";
import { surfaceJournalFixture } from "./surface-journal-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
const grant:TutorClientGrant={clientId:"external-a",name:"A",read:true,write:true,learningMemory:false,targets:["board"],humanObjectIds:[],documents:["a.md"],createdAt:new Date().toISOString()};
const cleanup:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks();});
function host(overrides:Partial<TutorMcpHost>={}){
  const tasks=new TutorTaskCoordinator();cleanup.push(()=>tasks.dispose());
  const tools=new TutorMcpTools({tasks,surfaces:async()=>[],context:async source=>({source,start:0,end:1,text:"synthetic",revision:"1"}),memory:async()=>[],run:async()=>[],...overrides});
  cleanup.unshift(()=>tools.close());return {tasks,tools};
}

it("closes synchronously, rejects a queued start and waits for actual completion after cancellation",async()=>{
  const work=new ServiceWork(),run=vi.fn(async()=>{}),queued=work.run(undefined,run);
  const closed=work.close();await expect(queued).rejects.toThrow("service-stopped");await closed;expect(run).not.toHaveBeenCalled();
  const active=new ServiceWork(),entered=deferred(),release=deferred();let signal!:AbortSignal;
  const pending=active.run(undefined,async value=>{signal=value;entered.resolve();await release.promise;return "saved";});await entered.promise;
  let finished=false;const stopped=active.close().then(()=>{finished=true;});expect(signal.aborted).toBe(true);
  await Promise.resolve();expect(finished).toBe(false);release.resolve();expect(await pending).toBe("saved");await stopped;
  await expect(active.run(undefined,run)).rejects.toThrow("service-stopped");
});

it("drains background reasoning, preserves client isolation and never starts a late provider after context lookup",async()=>{
  const contextEntered=deferred(),contextRelease=deferred(),run=vi.fn<TutorMcpHost["run"]>(async()=>[]);
  const f=host({context:async source=>{contextEntered.resolve();await contextRelease.promise;return {source,start:0,end:0,text:"",revision:"1"};},run});
  const local=f.tasks.start({clientId:"obsidian"}),other=f.tasks.start({clientId:"unrelated"});
  const {task}=await f.tools.invoke(grant,"tutor_start_task",{key:"pending",prompt:"Explain",source:"a.md"}) as {task:{id:string}};
  await contextEntered.promise;let finished=false;const stopped=f.tools.close().then(()=>{finished=true;});await Promise.resolve();
  expect(finished).toBe(false);expect(f.tasks.get(task.id,grant.clientId).state).toBe("cancelled");
  expect(f.tasks.get(local.id,"obsidian").state).toBe("queued");expect(f.tasks.get(other.id,"unrelated").state).toBe("queued");
  contextRelease.resolve();await stopped;expect(run).not.toHaveBeenCalled();
  await expect(f.tools.invoke(grant,"tutor_status",{})).rejects.toThrow("service-stopped");
});

it("waits for a provider that ignores abort and discards its late answer",async()=>{
  const entered=deferred(),release=deferred();let signal!:AbortSignal;
  const f=host({run:async input=>{signal=input.signal;entered.resolve();await release.promise;return [{id:"late",type:"text",data:{text:"late"}}];}});
  const {task}=await f.tools.invoke(grant,"tutor_start_task",{key:"pending",prompt:"Explain"}) as {task:{id:string}};
  await entered.promise;let finished=false;const stopped=f.tools.close().then(()=>{finished=true;});expect(signal.aborted).toBe(true);
  await Promise.resolve();expect(finished).toBe(false);release.resolve();await stopped;
  expect(f.tasks.get(task.id,grant.clientId)).toMatchObject({state:"cancelled",artifacts:[]});
});

it("keeps old SDK grant closures closed after draining and does not cancel future replacement-service tasks",async()=>{
  const f=host(),server=f.tools.server(grant),client=new Client({name:"old-session",version:"1"}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);cleanup.unshift(()=>server.close(),()=>client.close());
  await client.callTool({name:"tutor_status",arguments:{}});await f.tools.close();
  expect((await client.callTool({name:"tutor_status",arguments:{}})).isError).toBe(true);
  const next=f.tasks.start({clientId:grant.clientId});await f.tools.close();expect(f.tasks.get(next.id,grant.clientId).state).toBe("queued");
});

it("cancels an awaiting draft read before it can create a task after shutdown",async()=>{
  const entered=deferred(),release=deferred(),history=new BoardHistory(createBoardDocument("a.md","standalone","board"));
  const surface=new TutorBoardSurface("board","studio",{history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>[],preview:async()=>"",changed:()=>{},save:async()=>{}});
  const read=surface.read.bind(surface);vi.spyOn(surface,"read").mockImplementation(async()=>{entered.resolve();await release.promise;return read();});
  const f=host({surfaces:async()=>[surface]});
  const pending=f.tools.invoke(grant,"tutor_begin_change",{targetId:"board",key:"late"}).catch(error=>error);
  await entered.promise;const stopped=f.tools.close();release.resolve();await stopped;expect(await pending).toBeInstanceOf(Error);expect(f.tasks.list(grant.clientId)).toEqual([]);
});

it.each(["in-memory","http"] as const)("adapter shutdown drains an already-started recovery save via %s SDK and retains its real committed receipt",async transport=>{
  const disk=surfaceJournalFixture(),history=new BoardHistory(createBoardDocument("a.md","standalone","board")),entered=deferred(),release=deferred();
  let saving=false,saves=0;
  const surface=new TutorBoardSurface("board","studio",{history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>[],preview:async()=>"",changed:()=>{},save:async()=>{saves++;if(!saving)throw new Error("fixture disk failure");entered.resolve();await release.promise;}},disk.journal);
  const f=host({transactions:disk.journal,surfaces:async()=>[surface]}),adapter=new LocalBoardMcpAdapter(new DefaultBoardToolRuntime(),{tutor:f.tools,authenticate:token=>token==="synthetic-client"?grant:undefined});
  let client:Client|undefined;
  if(transport==="http"){
    const endpoint=await adapter.start();client=new Client({name:"shutdown-recovery",version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`),{requestInit:{headers:{Authorization:"Bearer synthetic-client"}}}));
    cleanup.unshift(async()=>{release.resolve();await client!.close();await adapter.stop();});
  }
  const {task}=await f.tools.invoke(grant,"tutor_begin_change",{targetId:"board",key:"draft"}) as {task:{id:string;target:{revision:string}}};
  const changes={id:"one-change",taskId:task.id,targetId:"board",baseRevision:task.target.revision,dependencies:[],operations:[{type:"add",object:{id:"shape",kind:"rect",anchor:{kind:"canvas",pageId:"main"},x:0,y:0,width:40,height:40,color:"#000000",strokeWidth:2,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:"drawing"}}]};
  await expect(f.tools.invoke(grant,"tutor_commit_change",{changes,receiptVersion:1})).rejects.toThrow("applied-not-durable");
  const args={targetId:"board",transactionId:changes.id,receiptVersion:1};
  await f.tools.invoke(grant,"tutor_recover_change",{...args,action:"inspect"});saving=true;
  const pending=(client?client.callTool({name:"tutor_recover_change",arguments:{...args,action:"retry-save"}}):f.tools.invoke(grant,"tutor_recover_change",{...args,action:"retry-save"})).catch(error=>error);await entered.promise;
  let finished=false;const stopped=adapter.stop().then(()=>{finished=true;});await Promise.resolve();expect(finished).toBe(false);
  await expect(f.tools.invoke({...grant,clientId:"external-b"},"tutor_recover_change",args)).rejects.toThrow("service-stopped");
  release.resolve();await pending;await stopped;
  expect(saves).toBe(2);expect(history.document.objects).toHaveLength(1);
  expect(f.tasks.get(task.id,grant.clientId)).toMatchObject({state:"completed",phase:"committed-after-cancel",commit:{durability:"committed"}});
});

it("drains legacy tool work and permanently rejects its next call and restart",async()=>{
  const runtime=new DefaultBoardToolRuntime(),entered=deferred(),release=deferred();
  const commit=vi.spyOn(runtime,"commit").mockImplementation(async()=>{entered.resolve();await release.promise;return {} as Awaited<ReturnType<typeof runtime.commit>>;});
  const adapter=new LocalBoardMcpAdapter(runtime),request={jsonrpc:"2.0" as const,id:1,method:"tools/call",params:{name:"board.commit",arguments:{transactionId:"pending"}}};
  const pending=adapter.handleRpc(request);await entered.promise;let finished=false;const stopped=adapter.stop().then(()=>{finished=true;});
  expect((await adapter.handleRpc(request)).error?.message).toBe("service-stopped");expect(commit).toHaveBeenCalledTimes(1);
  expect(finished).toBe(false);release.resolve();await pending;await stopped;await expect(adapter.start()).rejects.toThrow("service-stopped");
});

it("rejects a queued listener startup when shutdown wins before it starts",async()=>{
  const adapter=new LocalBoardMcpAdapter(new DefaultBoardToolRuntime()),starting=adapter.start();
  const stopped=adapter.stop();expect(adapter.stop()).toBe(stopped);
  await expect(starting).rejects.toThrow("service-stopped");await stopped;expect(adapter.running).toBe(false);
});

it("aborts pairing approval and waits for its late persistence before stopping HTTP",async()=>{
  const entered=deferred(),release=deferred();let signal!:AbortSignal;
  const adapter=new LocalBoardMcpAdapter(new DefaultBoardToolRuntime(),{pair:async(_name,value)=>{signal=value;entered.resolve();await release.promise;return {token:"synthetic-result",clientId:"synthetic-client"};}});
  const endpoint=await adapter.start();cleanup.unshift(async()=>{release.resolve();await adapter.stop();});
  const response=fetch(`http://127.0.0.1:${endpoint.port}/pair`,{method:"POST",body:JSON.stringify({name:"synthetic"})}).then(result=>result.text()).catch(()=>undefined);
  await entered.promise;let finished=false;const stopped=adapter.stop().then(()=>{finished=true;});expect(signal.aborted).toBe(true);
  await Promise.resolve();expect(finished).toBe(false);release.resolve();await stopped;expect(await response).toBeUndefined();
});
