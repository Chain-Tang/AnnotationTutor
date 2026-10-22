import { z } from "zod";
import type { ContextGrant } from "./tutor-task.js";
import { boundedId, coord, surfaceCommitQueue, surfaceCommitResult, surfaceSignature, surfaceDigest, type ChangeSet, type SurfaceAdapter, type SurfaceScene, type SurfaceCommitResult } from "./tutor-surface.js";
import { commitSurfaceTransaction, recoverSurfaceTransaction, type SurfaceTransactionRuntime } from "./surface-transactions.js";
import type { SurfaceTransactionJournal } from "./surface-transaction-journal.js";

const color = z.string().regex(/^(?:#[0-9a-fA-F]{3,8}|transparent)$/);
const style = z.object({strokeColor:color.optional(),backgroundColor:color.optional(),strokeWidth:z.number().min(.5).max(16).optional(),opacity:z.number().min(0).max(100).optional(),roughness:z.number().min(0).max(3).optional(),fontSize:z.number().min(6).max(300).optional(),fillStyle:z.enum(["solid","hachure","cross-hatch"]).optional()}).strict();
const geometry = z.object({x:coord.optional(),y:coord.optional(),width:z.number().positive().max(100000).optional(),height:z.number().positive().max(100000).optional()}).strict();
export const excalidrawOperationSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("add"),id:boundedId,shape:z.enum(["rectangle","ellipse","diamond","text"]),x:coord,y:coord,width:z.number().positive().max(100000),height:z.number().positive().max(100000),text:z.string().max(8000).optional(),style:style.optional()}).strict(),
  z.object({type:z.literal("update"),id:boundedId,geometry:geometry.optional(),style:style.optional(),text:z.string().max(8000).optional()}).strict(),
  z.object({type:z.literal("delete"),id:boundedId}).strict(),
  z.object({type:z.literal("connect"),id:boundedId,from:boundedId,to:boundedId,fromSide:z.enum(["left","right","top","bottom"]).optional(),toSide:z.enum(["left","right","top","bottom"]).optional(),style:style.optional()}).strict(),
  z.object({type:z.literal("group"),ids:z.array(boundedId).min(2).max(128)}).strict(),
]);
export type ExcalidrawOperation = z.infer<typeof excalidrawOperationSchema>;
export type ExcalidrawElement = {id:string;type:string;isDeleted?:boolean;locked?:boolean;version?:number;versionNonce?:number;updated?:number;boundElements?:{id:string;type:string}[]|null;containerId?:string|null;[key:string]:unknown};
type View = {file?:{path:string};containerEl?:HTMLElement;save(preventReload?:boolean,force?:boolean):Promise<unknown>};
export type ExcalidrawApi = { getSceneElements():readonly ExcalidrawElement[]; getAppState():{selectedElementIds?:Record<string,boolean>}; updateScene(scene:{elements:ExcalidrawElement[];captureUpdate:"IMMEDIATELY"|"EVENTUALLY"}):void; refreshAllArrows?():void };
export type ExcalidrawAutomate = {
  targetView:View;elementsDict:Record<string,ExcalidrawElement>;style:Record<string,unknown>;
  getExcalidrawAPI():ExcalidrawApi;clear():void;copyViewElementsToEAforEditing(elements:readonly ExcalidrawElement[],copyImages?:boolean):void;
  addRect(x:number,y:number,w:number,h:number):string;addEllipse(x:number,y:number,w:number,h:number):string;addDiamond(x:number,y:number,w:number,h:number):string;
  addText(x:number,y:number,text:string,formatting?:{width?:number},id?:string):string;
  refreshTextElementSize(id:string):void;connectObjects(a:string,sideA:string|null,b:string,sideB:string|null,format:{endArrowHead:"arrow"}):string;
  addToGroup(ids:string[]):string;createSVG():Promise<SVGSVGElement>;
};
export type ExcalidrawFactory = { getAPI(view?:unknown):ExcalidrawAutomate; create(input:{filename:string;foldername?:string;onNewPane:boolean;silent?:boolean}):Promise<string> };

/** Pure fingerprint; no timestamps or unselected fields are rewritten. */
export function excalidrawRevision(elements: readonly ExcalidrawElement[]): string {
  const value=JSON.stringify(elements);let a=2166136261,b=5381;
  for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b,33)^value.charCodeAt(i);}
  return `${value.length}:${a>>>0}:${b>>>0}`;
}

/** Native updateScene assigns ordering indices and version metadata synchronously.
 * Accept only that bounded normalization, and retain exact applied fingerprints. */
export function verifyExcalidrawNativeApplication(expected:readonly ExcalidrawElement[],actual:readonly ExcalidrawElement[],changed:ReadonlySet<string>):void{
  const visible=expected.filter(object=>!object.isDeleted),byId=new Map(actual.map(object=>[object.id,object]));
  if(visible.length!==actual.length||byId.size!==actual.length)throw new Error("excalidraw-native-object-set-changed");
  for(const before of visible){
    const after=byId.get(before.id);if(!after)throw new Error("excalidraw-native-object-missing");
    if(!changed.has(before.id)){if(surfaceSignature(before)!==surfaceSignature(after))throw new Error("excalidraw-native-unselected-change");continue;}
    const normalized={...after};
    for(const key of ["version","versionNonce","updated"] as const){
      if(after[key]!==undefined&&(!Number.isSafeInteger(after[key])||Number(after[key])<0))throw new Error("excalidraw-native-metadata-invalid");
      if((key==="version"||key==="updated")&&before[key]!==undefined&&Number(after[key])<Number(before[key]))throw new Error("excalidraw-native-metadata-regressed");
      if(before[key]===undefined)delete normalized[key];else normalized[key]=before[key];
    }
    if(before.index===undefined&&after.index!==undefined){
      if(typeof after.index!=="string"||after.index.length>256||!after.index.length)throw new Error("excalidraw-native-index-invalid");
      delete normalized.index;
    }
    if(surfaceSignature(before)!==surfaceSignature(normalized))throw new Error("excalidraw-native-content-changed");
  }
}

export class ExcalidrawSurface implements SurfaceAdapter<ExcalidrawOperation> {
  private readonly file:View["file"];
  private identityReady=true;
  constructor(public readonly id:string,private readonly factory:ExcalidrawFactory,private readonly view:View,private readonly version:string,private transactions?:SurfaceTransactionJournal){this.file=view.file;}
  useTransactions(journal:SurfaceTransactionJournal):void{this.transactions=journal;}
  setIdentityReady(ready:boolean):void{this.identityReady=ready;}
  private requireIdentity():void{if(!this.identityReady)throw new Error("surface-identity-not-persisted");}
  capabilities(){
    try { const ea=this.factory.getAPI(this.view), api=ea.getExcalidrawAPI();
      const available=[ea.copyViewElementsToEAforEditing,ea.addRect,ea.addText,ea.connectObjects,ea.refreshTextElementSize,api.getSceneElements,api.updateScene,this.view.save].every(x=>typeof x==="function");
      return {available,version:this.version,operations:available?["add","update","delete","connect","group","preview"]:[],writeAvailable:this.identityReady&&(this.transactions?.status().available??false),writeReason:!this.identityReady?"surface-identity-not-persisted":this.transactions?.status().reason??(!this.transactions?"surface-transaction-journal-unavailable":undefined),...(available?{}:{reason:"excalidraw-api-incompatible"})};
    }catch{return {available:false,version:this.version,operations:[],reason:"excalidraw-unavailable",writeAvailable:false,writeReason:"excalidraw-unavailable"};}
  }
  private api(){
    if (!this.file || this.view.file!==this.file || this.view.containerEl?.isConnected===false) throw new Error("excalidraw-target-unavailable");
    if(!this.capabilities().available)throw new Error("excalidraw-api-incompatible");
    return this.factory.getAPI(this.view);
  }
  private scene():SurfaceScene{
    const api=this.api().getExcalidrawAPI(),objects=structuredClone([...api.getSceneElements()]);
    return {target:{id:this.id,source:this.file!.path,revision:excalidrawRevision(objects),surface:"excalidraw"},selection:Object.entries(api.getAppState().selectedElementIds??{}).filter(([,value])=>value).map(([id])=>id),objects};
  }
  async read():Promise<SurfaceScene>{return this.scene();}
  private draft(changes:ChangeSet<ExcalidrawOperation>,grant?:ContextGrant){
    if(changes.targetId!==this.id)throw new Error("changeset-target-mismatch");
    const operations=z.array(excalidrawOperationSchema).min(1).max(128).parse(changes.operations);
    const ea=this.api();ea.clear();
    const original=structuredClone([...ea.getExcalidrawAPI().getSceneElements()]);
    if(excalidrawRevision(original)!==changes.baseRevision)throw new Error("scene-revision-conflict");
    // Cloned workbench is isolated; only touched objects will be submitted.
    ea.copyViewElementsToEAforEditing(original,true);
    // Automate copies also bump metadata on every imported element. Retain its
    // image-resource work, but restore exact element bytes before editing only
    // the explicitly addressed objects and their granted dependants.
    for(const element of original)ea.elementsDict[element.id]=structuredClone(element);
    const changed=new Set<string>(), aliases=new Map<string,string>(), prior=new Map(original.map(e=>[e.id,e]));
    if(prior.size!==original.length)throw new Error("duplicate-surface-object-id");
    const generate=(operation:()=>string)=>{
      const existing=new Set(Object.keys(ea.elementsDict)),id=operation();
      if(!id||existing.has(id)||!ea.elementsDict[id]||ea.elementsDict[id]!.id!==id)throw new Error("generated-element-id-collision");
      // Excalidraw can compile extra labels or other companion elements.
      for(const key of Object.keys(ea.elementsDict))if(!existing.has(key))changed.add(key);
      return id;
    };
    const resolve=(id:string)=>aliases.get(id)??id;
    const check=(id:string)=>{
      const key=resolve(id), el=ea.elementsDict[key];if(!el||el.isDeleted)throw new Error("element-not-found");
      if(el.locked)throw new Error("element-locked");
      if(grant && prior.has(key) && !grant.humanObjectIds.includes(key))throw new Error("object-outside-grant");
      changed.add(key);return el;
    };
    for(const op of operations){
      if(op.type==="add"){
        if(prior.has(op.id)||aliases.has(op.id))throw new Error("duplicate-element-id");
        const defaults={...ea.style};Object.assign(ea.style,op.style??{});
        const generated=generate(()=>op.shape==="text"?ea.addText(op.x,op.y,op.text??"",{width:op.width}):op.shape==="ellipse"?ea.addEllipse(op.x,op.y,op.width,op.height):op.shape==="diamond"?ea.addDiamond(op.x,op.y,op.width,op.height):ea.addRect(op.x,op.y,op.width,op.height));
        if(op.shape!=="text" && op.text){
          const labelId=generate(()=>ea.addText(op.x,op.y,op.text!,{width:Math.max(1,op.width-20)})),label=ea.elementsDict[labelId]!,container=ea.elementsDict[generated]!;
          label.containerId=generated;container.boundElements=[...(container.boundElements??[]),{id:labelId,type:"text"}];
          label.x=op.x+(op.width-Number(label.width))/2;label.y=op.y+(op.height-Number(label.height))/2;
          changed.add(labelId);
        }
        ea.style=defaults;aliases.set(op.id,generated);changed.add(generated);
      }else if(op.type==="connect"){
        if(prior.has(op.id)||aliases.has(op.id))throw new Error("duplicate-element-id");
        const a=check(op.from),b=check(op.to),defaults={...ea.style};Object.assign(ea.style,op.style??{});
        const generated=generate(()=>ea.connectObjects(a.id,op.fromSide??null,b.id,op.toSide??null,{endArrowHead:"arrow"}));ea.style=defaults;
        if(!generated)throw new Error("connection-failed");aliases.set(op.id,generated);changed.add(generated);
      }else if(op.type==="group"){
        const ids=op.ids.map(id=>check(id).id);ea.addToGroup(ids);
      }else{
        const el=check(op.id);
        if(op.type==="delete" || op.geometry){
          // Native binding refresh also changes connected arrows/text; require their grant too.
          for(const bound of el.boundElements??[]) check(bound.id);
          if(el.containerId)check(el.containerId);
          
        }
        if(op.type==="delete")el.isDeleted=true;
        else{
          if(op.geometry)Object.assign(el,op.geometry);
          if(op.style)Object.assign(el,op.style);
          if(op.text!==undefined){if(el.type!=="text")throw new Error("text-target-required");el.text=op.text;el.originalText=op.text;el.rawText=op.text;ea.refreshTextElementSize(el.id);}
        }
      }
    }
    // Account for compiler side effects before applying anything, and require grants for every old object touched.
    for(const [id,element] of Object.entries(ea.elementsDict)){
      if(element.id!==id)throw new Error("generated-element-id-collision");
      const old=prior.get(id);
      if(!old)changed.add(id);
      else if(surfaceSignature(old)!==surfaceSignature(element)){
        if(old.locked)throw new Error("element-locked");
        if(grant&&!grant.humanObjectIds.includes(id))throw new Error("object-outside-grant");
        changed.add(id);
      }
    }
    for (const id of changed) {
      const next=ea.elementsDict[id]!, old=prior.get(id);
      if(!old || next.type!=="text" || !next.containerId)continue;
      const container=ea.elementsDict[next.containerId],before=prior.get(next.containerId);
      if(container && before){
        next.x=Number(container.x)+(Number(container.width)-Number(next.width))/2;
        next.y=Number(container.y)+(Number(container.height)-Number(next.height))/2;
      }
    }
    // Move only the explicitly granted straight connectors in the isolated draft.
    // refreshAllArrows() mutates every native arrow and creates a second undo entry.
    for (const id of [...changed]) {
      const next=ea.elementsDict[id]!, old=prior.get(id);
      if (!old || next.type !== "arrow") continue;
      const affected=["startBinding","endBinding"].some(key=>{
        const binding=old[key] as {elementId:string}|undefined;
        const from=binding?prior.get(binding.elementId):undefined,to=binding?ea.elementsDict[binding.elementId]:undefined;
        return from && to && (to.isDeleted || ["x","y","width","height"].some(field=>from[field]!==to[field]));
      });
      if(!affected)continue;
      const points=old.points as number[][]|undefined;
      if (!points || points.length!==2 || Number(old.angle??0)!==0) throw new Error("bound-connector-geometry-unsupported");
      const endpoints=points.map(point=>[Number(old.x)+point[0]!,Number(old.y)+point[1]!]);
      for (const [index,key] of [[0,"startBinding"],[1,"endBinding"]] as const) {
        const binding=old[key] as {elementId:string}|undefined;
        if(!binding)continue;
        const from=prior.get(binding.elementId),to=ea.elementsDict[binding.elementId];
        if(!from||!to)continue;
        if(to.isDeleted)throw new Error("delete-connected-elements-requires-explicit-unbind");
        for(const axis of [0,1] as const){
          const origin=axis===0?"x":"y",size=axis===0?"width":"height";
          const before=Number(from[size]),after=Number(to[size]);
          endpoints[index]![axis]=Number(to[origin])+(endpoints[index]![axis]!-Number(from[origin]))*(before?after/before:1);
        }
      }
      next.x=endpoints[0]![0];next.y=endpoints[0]![1];
      next.points=[[0,0],[endpoints[1]![0]!-endpoints[0]![0]!,endpoints[1]![1]!-endpoints[0]![1]!]];
      next.width=Math.abs(endpoints[1]![0]!-endpoints[0]![0]!);next.height=Math.abs(endpoints[1]![1]!-endpoints[0]![1]!);
    }
    for(const id of changed){const el=ea.elementsDict[id]!,old=prior.get(id);if(old){el.version=(old.version??1)+1;el.versionNonce=Math.floor(Math.random()*2147483647);el.updated=Date.now();}}
    const elements=original.map(el=>changed.has(el.id)?ea.elementsDict[el.id]!:el);
    for(const id of changed)if(!prior.has(id))elements.push(ea.elementsDict[id]!);
    if(elements.length>10000)throw new Error("scene-size-limit");
    return {ea,elements,original,changed};
  }
  async preview(changes?:ChangeSet<ExcalidrawOperation>):Promise<string>{
    const ea=changes?this.draft(changes).ea:this.api();
    if(!changes){ea.clear();ea.copyViewElementsToEAforEditing(ea.getExcalidrawAPI().getSceneElements(),true);}
    return (await ea.createSVG()).outerHTML;
  }
  private runtime():SurfaceTransactionRuntime<ExcalidrawOperation>{return {
    id:this.id,journal:this.transactions,capture:()=>this.scene(),target:receipt=>({id:this.id,source:this.file?.path??"",revision:receipt.committedRevision??receipt.appliedRevision,surface:"excalidraw"}),
    save:async()=>{this.requireIdentity();this.api();await this.view.save(true,true);this.api();this.requireIdentity();},
    compile:(changes,grant)=>{const {ea,elements,original,changed}=this.draft(changes,grant),api=ea.getExcalidrawAPI();
      const result=surfaceCommitResult(changes,grant,{id:this.id,source:this.file!.path,revision:excalidrawRevision(elements),surface:"excalidraw"},original,elements);
      const expected=structuredClone(elements);return {
      result,before:original,
      dependenciesValid:()=>this.identityReady,
      apply:()=>{
        api.updateScene({elements,captureUpdate:"IMMEDIATELY"});
        const actual=structuredClone([...api.getSceneElements()]);verifyExcalidrawNativeApplication(expected,actual,changed);
        const byId=new Map(actual.map(object=>[object.id,object]));
        for(const id of [...result.receipt.createdIds,...result.receipt.updatedIds])result.receipt.objectRevisions[id]=surfaceDigest(byId.get(id));
        result.target.revision=excalidrawRevision(actual);result.receipt.appliedRevision=result.target.revision;
        return result;
      },
    };},
  };}
  commit(changes:ChangeSet<ExcalidrawOperation>,grant:ContextGrant,signal:AbortSignal):Promise<SurfaceCommitResult>{const runtime=this.runtime();return surfaceCommitQueue.run(this.id,()=>{this.requireIdentity();return commitSurfaceTransaction(runtime,changes,grant,signal);});}
  recoverCommit(transactionId:string,grant:ContextGrant,signal:AbortSignal,action:"inspect"|"retry-save"):Promise<SurfaceCommitResult>{const runtime=this.runtime();return surfaceCommitQueue.run(this.id,()=>{if(action==="retry-save")this.requireIdentity();return recoverSurfaceTransaction(runtime,transactionId,grant,signal,action);});}
}
