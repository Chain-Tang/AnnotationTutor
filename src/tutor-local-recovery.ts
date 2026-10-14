import { z } from "zod";
import type { SurfaceTransactionJournal, SurfaceTransactionRecord } from "./surface-transaction-journal.js";
import { surfaceReceiptSchema } from "./surface-transaction-journal.js";
import type { TutorTask, TutorTaskCoordinator } from "./tutor-task.js";

/** A ChatLog task ID is only a hint. Authority comes from the fixed-vault journal. */
export function localDrawingTaskProjection(record:SurfaceTransactionRecord):TutorTask {
  const receipt=surfaceReceiptSchema.parse(record.receipt);
  if(receipt.clientId!=="obsidian"||!z.uuid().safeParse(receipt.requestId).success)throw new Error("local-drawing-recovery-identity-mismatch");
  if(["applying","saving","unknown"].includes(record.phase))receipt.durability="outcome-unknown";
  const state=receipt.durability==="committed"?"completed":receipt.durability==="not-applied"?"failed":"input-required";
  const phase=receipt.durability==="committed"?"completed":receipt.durability==="not-applied"?"not-applied":receipt.durability==="applied-not-durable"?"applied-not-saved":"commit-outcome-unknown";
  return {id:receipt.requestId,clientId:"obsidian",lead:"tutor",agent:"tutor",state,phase,createdAt:record.createdAt,updatedAt:record.updatedAt,
    target:{id:receipt.targetId,source:"",revision:receipt.baseRevision,surface:record.surface},
    artifacts:[{id:receipt.transactionId,type:"changes",data:{receipt}}],children:[],commit:receipt,metrics:{modelCalls:0,toolCalls:0}};
}

function isRunning(tasks:TutorTaskCoordinator,id:string):boolean {
  try{return ["queued","working"].includes(tasks.get(id,"obsidian").state);}catch{return false;}
}

/** Resolve one action directly from durable metadata, even when the task cache is full. */
export async function readLocalDrawingTask(journal:SurfaceTransactionJournal,tasks:TutorTaskCoordinator,taskId:string):Promise<TutorTask|undefined>{
  z.uuid().parse(taskId);
  const records=(await journal.recordsForClient("obsidian")).filter(record=>record.receipt.requestId===taskId);
  if(isRunning(tasks,taskId))throw new Error("local-drawing-task-still-running");
  if(records.length>1)throw new Error("local-drawing-recovery-ambiguous-task");
  return records[0]?localDrawingTaskProjection(records[0]):undefined;
}

/** Restores metadata only. Never reads model output, recompiles a drawing, or saves a surface. */
export async function restoreLocalDrawingTasks(journal:SurfaceTransactionJournal,tasks:TutorTaskCoordinator,taskIds:readonly string[]):Promise<TutorTask[]> {
  const requested=new Set(z.array(z.uuid()).max(50).parse(taskIds));
  if(!requested.size)return [];
  const records=(await journal.recordsForClient("obsidian")).filter(record=>requested.has(record.receipt.requestId));
  if(new Set(records.map(record=>record.receipt.requestId)).size!==records.length)throw new Error("local-drawing-recovery-ambiguous-task");
  const restored=records.map(localDrawingTaskProjection).filter(task=>!isRunning(tasks,task.id));
  tasks.restore(restored);
  for(const task of restored)tasks.recordSurfaceCommit(task.commit!,true);
  return restored.map(task=>{try{return tasks.get(task.id,"obsidian");}catch{return task;}});
}

/** Available even when chat-history retention is disabled or its file is missing. */
export async function listPendingLocalDrawingTasks(journal:SurfaceTransactionJournal,tasks:TutorTaskCoordinator,offset=0):Promise<{tasks:TutorTask[];total:number;nextOffset:number|null}> {
  if(!Number.isInteger(offset)||offset<0)throw new Error("local-drawing-recovery-offset-invalid");
  const records=(await journal.recordsForClient("obsidian")).filter(record=>record.phase!=="committed"&&record.phase!=="not-applied").sort((a,b)=>b.updatedAt-a.updatedAt);
  const page=records.slice(offset,offset+50);
  // Listing never fills the bounded live-task cache with unresolved placeholders.
  // An action re-reads its one receipt using readLocalDrawingTask before saving.
  return {tasks:page.filter(record=>!isRunning(tasks,record.receipt.requestId)).map(localDrawingTaskProjection),total:records.length,nextOffset:offset+page.length<records.length?offset+page.length:null};
}
