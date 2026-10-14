import { mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe,it,expect,afterEach } from "vitest";
const {diagnoseTutorLock,recoverTutorLock}=await import(new URL("../scripts/recover-private-state.mjs",import.meta.url).href);
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(pid=2147483647){
  const root=await realpath(await mkdtemp(join(tmpdir(),"tutor-support-lock-")));roots.push(root);
  const directory=join(root,"Tutor","private-support","a".repeat(32));await mkdir(directory,{recursive:true});
  const file=join(directory,"support-write.lock"),bytes=JSON.stringify({version:1,pid,nonce:randomUUID()});await writeFile(file,bytes);
  await writeFile(join(directory,"summaries.enc"),Buffer.from([212,143,111,67]));await writeFile(join(directory,"revocations.enc"),Buffer.from([43,18,205]));
  return {root,directory,file,bytes};
}
describe("private support lock recovery",()=>{
  it("diagnoses metadata only and explicitly quarantines an exact stopped owner's lock without reading private contents",async()=>{
    const f=await fixture(),before=await readFile(join(f.directory,"summaries.enc")),record=await readFile(join(f.directory,"revocations.enc"));
    const diagnostic=await diagnoseTutorLock(f.file);expect(diagnostic).toMatchObject({kind:"private-support",ownerPid:2147483647,ownerState:"absent",recoverable:true});expect(Object.keys(diagnostic).sort()).toEqual(["action","file","fingerprint","kind","ownerPid","ownerState","recoverable","valid"]);
    await expect(recoverTutorLock(f.file,{expected:diagnostic.fingerprint})).rejects.toThrow("confirm-stopped");
    const recovered=await recoverTutorLock(f.file,{expected:diagnostic.fingerprint,confirmStopped:true});expect(recovered.kind).toBe("private-support");expect(await readFile(recovered.quarantine,"utf8")).toBe(f.bytes);
    expect(await readFile(join(f.directory,"summaries.enc"))).toEqual(before);expect(await readFile(join(f.directory,"revocations.enc"))).toEqual(record);
    expect((await readdir(f.directory)).sort()).toEqual(["revocations.enc",recovered.quarantine.split("/").at(-1),"summaries.enc"].sort());
  });
  it("does not remove a live owner's lock",async()=>{
    const f=await fixture(process.pid),d=await diagnoseTutorLock(f.file);expect(d.recoverable).toBe(false);await expect(recoverTutorLock(f.file,{expected:d.fingerprint,confirmStopped:true})).rejects.toThrow("live or unknown");expect(await readFile(f.file,"utf8")).toBe(f.bytes);
  });
  it("refuses a lock replaced after diagnosis",async()=>{
    const f=await fixture(),d=await diagnoseTutorLock(f.file),replacement=JSON.stringify({version:1,pid:2147483647,nonce:randomUUID()});await writeFile(f.file,replacement);
    await expect(recoverTutorLock(f.file,{expected:d.fingerprint,confirmStopped:true})).rejects.toThrow("changed since diagnosis");expect(await readFile(f.file,"utf8")).toBe(replacement);
  });
  it.each(["foreign-path","invalid-owner","symlink"])("refuses %s without changing evidence",async mode=>{
    const f=await fixture();let file=f.file;
    if(mode==="foreign-path"){file=join(f.root,"support-write.lock");await writeFile(file,f.bytes);await expect(diagnoseTutorLock(file)).rejects.toThrow("exact Tutor");}
    if(mode==="invalid-owner"){await writeFile(file,'{"version":1,"pid":2147483647}');const d=await diagnoseTutorLock(file);expect(d).toMatchObject({valid:false,ownerState:"unknown",recoverable:false});await expect(recoverTutorLock(file,{expected:d.fingerprint,confirmStopped:true})).rejects.toThrow("live or unknown");}
    if(mode==="symlink"){const outside=join(f.root,"outside.lock");await writeFile(outside,f.bytes);await rm(file);await symlink(outside,file);await expect(diagnoseTutorLock(file)).rejects.toThrow();}
    expect((await readFile(join(f.directory,"summaries.enc"))).length).toBe(4);
  });
});
