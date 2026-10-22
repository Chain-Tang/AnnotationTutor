import type { BoardSnapshot, BoardVectorAsset } from "./board-types.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { TargetCommitQueue, type ContextGrant, type TaskTarget } from "./tutor-task.js";
import type { SurfaceTransactionJournal } from "./surface-transaction-journal.js";

export type SurfaceScene = { target: TaskTarget; selection: string[]; objects: unknown[]; vectorAssets?:BoardVectorAsset[] };
export type ChangeSet<T = unknown> = {
  id: string; taskId: string; targetId: string; baseRevision: string;
  operations: T[]; dependencies: string[];
};
export type SurfaceCommitReceipt = {
  version: 1;
  transactionId: string;
  requestId: string;
  clientId: string;
  targetId: string;
  baseRevision: string;
  appliedRevision: string;
  committedRevision?: string;
  createdIds: string[];
  updatedIds: string[];
  deletedIds: string[];
  objectRevisions: Record<string, string>;
  resources?: { kind: "vector" | "ink" | "character"; id: string; version?: number; digest: string }[];
  operationDigest: string;
  durability: "not-applied" | "applied-not-durable" | "committed" | "outcome-unknown";
};
/** A commit returns bounded metadata. Read the surface again for its current objects. */
export type SurfaceCommitResult = SurfaceScene & { receipt: SurfaceCommitReceipt };
export class SurfaceCommitError extends Error {
  constructor(message: string, public readonly result: SurfaceCommitResult) {
    super(`${message}: ${result.receipt.durability}`);
    this.name = "SurfaceCommitError";
  }
}
export function surfaceSignature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
/** Persisted receipts contain SHA-256 digests, never original operations or object contents. */
export function surfaceDigest(value: unknown): string {
  return createHash("sha256").update(surfaceSignature(value)).digest("hex");
}
type SurfaceObject = { id: string; isDeleted?: boolean };
/** Called on the isolated compilation and synchronous application, never a post-save scene diff. */
export function surfaceCommitResult(changes: ChangeSet, grant: ContextGrant, target: TaskTarget,
  before: readonly SurfaceObject[], applied: readonly SurfaceObject[]): SurfaceCommitResult {
  const prior = new Map(before.map(object => [object.id, object]));
  const next = new Map(applied.map(object => [object.id, object]));
  if (prior.size !== before.length || next.size !== applied.length) throw new Error("duplicate-surface-object-id");
  const createdIds: string[] = [], updatedIds: string[] = [], deletedIds: string[] = [];
  const objectRevisions: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const object of applied) {
    const previous = prior.get(object.id);
    if (!previous && !object.isDeleted) createdIds.push(object.id);
    else if (previous && !previous.isDeleted && object.isDeleted) deletedIds.push(object.id);
    else if (previous && surfaceSignature(previous) !== surfaceSignature(object)) updatedIds.push(object.id);
    else continue;
    objectRevisions[object.id] = surfaceDigest(object);
  }
  for (const object of before) if (!object.isDeleted && !next.has(object.id)) deletedIds.push(object.id);
  return { target: structuredClone(target), selection: [], objects: [], receipt: {
    version: 1, transactionId: changes.id, requestId: changes.taskId, clientId: grant.clientId,
    targetId: changes.targetId, baseRevision: changes.baseRevision, appliedRevision: target.revision,
    createdIds, updatedIds, deletedIds, objectRevisions, operationDigest: surfaceDigest(changes), durability: "applied-not-durable",
  } };
}
/** Later user additions are immaterial; only this transaction's fixed differences are checked. */
export function surfaceDeltaMatches(receipt: SurfaceCommitReceipt, objects: readonly SurfaceObject[]): boolean {
  const current = new Map(objects.map(object => [object.id, object]));
  if (current.size !== objects.length) return false;
  return [...receipt.createdIds, ...receipt.updatedIds].every(id => {
    const object = current.get(id); return object && !object.isDeleted && surfaceDigest(object) === receipt.objectRevisions[id];
  }) && receipt.deletedIds.every(id => !current.has(id) || current.get(id)!.isDeleted === true);
}
export function requireDurableSurfaceCommit(result: SurfaceCommitResult): SurfaceCommitResult {
  if (result.receipt.durability !== "committed") throw new SurfaceCommitError("surface-commit-requires-reconciliation", structuredClone(result));
  return structuredClone(result);
}
export interface SurfaceAdapter<T = unknown> {
  readonly id: string;
  capabilities(): { available: boolean; operations: string[]; reason?: string; version?: string; writeAvailable?: boolean; writeReason?: string };
  read(): Promise<SurfaceScene>;
  capture?(): Promise<BoardSnapshot>;
  preview(changes?: ChangeSet<T>): Promise<string>;
  commit(changes: ChangeSet<T>, grant: ContextGrant, signal: AbortSignal): Promise<SurfaceCommitResult>;
  useTransactions?(journal: SurfaceTransactionJournal): void;
  recoverCommit?(transactionId: string, grant: ContextGrant, signal: AbortSignal, action: "inspect" | "retry-save"): Promise<SurfaceCommitResult>;
}
export const surfaceCommitQueue = new TargetCommitQueue();
export function assertSurfaceGrant(id: string, grant: ContextGrant, write = false): void {
  if (!grant.targets.includes(id) || !grant.read || (write && !grant.write)) throw new Error("surface-access-denied");
}
export const boundedId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
export const coord = z.number().finite().min(-1_000_000).max(1_000_000);
