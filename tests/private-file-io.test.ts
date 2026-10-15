import { afterEach, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateFile, syncPrivateDirectory } from "../src/private-file-io.js";
import { DesktopStateIO } from "../src/desktop-state-io.js";
import { AtomicCredentialSettingsFile, PrivateCredentialStore } from "../src/credential-store.js";
import { PrivateSupportStore } from "../src/support-private-store.js";

const probe=vi.hoisted(()=>({action:"",file:"",flags:[] as (string|number|undefined)[],synced:0,closed:0,read:0}));
vi.mock("node:fs/promises",async importOriginal=>{
  const fs=await importOriginal<typeof import("node:fs/promises")>();
  return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{
    const file=String(args[0]),flags=args[1];probe.flags.push(flags);
    if(flags==="r"&&probe.action==="directory-open-failure")throw Error("directory-open-fault");
    if(file===probe.file&&typeof flags==="number"&&probe.action==="replace-before-open"){
      await fs.rename(file,`${file}.original`);await fs.writeFile(file,"different file");
    }
    const handle=await fs.open(...args),sync=handle.sync.bind(handle),close=handle.close.bind(handle),read=handle.readFile.bind(handle);
    handle.sync=async()=>{probe.synced++;if(flags==="r"&&probe.action==="directory-sync-failure")throw Error("directory-sync-fault");return sync();};
    handle.close=async()=>{probe.closed++;return close();};
    handle.readFile=(async(...values:Parameters<typeof handle.readFile>)=>{probe.read++;if(file===probe.file&&probe.action==="grow-during-read")return Buffer.alloc(33);return read(...values);}) as typeof handle.readFile;
    if(file===probe.file&&typeof flags==="number"&&probe.action==="replace-after-open"){
      await fs.rename(file,`${file}.original`);await fs.writeFile(file,"different file");
    }
    return handle;
  }};
});

const roots:string[]=[];
afterEach(async()=>{Object.assign(probe,{action:"",file:"",flags:[],synced:0,closed:0,read:0});await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),"tutor-private-io-")));roots.push(root);return root;}

it("explicitly avoids unsupported directory opens on Windows",async()=>{
  probe.action="directory-open-failure";
  await syncPrivateDirectory("directory","win32");
  expect(probe.flags).toEqual([]);expect(probe.synced).toBe(0);
});
it.skipIf(process.platform==="win32")("retains the POSIX directory durability barrier",async()=>{
  await syncPrivateDirectory(await fixture(),process.platform);
  expect(probe.flags).toEqual(["r"]);expect(probe.synced).toBe(1);expect(probe.closed).toBe(1);
});
it("does not swallow a POSIX directory-open failure",async()=>{
  probe.action="directory-open-failure";
  await expect(syncPrivateDirectory("directory","linux")).rejects.toThrow("directory-open-fault");
});
it.skipIf(process.platform==="win32")("propagates POSIX directory-sync failure and closes the handle",async()=>{
  probe.action="directory-sync-failure";
  await expect(syncPrivateDirectory(await fixture(),process.platform)).rejects.toThrow("directory-sync-fault");
  expect(probe.closed).toBe(1);
});
it.each(["win32","linux"] as const)("checks a real regular file through a bounded handle on %s",async platform=>{
  const file=join(await fixture(),"value.enc");await writeFile(file,"private fixture");
  expect((await readPrivateFile(file,32,platform)).toString()).toBe("private fixture");
  expect(probe.flags).toEqual([constants.O_RDONLY|(platform==="win32"?0:constants.O_NOFOLLOW)]);
  expect(probe.closed).toBe(1);
});
it("rejects nonfiles and oversized entries before opening",async()=>{
  const root=await fixture(),file=join(root,"value.enc");await writeFile(file,"too large");
  await expect(readPrivateFile(root,32,"win32")).rejects.toThrow("private-file-invalid");
  await expect(readPrivateFile(file,2,"win32")).rejects.toThrow("private-file-invalid");
  expect(probe.flags).toEqual([]);
});
it("rejects an actual file symlink before opening even without O_NOFOLLOW",async()=>{
  const root=await fixture(),target=join(root,"target.enc"),link=join(root,"link.enc");await writeFile(target,"original");await symlink(target,link);
  await expect(readPrivateFile(link,32,"win32")).rejects.toThrow("private-file-invalid");
  expect(probe.flags).toEqual([]);expect(await readFile(target,"utf8")).toBe("original");
});
it.each(["replace-before-open","replace-after-open"])("rejects %s before reading an untrusted replacement without O_NOFOLLOW",async action=>{
  const file=join(await fixture(),"value.enc");await writeFile(file,"original");Object.assign(probe,{file,action});
  await expect(readPrivateFile(file,32,"win32")).rejects.toThrow("private-file-invalid");
  expect(probe.read).toBe(0);expect(probe.closed).toBe(1);expect(await readFile(file,"utf8")).toBe("different file");
});
it("enforces the byte limit again if a file grows during reading",async()=>{
  const file=join(await fixture(),"value.enc");await writeFile(file,"original");Object.assign(probe,{file,action:"grow-during-read"});
  await expect(readPrivateFile(file,32,"win32")).rejects.toThrow("private-file-too-large");expect(probe.closed).toBe(1);
});
it.skipIf(process.platform==="win32")("never reports a successful private-store write when POSIX directory sync fails",async()=>{
  const root=await fixture(),cipher={isEncryptionAvailable:()=>true,encryptString:(text:string)=>Buffer.from(text),decryptString:(bytes:Buffer)=>bytes.toString()};
  const state=new DesktopStateIO(join(root,"state"));
  const settings=new AtomicCredentialSettingsFile(join(root,"settings.json"));await settings.read();
  const credentials=new PrivateCredentialStore(join(root,"application-data"),join(root,"vault"),cipher);
  const support=new PrivateSupportStore(join(root,"application-data"),join(root,"vault"),cipher);
  probe.action="directory-sync-failure";
  await expect(state.compareWrite("state.json",null,"1")).rejects.toThrow("state-save-not-confirmed");
  await expect(settings.write({value:1})).rejects.toThrow("credential-settings-save-failed");
  await expect(credentials.put("apiKey","a".repeat(64),"fixture")).rejects.toThrow("credential-store-unavailable");
  await expect(support.save([])).rejects.toThrow("support-store-unavailable");
});
