import { expect, it } from "vitest";
import { BoardDraftStore, boardDraftFile, type BoardDraftIO } from "../src/board-draft.js";
import { BoardRepository, BoardConflictError, type BoardStorageAdapter } from "../src/board-store.js";
import { BoardHistory, createBoardDocument, validateBoardInk } from "../src/board-model.js";
import type { BoardBundle, BoardObject } from "../src/board-types.js";
class IO implements BoardDraftIO {
  files = new Map<string, string>(); fail = false; cleanupFail = false;
  async read(path: string) { return this.files.get(path) ?? null; }
  async compareWrite(path: string, previous: string | null, next: string) {
    if (this.fail || this.cleanupFail && JSON.parse(next).pending === null) throw new Error("backup disk error");
    if (await this.read(path) !== previous) throw new Error("state-file-conflict");
    this.files.set(path, next);
  }
}
class Vault implements BoardStorageAdapter {
  files = new Map<string, string>(); binary = new Map<string, ArrayBuffer>(); failPath = "";
  folders = new Set<string>();
  async exists(path: string) { return this.files.has(path) || this.binary.has(path) || this.folders.has(path); }
  async read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, value: string) { if (path === this.failPath) throw new Error("primary disk error"); this.files.set(path, value); }
  async mkdir(path: string) { this.folders.add(path); }
  async list(path: string) { return { files: [...this.files.keys()].filter(file => file.startsWith(path + "/") && !file.slice(path.length + 1).includes("/")), folders: [] }; }
  async readBinary(path: string) { const value = this.binary.get(path); if (!value) throw new Error("missing asset"); return value.slice(0); }
  async writeBinary(path: string, value: ArrayBuffer) { this.binary.set(path, value.slice(0)); }
}
const object: BoardObject = { id: "OBJ-ink", kind: "ink", anchor: { kind: "canvas", pageId: "artboard-main" },
  x: 20, y: 40, width: 70, height: 40, color: "#446677", strokeWidth: 2, inkId: "INK-original",
  createdBy: "human", editedBy: "human", revision: 1, groupId: "human-one" };
const stroke = { id: "INK-original", createdAt: "2026-10-10T00:00:00Z", points: [{ x: 0, y: 0, pressure: 0.2 }, { x: 70, y: 40, pressure: 0.9 }] };
async function fixture(root = "Agent Memory") {
  const io = new IO(), vault = new Vault(), store = new BoardDraftStore(io);
  const repo = new BoardRepository(vault, root, store), bundle = await repo.open("QA/recovery.tutorboard", "standalone");
  await repo.save(bundle.document, bundle.ink);
  const baseline = structuredClone(bundle.document);
  bundle.document.objects.push(structuredClone(object)); bundle.ink[stroke.id] = structuredClone(stroke); bundle.document.revision++;
  const path = repo.boardPath(bundle.document.id), saved = await vault.read(path);
  const reopen = () => new BoardRepository(vault, root, new BoardDraftStore(io));
  return { io, vault, store, repo, bundle, baseline, path, saved, reopen, root };
}
it("documents the original gap: an unjournaled failed save cannot survive a fresh repository", async () => {
  const vault = new Vault(), repo = new BoardRepository(vault, "Agent Memory"), bundle = await repo.open("QA/legacy.md", "markdown");
  await repo.save(bundle.document, {}); bundle.document.objects.push({ ...object, anchor: { kind: "markdown", key: "p", quote: "Q" } }); bundle.document.revision++;
  vault.failPath = repo.boardPath(bundle.document.id);
  await expect(repo.save(bundle.document, { [stroke.id]: stroke })).rejects.toThrow(); vault.failPath = "";
  expect((await new BoardRepository(vault, "Agent Memory").open("QA/legacy.md", "markdown")).document.objects).toHaveLength(0);
});
it("recovers IDs, pressure and the undo baseline after the original repository is destroyed", async () => {
  const f = await fixture(); f.vault.failPath = f.path;
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow("primary disk error");
  const recovered = await f.reopen().open(f.bundle.document.sourceFile, "standalone");
  expect(recovered.document.objects).toEqual(f.bundle.document.objects); expect(recovered.ink).toEqual(f.bundle.ink);
  expect(recovered.recovery).toEqual({ baseline: f.baseline, conflicted: false });
  const history = new BoardHistory(recovered.document, 100, recovered.recovery!.baseline);
  expect(history.canUndo).toBe(true); history.undo(); expect(history.document.objects).toHaveLength(0);
  history.redo(); expect(history.document.objects[0]?.id).toBe(object.id);
  expect(await f.vault.read(f.path)).toBe(f.saved);
});
it("recovers a never-saved board under its original identity", async () => {
  const io = new IO(), vault = new Vault(), repo = new BoardRepository(vault, "Agent Memory", new BoardDraftStore(io));
  const bundle = await repo.open("QA/new.md", "markdown"); bundle.document.objects.push({ ...object, anchor: { kind: "markdown", key: "p", quote: "Q" } }); bundle.document.revision++;
  vault.failPath = repo.boardPath(bundle.document.id); await expect(repo.save(bundle.document, { [stroke.id]: stroke })).rejects.toThrow();
  const recovered = await new BoardRepository(vault, "Agent Memory", new BoardDraftStore(io)).open("QA/new.md", "markdown");
  expect(recovered.document.id).toBe(bundle.document.id); expect(recovered.recovery?.conflicted).toBe(false);
});
it("a retry saves once and clears the recovery marker without duplicating ink", async () => {
  const f = await fixture(); f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow();
  f.vault.failPath = ""; const repo = f.reopen(), restored = await repo.open(f.bundle.document.sourceFile, "standalone");
  await repo.save(restored.document, restored.ink); const reopened = await f.reopen().open(f.bundle.document.sourceFile, "standalone");
  expect(reopened.recovery).toBeUndefined(); expect(reopened.document.objects).toHaveLength(1); expect(Object.keys(reopened.ink)).toEqual([stroke.id]);
});
it("cleanup failure does not resurrect an already committed draft", async () => {
  const f = await fixture(); f.io.cleanupFail = true; await f.repo.save(f.bundle.document, f.bundle.ink);
  const restored = await f.reopen().open(f.bundle.document.sourceFile, "standalone"); expect(restored.recovery).toBeUndefined(); expect(restored.document.objects).toHaveLength(1);
});
it("a derived SVG failure cannot replace the committed authority with an older draft", async () => {
  const f = await fixture(); f.vault.failPath = f.path.replace(/\.board\.json$/, ".svg");
  await expect(f.repo.save(f.bundle.document, f.bundle.ink, "<svg/>")).rejects.toThrow();
  const restored = await f.reopen().open(f.bundle.document.sourceFile, "standalone"); expect(restored.recovery).toBeUndefined(); expect(restored.document.objects).toHaveLength(1);
  f.vault.failPath = f.path; f.bundle.document.revision++;
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow("primary disk error");
  expect((await f.reopen().open(f.bundle.document.sourceFile, "standalone")).recovery).toBeDefined();
});
it("original ink in the journal recovers even when a canonical ink file is missing", async () => {
  const f = await fixture(); await f.repo.save(f.bundle.document, f.bundle.ink);
  f.bundle.document.objects[0]!.x += 10; f.bundle.document.revision++; f.vault.failPath = f.path;
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow();
  f.vault.files.delete(f.repo.inkPath(stroke.id));
  for (const path of f.vault.files.keys()) if (path.includes("/ink-packs/")) f.vault.files.delete(path);
  const recovered = await f.reopen().open(f.bundle.document.sourceFile, "standalone");
  expect(recovered.ink[stroke.id]).toEqual(stroke); expect(recovered.document.objects[0]?.x).toBe(30);
});
it("missing dependencies do not produce a falsely complete recovery package", async () => {
  const f = await fixture(); f.bundle.document.objects.push({ ...object, id: "OBJ-missing", kind: "character", inkId: undefined, characterId: "CHAR-missing", characterVersion: 1 });
  f.vault.failPath = f.path;
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow("Board save and recovery backup failed");
  expect(await f.store.read(f.root, f.bundle.document.sourceFile, "standalone")).toBeNull(); expect(await f.vault.read(f.path)).toBe(f.saved);
});
it("preserves an external same-revision edit and writes the recovered draft only as a conflict fork", async () => {
  const f = await fixture(); f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow(); f.vault.failPath = "";
  const external = JSON.parse(f.saved); external.title = "External user change"; await f.vault.write(f.path, JSON.stringify(external));
  const raw = await f.vault.read(f.path), repo = f.reopen(), recovered = await repo.open(f.bundle.document.sourceFile, "standalone");
  expect(recovered.recovery?.conflicted).toBe(true); await expect(repo.save(recovered.document, recovered.ink)).rejects.toBeInstanceOf(BoardConflictError);
  expect(await f.vault.read(f.path)).toBe(raw); expect([...f.vault.files.keys()].some(path => path.includes(".conflict-"))).toBe(true);
});
it("recovery undo stays on the original branch when the external board has new ink", async () => {
  const f = await fixture(); f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow(); f.vault.failPath = "";
  const externalRepo = new BoardRepository(f.vault, f.root), external = await externalRepo.open(f.bundle.document.sourceFile, "standalone");
  external.document.objects.push({ ...object, id: "OBJ-external", inkId: "INK-external" }); external.document.revision++;
  external.ink["INK-external"] = { ...stroke, id: "INK-external" }; await externalRepo.save(external.document, external.ink);
  const recovered = await f.reopen().open(f.bundle.document.sourceFile, "standalone");
  expect(recovered.recovery?.conflicted).toBe(true);
  const history = new BoardHistory(recovered.document, 100, recovered.recovery!.baseline); history.undo();
  expect(history.document.objects).toHaveLength(0); expect(() => validateBoardInk(history.document, recovered.ink)).not.toThrow();
});
it("an immediate conflict fork must not mutate the authority's active ink pack or hide external ink", async () => {
  const f = await fixture(); f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow(); f.vault.failPath = "";
  const externalRepo = new BoardRepository(f.vault, f.root), external = await externalRepo.open(f.bundle.document.sourceFile, "standalone");
  external.document.objects.push({ ...object, id: "OBJ-external", inkId: "INK-external" }); external.document.revision++;
  external.ink["INK-external"] = { ...stroke, id: "INK-external" }; await externalRepo.save(external.document, external.ink);
  const primary = await f.vault.read(f.path), packPath = externalRepo.inkPackPath(external.document.id, external.document.inkManifest!.packs[0]!.id), pack = await f.vault.read(packPath);
  const repo = f.reopen(), recovered = await repo.open(f.bundle.document.sourceFile, "standalone");
  await expect(repo.save(recovered.document, recovered.ink)).rejects.toBeInstanceOf(BoardConflictError);
  expect(await f.vault.read(f.path)).toBe(primary); expect(await f.vault.read(packPath)).toBe(pack);
  const reopened = await new BoardRepository(f.vault, f.root).open(f.bundle.document.sourceFile, "standalone");
  expect(reopened.document.objects[0]?.id).toBe("OBJ-external"); expect(reopened.ink["INK-external"]).toEqual(external.ink["INK-external"]);
  const conflictPath = [...f.vault.files.keys()].find(path => path.endsWith(".board.json") && path.includes(".conflict-"))!;
  const fork = JSON.parse(await f.vault.read(conflictPath)); expect(fork.id).toBe(f.bundle.document.id);
  expect(fork.objects[0].id).toBe(object.id); expect(fork.inkManifest.packs[0].id).not.toBe(external.document.inkManifest!.packs[0]!.id);
  const forkPack = JSON.parse(await f.vault.read(repo.inkPackPath(fork.id, fork.inkManifest.packs[0].id)));
  expect(forkPack.strokes[stroke.id]).toEqual(stroke);
});
it("retrying a recovered conflict preserves its original base hash and undo branch across another reopen", async () => {
  const f = await fixture(); f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow(); f.vault.failPath = "";
  const originalDraft = await f.store.read(f.root, f.bundle.document.sourceFile, "standalone");
  const externalRepo = new BoardRepository(f.vault, f.root), external = await externalRepo.open(f.bundle.document.sourceFile, "standalone");
  external.document.objects.push({ ...object, id: "OBJ-external", inkId: "INK-external" }); external.document.revision++;
  external.ink["INK-external"] = { ...stroke, id: "INK-external" }; await externalRepo.save(external.document, external.ink);
  const repo = f.reopen(), restored = await repo.open(f.bundle.document.sourceFile, "standalone");
  restored.document.objects[0]!.x += 19; restored.document.revision++;
  await expect(repo.save(restored.document, restored.ink)).rejects.toBeInstanceOf(BoardConflictError);
  const retriedDraft = await new BoardDraftStore(f.io).read(f.root, f.bundle.document.sourceFile, "standalone");
  expect(retriedDraft?.bundle.document.objects[0]?.x).toBe(39);
  expect((await repo.read(f.bundle.document.sourceFile, "standalone"))?.document.objects[0]?.x).toBe(39);
  expect(retriedDraft?.baseHash).toBe(originalDraft?.baseHash);
  const reopened = await f.reopen().open(f.bundle.document.sourceFile, "standalone"); expect(reopened.recovery?.conflicted).toBe(true);
  const history = new BoardHistory(reopened.document, 100, reopened.recovery!.baseline); history.undo();
  expect(history.document.objects).toHaveLength(0); expect(() => validateBoardInk(history.document, reopened.ink)).not.toThrow();
});
it("copies and restores uploaded character dependencies before rendering the recovered scene", async () => {
  const f = await fixture(), assetPath = "Agent Memory/characters/assets/portrait.png", bytes = new Uint8Array([1, 5, 9]).buffer;
  f.vault.binary.set(assetPath, bytes);
  await f.repo.saveCharacter({ id: "CHAR-test", version: 1, name: "Original", origin: "uploaded", style: "custom", width: 100, height: 100, createdAt: stroke.createdAt, assetPath });
  f.bundle.document.objects.push({ ...object, id: "OBJ-character", kind: "character", inkId: undefined, characterId: "CHAR-test", characterVersion: 1 });
  f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow();
  f.vault.binary.delete(assetPath); f.vault.files.delete("Agent Memory/characters/CHAR-test.v1.character.json");
  const restored = await f.reopen().open(f.bundle.document.sourceFile, "standalone");
  expect(restored.document.objects).toHaveLength(2); expect(await f.vault.readBinary(assetPath)).toEqual(bytes);
});
it("will not overwrite changed dependency bytes or drop the pending draft", async () => {
  const f = await fixture(), path = "Agent Memory/paint-assets/" + "a".repeat(64) + ".mask.deflate";
  f.bundle.document.layers![0]!.kind = "paint";
  f.vault.binary.set(path, new Uint8Array([1, 2]).buffer);
  f.bundle.document.paintOperations = [{ id: "PAINT-fill", layerId: "layer-default", type: "fill", bounds: { x: 0, y: 0, width: 50, height: 50 }, affectedTiles: ["0:0"], color: "#ff0000", opacity: 1, maskAssetHash: "a".repeat(64), maskWidth: 50, maskHeight: 50, createdAt: stroke.createdAt, revision: 1 }];
  f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow();
  f.vault.binary.set(path, new Uint8Array([99]).buffer);
  await expect(f.reopen().open(f.bundle.document.sourceFile, "standalone")).rejects.toThrow("board-draft-asset-conflict");
  expect(await f.store.read(f.root, f.bundle.document.sourceFile, "standalone")).not.toBeNull();
});
it("backup failure cannot block a successful ordinary save; simultaneous failures remain explicit", async () => {
  const f = await fixture(); f.io.fail = true; await f.repo.save(f.bundle.document, f.bundle.ink);
  f.bundle.document.revision++; f.vault.failPath = f.path;
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow("Board save and recovery backup failed");
  expect(f.bundle.document.objects).toHaveLength(1);
});
it("a late ticket cannot clear a newer recovery snapshot", async () => {
  const io = new IO(), store = new BoardDraftStore(io), baseline = createBoardDocument("QA/late.md", "markdown"), bundle: BoardBundle = { document: baseline, ink: {} };
  const first = await store.capture("Agent Memory", bundle, baseline, null, []);
  bundle.document = { ...baseline, revision: baseline.revision + 1, title: "New edit" };
  await store.capture("Agent Memory", bundle, baseline, null, []); await store.resolve(first);
  expect((await store.read("Agent Memory", baseline.sourceFile, "markdown"))?.bundle.document.title).toBe("New edit");
});
it("another writer cannot replace an unresolved draft after observing an obsolete token", async () => {
  const io = new IO(), store = new BoardDraftStore(io), other = new BoardDraftStore(io), document = createBoardDocument("QA/two.md", "markdown");
  const bundle = { document, ink: {} }; await store.capture("Agent Memory", bundle, document, null, []);
  await other.read("Agent Memory", document.sourceFile, "markdown");
  const newer = { ...document, revision: document.revision + 1, title: "First writer" };
  await store.capture("Agent Memory", { document: newer, ink: {} }, document, null, []);
  await expect(other.capture("Agent Memory", { document: { ...newer, title: "Other" }, ink: {} }, document, null, [])).rejects.toThrow("board-draft-conflict");
});
it("draft contention must not fall through to an authority write from an uninformed repository", async () => {
  const f = await fixture(), other = f.reopen(), otherBundle = await other.open(f.bundle.document.sourceFile, "standalone");
  f.vault.failPath = f.path; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow(); f.vault.failPath = "";
  otherBundle.document.revision++; otherBundle.document.title = "Uninformed writer";
  await expect(other.save(otherBundle.document, otherBundle.ink)).rejects.toThrow("board-draft-conflict");
  expect(await f.vault.read(f.path)).toBe(f.saved);
  expect((await f.store.read(f.root, f.bundle.document.sourceFile, "standalone"))?.bundle.document.objects).toHaveLength(1);
});
it("a corrupt current record recovers only the verified prior draft; unknown versions are never downgraded", async () => {
  const io = new IO(), store = new BoardDraftStore(io), document = createBoardDocument("QA/prior.md", "markdown"), bundle = { document, ink: {} };
  const ticket = await store.capture("Agent Memory", bundle, document, null, []);
  await store.capture("Agent Memory", { document: { ...document, revision: document.revision + 1 }, ink: {} }, document, null, []);
  io.files.set(ticket.path, "{interrupted");
  expect((await new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown"))?.bundle.document.revision).toBe(document.revision);
  io.files.set(ticket.path, JSON.stringify({ format: "tutor-board-draft-v99" }));
  await expect(new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).rejects.toThrow("board-draft-unsupported");
});
it("repairs a damaged current WAL before backing up new recovered edits and preserves the damaged bytes", async () => {
  const f = await fixture(); f.vault.failPath = f.path;
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow();
  f.bundle.document.objects[0]!.x += 10; f.bundle.document.revision++;
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toThrow();
  const path = await f.store.path(f.root, f.bundle.document.sourceFile, "standalone"), previous = f.io.files.get(path + ".previous")!;
  f.io.files.set(path, "{interrupted");
  const repo = f.reopen(), recovered = await repo.open(f.bundle.document.sourceFile, "standalone");
  expect(recovered.document.objects[0]?.x).toBe(20);
  expect(f.io.files.get(path)).toBe(previous);
  expect([...f.io.files].some(([name, raw]) => name.startsWith(path + ".damaged-") && raw === "{interrupted")).toBe(true);
  recovered.document.objects[0]!.x += 25; recovered.document.revision++;
  await expect(repo.save(recovered.document, recovered.ink)).rejects.toThrow("primary disk error");
  expect((await f.reopen().open(f.bundle.document.sourceFile, "standalone")).document.objects[0]?.x).toBe(45);
  expect(f.io.files.get(path + ".previous")).toBe(previous);
});
it("a repair cannot overwrite an external current WAL update after verifying the previous record", async () => {
  const io = new IO(), store = new BoardDraftStore(io), document = createBoardDocument("QA/repair-race.md", "markdown");
  const first = await store.capture("Agent Memory", { document, ink: {} }, document, null, []);
  await store.capture("Agent Memory", { document: { ...document, revision: 1 }, ink: {} }, document, null, []);
  const external = io.files.get(first.path)!; io.files.set(first.path, "{interrupted");
  const compareWrite = io.compareWrite.bind(io);
  io.compareWrite = async (path, before, after) => {
    if (path.startsWith(first.path + ".damaged-")) io.files.set(first.path, external);
    return compareWrite(path, before, after);
  };
  await expect(new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).rejects.toThrow("state-file-conflict");
  expect(io.files.get(first.path)).toBe(external);
  expect((await new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown"))?.bundle.document.revision).toBe(1);
});
it("a failed damaged-byte backup cannot repair or erase the only current WAL", async () => {
  const io = new IO(), store = new BoardDraftStore(io), document = createBoardDocument("QA/repair-backup.md", "markdown");
  const first = await store.capture("Agent Memory", { document, ink: {} }, document, null, []);
  await store.capture("Agent Memory", { document: { ...document, revision: 1 }, ink: {} }, document, null, []);
  const previous = io.files.get(first.path + ".previous"); io.files.set(first.path, "{interrupted"); io.fail = true;
  await expect(new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).rejects.toThrow("backup disk error");
  expect(io.files.get(first.path)).toBe("{interrupted"); expect(io.files.get(first.path + ".previous")).toBe(previous);
});
it("limits preserved damaged WAL copies without overwriting earlier failure evidence", async () => {
  const io = new IO(), document = createBoardDocument("QA/repair-limit.md", "markdown"), store = new BoardDraftStore(io);
  const first = await store.capture("Agent Memory", { document, ink: {} }, document, null, []);
  await store.capture("Agent Memory", { document: { ...document, revision: 1 }, ink: {} }, document, null, []);
  for (let i = 0; i < 3; i++) { io.files.set(first.path, `{broken-${i}`); await new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown"); }
  const before = new Map(io.files); io.files.set(first.path, "{broken-over-limit");
  await expect(new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).rejects.toThrow("board-draft-repair-limit");
  for (const [path, raw] of before) if (path !== first.path) expect(io.files.get(path)).toBe(raw);
  expect(io.files.get(first.path)).toBe("{broken-over-limit");
});
it("rechecks the verified prior WAL before restoring it over a damaged current record", async () => {
  const io = new IO(), store = new BoardDraftStore(io), document = createBoardDocument("QA/repair-prior-race.md", "markdown");
  const first = await store.capture("Agent Memory", { document, ink: {} }, document, null, []);
  await store.capture("Agent Memory", { document: { ...document, revision: 1 }, ink: {} }, document, null, []);
  const replacement = io.files.get(first.path)!; io.files.set(first.path, "{interrupted");
  const compareWrite = io.compareWrite.bind(io);
  io.compareWrite = async (path, before, after) => {
    if (path.startsWith(first.path + ".damaged-")) io.files.set(first.path + ".previous", replacement);
    return compareWrite(path, before, after);
  };
  await expect(new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).rejects.toThrow("state-file-conflict");
  expect(io.files.get(first.path)).toBe("{interrupted"); expect(io.files.get(first.path + ".previous")).toBe(replacement);
});
it("does not announce a repaired WAL when atomic replacement fails after preserving the damaged bytes", async () => {
  const io = new IO(), store = new BoardDraftStore(io), document = createBoardDocument("QA/repair-write-failure.md", "markdown");
  const first = await store.capture("Agent Memory", { document, ink: {} }, document, null, []);
  await store.capture("Agent Memory", { document: { ...document, revision: 1 }, ink: {} }, document, null, []);
  io.files.set(first.path, "{interrupted"); const compareWrite = io.compareWrite.bind(io);
  io.compareWrite = async (path, before, after) => {
    if (path === first.path) throw new Error("state-save-not-confirmed");
    return compareWrite(path, before, after);
  };
  await expect(new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).rejects.toThrow("state-save-not-confirmed");
  expect(io.files.get(first.path)).toBe("{interrupted"); expect(io.files.get(first.path + ".damaged-1")).toBe("{interrupted");
});
it("repairs only a verified previous record and does not revive a resolved checkpoint", async () => {
  const io = new IO(), store = new BoardDraftStore(io), document = createBoardDocument("QA/repair-resolved.md", "markdown");
  await store.capture("Agent Memory", { document, ink: {} }, document, null, []);
  const ticket = await store.capture("Agent Memory", { document: { ...document, revision: 1 }, ink: {} }, document, null, []); await store.resolve(ticket);
  io.files.set(ticket.path, "{interrupted");
  expect(await new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).toBeNull();
  expect(JSON.parse(io.files.get(ticket.path)!).pending).toBeNull();
  io.files.set(ticket.path, "{broken-again"); io.files.set(ticket.path + ".previous", "{also-broken"); const before = new Map(io.files);
  await expect(new BoardDraftStore(io).read("Agent Memory", document.sourceFile, "markdown")).rejects.toThrow("board-draft-invalid");
  expect(io.files).toEqual(before);
});
it("unknown/corrupt target records never reset and do not block another target/root", async () => {
  const io = new IO(), store = new BoardDraftStore(io); const path = await store.path("Agent Memory", "QA/bad.md", "markdown"); io.files.set(path, "{broken");
  await expect(store.read("Agent Memory", "QA/bad.md", "markdown")).rejects.toThrow(); expect(io.files.get(path)).toBe("{broken");
  expect(await store.read("Other Memory", "QA/bad.md", "markdown")).toBeNull();
  expect(await store.read("Agent Memory", "QA/good.md", "markdown")).toBeNull();
});
it("rejects traversal or an unrelated authoritative file as an asset", async () => {
  const io = new IO(), store = new BoardDraftStore(io), document = createBoardDocument("QA/safe.md", "markdown");
  await expect(store.capture("Agent Memory", { document, ink: {} }, document, null, [await boardDraftFile("Agent Memory/boards/attack.board.json", "{}")])).rejects.toThrow("board-draft-asset-path");
  await expect(store.path("../other", "QA/safe.md", "markdown")).rejects.toThrow();
});
