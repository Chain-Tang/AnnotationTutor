import {AgentCard,Task,StreamResponse,ListTasksResponse,type SendMessageRequest,type GetTaskRequest,type CancelTaskRequest,type SubscribeToTaskRequest,type ListTasksRequest} from '@a2a-js/sdk';
import {JsonRpcTransportHandler,type A2ARequestHandler} from '@a2a-js/sdk/server';
import {UnsupportedOperationError,RequestMalformedError,TaskNotFoundError} from '@a2a-js/sdk/errors';
import type {TutorMcpTools,TutorClientGrant} from './tutor-mcp.js';
import type {TutorTask,TutorTaskCoordinator} from './tutor-task.js';
const state={queued:'TASK_STATE_SUBMITTED',working:'TASK_STATE_WORKING','input-required':'TASK_STATE_INPUT_REQUIRED',completed:'TASK_STATE_COMPLETED',failed:'TASK_STATE_FAILED',cancelled:'TASK_STATE_CANCELED'};
const ended=(task:TutorTask)=>!['queued','working'].includes(task.state);
export function tutorAgentCard(url:string):AgentCard{return AgentCard.fromJSON({name:'Tutor',description:'Independent teaching and scoped drawing drafts. Changes use the same authorized transaction service as MCP.',version:'0.6.0',supportedInterfaces:[{url,protocolBinding:'JSONRPC',protocolVersion:'1.0'}],capabilities:{streaming:true,pushNotifications:false},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain','application/json'],skills:[{id:'teach',name:'Teach and review',description:'Explain authorized learning context',tags:['education']},{id:'drawing',name:'Propose scoped drawing changes',description:'Versioned editable drawings; explicit commit through shared host validation',tags:['drawing']}],securitySchemes:{pairing:{httpAuthSecurityScheme:{scheme:'bearer'}}},securityRequirements:[{schemes:{pairing:{list:[]}}}]});}
function asTask(task:TutorTask):Task{return Task.fromJSON({id:task.id,contextId:task.id,status:{state:state[task.state],timestamp:new Date(task.updatedAt).toISOString(),message:{messageId:`status-${task.updatedAt}`,role:'ROLE_AGENT',parts:[{text:task.error?.message??task.phase}],contextId:task.id,taskId:task.id}},artifacts:task.artifacts.map(a=>({artifactId:a.id,parts:[a.type==='text'?{text:typeof a.data==='string'?a.data:(a.data as {text?:string}).text??''}:{data:a.data}]})),metadata:{route:task.route,metrics:task.metrics,target:task.target},history:[]});}
/** A2A is a transport over the existing task and transaction core, not a second writer. */
export class TutorA2AService {
  private readonly pending=new Map<string,{signature:string;result:Promise<TutorTask>}>();
  private readonly messages=new Map<string,{signature:string;taskId:string}>();
  constructor(private readonly tools:TutorMcpTools,private readonly tasks:TutorTaskCoordinator){}
  card(url:string){return tutorAgentCard(url);}
  handler(grant:TutorClientGrant,url:string,signal:AbortSignal,stillAuthorized:()=>boolean):JsonRpcTransportHandler{
    const call=async(name:string,args:Record<string,unknown>)=>{if(!stillAuthorized())throw new TaskNotFoundError();return this.tools.invoke(grant,name,args);};
    const get=(id:string)=>{if(!stillAuthorized())throw new TaskNotFoundError();try{return this.tasks.get(id,grant.clientId);}catch{throw new TaskNotFoundError();}};
    const execute=async(params:SendMessageRequest)=>{
      const message=params.message;if(!message||!message.messageId||message.messageId.length>160||message.role!==1||params.configuration?.taskPushNotificationConfig)throw new RequestMalformedError();
      if(message.parts.some(p=>p.content?.$case!=='text'))throw new RequestMalformedError({message:'Only text requests are accepted; use metadata for typed drawing changes.'});
      const prompt=message.parts.map(p=>p.content?.$case==='text'?p.content.value:'').join('\n');
      const key=JSON.stringify([grant.clientId,message.messageId]),signature=JSON.stringify(params),prior=this.messages.get(key);
      if(prior){if(prior.signature!==signature)throw new RequestMalformedError({message:'Message id reused with different contents'});return get(prior.taskId);}
      if(message.taskId&&message.contextId&&message.contextId!==message.taskId)throw new RequestMalformedError();
      const metadata=params.metadata??message.metadata??{};let result:Record<string,unknown>;
      if(metadata.action==='commit'){
        if(!message.taskId)throw new RequestMalformedError();get(message.taskId);
        const changes=metadata.changes;if(!changes||changes.taskId!==message.taskId)throw new RequestMalformedError();
        await call('tutor_commit_change',{changes});result={task:get(message.taskId)};
      }else if(message.taskId){get(message.taskId);result=await call('tutor_supply_input',{taskId:message.taskId,text:prompt});}
      else result=await call('tutor_start_task',{prompt,key:`a2a:${message.messageId}`,...(typeof metadata.targetId==='string'?{targetId:metadata.targetId}:{}),...(typeof metadata.source==='string'?{source:metadata.source}:{})});
      const task=result.task as TutorTask;this.messages.set(key,{signature,taskId:task.id});if(this.messages.size>200)this.messages.delete(this.messages.keys().next().value!);return task;
    };
    const start=(params:SendMessageRequest):Promise<TutorTask>=>{
      const key=JSON.stringify([grant.clientId,params.message?.messageId]),signature=JSON.stringify(params);
      const pending=this.pending.get(key);
      if(pending){if(pending.signature!==signature)throw new RequestMalformedError({message:'Message id reused with different contents'});return pending.result;}
      if(this.pending.size>=100)throw new RequestMalformedError({message:'Too many active messages'});
      const result=execute(params);this.pending.set(key,{signature,result});
      void result.finally(()=>this.pending.delete(key)).catch(()=>{});return result;
    };
    const events=async function*(tasks:TutorTaskCoordinator,task:TutorTask):AsyncGenerator<StreamResponse>{
      let latest:TutorTask|undefined=task,wake:(()=>void)|undefined;const off=tasks.subscribe(value=>{if(value.id===task.id&&value.clientId===grant.clientId){latest=value;wake?.();}});
      latest=get(task.id); // Re-read after subscribing: completion can race SendMessage's return.
      const abort=()=>wake?.();signal.addEventListener('abort',abort);
      try{while(!signal.aborted){if(!stillAuthorized())throw new TaskNotFoundError();if(latest){const value=latest;latest=undefined;yield StreamResponse.fromJSON({task:Task.toJSON(asTask(value))});if(ended(value))return;}if(latest)continue;await new Promise<void>(resolve=>{let timer:ReturnType<typeof setTimeout>;wake=()=>{clearTimeout(timer);resolve();};timer=setTimeout(wake,1000);if(signal.aborted)wake();});}}
      finally{off();signal.removeEventListener('abort',abort);}
    };
    const unsupported=async():Promise<never>=>{throw new UnsupportedOperationError();};
    const coordinator=this.tasks;
    const handler:A2ARequestHandler={
      getAgentCard:async()=>this.card(url),getAuthenticatedExtendedAgentCard:async()=>this.card(url),
      sendMessage:async params=>{let task=await start(params);if(!params.configuration?.returnImmediately)for await(const _ of events(this.tasks,task))task=get(task.id);return asTask(task);},
      sendMessageStream:async function*(params:SendMessageRequest){yield*events(coordinator,await start(params));},
      getTask:async(params:GetTaskRequest)=>asTask(get(params.id)),cancelTask:async(params:CancelTaskRequest)=>{const data=await call('tutor_cancel_task',{taskId:params.id});return asTask(data.task as TutorTask);},
      resubscribe:async function*(params:SubscribeToTaskRequest){yield*events(coordinator,get(params.id));},
      listTasks:async(params:ListTasksRequest)=>{const offset=Number(params.pageToken||0);if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw new RequestMalformedError();const rows=this.tasks.list(grant.clientId,offset,params.pageSize??30);return ListTasksResponse.fromJSON({tasks:rows.filter(t=>!params.contextId||t.id===params.contextId).map(t=>Task.toJSON(asTask(t))),nextPageToken:rows.length===(params.pageSize??30)?String(offset+rows.length):''});},
      createTaskPushNotificationConfig:unsupported,getTaskPushNotificationConfig:unsupported,listTaskPushNotificationConfigs:unsupported,deleteTaskPushNotificationConfig:unsupported,
    };
    return new JsonRpcTransportHandler(handler);
  }
}
