import { describe, it, expect, vi } from "vitest";
import { LearningV3Store, conceptCriterion, questionRefV3, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import { canonicalMathAnswer } from "../src/learning-answer.js";
import { LearningCommandsV3, type LearningCommandBinding } from "../src/learning-commands-v3.js";
import { effectiveLearningV3 } from "../src/learning-effective-v3.js";

function rig() {
  const files=new Map<string,string>();
  const io={read:async(p:string)=>files.get(p)??null,list:async(p:string)=>[...files.keys()].filter(k=>k.startsWith(p+"/")),write:async(p:string,v:string)=>{files.set(p,v);},compareWrite:async(p:string,b:string|null,n:string)=>{if((files.get(p)??null)!==b)throw Error("conflict");files.set(p,n);}};
  const store=new LearningV3Store(io,"learning/v3/episodes"),authority=localLearnerAuthority(),source={path:"math.md",version:"v1"},conversationId=crypto.randomUUID();
  const service=new LearningCommandsV3(store,()=>new Date("2026-10-09T12:00:00Z"));
  const invitation=service.offer({authority,source,conversationId,concept:"value-limit",requestId:crypto.randomUUID()});
  const accept=()=>service.accept(invitation,{authority,source,conversationId,requestId:crypto.randomUUID()});
  const binding=(e:EpisodeV3,requestId:string=crypto.randomUUID()):LearningCommandBinding=>({authority,requestId,episodeId:e.id,questionId:e.currentQuestionId,expectedRevision:e.revision,source:{...e.source}});
  const value=(e:EpisodeV3)=>{const q=renderQuestionV3(e.questions.find(q=>q.id===e.currentQuestionId)!);return canonicalMathAnswer(q,q.answer)!;};
  return {files,io,store,authority,source,conversationId,service,invitation,accept,binding,value};
}
function barrier(){
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  return {entered,release,wait:async()=>{enter();await released;}};
}
describe("durable learning commands",()=>{
  it.each(["already-corrected","correction-event"] as const)("does not append a new correction to %s, while the exact prior command remains replayable",async kind=>{
    const r=rig(),accepted=await r.accept(),judged=await r.service.judgment(r.binding(accepted.episode),[{id:conceptCriterion[accepted.episode.concept],state:"uncertain"}],crypto.randomUUID());
    const binding=r.binding(judged.episode),original=judged.episode.evidence[0]!,corrected=await r.service.correct(binding,original.id),snapshot=new Map(r.files);
    const target=kind==="already-corrected"?original:corrected.episode.evidence.at(-1)!;
    await expect(r.service.correct({...r.binding(corrected.episode),questionId:target.questionId},target.id)).rejects.toThrow("evidence-unavailable");expect(r.files).toEqual(snapshot);
    expect((await r.service.correct(binding,original.id)).replayed).toBe(true);expect(r.files).toEqual(snapshot);
  });
  it("does not persist an invitation; simultaneous consent requests consume one exact episode and question",async()=>{
    const r=rig();expect(r.files.size).toBe(0);
    const [a,b]=await Promise.all([r.accept(),r.accept()]);
    expect(a.replayed).toBe(false);expect(b.replayed).toBe(true);expect(a.episode.id).toBe(b.episode.id);
    expect(a.episode.currentQuestionId).toBe(r.invitation.questionId);
    expect((await r.store.list())).toHaveLength(1);
    expect(a.episode.consent.invitationId).toBe(r.invitation.id);
  });
  it("rejects fabricated, expired or differently scoped acceptance without a record",async()=>{
    const r=rig(),input={authority:r.authority,source:r.source,conversationId:r.conversationId,requestId:crypto.randomUUID()};
    await expect(r.service.accept({...r.invitation},input)).rejects.toThrow("expired");
    await expect(r.service.accept(r.invitation,{...input,source:{path:"other.md",version:"v1"}})).rejects.toThrow("expired");
    expect(()=>r.service.accept(r.invitation,{...input,authority:JSON.parse("{}")})).toThrow("local-learner-required");
    r.service.expire(r.invitation);await expect(r.service.accept(r.invitation,input)).rejects.toThrow("expired");expect(r.files.size).toBe(0);
  });
  it("does not restore a deleted learning event by reusing its old consent",async()=>{
    const r=rig(),accepted=await r.accept();await r.store.remove(accepted.episode.id);
    await expect(r.accept()).rejects.toThrow("deleted");expect(await r.store.list()).toEqual([]);
  });
  it("persists answer before its feedback help, then keeps future attempts helped or unknown",async()=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),presentationId=crypto.randomUUID();
    const first=await r.service.answer(binding,r.value(accepted.episode),presentationId);
    expect(first.episode.evidence[0]).toMatchObject({sequence:1,independence:"no-plugin-help"});
    expect(first.episode.help[0]).toMatchObject({sequence:2,state:"prepared"});
    const read=await r.store.readEffectiveResult();
    expect(effectiveLearningV3(read.records[0]!,read.protectionByEpisode.get(first.episode.id)).progressAnswers).toHaveLength(1);
    const second=await r.service.answer(r.binding(first.episode),r.value(first.episode),crypto.randomUUID());
    expect(second.episode.evidence[1]).toMatchObject({sequence:3,independence:"unknown"});
    const replay=await r.service.answer(binding,r.value(first.episode),presentationId);
    expect(replay.replayed).toBe(true);expect(replay.episode.evidence).toHaveLength(2);
    await expect(r.service.answer(binding,{kind:"number",value:999},presentationId)).rejects.toThrow("replay-conflict");
  });
  it("allows unknown presentation to become provided without erasing prepared help or replaying text",async()=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),presentationId=crypto.randomUUID();
    const prepared=await r.service.prepareHelp(binding,"hint",presentationId);
    const ticket=r.service.ticket(prepared,presentationId,binding.requestId);
    const unknown=await r.service.confirmHelp(ticket,r.authority,"unknown");expect(unknown.episode.help[0]?.state).toBe("unknown");
    const shown=await r.service.confirmHelp(ticket,r.authority,"presented");expect(shown.episode.help[0]?.state).toBe("presented");
    expect((await r.service.confirmHelp(ticket,r.authority,"unknown")).episode.help[0]?.state).toBe("presented");
    const answer=await r.service.answer(r.binding(shown.episode),r.value(shown.episode),crypto.randomUUID());
    expect(answer.episode.evidence[0]).toMatchObject({independence:"helped"});
  });
  it("does not let a cancelled command or concurrent source revision change mutate evidence",async()=>{
    const r=rig(),accepted=await r.accept(),signal=AbortSignal.abort();
    await expect(r.service.prepareHelp(r.binding(accepted.episode),"solution",crypto.randomUUID(),signal)).rejects.toMatchObject({name:"AbortError"});
    await expect(r.service.answer({...r.binding(accepted.episode),source:{path:"other.md",version:"v1"}},r.value(accepted.episode),crypto.randomUUID())).rejects.toThrow("source-changed");
    const paused=await r.service.pause(r.binding(accepted.episode));
    await expect(r.service.prepareHelp(r.binding(accepted.episode),"hint",crypto.randomUUID())).rejects.toThrow("revision-conflict");
    expect(paused.episode.evidence).toEqual([]);expect(paused.episode.help).toEqual([]);
  });
  it("consumes the exact due task once across different resume requests and a reopened service",async()=>{
    const r=rig(),accepted=await r.accept(),taskId=crypto.randomUUID();
    accepted.episode.status="completed";
    accepted.episode.reviewTasks.push({id:taskId,dueAt:"2026-10-08T12:00:00Z",localDate:"2026-10-08",step:0,state:"scheduled",dependsOn:[]});
    const stored=await r.store.save(accepted.episode),one=r.binding(stored),two=r.binding(stored);
    const [a,b]=await Promise.all([r.service.resume(one,undefined,taskId),r.service.resume(two,undefined,taskId)]);
    expect(a.episode.questions).toHaveLength(2);expect(b.episode.questions).toHaveLength(2);
    expect(a.episode.currentQuestionId).toBe(b.episode.currentQuestionId);
    expect(b.episode.questions[1]?.pool).toBe("delayed");expect(b.episode.reviewTasks[0]?.consumedBy).toBe(a.phaseId);
    const reopened=new LearningCommandsV3(new LearningV3Store(r.io,r.store.root),()=>new Date("2026-10-10T00:00:00+14:00"));
    const resumed=await reopened.resume(r.binding(b.episode),undefined,taskId);
    expect(resumed.episode.currentQuestionId).toBe(a.episode.currentQuestionId);expect(resumed.episode.questions).toHaveLength(2);
  });
  it("does not consume a future review or merge a stale ordinary resume",async()=>{
    const r=rig(),accepted=await r.accept(),taskId=crypto.randomUUID();accepted.episode.status="completed";
    accepted.episode.reviewTasks.push({id:taskId,dueAt:"2026-10-12T12:00:00Z",localDate:"2026-10-12",step:0,state:"scheduled",dependsOn:[]});
    const e=await r.store.save(accepted.episode),later=await r.service.resume(r.binding(e),undefined,taskId);
    expect(later.episode.questions).toHaveLength(1);expect(later.episode.status).toBe("completed");
    await expect(r.service.resume(r.binding(e))).rejects.toThrow("revision-conflict");
  });
  it("captures acceptance source and consent request before awaiting storage",async()=>{
    const r=rig(),blocked=barrier(),list=r.store.readEffectiveResult.bind(r.store);
    vi.spyOn(r.store,"readEffectiveResult").mockImplementationOnce(async()=>{await blocked.wait();return list();});
    const requestId=crypto.randomUUID(),input={authority:r.authority,requestId,conversationId:r.conversationId,source:{...r.source}};
    const pending=r.service.accept(r.invitation,input);await blocked.entered;
    input.requestId=crypto.randomUUID();input.conversationId=crypto.randomUUID();input.source.path="other.md";input.source.version="v2";
    blocked.release();const result=await pending;
    expect(result.phaseId).toBe(requestId);expect(result.episode.source).toEqual(r.source);
    expect(result.episode.consent).toMatchObject({requestId,conversationId:r.conversationId});
  });
  it("captures the answer and target before receipts are hashed or asynchronous reads resume",async()=>{
    const r=rig(),accepted=await r.accept(),blocked=barrier(),read=r.store.readEffectiveResult.bind(r.store);
    vi.spyOn(r.store,"readEffectiveResult").mockImplementationOnce(async()=>{await blocked.wait();return read();});
    const binding=r.binding(accepted.episode),original={...binding,source:{...binding.source}},answer=r.value(accepted.episode),originalAnswer={...answer},presentationId=crypto.randomUUID();
    const pending=r.service.answer(binding,answer,presentationId);await blocked.entered;
    binding.questionId=crypto.randomUUID();binding.episodeId=crypto.randomUUID();binding.requestId=crypto.randomUUID();binding.expectedRevision=99;binding.source.path="other.md";
    if(answer.kind==="number")answer.value=999;else answer.index=(answer.index+1)%8;
    blocked.release();const result=await pending;
    expect(result.episode.id).toBe(original.episodeId);
    expect(result.episode.evidence[0]).toMatchObject({questionId:original.questionId,answer:originalAnswer,outcome:"correct"});
    const replay=await r.service.answer(original,originalAnswer,presentationId);expect(replay.replayed).toBe(true);
    await expect(r.service.answer(original,answer,presentationId)).rejects.toThrow("replay-conflict");
  });
  it.each(["prepareHelp","correct","pause","resume"] as const)("captures caller-owned bindings for %s before queuing",async command=>{
    const r=rig(),accepted=await r.accept();
    const before=command==="correct"?await r.service.answer(r.binding(accepted.episode),r.value(accepted.episode),crypto.randomUUID()):accepted;
    const binding=r.binding(before.episode),requestId=binding.requestId,questionId=binding.questionId;
    const pending=command==="prepareHelp"?r.service.prepareHelp(binding,"hint",crypto.randomUUID()):command==="correct"?r.service.correct(binding,before.episode.evidence[0]!.id):command==="pause"?r.service.pause(binding):r.service.resume(binding);
    binding.questionId=crypto.randomUUID();binding.episodeId=crypto.randomUUID();binding.requestId=crypto.randomUUID();binding.expectedRevision=999;binding.source.path="other.md";
    const result=await pending;
    expect(result.episode.id).toBe(before.episode.id);expect(result.episode.currentQuestionId).toBe(questionId);
    expect(result.episode.revision).toBe(before.episode.revision+1);
    const replayBinding=r.binding(before.episode,requestId);
    const replay=command==="prepareHelp"?undefined:command==="correct"?await r.service.correct(replayBinding,before.episode.evidence[0]!.id):command==="pause"?await r.service.pause(replayBinding):await r.service.resume(replayBinding);
    if(replay)expect(replay.replayed).toBe(true);
  });
  it("captures confirmation tickets while retaining presented-after-unknown monotonicity",async()=>{
    const r=rig(),accepted=await r.accept(),presentationId=crypto.randomUUID(),binding=r.binding(accepted.episode);
    const prepared=await r.service.prepareHelp(binding,"hint",presentationId),ticket=r.service.ticket(prepared,presentationId,binding.requestId),original={...ticket,source:{...ticket.source}};
    const blocked=barrier(),read=r.store.readEffectiveResult.bind(r.store);
    vi.spyOn(r.store,"readEffectiveResult").mockImplementationOnce(async()=>{await blocked.wait();return read();});
    const pending=r.service.confirmHelp(ticket,r.authority,"presented");await blocked.entered;
    ticket.helpId=crypto.randomUUID();ticket.presentationId=crypto.randomUUID();ticket.questionId=crypto.randomUUID();ticket.source.path="other.md";
    blocked.release();const shown=await pending;expect(shown.episode.help[0]?.state).toBe("presented");
    const unknown=await r.service.confirmHelp(original,r.authority,"unknown");expect(unknown.episode.help[0]?.state).toBe("presented");
    expect((await r.service.confirmHelp(original,r.authority,"unknown")).replayed).toBe(true);
  });
  it("expires acceptance while the initial record read is in flight",async()=>{
    const r=rig(),blocked=barrier(),list=r.store.readEffectiveResult.bind(r.store);
    vi.spyOn(r.store,"readEffectiveResult").mockImplementationOnce(async()=>{await blocked.wait();return list();});
    const pending=r.accept(),rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});
    await blocked.entered;r.service.expire(r.invitation);blocked.release();await rejected;
    expect(r.files.size).toBe(0);await expect(r.accept()).rejects.toThrow("expired");
  });
  it("expires acceptance after protection is saved but before the episode is committed",async()=>{
    const r=rig(),blocked=barrier(),write=r.io.compareWrite,protection=r.store.protection.path(r.invitation.episodeId);
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{await write(p,b,n);if(p===protection)await blocked.wait();});
    const pending=r.accept(),rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});
    await blocked.entered;r.service.expire(r.invitation);blocked.release();await rejected;
    expect(r.files.has(protection)).toBe(true);expect(await r.store.list()).toEqual([]);
    expect(r.files.has(`${r.store.root}/${r.invitation.episodeId}.json`)).toBe(false);
    await expect(r.accept()).rejects.toThrow("expired");
  });
  it("expires acceptance during the final pre-commit tombstone read",async()=>{
    const r=rig(),blocked=barrier(),read=r.io.read,primary=`${r.store.root}/${r.invitation.episodeId}.json`;let tombstoneReads=0;
    vi.spyOn(r.io,"read").mockImplementation(async p=>{if(p===primary+".deleted"&&++tombstoneReads===2)await blocked.wait();return read(p);});
    const pending=r.accept(),rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});
    await blocked.entered;r.service.expire(r.invitation);blocked.release();await rejected;
    expect(r.files.has(primary)).toBe(false);expect(await r.store.list()).toEqual([]);
  });
  it.each(["expiry","caller"] as const)("reports an episode already saved when %s cancellation arrives during CAS completion",async cancellation=>{
    const r=rig(),blocked=barrier(),write=r.io.compareWrite,primary=`${r.store.root}/${r.invitation.episodeId}.json`,controller=new AbortController(),requestId=crypto.randomUUID();
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{await write(p,b,n);if(p===primary)await blocked.wait();});
    const pending=r.service.accept(r.invitation,{authority:r.authority,requestId,conversationId:r.conversationId,source:r.source},controller.signal);
    await blocked.entered;expect(r.files.has(primary)).toBe(true);
    if(cancellation==="expiry")r.service.expire(r.invitation);else controller.abort();
    blocked.release();const result=await pending;
    expect(result.replayed).toBe(false);expect(result.phaseId).toBe(requestId);expect(result.episode.revision).toBe(1);
    const replay=await r.accept();expect(replay.replayed).toBe(true);expect(replay.phaseId).toBe(requestId);expect(replay.episode.revision).toBe(1);
  });
  it("does not consume consent on a primary save failure, and retries the same preallocated question",async()=>{
    const r=rig(),write=r.io.compareWrite,primary=`${r.store.root}/${r.invitation.episodeId}.json`;let fail=true;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{if(p===primary&&fail){fail=false;throw new Error("injected-save-failure");}await write(p,b,n);});
    await expect(r.accept()).rejects.toThrow("injected-save-failure");expect(r.files.has(primary)).toBe(false);
    const result=await r.accept();expect(result.replayed).toBe(false);expect(result.episode.currentQuestionId).toBe(r.invitation.questionId);
    expect(result.episode.questions).toHaveLength(1);expect(await r.store.list()).toHaveLength(1);
  });
  it("caller cancellation before saving leaves the invitation available for a later acceptance",async()=>{
    const r=rig();
    await expect(r.service.accept(r.invitation,{authority:r.authority,requestId:crypto.randomUUID(),conversationId:r.conversationId,source:r.source},AbortSignal.abort())).rejects.toMatchObject({name:"AbortError"});
    expect(r.files.size).toBe(0);expect((await r.accept()).replayed).toBe(false);
  });
  it("cannot pause a different current question through an old question binding with a fresh revision",async()=>{
    const r=rig(),accepted=await r.accept(),oldQuestion=accepted.episode.currentQuestionId,question=questionRefV3(accepted.episode.concept,"transfer",1);
    accepted.episode.questions.push(question);accepted.episode.currentQuestionId=question.id;
    const current=await r.store.save(accepted.episode);
    await expect(r.service.pause({...r.binding(current),questionId:oldQuestion})).rejects.toThrow("question-inactive");
    const stored=(await r.store.list())[0]!;expect(stored.status).toBe("active");expect(stored.revision).toBe(current.revision);
    expect(stored.currentQuestionId).toBe(question.id);
  });
  it("cannot turn a completed episode into a resumable paused episode",async()=>{
    const r=rig(),accepted=await r.accept();accepted.episode.status="completed";const completed=await r.store.save(accepted.episode);
    await expect(r.service.pause(r.binding(completed))).rejects.toThrow("question-inactive");
    const resumed=await r.service.resume(r.binding(completed));expect(resumed.episode.status).toBe("completed");
    expect(resumed.episode.questions).toHaveLength(1);
  });
  it("replays a committed pause honestly after cancellation and preserves revision checks for a new pause",async()=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),paused=await r.service.pause(binding);
    const replay=await r.service.pause(binding,AbortSignal.abort());expect(replay.replayed).toBe(true);expect(replay.episode.revision).toBe(paused.episode.revision);
    await expect(r.service.pause(r.binding(accepted.episode))).rejects.toThrow("revision-conflict");
    expect((await r.service.pause(r.binding(paused.episode))).episode.status).toBe("paused");
  });
  it.each([
    {criteria:"untrusted free-form judgment"},
    {criteria:[{id:"point-versus-limit",state:"supported",text:"untrusted private explanation"}]},
    {criteria:[{id:"point-versus-limit",state:"correct"}]},
    {criteria:[{id:"continuity-conditions",state:"supported"}]},
  ])("rejects unsupported judgment criteria without creating or changing any file: %#",async({criteria})=>{
    const r=rig(),accepted=await r.accept(),before=new Map(r.files);
    await expect(r.service.judgment(r.binding(accepted.episode),criteria as Parameters<LearningCommandsV3["judgment"]>[1],crypto.randomUUID())).rejects.toThrow();
    expect(r.files).toEqual(before);
    const stored=(await r.store.list())[0]!;expect(stored.evidence).toEqual([]);expect(stored.help).toEqual([]);expect(stored.revision).toBe(accepted.episode.revision);
  });
  it("persists only bounded tutor judgment criteria, never objective correctness or progress",async()=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),presentationId=crypto.randomUUID();
    const criteria:Parameters<LearningCommandsV3["judgment"]>[1]=[{id:conceptCriterion[accepted.episode.concept],state:"supported"}];
    const pending=r.service.judgment(binding,criteria,presentationId);criteria[0]!.state="needs-review";
    const result=await pending,evidence=result.episode.evidence[0]!;
    expect(evidence).toMatchObject({type:"judgment",evaluator:"tutor",outcome:"unreviewed",criteria:[{id:"point-versus-limit",state:"supported"}]});
    expect(evidence).not.toHaveProperty("answer");expect(evidence).not.toHaveProperty("independence");
    expect(result.episode.help[0]).toMatchObject({kind:"related-discussion",state:"prepared",sequence:2});
    const read=await r.store.readEffectiveResult(),effective=effectiveLearningV3(read.records[0]!,read.protectionByEpisode.get(result.episode.id));
    expect(effective.judgments).toHaveLength(1);expect(effective.answers).toEqual([]);expect(effective.progressAnswers).toEqual([]);
    expect(result.episode.questions).toHaveLength(1);expect(result.episode.reviewTasks).toEqual([]);
    const replay=await r.service.judgment(binding,[{id:"point-versus-limit",state:"supported"}],presentationId);
    expect(replay.replayed).toBe(true);expect(replay.episode.evidence).toHaveLength(1);
    await expect(r.service.judgment(binding,criteria,presentationId)).rejects.toThrow("replay-conflict");
  });
  it("allocates one legal unseen question for simultaneous replayed next requests",async()=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),original=renderQuestionV3(accepted.episode.questions[0]!);
    const [first,replay]=await Promise.all([r.service.next(binding),r.service.next(binding)]);
    expect(first.replayed).toBe(false);expect(replay.replayed).toBe(true);expect(replay.episode).toEqual(first.episode);
    expect(first.episode.questions).toHaveLength(2);expect(first.episode.revision).toBe(accepted.episode.revision+1);
    const ref=first.episode.questions[1]!,question=renderQuestionV3(ref);
    expect(ref.pool).toBe("practice");expect(ref.concept).toBe(accepted.episode.concept);expect(ref.id).toBe(first.episode.currentQuestionId);
    expect(question.prompt).not.toBe(original.prompt);expect(canonicalMathAnswer(question,question.answer)).toBeDefined();
    await expect(r.service.next(r.binding(accepted.episode))).rejects.toThrow("revision-conflict");
    await expect(r.service.next({...r.binding(first.episode),questionId:accepted.episode.currentQuestionId})).rejects.toThrow("question-inactive");
    expect((await r.store.list())[0]!.questions).toHaveLength(2);
  });
  it("does not reuse an orphan question protected by a failed next commit",async()=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),primary=`${r.store.root}/${accepted.episode.id}.json`,before=r.files.get(primary),write=r.io.compareWrite;
    let failedQuestion:EpisodeV3["questions"][number]|undefined;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{
      if(p===primary&&!failedQuestion){failedQuestion=(JSON.parse(n) as EpisodeV3).questions.at(-1);throw new Error("injected-next-failure");}
      await write(p,b,n);
    });
    await expect(r.service.next(binding)).rejects.toThrow("injected-next-failure");expect(r.files.get(primary)).toBe(before);
    expect((await r.store.protection.read(accepted.episode.id)).questions.has(failedQuestion!.id)).toBe(true);
    const retried=await r.service.next(binding),question=retried.episode.questions.at(-1)!;
    expect(retried.replayed).toBe(false);expect(retried.episode.questions).toHaveLength(2);
    expect(question.id).not.toBe(failedQuestion!.id);expect(renderQuestionV3(question).prompt).not.toBe(renderQuestionV3(failedQuestion!).prompt);
  });
  it("replaces the old scheduled review once and never restores a corrected prerequisite",async()=>{
    const r=rig(),accepted=await r.accept(),answered=await r.service.answer(r.binding(accepted.episode),r.value(accepted.episode),crypto.randomUUID());
    const first=await r.service.schedule(r.binding(answered.episode),1),oldTask=first.episode.reviewTasks[0]!,binding=r.binding(first.episode);
    const second=await r.service.schedule(binding,3),newTask=second.episode.reviewTasks[1]!;
    expect(second.episode.reviewTasks[0]).toMatchObject({id:oldTask.id,state:"invalidated"});
    expect(newTask).toMatchObject({state:"scheduled",dependsOn:[answered.episode.evidence[0]!.id],dueAt:"2026-10-12T12:00:00.000Z"});
    const replay=await r.service.schedule(binding,3);expect(replay.replayed).toBe(true);expect(replay.episode.reviewTasks).toHaveLength(2);
    await expect(r.service.schedule(binding,7)).rejects.toThrow("replay-conflict");
    const corrected=await r.service.correct(r.binding(second.episode),answered.episode.evidence[0]!.id);
    expect(corrected.episode.reviewTasks.every(t=>t.state==="invalidated")).toBe(true);
    const scheduled=await r.service.schedule(r.binding(corrected.episode),7),fresh=scheduled.episode.reviewTasks.at(-1)!;
    expect(fresh).toMatchObject({state:"scheduled",dependsOn:[]});expect(scheduled.episode.reviewTasks.slice(0,-1).every(t=>t.state==="invalidated")).toBe(true);
    expect(effectiveLearningV3(scheduled.episode).reviewTasks.filter(t=>t.state==="scheduled").map(t=>t.id)).toEqual([fresh.id]);
  });
  it.each([false,true])("does not attach a new schedule to revoked downstream evidence, with independent continuation=%s",async continueIndependently=>{
    const r=rig(),accepted=await r.accept(),firstAnswer=await r.service.answer(r.binding(accepted.episode),r.value(accepted.episode),crypto.randomUUID());
    const scheduled=await r.service.schedule(r.binding(firstAnswer.episode),1),task=scheduled.episode.reviewTasks[0]!;
    task.dueAt="2026-10-08T12:00:00.000Z";task.localDate="2026-10-08";
    const due=await r.store.save(scheduled.episode),review=await r.service.resume(r.binding(due),undefined,task.id);
    const laterAnswer=await r.service.answer(r.binding(review.episode),r.value(review.episode),crypto.randomUUID());
    const corrected=await r.service.correct({...r.binding(laterAnswer.episode),questionId:firstAnswer.episode.currentQuestionId},firstAnswer.episode.evidence[0]!.id);
    const effective=effectiveLearningV3(corrected.episode);
    expect(effective.dependentEvidenceIds.has(laterAnswer.episode.evidence[1]!.id)).toBe(true);
    let current=corrected.episode;const expectedDependencies:string[]=[];
    if(continueIndependently){const next=await r.service.next(r.binding(current));const answer=await r.service.answer(r.binding(next.episode),r.value(next.episode),crypto.randomUUID());current=answer.episode;expectedDependencies.push(current.evidence.at(-1)!.id);}
    const replaced=await r.service.schedule(r.binding(current),3),fresh=replaced.episode.reviewTasks.at(-1)!;
    expect(fresh.dependsOn).toEqual(expectedDependencies);
    const projection=effectiveLearningV3(replaced.episode,await r.store.protection.read(replaced.episode.id));
    expect(projection.reviewTasks.find(t=>t.id===fresh.id)?.state).toBe("scheduled");
    expect(replaced.episode.evidence).toContainEqual(laterAnswer.episode.evidence[1]!);
    expect(projection.answers.find(a=>a.id===laterAnswer.episode.evidence[1]!.id)?.independence).toBe("no-plugin-help");
  });
  it("keeps the deletion tombstone authoritative against queued and reopened late help",async()=>{
    const r=rig(),accepted=await r.accept(),presentationId=crypto.randomUUID(),binding=r.binding(accepted.episode);
    const prepared=await r.service.prepareHelp(binding,"hint",presentationId),ticket=r.service.ticket(prepared,presentationId,binding.requestId);
    const forgetting=r.service.forget(r.binding(prepared.episode));
    const late=r.service.confirmHelp(ticket,r.authority,"presented"),rejected=expect(late).rejects.toThrow("target-unavailable");
    const forgotten=await forgetting;await rejected;
    const primary=`${r.store.root}/${prepared.episode.id}.json`,snapshot=new Map(r.files);
    expect(r.files.has(primary+".deleted")).toBe(true);expect(forgotten.episode).toMatchObject({status:"deleted",evidence:[],help:[],reviewTasks:[],links:[]});
    expect(await r.store.list()).toEqual([]);
    await expect(r.service.prepareHelp(r.binding(forgotten.episode),"solution",crypto.randomUUID())).rejects.toThrow("target-unavailable");
    const reopened=new LearningCommandsV3(new LearningV3Store(r.io,r.store.root));
    await expect(reopened.confirmHelp(ticket,r.authority,"unknown")).rejects.toThrow("target-unavailable");
    expect(r.files).toEqual(snapshot);expect(await reopened.store.list()).toEqual([]);
  });
  it.each([{minutes:20,status:"active"},{minutes:5,status:"paused"}])("commits answer, feedback and transfer question in one CAS with $minutes minutes remaining",async({minutes,status})=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),answer=r.value(accepted.episode),presentationId=crypto.randomUUID(),progress={remainingMinutes:minutes};
    const primary=`${r.store.root}/${accepted.episode.id}.json`,before=r.files.get(primary),write=r.io.compareWrite,commits:EpisodeV3[]=[];
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{
      if(p===primary){expect(r.files.get(primary)).toBe(before);const proposed=JSON.parse(n) as EpisodeV3;expect(proposed.evidence).toHaveLength(1);expect(proposed.help).toHaveLength(1);expect(proposed.questions).toHaveLength(2);commits.push(proposed);}
      await write(p,b,n);
    });
    const pending=r.service.answer(binding,answer,presentationId,undefined,progress);progress.remainingMinutes=minutes===20?0:20;
    const result=await pending;expect(commits).toHaveLength(1);expect(result.episode).toEqual(commits[0]);
    expect(result.episode.revision).toBe(accepted.episode.revision+1);expect(result.episode.status).toBe(status);
    expect(result.episode.evidence[0]).toMatchObject({type:"answer",questionId:accepted.episode.currentQuestionId,outcome:"correct",independence:"no-plugin-help"});
    expect(result.episode.help[0]).toMatchObject({questionId:accepted.episode.currentQuestionId,state:"prepared",sequence:2});
    expect(result.episode.questions[1]).toMatchObject({id:result.episode.currentQuestionId,pool:"transfer"});
    expect(renderQuestionV3(result.episode.questions[1]!).prompt).not.toBe(renderQuestionV3(result.episode.questions[0]!).prompt);
    const replay=await r.service.answer(binding,answer,presentationId,undefined,{remainingMinutes:minutes});
    expect(replay.replayed).toBe(true);expect(commits).toHaveLength(1);expect(replay.episode.questions).toHaveLength(2);
    await expect(r.service.answer(binding,answer,presentationId,undefined,progress)).rejects.toThrow("replay-conflict");
  });
  it("keeps a failed progressing answer out of the episode and retries without partial or duplicate evidence",async()=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),answer=r.value(accepted.episode),presentationId=crypto.randomUUID();
    const primary=`${r.store.root}/${accepted.episode.id}.json`,before=r.files.get(primary),write=r.io.compareWrite;let failedQuestion:EpisodeV3["questions"][number]|undefined;
    vi.spyOn(r.io,"compareWrite").mockImplementation(async(p,b,n)=>{
      if(p===primary&&!failedQuestion){const proposed=JSON.parse(n) as EpisodeV3;expect(proposed.evidence).toHaveLength(1);expect(proposed.help).toHaveLength(1);failedQuestion=proposed.questions.at(-1);throw new Error("injected-progress-failure");}
      await write(p,b,n);
    });
    await expect(r.service.answer(binding,answer,presentationId,undefined,{remainingMinutes:20})).rejects.toThrow("injected-progress-failure");
    expect(r.files.get(primary)).toBe(before);const unchanged=(await r.store.list())[0]!;
    expect(unchanged.evidence).toEqual([]);expect(unchanged.help).toEqual([]);expect(unchanged.questions).toHaveLength(1);
    const retried=await r.service.answer(binding,answer,presentationId,undefined,{remainingMinutes:20});
    expect(retried.replayed).toBe(false);expect(retried.episode.evidence).toHaveLength(1);expect(retried.episode.help).toHaveLength(1);expect(retried.episode.questions).toHaveLength(2);
    // The failed attempt reserved feedback from sequence 2 onward; its same
    // request's sequence-1 answer still precedes any prepared feedback.
    expect(retried.episode.evidence[0]).toMatchObject({independence:"no-plugin-help"});
    expect(renderQuestionV3(retried.episode.questions[1]!).prompt).not.toBe(renderQuestionV3(failedQuestion!).prompt);
  });
  it.each(["drawing","expert"] as const)("attaches one bounded %s artifact idempotently without creating answer evidence",async kind=>{
    const r=rig(),accepted=await r.accept(),binding=r.binding(accepted.episode),link={kind,taskId:crypto.randomUUID(),targetId:"surface:current",evidenceIds:[]};
    const first=await r.service.attachArtifact(binding,link),snapshot=new Map(r.files),replay=await r.service.attachArtifact(binding,link);
    expect(first.episode.links).toEqual([{...link,questionId:accepted.episode.currentQuestionId,at:"2026-10-09T12:00:00.000Z",state:"current"}]);
    expect(first.episode.evidence).toEqual([]);expect(first.episode.help).toEqual([]);expect(replay.replayed).toBe(true);expect(r.files).toEqual(snapshot);
    await expect(r.service.attachArtifact(binding,{...link,targetId:"surface:other"})).rejects.toThrow("replay-conflict");
  });
  it("captures artifact metadata and evidence ID arrays before the command queue runs",async()=>{
    const r=rig(),accepted=await r.accept(),answered=await r.service.answer(r.binding(accepted.episode),r.value(accepted.episode),crypto.randomUUID());
    const binding=r.binding(answered.episode),link={kind:"expert" as const,taskId:crypto.randomUUID(),targetId:"expert:task",evidenceIds:[answered.episode.evidence[0]!.id]},original={...link,evidenceIds:[...link.evidenceIds]};
    const pending=r.service.attachArtifact(binding,link);link.evidenceIds.push(crypto.randomUUID());link.targetId="injected:target";binding.questionId=crypto.randomUUID();binding.source.path="other.md";
    const result=await pending;expect(result.episode.links[0]).toMatchObject(original);expect(result.episode.evidence).toHaveLength(1);
  });
  it("rejects artifact links depending on corrected evidence without writing a link",async()=>{
    const r=rig(),accepted=await r.accept(),answered=await r.service.answer(r.binding(accepted.episode),r.value(accepted.episode),crypto.randomUUID());
    const evidenceId=answered.episode.evidence[0]!.id,corrected=await r.service.correct(r.binding(answered.episode),evidenceId),snapshot=new Map(r.files);
    await expect(r.service.attachArtifact(r.binding(corrected.episode),{kind:"expert",taskId:crypto.randomUUID(),targetId:"expert:task",evidenceIds:[evidenceId]})).rejects.toThrow("artifact-evidence-invalid");
    expect(r.files).toEqual(snapshot);expect((await r.store.list())[0]!.links).toEqual([]);
  });
  it("rejects an artifact dependency on downstream evidence invalidated by a corrected prerequisite",async()=>{
    const r=rig(),accepted=await r.accept(),first=await r.service.answer(r.binding(accepted.episode),r.value(accepted.episode),crypto.randomUUID());
    const scheduled=await r.service.schedule(r.binding(first.episode),1),task=scheduled.episode.reviewTasks[0]!;task.dueAt="2026-10-08T12:00:00.000Z";task.localDate="2026-10-08";
    const due=await r.store.save(scheduled.episode),review=await r.service.resume(r.binding(due),undefined,task.id),answered=await r.service.answer(r.binding(review.episode),r.value(review.episode),crypto.randomUUID());
    const corrected=await r.service.correct({...r.binding(answered.episode),questionId:first.episode.currentQuestionId},first.episode.evidence[0]!.id),snapshot=new Map(r.files);
    await expect(r.service.attachArtifact(r.binding(corrected.episode),{kind:"drawing",taskId:crypto.randomUUID(),targetId:"surface:target",evidenceIds:[answered.episode.evidence[1]!.id]})).rejects.toThrow("artifact-evidence-invalid");
    expect(r.files).toEqual(snapshot);
  });
  it("rejects an artifact for an old question despite a fresh episode revision",async()=>{
    const r=rig(),accepted=await r.accept(),next=await r.service.next(r.binding(accepted.episode)),snapshot=new Map(r.files);
    await expect(r.service.attachArtifact({...r.binding(next.episode),questionId:accepted.episode.currentQuestionId},{kind:"drawing",taskId:crypto.randomUUID(),targetId:"surface:target",evidenceIds:[]})).rejects.toThrow("question-inactive");
    expect(r.files).toEqual(snapshot);
  });
  it("does not persist artifact prose or accept a link after deletion",async()=>{
    const r=rig(),accepted=await r.accept(),link={kind:"drawing" as const,taskId:crypto.randomUUID(),targetId:"surface:target",evidenceIds:[]},snapshot=new Map(r.files);
    expect(()=>r.service.attachArtifact(r.binding(accepted.episode),{...link,summary:"PRIVATE_ARTIFACT_TEXT"} as typeof link)).toThrow();expect(r.files).toEqual(snapshot);
    const forgotten=await r.service.forget(r.binding(accepted.episode)),deleted=new Map(r.files);
    await expect(r.service.attachArtifact(r.binding(forgotten.episode),link)).rejects.toThrow("target-unavailable");expect(r.files).toEqual(deleted);
  });
});
