import {expect,it,vi} from "vitest";
import {BoardHistory,createBoardDocument} from "../src/board-model.js";
import type {BoardObject} from "../src/board-types.js";
import {TutorBoardSurface,type BoardSurfaceOperation} from "../src/tutor-board-surface.js";
import type {ChangeSet} from "../src/tutor-surface.js";
import {commitStudioConversationDrawing} from "../src/tutor-studio-commit.js";
import {memorySurfaceJournal} from "./surface-journal-fixture.js";
const object=(id:string):BoardObject=>({id,kind:"rect",anchor:{kind:"canvas",pageId:"main"},x:0,y:0,width:20,height:20,color:"#000000",strokeWidth:2,createdBy:"human",editedBy:"human",revision:1,groupId:"original"});
async function fixture(){
  const history=new BoardHistory({...createBoardDocument("test.tutorboard.md","standalone","board"),objects:[object("existing")]}),save=vi.fn(async()=>{});
  const surface=new TutorBoardSurface("board","studio",{history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>["existing"],save,preview:async()=>"<svg/>",changed:()=>{}},memorySurfaceJournal());
  const scene=await surface.read(),grant={clientId:"obsidian",targets:["board"],read:true,write:true,humanObjectIds:scene.selection,learningMemory:false};
  const change:ChangeSet<BoardSurfaceOperation>={id:crypto.randomUUID(),taskId:crypto.randomUUID(),targetId:"board",baseRevision:scene.target.revision,operations:[],dependencies:[]};
  return {history,save,surface,scene,grant,change,signal:new AbortController().signal,layer:history.document.layers![0]!.id};
}
it("commits conversation math with over 128 pieces to the captured layer once, with one undo",async()=>{
  const f=await fixture();f.change.operations=Array.from({length:140},(_,i)=>({type:"add",object:object(`curve-${i}`)}));
  const result=await commitStudioConversationDrawing(f.surface,f.scene,f.change,f.layer,f.grant,f.signal);
  expect(result.receipt.createdIds).toHaveLength(140);expect(result.receipt.durability).toBe("committed");
  expect(f.history.document.objects.slice(1).every(o=>o.layerId===f.layer)).toBe(true);
  await commitStudioConversationDrawing(f.surface,f.scene,f.change,f.layer,f.grant,f.signal);expect(f.save).toHaveBeenCalledOnce();
  f.history.undo();expect(f.history.document.objects).toEqual(f.scene.objects);expect(f.history.canUndo).toBe(false);
});
it("allows an explicitly selected human object, preserves its author, and denies an unselected object",async()=>{
  const f=await fixture();f.change.operations=[{type:"update",objectId:"existing",expectedRevision:1,object:{...object("existing"),x:30}}];
  await expect(commitStudioConversationDrawing(f.surface,f.scene,f.change,f.layer,{...f.grant,humanObjectIds:[]},f.signal)).rejects.toThrow("outside-grant");
  await commitStudioConversationDrawing(f.surface,f.scene,f.change,f.layer,f.grant,f.signal);
  expect(f.history.document.objects[0]).toMatchObject({createdBy:"human",editedBy:"tutor",x:30});
});
it("does not flatten contradictory operations or overwrite a changed scene",async()=>{
  const f=await fixture();f.change.operations=[{type:"add",object:object("new")},{type:"remove",objectId:"new",expectedRevision:1}];
  await expect(commitStudioConversationDrawing(f.surface,f.scene,f.change,f.layer,f.grant,f.signal)).rejects.toThrow("duplicate-object-operation");
  f.change.operations=[{type:"add",object:object("new")}];f.history.transact(d=>d.objects.push(object("later-human")));
  await expect(commitStudioConversationDrawing(f.surface,f.scene,f.change,f.layer,f.grant,f.signal)).rejects.toThrow("scene-changed");
  expect(f.history.document.objects.map(o=>o.id)).toEqual(["existing","later-human"]);expect(f.save).not.toHaveBeenCalled();
});
