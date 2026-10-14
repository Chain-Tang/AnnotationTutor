// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupCancelled, StartupIdleTasks, StartupLifetime, StartupTimings, type StartupDiagnostic, type StartupStage } from "../src/startup.js";
import { BUILTIN_SKINS, mergeSkins, resolveRailSkin, type SkinDef } from "../src/skins.js";
import { SupportSession, type SupportSummary } from "../src/support-session.js";

// Run the production lifecycle and registry publication methods. Host services
// are test boundaries; no Obsidian, disk, credentials or network are accessed.
const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
function methods(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Startup host fixture boundaries changed");
  return source.slice(start, end);
}
const lifecycle = methods("  public override async onload()", "\n  /** Installation health") +
  methods("  public override onunload()", "\n  private async saveSettingsSecurely()") +
  methods("  private async saveSettingsSecurely()", "\n  public async persistSettings()") +
  methods("  private async initializeSupport(", "\n  /** Per-path serialization") +
  methods("  private async initializeTutorResults(", "\n  private saveExpertResult(") +
  methods("  public allSkins()", "\n  /**\n   * Push the annotation highlight color");
const code = transformSync(`class Host {${lifecycle}};module.exports=Host;`, { loader: "ts", format: "cjs" }).code;
type Host = {
  onload(): Promise<void>; onunload(): void;
  reloadSkins(): Promise<void>; createSkinFromTemplate(): Promise<string>;
  startupDiagnostics(): readonly StartupDiagnostic[];
  customSkins: SkinDef[];
  activeRailSkin(): { id: string };
  settings: { cardSkin: string };
};

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const registeredCleanups: Array<() => void> = [];

function fixture(options: { holdSettings?: boolean } = {}) {
  const credentials = deferred<{ state: "ready" }>(), journal = deferred<void>();
  const learning = deferred<void>(), results = deferred<void>(), skins = deferred<SkinDef[]>();
  const credentialInitialize = vi.fn(() => credentials.promise), journalInitialize = vi.fn(() => journal.promise);
  const learningLoad = vi.fn(() => learning.promise), resultInitialize = vi.fn(() => results.promise);
  const scan = vi.fn(() => skins.promise), applyCss = vi.fn(), unloadSkin = vi.fn();
  const supportSummaries = deferred<SupportSummary[]>();
  const supportLoad = vi.fn(() => supportSummaries.promise);
  const credentialDispose = vi.fn(), credentialFlush = vi.fn(async () => {}), credentialSave = vi.fn(async () => {}), journalDispose = vi.fn(async () => {});
  let persistJournalId: ((id: string) => Promise<void>) | undefined;
  const restoreTasks = vi.fn(), supportListeners = vi.fn();
  const settingRefresh = vi.fn(), displayRefresh = vi.fn(), registeredViews: string[] = [], layouts: Array<() => void> = [];
  const initialize = vi.fn(async () => {}), syncBoards = vi.fn(async () => {}), disposeBoards = vi.fn(async () => {});
  const noOp = () => {}, ready = async () => {}, notice = vi.fn();
  class Stub {}
  class Adapter {
    getFullPath(path: string) { return `/synthetic-vault/${path}`; }
    getBasePath() { return "/synthetic-vault"; }
  }
  const settings = { tutorSurfaceIds: {}, surfaceTransactionJournalId: "", boardConnectionMode: "inherit", persistChatLog: false,
    teachingMode: "guide", highlightStyle: "dotted-underline", cardSkin: "flat", memoryRoot: "Synthetic memory", learningFlowEnabled: true };
  const settingsRead = deferred<typeof settings>();
  if (!options.holdSettings) settingsRead.resolve(settings);
  const stageSettled = vi.fn<(stage: StartupStage) => void>(), credentialCreated = vi.fn();
  class InstrumentedTimings extends StartupTimings {
    public override async measure<T>(stage: StartupStage, run: () => T | Promise<T>): Promise<T> {
      const result = await super.measure(stage, run);
      stageSettled(stage);
      return result;
    }
  }
  const deps = {
    StartupCancelled, StartupIdleTasks, StartupLifetime, StartupTimings: InstrumentedTimings, BUILTIN_SKINS, mergeSkins, resolveRailSkin,
    FileSystemAdapter: Adapter,
    AtomicCredentialSettingsFile: class { read = () => settingsRead.promise; },
    migrateSettings: (loaded: object) => ({ ...loaded }), detectDesktopPrivateStorage: () => ({ appData: "/synthetic-private" }),
    PrivateCredentialStore: Stub,
    CredentialSettingsSession: class { constructor() { credentialCreated(); } initialize = credentialInitialize; flush = credentialFlush; save = credentialSave; dispose = credentialDispose; },
    DesktopStateIO: Stub,
    SurfaceTransactionJournal: class {
      constructor(_state: unknown, _file: string, _clock: unknown, options: { persistJournalId(id: string): Promise<void> }) { persistJournalId = options.persistJournalId; }
      initialize = journalInitialize; dispose = journalDispose;
    },
    setTeachingPolicy: noOp, DEFAULT_SETTINGS: { highlightStyle: "dotted-underline" }, Notice: class { constructor(text: string) { notice(text); } },
    t: (key: string) => key, VaultStore: Stub,
    TutorConversation: class { tasks = { subscribe: () => noOp, dispose: noOp, restore: restoreTasks }; dispose = noOp; },
    BoardDraftStore: Stub, BOARD_DRAFT_MAX_BYTES: 1000,
    InspirationBoards: class { editorExtension = {}; sync = syncBoards; dispose = disposeBoards; },
    LearningFlow: class { load = learningLoad; }, LearningEpisodeStore: Stub, learningVaultIO: noOp,
    TutorJournal: class { flush = ready; }, MemoryWatcher: class { dispose = noOp; },
    TutorResultStore: class { restoreResult = async () => { await resultInitialize(); return { tasks: [], completeness: "complete" }; }; },
    SupportSession, homedir: () => "/synthetic-home",
    PrivateSupportStore: class { available = () => true; readDay = async () => ""; load = supportLoad; save = ready; writeDay = ready; },
    SkinLoader: class { loadCustomSkins = scan; applyCss = applyCss; unload = unloadSkin; createFromTemplate = async () => "new-skin"; },
    AnnotationTutorLiteSettingTab: class { refresh = settingRefresh; },
    configureBoardFonts: noOp, normalizePath: (path: string) => path,
    annotationDecorations: {}, marginRailExtension: {}, setMarkerClickHandler: noOp, setMarginCardHandlers: noOp, setCardGeomStore: noOp,
    DASHBOARD_VIEW_TYPE: "dashboard", CHAT_VIEW_TYPE: "chat", BOARD_VIEW_TYPE: "studio",
    DefaultBoardToolRuntime: Stub, TranslationController: Stub, NotebookController: Stub, ReviewController: Stub,
    PAPER_TEXTURE: "synthetic-paper", LEAF_TEXTURE: "synthetic-leaf",
    boardConnectionKey: () => "connection", MarkdownView: Stub,
  };
  const module = { exports: {} };
  new Function("module", ...Object.keys(deps), code)(module, ...Object.values(deps));
  const Host = module.exports as { new(): Host }, host = new Host();
  Object.assign(host, {
    app: { vault: { adapter: new Adapter(), configDir: ".obsidian", on: noOp }, workspace: {
      containerEl: document.createElement("div"), iterateAllLeaves: noOp, getLeavesOfType: () => [],
      on: (event: string) => { if (event === "layout-change") supportListeners(); }, onLayoutReady: (run: () => void) => layouts.push(run),
    } },
    manifest: { id: "tutor-test", dir: "synthetic-plugin" }, customSkins: [], customSkinRefresh: null, pluginUnloaded: false,
    startupTimings: new StartupTimings(), startupIdle: new StartupIdleTasks(), startupLifetime: new StartupLifetime(), pluginLoading: null,
    applyLocale: noOp, applyHighlightColor: noOp, sharedTutorSettingsKey: () => "settings", initializeLearningDialogue: noOp,
    initialize, recoveredExpertRoots: new Set(), supportComposition: new Set(), supportPointers: new Map(), supportInputAt: 0,
    addCommand: noOp, addRibbonIcon: noOp, addSettingTab: noOp, registerEditorExtension: noOp,
    registerMarkdownPostProcessor: noOp, registerView: (type: string) => registeredViews.push(type), registerObsidianProtocolHandler: noOp,
    applyWebBridge: ready, applyBoardMcp: ready, addStatusBarItem: () => ({ addClass: noOp }), registerCommands: noOp,
    registerEvent: noOp, register: (cleanup: () => void) => registeredCleanups.push(cleanup), registerDomEvent: noOp, applyDisplaySettings: displayRefresh,
    externalGenerations: { close: ready }, learningRuns: new Map(), learningReaders: { clear: noOp }, learningCommitSubscriptions: [],
    clipperGeneration: 0, officialClipTimers: new Map(), readingRail: { detach: noOp }, pdfHighlighter: { detach: noOp },
    pdfSelection: { detach: noOp }, pdfRail: { detach: noOp },
  });
  const resolveRequired = () => { credentials.resolve({ state: "ready" }); journal.resolve(); learning.resolve(); supportSummaries.resolve([]); results.resolve(); };
  return { host, credentials, journal, learning, results, skins, credentialInitialize, journalInitialize, learningLoad, resultInitialize,
    scan, applyCss, unloadSkin, settingRefresh, displayRefresh, registeredViews, layouts, initialize, syncBoards, notice, resolveRequired,
    credentialDispose, credentialFlush, credentialSave, journalDispose, restoreTasks, supportSummaries, supportLoad, supportListeners, settingsRead, settings,
    persistJournalId: (id: string) => persistJournalId!(id), stageSettled, credentialCreated };
}

afterEach(() => { for (const cleanup of registeredCleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("production startup lifecycle", () => {
  it("blocks publication if unload wins the microtask gap after a measured settings read", async () => {
    const r = fixture(); r.resolveRequired();
    // Unload after the real waitFor and measurement resolve, immediately before
    // their caller resumes; cancellation cannot rely only on the IO helper.
    r.stageSettled.mockImplementation(stage => { if (stage === "settings") r.host.onunload(); });
    await r.host.onload();
    expect(r.credentialCreated).not.toHaveBeenCalled(); expect(r.registeredViews).toEqual([]);
    expect(r.host.startupDiagnostics().find(record => record.stage === "onload")?.status).toBe("cancelled");
  });

  it("keeps credentials alive until a pending journal identity becomes durable", async () => {
    const r = fixture(), events: string[] = [];
    r.credentialDispose.mockImplementation(() => { events.push("disposed"); });
    r.credentialSave.mockImplementation(async () => { expect(r.credentialDispose).not.toHaveBeenCalled(); events.push("identity-saved"); });
    r.journalInitialize.mockImplementationOnce(async () => { await r.journal.promise; await r.persistJournalId("durable-journal-id"); });
    r.credentials.resolve({ state: "ready" });
    const loading = r.host.onload();
    await vi.waitFor(() => expect(r.journalInitialize).toHaveBeenCalledOnce());
    r.host.onunload(); expect(r.credentialDispose).not.toHaveBeenCalled();
    r.journal.resolve(); await loading;
    await vi.waitFor(() => expect(r.credentialDispose).toHaveBeenCalled());
    expect(events).toEqual(["identity-saved", "disposed"]);
    expect(r.registeredViews).toEqual([]);
  });

  it.each(["settings", "credentials", "journal", "learning", "support", "results"] as const)("cancels a pending %s restore before later registration", async stage => {
    const r = fixture({ holdSettings: stage === "settings" }), loading = r.host.onload();
    const phases = ["settings", "credentials", "journal", "learning", "support", "results"];
    const position = phases.indexOf(stage);
    if (position >= 1) await vi.waitFor(() => expect(r.credentialInitialize).toHaveBeenCalledOnce());
    if (position >= 2) { r.credentials.resolve({ state: "ready" }); await vi.waitFor(() => expect(r.journalInitialize).toHaveBeenCalledOnce()); }
    if (position >= 3) { r.journal.resolve(); await vi.waitFor(() => expect(r.learningLoad).toHaveBeenCalledOnce()); }
    if (position >= 4) { r.learning.resolve(); await vi.waitFor(() => expect(r.supportLoad).toHaveBeenCalledOnce()); }
    if (position >= 5) { r.supportSummaries.resolve([]); await vi.waitFor(() => expect(r.resultInitialize).toHaveBeenCalledOnce()); }
    r.host.onunload();
    if (stage === "credentials" || stage === "journal") expect(r.credentialDispose).not.toHaveBeenCalled();
    r.settingsRead.resolve(r.settings); r.resolveRequired();
    await loading;
    await Promise.resolve(); await Promise.resolve();
    expect(r.registeredViews).toEqual([]); expect(r.layouts).toEqual([]); expect(r.scan).not.toHaveBeenCalled();
    expect(r.restoreTasks).not.toHaveBeenCalled();
    if (stage === "support") expect(r.supportListeners).not.toHaveBeenCalled();
    if (position >= 1) await vi.waitFor(() => expect(r.credentialDispose).toHaveBeenCalled());
    expect(r.host.startupDiagnostics().find(record => record.stage === "onload")?.status).toBe("cancelled");
    expect(r.host.startupDiagnostics().some(record => record.status === "running")).toBe(false);
  });

  it("keeps authorization and recovery gates ahead of registered views while deferring skin disk IO", async () => {
    vi.useFakeTimers(); vi.stubGlobal("requestIdleCallback", undefined);
    const r = fixture(), loading = r.host.onload();
    await vi.waitFor(() => expect(r.credentialInitialize).toHaveBeenCalledOnce());
    expect(r.journalInitialize).not.toHaveBeenCalled(); expect(r.registeredViews).toEqual([]);
    r.credentials.resolve({ state: "ready" });
    await vi.waitFor(() => expect(r.journalInitialize).toHaveBeenCalledOnce());
    expect(r.learningLoad).not.toHaveBeenCalled(); expect(r.registeredViews).toEqual([]);
    r.journal.resolve();
    await vi.waitFor(() => expect(r.learningLoad).toHaveBeenCalledOnce());
    expect(r.resultInitialize).not.toHaveBeenCalled(); expect(r.registeredViews).toEqual([]);
    r.learning.resolve();
    r.supportSummaries.resolve([]);
    await vi.waitFor(() => expect(r.resultInitialize).toHaveBeenCalledOnce());
    expect(r.registeredViews).toEqual([]);
    r.results.resolve(); await loading;
    expect(r.registeredViews).toEqual(["dashboard", "chat", "studio"]);
    expect(r.host.activeRailSkin().id).toBe("flat"); expect(r.scan).not.toHaveBeenCalled();
    r.layouts[0]!();
    expect(r.initialize).toHaveBeenCalledOnce(); expect(r.syncBoards).toHaveBeenCalledOnce();
    expect(r.scan).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(r.scan).toHaveBeenCalledOnce();
    expect(r.host.startupDiagnostics().find(record => record.stage === "onload")?.status).toBe("ready");
    expect(r.host.startupDiagnostics().find(record => record.stage === "custom-skins")?.status).toBe("running");
    r.skins.resolve([{ id: "autumn", name: "Autumn", builtin: false, quiet: true, css: ".atl-skin-autumn{}" }]);
    await r.host.reloadSkins();
    expect(r.host.customSkins).toHaveLength(1);
    expect(r.settingRefresh).toHaveBeenCalledOnce(); expect(r.displayRefresh).toHaveBeenCalledOnce();
    r.host.onunload();
  });

  it("fails credential startup without exposing views or leaking error text to timings", async () => {
    const r = fixture(), loading = r.host.onload(), error = new Error("PRIVATE_CREDENTIAL_PATH");
    const rejected = expect(loading).rejects.toBe(error);
    r.credentials.reject(error);
    await rejected;
    expect(r.registeredViews).toEqual([]); expect(r.journalInitialize).not.toHaveBeenCalled();
    expect(r.host.startupDiagnostics()).toContainEqual(expect.objectContaining({ stage: "credentials", status: "failed" }));
    expect(JSON.stringify(r.host.startupDiagnostics())).not.toContain("PRIVATE");
  });

  it("cancels deferred skin scanning if the plugin unloads before layout/idle", async () => {
    vi.useFakeTimers(); vi.stubGlobal("requestIdleCallback", undefined);
    const r = fixture(); r.resolveRequired(); await r.host.onload();
    r.host.onunload(); r.layouts[0]!(); vi.runOnlyPendingTimers();
    expect(r.initialize).not.toHaveBeenCalled(); expect(r.scan).not.toHaveBeenCalled();
    const s = fixture(); s.resolveRequired(); await s.host.onload();
    s.layouts[0]!(); s.host.onunload(); vi.runOnlyPendingTimers();
    expect(s.scan).not.toHaveBeenCalled();
  });

  it("coalesces manual and startup reloads and drops late registry results after unload", async () => {
    vi.useFakeTimers(); vi.stubGlobal("requestIdleCallback", undefined);
    const r = fixture(); r.resolveRequired(); await r.host.onload();
    const manual = r.host.reloadSkins(); r.layouts[0]!(); vi.runOnlyPendingTimers();
    expect(r.scan).toHaveBeenCalledOnce();
    r.host.onunload(); r.skins.resolve([{ id: "late", name: "Late", builtin: false, quiet: true }]);
    await manual;
    expect(r.host.customSkins).toEqual([]); expect(r.displayRefresh).not.toHaveBeenCalled();
    expect(r.settingRefresh).not.toHaveBeenCalled(); expect(r.applyCss).toHaveBeenCalledOnce();
  });

  it("skips automatic idle scans when the user already reloaded skins", async () => {
    vi.useFakeTimers(); vi.stubGlobal("requestIdleCallback", undefined);
    const r = fixture(); r.resolveRequired(); await r.host.onload();
    r.skins.resolve([]); await r.host.reloadSkins();
    r.layouts[0]!(); vi.runOnlyPendingTimers();
    expect(r.scan).toHaveBeenCalledOnce(); r.host.onunload();
  });

  it("keeps optional skin failures out of onload and allows a manual retry", async () => {
    vi.useFakeTimers(); vi.stubGlobal("requestIdleCallback", undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = fixture(); r.resolveRequired(); await r.host.onload();
    r.layouts[0]!(); vi.runOnlyPendingTimers();
    r.skins.reject(new Error("PRIVATE_SKIN_PATH"));
    await vi.waitFor(() => expect(r.host.startupDiagnostics()).toContainEqual(expect.objectContaining({ stage: "custom-skins", status: "failed" })));
    expect(r.host.startupDiagnostics().find(record => record.stage === "onload")?.status).toBe("ready");
    expect(JSON.stringify(r.host.startupDiagnostics())).not.toContain("PRIVATE");
    expect(log).toHaveBeenCalledOnce();
    r.scan.mockResolvedValueOnce([{ id: "retry", name: "Retry", builtin: false, quiet: true }]);
    await r.host.reloadSkins();
    expect(r.host.customSkins.map(skin => skin.id)).toEqual(["retry"]);
    expect(r.settingRefresh).toHaveBeenCalledOnce(); r.host.onunload();
  });

  it("preserves the published registry and CSS when a later reload fails", async () => {
    const r = fixture(); r.resolveRequired(); await r.host.onload();
    const original = { id: "autumn", name: "Autumn", builtin: false, quiet: true, css: ".atl-skin-autumn{}" };
    r.host.settings.cardSkin = original.id;
    r.skins.resolve([original]); await r.host.reloadSkins();
    const error = new Error("directory-read-unavailable");
    r.scan.mockRejectedValueOnce(error);
    await expect(r.host.reloadSkins()).rejects.toBe(error);
    expect(r.host.customSkins).toEqual([original]);
    expect(r.applyCss).toHaveBeenLastCalledWith(original);
    expect(r.settingRefresh).toHaveBeenCalledOnce();
    r.scan.mockResolvedValueOnce([]);
    await r.host.reloadSkins();
    expect(r.host.customSkins).toEqual([]); r.host.onunload();
  });
});
