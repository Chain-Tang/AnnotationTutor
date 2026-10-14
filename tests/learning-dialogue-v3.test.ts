import { describe, expect, it, vi } from "vitest";
import { LearningDialogueV3, type DialogueInputV3 } from "../src/learning-dialogue-v3.js";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { LearningV3Store, conceptCriterion, questionRefV3, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { parseLearningControlV3, validateLearningBinding, localLearnerAuthority, type LearningActionV3, type LearningTurnIdentity } from "../src/learning-control-v3.js";
import { canonicalMathAnswer } from "../src/learning-answer.js";
import { buildApiMessages } from "../src/chat-prompt.js";
import { createEpisode } from "../src/learning-episode.js";
import { createEpisodeV2 } from "../src/learning-v2.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import { completeRecordReadResult } from "../src/learning-record-read.js";
const envelope=(action:LearningActionV3)=>({control:{action,replyRelation:"unrelated" as const},reply:""});
function rig(){
  const files=new Map<string,string>();let fail=false;
  const io={read:async(path:string)=>files.get(path)??null,list:async(path:string)=>[...files.keys()].filter(key=>key.startsWith(path+"/")),write:async(path:string,raw:string)=>{files.set(path,raw);},compareWrite:async(path:string,previous:string|null,next:string)=>{if(fail||(files.get(path)??null)!==previous)throw new Error("storage unavailable");files.set(path,next);}};
  const store=new LearningV3Store(io,"learning/v3/episodes"),commands=new LearningCommandsV3(store),dialogue=new LearningDialogueV3(commands),authority=localLearnerAuthority(),conversationId=crypto.randomUUID(),source={path:"math.md",version:"v1"};
  const input=(overrides:Partial<DialogueInputV3>={}):DialogueInputV3=>({entry:"sidebar",kind:"conversation",authority,conversationId,source,text:"hello",requestId:crypto.randomUUID(),...overrides});
  const prepare=(overrides:Partial<DialogueInputV3>={})=>dialogue.prepare(input(overrides));
  const offer=async()=>{const turn=await prepare();return dialogue.offer(turn,envelope({type:"invite",concept:"value-limit"}));};
  const accept=async()=>{const invitation=await offer(),turn=await prepare({text:"yes"});return dialogue.accept(turn,envelope({type:"accept",invitationId:invitation.id}));};
  const otherEpisode=async(overrides:Partial<EpisodeV3["source"]>={},concept:"value-limit"|"jump"="jump")=>{
    const boundSource={...source,...overrides},otherConversation=crypto.randomUUID(),invitation=commands.offer({authority,source:boundSource,conversationId:otherConversation,requestId:crypto.randomUUID(),concept});
    return (await commands.accept(invitation,{authority,source:boundSource,conversationId:otherConversation,requestId:crypto.randomUUID()})).episode;
  };
  return {files,store,commands,dialogue,authority,conversationId,source,input,prepare,offer,accept,otherEpisode,fail:(value:boolean)=>{fail=value;}};
}
describe("v3 learning conversation preparation",()=>{
  it("declares JSON in the actual API messages when requesting json_object output",async()=>{
    const r=rig(),turn=await r.prepare({text:"请解释极限"});
    const messages=buildApiMessages([],{notePath:r.source.path,teachingControl:r.dialogue.instructions(turn)},"请解释极限","Chinese");
    // OpenAI-compatible providers reject response_format=json_object unless
    // a message explicitly asks for JSON, even when an object example exists.
    expect(messages.some(message=>/\bjson\b/i.test(message.content))).toBe(true);
    expect(messages[0]!.content).toContain('"control"');expect(messages[0]!.content).toContain('"reply"');
    expect(messages[0]!.content).toContain("canInvite=true, use invite");
    expect(messages[0]!.content).toContain("wait for consent");
    expect(messages[0]!.content).toContain("Choose the action for the latest user message only");
    expect(messages[0]!.content).toContain("An answer offered after a hint is a new answer attempt");
    expect(messages[0]!.content).toContain("Do not infer an action merely from the existence of a short number");
    expect(messages[0]!.content).toMatch(/do not invent a question/i);
    expect(messages[0]!.content).toContain("For accept, resume, resume-legacy, next, schedule, correct, forget and expert, leave reply empty");
    expect(messages[0]!.content).not.toContain("Correctness");
    expect(buildApiMessages([],{},"请解释极限","Chinese")[0]!.content).not.toContain('"control"');
  });
  it("offers once without writing a record, accepts its exact handle, then binds the session",async()=>{
    const r=rig(),turn=await r.prepare();expect(turn).toMatchObject({eligible:true,canInvite:true,canAnswer:false});
    const invitation=r.dialogue.offer(turn,envelope({type:"invite",concept:"value-limit"}));
    expect(r.dialogue.offer(turn,envelope({type:"invite",concept:"value-limit"}))).toBe(invitation);expect(r.files.size).toBe(0);
    const response=await r.prepare({text:"yes"});expect(response.invitation).toBe(invitation);
    const accepted=await r.dialogue.accept(response,envelope({type:"accept",invitationId:invitation.id}));
    expect((await r.store.list()).map(record=>record.id)).toEqual([accepted.episode.id]);
    expect(await r.prepare({text:"9"})).toMatchObject({active:{id:accepted.episode.id},expectedRevision:accepted.episode.revision,canAnswer:true,canInvite:false});
  });
  it.each(["ignore","decline","next-turn"] as const)("expires an invitation on %s and never treats a later casual yes as consent",async behavior=>{
    const r=rig(),invitation=await r.offer(),response=await r.prepare();
    if(behavior!=="next-turn")r.dialogue.settle(response,envelope(behavior==="decline"?{type:"decline",invitationId:invitation.id}:{type:"none"}));
    const later=await r.prepare({text:"yes"});expect(later.invitation).toBeUndefined();expect(later.canInvite).toBe(false);
    await expect(r.dialogue.accept(later,envelope({type:"accept",invitationId:invitation.id}))).rejects.toThrow("invitation-mismatch");expect(r.files.size).toBe(0);
  });
  it.each([{path:"other.md",version:"v1"},{path:"math.md",version:"v2"},{path:"math.md",version:"v1",annotationId:"new"}])("expires a pending invitation when its live source changes: %j",async source=>{
    const r=rig(),invitation=await r.offer(),changed=await r.prepare({source});expect(changed.invitation).toBeUndefined();expect(changed.canInvite).toBe(false);
    await expect(r.dialogue.accept(changed,envelope({type:"accept",invitationId:invitation.id}))).rejects.toThrow();expect(r.files.size).toBe(0);
  });
  it("does not restore an invitation from a serialized ID or after restarting the dialogue",async()=>{
    const r=rig(),invitation=await r.offer();r.dialogue.reset();const resumed=await r.prepare({text:"yes"});
    await expect(r.dialogue.accept(resumed,envelope({type:"accept",invitationId:invitation.id}))).rejects.toThrow();
    const restarted=new LearningDialogueV3(new LearningCommandsV3(new LearningV3Store(r.store.io,r.store.root))),turn=await restarted.prepare(r.input({text:"yes"}));
    expect(turn.invitation).toBeUndefined();await expect(restarted.accept(turn,envelope({type:"accept",invitationId:invitation.id}))).rejects.toThrow();expect(r.files.size).toBe(0);
  });
  it.each([
    {entry:"external",kind:"conversation"},
    {entry:"sidebar",kind:"conversation",authority:undefined},
    {entry:"sidebar",kind:"conversation",authority:{}},
    {entry:"sidebar",kind:"document-edit"},
    {entry:"board",kind:"drawing"},
  ])("does not read records or offer write control for an ineligible identity: %j",async identity=>{
    const r=rig(),read=vi.spyOn(r.store,"readEffectiveResult"),turn=await r.prepare(identity as Partial<LearningTurnIdentity>);
    expect(turn).toMatchObject({eligible:false,canInvite:false,canAnswer:false,candidates:[],safeSummary:""});expect(read).not.toHaveBeenCalled();
    expect(()=>r.dialogue.offer(turn,envelope({type:"invite",concept:"value-limit"}))).toThrow("local-conversation");
    await expect(r.dialogue.accept(turn,envelope({type:"accept",invitationId:crypto.randomUUID()}))).rejects.toThrow("local-conversation");expect(r.files.size).toBe(0);
  });
  it("does not let an external request expire the local session invitation",async()=>{
    const r=rig(),invitation=await r.offer();await r.prepare({entry:"external",authority:undefined});
    expect((await r.prepare({text:"yes"})).invitation).toBe(invitation);
  });
  it("keeps a unique document record only as a resume candidate after reopening or greeting",async()=>{
    const r=rig(),episode=await r.otherEpisode();const turn=await r.prepare({text:"hello"});
    expect(turn.active).toBeUndefined();expect(turn).toMatchObject({candidate:{id:episode.id},canAnswer:false,canInvite:false});expect(turn.expectedRevision).toBeUndefined();expect(turn.commandSource).toBeUndefined();
    r.dialogue.settle(turn,envelope({type:"none"}));expect((await r.prepare({text:"9"})).active).toBeUndefined();expect((await r.store.list())[0]!.evidence).toEqual([]);
  });
  it("requires natural clarification when multiple candidate records exist",async()=>{
    const r=rig();await r.otherEpisode({},"value-limit");await r.otherEpisode();const turn=await r.prepare({text:"continue"});
    expect(turn.candidates).toHaveLength(2);expect(turn.active).toBeUndefined();expect(turn.candidate).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.clarification).toContain("哪一份");
  });
  it("exposes a bounded canonical index that can retrieve a specifically named older question, without activating it",async()=>{
    const r=rig(),otherConversation=crypto.randomUUID(),invitation=r.commands.offer({authority:r.authority,source:r.source,conversationId:otherConversation,requestId:crypto.randomUUID(),concept:"value-limit",question:questionRefV3("value-limit","transfer",0,crypto.randomUUID())});
    const old=(await r.commands.accept(invitation,{authority:r.authority,source:r.source,conversationId:otherConversation,requestId:crypto.randomUUID()})).episode;
    for(let i=0;i<4;i++)await r.otherEpisode({},"value-limit");
    const before=new Map(r.files),turn=await r.prepare({text:"继续传感器输出的那道题"}),instructions=r.dialogue.instructions(turn);
    const state=JSON.parse(instructions.split("Host state (data): ")[1]!);
    expect(state.resumeCandidateCount).toBe(5);expect(state.resumeCandidates).toHaveLength(3);
    expect(state.resumeCandidates.find((e:{id:string})=>e.id===old.id)).toMatchObject({currentQuestionId:old.currentQuestionId,question:renderQuestionV3(old.questions[0]!).prompt,createdAt:old.createdAt,updatedAt:old.updatedAt});
    expect(state.resumeCandidates.every((e:object)=>!("answer" in e)&&!("hint" in e))).toBe(true);
    expect(turn.safeSummary.length).toBeLessThanOrEqual(2000);expect(turn.active).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(r.files).toEqual(before);
    expect(r.dialogue.resumeTarget(turn,old.currentQuestionId).id).toBe(old.id);expect(r.dialogue.boundEpisodeId(r.conversationId,r.source.path)).toBeUndefined();
    expect(instructions).toContain("Merely asking to continue or repeat the existing question uses resume, never next");
    expect(instructions).not.toContain("Use next only for an explicit request to continue");
  });
  it("retains early correction identities outside the recent summary, with bounded canonical metadata and no corrected fact",async()=>{
    const r=rig(),accepted=await r.accept();let episode=accepted.episode;
    for(let i=0;i<12;i++)episode=(await r.commands.judgment({authority:r.authority,requestId:crypto.randomUUID(),episodeId:episode.id,questionId:episode.currentQuestionId,expectedRevision:episode.revision,source:episode.source},[{id:conceptCriterion[episode.concept],state:"uncertain"}],crypto.randomUUID())).episode;
    const first=episode.evidence[0]!,turn=await r.prepare({text:"第一题的旧判断你记错了，PRIVATE SUPPORT PROSE"});
    expect(turn.safeSummary).not.toContain(first.id);
    const state=JSON.parse(r.dialogue.instructions(turn).split("Host state (data): ")[1]!);
    expect(state.correctableEvidenceCount).toBe(12);expect(state.correctionCandidates.length).toBeLessThanOrEqual(8);
    expect(state.correctionCandidates.find((item:{evidenceId:string})=>item.evidenceId===first.id)).toMatchObject({questionId:first.questionId,type:"judgment",evaluator:"tutor",outcome:"unreviewed",sequence:first.sequence});
    expect(JSON.stringify(state.correctionCandidates)).not.toContain("PRIVATE SUPPORT PROSE");expect(JSON.stringify(state.correctionCandidates)).not.toContain('"answer":');expect(JSON.stringify(state.correctionCandidates)).not.toContain('"hint":');
    await r.commands.correct({authority:r.authority,requestId:crypto.randomUUID(),episodeId:episode.id,questionId:first.questionId,expectedRevision:episode.revision,source:episode.source},first.id);
    const next=await r.prepare(),updated=JSON.parse(r.dialogue.instructions(next).split("Host state (data): ")[1]!);
    expect(updated.correctableEvidenceCount).toBe(11);expect(updated.correctionCandidates.some((item:{evidenceId:string})=>item.evidenceId===first.id)).toBe(false);
    expect(()=>r.dialogue.resumeTarget(turn,episode.currentQuestionId)).toThrow();
  });
  it("binds a trusted explicit selection, but refuses unknown or cross-document IDs without falling back",async()=>{
    const r=rig(),episode=await r.otherEpisode(),other=await r.otherEpisode({path:"other.md"});
    for(const episodeId of [other.id,crypto.randomUUID()]){const turn=await r.prepare({episodeId});expect(turn.active).toBeUndefined();expect(turn.candidate).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.clarification).toContain("不可用");}
    const selected=await r.prepare({episodeId:episode.id});expect(selected.active?.id).toBe(episode.id);expect((await r.prepare()).active?.id).toBe(episode.id);
  });
  it("retains the selected question after document edits and separates live and original versions",async()=>{
    const r=rig(),accepted=await r.accept(),edited=await r.prepare({source:{...r.source,version:"v2"}});
    expect(edited).toMatchObject({active:{id:accepted.episode.id,currentQuestionId:accepted.episode.currentQuestionId},canAnswer:true,source:{version:"v2"},commandSource:{version:"v1"}});
    const changed=await r.prepare({source:{path:"other.md",version:"v3"}});expect(changed.active).toBeUndefined();
    const back=await r.prepare({source:{...r.source,version:"v2"}});expect(back.active).toBeUndefined();expect(back.candidate?.id).toBe(accepted.episode.id);
  });
  it("narrows candidates by annotation while allowing an explicit same-document selection from another entry",async()=>{
    const r=rig(),one=await r.otherEpisode({annotationId:"a"}),two=await r.otherEpisode({annotationId:"b"});
    const turn=await r.prepare({entry:"annotation",source:{...r.source,annotationId:"b",version:"v2"}});expect(turn.candidates.map(episode=>episode.id)).toEqual([two.id]);expect(turn.active).toBeUndefined();
    const explicit=await r.prepare({entry:"annotation",source:{...r.source,annotationId:"b",version:"v2"},episodeId:one.id});
    expect(explicit.active?.id).toBe(one.id);expect(explicit.commandSource).toEqual({...r.source,annotationId:"a"});
  });
  it("offers the same source exercise through a new annotation without granting answer authority",async()=>{
    const r=rig(),episode=await r.otherEpisode({},"value-limit"),other=await r.otherEpisode({path:"other.md"});
    const turn=await r.prepare({entry:"annotation",source:{...r.source,annotationId:"new"},text:"继续这道题"});
    expect(turn.candidates.map(e=>e.id)).toEqual([episode.id]);expect(turn.candidate?.id).toBe(episode.id);
    expect(turn.active).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.canInvite).toBe(false);
    expect(turn.safeSummary).toContain(episode.id);expect(turn.safeSummary).not.toContain(other.id);
    const result=await r.commands.resume({authority:r.authority,requestId:turn.requestId,episodeId:episode.id,questionId:episode.currentQuestionId,expectedRevision:episode.revision,source:episode.source});
    expect(r.dialogue.bindCommitted(turn,result)).toBe(true);
    const next=await r.prepare({entry:"annotation",source:{...r.source,annotationId:"new"}});
    expect(next.active?.id).toBe(episode.id);expect(next.commandSource).toEqual(episode.source);
    expect(await r.store.list()).toHaveLength(2);expect(next.active?.evidence).toEqual([]);
  });
  it("keeps multiple document exercises ambiguous at an annotation with no own record",async()=>{
    const r=rig();await r.otherEpisode({},"value-limit");await r.otherEpisode({annotationId:"elsewhere"});
    const turn=await r.prepare({entry:"annotation",source:{...r.source,annotationId:"new"},text:"继续"});
    expect(turn.candidates).toHaveLength(2);expect(turn.candidate).toBeUndefined();expect(turn.active).toBeUndefined();
    expect(turn.canAnswer).toBe(false);expect(turn.canInvite).toBe(false);expect(turn.clarification).toContain("哪一份");
  });
  it("does not grade a paused explicit target or bind a candidate before an explicit resume result",async()=>{
    const r=rig(),episode=await r.otherEpisode();episode.status="paused";const paused=await r.store.save(episode),turn=await r.prepare();
    const result=await r.commands.resume({authority:r.authority,requestId:turn.requestId,episodeId:paused.id,questionId:paused.currentQuestionId,expectedRevision:paused.revision,source:paused.source});
    expect(r.dialogue.bindCommitted(turn,result)).toBe(true);expect((await r.prepare()).canAnswer).toBe(true);
    const again=await r.commands.pause({authority:r.authority,requestId:crypto.randomUUID(),episodeId:result.episode.id,questionId:result.episode.currentQuestionId,expectedRevision:result.episode.revision,source:result.episode.source});
    expect(await r.prepare({episodeId:again.episode.id})).toMatchObject({active:{status:"paused"},canAnswer:false});
  });
  it("does not let a late committed resume overwrite a newer session or a reset",async()=>{
    const r=rig(),episode=await r.otherEpisode(),old=await r.prepare();await r.prepare({source:{path:"other.md",version:"v1"}});
    expect(r.dialogue.bindCommitted(old,{episode,replayed:false,phaseId:crypto.randomUUID()})).toBe(false);
    r.dialogue.reset();expect(r.dialogue.bindCommitted(old,{episode,replayed:false,phaseId:crypto.randomUUID()})).toBe(false);
  });
  it("rejects forged/stale prepare results and an unvalidated control without allocating an invitation",async()=>{
    const r=rig(),old=await r.prepare();await r.prepare();expect(()=>r.dialogue.offer(old,envelope({type:"invite",concept:"value-limit"}))).toThrow();
    const current=await r.prepare();expect(()=>r.dialogue.offer({...current},envelope({type:"invite",concept:"value-limit"}))).toThrow("local-conversation");
    expect(()=>r.dialogue.offer(current,{control:{action:{type:"invite",concept:"value-limit"},replyRelation:"unrelated"}} as never)).toThrow();expect(r.files.size).toBe(0);
  });
  it("reports unavailable storage without blocking ordinary explanation or inventing an empty learning history",async()=>{
    const r=rig();vi.spyOn(r.store,"readEffectiveResult").mockRejectedValue(new Error("PRIVATE IO ERROR"));const turn=await r.prepare();
    expect(turn).toMatchObject({completeness:"unavailable",canInvite:false,canAnswer:false});expect(turn.clarification).toContain("普通解释");expect(r.dialogue.instructions(turn)).not.toContain("PRIVATE IO ERROR");
  });
  it("uses protection-aware corrected evidence and no raw input in instructions",async()=>{
    const r=rig(),accepted=await r.accept(),episode=accepted.episode,q=renderQuestionV3(episode.questions[0]!);
    const answer=await r.commands.answer({authority:r.authority,requestId:crypto.randomUUID(),episodeId:episode.id,questionId:q.id,expectedRevision:episode.revision,source:episode.source},canonicalMathAnswer(q,q.answer)!,crypto.randomUUID());
    const corrected=await r.commands.correct({authority:r.authority,requestId:crypto.randomUUID(),episodeId:episode.id,questionId:q.id,expectedRevision:answer.episode.revision,source:episode.source},answer.episode.evidence[0]!.id);
    const turn=await r.prepare({text:"PRIVATE DISCLOSURE"});expect(turn.protection?.status).toBe("valid");expect(turn.safeSummary).not.toContain('"outcome":"correct"');
    const instructions=r.dialogue.instructions(turn);expect(instructions).not.toContain("PRIVATE DISCLOSURE");expect(instructions).not.toContain('"feedback":');expect(instructions).not.toContain('"attempt":');expect(instructions).toContain('"replyRelation"');expect(instructions).toContain(corrected.episode.currentQuestionId);
    r.files.delete(r.store.protection.path(episode.id));const missing=await r.prepare();expect(missing.completeness).toBe("partial");expect(missing.canAnswer).toBe(false);
  });
  it("keeps the same invitation after a failed consent write and never creates a second event on retry",async()=>{
    const r=rig(),invitation=await r.offer(),turn=await r.prepare({text:"yes"}),action=envelope({type:"accept",invitationId:invitation.id});r.fail(true);
    await expect(r.dialogue.accept(turn,action)).rejects.toThrow();r.fail(false);const accepted=await r.dialogue.accept(turn,action);
    expect(accepted.episode.id).toBe(invitation.episodeId);expect((await r.dialogue.accept(turn,action)).replayed).toBe(true);expect(await r.store.list()).toHaveLength(1);
  });
  it("keeps configured minutes as guidance and provides natural explain feedback plus every bounded action",async()=>{
    const r=rig(),accepted=await r.accept(),dialogue=new LearningDialogueV3(r.commands,{minutes:()=>20,experts:()=>true});
    const turn=await dialogue.prepare(r.input({episodeId:accepted.episode.id})),instructions=dialogue.instructions(turn);
    expect(turn.configuredMinutes).toBe(20);expect(instructions).toContain('"configuredMinutes":20');expect(instructions).not.toContain('"remainingMinutes":');
    expect(instructions).toContain("Explain reply may give natural feedback");expect(instructions).toContain("full answer");expect(instructions).toContain("repeated invitations");
    const actions=JSON.parse(instructions.split("\n").find(line=>line.startsWith("Allowed action shapes (data): "))!.slice("Allowed action shapes (data): ".length));
    expect(Object.keys(actions)).toEqual(["none","immediateSupport","supportBoundary","memoryClarification","capabilityInfo","invite","explainAndInvite","accept","decline","hint","solution","answer","explain","correct","resume","resumeLegacy","inviteFromLegacy","pause","next","schedule","forget","expert"]);
    expect(actions.schedule.days).toBe(1);expect(actions.expert.kind).toBe("explanation");
    expect((await new LearningDialogueV3(r.commands,{minutes:()=>NaN}).prepare(r.input())).configuredMinutes).toBeUndefined();
  });
  it("does not let an older async preparation replace the source selected by a newer turn",async()=>{
    const r=rig(),episode=await r.otherEpisode(),original=r.store.readEffectiveResult.bind(r.store);
    let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(r.store,"readEffectiveResult").mockImplementationOnce(async()=>{await blocked;return original();});
    const old=r.prepare({episodeId:episode.id});
    const newer=await r.prepare({source:{path:"other.md",version:"v1"}});release();
    await expect(old).rejects.toMatchObject({name:"AbortError"});expect(newer.active).toBeUndefined();
    const back=await r.prepare();expect(back.active).toBeUndefined();expect(back.candidate?.id).toBe(episode.id);
  });
  it("returns a real late consent commit without reactivating a superseding document",async()=>{
    const r=rig(),invitation=await r.offer(),turn=await r.prepare({text:"yes"}),original=r.commands.accept.bind(r.commands);
    let release!:()=>void,committed!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),saved=new Promise<void>(resolve=>{committed=resolve;});
    vi.spyOn(r.commands,"accept").mockImplementationOnce(async(...args)=>{const result=await original(...args);committed();await blocked;return result;});
    const accepted=r.dialogue.accept(turn,envelope({type:"accept",invitationId:invitation.id}));await saved;
    await r.prepare({source:{path:"other.md",version:"v1"}});release();expect((await accepted).episode.id).toBe(invitation.episodeId);
    const back=await r.prepare();expect(back.active).toBeUndefined();expect(back.candidate?.id).toBe(invitation.episodeId);
  });
  it("cancellation expires a pending invitation without reoffering in the same conversation",async()=>{
    const r=rig(),invitation=await r.offer(),old=await r.prepare({text:"yes"});r.dialogue.expireConversation(r.conversationId);
    await expect(r.dialogue.accept(old,envelope({type:"accept",invitationId:invitation.id}))).rejects.toMatchObject({name:"AbortError"});
    const next=await r.prepare();expect(next.invitation).toBeUndefined();expect(next.canInvite).toBe(false);expect(r.files.size).toBe(0);
  });
  it("checks the presentation session without consuming an invitation or rejecting its own evidence commit",async()=>{
    const r=rig(),invitation=await r.offer(),turn=await r.prepare({text:"yes"});
    expect(()=>r.dialogue.assertCurrent(turn)).not.toThrow();expect(turn.invitation).toBe(invitation);
    const accepted=await r.dialogue.accept(turn,envelope({type:"accept",invitationId:invitation.id}));
    expect(()=>r.dialogue.assertCurrent(turn)).not.toThrow();
    await r.commands.pause({authority:r.authority,requestId:turn.requestId,episodeId:accepted.episode.id,questionId:accepted.episode.currentQuestionId,expectedRevision:accepted.episode.revision,source:accepted.episode.source});
    expect(()=>r.dialogue.assertCurrent(turn)).not.toThrow();
    await r.prepare();expect(()=>r.dialogue.assertCurrent(turn)).toThrow();
    const external=await r.prepare({entry:"external"});expect(()=>r.dialogue.assertCurrent(external)).toThrow("local-conversation");
  });
});

describe("cross-entry candidates across current and legacy learning",()=>{
  const legacyV2=(r:ReturnType<typeof rig>,annotationId?:string,path=r.source.path)=>createEpisodeV2(
    {...r.source,path,...(annotationId?{annotationId}:{})},instantiateQuestion("value-limit","practice",0),
    {at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()});

  it("prefers an exact legacy annotation match over an unannotated v3 record",async()=>{
    const r=rig();await r.otherEpisode();const exact=legacyV2(r,"selected"),other=legacyV2(r,"other");
    const dialogue=new LearningDialogueV3(r.commands,{legacy:async()=>completeRecordReadResult([exact,other])}),before=new Map(r.files);
    const turn=await dialogue.prepare(r.input({entry:"annotation",source:{...r.source,annotationId:"selected"}}));
    expect(turn.legacyCandidates.map(record=>record.id)).toEqual([exact.id]);expect(turn.candidates).toEqual([]);
    expect(turn.active).toBeUndefined();expect(turn.candidate).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.canInvite).toBe(false);expect(r.files).toEqual(before);
  });

  it("prefers an exact v3 annotation match over unrelated legacy records",async()=>{
    const r=rig(),exact=await r.otherEpisode({annotationId:"selected"});await r.otherEpisode();const old=legacyV2(r,"other");
    const dialogue=new LearningDialogueV3(r.commands,{legacy:async()=>completeRecordReadResult([old])});
    const turn=await dialogue.prepare(r.input({entry:"annotation",source:{...r.source,annotationId:"selected"}}));
    expect(turn.candidates.map(record=>record.id)).toEqual([exact.id]);expect(turn.legacyCandidates).toEqual([]);
    expect(turn.candidate?.id).toBe(exact.id);expect(turn.active).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.canInvite).toBe(false);
  });

  it("retains ambiguity between a document v3 record and a legacy record at a new annotation",async()=>{
    const r=rig(),current=await r.otherEpisode(),old=legacyV2(r);
    const dialogue=new LearningDialogueV3(r.commands,{legacy:async()=>completeRecordReadResult([old])}),before=new Map(r.files);
    const turn=await dialogue.prepare(r.input({entry:"annotation",source:{...r.source,annotationId:"new"},text:"继续上次的题"}));
    expect(turn.candidates.map(record=>record.id)).toEqual([current.id]);expect(turn.legacyCandidates.map(record=>record.id)).toEqual([old.id]);
    expect(turn.candidate).toBeUndefined();expect(turn.active).toBeUndefined();expect(turn.clarification).toContain("哪一份");expect(turn.canInvite).toBe(false);expect(turn.canAnswer).toBe(false);expect(r.files).toEqual(before);
  });

  it("follows the surviving continuation chain when only its ancestors match the annotation",async()=>{
    const r=rig(),ancestor=createEpisode({...r.source,annotationId:"ancestor"},"value-limit"),middle=legacyV2(r,"middle");
    middle.legacy={id:ancestor.id,revision:ancestor.revision,evidenceIds:[]};
    const source={...r.source,annotationId:"child"},conversationId=crypto.randomUUID(),invitation=r.commands.offer({authority:r.authority,conversationId,requestId:crypto.randomUUID(),source,concept:"value-limit",legacy:{format:2,id:middle.id,revision:middle.revision,evidenceIds:[]}});
    const child=(await r.commands.accept(invitation,{authority:r.authority,conversationId,source,requestId:crypto.randomUUID()})).episode;
    const dialogue=new LearningDialogueV3(r.commands,{legacy:async()=>completeRecordReadResult([ancestor,middle])}),before=new Map(r.files);
    const turn=await dialogue.prepare(r.input({entry:"annotation",source:{...r.source,annotationId:"ancestor"}}));
    expect(turn.legacyCandidates).toEqual([]);expect(turn.candidates.map(record=>record.id)).toEqual([child.id]);expect(turn.candidate?.id).toBe(child.id);
    const summaryRecords=turn.safeSummary.split("\n").filter(line=>line.startsWith("{")).map(line=>JSON.parse(line));
    expect(summaryRecords.map(record=>record.id)).toEqual([child.id]);expect(summaryRecords[0]?.legacy).toBe(middle.id);
    expect(turn.active).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.canInvite).toBe(false);expect(r.files).toEqual(before);
  });

  it("does not let a deleted exact v3 match hide another document candidate or be explicitly resurrected",async()=>{
    const r=rig(),deleted=await r.otherEpisode({annotationId:"selected"}),survivor=await r.otherEpisode();await r.store.remove(deleted.id);
    const input={entry:"annotation" as const,source:{...r.source,annotationId:"selected"}},turn=await r.prepare(input);
    expect(turn.candidate?.id).toBe(survivor.id);expect(turn.active).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.canInvite).toBe(false);
    const explicit=await r.prepare({...input,episodeId:deleted.id});expect(explicit.candidates).toEqual([]);expect(explicit.active).toBeUndefined();expect(explicit.clarification).toContain("不可用");expect(explicit.canInvite).toBe(false);
  });

  it("ignores deleted and cross-document exact legacy matches before choosing the same-document candidate",async()=>{
    const r=rig(),current=await r.otherEpisode(),deleted=legacyV2(r,"selected"),foreign=legacyV2(r,"selected","other.md");deleted.status="deleted";
    const dialogue=new LearningDialogueV3(r.commands,{legacy:async()=>completeRecordReadResult([deleted,foreign])}),before=new Map(r.files);
    const turn=await dialogue.prepare(r.input({entry:"annotation",source:{...r.source,annotationId:"selected"}}));
    expect(turn.legacyCandidates).toEqual([]);expect(turn.candidates.map(record=>record.id)).toEqual([current.id]);expect(turn.candidate?.id).toBe(current.id);
    expect(turn.active).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(turn.canInvite).toBe(false);expect(r.files).toEqual(before);
  });
  it("provides schema-valid examples tied to the actual active question, never a guessed candidate",async()=>{
    const r=rig(),accepted=await r.accept(),turn=await r.prepare({text:"提示一下"}),instructions=r.dialogue.instructions(turn);
    const prefix="Current question action examples (data, choose only if requested): ";
    const examples=JSON.parse(instructions.split("\n").find(line=>line.startsWith(prefix))!.slice(prefix.length));
    for(const action of ["hint","solution","answer"]){
      const control=parseLearningControlV3(examples[action].control);expect(()=>validateLearningBinding(control,accepted.episode)).not.toThrow();
      expect(control.action).toEqual({type:action,questionId:accepted.episode.currentQuestionId});expect(examples[action].reply).toBe("");
    }
    r.dialogue.reset();const candidate=await r.prepare({text:"你好"});
    expect(candidate.active).toBeUndefined();expect(r.dialogue.instructions(candidate)).not.toContain(prefix);
    const resumePrefix="Resume action examples (data; only after an explicit continue request, clarify if ambiguous): ";
    const resume=JSON.parse(r.dialogue.instructions(candidate).split("\n").find(line=>line.startsWith(resumePrefix))!.slice(resumePrefix.length));
    expect(resume).toHaveLength(1);const resumed=parseLearningControlV3(resume[0].control);
    expect(resumed.action).toEqual({type:"resume",questionId:accepted.episode.currentQuestionId});
    expect(()=>validateLearningBinding(resumed,accepted.episode)).not.toThrow();
    expect(candidate.canAnswer).toBe(false);
  });

  it("offers whole-input answer syntax only for an active bound question without writing evidence",async()=>{
    const r=rig(),accepted=await r.accept(),before=new Map(r.files);
    const state=(turn:Awaited<ReturnType<typeof r.prepare>>)=>JSON.parse(r.dialogue.instructions(turn).split("\n").find(line=>line.startsWith("Host state (data): "))!.slice("Host state (data): ".length));
    const turn=await r.prepare({text:"6"});
    expect(state(turn).answerCandidate).toEqual({questionId:accepted.episode.currentQuestionId,wholeInputRecognized:true});
    expect(state(await r.prepare({text:"我的答案是6。请检查，不需要再给提示。"})).answerCandidate).toEqual({questionId:accepted.episode.currentQuestionId,wholeInputRecognized:true});
    for(const text of ["提示一下","6吗？","我很难受，6分也做不到","今天先休息","答案是6或7"]){
      expect(state(await r.prepare({text})).answerCandidate).toBeNull();
    }
    expect(r.files).toEqual(before);expect((await r.store.list())[0]!.evidence).toEqual([]);
    r.dialogue.reset();const candidate=await r.prepare({text:"6"});
    expect(candidate.candidate?.id).toBe(accepted.episode.id);expect(state(candidate).answerCandidate).toBeNull();
  });
  it("retains completed episode identity and only valid review state in continuation instructions",async()=>{
    const r=rig(),accepted=await r.accept(),e=accepted.episode;
    const scheduled={id:crypto.randomUUID(),dueAt:"2026-10-12T12:00:00.000Z",localDate:"2026-10-12",step:0,state:"scheduled" as const,dependsOn:[]};
    e.status="completed";e.reviewTasks.push(scheduled,{...scheduled,id:crypto.randomUUID(),state:"invalidated"});await r.store.save(e);
    const before=new Map(r.files),turn=await r.prepare({text:"继续刚才的题，只把题目告诉我"}),instructions=r.dialogue.instructions(turn);
    const state=JSON.parse(instructions.split("\n").find(line=>line.startsWith("Host state (data): "))!.slice("Host state (data): ".length));
    expect(state.activeEpisode).toMatchObject({id:e.id,status:"completed",reviews:[{id:scheduled.id,state:"scheduled",dueAt:scheduled.dueAt,step:0}]});
    expect(state.activeEpisode.reviews).toHaveLength(1);expect(state.canAnswer).toBe(false);
    expect(instructions).toContain("repeat only its question");expect(instructions).toContain("does not mean there is no current episode");
    expect(r.files).toEqual(before);
  });

  it("provides exact continuation examples for ungradable v1 candidates without creating consent or an active question",async()=>{
    const r=rig(),old=createEpisode(r.source,"value-limit");old.revision=2;
    const dialogue=new LearningDialogueV3(r.commands,{legacy:async()=>completeRecordReadResult([old])}),before=new Map(r.files);
    const turn=await dialogue.prepare(r.input({text:"继续上次的题"})),instructions=dialogue.instructions(turn);
    const prefix="Legacy continuation examples (data; explicit request required, clarify ambiguous targets): ";
    const examples=JSON.parse(instructions.split("\n").find(line=>line.startsWith(prefix))!.slice(prefix.length));
    expect(examples).toHaveLength(1);expect(parseLearningControlV3(examples[0].control).action).toEqual({type:"resume-legacy",episodeId:old.id});
    expect(examples[0].reply).toBe("");expect(instructions).toContain("use resume-legacy even if its format is 1");
    expect(instructions).toContain("If several candidates match, use none");
    expect(turn.active).toBeUndefined();expect(turn.invitation).toBeUndefined();expect(turn.canAnswer).toBe(false);expect(r.files).toEqual(before);
    const offered=await dialogue.offerLegacy(turn,old.id);
    const pending=await dialogue.prepare(r.input({text:"好的，开始新题并保存"})),pendingInstructions=dialogue.instructions(pending);
    expect(pendingInstructions).not.toContain(prefix);
    const responsePrefix="Pending invitation response examples (data; classify only the latest reply, never assume consent): ";
    const responses=JSON.parse(pendingInstructions.split("\n").find(line=>line.startsWith(responsePrefix))!.slice(responsePrefix.length));
    for(const type of ["accept","decline"]){expect(parseLearningControlV3(responses[type].control).action).toEqual({type,invitationId:offered.id});expect(responses[type].reply).toBe("");}
    expect(pendingInstructions).toContain("including invitations originating from old records");
    expect(pending.canInvite).toBe(false);expect(pending.active).toBeUndefined();expect(r.files).toEqual(before);
  });

});
