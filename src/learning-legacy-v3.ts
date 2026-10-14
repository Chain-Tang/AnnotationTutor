import { createHash } from "node:crypto";
import { z } from "zod";
import { episodeSchema, type ConceptId } from "./learning-episode.js";
import { episodeV2Schema } from "./learning-v2.js";
import { canonicalLegacyQuestion, safeLegacyEvidence, type LegacyLearningRecord } from "./learning-safe-projection.js";
import { hasLocalLearnerAuthority, type LocalLearnerAuthority } from "./learning-control-v3.js";
import { createEpisodeV3, episodeV3Schema, questionRefV3, type EpisodeV3, type LearningV3Store, type QuestionRefV3 } from "./learning-v3.js";
import { uniqueIds, validCorrectionReferences } from "./learning-record-read.js";
import { questionProtectionDigest } from "./learning-protection.js";

const uuid=z.string().uuid(),revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type LegacyContinuationBinding = Readonly<{
  format:1|2; id:string; revision:number; source:Readonly<LegacyLearningRecord["source"]>;
  currentSource:Readonly<EpisodeV3["source"]>;
}>;
export type LegacyContinuationInput = {
  authority:LocalLearnerAuthority;requestId:string;conversationId:string;
  record:LegacyLearningRecord;expectedRevision:number;source:EpisodeV3["source"];
  signal:AbortSignal;
  /** Host must re-read the selected ancestor (including its deletion barrier)
   * and current source version. Keep signal live for changes until CAS settles. */
  assertCurrentLegacy:(expected:LegacyContinuationBinding,signal:AbortSignal)=>Promise<void>;
};
export type LegacyContinuationResult =
  | {status:"continued";episode:EpisodeV3;replayed:boolean;protectionRevision?:string}
  | {status:"needs-new-question";reason:"legacy-v1"|"unverified-question";concept:ConceptId;legacy:NonNullable<EpisodeV3["legacy"]>;source:EpisodeV3["source"]};

function stableId(namespace:string,format:1|2,id:string):string {
  z.union([z.literal(1),z.literal(2)]).parse(format);uuid.parse(id);
  const bytes=createHash("sha256").update(JSON.stringify([namespace,format,id.toLowerCase()])).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|128;bytes[8]=(bytes[8]!&63)|128;
  const hex=bytes.toString("hex");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** One continuation per ancestor, independent of request, instance or old revision. */
export const legacyContinuationId=(format:1|2,id:string)=>stableId("tutor-legacy-continuation-v3-1",format,id);
function abort(signal:AbortSignal){if(signal.aborted)throw new DOMException("Learning continuation cancelled","AbortError");}
function sameTarget(a:LegacyLearningRecord["source"],b:LegacyLearningRecord["source"]){return a.path===b.path&&a.annotationId===b.annotationId;}
function readSelected(input:LegacyLearningRecord):LegacyLearningRecord {
  let record:LegacyLearningRecord;
  try{record=input.format===1?episodeSchema.parse(input):episodeV2Schema.parse(input);}catch{throw new Error("learning-legacy-record-invalid");}
  if(!validCorrectionReferences(record.evidence))throw new Error("learning-legacy-reference-invalid");
  if(record.format===2&&(!uniqueIds(record.questions)||!record.questions.some(q=>q.id===record.currentQuestionId)||record.questions.some(q=>q.concept!==record.concept)||record.evidence.some(e=>!record.questions.some(q=>q.id===e.questionId))))throw new Error("learning-legacy-reference-invalid");
  if(record.format===2&&record.status==="deleted")throw new Error("learning-legacy-deleted");
  return record;
}
function lineage(record:LegacyLearningRecord):NonNullable<EpisodeV3["legacy"]> {
  // v1 has no frozen v3-compatible question identity. Its historical claims
  // are not used as a basis for a newly authorized question.
  const evidenceIds=record.format===1?[]:safeLegacyEvidence(record).filter(item=>"answer" in item&&item.answer!==undefined&&item.evaluator==="deterministic").map(item=>item.id).sort();
  return {id:record.id,format:record.format,revision:record.revision,evidenceIds};
}
function originalQuestion(record:LegacyLearningRecord):QuestionRefV3|undefined {
  if(record.format!==2)return;
  const saved=record.questions.find(q=>q.id===record.currentQuestionId)!;
  if(saved.packVersion!=="limits-v2-2"||!canonicalLegacyQuestion(record,saved.id))return;
  // Explicit ID deliberately has no fresh-question capability: old help may
  // have been presented without a modern durable exposure record.
  return questionRefV3(record.concept,saved.pool,saved.seed,saved.id);
}

/** Explicit local continuation, not history migration. No old answer, prompt,
 * feedback, reflection, rubric, help count or mastery statement is copied. */
export class LearningLegacyV3 {
  private tail:Promise<unknown>=Promise.resolve();
  constructor(readonly store:LearningV3Store,private now:()=>Date=()=>new Date()){}
  continue(input:LegacyContinuationInput):Promise<LegacyContinuationResult> {
    if(!hasLocalLearnerAuthority(input.authority))throw new Error("learning-local-learner-required");
    const record=readSelected(input.record),expectedRevision=revision.parse(input.expectedRevision);
    const source=episodeV3Schema.shape.source.parse(input.source),requestId=uuid.parse(input.requestId),conversationId=uuid.parse(input.conversationId);
    if(record.revision!==expectedRevision)throw new Error("learning-legacy-revision-conflict");
    if(!sameTarget(record.source,source))throw new Error("learning-legacy-source-changed");
    const signal=input.signal,assertCurrent=input.assertCurrentLegacy;
    if(!signal||typeof signal.aborted!=="boolean"||typeof assertCurrent!=="function")throw new Error("learning-legacy-live-lease-required");
    const expected:LegacyContinuationBinding=Object.freeze({format:record.format,id:record.id,revision:record.revision,source:Object.freeze({...record.source}),currentSource:Object.freeze({...source})});
    const legacy=lineage(record),question=originalQuestion(record),id=legacyContinuationId(record.format,record.id);
    const check=async()=>{abort(signal);await assertCurrent(expected,signal);abort(signal);};
    const run=this.tail.catch(()=>{}).then(async():Promise<LegacyContinuationResult>=>{
      await check();
      if(!question)return {status:"needs-new-question",reason:record.format===1?"legacy-v1":"unverified-question",concept:record.concept,legacy,source};
      const existing=async()=>{
        const read=await this.store.readEffectiveResult(),episode=read.records.find(e=>e.id===id);
        if(!episode){if(read.integrityIssues.some(issue=>issue.recordId===id&&!issue.recovered))throw new Error("learning-legacy-target-unavailable");return;}
        if(episode.legacy?.id!==legacy.id||episode.legacy.format!==legacy.format||episode.legacy.revision!==legacy.revision||JSON.stringify(episode.legacy.evidenceIds)!==JSON.stringify(legacy.evidenceIds)||episode.concept!==record.concept||!sameTarget(episode.source,source)||!episode.questions[0]||questionProtectionDigest(episode.questions[0])!==questionProtectionDigest(question))throw new Error("learning-legacy-continuation-conflict");
        return {episode,protectionRevision:read.protectionByEpisode.get(episode.id)?.revision};
      };
      const prior=await existing();await check();
      if(prior)return {status:"continued",...prior,replayed:true};
      const date=this.now(),at=date.toISOString();
      const draft=createEpisodeV3(source,question,{at,requestId,conversationId,invitationId:stableId("tutor-legacy-consent-v3-1",record.format,record.id)},legacy);draft.id=id;
      if(question.pool==="delayed")draft.reviewTasks.push({id:stableId("tutor-legacy-review-v3-1",record.format,record.id),dueAt:at,localDate:`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`,step:0,state:"active",questionId:question.id,dependsOn:[],consumedBy:requestId});
      await check();
      try{const episode=await this.store.save(draft,signal,requestId);return {status:"continued",episode,replayed:false,protectionRevision:this.store.committedProtectionRevision(episode)};}
      catch(error){
        // A different instance may have won the same ancestor's first CAS, or
        // storage may have acknowledged a write with an uncertain transport error.
        await check();const winner=await existing();if(winner)return {status:"continued",...winner,replayed:true};throw error;
      }
    });this.tail=run;return run;
  }
  flush(){return this.tail;}
}
