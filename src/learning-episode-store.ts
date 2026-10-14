import { beginTutorActivity } from "./interaction-activity.js";
import { episodeSchema, lessonFor, type LearningEpisode } from "./learning-episode.js";
import { LearningRecordReader, learningRecordWithinLimit, validCorrectionReferences, type LearningIO, type LearningRecordCommit, type RecordReadResult } from "./learning-record-read.js";
import { saveLearningBackup } from "./learning-record-backup.js";
export type { LearningIO } from "./learning-record-read.js";
const validReferences = (record: LearningEpisode) => {
  const lesson = lessonFor(record.concept), questions = new Set([lesson.question.id, lesson.transfer.id, `${record.concept}-explanation`]);
  return validCorrectionReferences(record.evidence) && record.evidence.every(item => questions.has(item.questionId) || (!!item.corrects && item.questionId === "learner-correction"));
};
/** Independent v1 records, serialized writes, a last-good copy and explicit conflicts. */
export class LearningEpisodeStore {
  private tail:Promise<unknown>=Promise.resolve();
  private reader:LearningRecordReader<LearningEpisode>;
  private writing=new Set<string>();
  private commitListeners=new Set<(change:LearningRecordCommit)=>void>();
  constructor(private readonly io:LearningIO,public readonly root:string){this.reader=new LearningRecordReader(io,root,{format:1,parse:value=>episodeSchema.parse(value),validReferences});}
  listResult():Promise<RecordReadResult<LearningEpisode>>{const run=this.tail.catch(()=>{}).then(async()=>{
    const result=await this.reader.read();
    for(const issue of result.integrityIssues.filter(issue=>issue.recovered)){
      const record=result.records.find(record=>record.id===issue.recordId);if(record)this.committed({recordId:record.id,sources:[...new Set([record.source.path,...(issue.scope?[issue.scope.source]:[])])],unknownScope:false,revision:result.revision});
    }
    return result;
  });this.tail=run;return run;}
  async list():Promise<LearningEpisode[]>{return (await this.listResult()).records;}
  change(path:string){return this.writing.has(path)?Promise.resolve(null):this.reader.change(path);}
  async changed(path:string){return !!await this.change(path);}
  takeIntegrityIssues(){return this.reader.takeIntegrityIssues();}
  subscribeCommits(listener:(change:LearningRecordCommit)=>void){this.commitListeners.add(listener);return()=>{this.commitListeners.delete(listener);};}
  private committed(change:LearningRecordCommit){for(const listener of this.commitListeners)try{listener(change);}catch{/* A notification cannot turn a durable save into a reported failure. */}}
  save(episode:LearningEpisode,requestId?:string):Promise<LearningEpisode>{
    const input=episodeSchema.parse(structuredClone(episode));
    if(!validReferences(input))throw new Error("learning-cross-reference");
    const done=beginTutorActivity();
    const run=this.tail.catch(()=>{}).then(async()=>{
      const path=`${this.root}/${input.id}.json`,previous=await this.io.read(path);
      if(await this.io.read(path+".deleted")!==null)throw new Error("learning-deleted");
      const stored=previous!==null?this.reader.validate(previous,input.id):undefined;
      if((stored?.revision??0)!==input.revision){await this.io.write(`${path}.conflict-${crypto.randomUUID()}`,JSON.stringify(input,null,2));throw new Error("learning-revision-conflict");}
      const next={...input,revision:input.revision+1,updatedAt:new Date().toISOString()},text=JSON.stringify(next,null,2);
      if(!learningRecordWithinLimit(text))throw new Error("learning-record-too-large");
      this.writing.add(path);this.writing.add(path+".previous");
      try{
        if(previous!==null){const backup=await saveLearningBackup(this.io,path,previous,stored!,raw=>this.reader.validate(raw,input.id));this.reader.remember(path+".previous",backup.raw,backup.record);}
        if(await this.io.read(path+".deleted")!==null)throw new Error("learning-deleted");
        await this.io.compareWrite(path,previous,text);this.reader.remember(path,text,next);
      }catch(error){await this.io.write(`${path}.conflict-${crypto.randomUUID()}`,text);throw error;}
      finally{this.writing.delete(path);this.writing.delete(path+".previous");}
      this.committed({recordId:next.id,sources:[...new Set([next.source.path,...(stored?[stored.source.path]:[])])],unknownScope:false,revision:String(next.revision),requestId});return next;
    }).finally(done);this.tail=run;return run;
  }
  async flush(){await this.tail;}
}
