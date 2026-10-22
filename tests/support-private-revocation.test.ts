import { mkdtemp,realpath,rm,readFile,readdir,writeFile,stat,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { describe,it,expect,vi,afterEach } from "vitest";
import { PrivateSupportStore,type SupportCipher } from "../src/support-private-store.js";
import { SupportSession,type SupportSummary,type SupportStorage } from "../src/support-session.js";

const date=new Date("2026-10-10T03:00:00Z"),roots:string[]=[];
const summary=(text:string,days=7):SupportSummary=>({format:1,id:randomUUID(),text,confirmedAt:date.toISOString(),expiresAt:new Date(+date+days*86400000).toISOString()});
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),"tutor-support-revoke-")));roots.push(root);
  const vault="/synthetic-support-vault",directory=join(root,"Tutor","private-support",createHash("sha256").update(vault).digest("hex").slice(0,32));
  const fault={kind:"" as ""|"array"|"record",available:true,throwAvailability:false,backend:""};
  const cipher:SupportCipher={isEncryptionAvailable:()=>{if(fault.throwAvailability)throw Error("PRIVATE-UNSAFE-ERROR");return fault.available;},getSelectedStorageBackend:()=>fault.backend,
    encryptString:text=>{const kind=Array.isArray(JSON.parse(text))?"array":"record";if(kind===fault.kind){fault.kind="";throw Error("PRIVATE-UNSAFE-ERROR");}return Buffer.from(Buffer.from(text).map(b=>b^199));},
    decryptString:bytes=>Buffer.from(bytes.map(b=>b^199)).toString()};
  const store=()=>new PrivateSupportStore(root,vault,cipher);
  return {root,vault,directory,fault,cipher,store,read:async(name:string)=>readFile(join(directory,name))};
}

describe("durable private support revocation",()=>{
  it("does not resurrect a deletion after the remaining manifest fails; retains the other summary",async()=>{
    const f=await fixture(),db=f.store(),deleted=summary("DELETED-PRIVATE-FIXTURE"),keep=summary("KEEP-PRIVATE-FIXTURE");await db.save([deleted,keep]);
    const s=new SupportSession(db,async()=>"ok",()=>date);await s.initialize();f.fault.kind="array";
    await expect(s.delete(deleted.id)).rejects.toThrow(/^support-store-unavailable$/);
    expect(s.summaries).toEqual([keep]);expect(s.error).toBe("support-delete-failed");await expect(s.flush()).rejects.toThrow();
    await expect(f.read("summaries.enc")).rejects.toMatchObject({code:"ENOENT"});
    expect(await f.store().load()).toEqual([keep]);
    let context="";const fresh=new SupportSession(f.store(),async(_m,system)=>{context=system;return "ok";},()=>date);await fresh.initialize();await fresh.send("合成验收");
    expect(context).not.toContain(deleted.text);expect(context).toContain(keep.text);
    await s.retrySave();expect(await f.store().load()).toEqual([keep]);await expect(f.read("summaries.suspended.enc")).rejects.toMatchObject({code:"ENOENT"});
    await expect(f.store().save([deleted,keep])).rejects.toThrow("support-summary-revoked");expect(await db.load()).toEqual([keep]);s.dispose();fresh.dispose();
  });
  it("keeps an incomplete attestation unavailable after restart, but the original explicit retry can recover",async()=>{
    const f=await fixture(),db=f.store(),deleted=summary("REVOKED"),keep=summary("RETAINED");await db.save([deleted,keep]);f.fault.kind="record";
    await expect(db.revoke([deleted.id])).rejects.toThrow(/^support-store-unavailable$/);const recovery=await f.read("summaries.suspended.enc");
    await expect(f.read("summaries.enc")).rejects.toMatchObject({code:"ENOENT"});const fresh=f.store();await expect(fresh.load()).rejects.toThrow("support-store-unavailable");expect(fresh.available()).toBe(false);
    await expect(fresh.revoke([deleted.id])).rejects.toThrow("support-store-unavailable");expect(await f.read("summaries.suspended.enc")).toEqual(recovery);
    await db.revoke([deleted.id]);await db.save([keep]);expect(await f.store().load()).toEqual([keep]);
  });
  it("does not reuse an older attestation of identical bytes for a new, incomplete deletion",async()=>{
    const f=await fixture(),db=f.store(),deleted=summary("IDENTICAL-BYTES"),keep=summary("KEEP");await db.save([deleted,keep]);
    await db.revoke([randomUUID()]);await db.save([deleted,keep]);const oldRecord=await f.read("revocations.enc");
    f.fault.kind="record";await expect(db.revoke([deleted.id])).rejects.toThrow();expect(await f.read("revocations.enc")).toEqual(oldRecord);
    await expect(f.store().load()).rejects.toThrow("support-store-unavailable");await db.revoke([deleted.id]);await db.save([keep]);expect(await f.store().load()).toEqual([keep]);
  });
  it("retains owned recovery after a directory sync failure during retry",async()=>{
    const f=await fixture(),db=f.store(),deleted=summary("DELETE"),keep=summary("KEEP");await db.save([deleted,keep]);f.fault.kind="record";await expect(db.revoke([deleted.id])).rejects.toThrow();
    // Fault at the real atomic write's durability barrier after replacing the
    // suspended file, rather than a simulated storage success.
    const sync=vi.spyOn(db as unknown as {syncDirectory():Promise<void>},"syncDirectory").mockRejectedValueOnce(Error("sync-fault"));
    await expect(db.revoke([deleted.id])).rejects.toThrow("support-store-unavailable");sync.mockRestore();
    await expect(f.store().load()).rejects.toThrow();await db.revoke([deleted.id]);await db.save([keep]);expect(await f.store().load()).toEqual([keep]);
  });
  it.each(["unavailable","throws","basic_text"])("has no plaintext fallback when encryption %s during deletion",async mode=>{
    const f=await fixture(),db=f.store(),deleted=summary("PRIVATE-CIPHER-FIXTURE"),keep=summary("KEEP");await db.save([deleted,keep]);
    if(mode==="unavailable")f.fault.available=false;else if(mode==="throws")f.fault.throwAvailability=true;else f.fault.backend="basic_text";
    expect(db.available()).toBe(false);await expect(db.revoke([deleted.id])).rejects.toThrow("support-encryption-unavailable");await expect(f.read("summaries.enc")).rejects.toMatchObject({code:"ENOENT"});
    for(const name of await readdir(f.directory))expect((await f.read(name)).includes(Buffer.from(deleted.text))).toBe(false);
    f.fault.available=true;f.fault.throwAvailability=false;f.fault.backend="";
    await expect(f.store().load()).rejects.toThrow("support-store-unavailable");await db.revoke([deleted.id]);await db.save([keep]);expect(await f.store().load()).toEqual([keep]);
  });
  it("revokes expiry before responding even when cleanup fails and supports retry",async()=>{
    const f=await fixture(),db=f.store(),expired=summary("EXPIRED-PRIVATE"),keep=summary("VALID",20);await db.save([expired,keep]);
    let now=date,context="";const run=vi.fn(async(_m:unknown,system:string)=>{context=system;return "ok";}),s=new SupportSession(db,run,()=>now);await s.initialize();now=new Date(+date+7*86400000);f.fault.kind="array";
    await expect(s.send("hello")).rejects.toThrow();expect(run).not.toHaveBeenCalled();expect(await f.store().load()).toEqual([keep]);
    await s.retrySave();await s.send("hello");expect(context).not.toContain(expired.text);expect(context).toContain(keep.text);s.dispose();
  });
  it("loads the legacy array, writes encrypted files with private modes, and refuses an in-Vault directory",async()=>{
    const f=await fixture(),item=summary("NO-PLAINTEXT-PRIVATE-FIXTURE"),db=f.store();await db.save([item]);expect(await db.load()).toEqual([item]);
    // Windows does not expose POSIX group/other permission bits through stat.
    // Encryption and Vault isolation below remain required on every platform.
    if(process.platform!=="win32"){
      expect((await stat(f.directory)).mode&0o777).toBe(0o700);expect((await stat(join(f.directory,"summaries.enc"))).mode&0o777).toBe(0o600);
    }
    for(const name of await readdir(f.directory))expect((await f.read(name)).includes(Buffer.from(item.text))).toBe(false);
    const inside=new PrivateSupportStore(f.root,f.root,f.cipher);expect(inside.available()).toBe(false);await expect(inside.save([item])).rejects.toThrow();await expect(inside.writeDay("2026-10-10")).rejects.toThrow("support-store-unavailable");
  });
  it.each(["corrupt","duplicate","oversize","symlink","partial-attestation"])("fails closed on %s and preserves the original bytes",async mode=>{
    const f=await fixture(),item=summary("PRIVATE"),db=f.store();await db.save([item]);let target=join(f.directory,"summaries.enc");
    if(mode==="corrupt")await writeFile(target,"not-encrypted");
    if(mode==="duplicate")await writeFile(target,f.cipher.encryptString(JSON.stringify([item,item])));
    if(mode==="oversize")await writeFile(target,Buffer.alloc(131073));
    if(mode==="symlink"){const outside=join(f.root,"outside.enc");await writeFile(outside,await f.read("summaries.enc"));await rm(target);await symlink(outside,target);}
    if(mode==="partial-attestation"){target=join(f.directory,"revocations.enc");await writeFile(target,f.cipher.encryptString(JSON.stringify({format:1,ids:[],suspendedSha256:"a".repeat(64)})));}
    const before=await readFile(target);await expect(db.load()).rejects.toThrow(/^support-store-unavailable$/);expect(db.available()).toBe(false);expect(await readFile(target)).toEqual(before);
    await expect(db.save([])).rejects.toThrow();
  });
  it("refuses live and abandoned locks without guessing their age or changing their files",async()=>{
    const f=await fixture(),db=f.store(),item=summary("PRIVATE");await db.save([item]);const before=await f.read("summaries.enc");
    for(const pid of [process.pid,2147483647]){const bytes=JSON.stringify({version:1,pid,nonce:randomUUID()});await writeFile(join(f.directory,"support-write.lock"),bytes);const reader=f.store();await expect(reader.load()).rejects.toThrow("support-store-unavailable");expect(await f.read("summaries.enc")).toEqual(before);expect((await f.read("support-write.lock")).toString()).toBe(bytes);await rm(join(f.directory,"support-write.lock"));}
    expect(await f.store().load()).toEqual([item]);
  });
  it("serializes independent instances and rejects a queued stale save containing a revoked ID",async()=>{
    const f=await fixture(),item=summary("DELETED"),keep=summary("KEEP"),a=f.store(),b=f.store();await a.save([item,keep]);
    const revoked=a.revoke([item.id]),stale=b.save([item,keep]);await revoked;await expect(stale).rejects.toThrow("support-summary-revoked");await b.save([keep]);expect(await a.load()).toEqual([keep]);
  });
});

describe("pending confirmation and deletion queue",()=>{
  it("does not expose or persist a failed confirmation in a later deletion snapshot",async()=>{
    let saved:SupportSummary[]=[],release!:()=>void,context="";
    const db:SupportStorage={available:()=>true,load:async()=>structuredClone(saved),readDay:async()=>"",writeDay:async()=>{},save:async items=>{saved=structuredClone(items);}};
    const s=new SupportSession(db,async(_m,system)=>{context=system;return "ok";},()=>date);const old=await s.confirm("OLD");
    const gate=new Promise<void>(r=>{release=r;});db.save=async()=>{await gate;throw Error("disk-fault");};
    const confirming=s.confirm("UNCONFIRMED-PRIVATE-FIXTURE");const failure=expect(confirming).rejects.toThrow("disk-fault");await Promise.resolve();await s.send("hello");expect(context).not.toContain("UNCONFIRMED-PRIVATE-FIXTURE");
    const deleting=s.delete(old.id);db.save=async items=>{saved=structuredClone(items);};release();await failure;await deleting;
    expect(saved).toEqual([]);expect(s.summaries).toEqual([]);s.dispose();
  });
  it("keeps confirmations isolated and only returns receipts for their own successful save",async()=>{
    const snapshots:SupportSummary[][]=[];let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),writing=new Promise<void>(r=>{started=r;});let calls=0;
    const db:SupportStorage={available:()=>true,load:async()=>[],readDay:async()=>"",writeDay:async()=>{},save:async items=>{snapshots.push(structuredClone(items));if(++calls===1){started();await gate;}}};
    const s=new SupportSession(db,async()=>"",()=>date);const a=s.confirm("A"),b=s.confirm("B");await writing;expect(snapshots[0]?.map(s=>s.text)).toEqual(["A"]);release();await Promise.all([a,b]);expect(snapshots.map(items=>items.map(s=>s.text))).toEqual([["A"],["A","B"]]);s.dispose();
  });
});
