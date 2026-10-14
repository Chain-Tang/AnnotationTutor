import { describe, expect, it, vi } from "vitest";
import { LearningDialogueV3, type DialogueInputV3 } from "../src/learning-dialogue-v3.js";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { LearningLegacyV3 } from "../src/learning-legacy-v3.js";
import { LearningV3Store } from "../src/learning-v3.js";
import { createEpisode, type LearningEpisode } from "../src/learning-episode.js";
import { createEpisodeV2, type EpisodeV2 } from "../src/learning-v2.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import { questionIndependence } from "../src/learning-protection.js";
import { learningContext } from "../src/learning-context.js";
import { completeRecordReadResult, type LearningIO } from "../src/learning-record-read.js";

function fixture(){
  const files=new Map<string,string>(),records:Array<LearningEpisode|EpisodeV2>=[];
  const io:LearningIO={read:async path=>files.get(path)??null,list:async root=>[...files.keys()].filter(path=>path.startsWith(root+"/")),write:async(path,raw)=>{files.set(path,raw);},
    compareWrite:async(path,previous,next)=>{if((files.get(path)??null)!==previous)throw new Error("conflict");files.set(path,next);}};
  const store=new LearningV3Store(io,"v3/episodes"),commands=new LearningCommandsV3(store),legacy=vi.fn(async()=>completeRecordReadResult(records)),dialogue=new LearningDialogueV3(commands,{legacy});
  const authority=localLearnerAuthority(),conversationId=crypto.randomUUID(),source={path:"lesson.md",version:"v1"};
  const input=(extra:Partial<DialogueInputV3>={}):DialogueInputV3=>({entry:"sidebar",kind:"conversation",authority,conversationId,requestId:crypto.randomUUID(),source,text:"hello",...extra});
  const old=(format:1|2=2,extra:Partial<LearningEpisode["source"]>={})=>{
    const record=format===1?createEpisode({...source,...extra},"value-limit"):createEpisodeV2({...source,...extra},instantiateQuestion("value-limit","practice",0),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()});
    record.revision=2;records.push(record);return record;
  };
  const continueRecord=async(record:LearningEpisode|EpisodeV2)=>{
    const result=await new LearningLegacyV3(store).continue({authority,requestId:crypto.randomUUID(),conversationId,record,expectedRevision:record.revision,source:record.source,signal:new AbortController().signal,
      assertCurrentLegacy:async expected=>{const live=records.find(record=>record.id===expected.id);if(!live||live.revision!==expected.revision)throw new Error("legacy-changed");}});
    if(result.status!=="continued")throw new Error("expected-verified-question");return result;
  };
  return {files,records,store,commands,legacy,dialogue,authority,conversationId,source,input,old,continueRecord};
}

describe("legacy-aware v3 conversation preparation",()=>{
  it("offers a legacy record only as an explicit continuation candidate and never exposes its raw prose",async()=>{
    const f=fixture(),old=f.old();if(old.format!==2)throw new Error();old.questions[0]!.prompt="PRIVATE_OLD_PROMPT";old.questions[0]!.hint="PRIVATE_OLD_HINT";
    const before=JSON.stringify(f.records),turn=await f.dialogue.prepare(f.input({text:"9"}));
    expect(turn).toMatchObject({active:undefined,candidate:undefined,canAnswer:false,canInvite:false,legacyCandidates:[{id:old.id,format:2,revision:2,question:{id:old.currentQuestionId}}]});
    expect(f.dialogue.boundEpisodeId(f.conversationId,f.source.path)).toBeUndefined();
    const instructions=f.dialogue.instructions(turn);expect(instructions).toContain("resume-legacy");expect(instructions).not.toContain("PRIVATE_OLD_");
    expect(f.files.size).toBe(0);expect(JSON.stringify(f.records)).toBe(before);
  });

  it("provides natural clarification for multiple legacy candidates without selecting or writing",async()=>{
    const f=fixture();f.old();f.old();const turn=await f.dialogue.prepare(f.input({text:"继续"}));
    expect(turn.legacyCandidates).toHaveLength(2);expect(turn.active).toBeUndefined();expect(turn.candidate).toBeUndefined();expect(turn.canAnswer).toBe(false);
    expect(turn.clarification).toContain("哪一份");expect(f.files.size).toBe(0);
  });

  it("does not choose a unique v3 candidate while another legacy learning chain also exists",async()=>{
    const f=fixture(),first=f.old();await f.continueRecord(first);f.old();const turn=await f.dialogue.prepare(f.input({text:"继续"}));
    expect(turn.candidates).toHaveLength(1);expect(turn.legacyCandidates).toHaveLength(1);expect(turn.candidate).toBeUndefined();expect(turn.active).toBeUndefined();
    expect(turn.clarification).toContain("哪一份");
  });

  it("does not substitute another record when an explicit legacy ID is unknown or belongs to another document",async()=>{
    const f=fixture();f.old();const elsewhere=f.old(2,{path:"elsewhere.md"});
    for(const episodeId of [crypto.randomUUID(),elsewhere.id]){
      const turn=await f.dialogue.prepare(f.input({episodeId}));expect(turn.legacyCandidates).toEqual([]);expect(turn.candidates).toEqual([]);expect(turn.active).toBeUndefined();expect(turn.canInvite).toBe(false);expect(turn.clarification).toContain("不可用");
    }
    expect(f.files.size).toBe(0);
  });

  it("narrows by annotation by default but permits an explicit same-document old ID from another annotation",async()=>{
    const f=fixture(),one=f.old(2,{annotationId:"one"}),two=f.old(2,{annotationId:"two"}),source={...f.source,annotationId:"two",version:"edited"};
    const scoped=await f.dialogue.prepare(f.input({entry:"annotation",source}));expect(scoped.legacyCandidates.map(record=>record.id)).toEqual([two.id]);
    const explicit=await f.dialogue.prepare(f.input({entry:"annotation",source,episodeId:one.id}));expect(explicit.legacyCandidates.map(record=>record.id)).toEqual([one.id]);expect(explicit.active).toBeUndefined();
  });

  it("keeps v1 and unknown v2 packs as bounded candidates without pretending their original question is verified",async()=>{
    const f=fixture(),one=f.old(1),two=f.old();if(two.format!==2)throw new Error();two.questions[0]!.packVersion="limits-v2-1";
    const turn=await f.dialogue.prepare(f.input());expect(turn.legacyCandidates.map(record=>({id:record.id,question:record.question}))).toEqual([{id:one.id,question:undefined},{id:two.id,question:undefined}]);expect(f.files.size).toBe(0);
  });

  it("hides continued ancestors from source summaries while explicit old-ID reads remain available",async()=>{
    const f=fixture(),ancestor=f.old(1),middle=f.old();if(middle.format!==2)throw new Error();middle.legacy={id:ancestor.id,revision:ancestor.revision,evidenceIds:[]};
    const continued=await f.continueRecord(middle),read=await f.store.readEffectiveResult(),records=[...f.records,...read.records];
    const source=learningContext(records,{source:f.source.path},read.protectionByEpisode);expect(source.episodes.map(record=>record.id)).toEqual([continued.episode.id]);
    for(const old of [ancestor,middle])expect(learningContext(records,{source:f.source.path,episodeId:old.id},read.protectionByEpisode).episodes.map(record=>record.id)).toEqual([old.id]);
    const turn=await f.dialogue.prepare(f.input());expect(turn.legacyCandidates).toEqual([]);expect(turn.candidate?.id).toBe(continued.episode.id);expect(turn.active).toBeUndefined();
  });

  it("binds the continued identity only after its result, and resolves an explicitly reopened old ID to that same v3 question",async()=>{
    const f=fixture(),old=f.old(),turn=await f.dialogue.prepare(f.input({episodeId:old.id})),result=await f.continueRecord(old);
    expect(f.dialogue.bindCommitted(turn,{...result,phaseId:result.episode.consent.requestId})).toBe(true);
    expect(f.dialogue.boundEpisodeId(f.conversationId,f.source.path)).toBe(result.episode.id);expect(f.dialogue.boundEpisodeId(f.conversationId,"elsewhere.md")).toBeUndefined();
    const restarted=new LearningDialogueV3(new LearningCommandsV3(new LearningV3Store(f.store.io,f.store.root)),{legacy:f.legacy});
    const ordinary=await restarted.prepare(f.input({text:"hello"}));expect(ordinary.active).toBeUndefined();expect(ordinary.candidate?.id).toBe(result.episode.id);
    const selected=await restarted.prepare(f.input({episodeId:old.id,source:{...f.source,version:"edited"}}));expect(selected.active?.currentQuestionId).toBe(result.episode.currentQuestionId);expect(selected.commandSource?.version).toBe("v1");
    expect(await f.store.list()).toHaveLength(1);
  });

  it("does not bind a late continuation over a new document or after reset",async()=>{
    const f=fixture(),old=f.old(),turn=await f.dialogue.prepare(f.input({episodeId:old.id})),result=await f.continueRecord(old);
    await f.dialogue.prepare(f.input({source:{path:"elsewhere.md",version:"v1"}}));
    expect(f.dialogue.bindCommitted(turn,{...result,phaseId:result.episode.consent.requestId})).toBe(false);f.dialogue.reset();
    expect(f.dialogue.bindCommitted(turn,{...result,phaseId:result.episode.consent.requestId})).toBe(false);
  });

  it("disables a new invitation when old history cannot be read, without reading legacy for external callers",async()=>{
    const f=fixture();f.legacy.mockRejectedValue(new Error("PRIVATE_READ_FAILURE"));
    const turn=await f.dialogue.prepare(f.input());expect(turn).toMatchObject({completeness:"unavailable",canInvite:false,canAnswer:false});expect(f.dialogue.instructions(turn)).not.toContain("PRIVATE_READ_FAILURE");
    f.legacy.mockClear();const external=await f.dialogue.prepare(f.input({entry:"external",authority:undefined}));expect(f.legacy).not.toHaveBeenCalled();expect(external.legacyCandidates).toEqual([]);
  });
});

const envelope=(action:Record<string,unknown>)=>({control:{action,replyRelation:"unrelated"},reply:""}) as Parameters<LearningDialogueV3["accept"]>[1];
describe("new-question consent from legacy history",()=>{
  it.each([1,2] as const)("requires a later consent before creating a conservative v3 child of v%s",async format=>{
    const f=fixture(),old=f.old(format),before=JSON.stringify(old),turn=await f.dialogue.prepare(f.input({episodeId:old.id,text:"换一道新题"}));
    const invitation=await f.dialogue.offerLegacy(turn,old.id);expect(f.files.size).toBe(0);
    expect(await f.dialogue.offerLegacy(turn,old.id)).toBe(invitation);
    const yes=await f.dialogue.prepare(f.input({text:"好"})),result=await f.dialogue.accept(yes,envelope({type:"accept",invitationId:invitation.id}));
    expect(result.episode.legacy).toEqual({id:old.id,format,revision:old.revision,evidenceIds:[]});expect(result.episode.evidence).toEqual([]);
    if(old.format===2)expect(result.episode.currentQuestionId).not.toBe(old.currentQuestionId);expect(JSON.stringify(old)).toBe(before);
    const read=await f.store.readEffectiveResult();expect(read.records).toHaveLength(1);expect(questionIndependence(result.episode,result.episode.currentQuestionId,1,read.protectionByEpisode.get(result.episode.id))).toBe("unknown");
    expect((await f.dialogue.accept(yes,envelope({type:"accept",invitationId:invitation.id}))).episode.id).toBe(result.episode.id);
  });
  it("does not let generic invite reinterpret a legacy invitation, nor another legacy record reuse it",async()=>{
    const f=fixture(),old=f.old(),other=f.old(),turn=await f.dialogue.prepare(f.input());await f.dialogue.offerLegacy(turn,old.id);
    expect(()=>f.dialogue.offer(turn,envelope({type:"invite",concept:old.concept}))).toThrow("request-reused");
    await expect(f.dialogue.offerLegacy(turn,other.id)).rejects.toThrow("request-reused");expect(f.files.size).toBe(0);
  });
  it("never guesses an unknown, cross-document or unlisted legacy identity",async()=>{
    const f=fixture();f.old();const other=f.old(1,{path:"other.md"}),turn=await f.dialogue.prepare(f.input());
    for(const id of [other.id,crypto.randomUUID()])await expect(f.dialogue.offerLegacy(turn,id)).rejects.toThrow("not-available");
    expect(f.files.size).toBe(0);
  });
  it.each(["ignore","decline","restart","source"])("expires legacy consent on %s without repeated invitation",async mode=>{
    const f=fixture(),old=f.old(),turn=await f.dialogue.prepare(f.input()),invitation=await f.dialogue.offerLegacy(turn,old.id);
    const reply=await f.dialogue.prepare(f.input({text:"yes"}));
    if(mode==="ignore"||mode==="decline")f.dialogue.settle(reply,envelope(mode==="ignore"?{type:"none"}:{type:"decline",invitationId:invitation.id}));
    if(mode==="restart")f.dialogue.reset();
    if(mode==="source")await f.dialogue.prepare(f.input({source:{...f.source,version:"edited"}}));
    await expect(f.dialogue.accept(reply,envelope({type:"accept",invitationId:invitation.id}))).rejects.toThrow();
    const next=await f.dialogue.prepare(f.input());expect(next.invitation).toBeUndefined();
    if(mode!=="restart")await expect(f.dialogue.offerLegacy(next,old.id)).rejects.toThrow("not-available");
    expect(f.files.size).toBe(0);
  });
  it("rechecks legacy revision before offering and before accepting, with no writes",async()=>{
    const f=fixture(),old=f.old(),turn=await f.dialogue.prepare(f.input());old.revision++;
    await expect(f.dialogue.offerLegacy(turn,old.id)).rejects.toThrow("changed");
    const current=await f.dialogue.prepare(f.input()),invitation=await f.dialogue.offerLegacy(current,old.id),yes=await f.dialogue.prepare(f.input({text:"yes"}));old.revision++;
    await expect(f.dialogue.accept(yes,envelope({type:"accept",invitationId:invitation.id}))).rejects.toThrow("changed");expect(f.files.size).toBe(0);
  });
  it("expires a pending handle when the next preparation sees legacy deletion",async()=>{
    const f=fixture(),old=f.old(),turn=await f.dialogue.prepare(f.input());await f.dialogue.offerLegacy(turn,old.id);old.status="deleted";
    const yes=await f.dialogue.prepare(f.input({text:"yes"}));expect(yes.invitation).toBeUndefined();expect(yes.canInvite).toBe(false);expect(f.files.size).toBe(0);
  });
  it("rejects late legacy read completion after a newer turn",async()=>{
    const f=fixture(),old=f.old(),turn=await f.dialogue.prepare(f.input());let release!:(value:ReturnType<typeof completeRecordReadResult<LearningEpisode|EpisodeV2>>)=>void;
    f.legacy.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const offering=f.dialogue.offerLegacy(turn,old.id);
    await f.dialogue.prepare(f.input());release(completeRecordReadResult(f.records));await expect(offering).rejects.toMatchObject({name:"AbortError"});expect(f.files.size).toBe(0);
  });
  it("rejects unavailable old history and external author claims",async()=>{
    const f=fixture(),old=f.old(),turn=await f.dialogue.prepare(f.input());f.legacy.mockRejectedValue(new Error("unavailable"));
    await expect(f.dialogue.offerLegacy(turn,old.id)).rejects.toThrow("changed");
    const external=await f.dialogue.prepare(f.input({entry:"external"}));await expect(f.dialogue.offerLegacy(external,old.id)).rejects.toThrow("local-conversation");expect(f.files.size).toBe(0);
  });
});
