import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupCancelled, StartupIdleTasks, StartupLifetime } from "../src/startup.js";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
function method(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Startup service fixture boundaries changed");
  return source.slice(start, end);
}
const methods = method("  private async stopBoardMcp()", "\n  private sharedTutorSettingsKey()") +
  method("  public applyWebBridge(", "\n  private async onBridgeCapture(") +
  method("  public override onunload()", "\n  private async saveSettingsSecurely()");
const code = transformSync(`class Host {${methods}};module.exports=Host;`, { loader: "ts", format: "cjs" }).code;
type Host = {
  applyBoardMcp(): Promise<void>; applyWebBridge(): Promise<void>; onunload(): void;
  mcpApply: Promise<void>; clipperApply: Promise<unknown>; boardMcp: unknown;
  boardMcpEndpoint: unknown; tutorDiscoveryPath?: string;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const startup = new StartupLifetime(), listener = deferred<{ host: "127.0.0.1"; port: number; token: string }>();
  const discovery = deferred<string>(), policy = deferred<string | null>(), clipperState = deferred<unknown>();
  const stop = vi.fn(async () => {}), closeTools = vi.fn(async () => {}), makeServer = vi.fn(), makeTools = vi.fn();
  const start = vi.fn(() => listener.promise), publish = vi.fn(() => discovery.promise), remove = vi.fn(async () => {});
  const readPolicy = vi.fn(() => policy.promise), readClipperState = vi.fn(() => clipperState.promise), makeWeb = vi.fn();
  const saveSettings = vi.fn(async () => {}), pair = vi.fn(async () => ({})), notice = vi.fn();
  let serverOptions: { authenticate(token: string): unknown; pair(name: string, signal: AbortSignal): Promise<unknown> } | undefined;
  class Adapter { getBasePath() { return "/synthetic-vault"; } }
  const noOp = () => {}, ready = async () => {};
  const deps = {
    StartupCancelled, FileSystemAdapter: Adapter,
    TutorMcpTools: class { constructor() { makeTools(); } close = closeTools; },
    TutorA2AService: class {},
    LocalBoardMcpAdapter: class {
      constructor(_runtime: unknown, options: NonNullable<typeof serverOptions>) { makeServer(); serverOptions = options; }
      start = start; stop = stop;
    },
    publishTutorInstance: publish, removeTutorInstance: remove,
    authenticateTutorClient: () => ({ clientId: "client", read: true, write: true }),
    loadClipperState: readClipperState, clipperDigest: () => "synthetic-vault-id",
    WEB_BRIDGE_DISCOVERY_PORTS: [3100], WebBridgeServer: class { constructor() { makeWeb(); } },
    Notice: class { constructor(text: string) { notice(text); } },
    setMarkerClickHandler: noOp, setMarginCardHandlers: noOp, setCardGeomStore: noOp,
  };
  const module = { exports: {} };
  new Function("module", ...Object.keys(deps), code)(module, ...Object.values(deps));
  const Host = module.exports as { new(): Host }, host = new Host();
  Object.assign(host, {
    startupLifetime: startup, startupIdle: new StartupIdleTasks(), pluginUnloaded: false, pluginLoading: null,
    mcpApply: Promise.resolve(), clipperApply: Promise.resolve(), clipperGeneration: 0,
    app: { vault: { adapter: new Adapter(), getName: () => "Synthetic" } },
    settings: { boardMcpEnabled: true, boardMcpReadOnly: false, tutorPairings: [], webEnabled: true, webBridgePort: 3100 },
    upgrading: false, boardMcp: null, boardMcpEndpoint: null, tutorTools: undefined, webBridge: null,
    tutorConversation: { dispose: noOp, tasks: { dispose: noOp } }, boardToolRuntime: {},
    pairTutorClient: pair, externalGenerations: { close: ready }, learningRuns: new Map(), learningReaders: { clear: noOp },
    learningCommitSubscriptions: [], officialClipTimers: new Map(), readingRail: { detach: noOp }, pdfHighlighter: { detach: noOp },
    pdfSelection: { detach: noOp }, pdfRail: { detach: noOp },
    desktopState: { read: readPolicy }, webCaptureDir: () => "Synthetic capture", saveSettingsSecurely: saveSettings,
  });
  return { host, startup, listener, discovery, policy, clipperState, stop, closeTools, makeServer, makeTools, start, publish, remove,
    readPolicy, readClipperState, makeWeb, saveSettings, pair, notice, serverOptions: () => serverOptions! };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function useHostDocument() { vi.stubGlobal("document", { body: { style: { removeProperty() {} } } }); }

describe("production startup service cancellation", () => {
  it("does not start an MCP listener queued before unload", async () => {
    useHostDocument();
    const r = fixture(), queue = deferred<void>(); r.host.mcpApply = queue.promise;
    const applying = r.host.applyBoardMcp();
    r.host.onunload(); queue.resolve(); await applying;
    expect(r.makeTools).not.toHaveBeenCalled(); expect(r.start).not.toHaveBeenCalled();
    expect(r.publish).not.toHaveBeenCalled();
  });

  it("closes a late listener without publishing discovery or accepting new clients", async () => {
    useHostDocument();
    const r = fixture(), applying = r.host.applyBoardMcp();
    await vi.waitFor(() => expect(r.start).toHaveBeenCalledOnce());
    expect(r.serverOptions().authenticate("paired-token")).toMatchObject({ write: true });
    r.host.onunload();
    expect(r.serverOptions().authenticate("paired-token")).toBeUndefined();
    await expect(r.serverOptions().pair("client", new AbortController().signal)).rejects.toBeInstanceOf(StartupCancelled);
    expect(r.pair).not.toHaveBeenCalled();
    r.listener.resolve({ host: "127.0.0.1", port: 3100, token: "synthetic" }); await applying;
    expect(r.publish).not.toHaveBeenCalled(); expect(r.stop).toHaveBeenCalled(); expect(r.closeTools).toHaveBeenCalled();
    expect(r.host.boardMcp).toBeNull(); expect(r.host.boardMcpEndpoint).toBeNull();
  });

  it("removes a discovery file whose persistence finished after unload", async () => {
    useHostDocument();
    const r = fixture(), applying = r.host.applyBoardMcp();
    r.listener.resolve({ host: "127.0.0.1", port: 3100, token: "synthetic" });
    await vi.waitFor(() => expect(r.publish).toHaveBeenCalledOnce());
    r.host.onunload(); r.discovery.resolve("/synthetic-private/instance.json"); await applying;
    expect(r.remove).toHaveBeenCalledWith("/synthetic-private/instance.json");
    expect(r.host.tutorDiscoveryPath).toBeUndefined(); expect(r.host.boardMcpEndpoint).toBeNull();
    expect(r.stop).toHaveBeenCalled(); expect(r.closeTools).toHaveBeenCalled();
  });

  it("keeps ordinary MCP startup and its durable discovery cleanup", async () => {
    useHostDocument();
    const r = fixture(), endpoint = { host: "127.0.0.1" as const, port: 3100, token: "synthetic" };
    r.listener.resolve(endpoint); r.discovery.resolve("/synthetic-private/instance.json");
    await r.host.applyBoardMcp();
    expect(r.host.boardMcpEndpoint).toEqual(endpoint); expect(r.host.tutorDiscoveryPath).toBe("/synthetic-private/instance.json");
    r.host.onunload(); expect(r.remove).toHaveBeenCalledWith("/synthetic-private/instance.json");
    expect(r.stop).toHaveBeenCalledOnce(); expect(r.closeTools).toHaveBeenCalledOnce();
  });

  it("drops a late Clipper policy read without changing settings or showing a notice", async () => {
    useHostDocument();
    const r = fixture(), applying = r.host.applyWebBridge();
    await vi.waitFor(() => expect(r.readPolicy).toHaveBeenCalledOnce());
    r.host.onunload(); r.policy.resolve(null); await applying;
    expect(r.saveSettings).not.toHaveBeenCalled(); expect(r.notice).not.toHaveBeenCalled();
    expect(r.readClipperState).not.toHaveBeenCalled(); expect(r.makeWeb).not.toHaveBeenCalled();
  });

  it("drops late Clipper restore failures quietly after unload", async () => {
    useHostDocument();
    const r = fixture(), applying = r.host.applyWebBridge();
    r.policy.resolve("policy"); await vi.waitFor(() => expect(r.readClipperState).toHaveBeenCalledOnce());
    r.host.onunload(); r.clipperState.reject(new Error("PRIVATE_CLIPPER_STATE_ERROR")); await applying;
    expect(r.notice).not.toHaveBeenCalled(); expect(r.makeWeb).not.toHaveBeenCalled();
  });
});
