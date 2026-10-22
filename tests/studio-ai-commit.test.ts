// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
vi.mock("obsidian", () => ({
  ItemView: class { contentEl = document.createElement("div"); containerEl = this.contentEl; app = {}; async setState() {} },
  Modal: class {}, Notice: class {}, Menu: class {}, setIcon: vi.fn(),
}));
import { StandaloneBoardView } from "../src/views/board-view.js";
import { createBoardDocument, type BoardHistory } from "../src/board-model.js";
import type { BoardAgent, BoardAgentResult, BoardBundle, BoardObject, BoardOperation, ImageGenerationCandidate, ImageGenerationProvider } from "../src/board-types.js";
import { TutorTaskCoordinator } from "../src/tutor-task.js";
import { surfaceJournalFixture } from "./surface-journal-fixture.js";
import { setLocale, t } from "../src/i18n.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
const object = (id: string, actor: "human" | "tutor" = "tutor"): BoardObject => ({
  id, kind: "rect", anchor: { kind: "canvas", pageId: "main" }, x: 0, y: 0, width: 20, height: 20,
  color: "#000000", strokeWidth: 2, createdBy: actor, editedBy: actor, revision: 1, groupId: "fixture",
});
const success = (operations: BoardOperation[]): BoardAgentResult => ({ ok: true, operations, description: "Synthetic preview", requestId: "fixture", baseRevision: 0 });
type InternalView = {
  renderShell(): void; preview(): string; snapshotForObjects(): unknown; schedule(): void;
  openAiCreationPanel(button: HTMLButtonElement): void; selectedIds: Set<string>; history: BoardHistory;
};
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("Option", function(text: string, value: string) { const option = document.createElement("option"); option.text = text; option.value = value; return option; });
  const create = function(this: HTMLElement, tag: string, options?: { cls?: string; text?: string; type?: string; attr?: Record<string, string> }) {
    const element = document.createElement(tag); if (options?.cls) element.className = options.cls;
    if (options?.text) element.textContent = options.text;
    if (options?.type) element.setAttribute("type", options.type);
    for (const [key, value] of Object.entries(options?.attr ?? {})) element.setAttribute(key, value);
    this.append(element); return element;
  };
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); }, addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
    toggleClass(this: HTMLElement, cls: string, value: boolean) { this.classList.toggle(cls, value); },
    createEl: create, createDiv(this: HTMLElement, options?: object) { return create.call(this, "div", options); },
    createSpan(this: HTMLElement, options?: object) { return create.call(this, "span", options); },
    appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); },
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-candidate");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(options: { objects?: BoardObject[]; operations?: BoardOperation[]; request?: BoardAgent["request"]; save?: () => Promise<void>; provider?: ImageGenerationProvider; saveAsset?: () => Promise<void>; writeExport?: () => Promise<void> } = {}) {
  const journal = surfaceJournalFixture(), tasks = new TutorTaskCoordinator();
  const bundle: BoardBundle = { document: { ...createBoardDocument("fixture.tutorboard.md", "standalone", "studio-fixture"), objects: options.objects ?? [] }, ink: {} };
  const request = vi.fn(options.request ?? (async () => success(options.operations ?? [{ type: "add", object: object("added") }])));
  const agent: BoardAgent = { request, cancel: vi.fn(), dispose: vi.fn() };
  const save = vi.fn(options.save ?? (async () => {})), saveAsset = vi.fn(options.saveAsset ?? (async () => {})), writeExport = vi.fn(options.writeExport ?? (async () => {}));
  const view = new StandaloneBoardView({} as WorkspaceLeaf, {
    open: async () => structuredClone(bundle), save, assets: async () => [], tasks, transactions: journal.journal,
    createAgent: () => agent, createImageProvider: () => options.provider ?? null, saveAsset, writeExport, imageAssetFolder: () => "synthetic-assets",
  });
  const internal = view as unknown as InternalView;
  vi.spyOn(internal, "renderShell").mockImplementation(() => { view.contentEl.empty(); view.contentEl.createEl("button", { text: "trigger" }); });
  vi.spyOn(internal, "preview").mockReturnValue("<svg/>"); vi.spyOn(internal, "schedule").mockImplementation(() => {});
  vi.spyOn(internal, "snapshotForObjects").mockReturnValue({ pngBase64: "fixture", width: 1024, height: 1024, imageToBoard: [1, 0, 0, 1, 0, 0], anchor: { kind: "canvas", pageId: "main" }, layoutRevision: "fixture" });
  document.body.append(view.contentEl); await view.setState({ sourceFile: "fixture.tutorboard.md" }, { history: false }); await view.whenReady();
  cleanup.push(async () => { await view.onClose(); tasks.dispose(); });
  internal.openAiCreationPanel(view.contentEl.querySelector("button")!);
  const panel = view.contentEl.querySelector<HTMLElement>(".atl-studio-ai-panel")!;
  const run = panel.querySelector<HTMLButtonElement>('[data-action="generate"]')!, mode = panel.querySelector<HTMLSelectElement>('select[aria-label="创作模式"]')!;
  const button = (text: string) => [...panel.querySelectorAll("button")].find(item => item.textContent === text)!;
  const click = async (item: HTMLButtonElement) => { await item.onclick?.call(item, new PointerEvent("click")); };
  const selectMode = (value: string) => { mode.value = value; mode.dispatchEvent(new Event("change")); };
  selectMode("math"); panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="创作要求"]')!.value = "Synthetic drawing";
  return { view, internal, panel, run, tasks, journal, save, saveAsset, writeExport, request, button, click, selectMode,
    status: () => panel.querySelector(".atl-studio-ai-status")!.textContent ?? "", task: () => tasks.list("obsidian")[0]!,
    objects: () => internal.history.document.objects };
}

describe("Studio AI confirmation through R04 transactions", () => {
  it("commits a large native preview once, preserves unrelated objects and provides one durable undo step", async () => {
    const operations: BoardOperation[] = Array.from({ length: 140 }, (_, index) => ({ type: "add", object: object(`new-${index}`) }));
    const f = await fixture({ objects: [object("human", "human")], operations }), original = structuredClone(f.objects()[0]);
    await f.click(f.run); expect(f.save).not.toHaveBeenCalled(); expect(f.objects()).toHaveLength(1);
    await f.click(f.run); expect(f.objects()).toHaveLength(141); expect(f.objects()[0]).toEqual(original);
    expect(f.task().commit).toMatchObject({ durability: "committed", updatedIds: [], deletedIds: [] });
    expect(f.task().commit!.createdIds).toHaveLength(140); expect(f.task().state).toBe("completed"); expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.status()).toContain("已保存"); f.internal.history.undo(); expect(f.objects()).toEqual([original]); expect(f.internal.history.canUndo).toBe(false);
  });

  it.each([true, false])("uses only the selection fixed before generation (initially granted: %s)", async initiallyGranted => {
    const reply = deferred<BoardAgentResult>(), existing = object("other-task-tutor"), f = await fixture({ objects: [existing], request: async () => reply.promise });
    if (initiallyGranted) f.internal.selectedIds.add(existing.id);
    const generation = f.click(f.run); await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    if (initiallyGranted) f.internal.selectedIds.clear(); else f.internal.selectedIds.add(existing.id);
    reply.resolve(success([{ type: "update", objectId: existing.id, expectedRevision: 1, object: { ...existing, x: 80, revision: 2 } }]));
    await generation; await f.click(f.run);
    expect(f.objects()[0]!.x).toBe(initiallyGranted ? 80 : 0);
    expect(f.save).toHaveBeenCalledTimes(initiallyGranted ? 1 : 0);
    expect(f.task().state).toBe(initiallyGranted ? "completed" : "failed");
    if (!initiallyGranted) expect(f.status()).toContain("outside-grant");
  });

  it("keeps an applied unsaved drawing and retries only its save after inspection", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("fixture disk failure")).mockResolvedValue(undefined);
    const f = await fixture({ save }); await f.click(f.run); await f.click(f.run);
    expect(f.task().commit?.durability).toBe("applied-not-durable"); expect(f.task().state).toBe("input-required");
    expect(f.objects()).toHaveLength(1); expect(f.status()).toContain("需要核对"); expect(f.run.disabled).toBe(true);
    await f.click(f.run); expect(f.request).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1);
    await f.click(f.button("核对保存结果")); expect(f.button("只重试保存").hidden).toBe(false);
    await f.click(f.button("只重试保存")); expect(f.task().commit?.durability).toBe("committed"); expect(f.task().state).toBe("completed");
    expect(f.request).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(2); expect(f.objects()).toHaveLength(1);
    f.internal.history.undo(); expect(f.objects()).toHaveLength(0); expect(f.internal.history.canUndo).toBe(false);
  });

  it("cancelling before application leaves the original scene untouched and records a cancelled task", async () => {
    const f = await fixture(), release = deferred(), entered = deferred(); await f.click(f.run);
    const originalWrite = f.journal.io.compareWrite;
    vi.spyOn(f.journal.io, "compareWrite").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await originalWrite(...args); });
    const applying = f.click(f.run); await entered.promise; await f.click(f.button("取消本次")); release.resolve(); await applying;
    expect(f.objects()).toHaveLength(0); expect(f.save).not.toHaveBeenCalled(); expect(f.task().state).toBe("cancelled");
    expect(f.status()).toMatch(/没有应用|原作品没有改变/);
  });

  it("cancellation during a successful save does not claim the original drawing was unchanged", async () => {
    const saving = deferred(), release = deferred(), f = await fixture({ save: async () => { saving.resolve(); await release.promise; } });
    await f.click(f.run); const applying = f.click(f.run); await saving.promise;
    await f.click(f.button("取消本次")); expect(f.status()).toContain("核对"); expect(f.status()).not.toContain("原作品没有改变");
    release.resolve(); await applying;
    expect(f.task().state).toBe("completed"); expect(f.task().phase).toBe("committed-after-cancel"); expect(f.task().commit?.durability).toBe("committed");
    expect(f.objects()).toHaveLength(1); expect(f.status()).toContain("已保存");
  });

  it("keeps the committed receipt when the panel closes while its save finishes", async () => {
    const saving = deferred(), release = deferred(), f = await fixture({ save: async () => { saving.resolve(); await release.promise; } });
    await f.click(f.run); const applying = f.click(f.run); await saving.promise;
    await f.click(f.panel.querySelector<HTMLButtonElement>('[aria-label="关闭共画面板"]')!);
    expect(f.panel.isConnected).toBe(false); release.resolve(); await applying;
    expect(f.task().commit?.durability).toBe("committed"); expect(f.task().phase).toBe("committed-after-cancel");
    expect(f.task().state).toBe("completed"); expect(f.objects()).toHaveLength(1); expect(f.save).toHaveBeenCalledTimes(1);
  });

  it("does not start a protocol repair after the generation is cancelled", async () => {
    const reply = deferred<BoardAgentResult>(), f = await fixture({ request: async () => reply.promise });
    const generation = f.click(f.run); await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    await f.click(f.button("取消本次")); reply.resolve({ ok: false, code: "invalid-response", error: "drawing-request-produced-no-objects" });
    await generation; expect(f.request).toHaveBeenCalledTimes(1); expect(f.objects()).toHaveLength(0); expect(f.task().state).toBe("cancelled");
  });

  it("rejects a stale preview without replacing later human work", async () => {
    const f = await fixture(); await f.click(f.run);
    f.internal.history.transact(document => { document.objects.push(object("later-human", "human")); });
    await f.click(f.run); expect(f.objects().map(item => item.id)).toEqual(["later-human"]); expect(f.save).not.toHaveBeenCalled();
    expect(f.task().state).toBe("failed"); expect(f.status()).toContain("revision-conflict");
  });
});

function imageProvider(): ImageGenerationProvider {
  const candidate: ImageGenerationCandidate = { id: "image-fixture", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", width: 1024, height: 1024, model: "fixture", latencyMs: 1, provenance: { provider: "fixture", generatedAt: new Date().toISOString() } };
  return { id: "fixture", availability: async () => ({ available: true }), capabilities: async () => ({ generation: true, editing: true, mask: false, references: false, transparency: false, partialPreviews: false, seed: false }),
    generate: vi.fn(async () => [candidate]), edit: vi.fn(async () => [candidate]), cancel: vi.fn() };
}
describe("Studio generated image insertion", () => {
  it("does not start image generation after cancellation during provider availability", async () => {
    const available = deferred<{ available: boolean }>(), provider = imageProvider();
    provider.availability = vi.fn(() => available.promise);
    const f = await fixture({ provider }); f.selectMode("illustration"); const generation = f.click(f.run);
    await vi.waitFor(() => expect(provider.availability).toHaveBeenCalledOnce()); await f.click(f.button("取消本次"));
    available.resolve({ available: true }); await generation;
    expect(provider.generate).not.toHaveBeenCalled(); expect(f.writeExport).not.toHaveBeenCalled(); expect(f.task().state).toBe("cancelled");
  });

  it("awaits candidate bytes and profile persistence before a single receipted insertion", async () => {
    const bytesReady = deferred(), writingBytes = deferred(), profileReady = deferred(), writingProfile = deferred();
    const f = await fixture({ provider: imageProvider(), writeExport: async () => { writingBytes.resolve(); await bytesReady.promise; }, saveAsset: async () => { writingProfile.resolve(); await profileReady.promise; } });
    f.selectMode("illustration"); const generation = f.click(f.run); await writingBytes.promise;
    expect(f.saveAsset).not.toHaveBeenCalled(); expect(f.objects()).toHaveLength(0); bytesReady.resolve(); await generation;
    const insert = f.button(t("board.insertCandidate")), inserting = f.click(insert); await writingProfile.promise;
    await f.click(insert); expect(f.saveAsset).toHaveBeenCalledTimes(1); expect(f.objects()).toHaveLength(0); expect(f.save).not.toHaveBeenCalled();
    profileReady.resolve(); await inserting;
    expect(f.objects()).toHaveLength(1); expect(f.objects()[0]!.kind).toBe("sticker"); expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.task().commit).toMatchObject({ durability: "committed", resources: [expect.objectContaining({ kind: "character" })] });
    expect(f.task().state).toBe("completed");
  });

  it("cancelling while the candidate profile saves prevents insertion after the late save", async () => {
    const profileReady = deferred(), writingProfile = deferred(), provider = imageProvider();
    const f = await fixture({ provider, saveAsset: async () => { writingProfile.resolve(); await profileReady.promise; } });
    f.selectMode("illustration"); await f.click(f.run); const inserting = f.click(f.button(t("board.insertCandidate"))); await writingProfile.promise;
    await f.click(f.button("取消本次")); profileReady.resolve(); await inserting;
    expect(f.objects()).toHaveLength(0); expect(f.save).not.toHaveBeenCalled(); expect(f.task().state).toBe("cancelled"); expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("retains generated candidates when profile persistence fails and retries storage without generating again", async () => {
    const saveAsset = vi.fn().mockRejectedValueOnce(new Error("fixture profile failure")).mockResolvedValue(undefined), provider = imageProvider();
    const f = await fixture({ provider, saveAsset }); f.selectMode("illustration"); await f.click(f.run);
    const insert = f.button(t("board.insertCandidate")); await f.click(insert);
    expect(f.objects()).toHaveLength(0); expect(f.save).not.toHaveBeenCalled(); expect(f.status()).toContain("资源保存未确认");
    expect(insert.disabled).toBe(false); await f.click(insert);
    expect(saveAsset).toHaveBeenCalledTimes(2); expect(saveAsset.mock.calls[0]).toEqual(saveAsset.mock.calls[1]);
    expect(provider.generate).toHaveBeenCalledTimes(1); expect(f.writeExport).toHaveBeenCalledTimes(1);
    expect(f.objects()).toHaveLength(1); expect(f.task().commit?.durability).toBe("committed");
  });
});
