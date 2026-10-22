import {z} from 'zod';
import type {TutorTask} from './tutor-task.js';
import type {BoardStorageAdapter} from './board-store.js';
import type {RemoteTaskLink} from './tutor-a2a-client.js';
const id=z.string().min(1).max(200),number=z.number().finite().nonnegative();
const summarySchema=z.object({id,clientId:id,lead:id,agent:id,parentId:id.optional(),target:z.object({id,revision:z.string().max(200),surface:z.enum(['studio','document','excalidraw'])}).optional(),state:z.enum(['queued','working','input-required','completed','failed','cancelled']),phase:z.string().max(500),route:z.object({engine:id,model:z.string().max(300)}).optional(),metrics:z.object({firstFeedbackMs:number.optional(),firstPreviewMs:number.optional(),completedMs:number.optional(),modelCalls:number,toolCalls:number}),createdAt:number,updatedAt:number,artifactCount:number,errorCode:z.string().max(200).optional()});
const remoteSchema=z.object({endpoint:z.string().url().max(2048).refine(s=>{const u=new URL(s);return !u.username&&!u.password&&!u.search&&!u.hash;}),localId:z.string().uuid(),remoteId:id,updatedAt:number});
/** Separate bounded manifests; intentionally no prompts, screenshots, credentials or raw responses. */
export class TutorJournal {
  private tail:Promise<unknown>=Promise.resolve();private loaded=false;
  private latest=new Map<string,z.infer<typeof summarySchema>>();private remotes=new Map<string,RemoteTaskLink>();
  constructor(private adapter:BoardStorageAdapter,private root:string){}
  private async folder(){let path='';for(const part of `${this.root}/tasks`.split('/')){path=path?`${path}/${part}`:part;if(!await this.adapter.exists(path))await this.adapter.mkdir(path);}return path;}
  private async load(){
    if(this.loaded)return;
    const read=async(file:string)=>{const path=`${this.root}/tasks/${file}`;if(!await this.adapter.exists(path))return [];const raw=await this.adapter.read(path);if(raw.length>1_000_000)throw new Error('task-journal-too-large');const data=JSON.parse(raw);return Array.isArray(data.entries)?data.entries.slice(-200):[];};
    for(const value of await read('task-index.json')){const parsed=summarySchema.safeParse(value);if(parsed.success)this.latest.set(parsed.data.id,parsed.data);}
    for(const value of await read('remote-index.json')){const parsed=remoteSchema.safeParse(value);if(parsed.success)this.remotes.set(parsed.data.localId,parsed.data);}
    this.loaded=true;
  }
  private enqueue<T>(run:()=>Promise<T>):Promise<T>{const next=this.tail.catch(()=>{}).then(async()=>{await this.load();return run();});this.tail=next;return next;}
  record(task:TutorTask):Promise<void>{
    const summary=summarySchema.parse({id:task.id,clientId:task.clientId,lead:task.lead,agent:task.agent,parentId:task.parentId,target:task.target?{id:task.target.id,revision:task.target.revision,surface:task.target.surface}:undefined,state:task.state,phase:task.phase,route:task.route,metrics:task.metrics,createdAt:task.createdAt,updatedAt:task.updatedAt,artifactCount:task.artifacts.length,errorCode:task.error?.code});
    return this.enqueue(async()=>{this.latest.delete(task.id);this.latest.set(task.id,summary);if(this.latest.size>200)this.latest.delete(this.latest.keys().next().value!);const folder=await this.folder();await this.adapter.write(`${folder}/task-index.json`,JSON.stringify({format:'tutor-task-index-v1',entries:[...this.latest.values()]}));});
  }
  async rememberRemote(link:RemoteTaskLink):Promise<void>{const parsed=remoteSchema.parse(link);return this.enqueue(async()=>{this.remotes.delete(parsed.localId);this.remotes.set(parsed.localId,parsed);if(this.remotes.size>200)this.remotes.delete(this.remotes.keys().next().value!);const folder=await this.folder();await this.adapter.write(`${folder}/remote-index.json`,JSON.stringify({format:'tutor-remote-index-v1',entries:[...this.remotes.values()]}));});}
  remote(id:string):Promise<RemoteTaskLink|undefined>{return this.enqueue(async()=>{const record=this.remotes.get(id);return record?structuredClone(record):undefined;});}
  flush(){return this.tail;}
}
