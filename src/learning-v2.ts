import { z } from "zod";
import { mathPlotSchema } from "./board-math.js";
import { conceptIds, type LearningEpisode } from "./learning-episode.js";
import type { LearningIO } from "./learning-episode-store.js";
import { beginTutorActivity } from "./interaction-activity.js";
import { LearningRecordReader, learningRecordWithinLimit, uniqueIds, validCorrectionReferences, type LearningRecordChange, type LearningRecordCommit, type RecordReadResult } from "./learning-record-read.js";
import { saveLearningBackup } from "./learning-record-backup.js";

const uuid = z.string().uuid();
export const questionInstanceSchema = z.object({
  id: uuid, templateId: z.string().max(100), packVersion: z.enum(["limits-v2-1", "limits-v2-2"]),
  concept: z.enum(conceptIds), pool: z.enum(["practice", "transfer", "delayed"]),
  seed: z.number().int().nonnegative(), parameters: z.record(z.string(), z.number().finite()),
  prompt: z.string().max(4000), kind: z.enum(["number", "choice", "explanation"]),
  answer: z.string().max(1000), choices: z.array(z.string()).max(8).optional(),
  explanation: z.string().max(4000), hint: z.string().max(2000), rubric: z.array(z.string()).max(8),
  hintCount: z.number().int().nonnegative(), answerShown: z.boolean(), math: mathPlotSchema.optional(),
});
export type QuestionInstance = z.infer<typeof questionInstanceSchema>;
export const evidenceV2Schema = z.object({
  id: uuid, requestId: uuid, at: z.string().datetime(), questionId: uuid,
  answer: z.string().max(12000), help: z.object({ hints: z.number().int().nonnegative(), answerShown: z.boolean() }),
  kind: z.enum(["self-report", "hinted", "unassisted", "transfer", "delayed", "explanation"]),
  evaluator: z.enum(["deterministic", "tutor", "learner"]), outcome: z.enum(["correct", "incorrect", "unreviewed"]),
  feedback: z.string().max(4000), corrects: uuid.optional(),
});
export const episodeV2Schema = z.object({
  format: z.literal(2), id: uuid, revision: z.number().int().nonnegative(),
  source: z.object({ path: z.string().max(1000), version: z.string().max(200), annotationId: z.string().optional() }),
  concept: z.enum(conceptIds), consent: z.object({ at: z.string().datetime(), requestId: uuid, conversationId: uuid }),
  legacy: z.object({ id: uuid, revision: z.number().int(), evidenceIds: z.array(uuid).max(500) }).optional(),
  status: z.enum(["active", "paused", "completed", "deleted"]),
  questions: z.array(questionInstanceSchema).min(1).max(100), currentQuestionId: uuid,
  links: z.array(z.object({kind:z.enum(["drawing","expert"]),taskId:uuid,targetId:z.string().max(1000),questionId:uuid,at:z.string().datetime()})).max(500).default([]),
  evidence: z.array(evidenceV2Schema).max(500), requests: z.array(uuid).max(1000),
  reviewDue: z.string().datetime().optional(), reviewStep: z.number().int().min(0).max(3),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type EpisodeV2 = z.infer<typeof episodeV2Schema>;
const validReferences = (record: EpisodeV2) => {
  const questions = new Set(record.questions.map(question => question.id));
  return uniqueIds(record.questions) && validCorrectionReferences(record.evidence) && questions.has(record.currentQuestionId) &&
    record.questions.every(question => question.concept === record.concept) && record.evidence.every(item => questions.has(item.questionId)) &&
    record.links.every(link => questions.has(link.questionId)) && new Set(record.requests).size === record.requests.length;
};
/** v2 historically allowed evidence without a matching deduplication receipt.
 * Read it as authored, but never invent a receipt or use that gap to rewrite it.
 * Both inputs have passed the schema, so the comparison covers entire normalized evidence. */
function validateEvidenceReceipts(value:EpisodeV2,stored?:EpisodeV2):void{
  const historical=new Map((stored?.evidence??[]).filter(item=>!stored!.requests.includes(item.requestId)).map(item=>[item.id,item]));
  for(const previous of historical.values()){
    const retained=value.evidence.find(item=>item.id===previous.id);
    if(retained&&JSON.stringify(retained)!==JSON.stringify(previous))throw new Error("learning-v2-legacy-evidence-changed");
    if(value.requests.includes(previous.requestId))throw new Error("learning-v2-legacy-receipt-backfill");
  }
  for(const item of value.evidence)if(!value.requests.includes(item.requestId)){
    const previous=historical.get(item.id);
    if(!previous||JSON.stringify(previous)!==JSON.stringify(item))throw new Error("learning-v2-evidence-request-missing");
  }
}
export function createEpisodeV2(source: LearningEpisode["source"], question: QuestionInstance,
  consent: EpisodeV2["consent"], legacy?: LearningEpisode): EpisodeV2 {
  return episodeV2Schema.parse({ format: 2, id: crypto.randomUUID(), revision: 0, source,
    concept: question.concept, consent, status: "active", questions: [question], currentQuestionId: question.id,
    evidence: [], requests: [consent.requestId], reviewStep: 0, createdAt: consent.at, updatedAt: consent.at,
    ...(legacy ? { legacy: { id: legacy.id, revision: legacy.revision, evidenceIds: legacy.evidence.map(e => e.id) } } : {}) });
}

/** Separate v2 records. Deletion is a tombstone, so rollback or delayed replies cannot resurrect evidence. */
export class LearningV2Store {
  private tail: Promise<unknown> = Promise.resolve();
  private writing = new Set<string>();
  private reader: LearningRecordReader<EpisodeV2>;
  private generation = 0;
  private sourceEpochs = new Map<string, number>();
  private recordEpochs = new Map<string, number>();
  private commitListeners=new Set<(change:LearningRecordCommit)=>void>();
  epoch = 0;
  constructor(readonly io: LearningIO, readonly root: string) {
    this.reader = new LearningRecordReader(io, root, {format:2,parse:value=>episodeV2Schema.parse(value),validReferences});
  }
  invalidate(change?: Pick<LearningRecordChange,"sources"|"unknownScope"> & {recordId?:string}) {
    this.epoch++;
    if(!change || change.unknownScope)this.generation++;
    else {
      for(const source of change.sources)this.sourceEpochs.set(source,(this.sourceEpochs.get(source)??0)+1);
      if(change.recordId)this.recordEpochs.set(change.recordId,(this.recordEpochs.get(change.recordId)??0)+1);
    }
  }
  epochFor(source:string,recordId?:string) {return this.generation+(this.sourceEpochs.get(source)??0)+(recordId?this.recordEpochs.get(recordId)??0:0);}
  async change(path:string):Promise<LearningRecordChange|null>{
    if(this.writing.has(path))return null;
    const change=await this.reader.change(path);if(change)this.invalidate(change);return change;
  }
  async changed(path:string):Promise<boolean>{return !!await this.change(path);}
  listResult():Promise<RecordReadResult<EpisodeV2>>{const run=this.tail.catch(()=>{}).then(async()=>{
    const result=await this.reader.read();
    for(const issue of result.integrityIssues.filter(issue=>issue.recovered)){
      const record=result.records.find(record=>record.id===issue.recordId);if(record){
        const change={recordId:record.id,sources:[...new Set([record.source.path,...(issue.scope?[issue.scope.source]:[])])],unknownScope:false,revision:result.revision};
        this.invalidate(change);this.committed(change);
      }
    }
    return result;
  });this.tail=run;return run;}
  async list():Promise<EpisodeV2[]>{return (await this.listResult()).records;}
  takeIntegrityIssues(){return this.reader.takeIntegrityIssues();}
  subscribeCommits(listener:(change:LearningRecordCommit)=>void){this.commitListeners.add(listener);return()=>{this.commitListeners.delete(listener);};}
  private committed(change:LearningRecordCommit){for(const listener of this.commitListeners)try{listener(change);}catch{/* A notification cannot turn a durable save into a reported failure. */}}
  save(input: EpisodeV2, signal?: AbortSignal, requestId?:string): Promise<EpisodeV2> {
    const value = episodeV2Schema.parse(structuredClone(input)), epoch = this.epochFor(input.source.path,input.id);
    if(!validReferences(value))throw new Error("learning-v2-cross-reference");
    const done = beginTutorActivity();
    const run = this.tail.catch(() => {}).then(async () => {
      const path = `${this.root}/${value.id}.json`, previous = await this.io.read(path);
      if (signal?.aborted || epoch !== this.epochFor(value.source.path,value.id)) throw new DOMException("Learning context changed", "AbortError");
      if (await this.io.read(path + ".deleted")!==null) throw new Error("learning-v2-deleted");
      const stored = previous!==null ? this.reader.validate(previous,value.id) : undefined;
      // Reject invalid new/rewritten evidence before creating any candidate
      // conflict file, even if another store already advanced the revision.
      validateEvidenceReceipts(value,stored);
      if ((stored?.revision ?? 0) !== value.revision || stored?.status === "deleted") {
        await this.io.write(`${path}.conflict-${crypto.randomUUID()}`, JSON.stringify(value));
        throw new Error("learning-v2-revision-conflict");
      }
      const next = { ...value, revision: value.revision + 1, updatedAt: new Date().toISOString() };
      const text = JSON.stringify(next, null, 2);
      if(!learningRecordWithinLimit(text))throw new Error("learning-record-too-large");
      const change={recordId:next.id,sources:[...new Set([next.source.path,...(stored?[stored.source.path]:[])])],unknownScope:false,revision:String(next.revision),requestId};
      let deletionBarrierSaved=false;
      this.writing.add(path);
      this.writing.add(path+".previous");this.writing.add(path+".deleted");
      try {
        if (next.status === "deleted") {
          const deleted=JSON.stringify({id:next.id,at:next.updatedAt});
          await this.io.write(path + ".deleted", deleted);this.reader.remember(path+".deleted",deleted,next);
          deletionBarrierSaved=true;
          const backup=await saveLearningBackup(this.io,path,text,next,raw=>this.reader.validate(raw,value.id));this.reader.remember(path+".previous",backup.raw,backup.record);
        } else if (previous!==null) {const backup=await saveLearningBackup(this.io,path,previous,stored!,raw=>this.reader.validate(raw,value.id));this.reader.remember(path+".previous",backup.raw,backup.record);}
        if (signal?.aborted || epoch !== this.epochFor(value.source.path,value.id)) throw new DOMException("Learning context changed", "AbortError");
        if(next.status!=="deleted" && await this.io.read(path+".deleted")!==null)throw new Error("learning-v2-deleted");
        await this.io.compareWrite(path, previous, text); this.reader.remember(path, text, next);
      } catch(error) {
        // The durable deletion barrier already excludes the evidence, even if the
        // following record write fails. Cached readers must stop using it now.
        if(deletionBarrierSaved){this.invalidate(change);this.committed(change);}
        throw error;
      } finally { this.writing.delete(path);this.writing.delete(path+".previous");this.writing.delete(path+".deleted"); }
      this.invalidate(change);this.committed(change); return next;
    }).finally(done);
    this.tail = run; return run;
  }
  async remove(id: string) {
    const record = (await this.list()).find(e => e.id === id);
    if (record && record.status !== "deleted") await this.save({ ...record, status: "deleted", evidence: [] });
  }
  flush() { return this.tail; }
}
