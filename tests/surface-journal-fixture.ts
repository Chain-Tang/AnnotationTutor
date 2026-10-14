import { SurfaceTransactionJournal, type SurfaceJournalIO } from "../src/surface-transaction-journal.js";
export function surfaceJournalFixture(now:()=>number=Date.now){
  const files=new Map<string,string>();
  const io:SurfaceJournalIO={read:async path=>files.get(path)??null,compareWrite:async(path,previous,next)=>{if((files.get(path)??null)!==previous)throw new Error("conflict");files.set(path,next);}};
  return {files,io,journal:new SurfaceTransactionJournal(io,"surface.json",now),reload:()=>new SurfaceTransactionJournal(io,"surface.json",now)};
}
export const memorySurfaceJournal=()=>surfaceJournalFixture().journal;
