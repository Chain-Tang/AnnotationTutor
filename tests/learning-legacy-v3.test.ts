import { describe, expect, it } from "vitest";
import { createEpisode, type LearningEpisode } from "../src/learning-episode.js";
import { createEpisodeV2, type EpisodeV2 } from "../src/learning-v2.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import { LearningLegacyV3, legacyContinuationId, type LegacyContinuationInput } from "../src/learning-legacy-v3.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { canonicalMathAnswer } from "../src/learning-answer.js";
import { questionIndependence } from "../src/learning-protection.js";
import { LearningV3Store, renderQuestionV3 } from "../src/learning-v3.js";
import { protectionFixture } from "./learning-protection-fixture.js";

const date=new Date("2026-10-09T12:00:00Z");
function rig(format:1|2=2,pool:"practice"|"transfer"|"delayed"="practice"){
  const f=protectionFixture(),authority=localLearnerAuthority(),source={path:"Synthetic/legacy.md",version:"v1",annotationId:"note-1"};
  const record=format===1?createEpisode(source,"value-limit"):createEpisodeV2(source,instantiateQuestion("value-limit",pool,0),{at:date.toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()});
  record.revision=3;
  const state={record,deleted:false,currentSource:{...source},checks:0};
  const service=new LearningLegacyV3(f.store,()=>date),controller=new AbortController();
  const input:LegacyContinuationInput={authority,record,expectedRevision:record.revision,source:{...source},requestId:crypto.randomUUID(),conversationId:crypto.randomUUID(),signal:controller.signal,
    assertCurrentLegacy:async(expected,signal)=>{
      state.checks++;
      if(signal.aborted)throw new DOMException("cancelled","AbortError");
      if(state.deleted)throw new Error("legacy-deleted-by-host");
      if(expected.id!==state.record.id||expected.format!==state.record.format||expected.revision!==state.record.revision||JSON.stringify(expected.source)!==JSON.stringify(state.record.source)||JSON.stringify(expected.currentSource)!==JSON.stringify(state.currentSource))throw new Error("legacy-lease-changed");
    }};
  return {...f,authority,source,record,state,service,controller,input};
}
function oldEvidence(e:EpisodeV2,answer:string,evaluator:"deterministic"|"tutor"="deterministic"){
  const q=e.questions[0]!,requestId=crypto.randomUUID();e.requests.push(requestId);
  const evidence={id:crypto.randomUUID(),requestId,questionId:q.id,at:date.toISOString(),answer,help:{hints:0,answerShown:false},kind:"unassisted" as const,evaluator,outcome:"correct" as const,feedback:"PRIVATE_FEEDBACK"};
  e.evidence.push(evidence);return evidence;
}

describe("explicit legacy continuation into v3",()=>{
  it("continues the verified original question with an unknown-help barrier and no copied prose",async()=>{
    const r=rig(),old=r.record as EpisodeV2,q=old.questions[0]!,safe=oldEvidence(old,q.answer);
    oldEvidence(old,"答案是9，PRIVATE_DISCLOSURE");oldEvidence(old,q.answer,"tutor");
    q.prompt="PRIVATE_PROMPT";q.explanation="PRIVATE_EXPLANATION";q.hint="PRIVATE_HINT";q.rubric=["PRIVATE_RUBRIC"];q.answer="PRIVATE_ANSWER_KEY";
    r.state.currentSource.version="v2";r.input.source.version="v2";
    const original=structuredClone(old),result=await r.service.continue(r.input);
    expect(result.status).toBe("continued");if(result.status!=="continued")throw new Error();
    expect(result.episode).toMatchObject({id:legacyContinuationId(2,old.id),format:3,source:{...r.source,version:"v2"},legacy:{id:old.id,format:2,revision:3,evidenceIds:[safe.id]},status:"active",currentQuestionId:q.id,evidence:[],help:[],links:[]});
    expect(result.episode.questions[0]).toMatchObject({id:q.id,packVersion:"limits-v3-1",pool:q.pool,seed:q.seed});
    expect(renderQuestionV3(result.episode.questions[0]!).prompt).not.toContain("PRIVATE");
    const protection=await r.store.protection.read(result.episode.id);
    expect(questionIndependence(result.episode,q.id,1,protection)).toBe("unknown");
    expect(result.protectionRevision).toBe(protection.revision);
    expect(JSON.stringify([...r.files.values()])).not.toContain("PRIVATE");expect(old).toEqual(original);
  });

  it.each(["v1","v2-1","bad-parameters","bad-template"])("requires explicit new-question consent for %s without writing a substitute",async kind=>{
    const r=rig(kind==="v1"?1:2);
    if(r.record.format===1)(r.record as LearningEpisode).reflection="PRIVATE_REFLECTION";
    else if(kind==="v2-1")r.record.questions[0]!.packVersion="limits-v2-1";
    else if(kind==="bad-parameters")r.record.questions[0]!.parameters.a=999;
    else r.record.questions[0]!.templateId="unknown-template";
    const result=await r.service.continue(r.input);
    expect(result).toMatchObject({status:"needs-new-question",reason:kind==="v1"?"legacy-v1":"unverified-question",concept:"value-limit",legacy:{id:r.record.id,format:r.record.format,revision:3}});
    expect(r.files.size).toBe(0);expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("excludes corrected, unverified and free-text legacy evidence IDs",async()=>{
    const r=rig(),e=r.record as EpisodeV2,q=e.questions[0]!,first=oldEvidence(e,q.answer),uncorrected=oldEvidence(e,q.answer);
    oldEvidence(e,"PRIVATE_FREE_TEXT");oldEvidence(e,q.answer,"tutor");
    const correction=oldEvidence(e,"", "tutor");Object.assign(correction,{corrects:first.id,evaluator:"learner",outcome:"unreviewed"});
    const result=await r.service.continue(r.input);if(result.status!=="continued")throw new Error();
    expect(result.episode.legacy?.evidenceIds).toEqual([uncorrected.id]);expect(result.episode.evidence).toEqual([]);
  });

  it("deduplicates different requests, conversations, instances and first-CAS races by ancestor",async()=>{
    const r=rig(),other=new LearningLegacyV3(new LearningV3Store(r.io,r.root),()=>date);
    const results=await Promise.all([r.service.continue(r.input),other.continue({...r.input,requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()})]);
    expect(results.every(result=>result.status==="continued")).toBe(true);
    const continued=results.filter(result=>result.status==="continued");expect(continued.filter(result=>!result.replayed)).toHaveLength(1);
    expect(new Set(continued.map(result=>result.episode.id)).size).toBe(1);expect((await r.store.list())).toHaveLength(1);
    const restarted=await new LearningLegacyV3(r.reopen(),()=>date).continue({...r.input,requestId:crypto.randomUUID()});
    expect(restarted).toMatchObject({status:"continued",replayed:true});
    expect(legacyContinuationId(1,r.record.id)).not.toBe(legacyContinuationId(2,r.record.id));
    expect(legacyContinuationId(2,r.record.id.toUpperCase())).toBe(legacyContinuationId(2,r.record.id));
  });

  it.each(["authority","source","annotation","revision"])("rejects an invalid %s binding before any write",async field=>{
    const r=rig();
    if(field==="authority")r.input.authority={} as never;
    if(field==="source")r.input.source.path="Other/document.md";
    if(field==="annotation")r.input.source.annotationId="other-note";
    if(field==="revision")r.input.expectedRevision=2;
    await expect(async()=>r.service.continue(r.input)).rejects.toThrow();expect(r.files.size).toBe(0);expect(r.state.checks).toBe(0);
  });

  it("captures selected identity and source before queued host validation",async()=>{
    const r=rig(),validate=r.input.assertCurrentLegacy,expectedRequest=r.input.requestId,expectedConversation=r.input.conversationId;
    let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{entered=resolve;});
    r.input.assertCurrentLegacy=async(expected,signal)=>{entered();await blocked;return validate(expected,signal);};
    const pending=r.service.continue(r.input);await reached;
    r.input.requestId=crypto.randomUUID();r.input.conversationId=crypto.randomUUID();r.input.source.path="Other/document.md";r.input.record=structuredClone(r.record);r.input.record.revision=99;
    release();const result=await pending;if(result.status!=="continued")throw new Error();
    expect(result.episode.consent).toMatchObject({requestId:expectedRequest,conversationId:expectedConversation});expect(result.episode.source).toEqual(r.source);
  });

  it("refuses a changed original revision or source version discovered by the host lease",async()=>{
    for(const changed of ["revision","version"]){const r=rig();r.state.record=structuredClone(r.record);if(changed==="revision")r.state.record.revision++;else r.state.currentSource.version="v2";
      await expect(r.service.continue(r.input)).rejects.toThrow("lease-changed");expect(r.files.size).toBe(0);}
  });

  it("rechecks the original deletion barrier after reading the v3 target and before saving",async()=>{
    const r=rig(),read=r.store.readEffectiveResult.bind(r.store);
    r.store.readEffectiveResult=async()=>{const result=await read();r.state.deleted=true;return result;};
    await expect(r.service.continue(r.input)).rejects.toThrow("deleted-by-host");expect(r.files.size).toBe(0);
  });

  it("does not recreate a deleted ancestor or a deleted v3 continuation",async()=>{
    const r=rig();r.state.deleted=true;
    await expect(r.service.continue(r.input)).rejects.toThrow("deleted");expect(r.files.size).toBe(0);
    r.state.deleted=false;const result=await r.service.continue(r.input);if(result.status!=="continued")throw new Error();
    await r.store.remove(result.episode.id);const before=new Map(r.files);
    await expect(r.service.continue(r.input)).rejects.toThrow("deleted");expect(await r.store.list()).toEqual([]);expect(r.files).toEqual(before);
    const already=rig();(already.record as EpisodeV2).status="deleted";
    await expect(async()=>already.service.continue(already.input)).rejects.toThrow("deleted");expect(already.files.size).toBe(0);
  });

  it("cancels before or during persistence without acknowledging continuation",async()=>{
    const before=rig();before.controller.abort();await expect(before.service.continue(before.input)).rejects.toMatchObject({name:"AbortError"});expect(before.files.size).toBe(0);
    const during=rig(),compare=during.io.compareWrite,id=legacyContinuationId(2,during.record.id),guard=during.store.protection.path(id);
    during.io.compareWrite=async(path,raw,next)=>{await compare(path,raw,next);if(path===guard)during.controller.abort();};
    await expect(during.service.continue(during.input)).rejects.toMatchObject({name:"AbortError"});
    expect(during.files.has(`${during.root}/${id}.json`)).toBe(false);expect(await during.store.list()).toEqual([]);
  });

  it("returns its durable continuation and acknowledged protection when cancellation arrives after CAS",async()=>{
    const r=rig(),compare=r.io.compareWrite,path=`${r.root}/${legacyContinuationId(2,r.record.id)}.json`;
    r.io.compareWrite=async(target,before,after)=>{await compare(target,before,after);if(target===path)r.controller.abort();};
    const result=await r.service.continue(r.input);if(result.status!=="continued")throw new Error();
    expect(result.replayed).toBe(false);expect(r.controller.signal.aborted).toBe(true);
    expect(JSON.parse(r.files.get(path)!)).toEqual(result.episode);
    expect(result.protectionRevision).toBe(r.store.committedProtectionRevision(result.episode));
  });

  it("retries a failed first primary CAS without creating another continuation or claiming fresh help history",async()=>{
    const r=rig(),compare=r.io.compareWrite,path=`${r.root}/${legacyContinuationId(2,r.record.id)}.json`;
    r.io.compareWrite=async(target,before,after)=>{if(target===path)throw new Error("primary-failed");await compare(target,before,after);};
    await expect(r.service.continue(r.input)).rejects.toThrow("primary-failed");expect(r.files.has(path)).toBe(false);
    r.io.compareWrite=compare;const result=await r.service.continue({...r.input,requestId:crypto.randomUUID()});if(result.status!=="continued")throw new Error();
    expect((await r.store.list())).toHaveLength(1);
    expect(questionIndependence(result.episode,result.episode.currentQuestionId,1,await r.store.protection.read(result.episode.id))).toBe("unknown");
  });

  it("preserves an unsupported derived target instead of treating it as an unused ancestor",async()=>{
    const r=rig(),path=`${r.root}/${legacyContinuationId(2,r.record.id)}.json`,future='{"format":99,"private":"FUTURE_RECORD"}';
    r.files.set(path,future);const before=new Map(r.files);
    await expect(r.service.continue(r.input)).rejects.toThrow("target-unavailable");expect(r.files).toEqual(before);
  });

  it("never starts a second continuation for a newer ancestor revision or different lineage",async()=>{
    const r=rig(),saved=await r.service.continue(r.input);if(saved.status!=="continued")throw new Error();
    r.record.revision++;r.input.expectedRevision=r.record.revision;const before=new Map(r.files);
    await expect(r.service.continue(r.input)).rejects.toThrow("continuation-conflict");expect(r.files).toEqual(before);expect((await r.store.list())).toHaveLength(1);
  });

  it("replays progressed v3 state without restoring its old current question or consent",async()=>{
    const r=rig(),saved=await r.service.continue(r.input);if(saved.status!=="continued")throw new Error();
    const commands=new LearningCommandsV3(r.store,()=>date),e=saved.episode;
    const moved=await commands.next({authority:r.authority,requestId:crypto.randomUUID(),episodeId:e.id,questionId:e.currentQuestionId,expectedRevision:e.revision,source:e.source});
    const replay=await r.service.continue({...r.input,requestId:crypto.randomUUID()});
    expect(replay).toMatchObject({status:"continued",replayed:true,episode:{currentQuestionId:moved.episode.currentQuestionId,consent:e.consent}});
  });

  it("creates a new step-zero delayed task without importing the old mastery stage",async()=>{
    const r=rig(2,"delayed"),old=r.record as EpisodeV2;old.reviewStep=3;old.reviewDue="2026-10-01T00:00:00Z";
    const result=await r.service.continue(r.input);if(result.status!=="continued")throw new Error();
    const e=result.episode;expect(e.currentQuestionId).toBe(old.currentQuestionId);
    expect(e.reviewTasks).toEqual([expect.objectContaining({state:"active",step:0,dependsOn:[],questionId:old.currentQuestionId,consumedBy:r.input.requestId,dueAt:date.toISOString()})]);
    const commands=new LearningCommandsV3(r.store,()=>date),question=renderQuestionV3(e.questions[0]!);
    const answer=await commands.answer({authority:r.authority,requestId:crypto.randomUUID(),episodeId:e.id,questionId:e.currentQuestionId,expectedRevision:e.revision,source:e.source},canonicalMathAnswer(question,question.answer)!,crypto.randomUUID(),undefined,{remainingMinutes:20});
    expect(answer.episode.evidence[0]).toMatchObject({independence:"unknown"});
    expect(answer.episode.reviewTasks.filter(task=>task.state==="scheduled")).toEqual([expect.objectContaining({step:0,dueAt:"2026-10-10T12:00:00.000Z"})]);
  });
});
