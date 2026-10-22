import { mkdir,rename,rm,chmod,open,lstat } from "node:fs/promises";
import { createHash,randomUUID } from "node:crypto";
import { join,dirname,resolve,relative,isAbsolute,sep } from "node:path";
import { z } from "zod";
import { supportSummarySchema,type SupportStorage,type SupportSummary } from "./support-session.js";
import { readPrivateFile, syncPrivateDirectory } from "./private-file-io.js";
export type SupportCipher={isEncryptionAvailable():boolean;encryptString(text:string):Buffer;decryptString(data:Buffer):string;getSelectedStorageBackend?():string};
const revocationsSchema=z.object({
  format:z.literal(1),ids:z.array(z.string().uuid()).max(4096),
  suspendedSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  suspendedIdentity:z.string().regex(/^\d{1,30}:\d{1,30}$/).optional(),
}).strict().refine(record=>new Set(record.ids).size===record.ids.length&&!!record.suspendedSha256===!!record.suspendedIdentity);
type Revocations=z.infer<typeof revocationsSchema>;
const queues=new Map<string,Promise<unknown>>();
const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
/** Application-private, never under the Vault or plugin install directory. No plaintext fallback. */
export class PrivateSupportStore implements SupportStorage {
  private readonly directory:string;
  private readonly outsideVault:boolean;
  private readable=true;
  private pendingAttestation:{sha256:string;identity:string;ids:string[]}|undefined;
  constructor(appData:string,vaultPath:string,private readonly cipher:SupportCipher|undefined){this.directory=join(resolve(appData),"Tutor","private-support",createHash("sha256").update(vaultPath).digest("hex").slice(0,32));const fromVault=relative(resolve(vaultPath),this.directory);this.outsideVault=!!fromVault&&(fromVault===".."||fromVault.startsWith(`..${sep}`)||isAbsolute(fromVault));}
  private encryptionAvailable(){try{return !!this.cipher?.isEncryptionAvailable() && this.cipher.getSelectedStorageBackend?.()!=="basic_text";}catch{return false;}}
  available(){return this.outsideVault&&this.readable&&this.encryptionAvailable();}
  private async checkParents(){if(!this.outsideVault)throw new Error("support-store-unavailable");for(let path=this.directory;;path=dirname(path)){
    try{const info=await lstat(path);if(info.isSymbolicLink()||!info.isDirectory())throw new Error("support-store-unavailable");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(dirname(path)===path)break;
  }}
  private async ensureDirectory(){await this.checkParents();await mkdir(this.directory,{recursive:true,mode:0o700});await this.checkParents();await chmod(this.directory,0o700);}
  private async syncDirectory(){await syncPrivateDirectory(this.directory);}
  private async write(name:string,bytes:string|Buffer,onReplace?:()=>Promise<void>){await this.ensureDirectory();const tmp=join(this.directory,`${name}.${randomUUID()}.tmp`);try{
    const file=await open(tmp,"wx",0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    await rename(tmp,join(this.directory,name));await onReplace?.();await this.syncDirectory();
  }finally{await rm(tmp,{force:true}).catch(()=>{});}}
  /** Serialize instances within a host; a different process or abandoned lock
   * is refused, never stolen by age. Recovery only removes the exact dead lock. */
  private operation<T>(run:()=>Promise<T>):Promise<T>{
    const task=(queues.get(this.directory)??Promise.resolve()).catch(()=>{}).then(async()=>{
      await this.ensureDirectory();const path=join(this.directory,"support-write.lock");let guard:Awaited<ReturnType<typeof open>>|undefined;
      try{guard=await open(path,"wx",0o600);await guard.writeFile(JSON.stringify({version:1,pid:process.pid,nonce:randomUUID()}));await guard.sync();return await run();}
      catch(error){throw new Error((error as NodeJS.ErrnoException).code==="EEXIST"?"support-store-locked":error instanceof Error&&error.message.startsWith("support-")?error.message:"support-store-unavailable");}
      finally{if(guard){const held=await guard.stat();await guard.close();const current=await lstat(path).catch(()=>undefined);if(current?.ino===held.ino&&current.dev===held.dev)await rm(path);}}
    });queues.set(this.directory,task);const done=()=>{if(queues.get(this.directory)===task)queues.delete(this.directory);};void task.then(done,done);return task;
  }
  private async bytes(name:string,max=131072):Promise<Buffer|null>{try{
    return await readPrivateFile(join(this.directory,name),max);
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}}
  private async revocations():Promise<Revocations>{const bytes=await this.bytes("revocations.enc",262144);return bytes?revocationsSchema.parse(JSON.parse(this.cipher!.decryptString(bytes))):{format:1,ids:[]};}
  private summaries(bytes:Buffer){const records=JSON.parse(this.cipher!.decryptString(bytes));if(!Array.isArray(records)||records.length>20)throw new Error("support-store-format");const parsed=records.map(x=>supportSummarySchema.parse(x));if(new Set(parsed.map(s=>s.id)).size!==parsed.length)throw new Error("support-store-format");return parsed;}
  private async suspendedIdentity(){const stat=await lstat(join(this.directory,"summaries.suspended.enc"),{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())throw new Error("support-store-unavailable");return `${stat.dev}:${stat.ino}`;}
  private async suspended(record:Revocations){const bytes=await this.bytes("summaries.suspended.enc");if(bytes&&(record.suspendedSha256!==hash(bytes)||record.suspendedIdentity!==await this.suspendedIdentity()))throw new Error("support-revocation-incomplete");return bytes;}
  private async ownedRecovery(record:Revocations){try{return await this.suspended(record);}catch(error){
    if(!(error instanceof Error)||error.message!=="support-revocation-incomplete"||!this.pendingAttestation)throw error;
    const bytes=await this.bytes("summaries.suspended.enc");if(!bytes||hash(bytes)!==this.pendingAttestation.sha256||await this.suspendedIdentity()!==this.pendingAttestation.identity)throw error;return bytes;
  }}
  private async suspend(primary:Buffer|null,recovery:Buffer|null,ids:string[]){const bytes=primary??recovery;if(!bytes)return;
    if(primary){await rename(join(this.directory,"summaries.enc"),join(this.directory,"summaries.suspended.enc"));
      this.pendingAttestation={sha256:hash(bytes),identity:await this.suspendedIdentity(),ids};await this.syncDirectory();
    }else{await this.write("summaries.suspended.enc",bytes,async()=>{this.pendingAttestation={sha256:hash(bytes),identity:await this.suspendedIdentity(),ids};});}
  }
  async load(){if(!this.available())return [];try{return await this.operation(async()=>{
    const record=await this.revocations(),recovery=await this.suspended(record),primary=await this.bytes("summaries.enc"),bytes=primary??recovery;
    if(!bytes)return [];const revoked=new Set(record.ids);return this.summaries(bytes).filter(s=>!revoked.has(s.id));
  });}catch{this.readable=false;throw new Error("support-store-unavailable");}}
  /** Remove the old reader's primary BEFORE writing the revocation attestation.
   * A crash between these steps leaves encrypted recovery bytes, but neither
   * this version nor a downgraded reader may silently restore them. */
  async revoke(ids:readonly string[]){if(!this.readable&&!this.pendingAttestation)throw new Error("support-store-unavailable");const checked=z.array(z.string().uuid()).max(4096).parse(ids);
    await this.operation(async()=>{const primary=await this.bytes("summaries.enc");
      const pendingIds=[...new Set([...(this.pendingAttestation?.ids??[]),...checked])];
      if(!this.encryptionAvailable()){
        await this.suspend(primary,primary?null:await this.bytes("summaries.suspended.enc"),pendingIds);
        throw new Error("support-encryption-unavailable");
      }
      const record=await this.revocations(),recovery=await this.ownedRecovery(record),bytes=primary??recovery;
      if(primary)this.summaries(primary);
      const revokedIds=z.array(z.string().uuid()).max(4096).parse([...new Set([...record.ids,...pendingIds])]);
      // A fresh filesystem identity invalidates even an older attestation of
      // identical ciphertext; failure cannot authorize a newer deletion intent.
      await this.suspend(primary,recovery,pendingIds);
      const next=revocationsSchema.parse({format:1,ids:revokedIds,...(bytes?{suspendedSha256:hash(bytes),suspendedIdentity:await this.suspendedIdentity()}:{})});
      await this.write("revocations.enc",this.cipher!.encryptString(JSON.stringify(next)));
      this.pendingAttestation=undefined;this.readable=true;
    });
  }
  async save(summaries:SupportSummary[]){if(!this.available())throw new Error("support-encryption-unavailable");const snapshot=summaries.map(s=>supportSummarySchema.parse(s));if(snapshot.length>20||new Set(snapshot.map(s=>s.id)).size!==snapshot.length)throw new Error("support-store-format");
    await this.operation(async()=>{if(this.pendingAttestation)throw new Error("support-revocation-incomplete");const record=await this.revocations();if(snapshot.some(s=>record.ids.includes(s.id)))throw new Error("support-summary-revoked");
      await this.suspended(record);
      await this.write("summaries.enc",this.cipher!.encryptString(JSON.stringify(snapshot)));
      // The primary receipt is already durable. A leftover encrypted recovery
      // file does not turn that receipt into failure or authorize its reuse.
      await rm(join(this.directory,"summaries.suspended.enc"),{force:true}).catch(()=>{});
    });
  }
  async readDay(){await this.checkParents();const bytes=await this.bytes("day.txt",32);if(!bytes)return "";const day=bytes.toString("utf8").trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("support-day-format");return day;}
  async writeDay(day:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("support-day-format");await this.write("day.txt",day);}
}
