import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { StartupCancelled, StartupLifetime } from "../src/startup.js";
import { emptyLibrarySnapshot, type LibrarySnapshot } from "../src/library-index.js";
import { GenerationRefreshQueue } from "../src/refresh-queue.js";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
function method(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Layout startup fixture boundaries changed");
  return source.slice(start, end);
}
const methods = method("  private async initialize(", "\n  /**\n   * Query the agent CLI") +
  method("  public async refreshAvailableModels()", "\n  /**\n   * Prepend the login-shell PATH") +
  method("  public async rebuildIndex(", "\n  // --- watcher reconcile");
const code = transformSync(`class Host {${methods}};module.exports=Host;`, { loader: "ts", format: "cjs" }).code;
type Host = {
  initialize(startup?: StartupLifetime): Promise<void>;
  rebuildIndex(notify: boolean): Promise<void>;
  refreshIndex(notify: boolean, paths?: string[]): Promise<void>;
  commit(): Promise<void>;
  refreshAvailableModels(): Promise<unknown>;
  pluginUnloaded: boolean;
  librarySnapshot: LibrarySnapshot;
  availableModels: string[];
  modelsLoaded: boolean;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const startup = new StartupLifetime(), scaffold = deferred<void>(), cache = deferred<LibrarySnapshot | null>();
  const index = deferred<LibrarySnapshot>(), migration = deferred<void>(), models = deferred<{ ok: true; models: string[] }>();
  const initial = emptyLibrarySnapshot(), next = emptyLibrarySnapshot();
  const store = {
    ensureScaffold: vi.fn(() => scaffold.promise), loadLibraryCache: vi.fn(() => cache.promise),
    rebuildLibrary: vi.fn(() => index.promise), refreshLibrary: vi.fn(async () => next), syncScenesFromCells: vi.fn(async (_full?: boolean) => {}),
  };
  const warmModels = vi.fn(() => models.promise), pretranslate = vi.fn(), migrate = vi.fn(() => migration.promise);
  const refreshDashboard = vi.fn(), refreshSettings = vi.fn(), refreshBadge = vi.fn(), refreshDecorations = vi.fn(async () => {});
  const replaceIndex = vi.fn(), persistSettings = vi.fn(async () => {}), chooseModel = vi.fn(() => "provider/new-model");
  const module = { exports: {} };
  const deps = { resolveBoardConnection: () => ({ engine: "api" }), listModels: warmModels, pickDefaultModel: chooseModel,
    Notice: class {}, t: (key: string) => key, GenerationRefreshQueue };
  new Function("module", ...Object.keys(deps), code)(module, ...Object.values(deps));
  const Host = module.exports as { new(): Host }, host = new Host();
  Object.assign(host, {
    startupLifetime: startup, pluginUnloaded: false, librarySnapshot: initial, indexRefresh: Promise.resolve(), store,
    app: { workspace: { getActiveFile: () => ({ extension: "md", path: "synthetic.md" }) } },
    settings: { reviewEngine: "opencode", chatEngine: "api", agentCommand: "opencode", agentModel: "", webAutoAnalyze: false },
    translation: { maybePretranslate: pretranslate }, migrateTableAnchors: migrate, availableModels: [], modelsLoaded: false,
    refreshDashboard, settingTab: { refresh: refreshSettings }, review: { refreshBadge }, refreshDecorations,
    indexTable: { replaceAll: replaceIndex }, agentSpawnEnv: () => ({}), persistSettings,
  });
  const unload = () => { host.pluginUnloaded = true; startup.cancel(); };
  return { host, startup, scaffold, cache, index, migration, models, initial, next, store, warmModels, pretranslate, migrate,
    refreshDashboard, refreshSettings, refreshBadge, refreshDecorations, replaceIndex, persistSettings, chooseModel, unload };
}

describe("production layout startup", () => {
  it.each(["scaffold", "cache", "index", "migration"] as const)("stops follow-up work when unloading during %s IO", async stage => {
    const r = fixture(), initializing = r.host.initialize();
    const phases = ["scaffold", "cache", "index", "migration"], position = phases.indexOf(stage);
    const cancelled = expect(initializing).rejects.toBeInstanceOf(StartupCancelled);
    expect(r.store.ensureScaffold).toHaveBeenCalledOnce();
    if (position >= 1) { r.scaffold.resolve(); await vi.waitFor(() => expect(r.store.loadLibraryCache).toHaveBeenCalledOnce()); }
    if (position >= 2) { r.cache.resolve(null); await vi.waitFor(() => expect(r.store.rebuildLibrary).toHaveBeenCalledOnce()); }
    if (position >= 3) { r.index.resolve(r.next); await vi.waitFor(() => expect(r.migrate).toHaveBeenCalledOnce()); }
    r.unload(); r.scaffold.resolve(); r.cache.resolve(null); r.index.resolve(r.next); r.migration.resolve();
    await cancelled;
    expect(r.pretranslate).not.toHaveBeenCalled();
    if (position < 3) {
      expect(r.warmModels).not.toHaveBeenCalled(); expect(r.refreshDashboard).not.toHaveBeenCalled();
      expect(r.refreshSettings).not.toHaveBeenCalled(); expect(r.replaceIndex).not.toHaveBeenCalled();
      expect(r.host.librarySnapshot).toBe(r.initial);
    } else {
      expect(r.warmModels).toHaveBeenCalledOnce();
      r.models.resolve({ ok: true, models: ["provider/new-model"] });
      await Promise.resolve(); await Promise.resolve();
      expect(r.persistSettings).not.toHaveBeenCalled(); expect(r.host.modelsLoaded).toBe(false);
    }
  });

  it("does not publish an already-started model warmup after unloading", async () => {
    const r = fixture(), listing = r.host.refreshAvailableModels();
    expect(r.warmModels).toHaveBeenCalledOnce();
    r.unload(); const result = { ok: true as const, models: ["provider/new-model"] };
    r.models.resolve(result); await expect(listing).resolves.toEqual(result);
    expect(r.host.availableModels).toEqual([]); expect(r.host.modelsLoaded).toBe(false);
    expect(r.chooseModel).not.toHaveBeenCalled(); expect(r.persistSettings).not.toHaveBeenCalled();
  });
});

describe("manual scene and index repair", () => {
  it("waits for full scene repair before rebuilding the index; automatic refresh remains incremental", async () => {
    const r = fixture(), scene = deferred<void>(), events: string[] = [];
    r.store.syncScenesFromCells.mockImplementationOnce(async () => { events.push("scenes"); await scene.promise; });
    r.store.rebuildLibrary.mockImplementation(async () => { events.push("index"); return r.next; });
    const repairing = r.host.rebuildIndex(true);
    await vi.waitFor(() => expect(r.store.syncScenesFromCells).toHaveBeenCalledWith(true)); expect(r.store.rebuildLibrary).not.toHaveBeenCalled();
    scene.resolve(); await repairing;
    expect(events).toEqual(["scenes", "index"]);
    await r.host.rebuildIndex(false); await r.host.commit();
    expect(r.store.syncScenesFromCells).toHaveBeenCalledOnce();
    expect(r.store.refreshLibrary).toHaveBeenCalledWith(r.next, []);
    r.unload(); await r.host.rebuildIndex(true);
    expect(r.store.syncScenesFromCells).toHaveBeenCalledOnce();
  });

  it("publishes a same-tick batch once, promoting manual scene repair and the full index read", async () => {
    const r = fixture(); r.store.rebuildLibrary.mockResolvedValue(r.next);
    const pending = Array.from({ length: 9 }, () => r.host.commit());
    pending.push(r.host.rebuildIndex(true));
    await Promise.all(pending);
    expect(r.store.syncScenesFromCells).toHaveBeenCalledOnce();
    expect(r.store.rebuildLibrary).toHaveBeenCalledOnce(); expect(r.store.refreshLibrary).not.toHaveBeenCalled();
    expect(r.refreshDashboard).toHaveBeenCalledOnce(); expect(r.refreshSettings).toHaveBeenCalledOnce();
    expect(r.refreshDecorations).toHaveBeenCalledOnce(); expect(r.replaceIndex).toHaveBeenCalledOnce();
  });

  it("unions incremental paths into one later round and keeps the completion barrier pending", async () => {
    const r = fixture(), first = deferred<LibrarySnapshot>();
    r.store.refreshLibrary.mockImplementationOnce(() => first.promise);
    const initial = r.host.commit();
    await vi.waitFor(() => expect(r.store.refreshLibrary).toHaveBeenCalledOnce());
    const pending = Array.from({ length: 10 }, (_, i) => r.host.refreshIndex(false, [`file-${i}.md`]));
    let complete = false;
    void Promise.all(pending).then(() => { complete = true; });
    first.resolve(r.next); await initial;
    await Promise.all(pending);
    expect(complete).toBe(true); expect(r.store.refreshLibrary).toHaveBeenCalledTimes(2);
    expect(r.store.refreshLibrary).toHaveBeenLastCalledWith(r.next, Array.from({ length: 10 }, (_, i) => `file-${i}.md`));
    expect(r.refreshDashboard).toHaveBeenCalledTimes(2);
  });

  it("returns a failed generation to every caller and permits the next refresh", async () => {
    const r = fixture(); r.store.refreshLibrary.mockRejectedValueOnce(new Error("disk failed"));
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => r.host.commit()));
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(r.refreshDashboard).not.toHaveBeenCalled();
    await r.host.commit(); expect(r.refreshDashboard).toHaveBeenCalledOnce();
  });
});
