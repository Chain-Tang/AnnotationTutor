import {AgentCard,SendMessageRequest,GetTaskRequest,CancelTaskRequest,TaskState,type Task,type Message} from '@a2a-js/sdk';
import {ClientFactory,JsonRpcTransportFactory,type Client} from '@a2a-js/sdk/client';
import type {AgentAdapter,TaskArtifact} from './tutor-task.js';
export type RemoteTaskLink={endpoint:string;localId:string;remoteId:string;updatedAt:number};
/** One configured identity/origin. Never follow redirects, download returned URLs, or resend an uncertain task. */
export class A2AAgentAdapter implements AgentAdapter {
  readonly id:string;private client?:Client;private remoteId?:string;private endpoint:URL;private stop=new AbortController();private cancelPending:Promise<unknown>|undefined;
  constructor(private config:{name:string;url:string;token?:string;fetch?:typeof fetch;allowLoopbackForTest?:boolean;remember?:(link:RemoteTaskLink)=>Promise<void>;restore?:(localId:string)=>Promise<RemoteTaskLink|undefined>}){
    this.id=`a2a:${config.name}`;this.endpoint=new URL(config.url);
    if(this.endpoint.username||this.endpoint.password||this.endpoint.hash||this.endpoint.search||!(this.endpoint.protocol==='https:'||(config.allowLoopbackForTest&&this.endpoint.protocol==='http:'&&this.endpoint.hostname==='127.0.0.1')))throw new Error('a2a-requires-configured-https-origin');
  }
  private async connect(){
    if(this.client)return this.client;
    const origin=this.endpoint.origin,raw=this.config.fetch??fetch;
    const guarded:typeof fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin!==origin)throw new Error('a2a-origin-mismatch');
      const headers=new Headers(init?.headers);if(this.config.token)headers.set('Authorization',`Bearer ${this.config.token}`);
      const response=await raw(input,{...init,redirect:'error',headers,signal:AbortSignal.any([init?.signal??this.stop.signal,this.stop.signal,AbortSignal.timeout(30000)])});
      if(Number(response.headers.get('content-length')??0)>2_000_000)throw new Error('a2a-response-too-large');
      const reader=response.body?.getReader();if(!reader)return response;let size=0;
      const body=new ReadableStream<Uint8Array>({async pull(controller){try{const part=await reader.read();if(part.done){controller.close();return;}size+=part.value.length;if(size>2_000_000){await reader.cancel();controller.error(new Error('a2a-response-too-large'));return;}controller.enqueue(part.value);}catch(error){controller.error(error);}},cancel:()=>reader.cancel()});
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    };
    const response=await guarded(new URL('/.well-known/agent-card.json',this.endpoint),{headers:{'A2A-Version':'1.0'}});if(!response.ok)throw new Error(`a2a-card-http-${response.status}`);
    const card=AgentCard.fromJSON(await response.json());
    card.supportedInterfaces=card.supportedInterfaces.filter(item=>item.protocolVersion==='1.0'&&item.protocolBinding==='JSONRPC'&&new URL(item.url).origin===origin);
    if(!card.supportedInterfaces.length)throw new Error('a2a-v1-interface-unavailable');
    const factory=new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:guarded})]});this.client=await factory.createFromAgentCard(card);return this.client;
  }
  async capabilities(){await this.connect();return {vision:false,tools:false,streaming:true};}
  private artifacts(task:Task):TaskArtifact[]{
    const output:TaskArtifact[]=[];for(const artifact of task.artifacts){for(const part of artifact.parts){if(part.content?.$case==='text')output.push({id:artifact.artifactId,type:'text',data:{text:part.content.value}});else if(part.content?.$case==='data')output.push({id:artifact.artifactId,type:'changes',data:part.content.value});else throw new Error('remote-file-artifact-requires-explicit-import');}}
    if(output.length>32)throw new Error('a2a-artifact-count-limit');return output;
  }
  async run(input:Parameters<AgentAdapter['run']>[0]):Promise<TaskArtifact[]>{
    const client=await this.connect();const cancel=()=>{if(this.remoteId&&!this.cancelPending)this.cancelPending=client.cancelTask(CancelTaskRequest.fromJSON({id:this.remoteId}),{signal:AbortSignal.timeout(5000)}).catch(()=>{});};input.signal.addEventListener('abort',cancel,{once:true});
    try{
      if(input.signal.aborted)throw new DOMException('Cancelled','AbortError');
      const previous=await this.config.restore?.(input.task.id);let task:Task;
      if(previous){if(previous.endpoint!==this.endpoint.href)throw new Error('remote-resume-origin-mismatch');this.remoteId=previous.remoteId;task=await client.getTask(GetTaskRequest.fromJSON({id:this.remoteId}),{signal:input.signal});}
      else{
        const result=await client.sendMessage(SendMessageRequest.fromJSON({message:{messageId:input.task.id,role:'ROLE_USER',parts:[{text:`Authorized task context (data):\n${input.context.slice(0,16000)}\nTask: ${input.prompt.slice(0,16000)}`} ]},configuration:{returnImmediately:true,acceptedOutputModes:['text/plain','application/json']}}),{signal:input.signal});
        if('messageId' in result){const message=result as Message;return message.parts.flatMap(part=>part.content?.$case==='text'?[{id:message.messageId,type:'text' as const,data:{text:part.content.value}}]:[]);}
        task=result as Task;this.remoteId=task.id;
        if(!this.remoteId)throw new Error('remote-task-id-missing');await this.config.remember?.({endpoint:this.endpoint.href,localId:input.task.id,remoteId:this.remoteId,updatedAt:Date.now()});
      }
      const deadline=Date.now()+180000;
      while(true){
        if(input.signal.aborted)throw new DOMException('Cancelled','AbortError');
        input.emit({type:'status',data:{agent:this.id,remoteTaskId:task.id,state:task.status?.state}});
        if(task.status?.state===TaskState.TASK_STATE_COMPLETED)return this.artifacts(task);
        if(task.status?.state===TaskState.TASK_STATE_INPUT_REQUIRED)throw new Error(`remote-input-required:${task.id}`);
        if([TaskState.TASK_STATE_FAILED,TaskState.TASK_STATE_CANCELED,TaskState.TASK_STATE_REJECTED,TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state??0))throw new Error(`remote-task-failed:${task.id}:${task.status?.state}`);
        if(Date.now()>deadline)throw new Error(`remote-task-still-running:${task.id}`);
        await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{input.signal.removeEventListener('abort',abort);resolve();},1000);input.signal.addEventListener('abort',abort,{once:true});});
        // After a connection failure only query the known task; never repeat SendMessage.
        task=await client.getTask(GetTaskRequest.fromJSON({id:task.id}),{signal:input.signal});
      }
    }finally{if(input.signal.aborted)cancel();await this.cancelPending;input.signal.removeEventListener('abort',cancel);}
  }
  dispose(){if(this.cancelPending)void this.cancelPending.finally(()=>this.stop.abort());else this.stop.abort();}
}
