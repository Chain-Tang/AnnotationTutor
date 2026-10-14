import { createHash } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
/** Discovery contains no credentials. Pairing secrets are stored only by the paired client. */
export async function publishTutorInstance(vault:string,name:string,port:number):Promise<string>{
  const id=createHash("sha256").update(vault).digest("hex").slice(0,24),folder=join(homedir(),".local","share","tutor","instances");
  await mkdir(folder,{recursive:true,mode:0o700});const path=join(folder,`${id}.json`);
  await writeFile(`${path}.tmp`,JSON.stringify({version:1,id,name,port,pid:process.pid,startedAt:new Date().toISOString()}),{mode:0o600});await rename(`${path}.tmp`,path);return path;
}
export async function removeTutorInstance(path:string):Promise<void>{await rm(path,{force:true});}
