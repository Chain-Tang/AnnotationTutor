import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { AcpSession, type AcpSessionHandle, type AcpStreamEvent, type startAcpSession } from "../src/acp-session.js";
import { buildApiMessages, opencodePreamble } from "../src/chat-prompt.js";
import { t } from "../src/i18n.js";
import { parseMcpConfig } from "../src/mcp-config.js";
import { LEARNING_STREAM_LIMITS } from "../src/learning-stream-v3.js";
import type { TutorRunnerInput } from "../src/tutor-conversation.js";
import { beginConversationDiagnostic } from "../src/conversation-diagnostics.js";
import { learningApiProtocol } from "../src/learning-api-protocol.js";

// Run both actual host call sites against ACP's real mode guard and message
// decoder. A fake child answers JSON-RPC; no model, process or Obsidian runs.
const source=readFileSync(new URL("../src/main.ts",import.meta.url),"utf8").replace(/\r\n?/g,"\n");
function method(startMarker:string,endMarker:string):string{
  const start=source.indexOf(startMarker),end=source.indexOf(endMarker,start);
  if(start<0||end<0)throw new Error("ACP host fixture boundaries changed");return source.slice(start,end);
}
const methods=method("  private async runTutorTransport(","\n  /** Coalesce the rapid geometry writes")+
  method("  private async runIsolatedTutorTurn(","\n  public async replyInAnnotation(")+
  method("  public async startChatSession(","\n  /**\n   * Resolve an agent write/execute permission");
const code=transformSync(`class Host {${methods}};module.exports=Host;`,{loader:"ts",format:"cjs"}).code;
type StartOptions=Parameters<typeof startAcpSession>[0];
type Host={runTutorTransport(input:TutorRunnerInput):Promise<{text:string}>;runIsolatedTutorTurn(input:TutorRunnerInput):Promise<{text:string}>;
  startChatSession(input:{denyTools?:boolean;onUpdate:(event:AcpStreamEvent)=>void;onExit:(reason:string)=>void}):Promise<AcpSessionHandle>};
type Rpc={id?:number;method?:string;params?:Record<string,any>};
const response='{"control":{"action":{"type":"none"},"replyRelation":"unrelated"},"reply":"明确的回复"}';
function fixture(options:{model?:string;modelResult?:"missing"|"different"|"error";chunks?:string[];apiKey?:string}={}){
  const sent:Rpc[]=[],sessions:AcpSession[]=[],handles:AcpSessionHandle[]=[],events:AcpStreamEvent[]=[];
  const mode="tutor-isolated-test";
  // The host's actual startChatSession supplies every option. Only the spawn
  // boundary is replaced; ACP performs its real mode/model/length validation.
  const startSession=vi.fn(async(config:StartOptions)=>{
    const session=new AcpSession(raw=>{
      const message=raw as Rpc;sent.push(message);
      if(message.id===undefined)return;
      queueMicrotask(()=>{
        if(message.method==="session/prompt"){
          for(const text of options.chunks??[response])session.receive({jsonrpc:"2.0",method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}}});
          session.receive({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});return;
        }
        if(message.method==="session/set_config_option"&&message.params!.configId==="model"){
          if(options.modelResult==="error"){session.receive({jsonrpc:"2.0",id:message.id,error:{message:"selected model unavailable"}});return;}
          if(options.modelResult==="missing"){session.receive({jsonrpc:"2.0",id:message.id,result:{}});return;}
          if(options.modelResult==="different"){session.receive({jsonrpc:"2.0",id:message.id,result:{configOptions:[{id:"model",currentValue:"wrong-provider/wrong-model"}]}});return;}
        }
        const result=message.method==="initialize"?{protocolVersion:1}:message.method==="session/new"?{sessionId:`session-${sessions.length}`}:
          {configOptions:[{id:message.params!.configId,currentValue:message.params!.value}]};
        session.receive({jsonrpc:"2.0",id:message.id,result});
      });
    },{...config,requiredMode:config.denyTools?mode:undefined});
    sessions.push(session);await session.start();if(session.error){session.dispose();throw new Error(session.error);}
    const handle={session,dispose:vi.fn(()=>session.dispose())};handles.push(handle);return handle;
  });
  const api=vi.fn(async()=>({ok:true,text:"ordinary API fallback"}));
  const module={exports:{}};
  const deps={opencodePreamble,t,startAcpSession:startSession,parseMcpConfig,tmpdir:()=>"/isolated-test",LEARNING_STREAM_LIMITS,
    buildApiMessages,streamChatCompletion:api,nodeHttpStream:{},beginConversationDiagnostic,learningApiProtocol,Notice:class {}};
  new Function("module",...Object.keys(deps),code)(module,...Object.values(deps));
  const Host=module.exports as {new():Host},host=new Host();
  Object.assign(host,{
    settings:{chatEngine:"opencode",reviewLanguage:"Chinese",apiKey:options.apiKey??"",teachingMode:"guide",mcpServersJson:"",agentCommand:"opencode",agentModel:options.model??"provider/teaching",agentTimeoutSeconds:120},
    tutorSessionGeneration:0,tutorSession:null,tutorSessionKey:"",tutorSessionHistoryLength:0,tutorSessionStream:null,tutorResetAfterTransport:false,
    tutorConversation:{setCommands:vi.fn()},sharedTutorSettingsKey:()=>"fixed-settings",vaultBasePath:()=>"/vault",agentSpawnEnv:()=>({}),chatTimeoutMs:()=>120000,
    resetTutorSession(){const self=this as unknown as {tutorSession:AcpSessionHandle|null;tutorSessionGeneration:number;tutorSessionHistoryLength:number};self.tutorSession?.dispose();self.tutorSession=null;self.tutorSessionGeneration++;self.tutorSessionHistoryLength=0;}
  });
  const startChatSession=vi.spyOn(host,"startChatSession");
  const input=(protocol:boolean,executionMode:"ask"|"plan"|"build"="ask"):TutorRunnerInput=>({
    text:"解释这页",history:[],historyOffset:0,signal:new AbortController().signal,
    options:{mode:executionMode,context:{chat:{notePath:"math.md",content:"CURRENT_SOURCE_TEXT",...(protocol?{teachingControl:"Respond ONLY with the learning JSON envelope."}:{})}}},
    onReply:()=>{},onEvent:event=>{events.push(event);}
  });
  return {host,sent,sessions,handles,events,startChatSession,startSession,api,input,mode};
}

describe("real ACP mode guard at Tutor host call sites",()=>{
  it.each(["ask","plan","build"] as const)("sends a learning %s turn inside its fixed tool-free mode",async executionMode=>{
    const r=fixture(),input=r.input(true,executionMode),reply=vi.fn();input.onReply=reply;
    const result=await r.host.runTutorTransport(input);
    expect(result.text).toBe(response);expect(reply).toHaveBeenCalledExactlyOnceWith(response);
    expect(r.startChatSession).toHaveBeenCalledWith(expect.objectContaining({denyTools:true}));
    const prompts=r.sent.filter(message=>message.method==="session/prompt");expect(prompts).toHaveLength(1);
    expect(prompts[0]!.params!.prompt[0].text).toContain("CURRENT_SOURCE_TEXT");expect(prompts[0]!.params!.prompt[0].text).toContain("no file tools");
    expect(r.sent.filter(message=>message.method==="session/set_config_option"&&message.params!.configId==="mode").map(message=>message.params!.value)).toEqual([r.mode]);
    r.handles.forEach(handle=>handle.dispose());
  });
  it.each([false,true])("sends isolated annotation protocol=%s without attempting the build mode",async protocol=>{
    const r=fixture(),input=r.input(protocol),reply=vi.fn();input.onReply=reply;
    await expect(r.host.runIsolatedTutorTurn(input)).resolves.toEqual({text:response});
    expect(reply).toHaveBeenCalledExactlyOnceWith(response);expect(r.sent.filter(message=>message.method==="session/prompt")).toHaveLength(1);
    expect(r.sent.filter(message=>message.method==="session/set_config_option"&&message.params!.configId==="mode").map(message=>message.params!.value)).toEqual([r.mode]);
    expect(r.handles[0]!.dispose).toHaveBeenCalledOnce();
  });
  it.each(["ask","plan","build"] as const)("preserves ordinary %s chat execution mode",async executionMode=>{
    const r=fixture();await expect(r.host.runTutorTransport(r.input(false,executionMode))).resolves.toEqual({text:response});
    expect(r.startChatSession).toHaveBeenCalledWith(expect.objectContaining({denyTools:false}));
    expect(r.sent.filter(message=>message.method==="session/set_config_option"&&message.params!.configId==="mode").map(message=>message.params!.value)).toEqual([executionMode==="plan"?"plan":"build"]);
    expect(r.sent.filter(message=>message.method==="session/prompt")).toHaveLength(1);r.handles.forEach(handle=>handle.dispose());
  });
  it("reuses the protected learning session for a corrected turn without changing its mode",async()=>{
    const r=fixture(),input=r.input(true);await r.host.runTutorTransport(input);
    const second=r.input(true);(second.options.context as {chat:{teachingControl:string}}).chat.teachingControl+=" FORMAT CORRECTION";
    await expect(r.host.runTutorTransport(second)).resolves.toEqual({text:response});
    expect(r.startChatSession).toHaveBeenCalledOnce();expect(r.sent.filter(message=>message.method==="session/prompt")).toHaveLength(2);
    expect(r.sent.filter(message=>message.method==="session/set_config_option"&&message.params!.configId==="mode").map(message=>message.params!.value)).toEqual([r.mode]);
    r.handles.forEach(handle=>handle.dispose());
  });
});


describe("bounded and confirmed tool-free Tutor sessions",()=>{
  it.each([false,true])("the real host applies model/length guards only to denyTools=%s",async denyTools=>{
    const r=fixture();const handle=await r.host.startChatSession({denyTools,onUpdate:()=>{},onExit:()=>{}});
    const config=r.startSession.mock.calls[0]![0];
    expect(config.denyTools).toBe(denyTools);expect(config.toolFreeRole).toBe("conversation");
    expect(config.cwd).toBe(denyTools?"/isolated-test":"/vault");
    expect(config.strictModelSelection).toBe(denyTools?true:undefined);expect(config.maxTurnChars).toBe(denyTools?LEARNING_STREAM_LIMITS.maxEnvelopeChars:undefined);
    expect(config.model).toBe("provider/teaching");handle.dispose();
  });
  it.each(["empty","missing","different","error"] as const)("rejects %s model confirmation before sending learner material or switching provider",async failure=>{
    const r=fixture({...(failure==="empty"?{model:""}:{modelResult:failure}),apiKey:"configured-test-key"}),reply=vi.fn(),input=r.input(true);input.onReply=reply;
    await expect(r.host.runTutorTransport(input)).rejects.toThrow("model-selection-unconfirmed");
    expect(r.sent.filter(message=>message.method==="session/prompt")).toEqual([]);expect(reply).not.toHaveBeenCalled();expect(r.api).not.toHaveBeenCalled();
    expect(r.startSession).toHaveBeenCalledOnce();expect(r.events).toEqual([]);
  });
  it("rejects unconfirmed isolated annotation models without falling back to another provider",async()=>{
    const r=fixture({modelResult:"missing",apiKey:"configured-test-key"});
    await expect(r.host.runIsolatedTutorTurn(r.input(true))).rejects.toThrow("model-selection-unconfirmed");
    expect(r.sent.filter(message=>message.method==="session/prompt")).toEqual([]);expect(r.api).not.toHaveBeenCalled();
  });
  it.each(["sidebar","annotation"] as const)("cancels a %s response above the learning protocol limit without displaying excess bytes",async entry=>{
    const limit=LEARNING_STREAM_LIMITS.maxEnvelopeChars,r=fixture({chunks:["x".repeat(limit),"EXCESS_BYTES"],apiKey:"configured-test-key"}),reply=vi.fn(),input=r.input(true);input.onReply=reply;
    await expect(entry==="sidebar"?r.host.runTutorTransport(input):r.host.runIsolatedTutorTurn(input)).rejects.toThrow("response-too-large");
    expect(reply).toHaveBeenCalledOnce();expect(reply.mock.calls[0]![0]).toHaveLength(limit);
    expect(r.sent.filter(message=>message.method==="session/cancel")).toHaveLength(1);expect(r.api).not.toHaveBeenCalled();
    r.handles.forEach(handle=>handle.dispose());
  });
  it("keeps ordinary open chat's prior optional model confirmation and output behavior",async()=>{
    const text="x".repeat(LEARNING_STREAM_LIMITS.maxEnvelopeChars+1),r=fixture({modelResult:"missing",chunks:[text]});
    await expect(r.host.runTutorTransport(r.input(false))).resolves.toEqual({text});expect(r.sent.filter(message=>message.method==="session/prompt")).toHaveLength(1);
    expect(r.sent.filter(message=>message.method==="session/cancel")).toEqual([]);r.handles.forEach(handle=>handle.dispose());
  });
  it("keeps ordinary open chat's existing startup fallback",async()=>{
    const r=fixture({apiKey:"configured-test-key"});r.startChatSession.mockRejectedValueOnce(new Error("startup-unavailable"));
    await expect(r.host.runTutorTransport(r.input(false))).resolves.toEqual({text:"ordinary API fallback"});
    expect(r.api).toHaveBeenCalledOnce();expect(r.events[0]).toMatchObject({type:"tool",status:"completed"});
  });
});
