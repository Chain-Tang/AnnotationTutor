import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { AcpStreamEvent } from "../src/acp-session.js";
import { opencodePreamble } from "../src/chat-prompt.js";
import { t } from "../src/i18n.js";
import { learningContext, type LearningContextQuery, type LearningContextSnapshot, type LearningContextRecord } from "../src/learning-context.js";
import { LearningInvalidation, LearningSessionReferences, type LearningScopeChange } from "../src/learning-invalidation.js";
import { contextVersion } from "../src/teaching-policy.js";
import type { TutorRunnerInput } from "../src/tutor-conversation.js";
import { LearningDialogueV3 } from "../src/learning-dialogue-v3.js";
import { LearningCardV3 } from "../src/learning-card-v3.js";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { LearningV3Store, type EpisodeV3 } from "../src/learning-v3.js";
import { LearningV2Store, createEpisodeV2 } from "../src/learning-v2.js";
import { LearningEpisodeStore } from "../src/learning-episode-store.js";
import { createEpisode } from "../src/learning-episode.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import { LearningLegacyV3 } from "../src/learning-legacy-v3.js";
import { questionIndependence } from "../src/learning-protection.js";
import { localLearnerAuthority, permitsLearningControl, type LearningActionV3 } from "../src/learning-control-v3.js";
import { supportsLearningReplyTool } from "../src/learning-api-protocol.js";
import { runSupportResponse } from "../src/support-response.js";
import { resolveSupportStorageContext } from "../src/support-storage-context.js";
import { runLearningTurnV3 } from "../src/learning-runner-v3.js";
import { completeRecordReadResult, combineRecordReadResults, type LearningIO, type RecordReadResult } from "../src/learning-record-read.js";
import type { ProtectionSnapshot } from "../src/learning-protection.js";
import { classifyIntent } from "../src/intent.js";
import { assembleAnnotationContext } from "../src/annotation-branches.js";
import { ConversationRecovery } from "../src/conversation-recovery.js";
import { ConversationTransportError } from "../src/conversation-diagnostics.js";
import { SocketTransportError, streamChatCompletion } from "../src/api-stream.js";

class TFile {path="evidence.md";extension="md";stat={mtime:1,size:4};}

// Execute the plugin's real conversation and ACP routing methods, following
// document-edit-host.test.ts; only the host services and ACP process are replaced.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const start = source.indexOf("  private sharedTutorSettingsKey()"),
  end = source.indexOf("\n  /** Coalesce the rapid geometry writes", start);
if (start < 0 || end < 0) throw new Error("Learning host fixture needs updated method boundaries");
const module = { exports: {} };
const annotationStart=source.indexOf("  public async replyInAnnotation("),annotationEnd=source.indexOf("\n  /** System prompt for an in-annotation dialogue",annotationStart);
if(annotationStart<0||annotationEnd<0)throw new Error("Annotation host fixture needs updated method boundaries");
const dependencies={contextVersion,opencodePreamble,t,permitsLearningControl,localLearnerAuthority,runLearningTurnV3,runSupportResponse,resolveSupportStorageContext,supportsLearningReplyTool,learningContext,
  LearningV3Store,LearningV2Store,LearningDialogueV3,LearningCommandsV3,LearningLegacyV3,LearningCardV3,combineRecordReadResults,TFile,classifyIntent,assembleAnnotationContext,ConversationRecovery,
  // This suite isolates evidence/transport invalidation. Actual view identity
  // and split-buffer reads run separately in learning-source-version-host.
  readStudySource:(host:{tutorContext:(path:string)=>Promise<unknown>},path:string)=>host.tutorContext(path),
  learningVaultIO:(app:{learningIO:LearningIO})=>app.learningIO,nowIso:()=>new Date().toISOString(),recordFromAnnotation:(value:unknown)=>value};
new Function("module",...Object.keys(dependencies),
  transformSync(`class Host {${source.slice(start, end)}${source.slice(annotationStart,annotationEnd)}}; module.exports=Host;`, { loader: "ts", format: "cjs" }).code
)(module,...Object.values(dependencies));

type Host = {
  tutorLearningReferences: LearningSessionReferences;
  learningReaders: LearningInvalidation;
  learningRuns:Map<AbortController,Promise<void>>;
  learningDialogue:LearningDialogueV3;
  learningV3:LearningV3Store;
  learningV2:LearningV2Store;
  learning:{store:LearningEpisodeStore};
  initializeLearningDialogue():void;
  learningReadState(query:LearningContextQuery):Promise<{read:RecordReadResult<LearningContextRecord>;protection:ReadonlyMap<string,ProtectionSnapshot>;snapshot:LearningContextSnapshot}>;
  learningContextSnapshot(query:LearningContextQuery):Promise<LearningContextSnapshot>;
  runTutorConversation(input: TutorRunnerInput,conversationId?:string,transport?:(input:TutorRunnerInput)=>Promise<{text:string}>): Promise<{ text: string;confirmProvided?:()=>Promise<void> }>;
  invalidateLearningReaders(change: LearningScopeChange): void;
  stopLearningRuns():Promise<void>;
  replyInAnnotation(id:string,text:string):Promise<{ok:boolean;agentText?:string;error?:string}>;
  runIsolatedTutorTurn(input:TutorRunnerInput):Promise<{text:string}>;
};
const Host = module.exports as {new ():Host;prototype:Host};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const snapshot: LearningContextSnapshot = {
  version: 1, revision: "r1", summary: "evidence",
  episodes: [{ id: "episode-a", source: "evidence.md", format: 2, revision: 1, concept: "value-limit", evidenceIds: [] }]
};
function fixture(notePath = "evidence.md", episodeId?: string) {
  const host = new Host(), abort = new AbortController();
  const entered = deferred<void>(), pending = deferred<{ ok: boolean; text: string }>();
  const onReply = vi.fn(), onEvent = vi.fn(), dispose = vi.fn();
  let onUpdate!: (event: AcpStreamEvent) => void;
  const prompt = vi.fn(() => { entered.resolve(); return pending.promise; });
  const startChatSession = vi.fn(async (options: { onUpdate: (event: AcpStreamEvent) => void }) => {
    onUpdate = options.onUpdate;
    return { dispose, session: { commands: [], prompt } };
  });
  Object.assign(host, {
    settings: { chatEngine: "opencode", reviewLanguage: "Chinese", apiKey: "", teachingMode: "guide" },
    chatTimeoutMs:()=>180_000,
    tutorLearningReferences: new LearningSessionReferences(), learningReaders: new LearningInvalidation(),
    tutorSessionGeneration: 0, tutorSession: null, tutorSessionKey: "", tutorSessionHistoryLength: 0, tutorSessionStream: null,
    learningRuns:new Map(),tutorTransportRequestId:undefined,tutorResetAfterTransport:false,
    tutorConversation: { conversationId: "chat-1", setCommands: vi.fn() },
    learningDialogue: { prepare: async ({ requestId }: { requestId: string }) => ({ requestId }) },
    learningReadState:vi.fn(async()=>({read:completeRecordReadResult([]),protection:new Map(),snapshot})),
    learningContextSnapshot: vi.fn(async () => snapshot), startChatSession
  });
  const input: TutorRunnerInput = {
    text: "explain", history: [], historyOffset: 0, signal: abort.signal, onReply, onEvent,
    options: { learningRequestId: "request-a", context: { chat: { notePath, content: "note" } },
      ...(episodeId ? { metadata: { learningEpisodeId: episodeId } } : {}) }
  };
  return { host, input, abort, entered, pending, onReply, onEvent, dispose, prompt,
    update: (event: AcpStreamEvent) => onUpdate(event) };
}
const sourceChange = (path: string): LearningScopeChange => ({ sources: [path], unknownScope: false });

function learningFixture(){
  const f=fixture(),files=new Map<string,string>();let revision="v1";
  const io:LearningIO={read:async path=>files.get(path)??null,list:async root=>[...files.keys()].filter(path=>path.startsWith(root+"/")),
    write:async(path,text)=>{files.set(path,text);},compareWrite:async(path,before,next)=>{if((files.get(path)??null)!==before)throw new Error("write-conflict");files.set(path,next);}};
  const authority=localLearnerAuthority(),conversationId=crypto.randomUUID(),file=new TFile();
  Object.assign(f.host,{settings:{chatEngine:"opencode",reviewLanguage:"Chinese",apiKey:"",teachingMode:"guide",memoryRoot:"learning",learningDailyMinutes:20,learningExpertsEnabled:false},
    app:{learningIO:io,vault:{getAbstractFileByPath:(path:string)=>path===file.path?file:undefined}},
    tutorContext:vi.fn(async()=>({source:file.path,text:"note",revision})),
    captureLearningSource:vi.fn(()=>"fixture-source-lease"),
    tutorConversation:{conversationId,setCommands:vi.fn()},learningCommitSubscriptions:[],
    learning: {store:new LearningEpisodeStore(io,"learning/learning/v1/episodes")},
    learningDialogue:undefined,learningReadState:Host.prototype.learningReadState,learningContextSnapshot:Host.prototype.learningContextSnapshot});
  f.host.initializeLearningDialogue();
  const input=(overrides:Partial<TutorRunnerInput>={}):TutorRunnerInput=>({...f.input,...overrides,options:{...f.input.options,learningRequestId:crypto.randomUUID(),
    learningTurn:{entry:"sidebar",kind:"conversation",authority},context:{chat:{notePath:file.path,content:"note",observation:{source:file.path,version:"v1",scope:"document-excerpt",hasImage:false}},engineText:"augmented ordinary prompt"},...overrides.options}});
  const send=async(action:LearningActionV3,reply="",overrides:Partial<TutorRunnerInput>={},relation:"unrelated"|"current-question"|"uncertain"="unrelated")=>{
    const raw=JSON.stringify({control:{action,replyRelation:relation},reply});
    return f.host.runTutorConversation(input(overrides),conversationId,async value=>{value.onReply(raw);return {text:raw};});
  };
  const seed=async(annotationId?:string)=>{
    const source={path:file.path,version:"v1",...(annotationId?{annotationId}:{})},id=crypto.randomUUID();
    const invitation=f.host.learningDialogue.commands.offer({authority,source,conversationId:id,requestId:crypto.randomUUID(),concept:"value-limit"});
    return (await f.host.learningDialogue.commands.accept(invitation,{authority,source,conversationId:id,requestId:crypto.randomUUID()})).episode;
  };
  return {...f,files,io,authority,conversationId,file,input,send,seed,setRevision:(value:string)=>{revision=value;}};
}

describe("plugin learning evidence invalidation", () => {
  it('uses the non-mutating semantic channel with no source or learning authority on a verified API',async()=>{
    const f=fixture();Object.assign(f.host,{settings:{chatEngine:'api',apiBaseUrl:'https://api.deepseek.com/v1',apiModel:'deepseek-flash'}});
    const input={...f.input,text:'我不确定自己能否安全',options:{context:{chat:{content:'No student source'}}}},before=structuredClone(snapshot);
    const transport=vi.fn(async(value:TutorRunnerInput)=>{const ctx=(value.options.context as {chat:{replyProtocol?:string;teachingControl?:string}}).chat;expect(ctx.replyProtocol).toBe('support');expect(ctx.teachingControl).toContain('ephemeral');const text=JSON.stringify({control:{action:{type:'immediate-support',phase:'urgent'}},reply:'UNSAFE_MODEL'});value.onReply(text);return {text};});
    const result=await f.host.runTutorConversation(input,'support-test',transport);expect(result.text).toContain('联系当地紧急服务');expect(f.onReply.mock.calls.flat().join('')).not.toContain('UNSAFE_MODEL');expect(transport).toHaveBeenCalledOnce();expect(snapshot).toEqual(before);expect(f.host.learningRuns.size).toBe(0);
  });
  it('does not promote a rejected ordinary support command into a learning write or extra request',async()=>{
    const f=fixture();Object.assign(f.host,{settings:{chatEngine:'api',apiBaseUrl:'https://api.deepseek.com/v1',apiModel:'deepseek-flash'}});
    const transport=vi.fn(async(value:TutorRunnerInput)=>{const text=JSON.stringify({control:{action:{type:'forget',questionId:crypto.randomUUID()}},reply:'DELETED'});value.onReply(text);return {text};});
    await expect(f.host.runTutorConversation(f.input,'support-test',transport)).rejects.toThrow('teaching-control-rejected');expect(f.onReply).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledOnce();expect(f.host.learningRuns.size).toBe(0);
  });
  it("retains the first ACP prompt's evidence references after session creation and completion", async () => {
    const f = fixture(), turn = f.host.runTutorConversation(f.input);
    await f.entered.promise;
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(f.host.tutorLearningReferences.affected(sourceChange("evidence.md"))).toBe(true);
    f.pending.resolve({ ok: true, text: "done" });
    await expect(turn).resolves.toEqual({ text: "done" });
    f.host.invalidateLearningReaders(sourceChange("unrelated.md"));
    expect(f.dispose).not.toHaveBeenCalled();
    f.host.invalidateLearningReaders(sourceChange("evidence.md"));
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.host.tutorLearningReferences.affected(sourceChange("evidence.md"))).toBe(false);
  });

  it("uses the projected episode source when the displayed document is different", async () => {
    const f = fixture("display.md", "episode-a"), turn = f.host.runTutorConversation(f.input);
    await f.entered.promise;
    expect(f.host.tutorLearningReferences.affected(sourceChange("evidence.md"))).toBe(true);
    expect(f.host.tutorLearningReferences.affected(sourceChange("display.md"))).toBe(false);
    f.pending.resolve({ ok: true, text: "done" });
    await turn;
    f.host.invalidateLearningReaders(sourceChange("display.md"));
    expect(f.dispose).not.toHaveBeenCalled();
    // A source rename has no episode record ID, but still invalidates the
    // persistent context that actually received that episode's evidence.
    f.host.invalidateLearningReaders(sourceChange("evidence.md"));
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("excludes only a local commit's own request while cancelling other readers of the same evidence", () => {
    const readers = new LearningInvalidation(), writer = vi.fn(), other = vi.fn(), unrelated = vi.fn();
    const query = { source: "display.md", episodeId: "episode-a" };
    readers.track(query, writer, { snapshot, requestId: "request-a" });
    readers.track(query, other, { snapshot, requestId: "request-b" });
    readers.track({ source: "unrelated.md" }, unrelated, { requestId: "request-c" });
    readers.changed({ recordId: "episode-a", sources: ["evidence.md"], unknownScope: false, requestId: "request-a" });
    expect(writer).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
    readers.changed(sourceChange("evidence.md"));
    expect(writer).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
  });

  it.each(["evidence", "caller"] as const)("drops late ACP chunks and completion after %s cancellation", async cause => {
    const f = fixture("display.md", "episode-a"), turn = f.host.runTutorConversation(f.input);
    await f.entered.promise;
    f.update({ type: "message", text: "before" });
    if (cause === "evidence") f.host.invalidateLearningReaders(sourceChange("evidence.md"));
    else f.abort.abort();
    expect(f.dispose).toHaveBeenCalledOnce();
    f.update({ type: "message", text: "late" });
    f.update({ type: "tool", title: "late tool", status: "completed" });
    const rejected = expect(turn).rejects.toThrow(/cancelled|Learning evidence changed/i);
    f.pending.resolve({ ok: true, text: "late final" });
    await rejected;
    expect(f.onReply.mock.calls).toEqual([["before"]]);
    expect(f.onEvent).not.toHaveBeenCalled();
  });
});

describe("main v3 learning host integration",()=>{
  it("recovers a zero-byte connection once under the same request and records related help only once",async()=>{
    const f=learningFixture(),episode=await f.seed(),reserve=vi.fn(),progress=vi.fn(),lease=vi.fn(async()=>{}),present=vi.fn(()=>true),calls:TutorRunnerInput[]=[];
    const failure=await streamChatCompletion({baseUrl:"https://test.example",model:"test",apiKey:"test",messages:[],timeoutMs:1000},async()=>{throw new SocketTransportError("reset");});
    const input=f.input({consumeAdditionalModelCall:reserve,beforeAdditionalModelCall:lease,onConnectionRetry:progress,onReply:present,options:{metadata:{learningEpisodeId:episode.id},learningTurn:{entry:"sidebar",kind:"conversation",authority:f.authority},context:{chat:{notePath:f.file.path,content:"note",observation:{source:f.file.path,version:"v1",scope:"document-excerpt",hasImage:false}}}}});
    const result=await f.host.runTutorConversation(input,f.conversationId,async value=>{
      calls.push(value);if(calls.length===1)throw new ConversationTransportError(failure);
      const text=JSON.stringify({control:{action:{type:"none"},replyRelation:"current-question"},reply:"接续原问题。"});value.onReply(text);return {text};
    });
    expect(result.text).toBe("接续原问题。");expect(calls).toHaveLength(2);
    expect(calls.map(call=>call.options.learningRequestId)).toEqual([input.options.learningRequestId,input.options.learningRequestId]);
    expect(calls.map(call=>call.apiTransport?.freshConnection)).toEqual([false,true]);
    expect(calls[1]!.apiTransport!.timeoutMs).toBeLessThan(calls[0]!.apiTransport!.timeoutMs);
    expect(reserve).toHaveBeenCalledOnce();expect(lease).toHaveBeenCalledOnce();expect(progress).toHaveBeenCalledOnce();
    expect((await f.host.learningV3.list())[0]!.help).toHaveLength(1);expect(present.mock.calls.flat().join("")).toBe("接续原问题。");
  });

  it.each(["network-first","format-first"])("shares the two-call limit between connection and format recovery: %s",async order=>{
    const f=learningFixture(),reserve=vi.fn(),present=vi.fn(()=>true),failure=await streamChatCompletion({baseUrl:"https://test.example",model:"test",apiKey:"test",messages:[],timeoutMs:1000},async()=>{throw new SocketTransportError("reset");});
    let calls=0;const transport=vi.fn(async(value:TutorRunnerInput)=>{
      calls++;if((order==="network-first")===(calls===1))throw new ConversationTransportError(failure);
      value.onReply('{"control":{"action":{"type":"none"},"replyRelation":"unrelated"},"reply":null}');return {text:""};
    });
    await expect(f.host.runTutorConversation(f.input({consumeAdditionalModelCall:reserve,onReply:present}),f.conversationId,transport)).rejects.toThrow(order==="network-first"?"teaching-reply-string-required":"api-connection-failed");
    expect(transport).toHaveBeenCalledTimes(2);expect(reserve).toHaveBeenCalledOnce();expect(present).not.toHaveBeenCalled();expect(f.files.size).toBe(0);
  });

  it("checks the additional-call association lease before reserving retry budget",async()=>{
    const f=learningFixture(),reserve=vi.fn(),lease=vi.fn(async()=>{throw new Error("annotation-parent-reply-changed");});
    const failure=await streamChatCompletion({baseUrl:"https://test.example",model:"test",apiKey:"test",messages:[],timeoutMs:1000},async()=>{throw new SocketTransportError("reset");});
    const transport=vi.fn(async()=>{throw new ConversationTransportError(failure);});
    await expect(f.host.runTutorConversation(f.input({consumeAdditionalModelCall:reserve,beforeAdditionalModelCall:lease}),f.conversationId,transport)).rejects.toThrow("annotation-parent-reply-changed");
    expect(transport).toHaveBeenCalledOnce();expect(lease).toHaveBeenCalledOnce();expect(reserve).not.toHaveBeenCalled();expect(f.files.size).toBe(0);
  });
  it("reserves the original task budget before a format correction and never persists a rejected invitation",async()=>{
    const f=learningFixture(),present=vi.fn(()=>true),offer=vi.spyOn(f.host.learningDialogue,"offer"),calls:string[]=[];
    const reserve=vi.fn(()=>{expect(calls).toHaveLength(1);expect(offer).not.toHaveBeenCalled();expect(f.files.size).toBe(0);});
    const input=f.input({onReply:present,consumeAdditionalModelCall:reserve}),requestId=input.options.learningRequestId;
    const raw=JSON.stringify({control:{action:{type:"invite",concept:"value-limit"},replyRelation:"unrelated"},reply:""});
    const result=await f.host.runTutorConversation(input,f.conversationId,async value=>{
      expect(value.options.learningRequestId).toBe(requestId);calls.push(value.options.learningRequestId!);
      const reply=raw+(calls.length===1?" invalid suffix":"");value.onReply(reply);return {text:reply};
    });
    expect(reserve).toHaveBeenCalledOnce();expect(calls).toHaveLength(2);expect(offer).toHaveBeenCalledOnce();
    expect(result.text).toContain("保存这次练习进度");expect(result.text).not.toContain("invalid suffix");
    expect(present).toHaveBeenCalledOnce();expect(await f.host.learningV3.list()).toHaveLength(0);expect(f.files.size).toBe(0);
  });

  it("does not send a correction when the captured task's model budget is exhausted",async()=>{
    const f=learningFixture(),present=vi.fn(()=>true),offer=vi.spyOn(f.host.learningDialogue,"offer");
    const reserve=vi.fn(()=>{throw new Error("model-budget-exhausted");});
    const transport=vi.fn(async(value:TutorRunnerInput)=>{
      const raw=JSON.stringify({control:{action:{type:"invite",concept:"value-limit"},replyRelation:"unrelated"},reply:""})+" invalid suffix";
      value.onReply(raw);return {text:raw};
    });
    await expect(f.host.runTutorConversation(f.input({onReply:present,consumeAdditionalModelCall:reserve}),f.conversationId,transport)).rejects.toThrow("model-budget-exhausted");
    expect(reserve).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();expect(present).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();expect(f.files.size).toBe(0);expect(f.host.learningRuns.size).toBe(0);
  });

  it("uses the actual main method chain to invite and accept with an augmented engineText",async()=>{
    const f=learningFixture(),offer=vi.spyOn(f.host.learningDialogue,"offer");
    const invitation=await f.send({type:"invite",concept:"value-limit"},"先看附近的趋势。",{onReply:()=>true});
    expect(invitation.text).not.toContain("先看附近");expect(invitation.text).toContain("保存这次练习进度");expect(await f.host.learningV3.list()).toHaveLength(0);
    const handle=offer.mock.results[0]!.value;
    const accepted=await f.send({type:"accept",invitationId:handle.id},"",{onReply:()=>true,text:"好"});
    const records=await f.host.learningV3.list();expect(records).toHaveLength(1);expect(records[0]!.consent.invitationId).toBe(handle.id);
    expect(records[0]!.currentQuestionId).toBe(handle.questionId);expect(accepted.text.trim()).not.toBe("");expect(accepted.text).not.toContain('"control"');
  });

  it.each([true,false,undefined])("preserves presenter %s instead of claiming a no-op displayed help",async provided=>{
    const f=learningFixture(),episode=await f.seed(),present=vi.fn(()=>provided);
    await f.send({type:"hint",questionId:episode.currentQuestionId},"",{onReply:present,options:{metadata:{learningEpisodeId:episode.id}}});
    const saved=(await f.host.learningV3.list())[0]!;expect(saved.help).toHaveLength(1);expect(saved.help[0]!.state).toBe(provided===true?"presented":"unknown");expect(present).toHaveBeenCalled();
  });

  it("keeps an ACP stream alive for its own durable help, then refreshes the stale session after transport",async()=>{
    const f=learningFixture(),episode=await f.seed(),present=vi.fn((_delta:string)=>true);
    const input=f.input({onReply:present,options:{metadata:{learningEpisodeId:episode.id}}});
    const running=f.host.runTutorConversation(input);await f.entered.promise;
    f.update({type:"message",text:'{"control":{"action":{"type":"none"},"replyRelation":"current-question"},"reply":"相关解释'});
    await vi.waitFor(()=>expect(present).toHaveBeenCalled());
    expect(f.dispose).not.toHaveBeenCalled();expect((await f.host.learningV3.list())[0]!.help[0]!.state).toBe("presented");
    f.update({type:"message",text:'继续。"}'});f.pending.resolve({ok:true,text:"received through stream"});
    expect((await running).text).toBe("相关解释继续。");expect(f.dispose).toHaveBeenCalled();expect(f.host.learningRuns.size).toBe(0);
  });

  it("still cancels an ACP stream for a foreign commit after its own help was provided",async()=>{
    const f=learningFixture(),episode=await f.seed(),present=vi.fn((_delta:string)=>true);
    const running=f.host.runTutorConversation(f.input({onReply:present,options:{metadata:{learningEpisodeId:episode.id}}}));
    const rejected=expect(running).rejects.toThrow(/cancelled|changed/i);await f.entered.promise;
    f.update({type:"message",text:'{"control":{"action":{"type":"none"},"replyRelation":"current-question"},"reply":"已经显示'});
    await vi.waitFor(()=>expect(present).toHaveBeenCalled());
    f.host.invalidateLearningReaders({recordId:episode.id,sources:[episode.source.path],unknownScope:false,requestId:crypto.randomUUID()});
    f.update({type:"message",text:'不该显示。"}'});f.pending.resolve({ok:true,text:"late"});await rejected;
    expect(present.mock.calls.map(call=>call[0])).toEqual(["已经显示"]);expect(f.dispose).toHaveBeenCalled();
    expect((await f.host.learningV3.list())[0]!.help[0]!.state).toBe("presented");
  });

  it("refuses a captured source version that is already stale before transport starts",async()=>{
    const f=learningFixture(),transport=vi.fn(async()=>({text:""}));f.setRevision("v2");
    await expect(f.host.runTutorConversation(f.input(),f.conversationId,transport)).rejects.toThrow("Learning source changed");
    expect(transport).not.toHaveBeenCalled();expect(f.files.size).toBe(0);expect(f.host.learningRuns.size).toBe(0);
  });

  it.each(["document-edit","external","missing-authority"] as const)("keeps %s on the ordinary transport without learning mutations",async identity=>{
    const f=learningFixture(),prepare=vi.spyOn(f.host.learningDialogue,"prepare"),present=vi.fn(()=>true);
    const input=f.input({onReply:present,options:{learningTurn:{entry:identity==="external"?"external":"sidebar",kind:identity==="document-edit"?"document-edit":"conversation",...(identity==="missing-authority"?{}:{authority:f.authority})}}});
    const result=await f.host.runTutorConversation(input,f.conversationId,async value=>{
      expect((value.options.context as {chat:{teachingControl?:string}}).chat.teachingControl).toBeUndefined();
      expect(value.onReply("ordinary reply")).toBe(true);return {text:"ordinary reply"};
    });
    expect(result.text).toBe("ordinary reply");expect(prepare).not.toHaveBeenCalled();expect(f.files.size).toBe(0);
  });

  it("does not absorb a foreign episode revision into its own commit baseline",async()=>{
    const f=learningFixture(),episode=await f.seed(),other=await f.seed(),commands=f.host.learningDialogue.commands,prepare=commands.prepareHelp.bind(commands);
    vi.spyOn(commands,"prepareHelp").mockImplementationOnce(async(...args)=>{
      const result=await prepare(...args),path=`${f.host.learningV3.root}/${other.id}.json`,record=JSON.parse(f.files.get(path)!) as EpisodeV3;
      record.revision++;record.updatedAt="2099-01-01T00:00:00.000Z";f.files.set(path,JSON.stringify(record));return result;
    });
    const present=vi.fn((_delta:string)=>true);
    // Source-scoped projection reads both records; the active session remains explicit.
    await f.host.learningDialogue.prepare({...f.input().options.learningTurn!,conversationId:f.conversationId,requestId:crypto.randomUUID(),source:episode.source,text:"",episodeId:episode.id});
    await expect(f.send({type:"hint",questionId:episode.currentQuestionId},"",{onReply:present})).rejects.toThrow(/cancelled|changed/i);
    expect(present).not.toHaveBeenCalled();expect((await f.host.learningV3.list()).find(e=>e.id===episode.id)!.help).toHaveLength(1);
  });

  it("does not absorb a foreign protection revision after its own save acknowledgement",async()=>{
    const f=learningFixture(),episode=await f.seed(),commands=f.host.learningDialogue.commands,prepare=commands.prepareHelp.bind(commands);
    vi.spyOn(commands,"prepareHelp").mockImplementationOnce(async(...args)=>{
      const result=await prepare(...args);
      await f.host.learningV3.protection.block({episodeId:episode.id,questions:[{ref:episode.questions[0]!,fromSequence:1}],reason:"external-uncertainty"});
      return result;
    });
    const present=vi.fn((_delta:string)=>true);
    await expect(f.send({type:"hint",questionId:episode.currentQuestionId},"",{onReply:present,options:{metadata:{learningEpisodeId:episode.id}}})).rejects.toThrow(/cancelled|changed/i);
    expect(present).not.toHaveBeenCalled();
  });

  it("stops and drains independent learning transports before a host changes directories",async()=>{
    const f=learningFixture(),entered=deferred<void>(),released=deferred<void>();let captured!:AbortSignal;
    const running=f.host.runTutorConversation(f.input(),crypto.randomUUID(),async input=>{
      captured=input.signal;entered.resolve();await released.promise;const text=JSON.stringify({control:{action:{type:"none"},replyRelation:"unrelated"},reply:"late"});input.onReply(text);return {text};
    });
    const rejected=expect(running).rejects.toThrow(/cancelled|changed/i);await entered.promise;
    const stopped=vi.fn();const stopping=f.host.stopLearningRuns().then(stopped);
    expect(captured.aborted).toBe(true);await Promise.resolve();expect(stopped).not.toHaveBeenCalled();
    released.resolve();await rejected;await stopping;expect(f.host.learningRuns.size).toBe(0);expect(f.onReply).not.toHaveBeenCalled();
  });

  it.each(["success","failed","deleted","confirm-failed"] as const)("confirms annotation help only after the actual append (%s)",async outcome=>{
    const f=learningFixture(),annotationId=crypto.randomUUID(),episode=await f.seed(annotationId),conversationId=crypto.randomUUID();
    await f.host.learningDialogue.prepare({entry:"annotation",kind:"conversation",authority:f.authority,conversationId,requestId:crypto.randomUUID(),source:episode.source,episodeId:episode.id,text:""});
    const record={id:annotationId,annotationId,sourceFile:f.file.path,selectedText:"selected math",anchor:{blockId:"math",selectedText:"selected math"},userNote:"Original learner note",reviewText:"Prior Tutor review",dialogue:[]},upsert=vi.fn();
    const append=vi.fn(async()=>{
      expect((await f.host.learningV3.list())[0]!.help[0]!.state).toBe("unknown");
      if(outcome==="failed")throw new Error("annotation-write-failed");
      return outcome==="deleted"?null:record;
    });
    const confirm=f.host.learningDialogue.commands.confirmHelp.bind(f.host.learningDialogue.commands);
    const confirmations=vi.spyOn(f.host.learningDialogue.commands,"confirmHelp").mockImplementation(async(ticket,authority,state)=>{
      if(state==="presented"){expect(append).toHaveBeenCalledOnce();if(outcome==="confirm-failed")throw new Error("confirmation-write-failed");}
      return confirm(ticket,authority,state);
    });
    Object.assign(f.host,{annotationLearningSessions:new Map([[annotationId,conversationId]]),annotationLearningBusy:new Set(),
      indexTable:{get:(id:string)=>id===annotationId?record:undefined,upsert},store:{readAnnotation:async()=>record,readConversationSource:async()=>"note",appendDialogueTurns:append,annotationPath:()=>"annotation.json"},publishAnnotationInsight:vi.fn(),
      runIsolatedTutorTurn:async(input:TutorRunnerInput)=>{const raw=JSON.stringify({control:{action:{type:"hint",questionId:episode.currentQuestionId},replyRelation:"current-question"},reply:""});input.onReply(raw);return {text:raw};}});
    const result=await f.host.replyInAnnotation(annotationId,"请给这道题一个提示");
    expect(result.ok).toBe(outcome==="success"||outcome==="confirm-failed");
    expect((await f.host.learningV3.list())[0]!.help[0]!.state).toBe(outcome==="success"?"presented":"unknown");
    if(outcome==="success"||outcome==="confirm-failed"){expect(upsert).toHaveBeenCalledOnce();expect(result.agentText?.trim()).toBeTruthy();}
    else expect(confirmations.mock.calls.some(call=>call[2]==="presented")).toBe(false);
    expect(f.host.learningRuns.size).toBe(0);
  });

  it("drains an annotation append and confirms its real late success before directory shutdown can finish",async()=>{
    const f=learningFixture(),annotationId=crypto.randomUUID(),episode=await f.seed(annotationId),conversationId=crypto.randomUUID();
    await f.host.learningDialogue.prepare({entry:"annotation",kind:"conversation",authority:f.authority,conversationId,requestId:crypto.randomUUID(),source:episode.source,episodeId:episode.id,text:""});
    const record={id:annotationId,annotationId,sourceFile:f.file.path,selectedText:"selected math",anchor:{blockId:"math",selectedText:"selected math"},userNote:"Original learner note",reviewText:"Prior Tutor review",dialogue:[]},entered=deferred<void>(),release=deferred<void>();
    Object.assign(f.host,{annotationLearningSessions:new Map([[annotationId,conversationId]]),annotationLearningBusy:new Set(),
      indexTable:{get:()=>record,upsert:vi.fn()},store:{readAnnotation:async()=>record,readConversationSource:async()=>"note",appendDialogueTurns:async()=>{entered.resolve();await release.promise;return record;},annotationPath:()=>"annotation.json"},publishAnnotationInsight:vi.fn(),
      runIsolatedTutorTurn:async(input:TutorRunnerInput)=>{const raw=JSON.stringify({control:{action:{type:"hint",questionId:episode.currentQuestionId},replyRelation:"current-question"},reply:""});input.onReply(raw);return {text:raw};}});
    const annotation=f.host.replyInAnnotation(annotationId,"请给这道题一个提示");await entered.promise;
    expect((await f.host.learningV3.list())[0]!.help[0]!.state).toBe("unknown");
    const stopped=vi.fn(),stopping=f.host.stopLearningRuns().then(stopped);await Promise.resolve();expect(stopped).not.toHaveBeenCalled();
    release.resolve();expect((await annotation).ok).toBe(true);await stopping;
    expect((await f.host.learningV3.list())[0]!.help[0]!.state).toBe("presented");expect(f.host.learningRuns.size).toBe(0);
  });
});

describe("main legacy continuation integration",()=>{
  async function legacyFixture(format:1|2=2){
    const f=learningFixture(),source={path:f.file.path,version:"v1"};
    const old=format===1?await f.host.learning.store.save(createEpisode(source,"value-limit")):
      await f.host.learningV2.save(createEpisodeV2(source,instantiateQuestion("value-limit","practice",0),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()}));
    return {...f,old};
  }
  it("continues a verified v2 question through main without rewriting old evidence or counting it again",async()=>{
    const f=await legacyFixture();if(f.old.format!==2)throw new Error();
    const old=f.old,question=old.questions[0]!,requestId=crypto.randomUUID();old.requests.push(requestId);
    old.evidence.push({id:crypto.randomUUID(),requestId,questionId:question.id,at:new Date().toISOString(),answer:question.answer,help:{hints:2,answerShown:true},kind:"hinted",evaluator:"deterministic",outcome:"correct",feedback:"PRIVATE_LEGACY_FEEDBACK"});
    const saved=await f.host.learningV2.save(old),path=`${f.host.learningV2.root}/${old.id}.json`,before=f.files.get(path);
    const result=await f.send({type:"resume-legacy",episodeId:old.id},"",{text:"明确继续这道旧题",onReply:()=>true,options:{metadata:{learningEpisodeId:old.id}}});
    const records=await f.host.learningV3.list(),next=records[0]!;
    expect(records).toHaveLength(1);expect(next.currentQuestionId).toBe(question.id);expect(next.evidence).toEqual([]);
    expect(next.legacy).toEqual({format:2,id:old.id,revision:saved.revision,evidenceIds:[saved.evidence[0]!.id]});
    expect(f.files.get(path)).toBe(before);expect(result.text).toContain(question.prompt);expect(result.text).not.toContain("PRIVATE_LEGACY_FEEDBACK");
    expect(questionIndependence(next,next.currentQuestionId,1,await f.host.learningV3.protection.read(next.id))).toBe("unknown");
    const projected=await f.host.learningContextSnapshot({source:f.file.path});expect(projected.episodes.map(e=>e.id)).toEqual([next.id]);
    const original=await f.host.learningContextSnapshot({source:f.file.path,episodeId:old.id});expect(original.episodes.map(e=>e.id)).toEqual([old.id]);
    expect((await f.host.learningDialogue.prepare({entry:"sidebar",kind:"conversation",authority:f.authority,conversationId:f.conversationId,requestId:crypto.randomUUID(),text:"继续",source:old.source,episodeId:old.id})).active?.id).toBe(next.id);
    await f.send({type:"resume",questionId:next.currentQuestionId},"",{onReply:()=>true,options:{metadata:{learningEpisodeId:old.id}}});
    expect(await f.host.learningV3.list()).toHaveLength(1);expect((await f.host.learningV3.list())[0]!.evidence).toEqual([]);
  });
  it.each([1,2] as const)("leaves unsupported legacy format %s readable and provides its limit without creating v3",async format=>{
    const f=await legacyFixture(format);
    if(f.old.format===2){f.old.questions[0]!.packVersion="limits-v2-1";await f.host.learningV2.save(f.old);}
    const before=new Map(f.files),result=await f.send({type:"resume-legacy",episodeId:f.old.id},"",{text:"继续旧题",onReply:()=>true});
    expect(result.text).toContain("暂不能可靠地续记");expect(result.text).toContain("旧记录和答案都保留");expect(f.files).toEqual(before);expect(await f.host.learningV3.list()).toEqual([]);
  });
  it("does not convert a legacy record during greetings, ordinary discussion or an unbound bare number",async()=>{
    const f=await legacyFixture(),before=new Map(f.files);
    for(const text of ["你好","谈谈概念","9"]){const result=await f.send({type:"none"},"普通说明",{text,onReply:()=>true});expect(result.text).toBe("普通说明");}
    expect(f.files).toEqual(before);expect(await f.host.learningV3.list()).toEqual([]);
  });
  it("allows explicit continuation after a normal document edit while preserving the original question",async()=>{
    const f=await legacyFixture();if(f.old.format!==2)throw new Error();f.setRevision("v2");
    const result=await f.send({type:"resume-legacy",episodeId:f.old.id},"",{text:"继续旧题",onReply:()=>true,options:{context:{chat:{notePath:f.file.path,content:"edited",observation:{source:f.file.path,version:"v2",scope:"document-excerpt",hasImage:false}},engineText:"continue captured old question"}}});
    const saved=(await f.host.learningV3.list())[0]!;expect(saved.currentQuestionId).toBe(f.old.currentQuestionId);expect(saved.source.version).toBe("v2");expect(result.text).toContain(f.old.questions[0]!.prompt);
    expect((await f.host.learningV2.list())[0]!.source.version).toBe("v1");
  });
  it.each(["legacy-revision","source-version"] as const)("rejects late %s changes before a continuation can write",async changed=>{
    const f=await legacyFixture(),entered=deferred<void>(),release=deferred<void>();
    const pending=f.host.runTutorConversation(f.input(),f.conversationId,async input=>{entered.resolve();await release.promise;const text=JSON.stringify({control:{action:{type:"resume-legacy",episodeId:f.old.id},replyRelation:"unrelated"},reply:""});input.onReply(text);return {text};});
    const rejected=expect(pending).rejects.toThrow(/changed|cancelled/i);await entered.promise;
    if(changed==="source-version")f.setRevision("v2");
    else{const path=`${f.host.learningV2.root}/${f.old.id}.json`,record=JSON.parse(f.files.get(path)!);record.revision++;f.files.set(path,JSON.stringify(record));}
    release.resolve();await rejected;expect(await f.host.learningV3.list()).toEqual([]);
    expect([...f.files.keys()].some(path=>path.includes("/v3/"))).toBe(false);
  });
  it("rejects a model-invented legacy target and leaves multiple candidates unchosen",async()=>{
    const f=await legacyFixture();await f.host.learningV2.save(createEpisodeV2(f.old.source,instantiateQuestion("jump","practice",0),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()}));
    const before=new Map(f.files);await expect(f.send({type:"resume-legacy",episodeId:crypto.randomUUID()},"",{text:"继续"})).rejects.toThrow("legacy-target-unavailable");
    const response=await f.send({type:"none"},"想继续哪一份练习？",{text:"继续",onReply:()=>true});expect(response.text).toContain("哪一份");
    expect(f.files).toEqual(before);expect(await f.host.learningV3.list()).toEqual([]);
  });
});
