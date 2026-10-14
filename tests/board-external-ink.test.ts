import { expect, it } from "vitest";
import { BoardRepository, BoardConflictError, type BoardStorageAdapter } from "../src/board-store.js";
import { BoardDraftStore, type BoardDraftIO } from "../src/board-draft.js";
import { upgradeBoardDocument } from "../src/board-model.js";
import type { BoardObject } from "../src/board-types.js";
class Vault implements BoardStorageAdapter {
  files = new Map<string, string>(); folders = new Set<string>(); reads: string[] = [];
  async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
  async read(path: string) { this.reads.push(path); const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, value: string) { this.files.set(path, value); }
  async mkdir(path: string) { this.folders.add(path); }
  async list(path: string) { return { files: [...this.files.keys()].filter(file => file.startsWith(path + "/") && !file.slice(path.length + 1).includes("/")), folders: [] }; }
}
class IO implements BoardDraftIO {
  files = new Map<string, string>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async compareWrite(path: string, before: string | null, after: string) { if (await this.read(path) !== before) throw new Error("state-file-conflict"); this.files.set(path, after); }
}
const root = "Agent Memory", inkId = "INK-original";
const stroke = { id: inkId, createdAt: "2026-10-10T00:00:00Z", points: [{ x: 0, y: 0, pressure: 0.2 }, { x: 60, y: 30, pressure: 0.9 }] };
const object: BoardObject = { id: "OBJ-original", kind: "ink", anchor: { kind: "markdown", key: "p", quote: "Original" }, x: 20, y: 30,
  width: 60, height: 30, color: "#446677", strokeWidth: 2, inkId, createdBy: "human", editedBy: "human", revision: 1, groupId: "GROUP-original" };
async function fixture() {
  const vault = new Vault(), io = new IO(), store = new BoardDraftStore(io), repo = new BoardRepository(vault, root, store);
  const bundle = await repo.open("QA/external-ink.md", "markdown");
  while (bundle.document.schemaVersion < 5) bundle.document = upgradeBoardDocument(bundle.document);
  bundle.document.objects.push(structuredClone(object)); bundle.ink[inkId] = structuredClone(stroke); bundle.document.revision++;
  await repo.save(bundle.document, bundle.ink);
  return { vault, io, store, repo, bundle, path: repo.boardPath(bundle.document.id), packPath: repo.inkPackPath(bundle.document.id, bundle.document.inkManifest!.packs[0]!.id), inkPath: repo.inkPath(inkId) };
}
for (const kind of ["raw", "deleted-raw", "pack", "corrupt-pack", "deleted-pack"] as const) {
  it(`a notified ${kind} change preserves authority bytes and the original ink branch`, async () => {
    const f = await fixture(), path = kind === "raw" || kind === "deleted-raw" ? f.inkPath : f.packPath, authority = await f.vault.read(f.path);
    if (kind === "deleted-pack" || kind === "deleted-raw") f.vault.files.delete(path);
    else if (kind === "corrupt-pack") f.vault.files.set(path, "{broken");
    else {
      const value = JSON.parse(await f.vault.read(path)), target = kind === "raw" ? value : value.strokes[inkId]; target.points[0].x = 999;
      f.vault.files.set(path, JSON.stringify(value));
    }
    const external = f.vault.files.get(path); expect(await f.repo.onExternalChange(path)).toMatchObject({ boardId: f.bundle.document.id, stale: true });
    f.bundle.document.revision++; f.bundle.document.objects[0]!.x += 10;
    await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toBeInstanceOf(BoardConflictError);
    expect(await f.vault.read(f.path)).toBe(authority); expect(f.vault.files.get(path)).toBe(external);
    const forkPath = [...f.vault.files.keys()].find(path => path.includes(".conflict-") && path.endsWith(".board.json"))!, fork = JSON.parse(await f.vault.read(forkPath));
    expect(fork.objects[0].id).toBe(object.id); expect(fork.objects[0].x).toBe(30);
    expect(JSON.parse(await f.vault.read(f.repo.inkPackPath(fork.id, fork.inkManifest.packs[0].id))).strokes[inkId]).toEqual(stroke);
    const recoveryRepo = new BoardRepository(f.vault, root, new BoardDraftStore(f.io)), recovered = await recoveryRepo.open(f.bundle.document.sourceFile, "markdown");
    expect(recovered.recovery?.conflicted).toBe(true); expect(recovered.ink).toEqual(f.bundle.ink);
    recovered.document.objects[0]!.x += 3; recovered.document.revision++;
    await expect(recoveryRepo.save(recovered.document, recovered.ink)).rejects.toBeInstanceOf(BoardConflictError);
    expect(f.vault.files.get(path)).toBe(external);
    expect((await new BoardRepository(f.vault, root, new BoardDraftStore(f.io)).open(f.bundle.document.sourceFile, "markdown")).document.objects[0]?.x).toBe(33);
  });
}
it("marks every open board referencing the changed raw ink without widening unrelated targets", async () => {
  const f = await fixture(), second = await f.repo.open("QA/shared.md", "markdown"), unrelated = await f.repo.open("QA/unrelated.md", "markdown");
  second.document.objects.push(structuredClone(object)); second.document.revision++; await f.repo.save(second.document, f.bundle.ink);
  await f.repo.save(unrelated.document, unrelated.ink);
  f.vault.files.set(f.inkPath, JSON.stringify({ ...stroke, points: [{ x: 123, y: 456 }] }));
  const event = await f.repo.onExternalChange(f.inkPath);
  expect(event).toMatchObject({ affectedBoardIds: [f.bundle.document.id, second.document.id] });
  for (const bundle of [f.bundle, { ...second, ink: f.bundle.ink }]) {
    bundle.document.revision++; await expect(f.repo.save(bundle.document, bundle.ink)).rejects.toBeInstanceOf(BoardConflictError);
  }
  unrelated.document.revision++; await expect(f.repo.save(unrelated.document, unrelated.ink)).resolves.toBeUndefined();
});
it("rechecks a notified asset before saving so restoring the exact original clears only that asset conflict", async () => {
  const f = await fixture(), original = await f.vault.read(f.packPath);
  f.vault.files.set(f.packPath, "{broken"); await f.repo.onExternalChange(f.packPath); f.vault.files.set(f.packPath, original);
  f.bundle.document.revision++; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).resolves.toBeUndefined();
  expect([...f.vault.files.keys()].some(path => path.includes(".conflict-"))).toBe(false);
});
it("does not treat reordered samples or unrelated retired packs as current-board modifications", async () => {
  const f = await fixture(), value = JSON.parse(await f.vault.read(f.packPath));
  value.strokes[inkId] = { createdAt: stroke.createdAt, points: stroke.points.map(point => ({ pressure: point.pressure, y: point.y, x: point.x })), id: inkId };
  f.vault.files.set(f.packPath, JSON.stringify(value)); expect(await f.repo.onExternalChange(f.packPath)).toBeNull();
  const retired = f.repo.inkPackPath(f.bundle.document.id, "PACK-retired"); f.vault.files.set(retired, "{broken"); expect(await f.repo.onExternalChange(retired)).toBeNull();
  f.vault.reads.length = 0; f.bundle.document.revision++; await f.repo.save(f.bundle.document, f.bundle.ink);
  expect(f.vault.reads.some(path => path.includes("/ink/") || path.includes("/ink-packs/"))).toBe(false);
});
it("a recovered old draft recognizes changed shared ink even when only the pack changed", async () => {
  const f = await fixture(); f.bundle.document.objects[0]!.x += 10; f.bundle.document.revision++;
  await f.store.capture(root, f.bundle, JSON.parse(await f.vault.read(f.path)), await f.vault.read(f.path), []);
  const value = JSON.parse(await f.vault.read(f.packPath)); value.strokes[inkId].points[0].pressure = 0.8; f.vault.files.set(f.packPath, JSON.stringify(value));
  const recovered = await new BoardRepository(f.vault, root, new BoardDraftStore(f.io)).open(f.bundle.document.sourceFile, "markdown");
  expect(recovered.recovery?.conflicted).toBe(true); expect(recovered.ink[inkId]).toEqual(stroke);
});
it("does not clear an unchanged-scene checkpoint merely because the cached board resembles the failed save", async () => {
  const f = await fixture(), original = await f.vault.read(f.inkPath);
  f.vault.files.set(f.inkPath, JSON.stringify({ ...stroke, points: [{ x: 987, y: 654 }] })); await f.repo.onExternalChange(f.inkPath);
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toBeInstanceOf(BoardConflictError);
  expect((await f.store.read(root, f.bundle.document.sourceFile, "markdown"))?.assetConflicts).toEqual([f.inkPath]);
  const conflicted = await new BoardRepository(f.vault, root, new BoardDraftStore(f.io)).open(f.bundle.document.sourceFile, "markdown");
  expect(conflicted.recovery?.conflicted).toBe(true); expect(conflicted.ink).toEqual(f.bundle.ink);
  f.vault.files.set(f.inkPath, original);
  const resolved = await new BoardRepository(f.vault, root, new BoardDraftStore(f.io)).open(f.bundle.document.sourceFile, "markdown");
  expect(resolved.recovery).toBeUndefined(); expect(await f.store.read(root, f.bundle.document.sourceFile, "markdown")).toBeNull();
});
it("conflict observation paths cannot read or overwrite unrelated private files", async () => {
  const f = await fixture(), before = new Map(f.io.files);
  await expect(f.store.capture(root, f.bundle, f.bundle.document, await f.vault.read(f.path), [], { assetConflicts: ["../private/credentials.json"] })).rejects.toThrow("board-draft-asset-path");
  expect(f.io.files).toEqual(before);
});
it("restoring one changed asset does not clear a different unresolved pack conflict", async () => {
  const f = await fixture(), raw = await f.vault.read(f.inkPath);
  f.vault.files.set(f.inkPath, "{changed"); f.vault.files.set(f.packPath, "{changed");
  await f.repo.onExternalChange(f.inkPath); await f.repo.onExternalChange(f.packPath);
  f.vault.files.set(f.inkPath, raw); expect(await f.repo.onExternalChange(f.inkPath)).toBeNull();
  await expect(f.repo.save(f.bundle.document, f.bundle.ink)).rejects.toBeInstanceOf(BoardConflictError);
  expect((await f.store.read(root, f.bundle.document.sourceFile, "markdown"))?.assetConflicts).toEqual([f.packPath]);
});
it("does not consider inherited Object keys to be references to another board's ink", async () => {
  const f = await fixture(), path = `${root}/ink/constructor.ink.json`;
  f.vault.files.set(path, "{unrelated"); expect(await f.repo.onExternalChange(path)).toBeNull();
  f.bundle.document.revision++; await expect(f.repo.save(f.bundle.document, f.bundle.ink)).resolves.toBeUndefined();
});
it("a verified recovery can recreate a missing legacy ink mirror that has no outstanding external notification", async () => {
  const f = await fixture(); f.bundle.document.objects[0]!.x += 10; f.bundle.document.revision++;
  await f.store.capture(root, f.bundle, JSON.parse(await f.vault.read(f.path)), await f.vault.read(f.path), []);
  f.vault.files.delete(f.inkPath);
  const repo = new BoardRepository(f.vault, root, new BoardDraftStore(f.io)), recovered = await repo.open(f.bundle.document.sourceFile, "markdown");
  await repo.save(recovered.document, recovered.ink);
  expect(JSON.parse(await f.vault.read(f.inkPath))).toEqual(stroke);
});
for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
  it(`saves and recovers the legal own ink ID ${id} without confusing it with an inherited key`, async () => {
    const vault = new Vault(), io = new IO(), store = new BoardDraftStore(io), repo = new BoardRepository(vault, root, store);
    const bundle = await repo.open(`QA/${id}.md`, "markdown");
    while (bundle.document.schemaVersion < 5) bundle.document = upgradeBoardDocument(bundle.document);
    const own = { ...structuredClone(stroke), id };
    bundle.ink[id] = own; bundle.document.objects.push({ ...structuredClone(object), inkId: id }); bundle.document.revision++;
    await repo.save(bundle.document, bundle.ink);
    expect(JSON.parse(await vault.read(repo.inkPath(id)))).toEqual(own);
    const reopened = await new BoardRepository(vault, root).open(bundle.document.sourceFile, "markdown");
    expect(Object.hasOwn(reopened.ink, id)).toBe(true); expect(reopened.ink[id]).toEqual(own);
    bundle.document.objects[0]!.x += 10; bundle.document.revision++;
    await store.capture(root, bundle, reopened.document, await vault.read(repo.boardPath(bundle.document.id)), []);
    vault.files.delete(repo.inkPath(id));
    const recovery = new BoardRepository(vault, root, new BoardDraftStore(io)), recovered = await recovery.open(bundle.document.sourceFile, "markdown");
    await recovery.save(recovered.document, recovered.ink);
    expect(JSON.parse(await vault.read(repo.inkPath(id)))).toEqual(own);
    expect((await new BoardRepository(vault, root).open(bundle.document.sourceFile, "markdown")).document.objects[0]?.x).toBe(30);
  });
}
it("reports a missing own packed stroke rather than reading an inherited constructor as ink", async () => {
  const f = await fixture(), manifest = JSON.parse(await f.vault.read(f.path));
  manifest.objects[0].inkId = "constructor"; manifest.inkManifest.packs[0].strokeIds = ["constructor"];
  f.vault.files.set(f.path, JSON.stringify(manifest));
  const packed = JSON.parse(await f.vault.read(f.packPath)); packed.strokes = {}; f.vault.files.set(f.packPath, JSON.stringify(packed));
  f.vault.files.delete(f.path.replace(".board.json", ".previous.board.json"));
  await expect(new BoardRepository(f.vault, root).open(f.bundle.document.sourceFile, "markdown")).rejects.toThrow("Missing immutable ink: constructor");
});
