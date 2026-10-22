import type { ContextGrant, TaskTarget } from "./tutor-task.js";
import { SurfaceCommitError, assertSurfaceGrant, requireDurableSurfaceCommit, surfaceDeltaMatches, surfaceDigest, type ChangeSet, type SurfaceCommitReceipt, type SurfaceCommitResult, type SurfaceScene } from "./tutor-surface.js";
import type { SurfaceTransactionJournal, SurfaceTransactionRecord, SurfaceTransactionRef } from "./surface-transaction-journal.js";

export type SurfaceTransactionRuntime<T> = {
  id: string;
  journal?: SurfaceTransactionJournal;
  capture(): SurfaceScene;
  target(receipt: SurfaceCommitReceipt): TaskTarget;
  resourcesMatch?(receipt: SurfaceCommitReceipt): boolean;
  compile(changes: ChangeSet<T>, grant: ContextGrant): { result: SurfaceCommitResult; before: { id: string }[]; apply(): SurfaceCommitResult | void; dependenciesValid?(): boolean };
  save(): Promise<void>;
};
function requiredJournal(runtime: SurfaceTransactionRuntime<unknown>): SurfaceTransactionJournal {
  if (!runtime.journal) throw new Error("surface-transaction-journal-unavailable");
  return runtime.journal;
}
function resultOf<T>(runtime: SurfaceTransactionRuntime<T>, record: SurfaceTransactionRecord): SurfaceCommitResult {
  const receipt = structuredClone(record.receipt);
  // An interrupted application or save has no durable confirmation; never infer success from its phase.
  if (["applying", "saving", "unknown"].includes(record.phase)) receipt.durability = "outcome-unknown";
  return { target: runtime.target(receipt), selection: [], objects: [], receipt };
}
const fail = (message: string, result: SurfaceCommitResult): never => { throw new SurfaceCommitError(message, structuredClone(result)); };
function matches<T>(runtime: SurfaceTransactionRuntime<T>, receipt: SurfaceCommitReceipt): boolean {
  try { return surfaceDeltaMatches(receipt, runtime.capture().objects as { id: string }[]) && (runtime.resourcesMatch?.(receipt) ?? true); } catch { return false; }
}
async function recordFailure<T>(runtime: SurfaceTransactionRuntime<T>, journal: SurfaceTransactionJournal, result: SurfaceCommitResult, phase: "applied" | "unknown" | "not-applied", message: string): Promise<never> {
  try {
    const record = await journal.transition(result.receipt, phase);
    return fail(message, resultOf(runtime, record));
  } catch (error) {
    if (error instanceof SurfaceCommitError) throw error;
    result.receipt.durability = "outcome-unknown"; delete result.receipt.committedRevision;
    return fail("surface-journal-write-not-confirmed-reconcile-before-retry", result);
  }
}
async function saveApplied<T>(runtime: SurfaceTransactionRuntime<T>, journal: SurfaceTransactionJournal, result: SurfaceCommitResult, signal: AbortSignal, dependenciesValid: () => boolean = () => true): Promise<SurfaceCommitResult> {
  if (!matches(runtime, result.receipt) || !dependenciesValid()) return recordFailure(runtime, journal, result, "unknown", "surface-difference-changed-before-save");
  if (signal.aborted) return recordFailure(runtime, journal, result, "applied", "task-cancelled-after-apply");
  try { await journal.transition(result.receipt, "saving"); } catch { result.receipt.durability = "outcome-unknown"; return fail("surface-journal-write-not-confirmed", result); }
  // Native edits are not held by the Tutor queue while the journal awaits IO.
  if (!matches(runtime, result.receipt) || !dependenciesValid()) return recordFailure(runtime, journal, result, "unknown", "surface-difference-changed-before-save");
  if (signal.aborted) return recordFailure(runtime, journal, result, "applied", "task-cancelled-before-save");
  try { await runtime.save(); } catch {
    return recordFailure(runtime, journal, result, matches(runtime, result.receipt) ? "applied" : "unknown", "surface-save-not-confirmed");
  }
  if (!matches(runtime, result.receipt) || !dependenciesValid()) return recordFailure(runtime, journal, result, "unknown", "surface-difference-changed-during-save");
  try { return resultOf(runtime, await journal.transition(result.receipt, "committed")); } catch {
    result.receipt.durability = "outcome-unknown"; delete result.receipt.committedRevision;
    return fail("surface-saved-but-journal-not-confirmed", result);
  }
}
/** Caller holds the canonical target queue. Only metadata is persisted before the synchronous apply. */
export async function commitSurfaceTransaction<T>(runtime: SurfaceTransactionRuntime<T>, changes: ChangeSet<T>, grant: ContextGrant, signal: AbortSignal): Promise<SurfaceCommitResult> {
  assertSurfaceGrant(runtime.id, grant, true);
  const journal = requiredJournal(runtime as SurfaceTransactionRuntime<unknown>), ref: SurfaceTransactionRef = { clientId: grant.clientId, targetId: changes.targetId, transactionId: changes.id };
  const previous = await journal.lookup(ref, surfaceDigest(changes));
  if (previous) return requireDurableSurfaceCommit(resultOf(runtime, previous));
  if (signal.aborted) throw new Error("task-cancelled");
  const snapshot = runtime.capture(), effective = await journal.authorizedGrant(grant, runtime.id, snapshot.objects as { id: string }[]);
  if (signal.aborted) throw new Error("task-cancelled");
  const compiled = runtime.compile(changes, effective), prepared = await journal.prepare(changes, grant, compiled.result.target.surface, compiled.result.receipt, compiled.before);
  if (!prepared.created) return requireDurableSurfaceCommit(resultOf(runtime, prepared.record));
  let result = resultOf(runtime, prepared.record);const dependenciesValid = compiled.dependenciesValid ?? (() => true);
  const applicable = () => { try { return runtime.capture().target.revision === changes.baseRevision && dependenciesValid(); } catch { return false; } };
  if (signal.aborted || !applicable()) return recordFailure(runtime, journal, result, "not-applied", signal.aborted ? "task-cancelled-before-apply" : "scene-revision-conflict");
  try { await journal.transition(ref, "applying"); } catch { result.receipt.durability = "outcome-unknown"; return fail("surface-application-not-started-journal-unconfirmed", result); }
  if (signal.aborted || !applicable()) return recordFailure(runtime, journal, result, "not-applied", signal.aborted ? "task-cancelled-before-apply" : "scene-revision-conflict");
  try { const applied=compiled.apply();if(applied)result=applied; } catch { return recordFailure(runtime, journal, result, "unknown", "surface-application-outcome-unknown"); }
  if (!matches(runtime, result.receipt) || !dependenciesValid()) return recordFailure(runtime, journal, result, "unknown", "surface-postapply-mismatch");
  result.receipt.durability="applied-not-durable";
  try{grant.onSurfaceCommit?.(structuredClone(result.receipt));}catch{/* Observers cannot affect a native application. */}
  try { await journal.transition(ref, "applied",result.receipt); } catch { result.receipt.durability = "outcome-unknown"; return fail("surface-applied-but-journal-not-confirmed", result); }
  result.receipt.durability = "applied-not-durable";
  try{
    const saved=await saveApplied(runtime, journal, result, signal, dependenciesValid);
    try{grant.onSurfaceCommit?.(structuredClone(saved.receipt));}catch{/* Outcome is already durable. */}
    return saved;
  }catch(error){
    if(error instanceof SurfaceCommitError)try{grant.onSurfaceCommit?.(structuredClone(error.result.receipt));}catch{/* Preserve the actual outcome. */}
    throw error;
  }
}
/** Explicit recovery never recompiles or reapplies drawing operations. */
export async function recoverSurfaceTransaction<T>(runtime: SurfaceTransactionRuntime<T>, transactionId: string, grant: ContextGrant, signal: AbortSignal, action: "inspect" | "retry-save"): Promise<SurfaceCommitResult> {
  assertSurfaceGrant(runtime.id, grant, action === "retry-save");
  const journal = requiredJournal(runtime as SurfaceTransactionRuntime<unknown>), ref = { clientId: grant.clientId, targetId: runtime.id, transactionId }, record = await journal.lookup(ref);
  if (!record) throw new Error("surface-transaction-not-found");
  let result = resultOf(runtime, record);
  if (record.phase === "committed" || record.phase === "not-applied") return action === "inspect" ? result : requireDurableSurfaceCommit(result);
  if (record.phase === "prepared") {
    result = resultOf(runtime, await journal.transition(ref, "not-applied"));
    return action === "inspect" ? result : requireDurableSurfaceCommit(result);
  }
  if (action === "retry-save") {
    if (record.phase !== "applied") return fail("surface-outcome-unknown-inspect-before-save", result);
    return saveApplied(runtime, journal, result, signal);
  }
  if (!matches(runtime, result.receipt)) {
    result = resultOf(runtime, await journal.transition(ref, "unknown"));
    return result;
  }
  // Matching exact IDs and SHA-256 revisions confirms the applied difference, not disk durability.
  return resultOf(runtime, await journal.transition(ref, "applied"));
}
