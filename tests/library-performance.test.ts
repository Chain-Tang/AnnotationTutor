import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AnnotationTutorLiteSettings } from "../src/settings.js";
import type { Annotation, MemoryCell } from "../src/model.js";
import * as cellMarkdown from "../src/markdown/memory-cell-file.js";
import * as sceneMarkdown from "../src/markdown/scene-file.js";
import * as annotationMarkdown from "../src/markdown/annotation-file.js";
import { createMockApp, TFile } from "./helpers/obsidian-mock.js";

vi.mock("obsidian", () => import("./helpers/obsidian-mock.js"));
const { VaultStore } = await import("../src/store.js");
const NOW = "2026-10-16T00:00:00.000Z";
const cell = (id: string, concept: string): MemoryCell => ({ id, type: "understanding", concept, status: "stable",
  summary: "A valid understanding.", sourceAnnotations: ["ANN-1"], tags: [], confidence: 0.9, createdAt: NOW, updatedAt: NOW });
const annotation: Annotation = { id: "ANN-1", sourceFile: "note.md", anchor: { blockId: "a1", selectedText: "Selection" },
  userNote: "Original", concepts: [], relatedMemoryCells: [], status: "saved", createdAt: NOW, updatedAt: NOW };
function fixture() {
  const app = createMockApp();
  const settings = { memoryRoot: "Agent Memory", createAgentInstructions: true } as AnnotationTutorLiteSettings;
  return { store: new VaultStore(app as unknown as App, "tutor", () => settings), vault: app.vault, settings };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("library parsing and generation budgets", () => {
  it("does zero Markdown parsing for a warm 1000-cell / 500-scene sync and index refresh", async () => {
    const { store, vault } = fixture();
    for (let i = 0; i < 1000; i++) await vault.create(`Agent Memory/memory-cells/CELL-${i}.md`, cellMarkdown.serializeMemoryCell(cell(`CELL-${i}`, `Concept ${Math.floor(i / 2)}`)));
    await store.syncScenesFromCells(); await store.refreshLibrary();
    const cells = vi.spyOn(cellMarkdown, "parseMemoryCellFile"), scenes = vi.spyOn(sceneMarkdown, "parseSceneFile");
    const rawReads = vi.spyOn(vault, "read");
    await store.syncScenesFromCells();
    const snapshot = await store.refreshLibrary();
    expect(snapshot.cells).toHaveLength(1000); expect(snapshot.scenes).toHaveLength(500);
    expect(cells).not.toHaveBeenCalled(); expect(scenes).not.toHaveBeenCalled(); expect(rawReads).not.toHaveBeenCalled();
  });

  it("coalesces ten refreshes and promotes a full rebuild into one source read and cache write", async () => {
    const { store, vault } = fixture(); await store.createAnnotation(annotation); await store.refreshLibrary();
    const read = vi.spyOn(vault, "read"), write = vi.spyOn(vault.adapter, "write");
    const pending = Array.from({ length: 9 }, () => store.refreshLibrary()); pending.push(store.rebuildLibrary());
    const snapshots = await Promise.all(pending);
    expect(new Set(snapshots).size).toBe(1); expect(read).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce();
  });

  it("caches an incomplete raw version independently of last-valid hashes, and handles delete / rename / roots", async () => {
    const { store, vault, settings } = fixture(); await store.createAnnotation(annotation);
    const first = await store.refreshLibrary();
    await vault.modify(new TFile(store.annotationPath(annotation.id)), "unfinished frontmatter");
    const parse = vi.spyOn(annotationMarkdown, "parseAnnotationFile");
    const invalid = await store.refreshLibrary(first, [store.annotationPath(annotation.id)]);
    expect(invalid.annotations).toHaveLength(1); expect(invalid.diagnostics).toHaveLength(1);
    expect(invalid.files[store.annotationPath(annotation.id)]).toBe(first.files[store.annotationPath(annotation.id)]);
    await store.refreshLibrary(invalid); expect(parse).toHaveBeenCalledOnce();
    const oldPath = store.annotationPath(annotation.id), newPath = `${store.annotationsDir()}/renamed.md`;
    await vault.delete(new TFile(oldPath)); await vault.create(newPath, annotationMarkdown.serializeAnnotation(annotation));
    const renamed = await store.refreshLibrary(invalid, [oldPath, newPath]);
    expect(renamed.annotations[0]?.memoryFile).toBe(newPath); expect(renamed.diagnostics).toHaveLength(0);
    expect(renamed.files).not.toHaveProperty(oldPath);
    settings.memoryRoot = "Other Memory"; expect((await store.refreshLibrary()).annotations).toHaveLength(0);
    settings.memoryRoot = "Agent Memory"; expect((await store.refreshLibrary()).annotations).toHaveLength(1);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("waits for one follow-up round when ten callers arrive during durable writes", async () => {
    const { store, vault } = fixture(); await store.createAnnotation(annotation); await store.refreshLibrary();
    const held = gate(), original = vault.adapter.write.bind(vault.adapter);
    const write = vi.spyOn(vault.adapter, "write").mockImplementationOnce(async (path, content) => { await held.promise; await original(path, content); });
    await store.updateAnnotation(annotation.id, { userNote: "Round 1" });
    const first = store.refreshLibrary(); await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    await store.updateAnnotation(annotation.id, { userNote: "Round 2" });
    let completed = 0;
    const pending = Array.from({ length: 10 }, () => store.refreshLibrary().then(snapshot => { completed++; return snapshot; }));
    expect(completed).toBe(0); held.resolve();
    expect((await first).annotations[0]?.userNote).toBe("Round 1");
    const latest = await Promise.all(pending); expect(new Set(latest).size).toBe(1);
    expect(latest[0]?.annotations[0]?.userNote).toBe("Round 2"); expect(write).toHaveBeenCalledTimes(2);
  });

  it("rejects failed callers and keeps dirty source changes for the next retry", async () => {
    const { store, vault } = fixture(); await store.createAnnotation(annotation); await store.refreshLibrary();
    await store.updateAnnotation(annotation.id, { userNote: "Retry" });
    vi.spyOn(vault.adapter, "write").mockRejectedValueOnce(new Error("disk failed"));
    const failed = Array.from({ length: 10 }, () => store.refreshLibrary());
    expect((await Promise.allSettled(failed)).every(result => result.status === "rejected")).toBe(true);
    expect((await store.refreshLibrary()).annotations[0]?.userNote).toBe("Retry");
  });

  it("keeps last-valid fallback independent from records changed by a UI consumer", async () => {
    const { store, vault } = fixture(); await store.createAnnotation(annotation);
    const first = await store.refreshLibrary();
    first.annotations[0]!.userNote = "Only in the view"; first.annotations[0]!.concepts.push("UI-only");
    await vault.modify(new TFile(store.annotationPath(annotation.id)), "unfinished frontmatter");
    const next = await store.refreshLibrary(first, [store.annotationPath(annotation.id)]);
    expect(next.annotations[0]?.userNote).toBe(annotation.userNote);
    expect(next.annotations[0]?.concepts).toEqual(annotation.concepts);
  });
});
