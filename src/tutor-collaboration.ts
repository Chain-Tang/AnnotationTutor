import type { AgentAdapter, TaskArtifact, TaskTarget, TutorTask, TutorTaskCoordinator } from "./tutor-task.js";

/** Experts return independent artifacts. Only the lead summarizes; no adapter can commit. */
export class TutorCollaboration {
  constructor(private readonly tasks:TutorTaskCoordinator){}
  start(input:{clientId:string;key?:string;prompt:string;context:string;target?:TaskTarget;signal?:AbortSignal;lead:AgentAdapter;experts:AgentAdapter[]}):TutorTask{
    if(input.signal?.aborted){input.lead.dispose();for(const expert of input.experts)expert.dispose();throw new DOMException("Cancelled","AbortError");}
    if(input.experts.length>2)throw new Error("parallel-agent-budget-exceeded");
    const root=this.tasks.start({clientId:input.clientId,key:input.key,lead:"tutor",agent:"tutor",target:input.target});
    if(root.state==="queued")void this.run(root,input);else {input.lead.dispose();for(const expert of input.experts)expert.dispose();}return root;
  }
  private emit(task:TutorTask,event:Parameters<AgentAdapter['run']>[0]['emit'] extends (e:infer E)=>void?E:never):void{
    if(event.type==='status'&&event.data&&typeof event.data==='object'&&'route' in event.data){
      const route=event.data.route as {engine?:unknown;model?:unknown};
      if(typeof route.engine==='string'&&typeof route.model==='string')this.tasks.phase(task.id,task.clientId,this.tasks.get(task.id,task.clientId).phase,{engine:route.engine,model:route.model});
    }
    this.tasks.emit(task.id,task.clientId,event);
  }
  private async run(root:TutorTask,input:Parameters<TutorCollaboration["start"]>[0]):Promise<void>{
    const client=root.clientId;
    const cancel=()=>this.tasks.cancel(root.id,client);
    input.signal?.addEventListener("abort",cancel,{once:true});
    try{
      if(input.signal?.aborted){cancel();return;}
      this.tasks.phase(root.id,client,"experts");
      const children=input.experts.map(adapter=>({adapter,task:this.tasks.start({clientId:client,parentId:root.id,agent:adapter.id,target:root.target})}));
      const drafts=await Promise.all(children.map(async({adapter,task})=>{
        try{
          this.tasks.phase(task.id,client,"working");this.tasks.consume(task.id,client,"modelCalls");
          const result=await adapter.run({task,prompt:input.prompt,context:input.context,signal:this.tasks.signal(task.id,client),emit:event=>this.emit(task,event)});
          this.tasks.complete(task.id,client,result);return {agent:adapter.id,artifacts:result};
        }catch(error){this.tasks.fail(task.id,client,"expert-failed",error instanceof Error?error.message:"Expert failed");return {agent:adapter.id,error:"Expert task failed; do not infer its answer."};}
        finally{adapter.dispose();}
      }));
      if(this.tasks.signal(root.id,client).aborted)return;
      this.tasks.phase(root.id,client,"tutor-summary");this.tasks.consume(root.id,client,"modelCalls");
      const result=await input.lead.run({task:root,prompt:`${input.prompt}\nYou are the lead Tutor. Review the independent expert results below, resolve supported differences and explain remaining uncertainty. Do not claim that an artifact has been applied.\n${JSON.stringify(drafts).slice(0,48000)}`,context:input.context,signal:this.tasks.signal(root.id,client),emit:event=>this.emit(root,event)});
      const artifacts:TaskArtifact[]=[...drafts.flatMap(draft=>"artifacts" in draft?draft.artifacts??[]:[]),...result];
      this.tasks.complete(root.id,client,artifacts);
    }catch(error){this.tasks.fail(root.id,client,"collaboration-failed",error instanceof Error?error.message:"Collaboration failed");}
    finally{input.signal?.removeEventListener("abort",cancel);input.lead.dispose();for(const adapter of input.experts)adapter.dispose();}
  }
}
