import { describe, expect, it, vi } from "vitest";
import { LearningV3Store, conceptCriterion, questionRefV3, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { LearningDialogueV3, type DialogueTurnV3 } from "../src/learning-dialogue-v3.js";
import { localLearnerAuthority, type LearningControlV3 } from "../src/learning-control-v3.js";
import { runLearningTurnV3 } from "../src/learning-runner-v3.js";
import { effectiveLearningV3 } from "../src/learning-effective-v3.js";

type RunOptions=Parameters<typeof runLearningTurnV3>[0];
const envelope=(action:LearningControlV3["action"],reply="",replyRelation:LearningControlV3["replyRelation"]="current-question")=>({control:{action,replyRelation},reply});
function barrier(){
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  return {entered,release,wait:async()=>{enter();await released;}};
}
async function rig(active=true){
  const files=new Map<string,string>();
  const io={read:async(p:string)=>files.get(p)??null,list:async(p:string)=>[...files.keys()].filter(k=>k.startsWith(p+"/")),write:async(p:string,n:string)=>{files.set(p,n);},compareWrite:async(p:string,b:string|null,n:string)=>{if((files.get(p)??null)!==b)throw new Error("conflict");files.set(p,n);}};
  const store=new LearningV3Store(io,"learning/v3/episodes"),commands=new LearningCommandsV3(store,()=>new Date("2026-10-09T12:00:00Z"));
  const dialogue=new LearningDialogueV3(commands),authority=localLearnerAuthority(),conversationId=crypto.randomUUID(),source={path:"math.md",version:"v1"};
  let episode:EpisodeV3|undefined;
  if(active){const invitation=commands.offer({authority,conversationId,source,requestId:crypto.randomUUID(),concept:"value-limit"});episode=(await commands.accept(invitation,{authority,conversationId,source,requestId:crypto.randomUUID()})).episode;}
  const prepare=(text="提示一下",overrides:Partial<Parameters<LearningDialogueV3["prepare"]>[0]>={})=>dialogue.prepare({authority,conversationId,source,requestId:crypto.randomUUID(),entry:"sidebar",kind:"conversation",text,...(episode?{episodeId:episode.id}:{}),...overrides});
  const shown:string[]=[],controller=new AbortController();
  const options=(turn:DialogueTurnV3,response:unknown,overrides:Partial<RunOptions>={}):RunOptions=>({dialogue,turn,signal:controller.signal,transport:async(_instructions,onDelta)=>{const text=JSON.stringify(response);onDelta(text);return {text};},present:delta=>{shown.push(delta);return true;},ensureCurrent:async()=>{},...overrides});
  const stored=()=>episode?JSON.parse(files.get(`${store.root}/${episode.id}.json`)!) as EpisodeV3:undefined;
  return {files,io,store,commands,dialogue,authority,conversationId,source,episode,prepare,shown,controller,options,stored};
}

describe("learning turn runner",()=>{
  it('accepts a natural trend answer for the bound transfer question without importing previous hints',async()=>{
    const r=await rig();
    const hint=await r.prepare('提示一下');
    await runLearningTurnV3(r.options(hint,envelope({type:'hint',questionId:hint.active!.currentQuestionId})));
    const first=await r.prepare('答案是9');
    await runLearningTurnV3(r.options(first,envelope({type:'answer',questionId:first.active!.currentQuestionId})));
    const transfer=await r.prepare('附近的读数趋向6。');
    expect(transfer.active!.currentQuestionId).not.toBe(first.active!.currentQuestionId);
    const result=await runLearningTurnV3(r.options(transfer,envelope({type:'answer',questionId:transfer.active!.currentQuestionId})));
    const saved=r.stored()!;
    expect(saved.evidence).toHaveLength(2);
    expect(saved.evidence[0]).toMatchObject({type:'answer',outcome:'correct',independence:'helped'});
    expect(saved.evidence[1]).toMatchObject({type:'answer',questionId:transfer.active!.currentQuestionId,answer:{kind:'number',value:6},outcome:'correct',independence:'no-plugin-help',helpIds:[]});
    expect(saved.reviewTasks).toHaveLength(1);
    expect(result.text).toContain('进度已保存');
    expect([...r.files.values()].join('')).not.toContain('附近的读数趋向');
  });
  it('supplies actual storage facts to an ordinary learning reply without creating evidence or an extra call',async()=>{
    const r=await rig(),turn=await r.prepare('我想听一句鼓励'),before=new Map(r.files);
    const raw=JSON.stringify(envelope({type:'none'},'可以先休息一下。','unrelated'));
    const transport=vi.fn(async(instructions:string,delta:(s:string)=>void)=>{expect(instructions).toContain('"surface":"chat","chatLog":"disabled"');delta(raw);return {text:raw};});
    const result=await runLearningTurnV3(r.options(turn,undefined,{storageContext:()=>({surface:'chat',chatLog:'disabled'}),transport}));
    expect(result.text).toBe('可以先休息一下。');expect(result.tracking).toBeUndefined();expect(r.files).toEqual(before);expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['none','pause'] as const)('invalidates a late %s proposal when storage facts change, without committing or retrying',async type=>{
    const r=await rig(),turn=await r.prepare('暂停'),before=new Map(r.files);let enabled=true;
    const action=type==='pause'?{type,questionId:turn.active!.currentQuestionId}:{type};
    const raw=JSON.stringify(envelope(action,'STALE','unrelated')),correction=vi.fn();
    const transport=vi.fn(async()=>{enabled=false;return {text:raw};});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction,storageContext:()=>({surface:'chat',chatLog:enabled?'enabled':'disabled'})}))).rejects.toMatchObject({name:'AbortError'});
    expect(r.files).toEqual(before);expect(r.shown).toEqual([]);expect(correction).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['storage','learning-evidence'] as const)('explains %s using host facts without grading, pausing or recording private prose',async topic=>{
    const r=await rig(),turn=await r.prepare('请说清楚记录规则，不要评分'),before=new Map(r.files);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:'capability-info',topic},'已删除记录，没有保存任何地方','current-question'),{storageContext:()=>({surface:'chat',chatLog:'enabled'})}));
    expect(result.tracking).toBe('private');
    expect(r.files).toEqual(before);expect(result.text).not.toMatch(/已删除|没有保存任何地方/);
    expect(result.text).toContain(topic==='storage'?'开启本地聊天记录':'不把旧题改成独立完成');
  });
  it('commits an explicit pause and separately acknowledges concern about Tutor without scoring or recording support',async()=>{
    const r=await rig(),turn=await r.prepare('今天暂停这道题。你会不会失望？'),before=r.stored()!;
    const response={...envelope({type:'pause',questionId:before.currentQuestionId},'我不会走开，已为你评分','current-question'),control:{action:{type:'pause',questionId:before.currentQuestionId},replyRelation:'current-question',support:{type:'support-boundary',need:'departure'}}};
    const result=await runLearningTurnV3(r.options(turn,response)),after=r.stored()!;
    expect(after.status).toBe('paused');expect(after.currentQuestionId).toBe(before.currentQuestionId);
    expect(after.evidence).toEqual(before.evidence);expect(after.help).toEqual(before.help);
    expect(result.text).toContain('已有进度会保留');expect(result.text).toContain('休息不需要顾虑我的感受');expect(result.text).not.toMatch(/不会走开|评分/);
    expect([...r.files.values()].join('')).not.toMatch(/失望|走开|顾虑我的感受/);
  });
  it.each(['cancel','source','truncated','save'] as const)('never claims a compound pause completed after %s before commit',async kind=>{
    const r=await rig(),turn=await r.prepare('暂停，别失望'),before=new Map(r.files);let stale=false;
    const response={control:{action:{type:'pause',questionId:turn.active!.currentQuestionId},replyRelation:'unrelated',support:{type:'support-boundary',need:'departure'}},reply:'PROMISE'};
    const raw=JSON.stringify(response);
    if(kind==='save')vi.spyOn(r.commands,'pause').mockRejectedValueOnce(Error('save-failed'));
    await expect(runLearningTurnV3(r.options(turn,response,{ensureCurrent:async()=>{if(stale)throw Error('source-changed');},transport:async(_i,delta)=>{
      delta(kind==='truncated'?raw.slice(0,-1):raw);if(kind==='cancel')r.controller.abort();if(kind==='source')stale=true;return {text:raw};
    }}))).rejects.toThrow();
    expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it('does not conceal a pause already committed when cancellation occurs before its acknowledgement',async()=>{
    const r=await rig(),turn=await r.prepare('暂停，别失望');
    const response={control:{action:{type:'pause',questionId:turn.active!.currentQuestionId},replyRelation:'unrelated',support:{type:'support-boundary',need:'departure'}},reply:''};
    await expect(runLearningTurnV3(r.options(turn,response,{ownCommit:()=>r.controller.abort()}))).rejects.toMatchObject({name:'AbortError'});
    expect(r.stored()!.status).toBe('paused');expect(r.stored()!.evidence).toEqual([]);expect(r.shown).toEqual([]);
  });
  it('rejects an orthogonal support response with the wrong pause target before any presentation or write',async()=>{
    const r=await rig(),turn=await r.prepare('暂停，别失望'),before=new Map(r.files);
    const response={control:{action:{type:'pause',questionId:crypto.randomUUID()},replyRelation:'unrelated',support:{type:'support-boundary',need:'departure'}},reply:'CLAIM'};
    const correction=vi.fn();await expect(runLearningTurnV3(r.options(turn,response,{onProtocolCorrection:correction}))).rejects.toThrow('teaching-control-rejected');
    expect(r.files).toEqual(before);expect(r.shown).toEqual([]);expect(correction).not.toHaveBeenCalled();
  });
  it('provides urgent support before attempting a separately requested pause save, without claiming a failed save',async()=>{
    const r=await rig(),turn=await r.prepare('我无法确保安全，请暂停'),before=new Map(r.files);
    const response={control:{action:{type:'pause',questionId:turn.active!.currentQuestionId},replyRelation:'unrelated',support:{type:'immediate-support',phase:'urgent'}},reply:''};
    vi.spyOn(r.commands,'pause').mockImplementationOnce(async()=>{expect(r.shown.join('')).toContain('联系当地紧急服务');throw Error('save-failed');});
    await expect(runLearningTurnV3(r.options(turn,response))).rejects.toThrow('save-failed');
    expect(r.shown.join('')).not.toContain('进度会保留');expect(r.files).toEqual(before);
  });
  it('prioritizes semantic immediate support without grading, help exposure or pausing the bound episode',async()=>{
    const r=await rig(),turn=await r.prepare('我不确定能否保持安全'),before=new Map(r.files);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:'immediate-support',phase:'urgent'},'UNSAFE_MODEL_RESPONSE','unrelated')));
    expect(result.text).toContain('联系当地紧急服务');expect(result.text).not.toContain('UNSAFE_MODEL');expect(r.files).toEqual(before);expect(r.stored()!.status).toBe('active');
  });
  it('acknowledges a memory dispute without rewriting facts or marking mathematical help',async()=>{
    const r=await rig(),turn=await r.prepare('你记错了，我没有说独立完成三次'),before=new Map(r.files);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:'memory-clarification',need:'disputed-fact'},'我已修改你的记录，你昨天看过提示','current-question')));
    expect(result.text).toContain('谢谢你指出来');expect(result.text).not.toMatch(/已修改|昨天|看过提示/);expect(r.files).toEqual(before);
    expect(r.stored()!.status).toBe('active');expect(r.stored()!.help).toEqual([]);expect(r.stored()!.evidence).toEqual([]);
  });
  it('provides offline capability information without pausing a current exercise or recording help',async()=>{
    const r=await rig(),turn=await r.prepare('离线能写字和看旧聊天吗'),before=new Map(r.files);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:'capability-info',topic:'offline'},'错误的离线承诺','current-question')));
    expect(result.text).toContain('各自的连接');expect(result.text).not.toContain('错误的');expect(r.files).toEqual(before);expect(r.stored()!.status).toBe('active');
  });
  it('streams a compound explanation, then offers one host invitation without writing before consent',async()=>{
    const r=await rig(false),turn=await r.prepare('先解释函数值与极限，举例，然后邀请我练习'),before=new Map(r.files);
    const explanation='函数值看点上的值，极限看附近的趋势。例如 f(x)=x²，x 趋近 2 时极限是 4。';
    const raw=JSON.stringify(envelope({type:'explain-and-invite',concept:'value-limit'},explanation,'unrelated')),blocked=barrier();
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{delta(raw.slice(0,-1));await blocked.wait();delta(raw.slice(-1));return {text:raw};});
    const pending=runLearningTurnV3(r.options(turn,undefined,{transport}));
    await blocked.entered;await vi.waitFor(()=>expect(r.shown.join('')).toBe(explanation));
    expect(r.files).toEqual(before);expect(r.shown.join('')).not.toContain('保存');blocked.release();
    const result=await pending;expect(result.text).toBe(explanation+'\n\n要不要试一道“函数值与极限”的小题？你愿意的话，我会保存这次练习进度，方便下次继续；也可以直接聊下去。');
    expect(r.files).toEqual(before);expect(transport).toHaveBeenCalledOnce();expect((await r.prepare('好的')).invitation?.concept).toBe('value-limit');
  });
  it.each(['cancel','incomplete','source'] as const)('never activates a compound invitation after %s, preserving already presented conceptual prose',async kind=>{
    const r=await rig(false),turn=await r.prepare('解释并邀请练习'),before=new Map(r.files),blocked=barrier();let stale=false;
    const raw=JSON.stringify(envelope({type:'explain-and-invite',concept:'value-limit'},'函数值看点，极限看附近。','unrelated'));
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{delta(raw.slice(0,-1));await blocked.wait();if(kind==='cancel'){r.controller.abort();throw new DOMException('Cancelled','AbortError');}if(kind==='source')stale=true;if(kind!=='incomplete')delta(raw.slice(-1));return {text:raw};});
    const pending=runLearningTurnV3(r.options(turn,undefined,{transport,ensureCurrent:async()=>{if(stale)throw Error('source-revision-changed');}}));
    const rejected=expect(pending).rejects.toThrow();await blocked.entered;await vi.waitFor(()=>expect(r.shown.join('')).toContain('附近'));blocked.release();await rejected;
    expect(r.shown.join('')).not.toContain('保存');expect(r.files).toEqual(before);expect(transport).toHaveBeenCalledOnce();expect((await r.prepare('好的')).invitation).toBeUndefined();
  });
  it.each(['invite','explain-and-invite'] as const)('expires an invitation when its host disclosure presenter fails: %s',async type=>{
    const r=await rig(false),turn=await r.prepare('邀请我练习'),before=new Map(r.files);
    await expect(runLearningTurnV3(r.options(turn,envelope({type,concept:'value-limit'},type==='invite'?'':'概念解释','unrelated'),{present:delta=>{if(delta.includes('保存'))throw Error('display-unavailable');r.shown.push(delta);return true;}}))).rejects.toThrow();
    expect(r.files).toEqual(before);expect((await r.prepare('好的')).invitation).toBeUndefined();
  });
  it("displays one host invitation only after completion, regardless of model introductory prose",async()=>{
    const r=await rig(false),turn=await r.prepare("请带我练习，先说明保存进度再等我同意"),before=new Map(r.files);
    const raw=JSON.stringify(envelope({type:"invite",concept:"value-limit"},"MODEL_INTRODUCTION_AND_DUPLICATE_CONSENT_PROMISE","unrelated"));
    const transport=vi.fn(async(_instructions:string,delta:(text:string)=>void)=>{
      delta(raw.slice(0,-1));await Promise.resolve();expect(r.shown).toEqual([]);expect(r.files).toEqual(before);
      delta(raw.slice(-1));return {text:raw};
    });
    const result=await runLearningTurnV3(r.options(turn,undefined,{transport}));
    expect(result.text).toBe('要不要试一道“函数值与极限”的小题？你愿意的话，我会保存这次练习进度，方便下次继续；也可以直接聊下去。');
    expect(r.shown.join("")).toBe(result.text);expect(r.files).toEqual(before);expect(transport).toHaveBeenCalledOnce();
    const accepted=await r.prepare("好的");expect(accepted.invitation?.concept).toBe("value-limit");
  });
  it("retains ordinary conceptual answers without forcing an invitation",async()=>{
    const r=await rig(false),turn=await r.prepare("直接解释函数值与极限，不做题"),before=new Map(r.files);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"none"},"函数值看这一点，极限看附近。","unrelated")));
    expect(result.text).toBe("函数值看这一点，极限看附近。");expect(r.files).toEqual(before);
    expect((await r.prepare("好的")).invitation).toBeUndefined();
  });
  it("never activates an invitation whose model request was cancelled",async()=>{
    const r=await rig(false),turn=await r.prepare("练习一下"),before=new Map(r.files);
    const transport=vi.fn(async(_instructions:string,delta:(text:string)=>void)=>{
      delta(JSON.stringify(envelope({type:"invite",concept:"value-limit"},"UNCONFIRMED_INVITATION")).slice(0,-1));
      r.controller.abort();throw new DOMException("Cancelled","AbortError");
    });
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport}))).rejects.toThrow("Cancelled");
    expect(r.shown).toEqual([]);expect(r.files).toEqual(before);
    expect((await r.prepare("好的")).invitation).toBeUndefined();
  });
  it.each(['active','completed'] as const)('rejects an unavailable invitation before output and corrects a %s episode new-question action once',async status=>{
    const r=await rig();if(status==='completed')await r.store.save({...r.stored()!,status});
    const turn=await r.prepare('换一道新题，不要提示或答案'),before=r.stored()!,correction=vi.fn(),instructions:string[]=[];
    expect(turn.canInvite).toBe(false);
    const transport=vi.fn(async(i:string,delta:(text:string)=>void)=>{instructions.push(i);const response=instructions.length===1?envelope({type:'invite',concept:'value-limit'},'UNAUTHORIZED_NEW_INVITATION'):envelope({type:'next',questionId:turn.active!.currentQuestionId});const text=JSON.stringify(response);delta(text);return {text};});
    const result=await runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction})),after=r.stored()!;
    expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledExactlyOnceWith({attempt:1,errorCode:'teaching-control-schema-invitation-unavailable'});expect(instructions[1]).toContain('canInvite=false');expect(instructions[1]).not.toContain('UNAUTHORIZED_NEW_INVITATION');
    expect(after.questions).toHaveLength(before.questions.length+1);expect(after.currentQuestionId).not.toBe(before.currentQuestionId);expect(after.evidence).toEqual(before.evidence);expect(after.help).toEqual(before.help);expect(after.consent).toEqual(before.consent);expect(result.text).toBe(renderQuestionV3(after.questions.at(-1)!).prompt);expect(r.shown.join('')).not.toContain('UNAUTHORIZED_NEW_INVITATION');
  });
  it('does not turn a repeated unavailable invitation into consent, writes or an unbounded retry',async()=>{
    const r=await rig(),turn=await r.prepare('换题'),before=new Map(r.files),correction=vi.fn(),transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{const text=JSON.stringify(envelope({type:'invite',concept:'value-limit'},'INVALID'));delta(text);return {text};});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).rejects.toThrow('invitation-unavailable');expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledOnce();expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it('retains a distinct provider failure when an unavailable invitation was also received',async()=>{
    const r=await rig(),turn=await r.prepare('换题'),before=new Map(r.files),correction=vi.fn(),transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{try{delta(JSON.stringify(envelope({type:'invite',concept:'value-limit'})));}catch{}throw Error('HTTP 403 provider limit');});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).rejects.toThrow('HTTP 403');expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();expect(r.files).toEqual(before);
  });
  it.each(['cancel','source','revision'] as const)('does not retry an unavailable invitation after %s invalidates the turn',async kind=>{
    const r=await rig(),turn=await r.prepare('换题');let stale=false;
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{const text=JSON.stringify(envelope({type:'invite',concept:'value-limit'}));delta(text);return {text};});
    const correction=vi.fn(async()=>{if(kind==='cancel')r.controller.abort();else if(kind==='source')stale=true;else await r.store.save({...r.stored()!,status:'paused'});});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction,ensureCurrent:async()=>{if(stale)throw Error('source-revision-changed');if((await r.store.list()).find(e=>e.id===turn.active!.id)?.revision!==turn.active!.revision)throw Error('learning-revision-changed');}}))).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();expect(r.stored()!.evidence).toEqual([]);expect(r.stored()!.questions).toHaveLength(1);expect(r.shown).toEqual([]);
  });
  async function candidate(r:Awaited<ReturnType<typeof rig>>,pool:"practice"|"transfer"="practice",source=r.source,question=questionRefV3("value-limit",pool,0,crypto.randomUUID())){
    const conversationId=crypto.randomUUID(),invitation=r.commands.offer({authority:r.authority,conversationId,source,requestId:crypto.randomUUID(),concept:"value-limit",question});
    return (await r.commands.accept(invitation,{authority:r.authority,conversationId,source,requestId:crypto.randomUUID()})).episode;
  }
  it("resumes an explicitly identified question among multiple records, without changing the other episode",async()=>{
    const r=await rig(false),one=await candidate(r),two=await candidate(r,"transfer"),turn=await r.prepare("继续传感器那道题，只重复题目"),before=new Map(r.files);
    expect(turn.candidate).toBeUndefined();expect(turn.canAnswer).toBe(false);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"resume",questionId:two.currentQuestionId},"MODEL_PROMISE_MUST_NOT_SHOW")));
    expect(result.text).toBe(renderQuestionV3(two.questions[0]!).prompt);
    expect(r.files.get(`${r.store.root}/${one.id}.json`)).toBe(before.get(`${r.store.root}/${one.id}.json`));
    const saved=(await r.store.list()).find(e=>e.id===two.id)!;expect(saved.evidence).toEqual([]);expect(saved.help).toEqual([]);expect(saved.questions).toEqual(two.questions);
    expect(r.dialogue.boundEpisodeId(r.conversationId,r.source.path)).toBe(two.id);
    const committed=new Map(r.files),replayed=await runLearningTurnV3(r.options(turn,envelope({type:"resume",questionId:two.currentQuestionId})));
    expect(replayed.text).toBe(result.text);expect(r.files).toEqual(committed);
    const answer=await r.prepare("6");expect(answer.canAnswer).toBe(true);expect(answer.active?.id).toBe(two.id);
  });
  it("keeps an ambiguous continuation as clarification, without automatically binding a candidate",async()=>{
    const r=await rig(false);await candidate(r);await candidate(r,"transfer");const turn=await r.prepare("继续上次的题"),before=new Map(r.files);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"none"},"是平方函数的题，还是传感器的题？","unrelated")));
    expect(result.text).toContain("还是");expect(r.files).toEqual(before);expect(r.dialogue.boundEpisodeId(r.conversationId,r.source.path)).toBeUndefined();
  });
  it.each(["foreign","missing","duplicate","answer","hint"] as const)("rejects %s target selection without retry, help exposure or activation",async kind=>{
    const r=await rig(false),one=await candidate(r),two=await candidate(r,"transfer",kind==="foreign"?{path:"other.md",version:"v1"}:r.source);
    if(kind==="duplicate")await candidate(r,"practice",r.source,one.questions[0]!);
    const turn=await r.prepare("继续"),before=new Map(r.files),correction=vi.fn();
    const questionId=kind==="foreign"?two.currentQuestionId:kind==="missing"?crypto.randomUUID():one.currentQuestionId;
    await expect(runLearningTurnV3(r.options(turn,envelope({type:kind==="answer"?"answer":kind==="hint"?"hint":"resume",questionId}),{onProtocolCorrection:correction}))).rejects.toThrow();
    expect(correction).not.toHaveBeenCalled();expect(r.files).toEqual(before);expect(r.shown).toEqual([]);expect(r.dialogue.boundEpisodeId(r.conversationId,r.source.path)).toBeUndefined();
  });
  it.each(["revision","delete","source","cancel"] as const)("does not commit a selected resume after %s changes during the model request",async kind=>{
    const r=await rig(false),one=await candidate(r),two=await candidate(r,"transfer"),turn=await r.prepare("继续传感器题");let changed=false,before!:Map<string,string>;
    const transport=vi.fn(async(_instructions:string,delta:(text:string)=>void)=>{
      if(kind==="revision")await r.store.save({...two,status:"paused"});
      else if(kind==="delete")await r.commands.forget({authority:r.authority,requestId:crypto.randomUUID(),episodeId:two.id,questionId:two.currentQuestionId,expectedRevision:two.revision,source:two.source});
      else if(kind==="source")changed=true;else r.controller.abort();
      before=new Map(r.files);const text=JSON.stringify(envelope({type:"resume",questionId:two.currentQuestionId}));delta(text);return {text};
    });
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,ensureCurrent:async()=>{if(changed)throw new Error("source-revision-changed");}}))).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();expect(r.files).toEqual(before);expect(r.shown).toEqual([]);expect(r.dialogue.boundEpisodeId(r.conversationId,r.source.path)).toBeUndefined();
    expect((await r.store.list()).find(e=>e.id===one.id)!.evidence).toEqual([]);
  });
  it("corrects an early answer after several reviews, invalidates dependent checks and keeps later answers and help",async()=>{
    const r=await rig();
    async function answer(){
      const e=r.stored()!,q=renderQuestionV3(e.questions.find(q=>q.id===e.currentQuestionId)!),turn=await r.prepare(q.answer);
      await runLearningTurnV3(r.options(turn,envelope({type:"answer",questionId:q.id})));
    }
    await answer();await answer();
    for(let i=0;i<3;i++){
      const e=r.stored()!,task=e.reviewTasks.find(t=>t.state==="scheduled")!;task.dueAt="2026-10-08T12:00:00.000Z";task.localDate="2026-10-08";await r.store.save(e);
      const turn=await r.prepare("继续到期检查，只告诉我题目");await runLearningTurnV3(r.options(turn,envelope({type:"resume",questionId:turn.active!.currentQuestionId})));await answer();
    }
    const before=r.stored()!,first=before.evidence[0]!,later=before.evidence.slice(1),turn=await r.prepare("第一题那次我用了别处的提示，请撤回无提示完成的记录");
    expect(turn.safeSummary).not.toContain(first.id);
    const state=JSON.parse(r.dialogue.instructions(turn).split("Host state (data): ")[1]!);expect(state.correctionCandidates.some((item:{evidenceId:string})=>item.evidenceId===first.id)).toBe(true);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"correct",questionId:first.questionId,evidenceId:first.id}))),saved=r.stored()!;
    expect(result.text).toContain("后来的作答仍保留");expect(saved.evidence.slice(0,before.evidence.length)).toEqual(before.evidence);expect(saved.help).toEqual(before.help);expect(saved.currentQuestionId).toBe(before.currentQuestionId);
    expect(saved.evidence.at(-1)).toMatchObject({type:"correction",questionId:first.questionId,corrects:first.id});expect(saved.evidence).toHaveLength(before.evidence.length+1);
    const effective=effectiveLearningV3(saved,(await r.store.readEffectiveResult()).protectionByEpisode.get(saved.id));
    expect(effective.answers.map(e=>e.id)).toEqual(later.map(e=>e.id));expect(effective.reviewTasks.every(t=>t.state==="invalidated")).toBe(true);
    expect(effective.progressAnswers.every(e=>!effective.dependentEvidenceIds.has(e.id)&&e.id!==first.id)).toBe(true);
    const snapshot=new Map(r.files);await runLearningTurnV3(r.options(turn,envelope({type:"correct",questionId:first.questionId,evidenceId:first.id})));expect(r.files).toEqual(snapshot);
    const continued=await r.prepare("继续，不换新题"),reply=await runLearningTurnV3(r.options(continued,envelope({type:"resume",questionId:continued.active!.currentQuestionId})));
    expect(reply.text).toContain("目前没有安排后续检查");expect(r.stored()!.help).toEqual(before.help);expect(r.stored()!.questions).toEqual(before.questions);
  });
  it.each(["好，我们就继续聊刚才的问题。",""])("declines an exact invitation with a natural reply and no persisted episode: %#",async reply=>{
    const r=await rig(false),offered=await r.prepare("极限是什么"),invitation=r.dialogue.offer(offered,envelope({type:"invite",concept:"value-limit"},"解释"));
    const turn=await r.prepare("不做练习"),result=await runLearningTurnV3(r.options(turn,envelope({type:"decline",invitationId:invitation.id},reply,"unrelated")));
    expect(result.text.trim()).not.toBe("");expect(r.shown.join("")).toBe(result.text);if(reply)expect(result.text).toBe(reply);
    expect(r.files.size).toBe(0);const later=await r.prepare("好");expect(later.invitation).toBeUndefined();expect(later.canInvite).toBe(false);
  });
  it("never shows a hint before its protection and episode CAS finish",async()=>{
    const r=await rig(),turn=await r.prepare(),blocked=barrier(),write=r.io.compareWrite,primary=`${r.store.root}/${r.episode!.id}.json`;let waited=false;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{if(p===primary&&!waited){waited=true;await blocked.wait();}await write(p,b,n);});
    const pending=runLearningTurnV3(r.options(turn,envelope({type:"hint",questionId:turn.active!.currentQuestionId},"MODEL_HINT_MUST_NOT_SHOW"),{present:delta=>{
      expect(r.stored()!.help[0]).toMatchObject({kind:"hint",state:"prepared"});expect(r.files.has(r.store.protection.path(r.episode!.id))).toBe(true);r.shown.push(delta);return true;
    }}));
    await blocked.entered;expect(r.shown).toEqual([]);expect(r.stored()!.help).toEqual([]);blocked.release();
    const result=await pending;expect(result.text).toBe(renderQuestionV3(turn.active!.questions[0]!).hint);
    expect(result.text).not.toContain("MODEL_HINT");expect(r.stored()!.help[0]!.state).toBe("presented");expect(r.stored()!.evidence).toEqual([]);
  });
  it("does not display help when the preparation CAS fails",async()=>{
    const r=await rig(),turn=await r.prepare(),write=r.io.compareWrite,primary=`${r.store.root}/${r.episode!.id}.json`;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{if(p===primary)throw new Error("save-unavailable");await write(p,b,n);});
    await expect(runLearningTurnV3(r.options(turn,envelope({type:"hint",questionId:turn.active!.currentQuestionId})))).rejects.toThrow("preparation-not-confirmed");
    expect(r.shown).toEqual([]);expect(r.stored()!.help).toEqual([]);expect((await r.store.protection.read(r.episode!.id)).questions.get(turn.active!.currentQuestionId)?.blockedFromSequence).toBe(1);
  });
  it("uses the host's full solution and records it before showing the answer",async()=>{
    const r=await rig(),turn=await r.prepare("直接告诉我完整答案"),question=renderQuestionV3(turn.active!.questions[0]!);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"solution",questionId:question.id},"MODEL_SOLUTION_MUST_NOT_SHOW")));
    expect(result.text).toContain(question.answer);expect(result.text).toContain(question.explanation);expect(result.text).not.toContain("MODEL_SOLUTION");
    expect(r.stored()!.help[0]).toMatchObject({kind:"solution",state:"presented"});expect(r.stored()!.evidence).toEqual([]);
  });
  it("retains unknown help if cancelled after saving but before the first visible fragment",async()=>{
    const r=await rig(),turn=await r.prepare(),blocked=barrier();let first=true;
    const pending=runLearningTurnV3(r.options(turn,envelope({type:"solution",questionId:turn.active!.currentQuestionId}),{ownCommit:async()=>{if(first){first=false;await blocked.wait();}}}));
    const rejected=expect(pending).rejects.toThrow();await blocked.entered;expect(r.stored()!.help[0]!.state).toBe("prepared");
    r.controller.abort();blocked.release();await rejected;expect(r.shown).toEqual([]);expect(r.stored()!.help[0]!.state).toBe("unknown");
    expect(r.stored()!.evidence).toEqual([]);
  });
  it("confirms a fragment already shown even when its presenter cancels generation",async()=>{
    const r=await rig(),turn=await r.prepare();
    await expect(runLearningTurnV3(r.options(turn,envelope({type:"solution",questionId:turn.active!.currentQuestionId}),{present:delta=>{r.shown.push(delta);r.controller.abort();return true;}}))).rejects.toThrow();
    expect(r.shown).toHaveLength(1);expect(r.stored()!.help[0]!.state).toBe("presented");expect(r.stored()!.help).toHaveLength(1);
  });
  it("retains a durable help ticket if host commit notification fails",async()=>{
    const r=await rig(),turn=await r.prepare();let notified=false;
    await expect(runLearningTurnV3(r.options(turn,envelope({type:"hint",questionId:turn.active!.currentQuestionId}),{ownCommit:()=>{if(!notified){notified=true;throw new Error("foreign-lease-invalid");}}}))).rejects.toThrow();
    expect(r.shown).toEqual([]);expect(r.stored()!.help[0]!.state).toBe("unknown");
  });
  it("keeps annotation streaming unknown until an actual append is explicitly confirmed, including after cancellation",async()=>{
    const r=await rig(),turn=await r.prepare("给个提示",{entry:"annotation"});
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"hint",questionId:turn.active!.currentQuestionId}),{present:()=>{}}));
    expect(result.text).toBe(renderQuestionV3(turn.active!.questions[0]!).hint);expect(r.stored()!.help[0]!.state).toBe("unknown");
    r.controller.abort();await result.confirmProvided();expect(r.stored()!.help[0]!.state).toBe("presented");
    const snapshot=new Map(r.files);await result.confirmProvided();expect(r.files).toEqual(snapshot);
  });
  it("does not resurrect a deleted episode through a late annotation presentation confirmation",async()=>{
    const r=await rig(),turn=await r.prepare();
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"hint",questionId:turn.active!.currentQuestionId}),{present:()=>{}}));
    await r.store.remove(r.episode!.id);const snapshot=new Map(r.files);
    await expect(result.confirmProvided()).rejects.toThrow("target-unavailable");expect(r.files).toEqual(snapshot);expect(await r.store.list()).toEqual([]);
  });
  it.each(["wrong-question","free-text-criteria","invented-answer-field"])("rejects invalid control without showing prose or writing evidence: %s",async kind=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files);
    const action=kind==="wrong-question"?{type:"answer",questionId:crypto.randomUUID()}:kind==="free-text-criteria"?{type:"explain",questionId:turn.active!.currentQuestionId,criteria:[{id:"point-versus-limit",state:"supported",text:"PRIVATE"}]}:{type:"answer",questionId:turn.active!.currentQuestionId,answer:9};
    await expect(runLearningTurnV3(r.options(turn,{control:{action,replyRelation:"current-question"},reply:"MODEL_PROSE"}))).rejects.toThrow();
    expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it("does not execute an explanation command from a truncated envelope",async()=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),raw=JSON.stringify(envelope({type:"explain",questionId:turn.active!.currentQuestionId,criteria:[{id:"point-versus-limit",state:"supported"}]},"MODEL_FEEDBACK"));
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport:async(_i,delta)=>{delta(raw.slice(0,-1));return {text:raw};}}))).rejects.toThrow("incomplete");
    expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it("shows host-graded answer feedback only after answer, help and transfer are saved",async()=>{
    const r=await rig(),question=renderQuestionV3(r.episode!.questions[0]!),turn=await r.prepare(question.answer);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"answer",questionId:question.id},"MODEL_SCORE_MUST_NOT_SHOW"),{present:delta=>{
      expect(r.stored()!.evidence[0]).toMatchObject({type:"answer",outcome:"correct",independence:"no-plugin-help"});expect(r.stored()!.questions).toHaveLength(2);expect(r.stored()!.help[0]!.state).toBe("prepared");r.shown.push(delta);return true;
    }}));
    expect(result.text).toContain("这次计算正确");expect(result.text).toContain(question.explanation);expect(result.text).not.toContain("MODEL_SCORE");
    expect(r.stored()!.help[0]).toMatchObject({questionId:question.id,state:"presented"});expect(r.stored()!.questions[1]!.pool).toBe("transfer");
  });
  it.each(["hint","answer"] as const)("retries the same captured %s turn without another help event, grade or question",async type=>{
    const r=await rig(),question=renderQuestionV3(r.episode!.questions[0]!),turn=await r.prepare(type==="answer"?question.answer:"提示一下"),response=envelope({type,questionId:question.id});
    const first=await runLearningTurnV3(r.options(turn,response)),snapshot=new Map(r.files);
    const second=await runLearningTurnV3(r.options(turn,response));
    expect(second.text).toBe(first.text);expect(r.files).toEqual(snapshot);expect(r.stored()!.help).toHaveLength(1);
    expect(r.stored()!.help[0]!.state).toBe("presented");expect(r.stored()!.evidence).toHaveLength(type==="answer"?1:0);expect(r.stored()!.questions).toHaveLength(type==="answer"?2:1);
  });
  it("asks for clarification instead of scoring mixed private text selected by a model span",async()=>{
    const r=await rig(),question=renderQuestionV3(r.episode!.questions[0]!),input=`我有私人烦恼，顺便写下 ${question.answer}`,turn=await r.prepare(input),before=new Map(r.files),from=input.lastIndexOf(question.answer);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"answer",questionId:question.id,span:{from,to:input.length}})));
    expect(result.text).toContain("本轮没有记成错误");expect(r.files).toEqual(before);
  });
  it.each(['我的最终答案是','这次我改为'])("uses whole-utterance source validation for %s without relying on a model offset",async prefix=>{
    const r=await rig(),question=renderQuestionV3(r.episode!.questions[0]!),text=`${prefix} ${question.answer}。`,turn=await r.prepare(text);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:'answer',questionId:question.id,span:{from:0,to:1}})));
    expect(result.text).toContain('这次计算正确');expect(r.stored()!.evidence).toHaveLength(1);expect(r.stored()!.evidence[0]).toMatchObject({type:'answer',outcome:'correct'});
    expect([...r.files.values()].join('')).not.toContain(prefix);
  });
  it("grades an explicit answer followed by a bounded check request once, without persisting request prose",async()=>{
    const r=await rig(),question=renderQuestionV3(r.episode!.questions[0]!),text=`我的答案是 ${question.answer}。请检查，不需要再给提示。`,turn=await r.prepare(text);
    const from=text.indexOf(question.answer),response=envelope({type:"answer",questionId:question.id,span:{from,to:from+question.answer.length}});
    await runLearningTurnV3(r.options(turn,response));const before=new Map(r.files);
    await runLearningTurnV3(r.options(turn,response));
    expect(r.files).toEqual(before);expect(r.stored()!.evidence).toHaveLength(1);
    expect(r.stored()!.evidence[0]).toMatchObject({type:"answer",outcome:"correct",independence:"no-plugin-help"});
    expect([...r.files.values()].join("")).not.toContain("请检查");
  });
  it.each([true,false])("reports completed review status accurately without inventing help or future checks: scheduled=%s",async scheduled=>{
    const r=await rig(),e=r.episode!;e.status="completed";
    if(scheduled)e.reviewTasks.push({id:crypto.randomUUID(),dueAt:"2026-10-12T12:00:00.000Z",localDate:"2026-10-12",step:0,state:"scheduled",dependsOn:[]});
    await r.store.save(e);const turn=await r.prepare("继续这份材料上次的题，不换题"),result=await runLearningTurnV3(r.options(turn,envelope({type:"resume",questionId:e.currentQuestionId})));
    expect(result.text).toContain(scheduled?"下次检查还没到时间":"目前没有安排后续检查");
    expect(r.stored()!.questions).toHaveLength(1);expect(r.stored()!.help).toEqual([]);expect(r.stored()!.evidence).toEqual([]);
    expect(r.stored()!.reviewTasks).toHaveLength(scheduled?1:0);
  });
  it("repeats the exact due question without adding help and advances an unhelped answer",async()=>{
    const r=await rig(),e=r.episode!,taskId=crypto.randomUUID();e.status="completed";
    e.reviewTasks.push({id:taskId,dueAt:"2026-10-08T12:00:00.000Z",localDate:"2026-10-08",step:0,state:"scheduled",dependsOn:[]});await r.store.save(e);
    let turn=await r.prepare("继续到期检查，只显示题目");await runLearningTurnV3(r.options(turn,envelope({type:"resume",questionId:turn.active!.currentQuestionId})));
    const active=r.stored()!,question=renderQuestionV3(active.questions.find(q=>q.id===active.currentQuestionId)!);
    turn=await r.prepare("继续刚才的检查，只把题目告诉我");const repeat=await runLearningTurnV3(r.options(turn,envelope({type:"resume",questionId:question.id})));
    expect(repeat.text).toContain(question.prompt);expect(r.stored()!.help).toEqual([]);expect(r.stored()!.reviewTasks).toEqual(active.reviewTasks);expect(r.stored()!.questions).toEqual(active.questions);
    turn=await r.prepare(question.answer);await runLearningTurnV3(r.options(turn,envelope({type:"answer",questionId:question.id})));
    expect(r.stored()!.evidence[0]).toMatchObject({outcome:"correct",independence:"no-plugin-help",helpIds:[]});
    expect(r.stored()!.reviewTasks.find(t=>t.state==="scheduled")).toMatchObject({step:1,dueAt:"2026-10-12T12:00:00.000Z"});
  });
  it("presents a correctable explanation judgment without storing its prose or counting an objective score",async()=>{
    const r=await rig(),turn=await r.prepare("我的解释是一个自然句子"),feedback="本次解释区分了函数值与极限",criteria=[{id:conceptCriterion[turn.active!.concept],state:"supported" as const}];
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"explain",questionId:turn.active!.currentQuestionId,criteria},feedback),{present:delta=>{
      expect(r.stored()!.evidence[0]).toMatchObject({type:"judgment",evaluator:"tutor",outcome:"unreviewed"});expect(r.stored()!.help[0]!.state).toBe("prepared");r.shown.push(delta);return true;
    }}));
    expect(result.text).toContain("Tutor 判断（可纠正）");expect(result.text).toContain(feedback);
    const all=[...r.files.values()].join("");expect(all).not.toContain(feedback);expect(all).not.toContain(turn.text);
    const effective=effectiveLearningV3(r.stored()!);expect(effective.judgments).toHaveLength(1);expect(effective.answers).toEqual([]);expect(effective.progressAnswers).toEqual([]);
  });
  it("pauses before showing supportive prose that says progress is saved",async()=>{
    const r=await rig(),turn=await r.prepare("今天就到这里"),response="今天可以先休息，进度会保留。";
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"pause",questionId:turn.active!.currentQuestionId},response,"unrelated"),{present:delta=>{expect(r.stored()!.status).toBe("paused");r.shown.push(delta);return true;}}));
    expect(result.text).toContain(response);expect(r.stored()!.help).toEqual([]);expect(r.stored()!.evidence).toEqual([]);
  });
  it("does not show a pause success claim when the pause save fails",async()=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),write=r.io.compareWrite,primary=`${r.store.root}/${r.episode!.id}.json`;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{if(p===primary)throw new Error("pause-save-failed");await write(p,b,n);});
    await expect(runLearningTurnV3(r.options(turn,envelope({type:"pause",questionId:turn.active!.currentQuestionId},"已暂停成功","unrelated")))).rejects.toThrow("pause-save-failed");
    expect(r.shown).toEqual([]);expect(r.files.get(primary)).toBe(before.get(primary));
    expect(r.stored()!).toMatchObject({status:"active",help:[],evidence:[]});
  });
  it("streams pure support in an active exercise without evidence or help writes",async()=>{
    const r=await rig(),turn=await r.prepare("答案可能是 7 或 4，但今天只想聊挫败感，先别评分"),before=new Map(r.files),reply="这道题先放着，我们可以先聊聊你现在需要什么。";
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"none"},reply,"unrelated")));
    expect(result.text).toBe(reply);expect(r.shown.join("")).toBe(reply);expect(r.files).toEqual(before);
  });
  it("pauses with emotional reassurance without changing question, evidence or help",async()=>{
    const r=await rig(),turn=await r.prepare("请暂停这道题，你会失望吗？"),before=r.stored()!,reply="不会，休息不需要向我交代。";
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"pause",questionId:turn.active!.currentQuestionId},reply,"unrelated"))),after=r.stored()!;
    expect(result.text).toContain(reply);expect(after.status).toBe("paused");expect(after.questions).toEqual(before.questions);expect(after.currentQuestionId).toBe(before.currentQuestionId);expect(after.evidence).toEqual(before.evidence);expect(after.help).toEqual(before.help);
  });
  it("keeps potential mathematical help conservative even during an emotional conversation",async()=>{
    const r=await rig(),turn=await r.prepare("我很沮丧，但还是想听一点这题的思路"),reply="先区分函数值与附近的趋势。";
    await runLearningTurnV3(r.options(turn,envelope({type:"none"},reply,"uncertain")));
    expect(r.stored()!.help).toEqual([expect.objectContaining({kind:"related-discussion",state:"presented",questionId:turn.active!.currentQuestionId})]);expect(r.stored()!.evidence).toEqual([]);
  });
  it("prepares related pause prose, commits the pause, and then confirms its presentation",async()=>{
    const r=await rig(),turn=await r.prepare("先暂停，不过请总结这题"),reply="这道题需要区分点上的值与附近趋势。";
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"pause",questionId:turn.active!.currentQuestionId},reply),{present:delta=>{
      expect(r.stored()!.status).toBe("paused");expect(r.stored()!.help[0]).toMatchObject({kind:"related-discussion",state:"prepared"});r.shown.push(delta);return true;
    }}));
    expect(result.text).toContain(reply);expect(r.stored()!.status).toBe("paused");expect(r.stored()!.help[0]!.state).toBe("presented");
  });
  it("shows a successful deletion receipt before expiring the current conversation lease",async()=>{
    const r=await rig(),turn=await r.prepare("忘掉这次练习");
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"forget",questionId:turn.active!.currentQuestionId}),{present:delta=>{
      expect(r.stored()!.status).toBe("deleted");expect(r.files.has(`${r.store.root}/${r.episode!.id}.json.deleted`)).toBe(true);r.shown.push(delta);return true;
    }}));
    expect(result.text).toContain("已停止使用这次学习记录");expect(await r.store.list()).toEqual([]);
    expect(()=>r.dialogue.assertCurrent(turn)).toThrow();expect((await r.prepare("继续聊聊")).active).toBeUndefined();
  });
  it("retains a committed deletion if cancellation prevents its success receipt from being displayed",async()=>{
    const r=await rig(),turn=await r.prepare("忘掉这次练习"),commits:EpisodeV3[]=[];
    await expect(runLearningTurnV3(r.options(turn,envelope({type:"forget",questionId:turn.active!.currentQuestionId}),{ownCommit:result=>{commits.push(result.episode);r.controller.abort();}}))).rejects.toThrow();
    expect(commits[0]!.status).toBe("deleted");expect(r.shown).toEqual([]);expect(await r.store.list()).toEqual([]);expect(()=>r.dialogue.assertCurrent(turn)).toThrow();
  });
  it.each(["paused","completed"] as const)("records ordinary related help without reactivating a %s episode",async status=>{
    const r=await rig();r.episode!.status=status;await r.store.save(r.episode!);const turn=await r.prepare("再解释一下刚才的题");
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"none"},"与该题相关的解释")));
    expect(result.text).toBe("与该题相关的解释");expect(r.stored()!.status).toBe(status);expect(r.stored()!.help[0]).toMatchObject({kind:"related-discussion",state:"presented"});
    expect(r.stored()!.evidence).toEqual([]);
  });
  it("rejects an already cancelled run before invoking transport",async()=>{
    const r=await rig(),turn=await r.prepare(),transport=vi.fn();r.controller.abort();
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport}))).rejects.toMatchObject({name:"AbortError"});expect(transport).not.toHaveBeenCalled();expect(r.shown).toEqual([]);
  });
  it("rechecks cancellation after an awaited source lease check",async()=>{
    const r=await rig(),turn=await r.prepare(),blocked=barrier(),transport=vi.fn(),before=new Map(r.files);
    const pending=runLearningTurnV3(r.options(turn,undefined,{transport,ensureCurrent:()=>blocked.wait()})),rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});
    await blocked.entered;r.controller.abort();blocked.release();await rejected;expect(transport).not.toHaveBeenCalled();expect(r.files).toEqual(before);
  });
  it.each(["delta","return"] as const)("reports cancellation for a non-cooperating transport's late %s instead of a protocol error",async delivery=>{
    const r=await rig(),turn=await r.prepare(),blocked=barrier(),before=new Map(r.files),raw=JSON.stringify(envelope({type:"none"},"late reply","unrelated"));
    const pending=runLearningTurnV3(r.options(turn,undefined,{transport:async(_i,delta)=>{await blocked.wait();if(delivery==="delta")delta(raw);return {text:raw};}}));
    const rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});await blocked.entered;r.controller.abort();blocked.release();await rejected;
    expect(r.shown).toEqual([]);expect(r.files).toEqual(before);
  });
  it("blocks a complete old answer response after a newer turn takes over the conversation",async()=>{
    const r=await rig(),question=renderQuestionV3(r.episode!.questions[0]!),turn=await r.prepare(question.answer),blocked=barrier(),before=new Map(r.files);
    const pending=runLearningTurnV3(r.options(turn,envelope({type:"answer",questionId:question.id}),{transport:async(_i,delta)=>{await blocked.wait();const text=JSON.stringify(envelope({type:"answer",questionId:question.id}));delta(text);return {text};}}));
    const rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});await blocked.entered;await r.prepare("新问题");blocked.release();await rejected;
    expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it("checks the current conversation again before displaying a late unrelated fragment",async()=>{
    const r=await rig(false),turn=await r.prepare("普通问题"),blocked=barrier();
    const pending=runLearningTurnV3(r.options(turn,undefined,{transport:async(_i,delta)=>{
      delta('{"control":{"action":{"type":"none"},"replyRelation":"unrelated"},"reply":"');await blocked.wait();delta('迟到的回复"}');return {text:""};
    }}));
    const rejected=expect(pending).rejects.toThrow();await blocked.entered;await r.prepare("另一个新问题");blocked.release();await rejected;
    expect(r.shown).toEqual([]);expect(r.files.size).toBe(0);
  });
  it("blocks command execution when the live source lease fails after transport",async()=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files);let stale=false;
    const options=r.options(turn,envelope({type:"next",questionId:turn.active!.currentQuestionId}),{ensureCurrent:async()=>{if(stale)throw new Error("source-revision-changed");}}),original=options.transport;
    options.transport=async(i,d)=>{const result=await original(i,d);stale=true;return result;};
    await expect(runLearningTurnV3(options)).rejects.toThrow("source-revision-changed");expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it.each(["","  \n  "])("turns an empty ordinary reply into a neutral response without preparing help: %#",async reply=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files);
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"none"},reply)));
    expect(result.text).toContain("没有收到可显示的回复");expect(r.files).toEqual(before);
  });
  it("handles an empty transport without accepting or expiring a pending invitation",async()=>{
    const r=await rig(false),offered=await r.prepare(),invitation=r.dialogue.offer(offered,envelope({type:"invite",concept:"value-limit"})),turn=await r.prepare("好");
    const result=await runLearningTurnV3(r.options(turn,undefined,{transport:async()=>({text:""})}));
    expect(result.text).toContain("没有收到可显示的回复");expect(r.files.size).toBe(0);
    const accepted=await r.dialogue.accept(turn,envelope({type:"accept",invitationId:invitation.id}));expect(accepted.episode.id).toBe(invitation.episodeId);
  });
  it("saves help before invoking an expert that may create a visible artifact",async()=>{
    const r=await rig(),turn=await r.prepare("请专家画图"),expert=vi.fn(async()=>{expect(r.stored()!.help[0]).toMatchObject({kind:"related-discussion",state:"prepared"});return "专家的检查结果";});
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"expert",questionId:turn.active!.currentQuestionId,kind:"diagram"}),{expert}));
    expect(expert).toHaveBeenCalledOnce();expect(result.text).toBe("专家的检查结果");expect(r.stored()!.help[0]!.state).toBe("presented");
  });
  it.each(["failure","cancel"] as const)("retains unknown help and created artifacts on expert %s",async kind=>{
    const r=await rig(),turn=await r.prepare(),artifacts:string[]=[];
    await expect(runLearningTurnV3(r.options(turn,envelope({type:"expert",questionId:turn.active!.currentQuestionId,kind:"diagram"}),{expert:async()=>{
      artifacts.push("already-created-drawing");if(kind==="failure")throw new Error("expert-failed");r.controller.abort();return "late expert result";
    }}))).rejects.toThrow();
    expect(artifacts).toEqual(["already-created-drawing"]);expect(r.shown).toEqual([]);expect(r.stored()!.help[0]!.state).toBe("unknown");
  });
  it("does not falsely confirm unseen expert content when only an empty-result notice was appended",async()=>{
    const r=await rig(),turn=await r.prepare();
    const result=await runLearningTurnV3(r.options(turn,envelope({type:"expert",questionId:turn.active!.currentQuestionId,kind:"research"}),{expert:async()=>"",present:()=>{}}));
    expect(result.text).toContain("没有返回可显示的回复");expect(r.stored()!.help[0]!.state).toBe("unknown");await result.confirmProvided();expect(r.stored()!.help[0]!.state).toBe("unknown");
  });
  it("does not invoke an expert if preparing help fails",async()=>{
    const r=await rig(),turn=await r.prepare(),expert=vi.fn(),write=r.io.compareWrite,primary=`${r.store.root}/${r.episode!.id}.json`;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{if(p===primary)throw new Error("cannot-prepare");await write(p,b,n);});
    await expect(runLearningTurnV3(r.options(turn,envelope({type:"expert",questionId:turn.active!.currentQuestionId,kind:"research"}),{expert}))).rejects.toThrow();expect(expert).not.toHaveBeenCalled();expect(r.shown).toEqual([]);
  });
});


describe("bounded learning protocol correction",()=>{
  it.each(["streamed-wrapped","returned","incomplete"] as const)("corrects one untouched malformed %s response and commits the original request once",async delivery=>{
    const r=await rig(),question=renderQuestionV3(r.episode!.questions[0]!),turn=await r.prepare(question.answer);
    const raw=JSON.stringify(envelope({type:"answer",questionId:question.id},"MODEL_PROSE_MUST_NOT_SHOW")),bad=delivery==="incomplete"?raw.slice(0,-1):raw+"BAD_SUFFIX_PRIVATE";
    const correction=vi.fn(),instructions:string[]=[];
    const transport=vi.fn(async(i:string,delta:(text:string)=>void)=>{
      instructions.push(i);
      if(instructions.length===1){
        if(delivery==="returned")return {text:bad};
        try{delta(bad);}catch(error){throw new Error((error as Error).message);}
        return {text:bad};
      }
      // Mimic real SSE fragments plus the transport's complete final text.
      for(let i=0;i<raw.length;i+=7)delta(raw.slice(i,i+7));return {text:raw};
    });
    const options=r.options(turn,undefined,{transport,onProtocolCorrection:correction}),result=await runLearningTurnV3(options);
    expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledExactlyOnceWith({attempt:1,errorCode:delivery==="incomplete"?"teaching-envelope-incomplete":"teaching-envelope-trailing-content"});
    expect(instructions[1]).toContain("FORMAT CORRECTION");expect(instructions[1]).not.toContain("BAD_SUFFIX_PRIVATE");expect(instructions[1]).not.toContain("MODEL_PROSE_MUST_NOT_SHOW");
    expect(result.text).toContain("这次计算正确");expect(result.text).not.toContain("MODEL_PROSE_MUST_NOT_SHOW");expect(r.shown.join("")).toBe(result.text);
    expect(r.stored()!.evidence).toHaveLength(1);expect(r.stored()!.help).toHaveLength(1);expect(r.stored()!.questions).toHaveLength(2);
    const snapshot=new Map(r.files);await runLearningTurnV3(r.options(turn,envelope({type:"answer",questionId:question.id})));expect(r.files).toEqual(snapshot);
  });
  it("does not splice failed ordinary prose or late first-transport bytes into a fresh parser",async()=>{
    const r=await rig(false),turn=await r.prepare("普通解释"),correction=vi.fn();let previous:((text:string)=>void)|undefined;
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{
      if(!previous){previous=delta;delta(JSON.stringify(envelope({type:"none"},"FAILED_REPLY","unrelated"))+"EXTRA");}
      previous!("LATE_INVALID_FIRST_RESPONSE");const text=JSON.stringify(envelope({type:"none"},"正确回复","unrelated"));delta(text);return {text};
    });
    const result=await runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}));
    expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledOnce();expect(result.text).toBe("正确回复");expect(r.shown.join("")).toBe("正确回复");expect(r.files.size).toBe(0);
  });
  it("stops after the second syntax failure without any command or evidence",async()=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),correction=vi.fn();
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{delta(JSON.stringify(envelope({type:"next",questionId:turn.active!.currentQuestionId}))+"}");return {text:""};});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).rejects.toThrow("trailing-content");
    expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledOnce();expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it.each(["teaching-envelope-trailing-content","HTTP 403 provider limit","HTTP 401 authentication failed","network-disconnected"])("does not mistake transport error %s for a locally proven parser failure",async message=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),correction=vi.fn();
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{delta('{"control":');throw new Error(message);});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).rejects.toThrow(message);
    expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();expect(r.files).toEqual(before);
  });
  it("preserves a distinct provider failure even when the callback also detected malformed bytes",async()=>{
    const r=await rig(),turn=await r.prepare(),correction=vi.fn();
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{try{delta("not JSON");}catch{}throw new Error("HTTP 403 provider limit");});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).rejects.toThrow("HTTP 403");
    expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();
  });
  it.each(["empty","whitespace"] as const)("does not spend a correction on %s output",async mode=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),correction=vi.fn();
    const transport=vi.fn(async()=>({text:mode==="empty"?"":"  \n  "})),pending=runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}));
    if(mode==="empty")expect((await pending).text).toContain("没有收到可显示的回复");else await expect(pending).rejects.toThrow("incomplete");
    expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();expect(r.files).toEqual(before);
  });
  it.each(["rejected-control","resource-limit"] as const)("never retries %s failures",async kind=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),correction=vi.fn();
    const raw=kind==="resource-limit"?" ".repeat(65_537):JSON.stringify(envelope({type:"answer",questionId:crypto.randomUUID()}));
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{delta(raw);return {text:raw};});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).rejects.toThrow(kind==="resource-limit"?"too-large":"control-rejected");
    expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();expect(r.files).toEqual(before);
  });
  it.each(["shown","consumer-failed"] as const)("never retries after prose has been offered to a %s presenter",async kind=>{
    const r=await rig(false),turn=await r.prepare("普通问题"),seen=barrier(),correction=vi.fn();
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{
      delta('{"control":{"action":{"type":"none"},"replyRelation":"unrelated"},"reply":"已经送到显示端');await seen.entered;
      delta('"}EXTRA');return {text:""};
    });
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction,present:()=>{
      void seen.wait();if(kind==="consumer-failed")throw new Error("presenter-unavailable");return true;
    }}))).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();expect(r.files.size).toBe(0);
  });
  it("drains in-flight help preparation and never retries when its write outcome was initially unknown",async()=>{
    const r=await rig(),turn=await r.prepare(),blocked=barrier(),write=r.io.compareWrite,primary=`${r.store.root}/${r.episode!.id}.json`,correction=vi.fn();let waited=false;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{if(p===primary&&!waited){waited=true;await blocked.wait();}return write(p,b,n);});
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{
      delta('{"control":{"action":{"type":"none"},"replyRelation":"current-question"},"reply":"与当前题相关的帮助');await blocked.entered;delta('"}EXTRA');return {text:""};
    });
    const pending=runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction})),rejected=expect(pending).rejects.toThrow("trailing-content");
    await blocked.entered;await Promise.resolve();expect(r.shown).toEqual([]);expect(correction).not.toHaveBeenCalled();blocked.release();await rejected;
    expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();expect(r.stored()!.help).toHaveLength(1);expect(r.stored()!.help[0]!.state).toBe("unknown");expect(r.stored()!.evidence).toEqual([]);
  });
  it.each(["cancel","source","new-turn"] as const)("rechecks %s before reserving a format correction",async kind=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),correction=vi.fn();let stale=false;
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{
      try{delta("not JSON");}catch(error){
        if(kind==="cancel")r.controller.abort();else if(kind==="source")stale=true;else await r.prepare("更新的请求");throw new Error((error as Error).message);
      }return {text:""};
    });
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction,ensureCurrent:async()=>{if(stale)throw new Error("source-revision-changed");}}))).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();expect(correction).not.toHaveBeenCalled();expect(r.files).toEqual(before);
  });
  it.each(["budget","cancel","source"] as const)("does not send the second call after the correction hook reports %s",async kind=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files);let stale=false;
    const transport=vi.fn(async(_i:string,delta:(text:string)=>void)=>{delta("not JSON");return {text:""};}),correction=vi.fn(async()=>{
      if(kind==="budget")throw new Error("model-call-budget-exhausted");if(kind==="cancel")r.controller.abort();if(kind==="source")stale=true;
    });
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction,ensureCurrent:async()=>{if(stale)throw new Error("source-revision-changed");}}))).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();expect(correction).toHaveBeenCalledOnce();expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });
  it.each(["missing-id","placeholder-id","relation"])("repairs pure schema %s once without inventing or applying the rejected action",async kind=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),questionId=turn.active!.currentQuestionId;
    const bad={control:{action:kind==="missing-id"?{type:"hint"}:{type:"hint",questionId:kind==="placeholder-id"?"host UUID":questionId},replyRelation:kind==="relation"?"current":"current-question"},reply:"PRIVATE_MALFORMED_REPLY"};
    const correction=vi.fn(),instructions:string[]=[];
    const transport=vi.fn(async(i:string,delta:(value:string)=>void)=>{
      instructions.push(i);expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
      const text=JSON.stringify(instructions.length===1?bad:envelope({type:"hint",questionId}));
      for(const char of text)delta(char);return {text};
    });
    const result=await runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}));
    expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledOnce();
    expect(instructions[1]).not.toContain("PRIVATE_MALFORMED_REPLY");expect(instructions[1]).toContain(questionId);
    expect(instructions[1]).toContain(kind==="relation"?"The rejected field is control.replyRelation":"The rejected field is control.action.questionId");
    expect(result.text).toBe(renderQuestionV3(turn.active!.questions[0]!).hint);
    expect(r.stored()!.help).toHaveLength(1);expect(r.stored()!.help[0]).toMatchObject({questionId,kind:"hint",state:"presented"});
    expect(r.stored()!.evidence).toEqual([]);expect(r.stored()!.currentQuestionId).toBe(questionId);
  });
  it("does not repair a second schema rejection or silently fill its missing ID",async()=>{
    const r=await rig(),turn=await r.prepare(),before=new Map(r.files),correction=vi.fn();
    const transport=vi.fn(async(_i:string,delta:(value:string)=>void)=>{delta('{"control":{"action":{"type":"hint"},"replyRelation":"current-question"},"reply":""}');return {text:""};});
    await expect(runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).rejects.toThrow("schema-question-id");
    expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledOnce();expect(r.files).toEqual(before);expect(r.shown).toEqual([]);
  });

  it.each(['{"text":"PRIVATE_MALFORMED_REPLY"}', '[]', 'null'])("corrects a non-string reply once with specific guidance: %s",async invalid=>{
    const r=await rig(false),turn=await r.prepare("普通问题"),correction=vi.fn(),instructions:string[]=[];
    const transport=vi.fn(async(i:string,delta:(value:string)=>void)=>{
      instructions.push(i);
      delta(instructions.length===1?'{"control":{"action":{"type":"none"},"replyRelation":"unrelated"},"reply":'+invalid+'}':JSON.stringify(envelope({type:"none"},"合法的回复。","unrelated")));
      return {text:""};
    });
    expect((await runLearningTurnV3(r.options(turn,undefined,{transport,onProtocolCorrection:correction}))).text).toBe("合法的回复。");
    expect(transport).toHaveBeenCalledTimes(2);expect(correction).toHaveBeenCalledExactlyOnceWith({attempt:1,errorCode:"teaching-reply-string-required"});
    expect(instructions[1]).toContain("It must be one JSON string");expect(instructions[1]).not.toContain("PRIVATE_MALFORMED_REPLY");
    expect(r.files.size).toBe(0);expect(r.shown.join("")).toBe("合法的回复。");
  });

  it("grades a complete natural limit statement after a hint without claiming independent completion",async()=>{
    const r=await rig(),hint=await r.prepare("给我一点提示"),qid=hint.active!.currentQuestionId;
    await runLearningTurnV3(r.options(hint,envelope({type:"hint",questionId:qid})));
    const turn=await r.prepare("极限是 9。"),result=await runLearningTurnV3(r.options(turn,envelope({type:"answer",questionId:qid})));
    expect(result.text).toContain("这次计算正确");expect(r.stored()!.evidence).toHaveLength(1);
    expect(r.stored()!.evidence[0]).toMatchObject({type:"answer",questionId:qid,outcome:"correct",independence:"helped",answer:{kind:"number",value:9}});
    expect(r.stored()!.currentQuestionId).not.toBe(qid);
  });

});
