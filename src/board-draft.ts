import { boardLayoutSchema } from "./board-layout.js";
import { BoardSourceIdentityStore } from "./board-source-identity.js";
import { boardInkSchema, validateBoardDocument, validateBoardInk } from "./board-model.js";
import type { BoardBundle, BoardDocument } from "./board-types.js";

/** Desktop write-ahead drafts are recovery copies, never a second ink authority. */
export interface BoardDraftIO {
  read(path: string): Promise<string | null>;
  compareWrite(path: string, previous: string | null, next: string): Promise<void>;
}
export type BoardDraftFile = { path: string; encoding: "utf8" | "base64"; data: string; sha256: string };
type Draft = { token: string; baseHash: string | null; baseline: BoardDocument;
  bundle: BoardBundle; files: BoardDraftFile[]; assetConflicts?: string[]; savedAt: string; checksum: string };
type RecordV1 = { format: "tutor-board-draft-v1"; root: string; source: string;
  sourceType: BoardDocument["sourceType"]; pending: Draft | null;
  movedTo?: { source: string; boardId: string; token: string };
  moveFrom?: { source: string; boardId: string; expectedRawHash: string | null } };
export type BoardDraftTicket = { path: string; raw: string; token: string };
export type BoardDraftCaptureOptions = { assetConflicts?: string[]; baseHash?: string | null };
export const BOARD_DRAFT_MAX_BYTES = 64 * 1024 * 1024;
const BOARD_DRAFT_DAMAGED_COPIES = 3;
const digest = async (value: string | Uint8Array): Promise<string> => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))].map(byte => byte.toString(16).padStart(2, "0")).join("");
};
export const boardDraftHash = (value: string): Promise<string> => digest(value);
export const boardDraftBundleHash = (value: BoardBundle): Promise<string> => digest(JSON.stringify({ document: value.document, ink: value.ink }, (_key, entry: unknown) =>
  entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry));
const safePath = (path: string) => !!path && !path.startsWith("/") && !path.includes("\\") &&
  path.split("/").every(segment => !!segment && segment !== "." && segment !== "..");
export async function boardDraftFile(path: string, value: string | ArrayBuffer): Promise<BoardDraftFile> {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return { path, encoding: typeof value === "string" ? "utf8" : "base64", data: bytes.toString(typeof value === "string" ? "utf8" : "base64"), sha256: await digest(bytes) };
}
export async function boardDraftBytes(file: BoardDraftFile): Promise<Buffer> {
  if (file.encoding !== "utf8" && file.encoding !== "base64") throw new Error("board-draft-invalid");
  const bytes = Buffer.from(file.data, file.encoding);
  if (file.encoding === "base64" && bytes.toString("base64") !== file.data || await digest(bytes) !== file.sha256)
    throw new Error("board-draft-checksum");
  return bytes;
}
const stamp = async (draft: Omit<Draft, "checksum"> | Draft) => {
  const { checksum: _checksum, ...value } = draft as Draft;
  return digest(JSON.stringify(value));
};

/** One bounded record per target; corruption or contention cannot reset it. */
export class BoardDraftStore {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly observed = new Map<string, string>();
  public readonly identities: BoardSourceIdentityStore;
  constructor(private readonly io: BoardDraftIO) { this.identities = new BoardSourceIdentityStore(io); }
  public async path(root: string, source: string, sourceType: BoardDocument["sourceType"]): Promise<string> {
    if (!safePath(root) || !safePath(source)) throw new Error("board-draft-target");
    return `board-drafts-v1/${await digest(JSON.stringify([root, sourceType, source]))}.json`;
  }
  private async parse(raw: string, root: string, source: string, sourceType: BoardDocument["sourceType"]): Promise<RecordV1> {
    if (Buffer.byteLength(raw) > BOARD_DRAFT_MAX_BYTES) throw new Error("board-draft-size");
    let value: RecordV1;
    try { value = JSON.parse(raw) as RecordV1; } catch { throw new Error("board-draft-invalid"); }
    if (!value || typeof value !== "object" || typeof value.format !== "string") throw new Error("board-draft-invalid");
    if (value.format !== "tutor-board-draft-v1") throw new Error("board-draft-unsupported");
    if (value.root !== root || value.source !== source || value.sourceType !== sourceType) throw new Error("board-draft-target");
    if (value.movedTo && (value.pending !== null || value.moveFrom || !safePath(value.movedTo.source) || value.movedTo.source === source ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value.movedTo.boardId) || !/^[a-f\d]{64}$/.test(value.movedTo.token)))
      throw new Error("board-draft-target");
    if (value.moveFrom && (!value.pending || !safePath(value.moveFrom.source) || value.moveFrom.source === source ||
      value.moveFrom.boardId !== value.pending.bundle?.document?.id ||
      value.moveFrom.expectedRawHash !== null && !/^[a-f\d]{64}$/.test(value.moveFrom.expectedRawHash)))
      throw new Error("board-draft-target");
    if (value.pending === null) return value;
    const draft = value.pending;
    if (!draft || typeof draft.token !== "string" || !/^[a-f\d]{64}$/.test(draft.token) ||
      draft.baseHash !== null && !/^[a-f\d]{64}$/.test(draft.baseHash) ||
      !Number.isFinite(Date.parse(draft.savedAt)) || !Array.isArray(draft.files) || draft.files.length > 2048)
      throw new Error("board-draft-invalid");
    if (draft.checksum !== await stamp(draft)) throw new Error("board-draft-checksum");
    const document = validateBoardDocument(draft.bundle.document), ink = boardInkSchema.parse(draft.bundle.ink);
    validateBoardInk(document, ink);
    if(draft.bundle.layout&&boardLayoutSchema.parse(draft.bundle.layout).boardId!==document.id)throw new Error("layout-board-mismatch");
    const baseline = validateBoardDocument(draft.baseline);
    if (document.sourceFile !== source || document.sourceType !== sourceType ||
      baseline.id !== document.id || baseline.sourceFile !== source || baseline.sourceType !== sourceType)
      throw new Error("board-draft-target");
    if (draft.assetConflicts !== undefined && (!Array.isArray(draft.assetConflicts) || draft.assetConflicts.length > 100_000 ||
      draft.assetConflicts.some(path => typeof path !== "string" || !safePath(path) ||
        !["ink/", "ink-packs/"].some(folder => path.startsWith(`${root}/${folder}`))) ||
      new Set(draft.assetConflicts).size !== draft.assetConflicts.length)) throw new Error("board-draft-asset-path");
    const paths = new Set<string>();
    for (const file of draft.files) {
      // Recovery may restore dependencies only, never an authoritative board or unrelated Vault file.
      if (!safePath(file.path) || !["characters/", "ink/", "brushes/resources/", "paint-assets/"].some(folder => file.path.startsWith(`${root}/${folder}`)) || paths.has(file.path))
        throw new Error("board-draft-asset-path");
      paths.add(file.path); await boardDraftBytes(file);
    }
    return value;
  }
  private queue<T>(path: string, work: () => Promise<T>): Promise<T> {
    const task = (this.tails.get(path) ?? Promise.resolve()).catch(() => {}).then(work);
    this.tails.set(path, task);
    void task.finally(() => { if (this.tails.get(path) === task) this.tails.delete(path); }).catch(() => {});
    return task;
  }
  public async read(root: string, source: string, sourceType: BoardDocument["sourceType"]): Promise<Draft | null> {
    const path = await this.path(root, source, sourceType);
    return this.queue(path, async () => {
      const raw = await this.io.read(path);
      if (raw === null) return null;
      let current = raw, record: RecordV1;
      try { record = await this.parse(raw, root, source, sourceType); }
      catch (error) {
        // Unknown versions stay unsupported. Only a verified v1 previous record repairs damaged v1 data.
        if (error instanceof Error && error.message === "board-draft-unsupported") throw error;
        const previous = await this.io.read(path + ".previous");
        if (!previous) throw error;
        record = await this.parse(previous, root, source, sourceType);
        // Reading a backup must also restore a writable recovery journal.
        // Keep the damaged original first; never replace an outside repair or
        // downgrade an unknown format. Bounded copies stay in private storage.
        await this.preserveDamaged(path, raw);
        if (await this.io.read(path + ".previous") !== previous) throw new Error("state-file-conflict");
        await this.io.compareWrite(path, raw, previous);
        if (await this.io.read(path) !== previous) throw new Error("board-draft-verification");
        current = previous;
      }
      const draft = (await this.finishMove(path, current, record)).record.pending;
      if (draft) this.observed.set(path, draft.token); else this.observed.delete(path);
      return draft;
    });
  }
  private async preserveDamaged(path: string, raw: string): Promise<void> {
    if (Buffer.byteLength(raw) > BOARD_DRAFT_MAX_BYTES) throw new Error("board-draft-size");
    for (let index = 1; index <= BOARD_DRAFT_DAMAGED_COPIES; index++) {
      const target = `${path}.damaged-${index}`, existing = await this.io.read(target);
      if (existing === raw) return;
      if (existing !== null) continue;
      await this.io.compareWrite(target, null, raw);
      if (await this.io.read(target) !== raw) throw new Error("board-draft-verification");
      return;
    }
    throw new Error("board-draft-repair-limit");
  }
  /** The destination copy is complete before the old entry is atomically retired. */
  private async finishMove(path: string, raw: string, record: RecordV1): Promise<{ raw: string; record: RecordV1 }> {
    if (!record.moveFrom) return { raw, record };
    const move = record.moveFrom, draft = record.pending!, oldPath = await this.path(record.root, move.source, record.sourceType);
    await this.identities.validateMove(record.root, move.source, record.source, record.sourceType, move.boardId);
    const oldRaw = await this.io.read(oldPath), old = oldRaw === null ? null : await this.parse(oldRaw, record.root, move.source, record.sourceType);
    const retired = old?.movedTo?.source === record.source && old.movedTo.boardId === move.boardId && old.movedTo.token === draft.token;
    if (!retired) {
      if ((oldRaw === null ? null : await digest(oldRaw)) !== move.expectedRawHash || old?.movedTo ||
        old?.pending && old.pending.bundle.document.id !== move.boardId) throw new Error("board-draft-move-conflict");
      if (await this.io.read(path) !== raw) throw new Error("state-file-conflict");
      const marker: RecordV1 = { format: "tutor-board-draft-v1", root: record.root, source: move.source,
        sourceType: record.sourceType, pending: null, movedTo: { source: record.source, boardId: move.boardId, token: draft.token } };
      const moved = JSON.stringify(marker), previous = await this.io.read(oldPath + ".previous");
      // A damaged retired entry must not revive its previous old-path draft.
      await this.io.compareWrite(oldPath + ".previous", previous, moved);
      await this.io.compareWrite(oldPath, oldRaw, moved);
      if (await this.io.read(oldPath) !== moved) throw new Error("board-draft-verification");
    }
    await this.identities.move(record.root, move.source, record.source, record.sourceType, move.boardId);
    const { moveFrom: _moveFrom, ...ready } = record, next = JSON.stringify(ready);
    await this.io.compareWrite(path, raw, next);
    if (await this.io.read(path) !== next) throw new Error("board-draft-verification");
    return { raw: next, record: ready };
  }
  public async movedTo(root: string, source: string, sourceType: BoardDocument["sourceType"]): Promise<RecordV1["movedTo"] | null> {
    const path = await this.path(root, source, sourceType), raw = await this.io.read(path);
    return raw === null ? null : (await this.parse(raw, root, source, sourceType)).movedTo ?? null;
  }
  public async relocate(root: string, before: string, after: string, bundle: BoardBundle, baseline: BoardDocument,
    baseRaw: string | null, files: BoardDraftFile[], options: BoardDraftCaptureOptions = {}): Promise<void> {
    const oldPath = await this.path(root, before, bundle.document.sourceType), path = await this.path(root, after, bundle.document.sourceType);
    if (oldPath === path) return;
    bundle = structuredClone(bundle); baseline = structuredClone(baseline); files = structuredClone(files); options = structuredClone(options);
    if (bundle.document.sourceFile !== before || baseline.sourceFile !== before) throw new Error("board-draft-target");
    const work = async () => {
      await this.identities.validateMove(root, before, after, bundle.document.sourceType, bundle.document.id);
      const oldRaw = await this.io.read(oldPath), old = oldRaw === null ? null : await this.parse(oldRaw, root, before, bundle.document.sourceType);
      if (old?.movedTo) throw new Error("board-draft-source-moved");
      if (old?.pending && (old.pending.token !== this.observed.get(oldPath) || old.pending.bundle.document.id !== bundle.document.id))
        throw new Error("board-draft-conflict");
      const current = await this.io.read(path), target = current === null ? null : await this.parse(current, root, after, bundle.document.sourceType);
      if (target?.pending || target?.movedTo && (target.movedTo.source !== before || target.movedTo.boardId !== bundle.document.id))
        throw new Error("board-draft-target-conflict");
      bundle.document.sourceFile = after; bundle.document.revision++; bundle.document.updatedAt = new Date().toISOString();
      delete bundle.recovery; baseline.sourceFile = after;
      const pending = { token: await boardDraftBundleHash(bundle), baseHash: options.baseHash === undefined ? baseRaw === null ? null : await digest(baseRaw) : options.baseHash,
        baseline, bundle, files, ...(options.assetConflicts?.length ? { assetConflicts: options.assetConflicts } : {}), savedAt: new Date().toISOString() };
      const record: RecordV1 = { format: "tutor-board-draft-v1", root, source: after, sourceType: bundle.document.sourceType,
        pending: { ...pending, checksum: await stamp(pending) }, moveFrom: { source: before, boardId: bundle.document.id, expectedRawHash: oldRaw === null ? null : await digest(oldRaw) } };
      const next = JSON.stringify(record); await this.parse(next, root, after, bundle.document.sourceType);
      if (current !== null) {
        const prior = await this.io.read(path + ".previous"); await this.io.compareWrite(path + ".previous", prior, current);
      }
      await this.io.compareWrite(path, current, next);
      if (await this.io.read(path) !== next) throw new Error("board-draft-verification");
      const ready = await this.finishMove(path, next, record);
      this.observed.set(path, ready.record.pending!.token); this.observed.delete(oldPath);
    };
    // Stable lock order prevents inverse renames from deadlocking this store.
    const [first, second] = [oldPath, path].sort();
    await this.queue(first!, () => this.queue(second!, work));
  }
  public async capture(root: string, bundle: BoardBundle, baseline: BoardDocument, baseRaw: string | null, files: BoardDraftFile[], options: BoardDraftCaptureOptions = {}): Promise<BoardDraftTicket> {
    bundle = structuredClone(bundle); baseline = structuredClone(baseline); files = structuredClone(files);
    const assetConflicts = [...options.assetConflicts ?? []], baseHash = options.baseHash;
    const { sourceFile: source, sourceType } = bundle.document, path = await this.path(root, source, sourceType);
    // Capture the caller's detached scene before waiting on another target write.
    const pending = structuredClone({ token: await boardDraftBundleHash(bundle), baseHash: baseHash === undefined ? baseRaw === null ? null : await digest(baseRaw) : baseHash,
      baseline, bundle, files, ...(assetConflicts.length ? { assetConflicts } : {}), savedAt: new Date().toISOString() });
    const record: RecordV1 = { format: "tutor-board-draft-v1", root, source, sourceType, pending: { ...pending, checksum: await stamp(pending) } };
    const next = JSON.stringify(record);
    return this.queue(path, async () => {
      let raw = await this.io.read(path);
      if (raw !== null) {
        // Do not overwrite an unresolved draft belonging to a different board/writer.
        const parsed = await this.parse(raw, root, source, sourceType);
        if (parsed.movedTo) throw new Error("board-draft-source-moved");
        const ready = await this.finishMove(path, raw, parsed), before = ready.record; raw = ready.raw;
        if (before.pending && (before.pending.token !== this.observed.get(path) || before.pending.bundle.document.id !== bundle.document.id ||
          before.pending.baseHash !== pending.baseHash || before.pending.bundle.document.revision > bundle.document.revision))
          throw new Error("board-draft-conflict");
        await this.parse(next, root, source, sourceType);
        const previous = await this.io.read(path + ".previous");
        await this.io.compareWrite(path + ".previous", previous, raw);
      } else await this.parse(next, root, source, sourceType);
      await this.io.compareWrite(path, raw, next);
      this.observed.set(path, pending.token);
      // A write receipt alone does not establish recoverability.
      if (await this.io.read(path) !== next) throw new Error("board-draft-verification");
      await this.parse(next, root, source, sourceType);
      return { path, raw: next, token: pending.token };
    });
  }
  public resolve(ticket: BoardDraftTicket): Promise<void> {
    return this.queue(ticket.path, async () => {
      const raw = await this.io.read(ticket.path);
      if (raw !== ticket.raw) return; // A late completion must not clear a newer draft.
      const record = JSON.parse(raw) as RecordV1;
      const next = JSON.stringify({ ...record, pending: null });
      await this.io.compareWrite(ticket.path, raw, next);
      // Do not retain private artwork after a completed authority save.
      const previous = await this.io.read(ticket.path + ".previous");
      if (previous !== null) await this.io.compareWrite(ticket.path + ".previous", previous, next);
    });
  }
  public async acknowledge(root: string, source: string, sourceType: BoardDocument["sourceType"], token: string): Promise<void> {
    const path = await this.path(root, source, sourceType), raw = await this.io.read(path);
    if (raw === null || (await this.parse(raw, root, source, sourceType)).pending?.token !== token) return;
    await this.resolve({ path, raw, token });
  }
}
