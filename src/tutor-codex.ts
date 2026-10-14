import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, TaskArtifact } from "./tutor-task.js";

import { resolveCodexCommand } from "./codex-command.js";

type RpcMessage={id?:number|string;method?:string;params?:Record<string,unknown>;result?:unknown;error?:{message?:string}};
type Turn={id:string;status:string;error?:{message:string}|null;items?:{type:string;text?:string}[]};
/** Owns one ephemeral App Server process and one thread, never an existing Codex chat. */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly id="codex";
  private child?:ChildProcessWithoutNullStreams;
  private sequence=0;
  private readonly pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  private notify?:(message:RpcMessage)=>void;
  constructor(private readonly config:{command:string;model?:string;env?:NodeJS.ProcessEnv}){}
  async capabilities(){return {vision:false,tools:false,streaming:true};}
  private send(message:RpcMessage){if(!this.child?.stdin.writable)throw new Error("codex-disconnected");this.child.stdin.write(JSON.stringify(message)+"\n");}
  private request<T>(method:string,params:Record<string,unknown>):Promise<T>{
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve:value=>resolve(value as T),reject});try{this.send({id,method,params});}catch(error){this.pending.delete(id);reject(error);}});
  }
  async run(input:Parameters<AgentAdapter["run"]>[0]):Promise<TaskArtifact[]>{
    if(this.child)throw new Error("codex-adapter-busy");if(input.signal.aborted)throw new Error("task-cancelled");
    const runtime=await resolveCodexCommand(this.config.command,this.config.env);
    if(input.signal.aborted)throw new Error("task-cancelled");
    const cwd=await mkdtemp(join(tmpdir(),"tutor-codex-"));let threadId="",turnId="",failTurn:(error:Error)=>void=()=>{};
    const cancel=()=>{if(threadId&&turnId){try{this.send({id:++this.sequence,method:"turn/interrupt",params:{threadId,turnId}});}catch{}}failTurn(new Error("task-cancelled"));this.dispose(new Error("task-cancelled"));};
    const timer=setTimeout(()=>{failTurn(new Error("codex-time-budget-exceeded"));this.dispose(new Error("codex-time-budget-exceeded"));},180000);
    try{
      this.child=spawn(runtime.command,["app-server","--listen","stdio://"],{cwd,env:runtime.env,stdio:["pipe","pipe","pipe"],shell:false});
      let buffer="";this.child.stderr.on("data",()=>{}); // Do not retain model or user content in diagnostic logs.
      this.child.stdout.setEncoding("utf8");this.child.stdout.on("data",(chunk:string)=>{
        buffer+=chunk;if(buffer.length>2_000_000){failTurn(new Error("codex-frame-too-large"));this.dispose();return;}
        let newline:number;while((newline=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
          try{const message=JSON.parse(line) as RpcMessage;
            if(message.id!==undefined&&!message.method){const pending=this.pending.get(Number(message.id));if(pending){this.pending.delete(Number(message.id));if(message.error)pending.reject(new Error(message.error.message??"codex-rpc-failed"));else pending.resolve(message.result);}}
            else if(message.id!==undefined){
              // This adapter produces advice/drafts. It never accepts shell, file, permission or external-tool actions.
              if(message.method?.includes("requestApproval"))this.send({id:message.id,result:{decision:"decline"}});
              else this.send({id:message.id,error:{message:"This Tutor delegation does not authorize additional tools or input."}});
            }else this.notify?.(message);
          }catch{failTurn(new Error("codex-invalid-response"));this.dispose();}
        }
      });
      this.child.on("error",error=>{const failure=new Error(`codex-start-failed:${(error as NodeJS.ErrnoException).code??"unknown"}`);failTurn(failure);this.dispose(failure);});
      this.child.on("exit",()=>{failTurn(new Error("codex-disconnected"));this.dispose();});
      input.signal.addEventListener("abort",cancel,{once:true});if(input.signal.aborted)cancel();
      await this.request("initialize",{clientInfo:{name:"tutor",title:"Tutor expert adapter",version:"0.4.2"},capabilities:{experimentalApi:false}});this.send({method:"initialized"});
      const effective=await this.request<{config:Record<string,unknown>}>("config/read",{cwd,includeLayers:false});
      const installed=await this.request<{marketplaces:{plugins:{id:string}[]}[]}>("plugin/installed",{cwds:[cwd]});
      const disabledPluginIds=installed.marketplaces.flatMap(m=>m.plugins.map(p=>p.id));
      const servers=Object.fromEntries(Object.keys((effective.config.mcp_servers??{}) as object).map(name=>[name,{enabled:false}]));
      const thread=await this.request<{thread:{id:string};model:string;modelProvider:string}>("thread/start",{cwd,ephemeral:true,sandbox:"read-only",approvalPolicy:"untrusted",...(this.config.model?{model:this.config.model}:{}),
        config:{mcp_servers:servers,web_search:"disabled",features:{shell_tool:false,unified_exec:false,code_mode:false,apps:false,hooks:false,multi_agent:false},apps:{_default:{enabled:false}}},
        developerInstructions:"You are a specialist delegated by Tutor. Return an independent review or draft using only the supplied authorized context. Do not read local files, invoke tools, delegate, change learner memory, or claim to have modified a drawing. Tutor remains the lead agent."});
      threadId=thread.thread.id;input.emit({type:"status",data:{route:{engine:`codex:${thread.modelProvider}`,model:thread.model}}});let answer="";
      const completed=new Promise<Turn>((resolve,reject)=>{failTurn=reject;this.notify=message=>{
        const params=message.params;if(params?.threadId!==threadId)return;
        if(message.method==="item/agentMessage/delta" && typeof params.delta==="string"){
          answer+=params.delta;if(answer.length>200000){reject(new Error("codex-output-too-large"));this.dispose();return;}input.emit({type:"text",data:{text:params.delta}});
        }
        if(message.method==="turn/completed")resolve(params.turn as Turn);
      };});
      // Attach rejection before turn/start awaits, so cancellation cannot create an unhandled rejection.
      void completed.catch(()=>{});
      const started=await this.request<{turn:Turn}>("turn/start",{threadId,disabledPluginIds,input:[{type:"text",text:`Authorized context:\n${input.context.slice(0,32000)}\n\nTask:\n${input.prompt.slice(0,16000)}`,text_elements:[]}],sandboxPolicy:{type:"readOnly",networkAccess:false},approvalPolicy:"untrusted"});
      turnId=started.turn.id;const turn=await completed;
      if(input.signal.aborted)throw new Error("task-cancelled");if(turn.status!=="completed")throw new Error(turn.error?.message??`codex-${turn.status}`);
      const final=turn.items?.filter(item=>item.type==="agentMessage").map(item=>item.text??"").join("\n")||answer;
      if(!final.trim())throw new Error("codex-empty-output");return [{id:crypto.randomUUID(),type:"text",data:{text:final,agent:"codex",threadId,turnId}}];
    }finally{clearTimeout(timer);input.signal.removeEventListener("abort",cancel);this.notify=undefined;this.dispose();await rm(cwd,{recursive:true,force:true});}
  }
  dispose(reason=new Error("codex-disconnected")):void{const child=this.child;this.child=undefined;for(const pending of this.pending.values())pending.reject(reason);this.pending.clear();child?.kill();}
}
