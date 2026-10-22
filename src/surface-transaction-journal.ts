import { z } from "zod";
import type { ContextGrant, TaskTarget } from "./tutor-task.js";
import { surfaceDigest, type ChangeSet, type SurfaceCommitReceipt } from "./tutor-surface.js";

export const SURFACE_TRANSACTION_POLICY = Object.freeze({
  version: 1, receiptRetentionMs: 30 * 24 * 60 * 60 * 1000, maxReceipts: 2048,
  maxOwnedObjects: 50_000, maxBytes: 16 * 1024 * 1024, barrierBits: 1 << 20,
  barrierHashes: 8, maxBarrierSetBits: 1 << 19,
});
export type SurfaceJournalIO = {
  read(path: string): Promise<string | null>;
  compareWrite(path: string, previous: string | null, next: string): Promise<void>;
};
/** The host persists this identity outside the journal/state directory (plugin settings).
 * Resolve persistJournalId only after that settings write is confirmed durable.
 * Existing nonempty/invalid identities must never be normalized back to null. */
export type SurfaceJournalIdentityBinding = {
  expectedJournalId: string | null;
  persistJournalId(journalId:string):Promise<void>;
};
const id = z.string().min(1).max(200), digest = z.string().regex(/^[a-f0-9]{64}$/), revision = z.string().max(200);
export const surfaceReceiptSchema = z.object({
  version: z.literal(1), transactionId: id, requestId: id, clientId: id, targetId: id,
  baseRevision: revision, appliedRevision: revision, committedRevision: revision.optional(),
  createdIds: z.array(id).max(10_000), updatedIds: z.array(id).max(10_000), deletedIds: z.array(id).max(10_000),
  objectRevisions: z.record(id, digest), operationDigest: digest,
  resources: z.array(z.object({kind:z.enum(["vector","ink","character"]),id,version:z.number().int().nonnegative().optional(),digest}).strict()).max(10_000).optional(),
  durability: z.enum(["not-applied", "applied-not-durable", "committed", "outcome-unknown"]),
}).strict();
const phases = ["prepared", "applying", "applied", "saving", "committed", "not-applied", "unknown"] as const;
export type SurfaceTransactionPhase = typeof phases[number];
const time = z.number().int().nonnegative();
const recordSchema = z.object({
  key: digest, receipt: surfaceReceiptSchema, surface: z.enum(["studio", "document", "excalidraw"]),
  phase: z.enum(phases), createdAt: time, updatedAt: time,
  beforeObjectRevisions: z.record(id, digest.nullable()), reservedBytes: z.number().int().nonnegative(),
}).strict();
export type SurfaceTransactionRecord = z.infer<typeof recordSchema>;
const ownerSchema = z.object({ clientId: id, targetId: id, transactionId: id, objectId: id, revision: digest }).strict();
type Owner = z.infer<typeof ownerSchema>;
const manifestSchema = z.object({
  format: z.literal("tutor-surface-transactions-v1"), journalId:z.uuid(), revision: z.number().int().nonnegative(),
  createdAt: time, updatedAt: time, barrier: z.string().length(SURFACE_TRANSACTION_POLICY.barrierBits / 4).regex(/^[0-9a-f]+$/),
  barrierSetBits: z.number().int().nonnegative().max(SURFACE_TRANSACTION_POLICY.barrierBits),
  records: z.array(recordSchema).max(SURFACE_TRANSACTION_POLICY.maxReceipts),
  owners: z.array(ownerSchema).max(SURFACE_TRANSACTION_POLICY.maxOwnedObjects),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const markerSchema=z.object({format:z.literal("tutor-surface-transactions-initialized-v1"),journalId:z.uuid(),createdAt:time}).strict();
export type SurfaceTransactionRef = { clientId: string; targetId: string; transactionId: string };
const keyOf = (ref: SurfaceTransactionRef) => surfaceDigest([ref.clientId, ref.targetId, ref.transactionId]);
const ownerKey = (owner: Pick<Owner, "clientId" | "targetId" | "objectId">) => surfaceDigest([owner.clientId, owner.targetId, owner.objectId]);
const terminal = (phase: SurfaceTransactionPhase) => phase === "committed" || phase === "not-applied";
function positions(key: string): number[] { return Array.from({ length: 8 }, (_, i) => parseInt(key.slice(i * 8, i * 8 + 8), 16) % SURFACE_TRANSACTION_POLICY.barrierBits); }
function hasBarrier(manifest: Manifest, key: string): boolean {
  return positions(key).every(bit => (parseInt(manifest.barrier[Math.floor(bit / 4)]!, 16) & (1 << (bit % 4))) !== 0);
}
function addBarrier(manifest: Manifest, key: string): void {
  const text = manifest.barrier.split("");
  for (const bit of positions(key)) {
    const index = Math.floor(bit / 4), old = parseInt(text[index]!, 16), next = old | (1 << (bit % 4));
    if (next !== old) manifest.barrierSetBits++;
    text[index] = next.toString(16);
  }
  if (manifest.barrierSetBits > SURFACE_TRANSACTION_POLICY.maxBarrierSetBits) throw new Error("surface-replay-barrier-saturated-retain-journal");
  manifest.barrier = text.join("");
}
/** Fixed-vault metadata only. CAS and atomic rename belong to the host IO boundary.
 * The permanent filter is never cleared or rotated: false positives fail closed. */
export class SurfaceTransactionJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private ready = false;
  private lastReason = "surface-journal-not-initialized";
  private lastWriteFailed = false;
  private lastRevision = -1;
  private boundJournalId:string|null|undefined;
  private readonly listeners = new Set<(record: SurfaceTransactionRecord) => void>();
  constructor(private readonly io: SurfaceJournalIO, private readonly path: string, private readonly now: () => number = Date.now,private readonly binding?:SurfaceJournalIdentityBinding) {this.boundJournalId=binding?.expectedJournalId;}
  status(): { available: boolean; reason?: string } { return { available: this.ready && !this.closed, ...(!this.ready || this.closed ? { reason: this.closed ? "surface-journal-closed" : this.lastReason } : {}) }; }
  subscribe(listener: (record: SurfaceTransactionRecord) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(record: SurfaceTransactionRecord): void { for (const listener of this.listeners) { try { listener(structuredClone(record)); } catch { /* Observers cannot affect persistence. */ } } }
  private empty(): Manifest { const now = this.now(); return { format: "tutor-surface-transactions-v1", journalId:crypto.randomUUID(), revision: 0, createdAt: now, updatedAt: now, barrier: "0".repeat(SURFACE_TRANSACTION_POLICY.barrierBits / 4), barrierSetBits: 0, records: [], owners: [] }; }
  private parse(raw: string): Manifest {
    if (Buffer.byteLength(raw, "utf8") > SURFACE_TRANSACTION_POLICY.maxBytes) throw new Error("surface-journal-too-large");
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error("surface-journal-corrupt"); }
    if ((parsed as { format?: unknown })?.format !== "tutor-surface-transactions-v1") throw new Error("surface-journal-format-unsupported");
    const checked = manifestSchema.safeParse(parsed); if (!checked.success) throw new Error("surface-journal-corrupt");
    const manifest = checked.data;
    if (manifest.revision < this.lastRevision) throw new Error("surface-journal-revision-regressed");
    if (new Set(manifest.records.map(record => record.key)).size !== manifest.records.length || new Set(manifest.owners.map(ownerKey)).size !== manifest.owners.length) throw new Error("surface-journal-duplicate-identity");
    const bitCounts=[0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];
    let setBits=0;for(let i=0;i<manifest.barrier.length;i++)setBits+=bitCounts[parseInt(manifest.barrier[i]!,16)]!;
    if(setBits!==manifest.barrierSetBits)throw new Error("surface-journal-barrier-corrupt");
    for (const record of manifest.records) {
      const ids = [...record.receipt.createdIds, ...record.receipt.updatedIds, ...record.receipt.deletedIds];
      if (record.key !== keyOf(record.receipt) || !hasBarrier(manifest, record.key) || new Set(ids).size !== ids.length) throw new Error("surface-journal-identity-mismatch");
      if ([...record.receipt.createdIds, ...record.receipt.updatedIds].some(id => !record.receipt.objectRevisions[id])) throw new Error("surface-journal-missing-object-revision");
      const expected=record.phase==="prepared"||record.phase==="not-applied"?"not-applied":record.phase==="applied"?"applied-not-durable":record.phase==="committed"?"committed":"outcome-unknown";
      if(record.receipt.durability!==expected||(record.phase==="committed"?record.receipt.committedRevision!==record.receipt.appliedRevision:record.receipt.committedRevision!==undefined))throw new Error("surface-journal-phase-mismatch");
    }
    if(manifest.owners.some(owner=>!hasBarrier(manifest,keyOf(owner))))throw new Error("surface-journal-ownership-provenance-missing");
    return manifest;
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(async () => {
      if (this.closed) throw new Error("surface-journal-closed");
      try { return await run(); } catch (error) {
        this.ready = false; this.lastReason = error instanceof Error && (error.message.startsWith("surface-") || error.message === "changeset-id-reused") ? error.message : "surface-journal-io-unavailable";
        throw new Error(this.lastReason);
      }
    });
    this.tail = next; return next;
  }
  private async load(): Promise<{ raw: string | null; manifest: Manifest }> {
    if(this.binding&&this.boundJournalId!==null&&!z.uuid().safeParse(this.boundJournalId).success)throw new Error("surface-journal-settings-identity-invalid");
    let raw = await this.io.read(this.path);
    const markerRaw=await this.io.read(`${this.path}.initialized`);
    let manifest:Manifest;
    if(raw===null&&markerRaw===null){
      if(this.binding&&this.boundJournalId!==null)throw new Error("surface-journal-bound-state-missing-requires-restoration");
      if(this.lastRevision>=0)throw new Error("surface-journal-missing-after-initialization");
      manifest=this.empty();raw=await this.write(null,manifest);this.ready=false;
      // The immutable companion prevents a single missing file from erasing
      // replay history after restart. An interrupted initialization is kept for
      // reconciliation, never silently completed from an orphaned file.
      try{await this.io.compareWrite(`${this.path}.initialized`,null,JSON.stringify({format:"tutor-surface-transactions-initialized-v1",journalId:manifest.journalId,createdAt:manifest.createdAt}));}
      catch{this.lastWriteFailed=true;throw new Error("surface-journal-initialization-not-confirmed");}
    }else{
      if(raw===null)throw new Error("surface-journal-missing-after-initialization");
      if(markerRaw===null)throw new Error("surface-journal-initialization-marker-missing-requires-reconciliation");
      let marker:unknown;try{if(markerRaw.length>1024)throw new Error();marker=JSON.parse(markerRaw);}catch{throw new Error("surface-journal-initialization-marker-corrupt");}
      const checked=markerSchema.safeParse(marker);if(!checked.success)throw new Error("surface-journal-initialization-marker-corrupt");
      manifest=this.parse(raw);
      if(checked.data.journalId!==manifest.journalId||checked.data.createdAt!==manifest.createdAt)throw new Error("surface-journal-initialization-identity-mismatch");
    }
    if(this.binding){
      if(this.boundJournalId!==null&&this.boundJournalId!==manifest.journalId)throw new Error("surface-journal-settings-identity-mismatch");
      if(this.boundJournalId===null){
        // Complete the log/marker pair before binding settings. Neither a fresh
        // journal nor a migrated one may accept any transaction until the host
        // confirms its external identity. A failed settings write retains the
        // original files for retry; it never creates a replacement journal.
        this.ready=false;this.lastRevision=manifest.revision;
        try{await this.binding.persistJournalId(manifest.journalId);}
        catch{this.lastWriteFailed=true;throw new Error("surface-journal-settings-identity-not-confirmed");}
        this.boundJournalId=manifest.journalId;this.lastWriteFailed=false;
        // Settings IO can await long enough for native/external file changes.
        // Re-read the pair and compare its identity before enabling writes.
        return this.load();
      }
    }
    this.lastRevision = manifest.revision; this.ready = true; this.lastReason = "";
    return { raw, manifest };
  }
  private async write(raw: string | null, manifest: Manifest): Promise<string> {
    const reserved = manifest.records.filter(record => !terminal(record.phase)).reduce((sum, record) => sum + record.reservedBytes, 0);
    const reservations = manifest.records.filter(record => !terminal(record.phase)).reduce((sum, record) => sum + record.receipt.createdIds.length, 0);
    if (manifest.owners.length + reservations > SURFACE_TRANSACTION_POLICY.maxOwnedObjects) throw new Error("surface-ownership-capacity-requires-reconciliation");
    manifest.revision++; manifest.updatedAt = this.now();
    const next = JSON.stringify(manifest);
    if (Buffer.byteLength(next, "utf8") + reserved > SURFACE_TRANSACTION_POLICY.maxBytes) throw new Error("surface-journal-capacity-requires-reconciliation");
    try { await this.io.compareWrite(this.path, raw, next); this.lastWriteFailed = false; } catch { this.lastWriteFailed = true; throw new Error("surface-journal-write-not-confirmed"); }
    this.lastRevision = manifest.revision;
    return next;
  }
  initialize(): Promise<void> { return this.enqueue(async () => { const state = await this.load(); if (state.raw === null) await this.write(null, state.manifest); }); }
  async flush(): Promise<void> { await this.tail.catch(() => {}); if (this.lastWriteFailed) throw new Error("surface-journal-write-not-confirmed"); }
  async dispose(): Promise<void> { await this.flush(); this.closed = true; this.listeners.clear(); }
  private find(manifest: Manifest, ref: SurfaceTransactionRef, operationDigest?: string): SurfaceTransactionRecord | undefined {
    const key = keyOf(ref), record = manifest.records.find(record => record.key === key);
    if (!record) { if(manifest.barrierSetBits>=SURFACE_TRANSACTION_POLICY.maxBarrierSetBits)throw new Error("surface-replay-barrier-saturated-retain-journal");if (hasBarrier(manifest, key)) throw new Error("surface-request-expired-or-filtered-use-new-identity-after-reconciliation"); return undefined; }
    if (this.now() - record.createdAt >= SURFACE_TRANSACTION_POLICY.receiptRetentionMs) throw new Error("surface-request-expired-requires-reconciliation");
    if (operationDigest && record.receipt.operationDigest !== operationDigest) throw new Error("changeset-id-reused");
    return record;
  }
  lookup(ref: SurfaceTransactionRef, operationDigest?: string): Promise<SurfaceTransactionRecord | undefined> {
    return this.enqueue(async () => { const { manifest } = await this.load(); const record = this.find(manifest, ref, operationDigest); return record ? structuredClone(record) : undefined; });
  }
  prepare(changes: ChangeSet, grant: ContextGrant, surface: TaskTarget["surface"], receipt: SurfaceCommitReceipt, beforeObjects: readonly { id: string }[]): Promise<{ record: SurfaceTransactionRecord; created: boolean }> {
    return this.enqueue(async () => {
      const { raw, manifest } = await this.load(), operationDigest = surfaceDigest(changes);
      if (receipt.clientId !== grant.clientId || receipt.targetId !== changes.targetId || receipt.transactionId !== changes.id || receipt.requestId !== changes.taskId || receipt.operationDigest !== operationDigest) throw new Error("surface-prepare-identity-mismatch");
      const found = this.find(manifest, receipt, operationDigest); if (found) return { record: structuredClone(found), created: false };
      manifest.records = manifest.records.filter(record => this.now() - record.createdAt < SURFACE_TRANSACTION_POLICY.receiptRetentionMs);
      // The advertised 30-day receipt window is guaranteed even under load.
      // Capacity stops new writes instead of evicting an unexpired receipt.
      if (manifest.records.length >= SURFACE_TRANSACTION_POLICY.maxReceipts) throw new Error("surface-receipt-capacity-wait-for-retention-expiry");
      if (manifest.barrierSetBits >= SURFACE_TRANSACTION_POLICY.maxBarrierSetBits) throw new Error("surface-replay-barrier-saturated-retain-journal");
      const before = new Map(beforeObjects.map(object => [object.id, object])), beforeObjectRevisions: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
      for (const id of [...receipt.createdIds, ...receipt.updatedIds, ...receipt.deletedIds]) beforeObjectRevisions[id] = before.has(id) ? surfaceDigest(before.get(id)) : null;
      const reservedBytes = receipt.createdIds.reduce((sum, objectId) => sum + Buffer.byteLength(JSON.stringify({ clientId: receipt.clientId, targetId: receipt.targetId, transactionId: receipt.transactionId, objectId, revision: "0".repeat(64) }), "utf8") + 2, 512);
      const record = recordSchema.parse({ key: keyOf(receipt), receipt: { ...receipt, durability: "not-applied", committedRevision: undefined }, surface, phase: "prepared", createdAt: this.now(), updatedAt: this.now(), beforeObjectRevisions, reservedBytes });
      addBarrier(manifest, record.key); manifest.records.push(record); await this.write(raw, manifest); this.emit(record);
      return { record: structuredClone(record), created: true };
    });
  }
  transition(ref: SurfaceTransactionRef, phase: SurfaceTransactionPhase, appliedReceipt?: SurfaceCommitReceipt): Promise<SurfaceTransactionRecord> {
    return this.enqueue(async () => {
      const { raw, manifest } = await this.load(), record = this.find(manifest, ref); if (!record) throw new Error("surface-transaction-not-found");
      if (terminal(record.phase)) { if (record.phase !== phase) throw new Error("surface-transaction-already-final"); return structuredClone(record); }
      const allowed: Record<SurfaceTransactionPhase, SurfaceTransactionPhase[]> = { prepared: ["applying", "not-applied"], applying: ["applied", "not-applied", "unknown"], applied: ["applied", "saving", "unknown"], saving: ["committed", "applied", "unknown"], unknown: ["applied", "unknown"], committed: [], "not-applied": [] };
      if (!allowed[record.phase].includes(phase)) throw new Error("surface-transaction-state-conflict");
      if(appliedReceipt){
        const fixed=(receipt:SurfaceCommitReceipt)=>[receipt.transactionId,receipt.requestId,receipt.clientId,receipt.targetId,receipt.baseRevision,receipt.operationDigest,receipt.createdIds,receipt.updatedIds,receipt.deletedIds,receipt.resources];
        if(record.phase!=="applying"||phase!=="applied"||surfaceDigest(fixed(record.receipt))!==surfaceDigest(fixed(appliedReceipt)))throw new Error("surface-applied-receipt-identity-mismatch");
        record.receipt=surfaceReceiptSchema.parse(appliedReceipt);
      }
      record.phase = phase; record.updatedAt = this.now();
      record.receipt.durability = phase === "committed" ? "committed" : phase === "not-applied" ? "not-applied" : phase === "applied" ? "applied-not-durable" : "outcome-unknown";
      if (phase === "committed") {
        record.receipt.committedRevision = record.receipt.appliedRevision;
        const deleted = new Set(record.receipt.deletedIds);
        manifest.owners = manifest.owners.filter(owner => owner.targetId !== record.receipt.targetId || !deleted.has(owner.objectId));
        for (const objectId of record.receipt.updatedIds) {
          const owner = manifest.owners.find(owner => owner.targetId === record.receipt.targetId && owner.clientId === record.receipt.clientId && owner.objectId === objectId);
          if (owner) owner.revision = record.receipt.objectRevisions[objectId]!;
        }
        for (const objectId of record.receipt.createdIds) {
          // A new identity invalidates any obsolete ownership of a deleted/recreated native ID.
          manifest.owners = manifest.owners.filter(owner => owner.targetId !== record.receipt.targetId || owner.objectId !== objectId);
          manifest.owners.push({ clientId: record.receipt.clientId, targetId: record.receipt.targetId, transactionId: record.receipt.transactionId, objectId, revision: record.receipt.objectRevisions[objectId]! });
        }
      }
      await this.write(raw, manifest); this.emit(record); return structuredClone(record);
    });
  }
  authorizedGrant(grant: ContextGrant, targetId: string, objects: readonly { id: string }[]): Promise<ContextGrant> {
    return this.enqueue(async () => {
      const { manifest } = await this.load(), current = new Map(objects.map(object => [object.id, object]));
      const owned = manifest.owners.filter(owner => owner.clientId === grant.clientId && owner.targetId === targetId && current.has(owner.objectId) && surfaceDigest(current.get(owner.objectId)) === owner.revision).map(owner => owner.objectId);
      return { ...grant, humanObjectIds: [...new Set([...grant.humanObjectIds, ...owned])] };
    });
  }
  recordsForClient(clientId: string): Promise<SurfaceTransactionRecord[]> {
    return this.enqueue(async () => { const { manifest } = await this.load(); return structuredClone(manifest.records.filter(record => record.receipt.clientId === clientId && this.now() - record.createdAt < SURFACE_TRANSACTION_POLICY.receiptRetentionMs)); });
  }
}
