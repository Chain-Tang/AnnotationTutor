import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { Annotation, IndexRecord } from "../src/model.js";
import type { AnnotationTutorLiteSettings } from "../src/settings.js";
import type { ReviewOutcome } from "../src/review-outcome.js";
import { IndexTable, recordFromAnnotation } from "../src/index-table.js";
import { makeId, nowIso } from "../src/ids.js";
import { defaultReviewRequest } from "../src/markdown/overview.js";
import { buildReviewPrompt } from "../src/agent-runner.js";
import { t } from "../src/i18n.js";
import { createMockApp } from "./helpers/obsidian-mock.js";
import { normalizePath, TFolder } from "./helpers/obsidian-mock.js";
import { normalizeMemoryRoot } from "../src/settings-config.js";
import { emptyLibrarySnapshot } from "../src/library-index.js";

vi.mock("obsidian", () => import("./helpers/obsidian-mock.js"));
const { VaultStore } = await import("../src/store.js");
// Execute the actual host workflow without loading unrelated Obsidian UI.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const methods = source.slice(source.indexOf("  public async askAgent(record:"), source.indexOf("  /** Direct-API engine:")) +
  source.slice(source.indexOf("  private async finishCreate("), source.indexOf("  /** Right-click in Reading view")) +
  source.slice(source.indexOf("  public async changeMemoryRoot("), source.indexOf("  public onSettingsChanged():"));
const code = transformSync(`class Host { requestingAgents = new Set(); runningAgents = new Set(); ${methods} }; module.exports = Host;`, { loader: "ts", format: "cjs" }).code;
type Host = { askAgent(record: IndexRecord): Promise<void>; finishCreate(annotation: Annotation, ask: boolean): Promise<void>; changeMemoryRoot(value: string): Promise<{ ok: boolean }>;
  runningAgents: Set<string>; requestingAgents: Set<string>; learningInputsPaused: boolean; indexRefresh: Promise<void> };

async function fixture(outcome: () => Promise<ReviewOutcome>, status: Annotation["status"] = "saved") {
  const app = createMockApp();
  const settings = { memoryRoot: "Agent Memory", autoRunAgent: true, reviewEngine: "api", apiModel: "fixture", agentTimeoutSeconds: 30, reviewLanguage: "Chinese" } as AnnotationTutorLiteSettings;
  const store = new VaultStore(app as unknown as App, "annotation-tutor-lite", () => settings);
  const annotation: Annotation = { id: "ANN-1", sourceFile: "source.md", anchor: { blockId: "anchor-1", selectedText: "Attention" }, userNote: "My note", status,
    concepts: [], relatedMemoryCells: [], createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z" };
  await store.createAnnotation(annotation);
  const record = recordFromAnnotation(annotation, store.annotationPath(annotation.id));
  const indexTable = new IndexTable([record]);
  const commits = vi.fn(async () => { const snapshot = await store.refreshLibrary(); indexTable.replaceAll(snapshot.annotations); });
  const notices: string[] = [];
  const Notice = class { constructor(text: string) { notices.push(text); } hide() {} };
  const module = { exports: {} };
  const dependencies = { Notice, t, makeId, nowIso, defaultReviewRequest, recordFromAnnotation, buildReviewPrompt, MIN_AGENT_TIMEOUT_SECONDS: 30,
    normalizePath, normalizeMemoryRoot, TFolder, emptyLibrarySnapshot, learningVaultIO: () => ({}),
    LearningFlow: class { constructor(..._args: unknown[]) {} }, LearningEpisodeStore: class { constructor(..._args: unknown[]) {} }, TutorJournal: class { constructor(..._args: unknown[]) {} } };
  new Function("module", ...Object.keys(dependencies), code)(module, ...Object.values(dependencies));
  const Constructor = module.exports as { new(): Host };
  const host = new Constructor();
  const capture = vi.fn(outcome), cell = vi.fn(async () => {});
  Object.assign(host, { settings, store, indexTable, commit: commits, captureApiReview: capture, captureOpenCodeReview: capture, learnerProfileSummary: () => "", activeSceneSummary: () => "", review: { autoSaveCellFromReview: cell } });
  return { host, record, store, capture, commits, cell, notices, settings, app, annotation };
}

describe("agent review failure recovery", () => {
  it.each<ReviewOutcome>([{ kind: "needs-key" }, { kind: "timeout" }, { kind: "failed", detail: "provider failed" }, { kind: "empty" }, { kind: "ok", reviewText: "  " }])("restores status and fails the inbox task for $kind", async outcome => {
    const f = await fixture(async () => outcome);
    await f.host.askAgent(f.record);
    expect((await f.store.readAnnotation("ANN-1"))?.status).toBe("saved");
    expect((await f.store.readTasks())[0]?.status).toBe("failed");
    expect(f.cell).not.toHaveBeenCalled();
    expect(f.host.runningAgents.size).toBe(0);
    expect(f.host.requestingAgents.size).toBe(0);
  });

  it.each(["reviewed", "archived", "source_missing"] as const)("restores the prior %s state when transport throws or cancels", async status => {
    const f = await fixture(async () => { throw new DOMException("Cancelled", "AbortError"); }, status);
    await f.host.askAgent(f.record);
    expect((await f.store.readAnnotation("ANN-1"))?.status).toBe(status);
    expect((await f.store.readTasks())[0]?.status).toBe("failed");
  });

  it("retains queued agent_requested state when auto-run is disabled", async () => {
    const f = await fixture(async () => ({ kind: "empty" }));
    f.settings.autoRunAgent = false;
    await f.host.askAgent(f.record);
    expect((await f.store.readAnnotation("ANN-1"))?.status).toBe("agent_requested");
    expect((await f.store.readTasks())[0]?.status).toBe("pending");
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous clicks before task creation and preserves an external archive", async () => {
    let resolve!: (outcome: ReviewOutcome) => void;
    const f = await fixture(() => new Promise(done => { resolve = done; }));
    const first = f.host.askAgent(f.record);
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(1));
    await f.host.askAgent(f.record);
    await f.store.updateAnnotation("ANN-1", { status: "archived" });
    resolve({ kind: "timeout" });
    await first;
    expect((await f.store.readTasks())).toHaveLength(1);
    expect((await f.store.readAnnotation("ANN-1"))?.status).toBe("archived");
    expect(f.capture).toHaveBeenCalledTimes(1);
  });

  it("marks a successful review completed and refreshes once after review/cell writes", async () => {
    const f = await fixture(async () => ({ kind: "ok", reviewText: "Helpful review" }));
    await f.host.askAgent(f.record);
    expect((await f.store.readAnnotation("ANN-1"))?.status).toBe("reviewed_unstructured");
    expect((await f.store.readTasks())[0]?.status).toBe("completed");
    expect(f.cell).toHaveBeenCalledExactlyOnceWith(f.record, "Helpful review");
    expect(f.commits).toHaveBeenCalledTimes(2);
  });

  it("preserves a review and completed task written by an external agent during a timed-out request", async () => {
    let resolve!: (outcome: ReviewOutcome) => void;
    const f = await fixture(() => new Promise(done => { resolve = done; }));
    const pending = f.host.askAgent(f.record);
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(1));
    await f.store.writeReview("ANN-1", "Externally completed review");
    await f.store.setTaskStatus((await f.store.readTasks())[0]!.id, "completed");
    resolve({ kind: "timeout" }); await pending;
    expect((await f.store.readAnnotation("ANN-1"))?.status).toBe("reviewed_unstructured");
    expect((await f.store.readTasks())[0]?.status).toBe("completed");
  });

  it("combines the initial save and review request into one awaited index refresh", async () => {
    const f = await fixture(async () => ({ kind: "ok", reviewText: "Helpful review" }));
    await f.host.finishCreate({ ...f.annotation, id: "ANN-2" }, true);
    expect(f.commits).toHaveBeenCalledTimes(2); // request + successful completion
    expect((await f.store.readAnnotation("ANN-2"))?.status).toBe("reviewed_unstructured");
    expect(f.notices[0]).toContain("ANN-2");
  });

  it("waits for the current index refresh before switching roots and rejects reviews during the switch", async () => {
    const f = await fixture(async () => ({ kind: "empty" }));
    let finishIndex!: () => void;
    f.host.indexRefresh = new Promise(done => { finishIndex = done; });
    const noOp = async () => {};
    Object.assign(f.host, { app: f.app, stopLearningRuns: noOp,
      tutorConversation: { cancel() {}, flush: noOp, tasks: { cancelAll() {} }, reset() {} },
      expertWrites: [], boards: { changeRoot: noOp, rootChanged() {} },
      initializeLearningDialogue() {}, initializeTutorResults: noOp, persistSettings: noOp,
      rebuildIndex: noOp, refreshChatViews() {} });
    const switching = f.host.changeMemoryRoot("New Memory");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.settings.memoryRoot).toBe("Agent Memory");
    expect(f.host.learningInputsPaused).toBe(true);
    await f.host.askAgent(f.record);
    expect(f.capture).not.toHaveBeenCalled();
    expect(await f.store.readTasks()).toHaveLength(0);
    finishIndex(); await expect(switching).resolves.toEqual({ ok: true });
    expect(f.settings.memoryRoot).toBe("New Memory");
    expect(f.host.learningInputsPaused).toBe(false);
  });

  it("does not switch memory roots while an annotation review is active", async () => {
    const f = await fixture(async () => ({ kind: "empty" }));
    f.host.requestingAgents.add("ANN-1");
    await expect(f.host.changeMemoryRoot("New Memory")).resolves.toMatchObject({ ok: false });
    expect(f.settings.memoryRoot).toBe("Agent Memory");
  });
});
