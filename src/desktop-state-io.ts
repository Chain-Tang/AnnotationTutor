import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { readPrivateFile, syncPrivateDirectory } from "./private-file-io.js";

/** Fixed plugin-state files, independent of the user's learning directory.
 * A stale lock requires explicit reconciliation: time alone cannot authorize
 * stealing another process's transaction. Errors never contain stored data. */
export class DesktopStateIO {
  private readonly root:string;
  constructor(root:string,private readonly maxBytes=16*1024*1024){this.root=resolve(root);}
  private path(name:string):string {
    if(!name || isAbsolute(name))throw new Error("state-path-denied");
    const path=resolve(this.root,name),inside=relative(this.root,path);
    if(!inside||inside===".."||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error("state-path-denied");
    return path;
  }
  private async checkParents(path:string):Promise<void>{
    for(let current=dirname(path);;current=dirname(current)){
      try{const stat=await lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error("state-path-denied");}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      if(dirname(current)===current)break;
    }
  }
  private async bytes(path:string):Promise<string|null>{
    try{return (await readPrivateFile(path,this.maxBytes)).toString("utf8");}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("state-file-unavailable");}
  }
  async read(name:string):Promise<string|null>{const path=this.path(name);await this.checkParents(path);return this.bytes(path);}
  async compareWrite(name:string,previous:string|null,next:string):Promise<void>{
    if(Buffer.byteLength(next)>this.maxBytes)throw new Error("state-file-too-large");
    const path=this.path(name),lock=`${path}.lock`,temporary=`${path}.${randomUUID()}.tmp`;
    await this.checkParents(path);await mkdir(dirname(path),{recursive:true,mode:0o700});await this.checkParents(path);
    let guard:Awaited<ReturnType<typeof open>>|undefined;
    try{
      guard=await open(lock,"wx",0o600);
      await guard.writeFile(JSON.stringify({version:1,pid:process.pid,nonce:randomUUID()}));await guard.sync();
      if(await this.bytes(path)!==previous)throw new Error("state-file-conflict");
      const file=await open(temporary,"wx",0o600);
      try{await file.writeFile(next,"utf8");await file.sync();}finally{await file.close();}
      if(await this.bytes(path)!==previous)throw new Error("state-file-conflict");
      await rename(temporary,path);
      await syncPrivateDirectory(dirname(path));
    }catch(error){throw new Error((error as NodeJS.ErrnoException).code==="EEXIST"?"state-file-locked":error instanceof Error&&error.message.startsWith("state-")?error.message:"state-save-not-confirmed");}
    finally{
      await unlink(temporary).catch(()=>{});
      if(guard){const held=await guard.stat();await guard.close();const current=await lstat(lock).catch(()=>undefined);if(current?.ino===held.ino&&current?.dev===held.dev)await unlink(lock);}
    }
  }
}

/** One owner per file; validation precedes every write. No reset on corruption. */
export class DesktopStateRecord<T> {
  private raw:string|null|undefined;
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private io:DesktopStateIO,private path:string,private parse:(value:unknown)=>T,private initial:()=>T){}
  async load():Promise<T>{const raw=await this.io.read(this.path);try{const value=raw===null?this.parse(this.initial()):this.parse(JSON.parse(raw));this.raw=raw;return value;}catch{this.raw=undefined;throw new Error("state-record-invalid");}}
  save(value:T):Promise<void>{let next:string;try{next=JSON.stringify(this.parse(value));}catch{return Promise.reject(new Error("state-record-invalid"));}
    const task=this.tail.catch(()=>{}).then(async()=>{if(this.raw===undefined)throw new Error("state-record-not-loaded");await this.io.compareWrite(this.path,this.raw,next);this.raw=next;});this.tail=task;return task;}
  async flush():Promise<void>{await this.tail;}
}
