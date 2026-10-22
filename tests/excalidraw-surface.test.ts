import { describe, expect, it } from "vitest";
import { ExcalidrawSurface, verifyExcalidrawNativeApplication, type ExcalidrawAutomate, type ExcalidrawElement } from "../src/excalidraw-surface.js";
import type { ContextGrant } from "../src/tutor-task.js";
import { SurfaceCommitError, surfaceCommitQueue } from "../src/tutor-surface.js";
import { memorySurfaceJournal } from "./surface-journal-fixture.js";
function fixture(options:{save?:(scene:ExcalidrawElement[])=>Promise<void>;afterApply?:()=>void;generatedId?:string;companion?:boolean;implicitEdit?:boolean;nativeMetadata?:boolean;copyMetadata?:boolean}={}){
  let scene:ExcalidrawElement[]=[{id:"human",type:"rectangle",x:10,y:20,width:100,height:60,strokeColor:"#111111",updated:42,fontFamily:2,version:7},{id:"untouched",type:"text",text:"Keep",fontFamily:3,lineHeight:1.6,rawText:"Keep",updated:123456,version:4}];
  let commits=0,saves=0;
  const view={file:{path:"a.excalidraw.md"},save:async()=>{saves++;await options.save?.(scene);}};
  const api={getSceneElements:()=>scene.filter(o=>!o.isDeleted),getAppState:()=>({selectedElementIds:{human:true}}),updateScene:(input:{elements:ExcalidrawElement[]})=>{scene=input.elements;if(options.nativeMetadata)scene=scene.map(o=>o.id==='new'||o.id==='label'?{...o,index:'a'+o.id,version:2,versionNonce:123,updated:Date.now()}:o);commits++;options.afterApply?.();},refreshAllArrows:()=>{}};
  const factory={create:async()=>"",getAPI:()=>{
    const ea={targetView:view,elementsDict:{} as Record<string,ExcalidrawElement>,style:{},getExcalidrawAPI:()=>api,clear:()=>{},copyViewElementsToEAforEditing:(elements:readonly ExcalidrawElement[])=>{ea.elementsDict=Object.fromEntries(structuredClone(elements).map(el=>[el.id,options.copyMetadata?{...el,version:(el.version??1)+1,updated:Date.now()}:el]));},addRect:()=>{const id=options.generatedId??"new";ea.elementsDict[id]={id,type:"rectangle"};if(options.companion)ea.elementsDict.companion={id:"companion",type:"text"};if(options.implicitEdit)ea.elementsDict.untouched!.text="compiler-changed";return id;},addText:()=>{ea.elementsDict.label={id:"label",type:"text",width:30,height:20};return "label";},addEllipse:()=>"",addDiamond:()=>"",refreshTextElementSize:()=>{},connectObjects:()=>{ea.elementsDict.arrow={id:"arrow",type:"arrow"};return "arrow";},addToGroup:()=>"",createSVG:async()=>({outerHTML:"<svg/>"})};return ea as unknown as ExcalidrawAutomate;
  }};
  const surface=new ExcalidrawSurface("surface",factory,view,"2.27.3",memorySurfaceJournal());
  const grant:ContextGrant={clientId:"test",targets:[surface.id],read:true,write:true,humanObjectIds:["human"],learningMemory:false};
  return {surface,grant,view,scene:()=>scene,counts:()=>({commits,saves})};
}
async function addition(f:ReturnType<typeof fixture>,id="add"){
  return {id,taskId:"task",targetId:f.surface.id,baseRevision:(await f.surface.read()).target.revision,dependencies:[],operations:[{type:"add" as const,id:"requested-alias",shape:"rectangle" as const,x:0,y:0,width:100,height:60,text:"label"}]};
}
describe("Excalidraw precision adapter",()=>{
  it("accepts native index/version normalization and receipts the actual applied objects",async()=>{
    const f=fixture({nativeMetadata:true}),change=await addition(f);
    const result=await f.surface.commit(change,f.grant,new AbortController().signal);
    expect(result.receipt.durability).toBe("committed");expect(f.scene().find(o=>o.id==='new')).toMatchObject({index:'anew',version:2});
    await f.surface.commit(change,f.grant,new AbortController().signal);expect(f.counts()).toEqual({commits:1,saves:1});
  });
  it("does not normalize away geometry, bindings, ordering or unselected changes",()=>{
    const expected:ExcalidrawElement[]=[{id:'a',type:'rectangle',x:10,index:'a0',version:1},{id:'b',type:'text',text:'human'}];
    for(const patch of [{x:11},{index:'b0'},{boundElements:[{id:'other',type:'arrow'}]}])expect(()=>verifyExcalidrawNativeApplication(expected,[{...expected[0]!,...patch},expected[1]!],new Set(['a']))).toThrow();
    expect(()=>verifyExcalidrawNativeApplication(expected,[expected[0]!,{...expected[1]!,version:2}],new Set(['a']))).toThrow('unselected-change');
    expect(()=>verifyExcalidrawNativeApplication(expected,[{...expected[0]!,version:0},expected[1]!],new Set(['a']))).toThrow('regressed');
  });
  it("changes only granted fields, persists once and deduplicates commits",async()=>{
    const f=fixture({copyMetadata:true}),scene=await f.surface.read(),untouched=structuredClone(f.scene()[1]);
    const changes={id:"change",taskId:"task",targetId:f.surface.id,baseRevision:scene.target.revision,dependencies:[],operations:[{type:"update" as const,id:"human",style:{strokeColor:"#ff0000"}}]};
    const receipt=await f.surface.commit(changes,f.grant,new AbortController().signal);
    expect(receipt.receipt.updatedIds).toEqual(["human"]);
    await f.surface.commit(changes,f.grant,new AbortController().signal);
    expect(f.counts()).toEqual({commits:1,saves:1});expect(f.scene()[1]).toEqual(untouched);expect(f.scene()[0]).toMatchObject({strokeColor:"#ff0000",x:10,y:20,fontFamily:2});
  });
  it("rejects stale, ungranted, locked and cancelled edits before touching the scene",async()=>{
    const f=fixture(),scene=await f.surface.read();
    const changes={id:"change",taskId:"task",targetId:f.surface.id,baseRevision:scene.target.revision,dependencies:[],operations:[{type:"delete" as const,id:"untouched"}]};
    await expect(f.surface.commit(changes,f.grant,new AbortController().signal)).rejects.toThrow("outside-grant");
    await expect(f.surface.commit({...changes,baseRevision:"stale"},f.grant,new AbortController().signal)).rejects.toThrow("conflict");
    const abort=new AbortController();abort.abort();await expect(f.surface.commit(changes,f.grant,abort.signal)).rejects.toThrow("cancelled");
    f.scene()[0]!.locked=true;const current=await f.surface.read();
    await expect(f.surface.commit({...changes,baseRevision:current.target.revision,operations:[{type:"delete",id:"human"}]},f.grant,new AbortController().signal)).rejects.toThrow("locked");
    expect(f.counts()).toEqual({commits:0,saves:0});
  });
  it("follows a renamed file handle but refuses a replacement view target",async()=>{
    const f=fixture();f.view.file.path="renamed.md";expect((await f.surface.read()).target.source).toBe("renamed.md");
    f.view.file={path:"another.md"};await expect(f.surface.read()).rejects.toThrow("target-unavailable");
  });
  it("keeps reads available while refusing writes until its identity is durable",async()=>{
    const f=fixture(),changes=await addition(f);f.surface.setIdentityReady(false);
    expect(f.surface.capabilities()).toMatchObject({available:true,writeAvailable:false,writeReason:"surface-identity-not-persisted"});
    expect((await f.surface.read()).objects).toHaveLength(2);expect(await f.surface.preview()).toBe("<svg/>");
    await expect(f.surface.commit(changes,f.grant,new AbortController().signal)).rejects.toThrow("surface-identity-not-persisted");
    await expect(f.surface.recoverCommit(changes.id,f.grant,new AbortController().signal,"retry-save")).rejects.toThrow("surface-identity-not-persisted");
    expect(f.counts()).toEqual({commits:0,saves:0});
    f.surface.setIdentityReady(true);await f.surface.commit(changes,f.grant,new AbortController().signal);
    expect(f.counts()).toEqual({commits:1,saves:1});expect(f.surface.capabilities().writeAvailable).toBe(true);
  });
  it("checks identity inside the target queue and permits read-only reconciliation while it is pending",async()=>{
    const f=fixture(),changes=await addition(f);let release!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const hold=surfaceCommitQueue.run(f.surface.id,()=>new Promise<void>(resolve=>{release=resolve;entered();}));
    await started;const pending=f.surface.commit(changes,f.grant,new AbortController().signal);f.surface.setIdentityReady(false);release();await hold;
    await expect(pending).rejects.toThrow("surface-identity-not-persisted");expect(f.counts()).toEqual({commits:0,saves:0});
    f.surface.setIdentityReady(true);await f.surface.commit(changes,f.grant,new AbortController().signal);f.surface.setIdentityReady(false);
    expect((await f.surface.recoverCommit(changes.id,f.grant,new AbortController().signal,"inspect")).receipt.durability).toBe("committed");
    expect(f.counts()).toEqual({commits:1,saves:1});
  });
  it("receipts only compiled IDs, including labels, connectors and companion elements, while a person draws during save",async()=>{
    const f=fixture({companion:true,save:async scene=>{scene.push({id:"human-during-save",type:"freedraw"});}});
    const change=await addition(f);change.operations.push({type:"connect",id:"connector-alias",from:"requested-alias",to:"human"} as never);
    const result=await f.surface.commit(change,f.grant,new AbortController().signal);
    expect(result.receipt).toMatchObject({version:1,transactionId:change.id,clientId:"test",targetId:f.surface.id,durability:"committed",createdIds:["new","companion","label","arrow"],updatedIds:["human"],deletedIds:[]});
    expect(result.receipt.createdIds).not.toContain("requested-alias");expect(result.receipt.createdIds).not.toContain("human-during-save");
    expect(Object.keys(result.receipt.objectRevisions).sort()).toEqual(["arrow","companion","human","label","new"]);
    expect(result.receipt.appliedRevision).not.toBe((await f.surface.read()).target.revision);
    expect(f.scene().at(-1)!.id).toBe("human-during-save");
  });
  it("rejects generated native ID collisions before any scene or undo mutation",async()=>{
    const f=fixture({generatedId:"human"}),before=structuredClone(f.scene());
    await expect(f.surface.commit(await addition(f),f.grant,new AbortController().signal)).rejects.toThrow("generated-element-id-collision");
    expect(f.scene()).toEqual(before);expect(f.counts()).toEqual({commits:0,saves:0});
  });
  it("requires an explicit grant for an old object changed implicitly by the compiler",async()=>{
    const f=fixture({implicitEdit:true}),before=structuredClone(f.scene());
    await expect(f.surface.commit(await addition(f),f.grant,new AbortController().signal)).rejects.toThrow("object-outside-grant");
    expect(f.scene()).toEqual(before);expect(f.counts()).toEqual({commits:0,saves:0});
  });
  it("retains an applied-not-durable receipt after save failure and never reapplies a retry",async()=>{
    const f=fixture({save:async scene=>{scene.push({id:"later-human",type:"freedraw"});throw new Error("disk-full");}}),change=await addition(f);
    const error=await f.surface.commit(change,f.grant,new AbortController().signal).catch(error=>error) as SurfaceCommitError;
    expect(error).toBeInstanceOf(SurfaceCommitError);expect(error.result.receipt).toMatchObject({durability:"applied-not-durable",createdIds:["new","label"]});
    expect(error.result.receipt.committedRevision).toBeUndefined();
    await expect(f.surface.commit(change,f.grant,new AbortController().signal)).rejects.toThrow("applied-not-durable");
    await expect(f.surface.commit({...change,operations:[{...change.operations[0]!,x:2}]},f.grant,new AbortController().signal)).rejects.toThrow("changeset-id-reused");
    expect(f.counts()).toEqual({commits:1,saves:1});expect(f.scene().some(item=>item.id==="later-human")).toBe(true);
  });
  it.each(["undo","modify"])("reports outcome-unknown when native %s changes the applied difference during save",async action=>{
    const f=fixture({save:async scene=>{if(action==="undo")scene.splice(scene.findIndex(item=>item.id==="new"),1);else scene.find(item=>item.id==="new")!.x=987;}}),change=await addition(f);
    const error=await f.surface.commit(change,f.grant,new AbortController().signal).catch(error=>error) as SurfaceCommitError;
    expect(error.result.receipt).toMatchObject({durability:"outcome-unknown",createdIds:["new","label"]});
    await expect(f.surface.commit(change,f.grant,new AbortController().signal)).rejects.toThrow("outcome-unknown");
    expect(f.counts()).toEqual({commits:1,saves:1});
    expect(action==="undo"?f.scene().some(item=>item.id==="new"):f.scene().find(item=>item.id==="new")!.x).toBe(action==="undo"?false:987);
  });
  it("reports applied-not-durable if cancelled at the application boundary, without rolling back",async()=>{
    const abort=new AbortController(),f=fixture({afterApply:()=>abort.abort()}),change=await addition(f);
    const error=await f.surface.commit(change,f.grant,abort.signal).catch(error=>error) as SurfaceCommitError;
    expect(error.result.receipt.durability).toBe("applied-not-durable");expect(f.counts()).toEqual({commits:1,saves:0});
    expect(f.scene().some(item=>item.id==="new")).toBe(true);
  });
  it("reports the durable result if cancellation occurs while a successful save is already pending",async()=>{
    const abort=new AbortController(),f=fixture({save:async()=>abort.abort()}),change=await addition(f);
    const result=await f.surface.commit(change,f.grant,abort.signal);
    expect(result.receipt.durability).toBe("committed");expect(f.counts()).toEqual({commits:1,saves:1});
    expect((await f.surface.commit(change,f.grant,abort.signal)).receipt).toEqual(result.receipt);
  });
});
