import {z} from 'zod';
import type {LearningIO} from './learning-episode-store.js';
import type {TutorTask} from './tutor-task.js';
import {LearningRecordReader, type RecordReadResult} from './learning-record-read.js';
import {contextVersion} from './teaching-policy.js';
const id=z.string().min(1).max(200),n=z.number().finite().nonnegative();
const savedTask=z.object({id:z.string().uuid(),clientId:id,lead:id,agent:id,parentId:z.string().uuid().optional(),requestKey:id.optional(),
 target:z.object({id,source:z.string().max(1000),revision:id,surface:z.enum(['document','studio','excalidraw'])}).optional(),
 state:z.enum(['queued','working','input-required','completed','failed','cancelled']),phase:z.string().max(500),createdAt:n,updatedAt:n,
 route:z.object({engine:id,model:z.string().max(300)}).optional(),children:z.array(z.string().uuid()).max(6),
 error:z.object({code:id,message:z.string().max(2000)}).optional(),
 metrics:z.object({firstFeedbackMs:n.optional(),firstPreviewMs:n.optional(),completedMs:n.optional(),modelCalls:n,toolCalls:n}),
 artifacts:z.array(z.object({id,type:z.literal('text'),data:z.object({text:z.string().max(60000),reviewStatus:z.enum(['current','stale']).optional(),evidenceRevision:z.string().max(200).optional()})})).max(8)
});
const groupSchema=z.object({format:z.literal(1),root:savedTask,children:z.array(savedTask).max(6)});
type ResultGroup=z.infer<typeof groupSchema>;
type ResultRecord={id:string;source:{path:string};concept:string;updatedAt:string;group:ResultGroup};

/** A saved group is a complete tree, never a collection of independently trusted task handles. */
function validGroup(group:ResultGroup):boolean {
 const all=[group.root,...group.children],byId=new Map(all.map(task=>[task.id,task]));
 if(group.root.parentId||byId.size!==all.length)return false;
 for(const task of all){
  if(task.clientId!==group.root.clientId||task.lead!==group.root.lead)return false;
  const expected=all.filter(child=>child.parentId===task.id).map(child=>child.id);
  if(new Set(task.children).size!==task.children.length||task.children.length!==expected.length||task.children.some(id=>!expected.includes(id)))return false;
  if(task.target&&(!group.root.target||(['id','source','revision','surface'] as const).some(key=>task.target![key]!==group.root.target![key])))return false;
  const seen=new Set([task.id]),agents=new Set([task.agent]);let cursor=task,depth=0;
  while(cursor.parentId){
   const parent=byId.get(cursor.parentId);
   if(!parent||seen.has(parent.id)||agents.has(parent.agent)||++depth>2)return false;
   seen.add(parent.id);agents.add(parent.agent);cursor=parent;
  }
  if(cursor.id!==group.root.id)return false;
 }
 return new Set(all.map(task=>task.agent)).size<=3;
}

export type TutorResultReadResult=Omit<RecordReadResult<ResultRecord>,'records'>&{tasks:TutorTask[]};
/** Explicit expert products only, separate from metadata logs. No prompt/history/support inputs accepted. */
export class TutorResultStore {
 private tail:Promise<unknown>=Promise.resolve();
 private readonly reader:LearningRecordReader<ResultRecord>;
 constructor(private io:LearningIO,readonly root:string){
  this.reader=new LearningRecordReader(io,root,{format:1,maxBytes:1_000_000,
   parse:value=>{const group=groupSchema.parse(value);return {id:group.root.id,source:{path:group.root.target?.source??''},concept:'expert-result',updatedAt:new Date(group.root.updatedAt).toISOString(),group};},
   validReferences:record=>validGroup(record.group)});
 }
 save(root:TutorTask,children:TutorTask[]):Promise<void>{
  const project=(t:TutorTask)=>({...t,artifacts:t.state==='completed'?t.artifacts.filter(a=>a.type==='text'):[],error:t.error?{code:t.error.code,message:t.error.code==='interrupted'?'任务中断，未自动重试。':'专家任务未完成，请检查实际连接。'}:undefined});
  const group=groupSchema.parse({format:1,root:project(root),children:children.map(project)});
  if(!validGroup(group))throw Error('invalid-task-ownership');
  const run=this.tail.catch(()=>{}).then(async()=>{const path=`${this.root}/${root.id}.json`,previous=await this.io.read(path),text=JSON.stringify(group);
   this.reader.validate(text,root.id);
   if(await this.io.read(path+'.deleted')!==null)throw Error('expert-result-deleted');if(previous===text)return;
   if(previous){
    const old=this.reader.validate(previous,root.id).group;
    if(old.root.clientId!==root.clientId)throw Error('invalid-task-ownership');
    if(old.root.updatedAt>group.root.updatedAt)throw Error('expert-result-stale');
    await this.io.write(path+'.previous',previous);
   }
   if(await this.io.read(path+'.deleted')!==null)throw Error('expert-result-deleted');
   await this.io.compareWrite(path,previous,text);
  });this.tail=run;return run;
 }
 async restoreResult():Promise<TutorResultReadResult>{
  await this.tail.catch(()=>{});
  const read=await this.reader.read();
  // A child ID appearing in two valid files is ambiguous even if each local tree is valid.
  const owners=new Map<string,ResultRecord[]>();
  for(const record of read.records)for(const task of [record.group.root,...record.group.children]){const list=owners.get(task.id)??[];list.push(record);owners.set(task.id,list);}
  const excluded=new Set([...owners.values()].filter(list=>list.length>1).flat());
  for(const record of excluded)read.integrityIssues.push({issueId:record.id,recordId:record.id,category:'duplicate-id',recovered:false});
  const groups=read.records.filter(record=>!excluded.has(record)).sort((a,b)=>b.group.root.updatedAt-a.group.root.updatedAt).slice(0,40).reverse();
  return {tasks:groups.flatMap(record=>[record.group.root,...record.group.children]),integrityIssues:read.integrityIssues,
   completeness:excluded.size?'partial':read.completeness,revision:contextVersion(JSON.stringify({revision:read.revision,excluded:[...excluded].map(record=>record.id).sort()}))};
 }
 async restore():Promise<TutorTask[]>{return (await this.restoreResult()).tasks;}
 flush(){return this.tail;}
}
