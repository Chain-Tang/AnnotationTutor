import {describe,it,expect} from 'vitest';
import {ClientFactory,JsonRpcTransportFactory} from '@a2a-js/sdk/client';
import {SendMessageRequest,GetTaskRequest,CancelTaskRequest,SubscribeToTaskRequest,TaskState} from '@a2a-js/sdk';
import {TutorTaskCoordinator} from '../src/tutor-task.js';
import {TutorMcpTools,type TutorClientGrant,type TutorMcpHost} from '../src/tutor-mcp.js';
import {TutorA2AService} from '../src/tutor-a2a.js';
import {LocalBoardMcpAdapter} from '../src/board-mcp.js';
import {DefaultBoardToolRuntime} from '../src/board-tools.js';
import {A2AAgentAdapter} from '../src/tutor-a2a-client.js';
const grant:TutorClientGrant={clientId:'a',name:'Expert',read:true,write:false,learningMemory:false,targets:[],humanObjectIds:[],documents:['qa.md'],createdAt:new Date().toISOString()};
async function fixture(run:TutorMcpHost['run']=async()=>{await new Promise(r=>setTimeout(r,40));return [{id:'answer',type:'text',data:{text:'A2A answer'}}];}){const tasks=new TutorTaskCoordinator(),tools=new TutorMcpTools({tasks,surfaces:async()=>[],context:async(source)=>({source,start:0,end:0,text:'authorized context',revision:'1'}),memory:async()=>[],run});const server=new LocalBoardMcpAdapter(new DefaultBoardToolRuntime(),{tutor:tools,a2a:new TutorA2AService(tools,tasks),authenticate:token=>token==='a'?grant:token==='b'?{...grant,clientId:'b'}:undefined});const endpoint=await server.start(),url=`http://127.0.0.1:${endpoint.port}`;const client=async(token:string)=>new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:(input,init)=>fetch(input,{...init,headers:{...Object.fromEntries(new Headers(init?.headers).entries()),Authorization:`Bearer ${token}`}})})]}).createFromUrl(url);return {tasks,tools,server,url,client,close:async()=>{tasks.dispose();await server.stop();}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
describe('A2A 1.0 SDK integration',()=>{
 it('deduplicates concurrent messages and terminates subscriptions opened after completion',async()=>{const f=await fixture();try{const a=await f.client('a');const req=SendMessageRequest.fromJSON({message:{messageId:'concurrent',role:'ROLE_USER',parts:[{text:'Explain'}]},configuration:{returnImmediately:true}});const results=await Promise.all([a.sendMessage(req),a.sendMessage(req)]);expect((results[0] as {id:string}).id).toBe((results[1] as {id:string}).id);expect(f.tasks.list('a')).toHaveLength(1);await new Promise(r=>setTimeout(r,80));let count=0;for await(const event of a.resubscribeTask(SubscribeToTaskRequest.fromJSON({id:(results[0] as {id:string}).id}),{signal:AbortSignal.timeout(1000)})){count++;expect(event.payload?.$case==='task'&&event.payload.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);}expect(count).toBe(1);}finally{await f.close();}});

 it('uses official client discovery, shared task handles, status and client isolation',async()=>{const f=await fixture();try{const a=await f.client('a'),b=await f.client('b');const req=SendMessageRequest.fromJSON({message:{messageId:'one',role:'ROLE_USER',parts:[{text:'Explain'}]},configuration:{returnImmediately:true},metadata:{source:'qa.md'}});const started=await a.sendMessage(req);if(!('id'in started))throw Error('not a task');expect((await a.sendMessage(req) as {id:string}).id).toBe(started.id);await expect(b.getTask(GetTaskRequest.fromJSON({id:started.id}))).rejects.toThrow();for await(const event of a.resubscribeTask(SubscribeToTaskRequest.fromJSON({id:started.id}))){expect(event.payload?.$case).toBe('task');}expect((await a.getTask(GetTaskRequest.fromJSON({id:started.id}))).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);expect(f.tasks.get(started.id,'a').artifacts).toHaveLength(1);}finally{await f.close();}});
 it('propagates cancellation and never returns a late model answer',async()=>{
  const entered=deferred<AbortSignal>(),release=deferred<void>(),returned=deferred<void>();
  const f=await fixture(async input=>{
   entered.resolve(input.signal);
   // The provider deliberately ignores abort and returns only after cancellation
   // is acknowledged, regardless of SDK round-trip or coverage instrumentation.
   await release.promise;
   returned.resolve();
   return [{id:'answer',type:'text',data:{text:'A2A answer'}}];
  });
  try{
   const a=await f.client('a');
   const task=await a.sendMessage(SendMessageRequest.fromJSON({message:{messageId:'cancel',role:'ROLE_USER',parts:[{text:'Explain'}]},configuration:{returnImmediately:true}}));
   if(!('id'in task))throw Error('not a task');
   const signal=await entered.promise;
   const cancelled=await a.cancelTask(CancelTaskRequest.fromJSON({id:task.id}));
   expect(cancelled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
   expect(signal.aborted).toBe(true);
   expect(f.tasks.get(task.id,'a')).toMatchObject({state:'cancelled',artifacts:[]});
   release.resolve();await returned.promise;
   const settled=await a.getTask(GetTaskRequest.fromJSON({id:task.id}));
   expect(settled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
   expect(settled.artifacts).toEqual([]);
   expect(f.tasks.get(task.id,'a')).toMatchObject({state:'cancelled',artifacts:[]});
  }finally{release.resolve();await f.close();}
 });
 it('runs an outbound adapter against an actual local SDK server and records resumable task identity',async()=>{const f=await fixture();try{let link:unknown;const adapter=new A2AAgentAdapter({name:'local-test',url:f.url,token:'a',allowLoopbackForTest:true,remember:async value=>{link=value;}});const task=f.tasks.start({clientId:'test-parent',agent:'external'});const result=await adapter.run({task,prompt:'Explain',context:'test data',signal:new AbortController().signal,emit:()=>{}});expect(result[0]?.data).toEqual({text:'A2A answer'});expect(link).toMatchObject({localId:task.id});adapter.dispose();}finally{await f.close();}});
});
