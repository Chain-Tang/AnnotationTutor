import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AnnotationTutorLiteSettings } from "../src/settings.js";
import type { Annotation, MemoryCell, Scene } from "../src/model.js";
import { createMockApp, TFile } from "./helpers/obsidian-mock.js";
import { serializeMemoryCell } from "../src/markdown/memory-cell-file.js";
import { serializeScene, parseSceneFile } from "../src/markdown/scene-file.js";
import { serializeAnnotation } from "../src/markdown/annotation-file.js";

vi.mock("obsidian", () => import("./helpers/obsidian-mock.js"));
const { VaultStore } = await import("../src/store.js");
const NOW = "2026-10-14T00:00:00.000Z";
const CELL_DIR = "Agent Memory/memory-cells";
const SCENE_PATH = "Agent Memory/scenes/SCENE-Attention.md";
const cell = (id: string, concept = "Attention"): MemoryCell => ({
  id, type: "understanding", concept, status: "stable", summary: "Understands the concept.",
  sourceAnnotations: ["ANN-1"], tags: [], confidence: 0.9, createdAt: NOW, updatedAt: NOW
});
const manualScene = (): Scene => ({
  id: "SCENE-Attention", type: "topic", title: "Attention", status: "active",
  summary: "The learner's own synthesis.", cells: ["CELL-1", "CELL-2"], tags: [], createdAt: NOW, updatedAt: NOW
});
function fixture() {
  const app = createMockApp();
  const settings = { memoryRoot: "Agent Memory", createAgentInstructions: true } as AnnotationTutorLiteSettings;
  const store = new VaultStore(app as unknown as App, "annotation-tutor-lite", () => settings);
  return { store, vault: app.vault, settings };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function seed() {
  const f = fixture();
  await f.store.createMemoryCell(cell("CELL-1"));
  await f.store.createMemoryCell(cell("CELL-2"));
  await f.store.syncScenesFromCells();
  await f.store.refreshLibrary();
  return f;
}
afterEach(() => vi.restoreAllMocks());

describe("incremental cells-to-scenes reconciliation", () => {
  // Allow coverage/runner overhead for setup; the I/O counts define this regression.
  it("reads one changed cell and one generated scene across sync + index refresh in a 1,500-file library", async () => {
    const { store, vault } = fixture();
    for (let i = 0; i < 1000; i++) await vault.create(`${CELL_DIR}/CELL-${i}.md`, serializeMemoryCell(cell(`CELL-${i}`, `Concept ${Math.floor(i / 2)}`)));
    await store.syncScenesFromCells();
    await store.rebuildLibrary();
    const read = vi.spyOn(vault, "read"), process = vi.spyOn(vault, "process"), modify = vi.spyOn(vault, "modify"), create = vi.spyOn(vault, "create");
    const cacheWrite = vi.spyOn(vault.adapter, "write");
    await store.syncScenesFromCells();
    await store.refreshLibrary();
    expect(read).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(cacheWrite).not.toHaveBeenCalled();
    await store.createMemoryCell(cell("CELL-new", "Concept 0"));
    await store.syncScenesFromCells();
    expect(read.mock.calls.map(([file]) => file.path)).toEqual([`${CELL_DIR}/CELL-new.md`]);
    expect(process).toHaveBeenCalledTimes(1);
    const snapshot = await store.refreshLibrary();
    expect(read.mock.calls.map(([file]) => file.path)).toEqual([`${CELL_DIR}/CELL-new.md`, "Agent Memory/scenes/SCENE-Concept-0.md"]);
    expect(snapshot.cells).toHaveLength(1001);
    expect(snapshot.scenes).toHaveLength(500);
    expect(snapshot.scenes.find(scene => scene.id === "SCENE-Concept-0")?.cells).toEqual(["CELL-0", "CELL-1", "CELL-new"]);
    expect(modify.mock.calls.map(([file]) => file.path).sort()).toEqual([store.overviewPath(), store.cellIndexPath()].sort());
    expect(cacheWrite).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("handles immediately invalidated external cell edits, additions and deletions before UI refresh", async () => {
    const { store, vault } = await seed();
    await vault.modify(new TFile(`${CELL_DIR}/CELL-2.md`), serializeMemoryCell(cell("CELL-2", "Projection")));
    store.invalidateLibrary([`${CELL_DIR}/CELL-2.md`]);
    await store.syncScenesFromCells();
    expect(vault.files.has(SCENE_PATH)).toBe(false);
    await vault.create(`${CELL_DIR}/CELL-3.md`, serializeMemoryCell(cell("CELL-3", "Projection")));
    store.invalidateLibrary([`${CELL_DIR}/CELL-3.md`]);
    await store.syncScenesFromCells();
    expect(parseSceneFile(vault.files.get("Agent Memory/scenes/SCENE-Projection.md")!)?.cells).toEqual(["CELL-2", "CELL-3"]);
    await vault.delete(new TFile(`${CELL_DIR}/CELL-3.md`));
    store.invalidateLibrary([`${CELL_DIR}/CELL-3.md`]);
    await store.syncScenesFromCells();
    expect(vault.files.has("Agent Memory/scenes/SCENE-Projection.md")).toBe(false);
  });

  it("preserves hand-authored and malformed scene files at a generated scene's target path", async () => {
    const { store, vault } = fixture();
    await store.createMemoryCell(cell("CELL-1"));
    await store.createMemoryCell(cell("CELL-2"));
    const manual = serializeScene(manualScene());
    await vault.create(SCENE_PATH, manual);
    await store.syncScenesFromCells();
    expect(vault.files.get(SCENE_PATH)).toBe(manual);
    await vault.modify(new TFile(SCENE_PATH), "unfinished frontmatter");
    store.invalidateLibrary([SCENE_PATH]);
    await store.syncScenesFromCells();
    expect(vault.files.get(SCENE_PATH)).toBe("unfinished frontmatter");
  });

  it("keeps scenes through incomplete cell edits and derives again after repair", async () => {
    const { store, vault } = await seed();
    const original = vault.files.get(SCENE_PATH);
    await vault.modify(new TFile(`${CELL_DIR}/CELL-2.md`), "unfinished frontmatter");
    store.invalidateLibrary([`${CELL_DIR}/CELL-2.md`]);
    await store.syncScenesFromCells();
    expect(vault.files.get(SCENE_PATH)).toBe(original);
    expect((await store.refreshLibrary()).diagnostics).toMatchObject([{ kind: "memory-cell", path: `${CELL_DIR}/CELL-2.md` }]);
    await vault.modify(new TFile(`${CELL_DIR}/CELL-2.md`), serializeMemoryCell(cell("CELL-2", "Projection")));
    store.invalidateLibrary([`${CELL_DIR}/CELL-2.md`]);
    await store.syncScenesFromCells();
    expect(vault.files.has(SCENE_PATH)).toBe(false);
  });

  it("preserves a scene converted to hand-authored while a derived update is starting", async () => {
    const { store, vault } = await seed();
    await store.createMemoryCell(cell("CELL-3"));
    const originalProcess = vault.process.bind(vault), manual = serializeScene(manualScene());
    vi.spyOn(vault, "process").mockImplementation(async (file, transform) => {
      if (file.path === SCENE_PATH) vault.files.set(file.path, manual);
      return originalProcess(file, transform);
    });
    await store.syncScenesFromCells();
    expect(vault.files.get(SCENE_PATH)).toBe(manual);
    expect((await store.refreshLibrary()).scenes[0]?.tags).toEqual([]);
  });

  it("does not delete a stale auto scene converted to hand-authored after the source scan", async () => {
    const { store, vault } = await seed();
    await vault.delete(new TFile(`${CELL_DIR}/CELL-2.md`));
    store.invalidateLibrary([`${CELL_DIR}/CELL-2.md`]);
    const originalRead = vault.read.bind(vault), manual = serializeScene(manualScene());
    vi.spyOn(vault, "read").mockImplementation(async file => {
      if (file.path === SCENE_PATH) vault.files.set(file.path, manual);
      return originalRead(file);
    });
    await store.syncScenesFromCells();
    expect(vault.files.get(SCENE_PATH)).toBe(manual);
  });

  it("reconciles a newer cell generation written while the scene was persisting", async () => {
    const { store, vault } = await seed();
    await store.createMemoryCell(cell("CELL-3"));
    const started = deferred(), gate = deferred(), original = vault.process.bind(vault);
    let block = true;
    vi.spyOn(vault, "process").mockImplementation(async (file, transform) => {
      if (block && file.path === SCENE_PATH) { block = false; started.resolve(); await gate.promise; }
      return original(file, transform);
    });
    const pending = store.syncScenesFromCells();
    await started.promise;
    await store.createMemoryCell(cell("CELL-4"));
    gate.resolve(); await pending;
    expect(parseSceneFile(vault.files.get(SCENE_PATH)!)?.cells).toEqual(["CELL-1", "CELL-2", "CELL-3", "CELL-4"]);
    expect((await store.refreshLibrary()).scenes[0]?.cells).toHaveLength(4);
  });

  it("serializes scene synchronization with library outputs and can retry a failed scene write", async () => {
    const { store, vault } = await seed();
    await store.createMemoryCell(cell("CELL-3"));
    const original = vault.process.bind(vault);
    vi.spyOn(vault, "process").mockRejectedValueOnce(new Error("scene unavailable")).mockImplementation(original);
    await expect(store.syncScenesFromCells()).rejects.toThrow("scene unavailable");
    const sync = store.syncScenesFromCells(), refresh = store.refreshLibrary();
    await sync;
    expect((await refresh).scenes[0]?.cells).toEqual(["CELL-1", "CELL-2", "CELL-3"]);
  });

  it("leaves an external invalidation dirty after an index output failure", async () => {
    const { store, vault } = await seed();
    await vault.modify(new TFile(`${CELL_DIR}/CELL-2.md`), serializeMemoryCell(cell("CELL-2", "Projection")));
    const write = vi.spyOn(vault.adapter, "write").mockRejectedValueOnce(new Error("index unavailable"));
    await expect(store.refreshLibrary(undefined, [`${CELL_DIR}/CELL-2.md`])).rejects.toThrow("index unavailable");
    write.mockRestore();
    expect((await store.refreshLibrary()).cells.find(cell => cell.id === "CELL-2")?.concept).toBe("Projection");
  });

  it("rescans ancestors per group without clearing unprocessed annotation changes", async () => {
    const { store, vault } = await seed();
    const annotation: Annotation = {
      id: "ANN-1", sourceFile: "source.md", anchor: { blockId: "anchor-1", selectedText: "Attention" },
      userNote: "New outside the cached library", status: "saved", concepts: [], relatedMemoryCells: [], createdAt: NOW, updatedAt: NOW
    };
    await vault.create(store.annotationPath(annotation.id), serializeAnnotation(annotation));
    store.invalidateLibrary([store.memoryRoot()]);
    await store.syncScenesFromCells();
    expect((await store.refreshLibrary()).annotations[0]?.userNote).toBe(annotation.userNote);
  });

  it("restarts from a newly selected root without writing old cells' scenes there", async () => {
    const { store, vault, settings } = fixture();
    await store.createMemoryCell(cell("CELL-1"));
    await store.createMemoryCell(cell("CELL-2"));
    const started = deferred(), gate = deferred(), original = vault.read.bind(vault);
    let block = true;
    vi.spyOn(vault, "read").mockImplementation(async file => {
      const content = await original(file);
      if (block && file.path.startsWith(CELL_DIR)) { block = false; started.resolve(); await gate.promise; }
      return content;
    });
    const pending = store.syncScenesFromCells();
    await started.promise;
    settings.memoryRoot = "New Memory";
    gate.resolve(); await pending;
    expect(vault.files.has("New Memory/scenes/SCENE-Attention.md")).toBe(false);
    expect((await store.refreshLibrary()).cells).toHaveLength(0);
  });

  it("supports an explicit full source rescan to repair edits made without a vault event", async () => {
    const { store, vault } = await seed();
    await vault.modify(new TFile(`${CELL_DIR}/CELL-2.md`), serializeMemoryCell(cell("CELL-2", "Projection")));
    await store.syncScenesFromCells(true);
    expect(vault.files.has(SCENE_PATH)).toBe(false);
    expect((await store.refreshLibrary()).cells.find(cell => cell.id === "CELL-2")?.concept).toBe("Projection");
  });
});
