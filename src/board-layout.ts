/** Display-only attachments. Geometry v5 and original ink remain the authority. */
import { z } from "zod";
import { boardLayoutDigest as surfaceDigest } from "./board-layout-digest.js";
import { objectClientBounds, rectUnion } from "./board-placement.js";
import type { BoardDocument, BoardMatrix, BoardObject, BoardRect } from "./board-types.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const matrix = z.tuple([z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite()]);
const binding = z.object({ objectId:id, digests:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100), matrix }).strict();
const slot = z.object({ id, anchorKey:z.string().min(1).max(512), groupId:z.string().min(1).max(160), order:z.number().int().nonnegative(), bindings:z.array(binding).max(100_000) }).strict();
export const boardLayoutSchema = z.object({ format:z.literal("tutor-board-layout-v1"),boardId:id,revision:z.number().int().nonnegative(),slots:z.array(slot).max(10_000),legacyNoticeShown:z.boolean() }).strict().superRefine((value,ctx)=>{
  const slots=new Set<string>(),objects=new Set<string>();
  for(const item of value.slots){if(slots.has(item.id))ctx.addIssue({code:"custom",message:"duplicate-layout-slot"});slots.add(item.id);
    for(const member of item.bindings){if(objects.has(member.objectId))ctx.addIssue({code:"custom",message:"duplicate-layout-binding"});objects.add(member.objectId);
      const m=member.matrix;if(Math.abs(m[0]*m[3]-m[1]*m[2])<1e-12)ctx.addIssue({code:"custom",message:"singular-layout-binding"});}}
});
export type BoardLayoutManifest=z.infer<typeof boardLayoutSchema>;
export type BoardLayoutSlot=BoardLayoutManifest["slots"][number];
export type BoardSlotSpec={id:string;anchorKey:string;width:number;height:number};
export const layoutObjectDigest=(object:BoardObject):string=>surfaceDigest(object);

export class BoardLayoutState {
  private state:BoardLayoutManifest;
  private observed=-1;
  private active=new Map<string,{slot:BoardLayoutSlot;matrix:BoardMatrix}>();
  constructor(boardId:string,saved?:BoardLayoutManifest){this.state=saved?boardLayoutSchema.parse(saved):{format:"tutor-board-layout-v1",boardId,revision:0,slots:[],legacyNoticeShown:false};if(this.state.boardId!==boardId)throw Error("layout-board-mismatch");}
  get revision():number{return this.state.revision;}
  snapshot():BoardLayoutManifest{return structuredClone(this.state);}
  restore(snapshot:unknown):void{
    const next=boardLayoutSchema.parse(snapshot);if(next.boardId!==this.state.boardId)throw Error("layout-board-mismatch");
    next.revision=this.state.revision+1;next.legacyNoticeShown ||= this.state.legacyNoticeShown;
    this.state=next;this.observed=-1;this.active.clear();
  }
  /** Called once per committed revision, never for each pointer sample. */
  reconcile(document:Readonly<BoardDocument>,trusted=false,locatedAnchors?:ReadonlySet<string>):boolean{
    if(document.id!==this.state.boardId)throw Error("layout-board-mismatch");
    if(this.observed===document.revision&&!trusted)return false;
    const before=JSON.stringify(this.state),byId=new Map(document.objects.map(o=>[o.id,o]));this.active.clear();
    for(const s of this.state.slots)for(const b of s.bindings){const o=byId.get(b.objectId);if(!o||o.anchor.kind!=="markdown"||o.anchor.key!==s.anchorKey)continue;const digest=layoutObjectDigest(o);
      if(trusted&&!b.digests.includes(digest)){b.digests.push(digest);if(b.digests.length>100)b.digests.shift();}
      if(b.digests.includes(digest))this.active.set(o.id,{slot:s,matrix:b.matrix});}
    const known=new Set(this.state.slots.flatMap(s=>s.bindings.map(b=>b.objectId)));
    const groups=new Map<string,BoardObject[]>();
    for(const o of document.objects)if(o.groupId.startsWith("LAYOUT-")&&!known.has(o.id)){const list=groups.get(o.groupId)??[];list.push(o);groups.set(o.groupId,list);}
    for(const [groupId,objects]of groups){const anchor=objects[0]!.anchor;if(anchor.kind!=="markdown"||locatedAnchors&&!locatedAnchors.has(anchor.key)||objects.some(o=>o.createdBy!=="tutor"||o.editedBy==="human"||o.anchor.kind!=="markdown"||o.anchor.key!==anchor.key))continue;
      const box=rectUnion(objects.map(o=>objectClientBounds(o,[1,0,0,1,0,0])));
      const s:BoardLayoutSlot={id:`SLOT-${surfaceDigest([document.id,groupId,objects.map(o=>o.id)]).slice(0,48)}`,anchorKey:anchor.key,groupId,order:this.state.slots.length,bindings:objects.map(o=>({objectId:o.id,digests:[layoutObjectDigest(o)],matrix:[1,0,0,1,12-box.x,12-box.y]}))};
      if(this.state.slots.some(old=>old.id===s.id))continue;this.state.slots.push(s);for(const b of s.bindings)this.active.set(b.objectId,{slot:s,matrix:b.matrix});}
    this.observed=document.revision;
    const changed=before!==JSON.stringify(this.state);if(changed)this.state.revision++;return changed;
  }
  binding(objectId:string){return this.active.get(objectId);}
  specs(objects:readonly BoardObject[]):BoardSlotSpec[]{
    const bounds=new Map<string,BoardRect[]>();for(const o of objects){const b=this.active.get(o.id);if(!b)continue;const list=bounds.get(b.slot.id)??[];list.push(objectClientBounds(o,b.matrix));bounds.set(b.slot.id,list);}
    return [...this.state.slots].sort((a,b)=>a.order-b.order).flatMap(s=>{const boxes=bounds.get(s.id);if(!boxes?.length)return [];const r=rectUnion(boxes);return [{id:s.id,anchorKey:s.anchorKey,width:Math.max(24,r.x+r.width+12),height:Math.max(24,r.y+r.height+12)}];});
  }
  ensureSlot(spec:BoardSlotSpec,groupId:string):void{
    if(this.state.slots.some(s=>s.id===spec.id))return;
    this.state.slots.push({id:spec.id,anchorKey:spec.anchorKey,groupId,order:this.state.slots.length,bindings:[]});this.state.revision++;
  }
  attach(object:BoardObject,slotId:string,transform:BoardMatrix):void{
    const s=this.state.slots.find(s=>s.id===slotId);if(!s)throw Error("layout-slot-missing");
    for(const old of this.state.slots)old.bindings=old.bindings.filter(b=>b.objectId!==object.id);
    const b={objectId:object.id,digests:[layoutObjectDigest(object)],matrix:transform};s.bindings.push(b);this.active.set(object.id,{slot:s,matrix:transform});this.state.revision++;
  }
  confirm(objects:readonly BoardObject[],slotId:string,matrices:ReadonlyMap<string,BoardMatrix>):void{
    if(!objects.length||!this.state.slots.some(s=>s.id===slotId)||objects.some(o=>!matrices.has(o.id)))throw Error("layout-attachment-invalid");
    for(const o of objects)this.attach(o,slotId,matrices.get(o.id)!);this.observed=-1;
  }
  needsLegacyNotice(objects:readonly BoardObject[]):boolean{return !this.state.legacyNoticeShown&&this.active.size>0&&objects.some(o=>o.createdBy==="human"&&!this.active.has(o.id));}
  markNotice():void{this.state.legacyNoticeShown=true;this.state.revision++;}
}
