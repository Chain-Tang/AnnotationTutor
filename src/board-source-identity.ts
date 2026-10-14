import {z} from 'zod';
import type {BoardDraftIO} from './board-draft.js';
import type {BoardDocument} from './board-types.js';
const safePath=(path:string)=>!!path&&!path.startsWith('/')&&!path.includes('\\')&&path.split('/').every(part=>!!part&&part!=='.'&&part!=='..');
const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/),pathSchema=z.string().max(4096).refine(safePath);
const schema=z.object({format:z.literal('tutor-board-source-v1'),root:pathSchema,source:pathSchema,sourceType:z.enum(['markdown','pdf','standalone']),boardId:identifier,
 hasWork:z.boolean(),revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),alternatives:z.array(z.object({id:identifier,hash:z.string().regex(/^[a-f\d]{64}$/)}).strict()).max(32),movedTo:pathSchema.optional()}).strict();
export type BoardSourceIdentity=z.infer<typeof schema>;
const hash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
/** Private source locators carry identity only, never artwork or learner text.
 * CAS creates one identity across processes; unknown/corrupt records cannot reset it. */
export class BoardSourceIdentityStore {
 constructor(private readonly io:BoardDraftIO){}
 public async path(root:string,source:string,type:BoardDocument['sourceType']):Promise<string>{
  if(!safePath(root)||!safePath(source))throw new Error('board-source-target');
  return `board-sources-v1/${await hash(JSON.stringify([root,type,source]))}.json`;
 }
 private parse(raw:string,root:string,source:string,type:BoardDocument['sourceType']):BoardSourceIdentity{
  if(Buffer.byteLength(raw)>65536)throw new Error('board-source-record-size');
  let value:BoardSourceIdentity;try{value=schema.parse(JSON.parse(raw));}catch{throw new Error('board-source-record-invalid');}
  if(value.root!==root||value.source!==source||value.sourceType!==type||value.movedTo===source||
    value.alternatives.some(item=>item.id===value.boardId)||new Set(value.alternatives.map(item=>item.id)).size!==value.alternatives.length||value.movedTo&&value.alternatives.length)
   throw new Error('board-source-target');
  return value;
 }
 public async get(root:string,source:string,type:BoardDocument['sourceType']):Promise<BoardSourceIdentity|null>{
  const raw=await this.io.read(await this.path(root,source,type));return raw===null?null:this.parse(raw,root,source,type);
 }
 private async publish(path:string,raw:string|null,next:BoardSourceIdentity):Promise<void>{
  const value=JSON.stringify(next);this.parse(value,next.root,next.source,next.sourceType);
  if(raw!==null){const previous=await this.io.read(path+'.previous');await this.io.compareWrite(path+'.previous',previous,raw);}
  await this.io.compareWrite(path,raw,value);
  if(await this.io.read(path)!==value)throw new Error('board-source-verification');
 }
 public async claim(root:string,source:string,type:BoardDocument['sourceType'],candidate:string):Promise<string>{
  identifier.parse(candidate);const path=await this.path(root,source,type);
  for(let attempt=0;attempt<8;attempt++){
   const raw=await this.io.read(path);
   if(raw!==null){const current=this.parse(raw,root,source,type);if(current.movedTo)throw new Error('board-source-moved');return current.boardId;}
   try{await this.publish(path,null,{format:'tutor-board-source-v1',root,source,sourceType:type,boardId:candidate,hasWork:false,revision:1,alternatives:[]});return candidate;}
   catch(error){
    if(!(error instanceof Error)||!['state-file-conflict','state-file-locked'].includes(error.message))throw error;
    // A completed competing claim is read immediately. A held lock is never
    // removed or stolen; bounded waiting only permits its owner to publish.
    if(await this.io.read(path)!==null)continue;
    if(attempt===7)throw error;
    await new Promise(resolve=>setTimeout(resolve,Math.min(5*2**attempt,40)));
   }
  }
  throw new Error('board-source-claim-unavailable');
 }
 public async assert(root:string,source:string,type:BoardDocument['sourceType'],boardId:string):Promise<void>{
  if(await this.claim(root,source,type,boardId)!==boardId)throw new Error('board-source-identity-conflict');
 }
 /** Only a verified authority or a complete recovery snapshot establishes work. */
 public async markWork(root:string,source:string,type:BoardDocument['sourceType'],boardId:string):Promise<void>{
  await this.assert(root,source,type,boardId);
  const path=await this.path(root,source,type),raw=await this.io.read(path);
  if(raw===null)throw new Error('board-source-identity-missing');
  const current=this.parse(raw,root,source,type);
  if(current.boardId!==boardId||current.movedTo)throw new Error('board-source-identity-conflict');
  if(!current.hasWork)await this.publish(path,raw,{...current,hasWork:true,revision:current.revision+1});
 }
 public async choose(root:string,source:string,type:BoardDocument['sourceType'],boardId:string,alternatives:BoardSourceIdentity['alternatives'],expectedRevision:number|null):Promise<void>{
  const path=await this.path(root,source,type),raw=await this.io.read(path),current=raw===null?null:this.parse(raw,root,source,type);
  if((current?.revision??null)!==expectedRevision||current?.movedTo)throw new Error('board-source-choice-stale');
  await this.publish(path,raw,{format:'tutor-board-source-v1',root,source,sourceType:type,boardId,hasWork:true,alternatives,revision:(current?.revision??0)+1});
 }
 private async moveState(root:string,before:string,after:string,type:BoardDocument['sourceType'],boardId:string){
  identifier.parse(boardId);
  const oldPath=await this.path(root,before,type),path=await this.path(root,after,type),oldRaw=await this.io.read(oldPath),old=oldRaw===null?null:this.parse(oldRaw,root,before,type);
  if(old&&(old.boardId!==boardId||old.movedTo&&old.movedTo!==after))throw new Error('board-source-identity-conflict');
  if(old?.alternatives.length)throw new Error('board-source-branches-move-required');
  const raw=await this.io.read(path),target=raw===null?null:this.parse(raw,root,after,type);
  if(target&&(target.boardId!==boardId||target.movedTo&&target.movedTo!==before||target.alternatives.length))throw new Error('board-source-identity-conflict');
  return {oldPath,path,oldRaw,old,raw,target};
 }
 /** Reject unsupported or incompatible routing before changing recovery files.
  * The later CAS publications still recheck their actual source revisions. */
 public async validateMove(root:string,before:string,after:string,type:BoardDocument['sourceType'],boardId:string):Promise<void>{
  await this.moveState(root,before,after,type,boardId);
 }
 /** Destination reservation precedes retirement. The draft move remains the
  * resumable coordinator; this metadata alone never permits artwork deletion. */
 public async move(root:string,before:string,after:string,type:BoardDocument['sourceType'],boardId:string):Promise<void>{
  const {oldPath,path,oldRaw,old,raw,target}=await this.moveState(root,before,after,type,boardId);
  if(!target||target.movedTo)await this.publish(path,raw,{format:'tutor-board-source-v1',root,source:after,sourceType:type,boardId,hasWork:old?.hasWork??false,revision:(target?.revision??0)+1,alternatives:[]});
  if(!old?.movedTo)await this.publish(oldPath,oldRaw,{format:'tutor-board-source-v1',root,source:before,sourceType:type,boardId,hasWork:old?.hasWork??false,revision:(old?.revision??0)+1,alternatives:[],movedTo:after});
 }
}
