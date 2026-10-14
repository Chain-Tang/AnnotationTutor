import { expect, it } from "vitest";
import { BoardConflictError, BoardRepository, type BoardStorageAdapter } from "../src/board-store.js";
import { BoardDraftStore, type BoardDraftIO } from "../src/board-draft.js";
import { upgradeBoardDocument } from "../src/board-model.js";
import type { BoardBundle, BoardObject } from "../src/board-types.js";

class Vault implements BoardStorageAdapter {
  files = new Map<string, string>(); folders = new Set<string>(); writes: string[] = []; reads: string[] = [];
  beforeWrite?: (path: string, value: string) => Promise<void>;
  afterWrite?: (path: string, value: string) => Promise<void>;
  beforeProcess?: (path: string) => Promise<void>;
  beforeExists?: (path: string) => Promise<void>;
  async exists(path: string) { await this.beforeExists?.(path); return this.files.has(path) || this.folders.has(path); }
  async read(path: string) { this.reads.push(path); const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, value: string) {
    await this.beforeWrite?.(path, value); this.files.set(path, value); this.writes.push(path); await this.afterWrite?.(path, value);
  }
  async process(path: string, update: (current: string) => string) {
    await this.beforeProcess?.(path); const value = update(await this.read(path)); this.files.set(path, value); await this.afterWrite?.(path, value); return value;
  }
  async mkdir(path: string) { this.folders.add(path); }
  async list(path: string) { return { files: [...this.files.keys()].filter(file => file.startsWith(path + "/") && !file.slice(path.length + 1).includes("/")), folders: [] }; }
}
class Journal implements BoardDraftIO {
  files = new Map<string, string>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async compareWrite(path: string, before: string | null, after: string) {
    if (await this.read(path) !== before) throw new Error("state-file-conflict"); this.files.set(path, after);
  }
}
const root = "Agent Memory", source = "QA/concurrent.tutorboard";
function add(bundle: BoardBundle, id: string) {
  bundle.ink[id] = { id, createdAt: "2026-10-10T00:00:00Z", points: [{ x: 0, y: 0, pressure: 0.2 }, { x: 30, y: 20, pressure: 0.8 }] };
  const object: BoardObject = { id: `OBJ-${id}`, kind: "ink", anchor: { kind: "canvas", pageId: "artboard-main" }, x: 20, y: 30,
    width: 30, height: 20, color: "#446677", strokeWidth: 2, inkId: id, createdBy: "human", editedBy: "human", revision: 1, groupId: `GROUP-${id}` };
  bundle.document.objects.push(object); bundle.document.revision++;
}
async function fixture() {
  const vault = new Vault(), journal = new Journal(), store = new BoardDraftStore(journal), repo = new BoardRepository(vault, root, store);
  const local = await repo.open(source, "standalone");
  while (local.document.schemaVersion < 5) local.document = upgradeBoardDocument(local.document);
  add(local, "INK-original"); await repo.save(local.document, local.ink);
  const externalRepo = new BoardRepository(vault, root), external = await externalRepo.open(source, "standalone");
  return { vault, journal, store, repo, local, externalRepo, external, path: repo.boardPath(local.document.id) };
}
for (const boundary of ["before-pack", "after-pack", "manifest-cas"] as const) {
  it(`preserves both ink branches when an external commit arrives at ${boundary}`, async () => {
    const f = await fixture(); add(f.local, "INK-local"); add(f.external, "INK-external");
    const originalPacks = new Map([...f.vault.files].filter(([path]) => path.includes("/ink-packs/") && path.endsWith(".inkpack.json")));
    let authority = "", externalPacks = new Map<string, string>(), fired = false;
    const commit = async () => {
      if (fired) return; fired = true;
      await f.externalRepo.save(f.external.document, f.external.ink);
      authority = await f.vault.read(f.path);
      externalPacks = new Map(f.external.document.inkManifest!.packs.map(pack => {
        const path = f.repo.inkPackPath(f.external.document.id, pack.id); return [path, f.vault.files.get(path)!];
      }));
    };
    const packHook = async (path: string, value: string) => {
      if (path.includes("/ink-packs/") && value.includes('"INK-local"')) await commit();
    };
    if (boundary === "before-pack") f.vault.beforeWrite = async path => { if (path.endsWith("/INK-local.ink.json")) await commit(); };
    if (boundary === "after-pack") f.vault.afterWrite = packHook;
    if (boundary === "manifest-cas") f.vault.beforeProcess = async path => { if (path === f.path) await commit(); };
    await expect(f.repo.save(f.local.document, f.local.ink)).rejects.toBeInstanceOf(BoardConflictError);
    expect(fired).toBe(true); expect(await f.vault.read(f.path)).toBe(authority);
    for (const [path, bytes] of originalPacks) expect(await f.vault.read(path)).toBe(bytes);
    for (const [path, bytes] of externalPacks) expect(await f.vault.read(path)).toBe(bytes);
    const reopened = await new BoardRepository(f.vault, root).open(source, "standalone");
    expect(reopened.document.objects.map(object => object.inkId)).toEqual(["INK-original", "INK-external"]);
    expect(reopened.ink).toEqual(f.external.ink);
    const forkPath = [...f.vault.files.keys()].find(path => path.includes(".conflict-") && path.endsWith(".board.json"))!;
    const fork = JSON.parse(await f.vault.read(forkPath));
    const forkInk = Object.assign({}, ...fork.inkManifest.packs.map((pack: { id: string }) => JSON.parse(f.vault.files.get(f.repo.inkPackPath(fork.id, pack.id))!).strokes));
    expect(fork.objects.map((object: BoardObject) => object.inkId)).toEqual(["INK-original", "INK-local"]); expect(forkInk).toEqual(f.local.ink);
    const recovery = await new BoardRepository(f.vault, root, new BoardDraftStore(f.journal)).open(source, "standalone");
    expect(recovery.recovery?.conflicted).toBe(true); expect(recovery.ink).toEqual(f.local.ink);
  });
}
it("keeps a prior board readable when a later packed-ink publication is interrupted", async () => {
  const f = await fixture(), primary = await f.vault.read(f.path), oldManifest = structuredClone(f.local.document.inkManifest!);
  add(f.local, "INK-local"); f.vault.beforeProcess = async path => { if (path === f.path) throw new Error("disk error"); };
  await expect(f.repo.save(f.local.document, f.local.ink)).rejects.toThrow("disk error");
  expect(await f.vault.read(f.path)).toBe(primary);
  for (const pack of oldManifest.packs) expect(Object.keys(JSON.parse(await f.vault.read(f.repo.inkPackPath(f.local.document.id, pack.id))).strokes)).toEqual(["INK-original"]);
  const reopened = await new BoardRepository(f.vault, root).open(source, "standalone"); expect(Object.keys(reopened.ink)).toEqual(["INK-original"]);
});
it("does not acknowledge a stale preview when its identical scene changes during asset checks", async () => {
  const f = await fixture(); add(f.external, "INK-external"); let fired = false, authority = "";
  f.vault.beforeExists = async path => {
    if (path !== `${root}/ink` || fired) return; fired = true;
    await f.externalRepo.save(f.external.document, f.external.ink); authority = await f.vault.read(f.path);
  };
  await expect(f.repo.save(f.local.document, f.local.ink, "<svg>stale</svg>")).rejects.toBeInstanceOf(BoardConflictError);
  expect(fired).toBe(true); expect(await f.vault.read(f.path)).toBe(authority);
  expect(f.vault.files.get(f.path.replace(/\.board\.json$/, ".svg"))).not.toBe("<svg>stale</svg>");
});
it("normalizes stale history metadata across queued saves and same-revision preview retries", async () => {
  const f = await fixture(), stale = structuredClone(f.local.document.inkManifest);
  add(f.local, "INK-one"); const first = structuredClone(f.local);
  const saving = f.repo.save(first.document, first.ink);
  add(f.local, "INK-two"); const second = structuredClone(f.local);
  const savingNext = f.repo.save(second.document, second.ink); await saving; await savingNext;
  const committed = await f.vault.read(f.path), packPaths = [...f.vault.files.keys()].filter(path => path.includes("/ink-packs/"));
  const retry = { ...second.document, inkManifest: stale }; f.vault.writes.length = 0; f.vault.reads.length = 0;
  await f.repo.save(retry, second.ink, "<svg/>");
  expect(await f.vault.read(f.path)).toBe(committed);
  expect(f.vault.writes.some(path => path.includes("/ink-packs/"))).toBe(false);
  expect(f.vault.reads.some(path => path.includes("/ink-packs/"))).toBe(false);
  expect([...f.vault.files.keys()].filter(path => path.includes("/ink-packs/"))).toEqual(packPaths);
  const restored = await new BoardRepository(f.vault, root, new BoardDraftStore(f.journal)).open(source, "standalone");
  expect(restored.recovery).toBeUndefined(); expect(restored.ink).toEqual(second.ink);
});
it("changes pack identity after removing ink while preserving the previous revision's bytes", async () => {
  const f = await fixture(); add(f.local, "INK-two"); await f.repo.save(f.local.document, f.local.ink);
  const before = structuredClone(f.local.document), bytes = new Map(before.inkManifest!.packs.map(pack => {
    const path = f.repo.inkPackPath(before.id, pack.id); return [path, f.vault.files.get(path)!];
  }));
  f.local.document.objects = f.local.document.objects.filter(object => object.inkId !== "INK-two"); delete f.local.ink["INK-two"]; f.local.document.revision++;
  await f.repo.save(f.local.document, f.local.ink);
  for (const [path, value] of bytes) expect(await f.vault.read(path)).toBe(value);
  expect(f.local.document.inkManifest!.packs[0]!.pointCount).toBe(2);
  const restored = await new BoardRepository(f.vault, root).open(source, "standalone"); expect(Object.keys(restored.ink)).toEqual(["INK-original"]);
});
it("keeps an old mutable pack intact and lazily allocates a new immutable identity for changed membership", async () => {
  const f = await fixture(), legacyId = "PACK-000001", raw = JSON.parse(await f.vault.read(f.path));
  const pack = raw.inkManifest.packs[0], oldPath = f.repo.inkPackPath(raw.id, pack.id), legacyPath = f.repo.inkPackPath(raw.id, legacyId);
  const legacyBytes = JSON.stringify({ ...JSON.parse(await f.vault.read(oldPath)), packId: legacyId });
  f.vault.files.set(legacyPath, legacyBytes); pack.id = legacyId; f.vault.files.set(f.path, JSON.stringify(raw));
  const repo = new BoardRepository(f.vault, root), bundle = await repo.open(source, "standalone");
  await repo.save(bundle.document, bundle.ink); expect(bundle.document.inkManifest!.packs[0]!.id).toBe(legacyId);
  add(bundle, "INK-next"); await repo.save(bundle.document, bundle.ink);
  expect(bundle.document.inkManifest!.packs[0]!.id).not.toBe(legacyId); expect(await f.vault.read(legacyPath)).toBe(legacyBytes);
  expect((await new BoardRepository(f.vault, root).open(source, "standalone")).ink).toEqual(bundle.ink);
});
it("freezes the journal's pack identities before publication and acknowledges the same committed bundle", async () => {
  const f = await fixture(); add(f.local, "INK-new"); let captured: BoardBundle | undefined;
  f.vault.beforeWrite = async path => {
    if (path.includes("/ink-packs/")) captured = structuredClone((await f.store.read(root, source, "standalone"))?.bundle);
  };
  await f.repo.save(f.local.document, f.local.ink);
  expect(captured?.document.inkManifest).toEqual(JSON.parse(await f.vault.read(f.path)).inkManifest);
  expect(await f.store.read(root, source, "standalone")).toBeNull();
  expect((await new BoardRepository(f.vault, root, new BoardDraftStore(f.journal)).open(source, "standalone")).recovery).toBeUndefined();
});
