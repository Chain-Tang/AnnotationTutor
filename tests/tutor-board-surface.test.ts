import { describe, expect, it } from "vitest";
import { BoardHistory, createBoardDocument } from "../src/board-model.js";
import type { BoardObject } from "../src/board-types.js";
import { TutorBoardSurface, compileBoardObjectChanges, MAX_PREPARED_DRAWING_CHANGES, type BoardSurfaceOperation } from "../src/tutor-board-surface.js";
import { SurfaceCommitError, type ChangeSet } from "../src/tutor-surface.js";
import { memorySurfaceJournal } from "./surface-journal-fixture.js";
function object(id:string):BoardObject{return {id,kind:"rect",anchor:{kind:"canvas",pageId:"main"},x:0,y:0,width:100,height:60,color:"#000000",strokeWidth:2,createdBy:"human",editedBy:"human",revision:1,groupId:"original"};}
function fixture(save?:(history:BoardHistory)=>Promise<void>){
  const history=new BoardHistory({...createBoardDocument("test.tutorboard.md","standalone","board"),objects:[object("existing")]}),grant={clientId:"client",targets:["board"],read:true,write:true,humanObjectIds:["existing"],learningMemory:false};
  let saves=0,changes=0;
  const surface=new TutorBoardSurface("board","studio",{history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>[],save:async()=>{saves++;await save?.(history);},preview:async()=>"<svg/>",changed:()=>{changes++;}},memorySurfaceJournal());
  return {surface,history,grant,counts:()=>({saves,changes})};
}
async function add(f:ReturnType<typeof fixture>,id="change"):Promise<ChangeSet<BoardSurfaceOperation>>{return {id,taskId:"task",targetId:"board",baseRevision:(await f.surface.read()).target.revision,dependencies:[],operations:[{type:"add",object:object("agent-created")}]};}
describe("R04 board commit receipts",()=>{
  it("keeps exact IDs and application revision while saving alongside new human ink",async()=>{
    const f=fixture(async history=>{history.transact(document=>document.objects.push(object("human-during-save")));}),change=await add(f);
    const result=await f.surface.commit(change,f.grant,new AbortController().signal);
    expect(result.receipt).toMatchObject({createdIds:["agent-created"],updatedIds:[],deletedIds:[],durability:"committed",appliedRevision:"1",committedRevision:"1"});
    expect((await f.surface.read()).target.revision).toBe("2");
    expect(f.history.document.objects.map(item=>item.id)).toEqual(["existing","agent-created","human-during-save"]);
    await f.surface.commit(change,f.grant,new AbortController().signal);expect(f.counts()).toEqual({saves:1,changes:1});
    // Tutor applied once; the separate human transaction is the latest undo unit.
    f.history.undo();expect(f.history.document.objects.map(item=>item.id)).toEqual(["existing","agent-created"]);
    f.history.undo();expect(f.history.document.objects.map(item=>item.id)).toEqual(["existing"]);
  });
  it("records updates and removals without treating pre-existing Tutor author labels as a grant",async()=>{
    const f=fixture(),before=f.history.document;
    f.history.transact(document=>document.objects.push({...object("other-client"),createdBy:"tutor",editedBy:"tutor"}),"tutor");
    const change=await add(f);
    await expect(f.surface.commit({...change,operations:[{type:"remove",objectId:"other-client",expectedRevision:1}]},f.grant,new AbortController().signal)).rejects.toThrow("outside-grant");
    const result=await f.surface.commit({...change,operations:[{type:"remove",objectId:"existing",expectedRevision:before.objects[0]!.revision}]},f.grant,new AbortController().signal);
    expect(result.receipt).toMatchObject({createdIds:[],updatedIds:[],deletedIds:["existing"]});expect(f.counts()).toEqual({saves:1,changes:1});
  });
  it("retains an applied difference after save failure and does not add another undo unit on retry",async()=>{
    const f=fixture(async()=>{throw new Error("disk-full");}),change=await add(f);
    const error=await f.surface.commit(change,f.grant,new AbortController().signal).catch(error=>error) as SurfaceCommitError;
    expect(error.result.receipt).toMatchObject({createdIds:["agent-created"],durability:"applied-not-durable"});
    await expect(f.surface.commit(change,f.grant,new AbortController().signal)).rejects.toThrow("applied-not-durable");
    expect(f.counts()).toEqual({saves:1,changes:1});f.history.undo();expect(f.history.document.objects.map(item=>item.id)).toEqual(["existing"]);expect(f.history.canUndo).toBe(false);
  });
  it("keeps a user's later modification and returns outcome-unknown instead of saved",async()=>{
    const f=fixture(async history=>{history.transact(document=>{document.objects.find(item=>item.id==="agent-created")!.x=500;});}),change=await add(f);
    const error=await f.surface.commit(change,f.grant,new AbortController().signal).catch(error=>error) as SurfaceCommitError;
    expect(error.result.receipt.durability).toBe("outcome-unknown");
    await expect(f.surface.commit(change,f.grant,new AbortController().signal)).rejects.toThrow("outcome-unknown");
    expect(f.history.document.objects.find(item=>item.id==="agent-created")!.x).toBe(500);expect(f.counts()).toEqual({saves:1,changes:1});
  });
  it("commits a full reference reconstruction as one exact local transaction and one undo",async()=>{
    const f=fixture(),before=f.history.document.objects,added=Array.from({length:MAX_PREPARED_DRAWING_CHANGES},(_,index)=>({...object(`stroke-${index}`),x:index%100,groupId:`paint-group-${index%2}`}));
    const drawing={id:"reference",taskId:"local-task",targetId:"board",baseRevision:(await f.surface.read()).target.revision,before,after:[...before,...added],dependencies:[]};
    const result=await f.surface.commitPreparedDrawing(drawing,{...f.grant,clientId:"obsidian"},new AbortController().signal);
    expect(result.receipt.createdIds).toEqual(added.map(item=>item.id));expect(result.receipt.updatedIds).toEqual([]);
    expect(f.history.document.objects.slice(1).map(item=>item.groupId)).toEqual(added.map(item=>item.groupId));
    expect(f.history.document.objects[0]).toEqual(before[0]);expect(f.counts()).toEqual({saves:1,changes:1});
    await f.surface.commitPreparedDrawing(drawing,{...f.grant,clientId:"obsidian"},new AbortController().signal);
    expect(f.counts()).toEqual({saves:1,changes:1});f.history.undo();expect(f.history.document.objects).toEqual(before);expect(f.history.canUndo).toBe(false);
  });
  it("retains the external limit and rejects large, duplicate or ungranted prepared differences",async()=>{
    const f=fixture(),before=f.history.document.objects,change=await add(f),added=Array.from({length:129},(_,index)=>object(`added-${index}`));
    await expect(f.surface.commit({...change,operations:added.map(object=>({type:"add",object}))},f.grant,new AbortController().signal)).rejects.toThrow();
    const drawing={id:"prepared",taskId:"task",targetId:"board",baseRevision:change.baseRevision,before,after:added,dependencies:[]};
    await expect(f.surface.commitPreparedDrawing(drawing,f.grant,new AbortController().signal)).rejects.toThrow("local-client");
    await expect(f.surface.commitPreparedDrawing(drawing,{...f.grant,clientId:"obsidian",humanObjectIds:[]},new AbortController().signal)).rejects.toThrow("outside-grant");
    expect(()=>compileBoardObjectChanges(before,[object("same"),object("same")])).toThrow("duplicate-object");
    expect(()=>compileBoardObjectChanges([],Array.from({length:MAX_PREPARED_DRAWING_CHANGES+1},(_,index)=>object(`too-many-${index}`)))).toThrow("change-limit");
    expect(f.counts()).toEqual({saves:0,changes:0});
  });
  it("requires the actual preview baseline and retries only a failed prepared save",async()=>{
    let failed=true;const f=fixture(async()=>{if(failed)throw new Error("disk-full");}),before=f.history.document.objects;
    const drawing={id:"prepared",taskId:"task",targetId:"board",baseRevision:(await f.surface.read()).target.revision,before,after:[...before,object("drawn")],dependencies:[]},grant={...f.grant,clientId:"obsidian"};
    await expect(f.surface.commitPreparedDrawing({...drawing,before:[{...before[0]!,x:999}]},grant,new AbortController().signal)).rejects.toThrow("scene-changed");
    const error=await f.surface.commitPreparedDrawing(drawing,grant,new AbortController().signal).catch(error=>error) as SurfaceCommitError;
    expect(error.result.receipt).toMatchObject({createdIds:["drawn"],durability:"applied-not-durable"});failed=false;
    await expect(f.surface.commitPreparedDrawing(drawing,grant,new AbortController().signal)).rejects.toThrow("applied-not-durable");
    await f.surface.recoverCommit(error.result.receipt.transactionId,grant,new AbortController().signal,"retry-save");
    expect(f.counts()).toEqual({saves:2,changes:1});f.history.undo();expect(f.history.document.objects).toEqual(before);expect(f.history.canUndo).toBe(false);
  });
});
