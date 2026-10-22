import { describe, expect, it, vi } from "vitest";
import type { ReviewOutcome } from "../src/review-outcome.js";
import type { AnnotationTutorLiteSettings } from "../src/settings-config.js";
import type { FileGlossary } from "../src/pretranslate.js";

vi.mock("obsidian", () => ({ TFile: class {}, Notice: class { hide() {} }, Modal: class {}, setIcon: () => {} }));
const { TFile } = await import("obsidian");
const { TranslationController } = await import("../src/translation-controller.js");
function fixture(concurrency?: number) {
  const file = Object.assign(new TFile(), { path: "source.md", extension: "md" });
  let content = "alpha first\n\nbeta second\n\ngamma third\n\ndelta fourth";
  const settings = { memoryRoot: "Agent Memory", pretranslateOnOpen: true, pretranslateChunkChars: 12, dictionaryLanguage: "Chinese" } as AnnotationTutorLiteSettings;
  const requests: Array<{ resolve: (outcome: ReviewOutcome) => void; prompt: string }> = [];
  let active = 0, peak = 0;
  const capture = vi.fn((prompt: string) => new Promise<ReviewOutcome>(resolve => {
    active += 1; peak = Math.max(peak, active);
    requests.push({ prompt, resolve: outcome => { active -= 1; resolve(outcome); } });
  }));
  const statusBar = { empty: vi.fn(), createSpan: () => ({}), setAttribute: vi.fn() } as unknown as HTMLElement;
  const read = vi.fn(async () => content);
  const controller = new TranslationController({ app: { workspace: {}, vault: { cachedRead: read, getAbstractFileByPath: (path: string) => path === file.path ? file : null } } as never,
    statusBar, settings: () => settings, chatTimeoutMs: () => 1000, captureText: capture,
    ...(concurrency === undefined ? {} : { pretranslateConcurrency: () => concurrency }) });
  const internals = controller as unknown as { glossaryCache: Map<string, FileGlossary>; glossFromCache(text: string, mode: string, file: unknown): string | null; cacheWordGloss(file: unknown, text: string, gloss: string, target: string): void };
  return { file, controller, capture, requests, settings, read, statusBar, glossary: () => internals.glossaryCache.get(file.path),
    cached: (text: string) => internals.glossFromCache(text, "word", file), cacheLive: (text: string, gloss: string, target: string) => internals.cacheWordGloss(file, text, gloss, target), peak: () => peak, changeContent: (value: string) => { content = value; } };
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("bounded pre-translation", () => {
  it("probes one batch, limits independent requests to two, and merges out-of-order replies in source order", async () => {
    const f = fixture(2), pending = f.controller.maybePretranslate(f.file);
    await tick(); expect(f.requests).toHaveLength(1);
    f.requests[0]!.resolve({ kind: "ok", reviewText: "alpha :: 阿尔法" });
    await tick(); expect(f.requests).toHaveLength(3);
    f.requests[2]!.resolve({ kind: "ok", reviewText: "shared :: 后文含义" });
    await tick(); expect(f.requests).toHaveLength(4);
    expect(f.glossary()?.complete).toBe(false);
    f.requests[1]!.resolve({ kind: "ok", reviewText: "shared :: 前文含义" });
    f.requests[3]!.resolve({ kind: "ok", reviewText: "delta :: 德尔塔" });
    await pending;
    expect(f.peak()).toBe(2);
    expect(f.glossary()?.byKey.get("shared")?.gloss).toBe("前文含义");
    expect(f.glossary()?.complete).toBe(true);
    await f.controller.maybePretranslate(f.file);
    expect(f.capture).toHaveBeenCalledTimes(4);
  });

  it("defaults to one request at a time for a shared transport", async () => {
    const f = fixture(), pending = f.controller.maybePretranslate(f.file);
    for (let i = 0; i < 4; i++) {
      await tick(); expect(f.requests).toHaveLength(i + 1);
      f.requests[i]!.resolve({ kind: "ok", reviewText: `term${i} :: 含义` });
    }
    await pending; expect(f.peak()).toBe(1);
  });

  it("missing credentials launch one probe and leave a retryable cache", async () => {
    const f = fixture(3), first = f.controller.maybePretranslate(f.file);
    await tick(); f.requests[0]!.resolve({ kind: "needs-key" });
    await first;
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.glossary()?.complete).toBe(false);
    const retry = f.controller.maybePretranslate(f.file);
    await tick(); expect(f.capture).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve({ kind: "needs-key" }); await retry;
  });

  it("failed batches do not mark a partial glossary complete", async () => {
    const f = fixture(), pending = f.controller.maybePretranslate(f.file);
    for (let i = 0; i < 4; i++) {
      await tick(); f.requests[i]!.resolve(i === 1 ? { kind: "failed", detail: "fixture" } : { kind: "ok", reviewText: `term${i} :: 含义` });
    }
    await pending; expect(f.glossary()?.complete).toBe(false);
  });

  it("includes the dictionary language in cache validity", async () => {
    const f = fixture(); f.changeContent("alpha");
    const first = f.controller.maybePretranslate(f.file);
    await tick(); f.requests[0]!.resolve({ kind: "ok", reviewText: "alpha :: 阿尔法" }); await first;
    expect(f.cached("alpha")).toBe("alpha (阿尔法)");
    f.settings.dictionaryLanguage = "French";
    expect(f.cached("alpha")).toBeNull();
    const next = f.controller.maybePretranslate(f.file);
    await tick(); expect(f.requests[1]!.prompt).toContain("French");
    expect(f.cached("alpha")).toBeNull();
    f.requests[1]!.resolve({ kind: "ok", reviewText: "alpha :: lettre" }); await next;
    expect(f.cached("alpha")).toBe("alpha (lettre)");
    f.cacheLive("beta", "中文旧请求", "Chinese");
    expect(f.cached("beta")).toBeNull();
  });

  it("reserves the run before async reads and releases it after a rename", async () => {
    const f = fixture(); f.changeContent("alpha");
    const first = f.controller.maybePretranslate(f.file), duplicate = f.controller.maybePretranslate(f.file);
    await tick(); expect(f.capture).toHaveBeenCalledTimes(1);
    f.file.path = "renamed.md"; f.controller.onFileRenamed("source.md", f.file.path);
    f.requests[0]!.resolve({ kind: "ok", reviewText: "alpha :: 过时" }); await Promise.all([first, duplicate]);
    expect(f.glossary()).toBeUndefined();
    const renamed = f.controller.maybePretranslate(f.file);
    await tick(); expect(f.capture).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve({ kind: "ok", reviewText: "alpha :: 最新" }); await renamed;
    expect(f.glossary()?.complete).toBe(true);
  });

  it("drops the old glossary when the source changes during generation", async () => {
    const f = fixture(); f.changeContent("alpha");
    const pending = f.controller.maybePretranslate(f.file);
    await tick(); f.changeContent("edited source");
    f.requests[0]!.resolve({ kind: "ok", reviewText: "alpha :: 过时" }); await pending;
    expect(f.glossary()).toBeUndefined();
  });
});
