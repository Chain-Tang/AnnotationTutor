import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "obsidian";
import type { ReviewOutcome } from "../src/review-outcome.js";
import type { AnnotationTutorLiteSettings } from "../src/settings-config.js";
import type { FileGlossary } from "../src/pretranslate.js";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({ TFile: class {}, Notice: class { constructor(text: string) { notices.push(text); } hide() {} }, Modal: class {}, setIcon: () => {} }));
const { TFile } = await import("obsidian");
const { TranslationController } = await import("../src/translation-controller.js");
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(limit = 2, batches = 3) {
  const files = Array.from({ length: 5 }, (_, i) => Object.assign(new TFile(), { path: `file-${i}.md`, extension: "md" }));
  const byPath = new Map(files.map(file => [file.path, file]));
  const texts = new Map(files.map((file, i) => [file.path, Array.from({ length: batches }, (_, j) => `File${i} ${["alpha", "beta", "gamma"][j]}`).join("\n\n")]));
  const settings = { memoryRoot: "Agent Memory", pretranslateOnOpen: true, pretranslateChunkChars: 12, dictionaryLanguage: "Chinese",
    reviewEngine: limit === 1 ? "opencode" : "api", apiBaseUrl: "https://example.invalid", apiModel: "test", apiKey: "test-secret" } as AnnotationTutorLiteSettings;
  const requests: Array<{ prompt: string; signal?: AbortSignal; settled: boolean; finish(outcome?: ReviewOutcome): void }> = [];
  let active = 0, peak = 0;
  const capture = vi.fn((prompt: string, _timeout: number, signal?: AbortSignal) => new Promise<ReviewOutcome>(resolve => {
    active++; peak = Math.max(peak, active);
    const request = { prompt, signal, settled: false, finish(outcome: ReviewOutcome = { kind: "ok", reviewText: "alpha :: 字义" }) {
      if (request.settled) return; request.settled = true; active--; resolve(outcome);
    } }; requests.push(request);
  }));
  let editorText = "term and term";
  const editor = { getSelection: () => "term", getValue: () => editorText, getCursor: (which: string) => ({ line: 0, ch: which === "from" ? 9 : 13 }),
    posToOffset: (position: { ch: number }) => position.ch, offsetToPos: (ch: number) => ({ line: 0, ch }), getLine: () => editorText,
    replaceRange: vi.fn((replacement: string, from: { ch: number }, to: { ch: number }) => { editorText = editorText.slice(0, from.ch) + replacement + editorText.slice(to.ch); }) };
  const statusBar = { empty: vi.fn(), createSpan: () => ({}), setAttribute: vi.fn() };
  const process = vi.fn(async (file: { path: string }, transform: (text: string) => string) => { texts.set(file.path, transform(texts.get(file.path)!)); });
  const vault = { cachedRead: vi.fn(async (file: { path: string }) => texts.get(file.path)!), getAbstractFileByPath: (path: string) => byPath.get(path), process };
  const controller = new TranslationController({ app: { workspace: { getLeavesOfType: () => [{ view: { editor, file: files[4] } }] }, vault } as never,
    statusBar: statusBar as unknown as HTMLElement, settings: () => settings, chatTimeoutMs: () => 1000, captureText: capture,
    pretranslateConcurrency: () => settings.reviewEngine === "api" ? 2 : 1 });
  const internal = controller as unknown as { glossaryCache: Map<string, FileGlossary>; preserveResult(text: string): void };
  internal.preserveResult = vi.fn();
  const finishAll = async () => {
    for (let i = 0; i < 30; i++) { await tick(); const waiting = requests.filter(request => !request.settled); if (!waiting.length) break; for (const request of waiting) request.finish(); }
    await tick();
  };
  return { files, byPath, texts, settings, controller, requests, capture, statusBar, process, vault, editor: editor as unknown as Editor,
    replace: editor.replaceRange, text: () => editorText, internal, peak: () => peak, finishAll };
}
beforeEach(() => { notices.length = 0; });

describe("controller-wide translation scheduling", () => {
  it.each([1, 2])("bounds four documents and all their workers to %i total requests", async limit => {
    const f = fixture(limit), pending = f.files.slice(0, 4).map(file => f.controller.maybePretranslate(file));
    await tick(); expect(f.requests).toHaveLength(limit);
    await f.finishAll(); await Promise.all(pending);
    expect(f.peak()).toBe(limit); expect(f.capture).toHaveBeenCalledTimes(12);
    expect(f.requests.every(request => request.signal instanceof AbortSignal)).toBe(true);
    expect(f.files.slice(0, 4).every(file => f.internal.glossaryCache.get(file.path)?.complete)).toBe(true);
  });

  it("queues live translations behind existing probes and ahead of subsequently enqueued workers", async () => {
    const f = fixture(), pending = f.files.slice(0, 4).map(file => f.controller.maybePretranslate(file));
    await tick(); const live = f.controller.translateSelection(f.editor);
    f.requests[0]!.finish(); await tick(); expect(f.requests[2]!.prompt).toContain("File2 alpha");
    f.requests[1]!.finish(); await tick(); expect(f.requests[3]!.prompt).toContain("File3 alpha");
    f.requests[2]!.finish(); await tick(); expect(f.requests[4]!.prompt).not.toContain("study glossary");
    f.requests[4]!.finish({ kind: "ok", reviewText: "术语" });
    await f.finishAll(); await Promise.all([...pending, live]);
    expect(f.text()).toBe("term and term (术语)"); expect(f.peak()).toBe(2);
  });

  it("cancels one queued file without cancelling other documents", async () => {
    const f = fixture(1, 1), pending = f.files.slice(0, 3).map(file => f.controller.maybePretranslate(file));
    await tick(); f.controller.onFileDeleted(f.files[1]!.path);
    f.requests[0]!.finish(); await tick(); expect(f.requests[1]!.prompt).toContain("File2 alpha");
    await f.finishAll(); await Promise.all(pending);
    expect(f.capture).toHaveBeenCalledTimes(2); expect(f.internal.glossaryCache.has(f.files[1]!.path)).toBe(false);
    expect(f.internal.glossaryCache.get(f.files[2]!.path)?.complete).toBe(true);
  });
});

describe("translation cancellation and side effects", () => {
  it("aborts a renamed run, while allowing its new generation without releasing the old permit early", async () => {
    const f = fixture(1, 1), file = f.files[0]!, old = file.path;
    const first = f.controller.maybePretranslate(file); await tick();
    f.byPath.delete(old); file.path = "renamed.md"; f.byPath.set(file.path, file); f.texts.set(file.path, "new alpha");
    f.controller.onFileRenamed(old, file.path);
    expect(f.requests[0]!.signal?.aborted).toBe(true);
    const next = f.controller.maybePretranslate(file); await first; await tick();
    expect(f.capture).toHaveBeenCalledTimes(1);
    f.requests[0]!.finish(); await tick(); expect(f.requests[1]!.prompt).toContain("new alpha");
    f.requests[1]!.finish(); await next;
    expect(f.internal.glossaryCache.get(file.path)?.complete).toBe(true); expect(f.peak()).toBe(1);
  });

  it.each(["language", "route", "source"])("invalidates pending %s work without retaining a late glossary", async change => {
    const f = fixture(1), file = f.files[0]!;
    const pending = f.controller.maybePretranslate(file); await tick();
    if (change === "source") f.controller.onFileChanged(file.path);
    else { if (change === "language") f.settings.dictionaryLanguage = "French"; else f.settings.agentModel = "different-model"; f.controller.onSettingsChanged(); }
    await pending; expect(f.requests[0]!.signal?.aborted).toBe(true);
    f.requests[0]!.finish(); await tick();
    expect(f.capture).toHaveBeenCalledTimes(1); expect(f.internal.glossaryCache.has(file.path)).toBe(false);
  });

  it("disposes queued and inflight work with no late status, cache, notices or editor writes", async () => {
    const f = fixture(), pending = f.files.slice(0, 4).map(file => f.controller.maybePretranslate(file));
    await tick(); const live = f.controller.translateSelection(f.editor);
    f.controller.dispose(); await Promise.all([...pending, live]);
    const statusWrites = f.statusBar.empty.mock.calls.length, noticeCount = notices.length;
    for (const request of f.requests) request.finish(); await tick();
    expect(f.requests.every(request => request.signal?.aborted)).toBe(true);
    expect(f.capture).toHaveBeenCalledTimes(2); expect(f.internal.glossaryCache.size).toBe(0);
    expect(f.replace).not.toHaveBeenCalled(); expect(f.process).not.toHaveBeenCalled(); expect(f.internal.preserveResult).not.toHaveBeenCalled();
    expect(f.statusBar.empty).toHaveBeenCalledTimes(statusWrites); expect(notices).toHaveLength(noticeCount);
    await f.controller.translateSelection(f.editor); await f.controller.maybePretranslate(f.files[0]!);
    expect(f.capture).toHaveBeenCalledTimes(2); expect(notices).toHaveLength(noticeCount);
  });

  it("does not enter a Reading-view write after the live result is cancelled", async () => {
    const f = fixture(1, 1), file = f.files[0]!;
    const pending = f.controller.translateReadingSelection(file, "alpha"); await tick();
    f.controller.dispose(); await pending;
    f.requests[0]!.finish({ kind: "ok", reviewText: "阿尔法" }); await tick();
    expect(f.process).not.toHaveBeenCalled(); expect(f.texts.get(file.path)).toBe("File0 alpha");
  });

  it("guards the Reading-view atomic transform when disposal arrives during process IO", async () => {
    const f = fixture(1, 1), file = f.files[0]!;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(done => { enter = done; }), gate = new Promise<void>(done => { release = done; });
    f.process.mockImplementationOnce(async (target, transform) => { enter(); await gate; f.texts.set(target.path, transform(f.texts.get(target.path)!)); });
    const pending = f.controller.translateReadingSelection(file, "alpha"); await tick();
    f.requests[0]!.finish({ kind: "ok", reviewText: "阿尔法" }); await entered;
    f.controller.dispose(); release(); await pending;
    expect(f.texts.get(file.path)).toBe("File0 alpha"); expect(f.internal.preserveResult).not.toHaveBeenCalled();
  });
});
