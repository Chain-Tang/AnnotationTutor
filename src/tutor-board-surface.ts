import {vectorEditSchema,applyVectorEdit,type VectorEdit} from "./board-vector-edit.js";
import { z } from "zod";
import { boardObjectSchema, validateBoardDocument, validateBoardInk, type BoardHistory } from "./board-model.js";
import type { BoardInk, BoardObject, BoardOperation, BoardSnapshot, BoardVectorAsset } from "./board-types.js";
import type { ContextGrant } from "./tutor-task.js";
import { surfaceCommitQueue, surfaceCommitResult, surfaceDigest, surfaceSignature, type ChangeSet, type SurfaceAdapter, type SurfaceScene, type SurfaceCommitResult, type SurfaceCommitReceipt } from "./tutor-surface.js";
import { commitSurfaceTransaction, recoverSurfaceTransaction, type SurfaceTransactionRuntime } from "./surface-transactions.js";
import type { SurfaceTransactionJournal } from "./surface-transaction-journal.js";
const operationSchema=z.discriminatedUnion("type",[
  vectorEditSchema,
  z.object({type:z.literal("add"),object:boardObjectSchema}).strict(),
  z.object({type:z.literal("update"),objectId:z.string(),expectedRevision:z.number().int().nonnegative(),object:boardObjectSchema}).strict(),
  z.object({type:z.literal("remove"),objectId:z.string(),expectedRevision:z.number().int().nonnegative()}).strict(),
]);
export const boardChangeOperations=z.array(operationSchema).min(1).max(128);
export type BoardSurfaceOperation=BoardOperation|VectorEdit;
export const MAX_PREPARED_DRAWING_CHANGES=4504;
export type PreparedBoardDrawing={id:string;taskId:string;targetId:string;baseRevision:string;before:readonly BoardObject[];after:readonly BoardObject[];dependencies:string[]};
/** Convert an already placed host preview into a precise difference, never a scene replacement. */
export function compileBoardObjectChanges(before:readonly BoardObject[],after:readonly BoardObject[]):BoardSurfaceOperation[]{
  if(before.length>20000||after.length>20000)throw new Error("prepared-drawing-scene-too-large");
  const old=new Map(before.map(object=>[object.id,object])),next=new Map(after.map(object=>[object.id,object]));
  if(old.size!==before.length||next.size!==after.length)throw new Error("duplicate-object-id");
  const operations:BoardSurfaceOperation[]=[];
  for(const object of after){const previous=old.get(object.id);if(!previous)operations.push({type:"add",object:structuredClone(object)});
    else if(surfaceSignature(previous)!==surfaceSignature(object))operations.push({type:"update",objectId:object.id,expectedRevision:previous.revision,object:structuredClone(object)});}
  for(const object of before)if(!next.has(object.id))operations.push({type:"remove",objectId:object.id,expectedRevision:object.revision});
  if(operations.length>MAX_PREPARED_DRAWING_CHANGES)throw new Error("prepared-drawing-change-limit");
  return operations;
}
type Host={version?():string;assets?():readonly {id:string;version:number}[];validateDraft?(objects:BoardObject[]):void;history():BoardHistory;ink():BoardInk;alive():boolean;selection():string[];save():Promise<void>;preview(objects?:BoardObject[],assets?:BoardVectorAsset[]):Promise<string>;changed():void;capture?():Promise<BoardSnapshot>;};
/** A single typed transaction path for document overlays and Studio. */
export class TutorBoardSurface implements SurfaceAdapter<BoardSurfaceOperation>{
  constructor(public readonly id:string,private readonly kind:"studio"|"document",private readonly host:Host,private transactions?:SurfaceTransactionJournal){}
  useTransactions(journal:SurfaceTransactionJournal):void{this.transactions=journal;}
  async capture():Promise<BoardSnapshot>{if(!this.host.capture)throw new Error("capture-unavailable");this.history();return this.host.capture();}
  capabilities(){return {available:this.host.alive(),operations:["add","update","remove","vector-edit","preview"],writeAvailable:this.transactions?.status().available??false,writeReason:this.transactions?.status().reason??(!this.transactions?"surface-transaction-journal-unavailable":undefined)};}
  private history(){if(!this.host.alive() || this.host.history().document.id!==this.id)throw new Error("surface-closed");return this.host.history();}
  private scene():SurfaceScene{const document=this.history().document;return {target:{id:this.id,source:document.sourceFile,revision:this.version(),surface:this.kind},selection:this.host.selection(),objects:document.objects,vectorAssets:document.vectorAssets};}
  async read():Promise<SurfaceScene>{return this.scene();}
  private version():string{return `${this.history().document.revision}${this.host.version?`@${this.host.version()}`:""}`;}
  private draft(changes:ChangeSet<BoardSurfaceOperation>,grant?:ContextGrant,prepared=false){
    const history=this.history(),document=history.document;
    if(changes.targetId!==this.id || changes.baseRevision!==this.version())throw new Error("scene-revision-conflict");
    const operations=(prepared?z.array(operationSchema).min(1).max(MAX_PREPARED_DRAWING_CHANGES):boardChangeOperations).parse(changes.operations);
    const objects=document.objects,byId=new Map(objects.map(o=>[o.id,o]));
    const unlocked=(layerId?:string)=>{
      let layer=document.layers?.find(l=>l.id===layerId);const seen=new Set<string>();
      if(layerId&&!layer)throw new Error("unknown-layer");
      while(layer){if(layer.locked||seen.has(layer.id))throw new Error("layer-locked");seen.add(layer.id);layer=document.layers?.find(l=>l.id===layer!.parentId);}
    };
    for(const operation of operations){
      const previous=operation.type==="add"?undefined:byId.get(operation.objectId);
      if(operation.type!=="add"){
        if(!previous||previous.revision!==operation.expectedRevision)throw new Error("object-revision-conflict");
        if(grant&&!grant.humanObjectIds.includes(previous.id))throw new Error("object-outside-grant");
        unlocked(previous.layerId);
      }
      if(operation.type==="vector-edit"){applyVectorEdit(document,operation);continue;}
      if(operation.type==="remove"){objects.splice(objects.findIndex(o=>o.id===operation.objectId),1);byId.delete(operation.objectId);continue;}
      const object=structuredClone(operation.object);unlocked(object.layerId);
      if(previous && (object.id!==previous.id || JSON.stringify(object.anchor)!==JSON.stringify(previous.anchor)))throw new Error("object-identity-or-anchor-change");
      if(!previous && byId.has(object.id))throw new Error("duplicate-object-id");
      // Assets and raw ink are immutable references: this tool cannot smuggle a URL or rewrite raw ink.
      if(object.assetId && !this.host.assets?.().some(asset=>asset.id===object.assetId&&asset.version===object.assetVersion))throw new Error("missing-character-asset");
      if(object.inkId && !this.host.ink()[object.inkId])throw new Error("missing-ink-asset");
      if(previous && object.inkId!==previous.inkId)throw new Error("raw-ink-identity-change");
      object.createdBy=previous?.createdBy??"tutor";object.editedBy="tutor";object.revision=(previous?.revision??0)+1;
      if(!prepared)object.groupId=previous?.groupId.startsWith("LAYOUT-")?previous.groupId:changes.id;
      if(previous)objects[objects.findIndex(o=>o.id===previous.id)]=object;else objects.push(object);
      byId.set(object.id,object);
    }
    const groups=prepared?new Map(objects.map(object=>[object.id,object.groupId])):undefined;
    this.host.validateDraft?.(objects);
    if(groups)for(const object of objects)object.groupId=groups.get(object.id)!;
    validateBoardDocument({...document,objects});validateBoardInk({...document,objects},this.host.ink());return document;
  }
  preview(changes?:ChangeSet<BoardSurfaceOperation>):Promise<string>{this.history();const draft=changes?this.draft(changes):undefined;return this.host.preview(draft?.objects,draft?.vectorAssets);}
  private resources(objects:BoardObject[],vectors:BoardVectorAsset[]|undefined):NonNullable<SurfaceCommitReceipt["resources"]>{
    const result:NonNullable<SurfaceCommitReceipt["resources"]>=[];
    for(const object of objects){
      if(object.vectorAssetId){const asset=vectors?.find(asset=>asset.id===object.vectorAssetId&&asset.version===object.vectorAssetVersion);if(!asset)throw new Error("missing-vector-asset");result.push({kind:"vector",id:asset.id,version:asset.version,digest:surfaceDigest(asset)});}
      if(object.inkId){const ink=this.host.ink()[object.inkId];if(!ink)throw new Error("missing-ink-asset");result.push({kind:"ink",id:object.inkId,digest:surfaceDigest(ink)});}
      const assetId=object.assetId??object.characterId,version=object.assetVersion??object.characterVersion;
      if(assetId){const asset=this.host.assets?.().find(asset=>asset.id===assetId&&asset.version===version);if(!asset)throw new Error("missing-character-asset");result.push({kind:"character",id:assetId,version,digest:surfaceDigest(asset)});}
    }
    return [...new Map(result.map(resource=>[JSON.stringify([resource.kind,resource.id,resource.version]),resource])).values()];
  }
  private resourcesMatch(receipt:SurfaceCommitReceipt):boolean{
    const document=this.history().document;
    return (receipt.resources??[]).every(resource=>{
      const value=resource.kind==="vector"?document.vectorAssets?.find(asset=>asset.id===resource.id&&asset.version===resource.version):resource.kind==="ink"?this.host.ink()[resource.id]:this.host.assets?.().find(asset=>asset.id===resource.id&&asset.version===resource.version);
      return value!==undefined&&surfaceDigest(value)===resource.digest;
    });
  }
  private runtime(preparedBefore?:readonly BoardObject[]):SurfaceTransactionRuntime<BoardSurfaceOperation>{return {
    id:this.id,journal:this.transactions,capture:()=>this.scene(),save:()=>this.host.save(),
    target:receipt=>({id:this.id,source:this.host.history().document.sourceFile,revision:receipt.committedRevision??receipt.appliedRevision,surface:this.kind}),
    resourcesMatch:receipt=>this.resourcesMatch(receipt),
    compile:(changes,grant)=>{
      const before=this.history().document;
      if(preparedBefore&&surfaceDigest(before.objects)!==surfaceDigest(preparedBefore))throw new Error("prepared-drawing-scene-changed");
      const draft=this.draft(changes,grant,preparedBefore!==undefined);
      const result=surfaceCommitResult(changes,grant,{id:this.id,source:draft.sourceFile,revision:`${before.revision+1}${this.host.version?`@${this.host.version()}`:""}`,surface:this.kind},before.objects,draft.objects);
      const touched=new Set([...result.receipt.createdIds,...result.receipt.updatedIds]);
      result.receipt.resources=this.resources(draft.objects.filter(object=>touched.has(object.id)),draft.vectorAssets);
      const external=result.receipt.resources.filter(resource=>resource.kind!=="vector");
      return {result,before:before.objects,dependenciesValid:()=>this.resourcesMatch({...result.receipt,resources:external}),apply:()=>{
        const applied=this.history().transact(document=>{document.objects=draft.objects;document.vectorAssets=draft.vectorAssets;},"tutor",new Set(grant.humanObjectIds));
        result.target.revision=this.version();result.receipt.appliedRevision=result.target.revision;
        for(const id of touched){const object=applied.objects.find(object=>object.id===id);if(!object)throw new Error("surface-applied-object-missing");result.receipt.objectRevisions[id]=surfaceDigest(object);}
        this.host.changed();return result;
      }};
    },
  };}
  commit(changes:ChangeSet<BoardSurfaceOperation>,grant:ContextGrant,signal:AbortSignal):Promise<SurfaceCommitResult>{
    const runtime=this.runtime();return surfaceCommitQueue.run(this.id,()=>commitSurfaceTransaction(runtime,changes,grant,signal));
  }
  /** Host-only path for an already validated math/artist/reference preview; external tools keep their 128-operation limit. */
  commitPreparedDrawing(drawing:PreparedBoardDrawing,grant:ContextGrant,signal:AbortSignal):Promise<SurfaceCommitResult>{
    if(grant.clientId!=="obsidian")return Promise.reject(new Error("prepared-drawing-local-client-required"));
    const operations=compileBoardObjectChanges(drawing.before,drawing.after),runtime=this.runtime(structuredClone(drawing.before));
    const changes:ChangeSet<BoardSurfaceOperation>={id:drawing.id,taskId:drawing.taskId,targetId:drawing.targetId,baseRevision:drawing.baseRevision,operations,dependencies:[...drawing.dependencies]};
    return surfaceCommitQueue.run(this.id,()=>commitSurfaceTransaction(runtime,changes,grant,signal));
  }
  recoverCommit(transactionId:string,grant:ContextGrant,signal:AbortSignal,action:"inspect"|"retry-save"):Promise<SurfaceCommitResult>{const runtime=this.runtime();return surfaceCommitQueue.run(this.id,()=>recoverSurfaceTransaction(runtime,transactionId,grant,signal,action));}
}
