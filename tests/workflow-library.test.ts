import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AnnotationTutorLiteSettings } from "../src/settings.js";
import type { Annotation } from "../src/model.js";
import { createMockApp, TFile } from "./helpers/obsidian-mock.js";
import { serializeAnnotation } from "../src/markdown/annotation-file.js";

vi.mock("obsidian", () => import("./helpers/obsidian-mock.js"));
const { VaultStore } = await import("../src/store.js");
const { MemoryWatcher } = await import("../src/watcher.js");

const annotation = (id = "ANN-1", status: Annotation["status"] = "saved"): Annotation => ({
  id, sourceFile: "source.md", anchor: { blockId: "anchor-1", selectedText: "Attention" },
  userNote: "My note", status, concepts: [], relatedMemoryCells: [],
  createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z"
});
function fixture() {
  const app = createMockApp();
  const settings = { memoryRoot: "Agent Memory", watchMemoryFiles: true, createAgentInstructions: true } as AnnotationTutorLiteSettings;
  const store = new VaultStore(app as unknown as App, "annotation-tutor-lite", () => settings);
  return { store, vault: app.vault, settings };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("library I/O reconciliation", () => {
  it("starts all five directory reads together, then awaits all generated outputs", async () => {
    const { store, vault } = fixture();
    await store.createAnnotation(annotation());
    for (const dir of ["memory-cells", "scenes", "profiles", "proposals/pending"]) await vault.create(`Agent Memory/${dir}/fixture.md`, "invalid fixture");
    const gate = deferred(), original = vault.read.bind(vault);
    const read = vi.spyOn(vault, "read").mockImplementation(async file => { await gate.promise; return original(file); });
    const pending = store.rebuildLibrary();
    await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(5);
    gate.resolve(); await pending;
    read.mockRestore();
    const outputGate = deferred(), originalModify = vault.modify.bind(vault);
    const modify = vi.spyOn(vault, "modify").mockImplementation(async (file, content) => { await outputGate.promise; return originalModify(file, content); });
    const refresh = store.rebuildLibrary();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(modify).toHaveBeenCalledTimes(6);
    outputGate.resolve(); await refresh;
  });

  it("re-reads only dirty files and preserves last-valid records through an invalid external edit", async () => {
    const { store, vault } = fixture();
    await store.createAnnotation(annotation());
    await store.createAnnotation(annotation("ANN-2"));
    const initial = await store.rebuildLibrary();
    const read = vi.spyOn(vault, "read");
    await store.updateAnnotation("ANN-1", { userNote: "Changed" });
    const updated = await store.refreshLibrary(initial);
    expect(read.mock.calls.map(([file]) => file.path)).toEqual([store.annotationPath("ANN-1")]);
    expect(updated.annotations.find(record => record.annotationId === "ANN-1")?.userNote).toBe("Changed");
    read.mockClear();
    await vault.modify(new TFile(store.annotationPath("ANN-1")), "unfinished frontmatter");
    const invalid = await store.refreshLibrary(updated, [store.annotationPath("ANN-1")]);
    expect(invalid.annotations).toHaveLength(2);
    expect(invalid.annotations.find(record => record.annotationId === "ANN-1")?.userNote).toBe("Changed");
    expect(invalid.diagnostics).toMatchObject([{ path: store.annotationPath("ANN-1"), kind: "annotation" }]);
    await vault.modify(new TFile(store.annotationPath("ANN-1")), serializeAnnotation(annotation("ANN-1", "reviewed")));
    const repaired = await store.refreshLibrary(invalid, [store.annotationPath("ANN-1")]);
    expect(repaired.diagnostics).toHaveLength(0);
    await store.deleteAnnotation("ANN-1");
    expect((await store.refreshLibrary(repaired)).annotations.map(record => record.annotationId)).toEqual(["ANN-2"]);
  });

  it("serializes refresh outputs and keeps writes made during a refresh dirty for the next one", async () => {
    const { store, vault } = fixture();
    await store.createAnnotation(annotation());
    await store.rebuildLibrary();
    await store.updateAnnotation("ANN-1", { userNote: "First" });
    const gate = deferred(), started = deferred(), originalModify = vault.modify.bind(vault);
    let blocked = false;
    vi.spyOn(vault, "modify").mockImplementation(async (file, content) => {
      if (!blocked && file.path === store.overviewPath()) { blocked = true; started.resolve(); await gate.promise; }
      await originalModify(file, content);
    });
    const first = store.refreshLibrary();
    await started.promise;
    await store.updateAnnotation("ANN-1", { userNote: "Second" });
    const second = store.refreshLibrary();
    gate.resolve();
    expect((await first).annotations[0]?.userNote).toBe("First");
    expect((await second).annotations[0]?.userNote).toBe("Second");
    expect(vault.files.get(store.overviewPath())).toContain("Second");
  });

  it("retains the completed write generation when a refresh overlaps slow persistence", async () => {
    const { store, vault } = fixture();
    await store.createAnnotation(annotation());
    await store.rebuildLibrary();
    const gate = deferred(), started = deferred();
    vi.spyOn(vault, "process").mockImplementation(async (file, transform) => {
      const next = transform(vault.files.get(file.path) ?? "");
      started.resolve(); await gate.promise;
      vault.files.set(file.path, next);
      return next;
    });
    const write = store.updateAnnotation("ANN-1", { userNote: "Persisted after refresh" });
    await started.promise;
    expect((await store.refreshLibrary()).annotations[0]?.userNote).toBe("My note");
    gate.resolve(); await write;
    expect(await store.isOwnWrite(store.annotationPath("ANN-1"))).toBe(true);
    expect((await store.refreshLibrary()).annotations[0]?.userNote).toBe("Persisted after refresh");
  });

  it("waits for sibling output writes on failure and allows a complete retry", async () => {
    const { store, vault } = fixture();
    await store.createAnnotation(annotation());
    await store.rebuildLibrary();
    await store.updateAnnotation("ANN-1", { userNote: "Retry" });
    const gate = deferred(), started = deferred(), originalModify = vault.modify.bind(vault);
    let fail = true;
    vi.spyOn(vault, "modify").mockImplementation(async (file, content) => {
      if (fail && file.path === store.overviewPath()) throw new Error("output unavailable");
      if (fail && file.path === store.recentLearningPath()) { started.resolve(); await gate.promise; }
      await originalModify(file, content);
    });
    let settled = false;
    const failed = store.refreshLibrary().finally(() => { settled = true; });
    await started.promise;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve(); await expect(failed).rejects.toThrow("output unavailable");
    fail = false;
    expect((await store.refreshLibrary()).annotations[0]?.userNote).toBe("Retry");
  });

  it("never writes an old-root snapshot into a newly selected memory root", async () => {
    const { store, vault, settings } = fixture();
    await store.createAnnotation(annotation());
    const gate = deferred(), started = deferred(), originalRead = vault.read.bind(vault);
    let block = true;
    vi.spyOn(vault, "read").mockImplementation(async file => {
      const text = await originalRead(file);
      if (block && file.path === "Agent Memory/annotations/ANN-1.md") { block = false; started.resolve(); await gate.promise; }
      return text;
    });
    const pending = store.rebuildLibrary();
    await started.promise;
    settings.memoryRoot = "New Memory";
    gate.resolve();
    const snapshot = await pending;
    expect(snapshot.annotations).toHaveLength(0);
    expect(vault.files.get("New Memory/annotation-memory.md")).not.toContain("ANN-1");
    expect(vault.files.get("Agent Memory/annotation-memory.md")).toContain("ANN-1");
  });

  it("restores only a request-owned status and preserves an external archive or written review", async () => {
    const { store } = fixture();
    await store.createAnnotation(annotation("ANN-1", "agent_requested"));
    expect((await store.restoreReviewRequest("ANN-1", "saved"))?.status).toBe("saved");
    await store.updateAnnotation("ANN-1", { status: "archived" });
    expect(await store.restoreReviewRequest("ANN-1", "saved")).toBeNull();
    expect((await store.readAnnotation("ANN-1"))?.status).toBe("archived");
  });
});

describe("watcher ownership and serialization", () => {
  it("does not use an old fingerprint after a concurrent self-write changed its generation", async () => {
    const { store, vault } = fixture();
    await store.createAnnotation(annotation());
    const gate = deferred(), started = deferred(), originalRead = vault.read.bind(vault);
    const read = vi.spyOn(vault, "read").mockImplementation(async file => {
      const content = await originalRead(file);
      started.resolve(); await gate.promise;
      return content;
    });
    const check = store.isOwnWrite(store.annotationPath("ANN-1"));
    await started.promise;
    await store.updateAnnotation("ANN-1", { userNote: "New generation" });
    gate.resolve(); expect(await check).toBe(false);
    read.mockRestore();
    expect(await store.isOwnWrite(store.annotationPath("ANN-1"))).toBe(true);
  });

  it("recognizes delayed self events without hiding immediate external changes", async () => {
    vi.useFakeTimers();
    const { store, vault, settings } = fixture();
    await store.createAnnotation(annotation());
    const flush = vi.fn();
    const watcher = new MemoryWatcher(store, () => settings, flush, 10);
    await vi.advanceTimersByTimeAsync(10000);
    watcher.notify(store.annotationPath("ANN-1"));
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).not.toHaveBeenCalled();
    await vault.modify(new TFile(store.annotationPath("ANN-1")), serializeAnnotation(annotation("ANN-1", "archived")));
    watcher.notify(store.annotationPath("ANN-1"));
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledExactlyOnceWith([store.annotationPath("ANN-1")]);
    await vault.modify(new TFile(store.annotationPath("ANN-1")), serializeAnnotation(annotation()));
    watcher.notify(store.annotationPath("ANN-1"));
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it("batches changes arriving while reconciliation is running into a later flush", async () => {
    vi.useFakeTimers();
    const { store, settings } = fixture();
    const gate = deferred();
    const flush = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const watcher = new MemoryWatcher(store, () => settings, flush, 10);
    watcher.notify("Agent Memory/annotations/external-1.md");
    await vi.advanceTimersByTimeAsync(10);
    watcher.notify("Agent Memory/annotations/external-2.md");
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1]).toEqual([["Agent Memory/annotations/external-2.md"]]);
    watcher.dispose();
    watcher.notify("Agent Memory/annotations/external-3.md");
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
