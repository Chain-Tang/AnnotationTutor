import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** Node does not expose a usable Windows directory fsync. File contents are still
 * synced before atomic replacement; POSIX directory-sync failures propagate. */
export async function syncPrivateDirectory(directory:string,platform:NodeJS.Platform=process.platform):Promise<void> {
  if(platform==="win32")return;
  const handle=await open(directory,"r");
  try{await handle.sync();}finally{await handle.close();}
}

/** O_NOFOLLOW is unavailable on Windows. Check the directory entry on both
 * sides of open and compare its identity with the actual handle before reading.
 * Parent-directory policy belongs to the store, which checks its own root. */
export async function readPrivateFile(file:string,maximum:number,platform:NodeJS.Platform=process.platform):Promise<Buffer> {
  const before=await lstat(file,{bigint:true});
  if(before.isSymbolicLink()||!before.isFile()||before.size>BigInt(maximum))throw new Error("private-file-invalid");
  const handle=await open(file,constants.O_RDONLY|(platform==="win32"?0:constants.O_NOFOLLOW));
  try{
    const held=await handle.stat({bigint:true}),current=await lstat(file,{bigint:true});
    if(!held.isFile()||held.size>BigInt(maximum)||current.isSymbolicLink()||!current.isFile()||
      held.dev!==before.dev||held.ino!==before.ino||held.dev!==current.dev||held.ino!==current.ino)throw new Error("private-file-invalid");
    const bytes=await handle.readFile();
    if(bytes.length>maximum)throw new Error("private-file-too-large");
    return bytes;
  }finally{await handle.close();}
}
