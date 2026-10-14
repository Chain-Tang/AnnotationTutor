import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AtomicCredentialSettingsFile, PrivateCredentialStore } from "../src/credential-store.js";
import { detectDesktopPrivateStorage, privateEncryptionAvailable } from "../src/desktop-private-storage.js";
import { CredentialSettingsSession } from "../src/credential-session.js";
import { migrateSettings } from "../src/settings-config.js";

const cipher={isEncryptionAvailable:()=>true,encryptString:(text:string)=>Buffer.from(Buffer.from(text).map(value=>value^173)),decryptString:(bytes:Buffer)=>Buffer.from(bytes.map(value=>value^173)).toString()};
const binding="a".repeat(64);
const temporary=async(prefix:string)=>realpath(await mkdtemp(join(tmpdir(),prefix)));
describe("private desktop credential storage",()=>{
  it("detects platform appData instead of assuming a macOS directory",()=>{
    const result=detectDesktopPrivateStorage(name=>{if(name==="@electron/remote")throw Error();return {app:{getPath:(name:string)=>name==="appData"?"/runtime/platform-private":""},safeStorage:cipher};});
    expect(result.appData).toBe("/runtime/platform-private");expect(result.available).toBe(true);
    expect(detectDesktopPrivateStorage(name=>name==="@electron/remote"?{app:{getPath:()=>"/split-runtime-private"}}:{safeStorage:cipher}).available).toBe(true);
    expect(detectDesktopPrivateStorage(name=>name==="@electron/remote"?{safeStorage:cipher}:{app:{getPath:()=>"/split-runtime-private"},safeStorage:{...cipher,isEncryptionAvailable:()=>false}}).available).toBe(true);
    expect(detectDesktopPrivateStorage(()=>{throw Error();})).toEqual({available:false});
    expect(privateEncryptionAvailable({...cipher,getSelectedStorageBackend:()=>"basic_text"})).toBe(false);
    expect(privateEncryptionAvailable({...cipher,isEncryptionAvailable:()=>{throw Error();}})).toBe(false);
  });
  it("writes only encrypted immutable records outside the vault and support directory",async()=>{
    const root=await temporary("tutor-credentials-");
    try {
      const store=new PrivateCredentialStore(root,"/synthetic-vault",cipher);
      const ref=await store.put("apiKey",binding,"PRIVATE-STORAGE-FIXTURE");
      expect(await store.get(ref)).toBe("PRIVATE-STORAGE-FIXTURE");
      const entries=await readdir(root,{recursive:true});const encrypted=entries.filter(name=>name.endsWith(".enc"));expect(encrypted).toHaveLength(1);
      expect(encrypted[0]).toContain("private-credentials");expect(encrypted[0]).not.toContain("private-support");
      expect((await readFile(join(root,encrypted[0]!))).includes(Buffer.from("PRIVATE-STORAGE-FIXTURE"))).toBe(false);
      await expect(store.get({...ref,slot:"tutorRemoteToken"})).rejects.toThrow("credential-reference-unavailable");
      await expect(new PrivateCredentialStore(root,"/another-vault",cipher).get(ref)).rejects.toThrow("credential-reference-unavailable");
      await expect(new PrivateCredentialStore(root,"/synthetic-vault",{...cipher,decryptString:()=>{throw Error("SECRET-ERROR");}}).get(ref)).rejects.toThrow(/^credential-reference-unavailable$/);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("never creates a plaintext fallback when unavailable or configured inside the vault",async()=>{
    const root=await temporary("tutor-credentials-off-");
    try {
      for(const store of [new PrivateCredentialStore(root,"/fixture-vault",undefined),new PrivateCredentialStore(root,root,cipher),new PrivateCredentialStore(root,"/fixture-vault",{...cipher,getSelectedStorageBackend:()=>"basic_text"})]) {
        expect(store.available()).toBe(false);await expect(store.put("apiKey",binding,"NO-PLAINTEXT-FIXTURE")).rejects.toThrow("credential-store-unavailable");
      }
      expect(await readdir(root)).toEqual([]);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("atomically replaces legacy plaintext settings with verified references and protects external edits",async()=>{
    const root=await temporary("tutor-settings-credentials-");
    try {
      const file=join(root,"data.json"),legacy={apiKey:"OLD-CONFIG-FIXTURE",apiModel:"kept"};await writeFile(file,JSON.stringify(legacy));
      const writer=new AtomicCredentialSettingsFile(file);expect(await writer.read()).toEqual(legacy);expect(JSON.stringify(writer)).not.toContain("OLD-CONFIG-FIXTURE");
      const ref={version:1,id:randomUUID(),slot:"apiKey",binding};
      await writer.write({apiModel:"kept",credentialRefs:[ref]});
      expect(await readFile(file,"utf8")).not.toContain("OLD-CONFIG-FIXTURE");expect(await readdir(root)).toEqual(["data.json"]);
      await writeFile(file,'{"apiModel":"external change"}');
      await expect(writer.write({apiModel:"stale"})).rejects.toThrow("credential-settings-changed");
      expect(await readFile(file,"utf8")).toBe('{"apiModel":"external change"}');
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("does not touch an unreadable or uninitialized settings file",async()=>{
    const root=await temporary("tutor-settings-invalid-");
    try {
      const file=join(root,"data.json");await writeFile(file,"{invalid");const writer=new AtomicCredentialSettingsFile(file);
      await expect(writer.read()).rejects.toThrow("credential-settings-invalid");expect(await readFile(file,"utf8")).toBe("{invalid");
      await expect(new AtomicCredentialSettingsFile(file).write({})).rejects.toThrow("credential-settings-not-loaded");
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("migrates a synthetic data.json and resolves its references on the next plugin session",async()=>{
    const root=await temporary("tutor-credential-integration-");
    try {
      const vault=join(root,"vault"),privateData=join(root,"application-private"),file=join(vault,"data.json");await mkdir(vault);
      await writeFile(file,JSON.stringify({apiBaseUrl:"https://api.fixture.test/v1",apiKey:"INTEGRATION-API-FIXTURE",boardImageApiKey:"INTEGRATION-IMAGE-FIXTURE",apiModel:"kept-model"}));
      const writer=new AtomicCredentialSettingsFile(file),settings=migrateSettings(await writer.read()),store=new PrivateCredentialStore(privateData,vault,cipher);
      const session=new CredentialSettingsSession(settings,store,writer);expect((await session.initialize()).state).toBe("ready");
      const saved=await readFile(file,"utf8");expect(saved).not.toContain("INTEGRATION-");expect(JSON.parse(saved).credentialRefs).toHaveLength(2);
      const nextWriter=new AtomicCredentialSettingsFile(file),nextSettings=migrateSettings(await nextWriter.read());
      const next=new CredentialSettingsSession(nextSettings,store,nextWriter);await next.initialize();
      expect(nextSettings.apiKey).toBe("INTEGRATION-API-FIXTURE");expect(nextSettings.boardImageApiKey).toBe("INTEGRATION-IMAGE-FIXTURE");expect(nextSettings.apiModel).toBe("kept-model");
      expect((await readdir(vault)).sort()).toEqual(["data.json"]);
      const unavailableWriter=new AtomicCredentialSettingsFile(file),unavailableSettings=migrateSettings(await unavailableWriter.read());
      const unavailable=new CredentialSettingsSession(unavailableSettings,new PrivateCredentialStore(privateData,vault,undefined),unavailableWriter);
      expect((await unavailable.initialize()).state).toBe("reference-unavailable");expect(unavailableSettings.apiKey).toBe("");
      expect(await readFile(file,"utf8")).toBe(saved);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("serializes two independent windows and never overwrites a competing committed revision",async()=>{
    const root=await temporary("tutor-credentials-cas-");
    try {
      const file=join(root,"data.json");await writeFile(file,'{"value":"original"}');
      const first=new AtomicCredentialSettingsFile(file),second=new AtomicCredentialSettingsFile(file);await Promise.all([first.read(),second.read()]);
      const outcomes=await Promise.allSettled([first.write({value:"first"}),second.write({value:"second"})]);
      expect(outcomes.filter(outcome=>outcome.status==="fulfilled")).toHaveLength(1);
      const failed=outcomes.find(outcome=>outcome.status==="rejected") as PromiseRejectedResult;
      expect(failed.reason.message).toMatch(/^credential-settings-(locked|changed)$/);
      expect(["first","second"]).toContain(JSON.parse(await readFile(file,"utf8")).value);
      expect(await readdir(root)).toEqual(["data.json"]);
      await writeFile(`${file}.credentials-write.lock`,'{"pid":0,"nonce":"existing-owner"}');
      const third=new AtomicCredentialSettingsFile(file);await third.read();
      await expect(third.write({value:"must-not-write"})).rejects.toThrow("credential-settings-locked");
      expect(await readFile(`${file}.credentials-write.lock`,"utf8")).toBe('{"pid":0,"nonce":"existing-owner"}');
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("refuses settings or private storage beneath a symbolic-link directory",async()=>{
    const root=await temporary("tutor-credentials-link-");
    try {
      const real=join(root,"real"),linked=join(root,"linked");await mkdir(real);await writeFile(join(real,"data.json"),'{}');
      await symlink(real,linked,process.platform==="win32"?"junction":"dir");
      await expect(new AtomicCredentialSettingsFile(join(linked,"data.json")).read()).rejects.toThrow("credential-settings-unavailable");
      const store=new PrivateCredentialStore(linked,"/fixture-vault",cipher);
      await expect(store.put("apiKey",binding,"LINK-FIXTURE")).rejects.toThrow("credential-store-unavailable");
      expect(await readdir(real)).toEqual(["data.json"]);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it.skipIf(process.platform==="win32")("refuses a symbolic-link settings file",async()=>{
    const root=await temporary("tutor-credentials-file-link-");
    try {
      const target=join(root,"target.json"),link=join(root,"data.json");await writeFile(target,'{"kept":true}');await symlink(target,link);
      await expect(new AtomicCredentialSettingsFile(link).read()).rejects.toThrow("credential-settings-unavailable");
      expect(await readFile(target,"utf8")).toBe('{"kept":true}');
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
