import { expect, it } from "vitest";
import { BoardRepository, BoardConflictError, type BoardStorageAdapter } from "../src/board-store.js";
import { BoardDraftStore, type BoardDraftIO } from "../src/board-draft.js";
import { BoardHistory, createBoardDocument, upgradeBoardDocument } from "../src/board-model.js";
import type { BoardDocument, BoardObject } from "../src/board-types.js";

class IO implements BoardDraftIO {
  files = new Map<string, string>();
  beforeWrite?: (path: string, before: string | null, after: string) => void;
  async read(path: string) { return this.files.get(path) ?? null; }
  async compareWrite(path: string, before: string | null, after: string) {
    this.beforeWrite?.(path, before, after);
    if (await this.read(path) !== before) throw new Error("state-file-conflict");
    this.files.set(path, after);
  }
}
class Vault implements BoardStorageAdapter {
  files = new Map<string, string>(); folders = new Set<string>(); failPath = "";
  async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
  async read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, value: string) { if (path === this.failPath) throw new Error("primary disk error"); this.files.set(path, value); }
  async mkdir(path: string) { this.folders.add(path); }
  async list(path: string) { return { files: [...this.files.keys()].filter(file => file.startsWith(path + "/") && !file.slice(path.length + 1).includes("/")), folders: [] }; }
}
const root = "Agent Memory", before = "QA/before.md", after = "QA/after.md";
const ink = { id: "INK-source-move", createdAt: "2026-10-10T00:00:00Z", points: [{ x: 0, y: 0, pressure: 0.2 }, { x: 60, y: 30, pressure: 0.9 }] };
async function fixture(type: BoardDocument["sourceType"] = "markdown") {
  const vault = new Vault(), io = new IO(), store = new BoardDraftStore(io), repo = new BoardRepository(vault, root, store);
  const local = await repo.open(before, type);
  while (local.document.schemaVersion < 5) local.document = upgradeBoardDocument(local.document);
  await repo.save(local.document, local.ink);
  const anchor: BoardObject["anchor"] = type === "markdown" ? { kind: "markdown", key: "p", quote: "Source" } : type === "pdf" ? { kind: "pdf", page: 1 } : { kind: "canvas", pageId: "artboard-main" };
  local.document.objects.push({ id: "OBJ-source-move", kind: "ink", anchor, x: 20, y: 30, width: 60, height: 30,
    color: "#446677", strokeWidth: 2, inkId: ink.id, createdBy: "human", editedBy: "human", revision: 1, groupId: "GROUP-source-move" });
  local.ink[ink.id] = structuredClone(ink); local.document.revision++;
  const path = repo.boardPath(local.document.id), authority = await vault.read(path);
  vault.failPath = path; await expect(repo.save(local.document, local.ink)).rejects.toThrow("primary disk error");
  const fresh = () => new BoardRepository(vault, root, new BoardDraftStore(io));
  return { vault, io, store, repo, local, path, authority, fresh, type };
}
for (const type of ["markdown", "pdf", "standalone"] as const) {
  it(`renames the unsaved ${type} branch under its stable ID while a primary write still fails`, async () => {
    const f = await fixture(type);
    await expect(f.repo.renameSource(before, after)).resolves.toMatchObject([{ boardId: f.local.document.id, durability: "recovery-only" }]);
    expect(await f.vault.read(f.path)).toBe(f.authority);
    const restored = await f.fresh().open(after, type);
    expect(restored.document.id).toBe(f.local.document.id); expect(restored.document.sourceFile).toBe(after);
    expect(restored.document.objects).toEqual(f.local.document.objects); expect(restored.ink).toEqual(f.local.ink);
    expect(restored.recovery?.conflicted).toBe(false);
    expect(restored.recovery?.baseline.sourceFile).toBe(after);
    const history = new BoardHistory(restored.document, 100, restored.recovery!.baseline); history.undo(); expect(history.document.objects).toHaveLength(0);
    expect(await new BoardDraftStore(f.io).read(root, before, type)).toBeNull();
    await expect(f.repo.save(f.local.document, f.local.ink)).rejects.toThrow(/source-moved/);
    f.vault.failPath = ""; const retry = f.fresh(), own = await retry.open(after, type); await retry.save(own.document, own.ink);
    const saved = await f.fresh().open(after, type); expect(saved.recovery).toBeUndefined(); expect(saved.document.objects).toEqual(f.local.document.objects);
  });
}
it("deduplicates repeated rename events and resumes the same prepared branch", async () => {
  const f = await fixture(); await f.repo.renameSource(before, after);
  const first = await f.fresh().open(after, "markdown"); await f.repo.renameSource(before, after);
  const repeated = await f.fresh().open(after, "markdown");
  expect(repeated.document.revision).toBe(first.document.revision); expect(repeated.document.id).toBe(first.document.id); expect(repeated.ink).toEqual(first.ink);
  f.vault.failPath = ""; await f.repo.renameSource(before, after);
  expect((await f.fresh().open(after, "markdown")).recovery).toBeUndefined(); await expect(f.repo.flush()).resolves.toBeUndefined();
});
it("can reverse a rename while preserving the same failed-save branch and original undo baseline", async () => {
  const f = await fixture(); await f.repo.renameSource(before, after); await f.repo.renameSource(after, before);
  const restored = await f.fresh().open(before, "markdown");
  expect(restored.document.id).toBe(f.local.document.id); expect(restored.document.objects).toEqual(f.local.document.objects); expect(restored.ink).toEqual(f.local.ink);
  expect(restored.recovery?.baseline.objects).toHaveLength(0); expect(restored.recovery?.conflicted).toBe(false);
  expect(await new BoardDraftStore(f.io).read(root, after, "markdown")).toBeNull();
});
it("does not replace a board already associated with the destination", async () => {
  const f = await fixture(); f.vault.failPath = "";
  const other = await f.repo.open(after, "markdown"); await f.repo.save(other.document, other.ink);
  const oldDraft = await f.io.read(await f.store.path(root, before, "markdown")), targetRaw = await f.vault.read(f.repo.boardPath(other.document.id));
  await expect(f.repo.renameSource(before, after)).rejects.toThrow("board-draft-target-conflict");
  expect(await f.vault.read(f.path)).toBe(f.authority); expect(await f.vault.read(f.repo.boardPath(other.document.id))).toBe(targetRaw);
  expect(await f.io.read(await f.store.path(root, before, "markdown"))).toBe(oldDraft);
});
it("restarts from the destination copy after interruption before the old entry is retired", async () => {
  const f = await fixture(), oldPath = await f.store.path(root, before, "markdown"); let injected = false;
  f.io.beforeWrite = (path, _before, raw) => { if (path === oldPath && JSON.parse(raw).movedTo && !injected) { injected = true; throw new Error("synthetic-move-interruption"); } };
  await expect(f.repo.renameSource(before, after)).rejects.toThrow("synthetic-move-interruption"); f.io.beforeWrite = undefined;
  const restored = await f.fresh().open(after, "markdown");
  expect(restored.document.id).toBe(f.local.document.id); expect(restored.document.objects).toEqual(f.local.document.objects); expect(restored.ink).toEqual(f.local.ink);
  expect(await new BoardDraftStore(f.io).read(root, before, "markdown")).toBeNull();
});
it("keeps the original draft discoverable when the destination recovery copy cannot be written", async () => {
  const f = await fixture(), destination = await f.store.path(root, after, "markdown"), old = await f.io.read(await f.store.path(root, before, "markdown"));
  f.io.beforeWrite = path => { if (path === destination) throw new Error("destination disk error"); };
  await expect(f.repo.renameSource(before, after)).rejects.toThrow("destination disk error");
  expect(await f.io.read(await f.store.path(root, before, "markdown"))).toBe(old); expect(await f.vault.read(f.path)).toBe(f.authority);
  expect((await f.fresh().open(before, "markdown")).document.objects).toEqual(f.local.document.objects);
});
it("preserves an external authority branch and exposes the renamed local branch as conflicted", async () => {
  const f = await fixture(); f.vault.failPath = "";
  const external = JSON.parse(f.authority); external.title = "External branch"; const raw = JSON.stringify(external); f.vault.files.set(f.path, raw);
  await expect(f.repo.renameSource(before, after)).resolves.toMatchObject([{ durability: "recovered-conflict" }]);
  expect(await f.vault.read(f.path)).toBe(raw); const restored = await f.fresh().open(after, "markdown");
  expect(restored.recovery?.conflicted).toBe(true); expect(restored.document.objects).toEqual(f.local.document.objects);
  expect([...f.vault.files.keys()].some(path => path.includes(".conflict-"))).toBe(true);
  const retry = f.fresh(), own = await retry.open(after, "markdown"); await expect(retry.save(own.document, own.ink)).rejects.toBeInstanceOf(BoardConflictError);
});
it("does not mistake a same-revision artwork change for a derived manifest difference", async () => {
  const f = await fixture(), original = await f.io.read(await f.store.path(root, before, "markdown"));
  const conflicting = structuredClone(f.local); conflicting.document.objects[0]!.color = "#ff0000";
  await expect(f.repo.renameSource(before, after, [conflicting])).rejects.toThrow("board-draft-conflict");
  expect(await f.io.read(await f.store.path(root, before, "markdown"))).toBe(original);
  expect(await f.io.read(await f.store.path(root, after, "markdown"))).toBeNull();
});
it("never revives a retired source from its previous recovery entry after current-record damage", async () => {
  const f = await fixture(), path = await f.store.path(root, before, "markdown"); await f.repo.renameSource(before, after);
  const retired = await f.io.read(path); f.io.files.set(path, '{"format":"tutor-board-draft-v1",');
  expect(await new BoardDraftStore(f.io).read(root, before, "markdown")).toBeNull();
  expect(await f.io.read(path)).toBe(retired); expect(await f.io.read(path + ".damaged-1")).toBe('{"format":"tutor-board-draft-v1",');
  await expect(f.fresh().open(before, "markdown")).rejects.toThrow(/source-moved/);
  await expect(f.repo.save(f.local.document, f.local.ink)).rejects.toThrow(/source-moved/);
  expect((await f.fresh().open(after, "markdown")).document.objects).toEqual(f.local.document.objects);
});
it("finishes a move interrupted after retirement without adding another artwork revision", async () => {
  const f = await fixture(), destination = await f.store.path(root, after, "markdown"); let injected = false;
  f.io.beforeWrite = (path, _before, raw) => { if (path === destination && !JSON.parse(raw).moveFrom && !injected) { injected = true; throw new Error("destination-finalization-interrupted"); } };
  await expect(f.repo.renameSource(before, after)).rejects.toThrow("destination-finalization-interrupted");
  const prepared = JSON.parse((await f.io.read(destination))!); f.io.beforeWrite = undefined;
  const restored = await f.fresh().open(after, "markdown");
  expect(restored.document.revision).toBe(prepared.pending.bundle.document.revision); expect(restored.ink).toEqual(f.local.ink);
  expect(JSON.parse((await f.io.read(destination))!).moveFrom).toBeUndefined();
  expect(await new BoardDraftStore(f.io).read(root, before, "markdown")).toBeNull();
});

async function historicalFixture(type: BoardDocument["sourceType"]) {
  const f=await fixture(type),other=createBoardDocument(before,type,'BOARD-historical-'+type);
  f.vault.files.set(f.repo.boardPath(other.id),JSON.stringify(other));
  const choices=await f.repo.sourceBranchChoices(before,type);
  await f.repo.selectSourceBranch(before,type,f.local.document.id,choices!.branches,choices!.identityRevision);
  return f;
}
for (const type of ["markdown", "pdf", "standalone"] as const) {
  it(`rejects unsupported multi-version ${type} relocation before changing either recovery route`,async()=>{
    const f=await historicalFixture(type),privateBefore=new Map(f.io.files),filesBefore=new Map(f.vault.files);
    await expect(f.repo.renameSource(before,after)).rejects.toThrow('board-source-branches-move-required');
    expect(f.io.files).toEqual(privateBefore);expect(f.vault.files).toEqual(filesBefore);
    const retry=f.fresh(),own=await retry.open(before,type);expect(own.document.id).toBe(f.local.document.id);expect(own.ink).toEqual(f.local.ink);
    own.document.objects[0]!.color='#123456';own.document.revision++;f.vault.failPath='';await retry.save(own.document,own.ink);
    const restored=await f.fresh().open(before,type);expect(restored.document.objects[0]!.color).toBe('#123456');expect(restored.ink).toEqual(f.local.ink);
    expect(await f.store.movedTo(root,before,type)).toBeNull();expect(await f.io.read(await f.store.path(root,after,type))).toBeNull();
  });
}
it('protects direct draft callers from retiring an unsupported historical source',async()=>{
  const f=await historicalFixture('markdown'),old=await f.store.read(root,before,'markdown'),all=new Map(f.io.files);
  await expect(f.store.relocate(root,before,after,old!.bundle,old!.baseline,f.authority,old!.files)).rejects.toThrow('board-source-branches-move-required');
  expect(f.io.files).toEqual(all);expect((await f.store.read(root,before,'markdown'))!.bundle.ink).toEqual(f.local.ink);
});
it('rechecks the source before retiring its draft when a historical branch appears during preparation',async()=>{
  const f=await fixture(),destination=await f.store.path(root,after,'markdown'),oldPath=await f.store.path(root,before,'markdown'),old=await f.io.read(oldPath),indexPath=await f.store.identities.path(root,before,'markdown');
  let injected=false;f.io.beforeWrite=(path,_before,raw)=>{if(path===destination&&JSON.parse(raw).moveFrom&&!injected){injected=true;const identity=JSON.parse(f.io.files.get(indexPath)!);identity.revision++;identity.alternatives=[{id:'BOARD-external-history',hash:'a'.repeat(64)}];f.io.files.set(indexPath,JSON.stringify(identity));}};
  await expect(f.repo.renameSource(before,after)).rejects.toThrow('board-source-branches-move-required');f.io.beforeWrite=undefined;
  expect(await f.io.read(oldPath)).toBe(old);expect(await f.store.movedTo(root,before,'markdown')).toBeNull();expect((await f.store.read(root,before,'markdown'))!.bundle.ink).toEqual(f.local.ink);
  expect(await f.vault.read(f.path)).toBe(f.authority);await expect(f.store.read(root,after,'markdown')).rejects.toThrow('board-source-branches-move-required');
});
it("keeps the complete destination copy and rejects retirement after an external old-entry change", async () => {
  const f = await fixture(), oldPath = await f.store.path(root, before, "markdown"), destination = await f.store.path(root, after, "markdown");
  const external = JSON.stringify({ format: "tutor-board-draft-v1", root, source: before, sourceType: "markdown", pending: null });
  f.io.beforeWrite = (path, _before, raw) => { if (path === oldPath && JSON.parse(raw).movedTo) f.io.files.set(oldPath, external); };
  await expect(f.repo.renameSource(before, after)).rejects.toThrow("state-file-conflict"); f.io.beforeWrite = undefined;
  expect(await f.io.read(oldPath)).toBe(external);
  const copy = JSON.parse((await f.io.read(destination))!); expect(copy.pending.bundle.ink).toEqual(f.local.ink);
  await expect(f.fresh().open(after, "markdown")).rejects.toThrow("board-draft-move-conflict");
  expect(await f.vault.read(f.path)).toBe(f.authority);
});
