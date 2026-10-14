import { chmod, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SupportCipher } from "./support-private-store.js";
import { privateEncryptionAvailable } from "./desktop-private-storage.js";
import { isCredentialReference, type CredentialReference, type CredentialSlot } from "./credential-types.js";

export interface CredentialStore {
  available(): boolean;
  put(slot: CredentialSlot, binding: string, value: string): Promise<CredentialReference>;
  get(reference: CredentialReference): Promise<string>;
}
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
async function noSymlinks(file:string):Promise<void> {
  let current=resolve(file);
  for(;;) {
    try {if((await lstat(current)).isSymbolicLink())throw new Error("credential-symbolic-link");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
}
async function readRegular(file:string,maximum:number):Promise<Buffer> {
  await noSymlinks(file);
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await handle.stat();if(!stat.isFile()||stat.size>maximum)throw new Error("credential-file-invalid");return await handle.readFile();}
  finally {await handle.close();}
}
async function writeDurable(file:string,bytes:string|Buffer):Promise<void> {
  const handle=await open(file,"wx",0o600);
  try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function syncDirectory(directory:string):Promise<void> {
  const handle=await open(directory,"r");try{await handle.sync();}finally{await handle.close();}
}
/** Immutable encrypted records live separately from support summaries. Keeping
 * old records makes old references usable after managed rollback/re-upgrade. */
export class PrivateCredentialStore implements CredentialStore {
  private readonly directory?:string;
  private readonly vaultId:string;
  constructor(appData:string|undefined,vaultPath:string,private readonly cipher:SupportCipher|undefined) {
    this.vaultId=digest(resolve(vaultPath));
    if (appData) {
      const directory=join(resolve(appData),"Tutor","private-credentials",this.vaultId.slice(0,32));
      const fromVault=relative(resolve(vaultPath),directory);
      if (fromVault && (fromVault.startsWith(`..${process.platform==="win32"?"\\":"/"}`) || fromVault===".." || isAbsolute(fromVault))) this.directory=directory;
    }
  }
  available():boolean { return !!this.directory && privateEncryptionAvailable(this.cipher); }
  async put(slot:CredentialSlot,binding:string,value:string):Promise<CredentialReference> {
    const reference:CredentialReference={version:1,id:randomUUID(),slot,binding};
    if (!this.available() || !isCredentialReference(reference) || !value || Buffer.byteLength(value)>262144) throw new Error("credential-store-unavailable");
    const target=join(this.directory!,`${reference.id}.enc`),temporary=`${target}.${randomUUID()}.tmp`;
    try {
      await noSymlinks(this.directory!);
      await mkdir(this.directory!,{recursive:true,mode:0o700});await chmod(this.directory!,0o700);
      await noSymlinks(this.directory!);
      const bytes=this.cipher!.encryptString(JSON.stringify({...reference,vaultId:this.vaultId,value}));
      if (bytes.length>524288) throw new Error("credential-store-size");
      await writeDurable(temporary,bytes);await rename(temporary,target);await syncDirectory(this.directory!);
      if (await this.get(reference)!==value) throw new Error("credential-verification-failed");
      return reference;
    } catch { throw new Error("credential-store-unavailable"); }
    finally { await rm(temporary,{force:true}).catch(()=>{}); }
  }
  async get(reference:CredentialReference):Promise<string> {
    if (!this.available() || !isCredentialReference(reference)) throw new Error("credential-reference-unavailable");
    try {
      const bytes=await readRegular(join(this.directory!,`${reference.id}.enc`),524288);
      if(bytes.length>524288)throw new Error("credential-store-size");
      const record=JSON.parse(this.cipher!.decryptString(bytes));
      if(record.version!==1||record.id!==reference.id||record.slot!==reference.slot||record.binding!==reference.binding||record.vaultId!==this.vaultId||typeof record.value!=="string"||!record.value||Buffer.byteLength(record.value)>262144)throw new Error("credential-store-format");
      return record.value;
    } catch { throw new Error("credential-reference-unavailable"); }
  }
}

export interface CredentialSettingsWriter { write(settings:Record<string,unknown>):Promise<void>; }
/** Load and replace current data.json atomically. No plaintext migration backup
 * is created; failure before rename leaves the existing configuration intact. */
export class AtomicCredentialSettingsFile implements CredentialSettingsWriter {
  #expected:string|null|undefined;
  constructor(private readonly file:string) {}
  private async bytes():Promise<string|null> {
    try {return (await readRegular(this.file,16777216)).toString("utf8");}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("credential-settings-unavailable");}
  }
  async read():Promise<unknown> {
    this.#expected=await this.bytes();
    if(this.#expected===null)return null;
    try {const value:unknown=JSON.parse(this.#expected);if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();return value;}
    catch {throw new Error("credential-settings-invalid");}
  }
  async write(settings:Record<string,unknown>):Promise<void> {
    if(this.#expected===undefined)throw new Error("credential-settings-not-loaded");
    const next=JSON.stringify(settings,null,2),temporary=`${this.file}.credentials-${randomUUID()}.tmp`;
    const lock=`${this.file}.credentials-write.lock`;
    let lockHandle:Awaited<ReturnType<typeof open>>|undefined;
    try {
      await noSymlinks(this.file);await mkdir(dirname(this.file),{recursive:true});await noSymlinks(this.file);
      try {lockHandle=await open(lock,"wx",0o600);}
      catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("credential-settings-locked");throw error;}
      await lockHandle.writeFile(JSON.stringify({version:1,pid:process.pid,nonce:randomUUID()}));await lockHandle.sync();
      if(await this.bytes()!==this.#expected)throw new Error("credential-settings-changed");
      await writeDurable(temporary,next);
      if((await readRegular(temporary,16777216)).toString("utf8")!==next)throw new Error("credential-settings-verification-failed");
      if(await this.bytes()!==this.#expected)throw new Error("credential-settings-changed");
      await rename(temporary,this.file);this.#expected=next;
      await syncDirectory(dirname(this.file));
    } catch(error) {
      if(error instanceof Error && ["credential-settings-changed","credential-settings-locked"].includes(error.message))throw error;
      throw new Error("credential-settings-save-failed");
    } finally {
      await rm(temporary,{force:true}).catch(()=>{});
      if(lockHandle) {
        // FSKit/exFAT can assign a temporary inode immediately after creation.
        // Compare the live handle after the write, while it still owns the lock.
        try {const held=await lockHandle.stat(),current=await lstat(lock);if(!current.isSymbolicLink()&&current.ino===held.ino&&current.dev===held.dev)await unlink(lock);}
        catch{/* Never guess or remove another writer's lock. */}
        await lockHandle.close().catch(()=>{});
      }
    }
  }
}
