import { describe, expect, it } from "vitest";
import { BoardHistory, createBoardDocument } from "../src/board-model.js";
import type { BoardDocument, BoardObject } from "../src/board-types.js";
import { TutorBoardSurface, type BoardSurfaceOperation } from "../src/tutor-board-surface.js";
import { SurfaceCommitError, surfaceDigest, type ChangeSet } from "../src/tutor-surface.js";
import { SurfaceTransactionJournal, SURFACE_TRANSACTION_POLICY, type SurfaceJournalIO } from "../src/surface-transaction-journal.js";
import { TutorTaskCoordinator } from "../src/tutor-task.js";
import { surfaceJournalFixture } from "./surface-journal-fixture.js";

const drawing=(id:string):BoardObject=>({id,kind:"text",anchor:{kind:"canvas",pageId:"main"},x:0,y:0,width:100,height:60,color:"#111111",strokeWidth:2,text:"PRIVATE GENERATED LABEL",createdBy:"human",editedBy:"human",revision:1,groupId:"original"});
const grant={clientId:"client",targets:["board"],read:true,write:true,humanObjectIds:[],learningMemory:false};
function boardFixture(options:{now?:()=>number;save?:(history:BoardHistory)=>Promise<void>;changed?:()=>void;io?:(base:SurfaceJournalIO)=>SurfaceJournalIO}={}){
  const disk=surfaceJournalFixture(options.now),io=options.io?.(disk.io)??disk.io;
  const journal=new SurfaceTransactionJournal(io,"surface.json",options.now),initial={...createBoardDocument("private-source-name.tutorboard.md","standalone","board"),objects:[]};
  let saved:BoardDocument=structuredClone(initial),saves=0,applications=0;
  const history=new BoardHistory(initial);
  const makeSurface=(current:BoardHistory,log:SurfaceTransactionJournal)=>new TutorBoardSurface("board","studio",{history:()=>current,ink:()=>({}),alive:()=>true,selection:()=>[],preview:async()=>"<svg/>",changed:()=>{applications++;options.changed?.();},save:async()=>{saves++;await options.save?.(current);saved=current.document;}},log);
  const surface=makeSurface(history,journal);
  const changes=async(id="transaction",objectId="created"):Promise<ChangeSet<BoardSurfaceOperation>>=>({id,taskId:"task",targetId:"board",baseRevision:(await surface.read()).target.revision,operations:[{type:"add",object:drawing(objectId)}],dependencies:[]});
  return {surface,history,journal,disk,io,changes,makeSurface,reloadJournal:()=>new SurfaceTransactionJournal(io,"surface.json",options.now),saved:()=>structuredClone(saved),counts:()=>({saves,applications})};
}
const signal=()=>new AbortController().signal;
describe("R04 durable surface transaction recovery",()=>{
  it("persists only bounded metadata and restores both replay protection and exact-version ownership",async()=>{
    const f=boardFixture(),change=await f.changes();await f.surface.commit(change,grant,signal());
    const raw=f.disk.files.get("surface.json")!;
    expect(raw).not.toContain("PRIVATE GENERATED LABEL");expect(raw).not.toContain("private-source-name");expect(raw).not.toContain('"operations"');
    const reloaded=f.makeSurface(new BoardHistory(f.saved()),f.reloadJournal());
    const prior=await reloaded.commit(change,grant,signal());expect(prior.receipt.durability).toBe("committed");expect(f.counts()).toEqual({saves:1,applications:1});
    const scene=await reloaded.read(),object=scene.objects[0] as BoardObject;
    const result=await reloaded.commit({id:"edit",taskId:"edit-task",targetId:"board",baseRevision:scene.target.revision,operations:[{type:"update",objectId:object.id,expectedRevision:object.revision,object:{...object,x:25}}],dependencies:[]},grant,signal());
    expect(result.receipt.updatedIds).toEqual(["created"]);expect(f.counts()).toEqual({saves:2,applications:2});
  });
  it("does not extend persistent ownership to an object subsequently changed by a person",async()=>{
    const f=boardFixture();await f.surface.commit(await f.changes(),grant,signal());
    f.history.transact(document=>{document.objects[0]!.text="human revision";});
    const scene=await f.surface.read(),object=scene.objects[0] as BoardObject;
    await expect(f.surface.commit({id:"edit",taskId:"edit-task",targetId:"board",baseRevision:scene.target.revision,operations:[{type:"update",objectId:object.id,expectedRevision:object.revision,object:{...object,x:20}}],dependencies:[]},grant,signal())).rejects.toThrow("outside-grant");
    expect(f.history.document.objects[0]!.text).toBe("human revision");
  });
  it("retries only saving an unchanged applied difference, including after reloading the journal",async()=>{
    let fail=true;const f=boardFixture({save:async()=>{if(fail)throw new Error("disk-full");}}),change=await f.changes();
    await expect(f.surface.commit(change,grant,signal())).rejects.toThrow("applied-not-durable");
    const reloaded=f.makeSurface(f.history,f.reloadJournal());
    await expect(reloaded.commit(change,grant,signal())).rejects.toThrow("applied-not-durable");expect(f.counts()).toEqual({saves:1,applications:1});
    fail=false;const before=f.history.document.revision;
    const saved=await reloaded.recoverCommit(change.id,grant,signal(),"retry-save");
    expect(saved.receipt.durability).toBe("committed");expect(f.history.document.revision).toBe(before);expect(f.counts()).toEqual({saves:2,applications:1});
    f.history.undo();expect(f.history.document.objects).toEqual([]);expect(f.history.canUndo).toBe(false);
  });
  it("does not reconstruct missing unsaved content after native undo or a reload from an older disk scene",async()=>{
    const f=boardFixture({save:async()=>{throw new Error("disk-full");}}),change=await f.changes();
    await expect(f.surface.commit(change,grant,signal())).rejects.toThrow("applied-not-durable");
    const reload=f.makeSurface(new BoardHistory(f.saved()),f.reloadJournal());
    expect((await reload.recoverCommit(change.id,grant,signal(),"inspect")).receipt.durability).toBe("outcome-unknown");
    await expect(reload.recoverCommit(change.id,grant,signal(),"retry-save")).rejects.toThrow("inspect-before-save");
    expect((await reload.read()).objects).toEqual([]);expect(f.counts()).toEqual({saves:1,applications:1});
  });
  it("records unknown if application occurred but its journal acknowledgment failed, then requires explicit inspection",async()=>{
    let fail=true;const f=boardFixture({io:base=>({...base,compareWrite:async(path,previous,next)=>{if(fail&&JSON.parse(next).records?.at(-1)?.phase==="applied")throw new Error("disk-full");await base.compareWrite(path,previous,next);}})}),change=await f.changes();
    await expect(f.surface.commit(change,grant,signal())).rejects.toThrow("outcome-unknown");expect(f.counts()).toEqual({saves:0,applications:1});
    await expect(f.journal.flush()).rejects.toThrow("write-not-confirmed");fail=false;
    const reload=f.makeSurface(f.history,f.reloadJournal());
    await expect(reload.commit(change,grant,signal())).rejects.toThrow("outcome-unknown");
    await expect(reload.recoverCommit(change.id,grant,signal(),"retry-save")).rejects.toThrow("inspect-before-save");
    expect((await reload.recoverCommit(change.id,grant,signal(),"inspect")).receipt.durability).toBe("applied-not-durable");
    expect((await reload.recoverCommit(change.id,grant,signal(),"retry-save")).receipt.durability).toBe("committed");expect(f.counts()).toEqual({saves:1,applications:1});
  });
  it("does not reapply when disk save succeeded but the final receipt was not durably recorded",async()=>{
    let fail=true;const f=boardFixture({io:base=>({...base,compareWrite:async(path,previous,next)=>{if(fail&&JSON.parse(next).records?.at(-1)?.phase==="committed")throw new Error("disk-full");await base.compareWrite(path,previous,next);}})}),change=await f.changes();
    await expect(f.surface.commit(change,grant,signal())).rejects.toThrow("saved-but-journal-not-confirmed");expect(f.saved().objects).toHaveLength(1);fail=false;
    const reload=f.makeSurface(new BoardHistory(f.saved()),f.reloadJournal());
    await expect(reload.commit(change,grant,signal())).rejects.toThrow("outcome-unknown");expect(f.counts()).toEqual({saves:1,applications:1});
    expect((await reload.recoverCommit(change.id,grant,signal(),"inspect")).receipt.durability).toBe("applied-not-durable");
    await reload.recoverCommit(change.id,grant,signal(),"retry-save");expect(f.counts()).toEqual({saves:2,applications:1});
  });
  it("fails before application when prepared metadata cannot be confirmed",async()=>{
    const f=boardFixture({io:base=>({...base,compareWrite:async()=>{throw new Error("disk-full");}})});
    await expect(f.surface.commit(await f.changes(),grant,signal())).rejects.toThrow("journal-write-not-confirmed");
    expect(f.history.document.objects).toEqual([]);expect(f.counts()).toEqual({saves:0,applications:0});expect((await f.surface.read()).target.id).toBe("board");
  });
  it.each(["prepared","applying"])("rechecks human scene changes after the %s journal write",async phase=>{
    const f=boardFixture({io:base=>({...base,compareWrite:async(path,previous,next)=>{
      await base.compareWrite(path,previous,next);
      if(JSON.parse(next).records?.at(-1)?.phase===phase)f.history.transact(document=>{document.objects.push(drawing("human-during-journal"));});
    }})});
    const error=await f.surface.commit(await f.changes(),grant,signal()).catch(error=>error) as SurfaceCommitError;
    expect(error.result.receipt.durability).toBe("not-applied");expect(f.counts()).toEqual({saves:0,applications:0});
    expect(f.history.document.objects.map(object=>object.id)).toEqual(["human-during-journal"]);
    f.history.undo();expect(f.history.document.objects).toEqual([]);expect(f.history.canUndo).toBe(false);
  });
  it("blocks writes without a journal while keeping local reads and previews usable",async()=>{
    const history=new BoardHistory(createBoardDocument("a.md","standalone","board")),surface=new TutorBoardSurface("board","studio",{history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>[],preview:async()=>"<svg/>",changed:()=>{},save:async()=>{}});
    expect((await surface.read()).objects).toEqual([]);expect(await surface.preview()).toBe("<svg/>");
    await expect(surface.commit({id:"new",taskId:"task",targetId:"board",baseRevision:"0",operations:[{type:"add",object:drawing("created")}],dependencies:[]},grant,signal())).rejects.toThrow("journal-unavailable");
  });
  it("preserves expired replay barriers after receipt pruning and across process reloads",async()=>{
    let now=1_000;const f=boardFixture({now:()=>now}),old=await f.changes();await f.surface.commit(old,grant,signal());
    now+=SURFACE_TRANSACTION_POLICY.receiptRetentionMs;
    await expect(f.surface.commit(old,grant,signal())).rejects.toThrow("expired");
    await f.surface.commit(await f.changes("fresh","fresh-object"),grant,signal());
    expect(JSON.parse(f.disk.files.get("surface.json")!).records.map((record:{receipt:{transactionId:string}})=>record.receipt.transactionId)).toEqual(["fresh"]);
    const reload=f.makeSurface(f.history,f.reloadJournal());
    await expect(reload.commit({...old,taskId:"new-task",baseRevision:(await reload.read()).target.revision},grant,signal())).rejects.toThrow("expired-or-filtered");expect(f.counts()).toEqual({saves:2,applications:2});
    // Ownership has its own lifetime; old receipt expiry does not erase a still-matching original object.
    const allowed=await f.reloadJournal().authorizedGrant(grant,"board",f.history.document.objects);expect(allowed.humanObjectIds).toContain("created");
  });
  it("keeps saturated barriers intact, refuses new requests, and still returns existing receipts",async()=>{
    const f=boardFixture(),change=await f.changes();await f.surface.commit(change,grant,signal());
    const manifest=JSON.parse(f.disk.files.get("surface.json")!);manifest.barrier="f".repeat(SURFACE_TRANSACTION_POLICY.barrierBits/4);manifest.barrierSetBits=SURFACE_TRANSACTION_POLICY.barrierBits;manifest.revision++;
    f.disk.files.set("surface.json",JSON.stringify(manifest));const reload=f.makeSurface(f.history,f.reloadJournal());
    expect((await reload.commit(change,grant,signal())).receipt.durability).toBe("committed");
    await expect(reload.commit(await f.changes("new","another"),grant,signal())).rejects.toThrow("barrier-saturated-retain-journal");
    expect(JSON.parse(f.disk.files.get("surface.json")!).barrierSetBits).toBe(SURFACE_TRANSACTION_POLICY.barrierBits);expect(f.counts()).toEqual({saves:1,applications:1});
  });
  it("retains the whole 30-day receipt window at capacity and resumes only after expiry",async()=>{
    let now=1_000;const f=boardFixture({now:()=>now}),first=await f.changes();await f.surface.commit(first,grant,signal());
    const manifest=JSON.parse(f.disk.files.get("surface.json")!),template=manifest.records[0],barrier=manifest.barrier.split("");
    for(let index=1;index<SURFACE_TRANSACTION_POLICY.maxReceipts;index++){
      const record=structuredClone(template);record.receipt.transactionId=`prior-${index}`;record.receipt.requestId=`task-${index}`;
      record.key=surfaceDigest(["client","board",record.receipt.transactionId]);
      for(let hash=0;hash<SURFACE_TRANSACTION_POLICY.barrierHashes;hash++){
        const bit=parseInt(record.key.slice(hash*8,hash*8+8),16)%SURFACE_TRANSACTION_POLICY.barrierBits,pos=Math.floor(bit/4),old=parseInt(barrier[pos]!,16),next=old|(1<<(bit%4));
        if(old!==next)manifest.barrierSetBits++;barrier[pos]=next.toString(16);
      }
      manifest.records.push(record);
    }
    manifest.barrier=barrier.join("");manifest.revision++;f.disk.files.set("surface.json",JSON.stringify(manifest));
    const reload=f.makeSurface(f.history,f.reloadJournal());
    await expect(reload.commit(await f.changes("new","another"),grant,signal())).rejects.toThrow("receipt-capacity-wait-for-retention-expiry");
    expect((await reload.commit(first,grant,signal())).receipt.durability).toBe("committed");expect(f.counts().applications).toBe(1);
    expect(JSON.parse(f.disk.files.get("surface.json")!).records).toHaveLength(SURFACE_TRANSACTION_POLICY.maxReceipts);
    now+=SURFACE_TRANSACTION_POLICY.receiptRetentionMs;
    await reload.commit(await f.changes("new","another"),grant,signal());
    expect(JSON.parse(f.disk.files.get("surface.json")!).records).toHaveLength(1);expect(f.counts().applications).toBe(2);
    await expect(reload.commit(first,grant,signal())).rejects.toThrow("expired-or-filtered");
  });
  it.each(["{broken",JSON.stringify({format:"tutor-surface-transactions-v99"})])("leaves corrupt or unsupported journal bytes untouched",async raw=>{
    const f=boardFixture();await f.journal.initialize();f.disk.files.set("surface.json",raw);
    await expect(f.surface.commit(await f.changes(),grant,signal())).rejects.toThrow("surface-journal");expect(f.disk.files.get("surface.json")).toBe(raw);expect(f.counts()).toEqual({saves:0,applications:0});
  });
  it.each(["surface.json","surface.json.initialized"])("refuses a missing %s after restarting and preserves the remaining file",async missing=>{
    const f=boardFixture();await f.surface.commit(await f.changes(),grant,signal());f.disk.files.delete(missing);
    const before=[...f.disk.files.entries()],reloaded=f.reloadJournal();
    await expect(reloaded.initialize()).rejects.toThrow("surface-journal");expect(reloaded.status().available).toBe(false);
    const surface=f.makeSurface(f.history,reloaded);
    await expect(surface.commit(await f.changes("new","new-object"),grant,signal())).rejects.toThrow("surface-journal");
    expect([...f.disk.files.entries()]).toEqual(before);expect(f.counts().applications).toBe(1);
  });
  it("retains a partial initialization and refuses automatic repair or mismatched journal identity",async()=>{
    const disk=surfaceJournalFixture(),broken=new SurfaceTransactionJournal({...disk.io,compareWrite:async(path,previous,next)=>{
      if(path.endsWith(".initialized"))throw new Error("disk-full");await disk.io.compareWrite(path,previous,next);
    }},"surface.json");
    await expect(broken.initialize()).rejects.toThrow("initialization-not-confirmed");
    expect(disk.files.has("surface.json")).toBe(true);expect(disk.files.has("surface.json.initialized")).toBe(false);
    await expect(disk.reload().initialize()).rejects.toThrow("marker-missing");
    const other=surfaceJournalFixture();await other.journal.initialize();disk.files.set("surface.json.initialized",other.files.get("surface.json.initialized")!);
    await expect(disk.reload().initialize()).rejects.toThrow("identity-mismatch");
  });
});

describe("R15 cancellation at surface commit boundaries",()=>{
  it("cancels between preparation and application with a durable not-applied result",async()=>{
    const abort=new AbortController();const f=boardFixture({io:base=>({...base,compareWrite:async(path,previous,next)=>{await base.compareWrite(path,previous,next);if(JSON.parse(next).records?.at(-1)?.phase==="prepared")abort.abort();}})});
    const error=await f.surface.commit(await f.changes(),grant,abort.signal).catch(error=>error) as SurfaceCommitError;
    expect(error.result.receipt.durability).toBe("not-applied");expect(f.counts()).toEqual({saves:0,applications:0});
  });
  it("reports applied-not-saved after cancellation at the apply point and committed-after-cancel after a successful pending save",async()=>{
    for(const boundary of ["apply","save"] as const){
      const tasks=new TutorTaskCoordinator();try{
        const task=tasks.start({clientId:"client",target:{id:"board",source:"a.md",surface:"studio",revision:"0"}});
        const f=boardFixture({changed:()=>{if(boundary==="apply")tasks.cancel(task.id,"client");},save:async()=>{if(boundary==="save")tasks.cancel(task.id,"client");}});
        const change={...await f.changes(),taskId:task.id},commitGrant={...grant,onSurfaceCommit:(receipt:Parameters<TutorTaskCoordinator["recordSurfaceCommit"]>[0])=>tasks.recordSurfaceCommit(receipt)};
        try{const result=await f.surface.commit(change,commitGrant,tasks.signal(task.id,"client"));tasks.recordSurfaceCommit(result.receipt,true);}catch(error){if(error instanceof SurfaceCommitError)tasks.recordSurfaceCommit(error.result.receipt,true);else throw error;}
        const result=tasks.get(task.id,"client");
        expect(result).toMatchObject(boundary==="apply"?{state:"input-required",phase:"applied-not-saved",commit:{durability:"applied-not-durable"}}:{state:"completed",phase:"committed-after-cancel",commit:{durability:"committed"}});
        expect(f.counts()).toEqual({applications:1,saves:boundary==="apply"?0:1});
      }finally{tasks.dispose();}
    }
  });
});
