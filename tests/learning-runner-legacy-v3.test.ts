import { describe, expect, it, vi } from "vitest";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { localLearnerAuthority, type LearningControlV3 } from "../src/learning-control-v3.js";
import { LearningDialogueV3, type DialogueInputV3, type DialogueTurnV3 } from "../src/learning-dialogue-v3.js";
import { createEpisode, type LearningEpisode } from "../src/learning-episode.js";
import { LearningLegacyV3 } from "../src/learning-legacy-v3.js";
import { questionIndependence } from "../src/learning-protection.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import { completeRecordReadResult, type LearningIO } from "../src/learning-record-read.js";
import { runLearningTurnV3 } from "../src/learning-runner-v3.js";
import { createEpisodeV2, type EpisodeV2 } from "../src/learning-v2.js";
import { LearningV3Store, renderQuestionV3 } from "../src/learning-v3.js";

type RunOptions=Parameters<typeof runLearningTurnV3>[0];
const response=(action:LearningControlV3["action"])=>JSON.stringify({control:{action,replyRelation:"unrelated"},reply:"MODEL_PROMISE_MUST_NOT_SHOW"});
function fixture(format:1|2=1){
  const files=new Map<string,string>(),source={path:"lesson.md",version:"v1"},authority=localLearnerAuthority(),conversationId=crypto.randomUUID();
  const old=format===1?createEpisode(source,"value-limit"):createEpisodeV2(source,instantiateQuestion("value-limit","practice",0),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId});old.revision=2;
  const records:Array<LearningEpisode|EpisodeV2>=[old],io:LearningIO={read:async p=>files.get(p)??null,list:async root=>[...files.keys()].filter(p=>p.startsWith(root+"/")),write:async(p,raw)=>{files.set(p,raw);},compareWrite:async(p,b,n)=>{if((files.get(p)??null)!==b)throw new Error("conflict");files.set(p,n);}};
  const store=new LearningV3Store(io,"v3/episodes"),commands=new LearningCommandsV3(store),legacy=vi.fn(async()=>completeRecordReadResult(records)),dialogue=new LearningDialogueV3(commands,{legacy});
  const input=(extra:Partial<DialogueInputV3>={}):DialogueInputV3=>({authority,entry:"sidebar",kind:"conversation",conversationId,requestId:crypto.randomUUID(),source,text:"继续旧练习",episodeId:old.id,...extra});
  const prepare=(extra:Partial<DialogueInputV3>={})=>dialogue.prepare(input(extra));
  const shown:string[]=[],controller=new AbortController();
  const options=(turn:DialogueTurnV3,action:LearningControlV3["action"],extra:Partial<RunOptions>={}):RunOptions=>({dialogue,turn,signal:controller.signal,transport:async(_i,delta)=>{const text=response(action);delta(text);return {text};},ensureCurrent:async()=>{},present:text=>{shown.push(text);return true;},...extra});
  const resumeLegacy=(turn:DialogueTurnV3):NonNullable<RunOptions["resumeLegacy"]>=>async id=>{
    if(id!==old.id)throw new Error("wrong-legacy-id");
    const continued=await new LearningLegacyV3(store).continue({authority,requestId:turn.requestId,conversationId,source,record:old,expectedRevision:turn.legacyCandidates.find(record=>record.id===id)!.revision,signal:controller.signal,assertCurrentLegacy:async expected=>{if(old.revision!==expected.revision||old.status==="deleted")throw new Error("changed");}});
    return continued.status==="continued"?{result:{...continued,phaseId:continued.episode.consent.requestId}}:{needsNewQuestion:true,message:"这份旧题暂不能可靠地续记。"};
  };
  return {files,source,authority,conversationId,old,records,store,commands,legacy,dialogue,prepare,shown,controller,options,resumeLegacy};
}

describe("legacy actions in the natural learning runner",()=>{
  it.each([1,2] as const)("offers a separately consented new question from v%s without writing or presenting model promises",async format=>{
    const r=fixture(format),before=JSON.stringify(r.old),turn=await r.prepare({text:"换一道新题"});
    const result=await runLearningTurnV3(r.options(turn,{type:"invite-from-legacy",episodeId:r.old.id}));
    expect(result.text).toContain("我会保存这次练习进度");expect(result.text).toContain("原来的记录仍保留");expect(result.text).not.toContain("MODEL_PROMISE");expect(r.files.size).toBe(0);
    const yes=await r.prepare({text:"好",episodeId:undefined});expect(yes.invitation).toBeDefined();
    const accepted=await runLearningTurnV3(r.options(yes,{type:"accept",invitationId:yes.invitation!.id}));
    const read=await r.store.readEffectiveResult(),episode=read.records[0]!;
    expect(read.records).toHaveLength(1);expect(episode.legacy).toMatchObject({id:r.old.id,format,revision:2});expect(episode.evidence).toEqual([]);expect(episode.help).toEqual([]);
    expect(accepted.text).toContain(renderQuestionV3(episode.questions[0]!).prompt);expect(JSON.stringify(r.old)).toBe(before);
    expect(questionIndependence(episode,episode.currentQuestionId,1,read.protectionByEpisode.get(episode.id))).toBe("unknown");
  });
  it.each(["v1","unknown-v2"] as const)("turns an incompatible %s continuation into an invitation for exactly that ancestor",async kind=>{
    const r=fixture(kind==="v1"?1:2);if(r.old.format===2)r.old.questions[0]!.packVersion="limits-v2-1";
    const turn=await r.prepare(),resumeLegacy=vi.fn(r.resumeLegacy(turn));
    const result=await runLearningTurnV3(r.options(turn,{type:"resume-legacy",episodeId:r.old.id},{resumeLegacy}));
    expect(resumeLegacy).toHaveBeenCalledWith(r.old.id);expect(result.text).toContain("暂不能可靠地续记");expect(result.text).toContain("我会保存");expect(r.files.size).toBe(0);
    const yes=await r.prepare({text:"好的",episodeId:undefined});await runLearningTurnV3(r.options(yes,{type:"accept",invitationId:yes.invitation!.id}));
    expect((await r.store.list())[0]!.legacy?.id).toBe(r.old.id);expect((await r.store.list())[0]!.evidence).toEqual([]);
  });
  it("continues a verified original question without a replacement invitation or new help",async()=>{
    const r=fixture(2),turn=await r.prepare(),ownCommit=vi.fn();
    const result=await runLearningTurnV3(r.options(turn,{type:"resume-legacy",episodeId:r.old.id},{resumeLegacy:r.resumeLegacy(turn),ownCommit}));
    const saved=(await r.store.list())[0]!;expect(ownCommit).toHaveBeenCalledOnce();expect(saved.currentQuestionId).toBe((r.old as EpisodeV2).currentQuestionId);
    expect(saved.help).toEqual([]);expect(saved.evidence).toEqual([]);expect(result.text).toContain("接着这道旧题继续");expect(result.text).not.toContain("换一道新题");
    const next=await r.prepare({text:"hello",episodeId:undefined});expect(next.invitation).toBeUndefined();expect(next.active?.id).toBe(saved.id);
  });
  it.each(["missing","message","failure"] as const)("does not silently offer a different question for a %s continuation service",async kind=>{
    const r=fixture(),turn=await r.prepare(),resumeLegacy=kind==="missing"?undefined:vi.fn(async()=>{if(kind==="failure")throw new Error("storage-unavailable");return {message:"旧进度暂时不可用"};});
    const run=runLearningTurnV3(r.options(turn,{type:"resume-legacy",episodeId:r.old.id},{resumeLegacy}));
    if(kind==="failure")await expect(run).rejects.toThrow("storage-unavailable");else expect((await run).text).not.toContain("换一道新题");
    expect(r.files.size).toBe(0);expect((await r.prepare({text:"好"})).invitation).toBeUndefined();
  });
  it.each(["invite-from-legacy","resume-legacy"] as const)("replays a captured %s request without replacing its pending consent",async type=>{
    const r=fixture(),turn=await r.prepare(),options=r.options(turn,{type,episodeId:r.old.id},{resumeLegacy:r.resumeLegacy(turn)});
    const first=await runLearningTurnV3(options),offered=vi.spyOn(r.commands,"offer"),second=await runLearningTurnV3(options);
    expect(second.text).toBe(first.text);expect(offered).not.toHaveBeenCalled();expect(r.files.size).toBe(0);
    expect((await r.prepare({text:"好"})).invitation).toBeDefined();
  });
  it("rejects an unlisted ancestor before calling the continuation host",async()=>{
    const r=fixture(),turn=await r.prepare(),resumeLegacy=vi.fn();
    await expect(runLearningTurnV3(r.options(turn,{type:"resume-legacy",episodeId:crypto.randomUUID()},{resumeLegacy}))).rejects.toThrow("target-unavailable");
    expect(resumeLegacy).not.toHaveBeenCalled();expect(r.files.size).toBe(0);expect(r.shown).toEqual([]);
  });
  it("rechecks the ancestor before offering a new question after a host compatibility result",async()=>{
    const r=fixture(),turn=await r.prepare();
    await expect(runLearningTurnV3(r.options(turn,{type:"resume-legacy",episodeId:r.old.id},{resumeLegacy:async()=>{r.old.revision++;return {needsNewQuestion:true};}}))).rejects.toThrow("changed");
    expect(r.files.size).toBe(0);expect(r.shown).toEqual([]);expect((await r.prepare({text:"好"})).invitation).toBeUndefined();
  });
  it("rejects a late compatibility result after cancellation without creating a pending invitation",async()=>{
    const r=fixture(),turn=await r.prepare();
    await expect(runLearningTurnV3(r.options(turn,{type:"resume-legacy",episodeId:r.old.id},{resumeLegacy:async()=>{r.controller.abort();return {needsNewQuestion:true};}}))).rejects.toMatchObject({name:"AbortError"});
    expect(r.files.size).toBe(0);expect(r.shown).toEqual([]);expect((await r.prepare({text:"好"})).invitation).toBeUndefined();
  });
  it("expires a consent created by a legacy read that completed after cancellation",async()=>{
    const r=fixture(),turn=await r.prepare();let release!:()=>void,entered!:()=>void;
    const began=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
    r.legacy.mockImplementationOnce(async()=>{entered();await wait;return completeRecordReadResult(r.records);});
    const run=runLearningTurnV3(r.options(turn,{type:"invite-from-legacy",episodeId:r.old.id})),rejected=expect(run).rejects.toMatchObject({name:"AbortError"});
    await began;r.controller.abort();release();await rejected;
    expect(r.files.size).toBe(0);expect(r.shown).toEqual([]);expect((await r.prepare({text:"好的"})).invitation).toBeUndefined();
  });
  it("revalidates a pending ancestor on acceptance and keeps changed legacy data untouched",async()=>{
    const r=fixture(),turn=await r.prepare();await runLearningTurnV3(r.options(turn,{type:"invite-from-legacy",episodeId:r.old.id}));
    const yes=await r.prepare({text:"好"}),id=yes.invitation!.id;r.old.revision++;const snapshot=JSON.stringify(r.old);
    await expect(runLearningTurnV3(r.options(yes,{type:"accept",invitationId:id}))).rejects.toThrow("changed");
    expect(r.files.size).toBe(0);expect(JSON.stringify(r.old)).toBe(snapshot);
  });
});
