import type { LearningIO } from "./learning-record-read.js";

type RevisionedRecord = { revision: number; status: string };

/** A losing primary writer must not roll back another writer's recovery copy.
 * Preserve unknown/invalid backups for explicit recovery, and compare bytes at
 * the backup write boundary just as we do for the primary. */
export async function saveLearningBackup<T extends RevisionedRecord>(
  io:LearningIO,path:string,raw:string,record:T,validate:(raw:string)=>T,
):Promise<{raw:string;record:T}> {
  const backupPath=path+".previous",previous=await io.read(backupPath);
  if(previous!==null){
    const stored=validate(previous);
    if(stored.status==="deleted"&&record.status!=="deleted")throw new Error("learning-backup-deleted");
    if(stored.revision>record.revision)return {raw:previous,record:stored};
    if(stored.revision===record.revision){
      if(JSON.stringify(stored)!==JSON.stringify(record))throw new Error("learning-backup-revision-conflict");
      return {raw:previous,record:stored};
    }
  }
  if(record.status!=="deleted"&&await io.read(path+".deleted")!==null)throw new Error("learning-backup-deleted");
  await io.compareWrite(backupPath,previous,raw);
  return {raw,record};
}
