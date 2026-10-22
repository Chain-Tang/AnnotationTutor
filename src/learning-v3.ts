import { z } from "zod";
import { conceptIds, type ConceptId } from "./learning-episode.js";
import { instantiateQuestion, questionTemplates } from "./learning-question-bank-v2-2.js";
import { gradeCanonicalAnswer, mathAnswerSchema } from "./learning-answer.js";
import { LearningRecordReader, uniqueIds, validCorrectionReferences, type LearningIO, type LearningRecordCommit, type LearningRecordChange, type RecordReadResult } from "./learning-record-read.js";
import { beginTutorActivity } from "./interaction-activity.js";
import { saveLearningBackup } from "./learning-record-backup.js";
import { LearningProtectionStore, allocateFreshQuestionRef, carryFreshQuestionCapability, freshQuestionToken, protectionDigest, questionIndependence, questionProtectionDigest, questionContentDigest, type ProtectionSnapshot } from "./learning-protection.js";

export const LEARNING_V3_PACK = "limits-v3-1" as const;
export const LEARNING_V3_MAX_BYTES = 512 * 1024;
const uuid=z.string().uuid(),stamp=z.string().datetime(),revision=z.number().int().nonnegative();
const token=z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const templates=new Set(questionTemplates.map(t=>t.id));
export const criterionIds=["point-versus-limit","one-sided-agreement","input-output-neighborhood","removable-extension","finite-jump","continuity-conditions"] as const;
export const conceptCriterion:Record<ConceptId,typeof criterionIds[number]>={"value-limit":"point-versus-limit","one-sided":"one-sided-agreement",neighborhood:"input-output-neighborhood",removable:"removable-extension",jump:"finite-jump",continuity:"continuity-conditions"};
export const questionRefV3Schema=z.object({id:uuid,packVersion:z.literal(LEARNING_V3_PACK),templateId:z.string().max(80).refine(id=>templates.has(id)),concept:z.enum(conceptIds),pool:z.enum(["practice","transfer","delayed"]),seed:z.number().int().min(0).max(1e6)}).strict();
export type QuestionRefV3=z.infer<typeof questionRefV3Schema>;
export function questionRefV3(concept:ConceptId,pool:QuestionRefV3["pool"],seed=0,id?:string):QuestionRefV3 {
  if(id===undefined){const ref=allocateFreshQuestionRef(concept,pool,seed);questionRefV3Schema.parse(ref);return ref;}
  const q=instantiateQuestion(concept,pool,seed);
  return questionRefV3Schema.parse({id,concept,pool,seed,packVersion:LEARNING_V3_PACK,templateId:q.templateId});
}
/** Question prose, answers, explanations and plots are reconstructed by the host. */
export function renderQuestionV3(ref:QuestionRefV3){
  const value=questionRefV3Schema.parse(ref),q=instantiateQuestion(value.concept,value.pool,value.seed);
  if(q.templateId!==value.templateId)throw new Error("learning-v3-question-mismatch");
  return {...q,id:value.id};
}
const sequence=z.number().int().min(1).max(10000);
const helpSchema=z.object({id:uuid,requestId:uuid,questionId:uuid,at:stamp,sequence,kind:z.enum(["hint","solution","related-discussion","diagram"]),state:z.enum(["prepared","presented","unknown"]),presentationId:uuid,transactionId:token.optional()}).strict();
export type HelpExposureV3=z.infer<typeof helpSchema>;
const common={id:uuid,requestId:uuid,questionId:uuid,at:stamp,sequence};
export const evidenceV3Schema=z.discriminatedUnion("type",[
  z.object({...common,type:z.literal("answer"),answer:mathAnswerSchema,evaluator:z.literal("deterministic"),outcome:z.enum(["correct","incorrect"]),independence:z.enum(["no-plugin-help","helped","unknown"]),helpIds:z.array(uuid).max(500)}).strict(),
  z.object({...common,type:z.literal("judgment"),evaluator:z.literal("tutor"),outcome:z.literal("unreviewed"),criteria:z.array(z.object({id:z.enum(criterionIds),state:z.enum(["supported","needs-review","uncertain"])}).strict()).min(1).max(6),helpIds:z.array(uuid).max(500)}).strict(),
  z.object({...common,type:z.literal("correction"),evaluator:z.literal("learner"),outcome:z.literal("unreviewed"),corrects:uuid}).strict(),
]);
export type EvidenceV3=z.infer<typeof evidenceV3Schema>;
export const episodeV3Schema=z.object({
  format:z.literal(3),id:uuid,revision,
  source:z.object({path:z.string().min(1).max(1000),version:token,annotationId:token.optional()}).strict(),concept:z.enum(conceptIds),
  consent:z.object({at:stamp,requestId:uuid,conversationId:uuid,invitationId:uuid}).strict(),
  legacy:z.object({format:z.union([z.literal(1),z.literal(2)]),id:uuid,revision,evidenceIds:z.array(uuid).max(500)}).strict().optional(),
  status:z.enum(["active","paused","completed","deleted"]),questions:z.array(questionRefV3Schema).min(1).max(100),currentQuestionId:uuid,
  evidence:z.array(evidenceV3Schema).max(500),help:z.array(helpSchema).max(500),requests:z.array(uuid).max(2000),
  reviewTasks:z.array(z.object({id:uuid,dueAt:stamp,localDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),step:z.number().int().min(0).max(3),state:z.enum(["scheduled","active","completed","invalidated"]),questionId:uuid.optional(),dependsOn:z.array(uuid).max(500),consumedBy:uuid.optional()}).strict()).max(100),
  links:z.array(z.object({kind:z.enum(["drawing","expert"]),taskId:uuid,targetId:token,questionId:uuid,at:stamp,evidenceIds:z.array(uuid).max(500),state:z.enum(["current","needs-review"])}).strict()).max(500),
  createdAt:stamp,updatedAt:stamp,
}).strict();
export type EpisodeV3=z.infer<typeof episodeV3Schema>;

function referencesValid(e:EpisodeV3):boolean {
  if(!uniqueIds(e.questions)||!uniqueIds(e.evidence)||!uniqueIds(e.help)||!uniqueIds(e.reviewTasks)||new Set(e.requests).size!==e.requests.length||!validCorrectionReferences(e.evidence))return false;
  const questions=new Map(e.questions.map(q=>[q.id,q])),evidence=new Map(e.evidence.map(x=>[x.id,x])),help=new Map(e.help.map(x=>[x.id,x]));
  const events=[...e.evidence,...e.help];if(new Set(events.map(x=>x.sequence)).size!==events.length||!uniqueIds(events))return false;
  if(!questions.has(e.currentQuestionId)||!e.requests.includes(e.consent.requestId))return false;
  try{for(const q of e.questions){if(q.concept!==e.concept)return false;renderQuestionV3(q);}}catch{return false;}
  for(const item of [...e.evidence,...e.help])if(!questions.has(item.questionId)||!e.requests.includes(item.requestId))return false;
  for(const item of e.evidence){
    if(item.type==="correction"){if(evidence.get(item.corrects)?.questionId!==item.questionId||evidence.get(item.corrects)!.sequence>=item.sequence)return false;continue;}
    if(new Set(item.helpIds).size!==item.helpIds.length||item.helpIds.some(id=>help.get(id)?.questionId!==item.questionId||help.get(id)!.sequence>=item.sequence))return false;
    const preceding=e.help.filter(h=>h.questionId===item.questionId&&h.sequence<item.sequence);
    if(preceding.some(h=>!item.helpIds.includes(h.id)))return false;
    if(item.type==="judgment"){if(item.criteria.some(c=>c.id!==conceptCriterion[e.concept])||new Set(item.criteria.map(c=>c.id)).size!==item.criteria.length)return false;continue;}
    const q=renderQuestionV3(questions.get(item.questionId)!);
    if(q.kind!==item.answer.kind||item.answer.kind==="choice"&&!q.choices?.[item.answer.index])return false;
    if((gradeCanonicalAnswer(q,item.answer)?"correct":"incorrect")!==item.outcome)return false;
    if(item.independence==="no-plugin-help"&&preceding.length)return false;
    if(item.independence==="helped"&&!preceding.some(h=>h.state==="presented"))return false;
  }
  for(const task of e.reviewTasks){if(task.dependsOn.some(id=>!evidence.has(id))||task.questionId&&!questions.has(task.questionId)||task.consumedBy&&!e.requests.includes(task.consumedBy))return false;if(task.state==="active"&&(!task.questionId||!task.consumedBy))return false;}
  for(const link of e.links)if(!questions.has(link.questionId)||link.evidenceIds.some(id=>!evidence.has(id)))return false;
  return true;
}
export function parseEpisodeV3(input:unknown):EpisodeV3 {
  let value:EpisodeV3;try{value=episodeV3Schema.parse(input);}catch{throw new Error("learning-v3-schema-invalid");}
  if(!referencesValid(value))throw new Error("learning-v3-reference-invalid");
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>LEARNING_V3_MAX_BYTES)throw new Error("learning-v3-record-too-large");
  return value;
}
export function createEpisodeV3(source:EpisodeV3["source"],question:QuestionRefV3,consent:EpisodeV3["consent"],legacy?:EpisodeV3["legacy"]):EpisodeV3 {
  const episode=parseEpisodeV3({format:3,id:crypto.randomUUID(),revision:0,source,concept:question.concept,consent,...(legacy?{legacy}:{}),status:"active",questions:[question],currentQuestionId:question.id,evidence:[],help:[],requests:[consent.requestId],reviewTasks:[],links:[],createdAt:consent.at,updatedAt:consent.at});
  carryFreshQuestionCapability(question,episode.questions[0]!);return episode;
}
export const nextLearningSequence=(e:EpisodeV3)=>Math.max(0,...e.evidence.map(x=>x.sequence),...e.help.map(x=>x.sequence))+1;
export type EffectiveV3ReadResult=RecordReadResult<EpisodeV3>&{protectionByEpisode:ReadonlyMap<string,ProtectionSnapshot>};

/** Independent v3 files; validation occurs before every write, including
 * backups/conflicts. Old text-bearing formats are not rewritten or imported. */
export class LearningV3Store {
  private tail:Promise<unknown>=Promise.resolve();
  private readonly commitProtection=new WeakMap<EpisodeV3,string>();
  committedProtectionRevision(record:EpisodeV3):string|undefined{return this.commitProtection.get(record);}
  private reader:LearningRecordReader<EpisodeV3>;
  private writing=new Set<string>();private generation=0;private epochs=new Map<string,number>();
  private protectionRevisions=new Map<string,string>();private sources=new Map<string,string>();
  readonly protection:LearningProtectionStore;
  private listeners=new Set<(change:LearningRecordCommit)=>void>();
  constructor(readonly io:LearningIO,readonly root:string){
    this.protection=new LearningProtectionStore(io,root,(raw,id)=>this.reader.validate(raw,id));
    this.reader=new LearningRecordReader(io,root,{format:3,maxBytes:LEARNING_V3_MAX_BYTES,parse:value=>episodeV3Schema.parse(value),validReferences:referencesValid,beforeRecover:async({recordId,backup})=>{
      const path=this.protection.path(recordId);this.writing.add(path);this.sources.set(recordId,backup.source.path);
      const before=(await this.protection.read(recordId)).revision;
      try{return await this.protection.beforeEpisodeRecovery({episodeId:recordId,backup});}
      finally{const after=(await this.protection.read(recordId)).revision;this.protectionRevisions.set(recordId,after);this.writing.delete(path);if(after!==before)this.committed({recordId,sources:[backup.source.path],unknownScope:false,revision:after});}
    }});
  }
  epochFor(source:string,id?:string){return this.generation+(this.epochs.get(source)??0)+(id?this.epochs.get(id)??0:0);}
  invalidate(change?:Pick<LearningRecordChange,"sources"|"unknownScope">&{recordId?:string}){if(!change||change.unknownScope)this.generation++;else for(const key of [...change.sources,...(change.recordId?[change.recordId]:[])])this.epochs.set(key,(this.epochs.get(key)??0)+1);}
  subscribeCommits(fn:(change:LearningRecordCommit)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  private committed(change:LearningRecordCommit){this.invalidate(change);for(const fn of this.listeners)try{fn(change);}catch{/* Durable writes remain successful. */}}
  async change(path:string){
    if(this.writing.has(path))return null;
    const recordId=this.protection.episodeIdForPath(path);
    if(recordId){
      const protection=await this.protection.read(recordId);
      if(this.protectionRevisions.get(recordId)===protection.revision)return null;
      this.protectionRevisions.set(recordId,protection.revision);
      const sources=new Set<string>();const known=this.sources.get(recordId);if(known)sources.add(known);
      try{const raw=await this.io.read(`${this.root}/${recordId}.json`);if(raw!==null){const source=this.reader.validate(raw,recordId).source.path;sources.add(source);this.sources.set(recordId,source);}}catch{/* Unknown scope invalidates conservatively. */}
      const change={recordId,sources:[...sources],unknownScope:!sources.size,revision:protection.revision};this.invalidate(change);return change;
    }
    const change=await this.reader.change(path);if(change)this.invalidate(change);return change;
  }
  private async readRecords(){const result=await this.reader.read();for(const e of result.records)this.sources.set(e.id,e.source.path);for(const issue of result.integrityIssues.filter(i=>i.recovered)){const e=result.records.find(e=>e.id===issue.recordId);if(e)this.committed({recordId:e.id,sources:[e.source.path],unknownScope:false,revision:result.revision});}return result;}
  listResult(){const run=this.tail.catch(()=>{}).then(()=>this.readRecords());this.tail=run;return run;}
  readEffectiveResult():Promise<EffectiveV3ReadResult>{
    const run=this.tail.catch(()=>{}).then(async()=>{
      const result=await this.readRecords(),protectionByEpisode=new Map<string,ProtectionSnapshot>();
      const records:EpisodeV3[]=[];
      for(const episode of result.records){
        const snapshot=await this.protection.read(episode.id);
        try{if(await this.io.read(`${this.root}/${episode.id}.json.deleted`)!==null)continue;}
        catch{result.integrityIssues.push({issueId:protectionDigest(`${episode.id}:deletion-check-unavailable`),recordId:episode.id,category:"read-failed",recovered:false,scope:{source:episode.source.path,annotationId:episode.source.annotationId,concept:episode.concept}});continue;}
        records.push(episode);protectionByEpisode.set(episode.id,snapshot);
        // Establish the first observation, but never swallow a later external
        // revision that still needs to invalidate readers via the watch path.
        if(!this.protectionRevisions.has(episode.id))this.protectionRevisions.set(episode.id,snapshot.revision);
        if(snapshot.status!=="valid"||episode.questions.some(q=>{const p=snapshot.questions.get(q.id);return p?.questionDigest!==questionProtectionDigest(q)||p?.contentDigest!==questionContentDigest(q);}))result.integrityIssues.push({issueId:protectionDigest(`${episode.id}:${snapshot.revision}`),recordId:episode.id,category:"protection-unavailable",recovered:false,scope:{source:episode.source.path,annotationId:episode.source.annotationId,concept:episode.concept}});
      }
      return {...result,records,protectionByEpisode,completeness:result.integrityIssues.some(i=>!i.recovered)&&result.completeness!=="unavailable"?"partial" as const:result.completeness,revision:protectionDigest(JSON.stringify([result.revision,records.map(e=>e.id),result.integrityIssues,[...protectionByEpisode].map(([id,p])=>[id,p.revision])]))};
    });this.tail=run;return run;
  }
  async list(){return (await this.listResult()).records;}
  takeIntegrityIssues(){return this.reader.takeIntegrityIssues();}
  save(input:EpisodeV3,signal?:AbortSignal,requestId?:string):Promise<EpisodeV3>{
    const value=parseEpisodeV3(structuredClone(input)),epoch=this.epochFor(value.source.path,value.id),done=beginTutorActivity();
    const fresh=new Map(input.questions.map(q=>[q.id,freshQuestionToken(q)]));
    const run=this.tail.catch(()=>{}).then(async()=>{
      const path=`${this.root}/${value.id}.json`,raw=await this.io.read(path);
      const current=()=>{if(signal?.aborted||epoch!==this.epochFor(value.source.path,value.id))throw new DOMException("Learning context changed","AbortError");};current();
      if(await this.io.read(path+".deleted")!==null)throw new Error("learning-v3-deleted");
      const stored=raw===null?undefined:this.reader.validate(raw,value.id);
      if((stored?.revision??0)!==value.revision)throw new Error("learning-v3-revision-conflict");
      if(stored){
        if(stored.concept!==value.concept||stored.createdAt!==value.createdAt||JSON.stringify(stored.consent)!==JSON.stringify(value.consent)||JSON.stringify(stored.legacy)!==JSON.stringify(value.legacy))throw new Error("learning-v3-identity-is-immutable");
        for(const question of stored.questions)if(JSON.stringify(value.questions.find(q=>q.id===question.id))!==JSON.stringify(question))throw new Error("learning-v3-question-is-immutable");
      }
      if(stored&&value.status!=="deleted"){
        // A scoring undo or cancellation cannot erase already prepared help.
        for(const old of stored.help){const next=value.help.find(h=>h.id===old.id);if(!next||JSON.stringify({...next,state:old.state})!==JSON.stringify(old)||old.state==="presented"&&next.state!=="presented"||old.state==="unknown"&&next.state==="prepared")throw new Error("learning-v3-help-is-monotonic");}
        for(const old of stored.evidence)if(JSON.stringify(value.evidence.find(x=>x.id===old.id))!==JSON.stringify(old))throw new Error("learning-v3-evidence-is-append-only");
        const last=nextLearningSequence(stored)-1,oldIds=new Set([...stored.help,...stored.evidence].map(x=>x.id));
        if([...value.help,...value.evidence].some(x=>!oldIds.has(x.id)&&x.sequence<=last))throw new Error("learning-v3-event-order");
        if(stored.requests.some(id=>!value.requests.includes(id)))throw new Error("learning-v3-receipt-removal");
      }
      const next=parseEpisodeV3({...value,revision:value.revision+1,updatedAt:new Date().toISOString()}),text=JSON.stringify(next,null,2);
      if(new TextEncoder().encode(text).byteLength>LEARNING_V3_MAX_BYTES)throw new Error("learning-v3-record-too-large");
      const change={recordId:next.id,sources:[...new Set([next.source.path,...(stored?[stored.source.path]:[])])],unknownScope:false,revision:String(next.revision),requestId};
      this.sources.set(next.id,next.source.path);
      for(const suffix of ["",".previous",".deleted"])this.writing.add(path+suffix);
      const protectionPath=this.protection.path(next.id);this.writing.add(protectionPath);
      let barrier=false,primaryApplied=false,protectionBefore:string|undefined,protectionAcknowledged:ProtectionSnapshot|undefined;
      try{
        if(next.status!=="deleted"){
          let snapshot=await this.protection.read(next.id);protectionBefore=snapshot.revision;
          const baseline=this.protectionRevisions.get(next.id);
          if(baseline!==undefined&&baseline!==snapshot.revision){this.protectionRevisions.set(next.id,snapshot.revision);this.committed({...change,requestId:undefined,revision:snapshot.revision});current();}
          protectionAcknowledged=snapshot;
          if(snapshot.status!=="valid"&&snapshot.status!=="missing")throw new Error(`learning-protection-${snapshot.status}`);
          for(const question of next.questions){
            const guard=snapshot.questions.get(question.id);
            if(guard){if(guard.questionDigest!==questionProtectionDigest(question)||guard.contentDigest!==questionContentDigest(question))throw new Error("learning-protection-question-mismatch");continue;}
            const token=fresh.get(question.id);
            if(!stored?.questions.some(q=>q.id===question.id)&&token)snapshot=await this.protection.registerFreshQuestion({episodeId:next.id,question,token},signal);
            else snapshot=await this.protection.block({episodeId:next.id,questions:[{ref:question,fromSequence:1}],reason:"protection-rebuilt"},signal);
            protectionAcknowledged=snapshot;
          }
          const helped=next.questions.flatMap(ref=>{const sequences=next.help.filter(h=>h.questionId===ref.id).map(h=>h.sequence);return sequences.length?[{ref,fromSequence:Math.min(...sequences)}]:[];});
          if(helped.length)snapshot=await this.protection.block({episodeId:next.id,questions:helped,reason:"help-prepared"},signal);
          protectionAcknowledged=snapshot;
          for(const answer of next.evidence)if(answer.type==="answer"&&answer.independence==="no-plugin-help"&&!stored?.evidence.some(e=>e.id===answer.id)&&questionIndependence(next,answer.questionId,answer.sequence,snapshot)!=="no-plugin-help")throw new Error("learning-v3-independence-unverified");
          current();
        }
        if(next.status==="deleted"){const tombstone=JSON.stringify({id:next.id,at:next.updatedAt});await this.io.write(path+".deleted",tombstone);this.reader.remember(path+".deleted",tombstone,next);barrier=true;const backup=await saveLearningBackup(this.io,path,text,next,text=>this.reader.validate(text,value.id));this.reader.remember(path+".previous",backup.raw,backup.record);}
        else if(raw!==null){const backup=await saveLearningBackup(this.io,path,raw,stored!,text=>this.reader.validate(text,value.id));this.reader.remember(path+".previous",backup.raw,backup.record);}
        current();if(next.status!=="deleted"&&await this.io.read(path+".deleted")!==null)throw new Error("learning-v3-deleted");
        current();
        await this.io.compareWrite(path,raw,text);primaryApplied=true;
        if(next.status!=="deleted"&&await this.io.read(path+".deleted")!==null)throw new Error("learning-v3-deleted");
        // Once CAS has committed, cancellation only stops presentation. Callers
        // still receive the durable record and its commit notification.
        this.reader.remember(path,text,next);
      }catch(error){const snapshot=await this.protection.read(next.id);if(barrier||primaryApplied||protectionBefore!==undefined&&snapshot.revision!==protectionBefore)this.committed({...change,revision:snapshot.revision});throw error;}
      finally{
        const latest=await this.protection.read(next.id);
        if(protectionAcknowledged)this.protectionRevisions.set(next.id,protectionAcknowledged.revision);
        for(const suffix of ["",".previous",".deleted"])this.writing.delete(path+suffix);this.writing.delete(protectionPath);
        if(protectionAcknowledged&&latest.revision!==protectionAcknowledged.revision){this.protectionRevisions.set(next.id,latest.revision);this.committed({...change,requestId:undefined,revision:latest.revision});}
      }
      if(protectionAcknowledged)this.commitProtection.set(next,protectionAcknowledged.revision);
      this.committed(change);return next;
    }).finally(done);this.tail=run;return run;
  }
  async remove(id:string){const e=(await this.list()).find(e=>e.id===id);if(e)await this.save({...e,status:"deleted",evidence:[],help:[],reviewTasks:[],links:[]});}
  flush(){return this.tail;}
}
