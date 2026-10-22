import { describe, expect, it, vi } from "vitest";
import { SurfaceTransactionJournal, type SurfaceJournalIdentityBinding } from "../src/surface-transaction-journal.js";
import { surfaceJournalFixture } from "./surface-journal-fixture.js";

const journalId=(files:Map<string,string>)=>(JSON.parse(files.get("surface.json")!) as {journalId:string}).journalId;
describe("surface journal identity outside the state directory",()=>{
  it("keeps writes unavailable until both journal files and external settings are confirmed",async()=>{
    const disk=surfaceJournalFixture();let persisted:string|null=null,entered!:()=>void,release!:()=>void;
    const waiting=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const persistJournalId=vi.fn(async(id:string)=>{expect(disk.files.has("surface.json.initialized")).toBe(true);entered();await gate;persisted=id;});
    const journal=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId:null,persistJournalId});
    const init=journal.initialize();await waiting;
    expect(journal.status().available).toBe(false);expect(JSON.parse(disk.files.get("surface.json")!).records).toEqual([]);
    release();await init;expect(journal.status().available).toBe(true);expect(persisted).toBe(journalId(disk.files));
    await journal.initialize();expect(persistJournalId).toHaveBeenCalledOnce();
  });
  it("refuses to create an empty journal after the complete state directory disappears",async()=>{
    const disk=surfaceJournalFixture();let expectedJournalId:string|null=null;
    const persistJournalId=vi.fn(async(id:string)=>{expectedJournalId=id;});
    await new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId,persistJournalId}).initialize();
    disk.files.clear();const reloaded=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId,persistJournalId});
    await expect(reloaded.initialize()).rejects.toThrow("bound-state-missing-requires-restoration");
    await expect(reloaded.recordsForClient("obsidian")).rejects.toThrow("bound-state-missing");
    expect(reloaded.status().available).toBe(false);expect(disk.files.size).toBe(0);expect(persistJournalId).toHaveBeenCalledOnce();
  });
  it("adopts a valid existing journal on first migration without rewriting its bytes",async()=>{
    const disk=surfaceJournalFixture();await disk.journal.initialize();const before=[...disk.files.entries()],persistJournalId=vi.fn(async()=>{});
    const migrated=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId:null,persistJournalId});await migrated.initialize();
    expect(persistJournalId).toHaveBeenCalledExactlyOnceWith(journalId(disk.files));expect([...disk.files.entries()]).toEqual(before);expect(migrated.status().available).toBe(true);
  });
  it("retains a journal after settings failure and safely retries binding the same identity",async()=>{
    const disk=surfaceJournalFixture(),persistJournalId=vi.fn(async()=>{throw new Error("private-settings-error");});
    const failed=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId:null,persistJournalId});
    await expect(failed.initialize()).rejects.toThrow("settings-identity-not-confirmed");await expect(failed.flush()).rejects.toThrow("write-not-confirmed");
    const before=[...disk.files.entries()],expected=journalId(disk.files);expect(failed.status().available).toBe(false);
    const retry=vi.fn(async()=>{}),reloaded=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId:null,persistJournalId:retry});
    await reloaded.initialize();expect(retry).toHaveBeenCalledExactlyOnceWith(expected);expect([...disk.files.entries()]).toEqual(before);
  });
  it("recovers when the settings write was durable but its acknowledgement was lost",async()=>{
    const disk=surfaceJournalFixture();let expectedJournalId:string|null=null;
    const failed=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId,persistJournalId:async id=>{expectedJournalId=id;throw new Error("lost acknowledgment");}});
    await expect(failed.initialize()).rejects.toThrow("settings-identity-not-confirmed");const before=[...disk.files.entries()],persistJournalId=vi.fn(async()=>{});
    const reloaded=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId,persistJournalId});await reloaded.initialize();
    expect(persistJournalId).not.toHaveBeenCalled();expect([...disk.files.entries()]).toEqual(before);expect(reloaded.status().available).toBe(true);
  });
  it.each(["mismatch","missing"] as const)("rechecks journal state changed during settings persistence: %s",async change=>{
    const disk=surfaceJournalFixture(),other=surfaceJournalFixture();await other.journal.initialize();
    const journal=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId:null,persistJournalId:async()=>{
      disk.files.clear();if(change==="mismatch")for(const [path,raw] of other.files)disk.files.set(path,raw);
    }});
    await expect(journal.initialize()).rejects.toThrow(change==="mismatch"?"settings-identity-mismatch":"bound-state-missing");expect(journal.status().available).toBe(false);
    expect([...disk.files.entries()]).toEqual(change==="mismatch"?[...other.files.entries()]:[]);
  });
  it("does not overwrite a bound identity with a valid but different journal",async()=>{
    const disk=surfaceJournalFixture();await disk.journal.initialize();const before=[...disk.files.entries()],persistJournalId=vi.fn(async()=>{});
    const journal=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId:crypto.randomUUID(),persistJournalId});
    await expect(journal.initialize()).rejects.toThrow("settings-identity-mismatch");expect([...disk.files.entries()]).toEqual(before);expect(persistJournalId).not.toHaveBeenCalled();
  });
  it("rejects a same-identity rollback while first-migration settings are being saved",async()=>{
    const disk=surfaceJournalFixture();await disk.journal.initialize();const older=disk.files.get("surface.json")!,newer=JSON.parse(older);newer.revision+=5;disk.files.set("surface.json",JSON.stringify(newer));
    const journal=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId:null,persistJournalId:async()=>{disk.files.set("surface.json",older);}});
    await expect(journal.initialize()).rejects.toThrow("revision-regressed");expect(journal.status().available).toBe(false);expect(disk.files.get("surface.json")).toBe(older);
  });
  it.each(["", "invalid", undefined, 42])("does not treat malformed external identity %s as first initialization",async expectedJournalId=>{
    const disk=surfaceJournalFixture(),persistJournalId=vi.fn(async()=>{});
    const journal=new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,{expectedJournalId,persistJournalId} as SurfaceJournalIdentityBinding);
    await expect(journal.initialize()).rejects.toThrow("settings-identity-invalid");expect(disk.files.size).toBe(0);expect(persistJournalId).not.toHaveBeenCalled();
  });
  it("leaves partial journal initialization for restoration without publishing a settings identity",async()=>{
    const disk=surfaceJournalFixture(),persistJournalId=vi.fn(async()=>{}),binding={expectedJournalId:null,persistJournalId};
    const journal=new SurfaceTransactionJournal({...disk.io,compareWrite:async(path,previous,next)=>{if(path.endsWith(".initialized"))throw new Error("disk-full");await disk.io.compareWrite(path,previous,next);}},"surface.json",Date.now,binding);
    await expect(journal.initialize()).rejects.toThrow("initialization-not-confirmed");const before=[...disk.files.entries()];
    await expect(new SurfaceTransactionJournal(disk.io,"surface.json",Date.now,binding).initialize()).rejects.toThrow("marker-missing");
    expect(persistJournalId).not.toHaveBeenCalled();expect([...disk.files.entries()]).toEqual(before);
  });
});
