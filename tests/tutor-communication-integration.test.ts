// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { LocalBoardMcpAdapter } from "../src/board-mcp.js";
import { DefaultBoardToolRuntime } from "../src/board-tools.js";
import { authenticateTutorClient, createTutorPairing } from "../src/tutor-access.js";
import { StartupCancelled, StartupLifetime } from "../src/startup.js";
import type { TutorClientGrant } from "../src/tutor-mcp.js";
import type { CommunicationIdentity } from "../src/tutor-communication.js";
import { communicationIdentityKey } from "../src/tutor-communication.js";

// Execute the production host methods without opening a vault, starting a
// listener, reading credentials, or making a model request.
const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8").replace(/\r\n?/g, "\n");
function section(start: string, end: string): string {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  if (first < 0 || last < 0) throw new Error("Communication integration boundaries changed");
  return source.slice(first, last);
}
const fields = source.split("\n").filter(line => /^  private (?:readonly )?communication[A-Z]/.test(line) && !line.includes("(") && line.trim().endsWith(";")).join("\n");
const hostMethods = fields + section("  private tutorCommunication()", "\n  private tutorJournal?")
  + section("  private async pairTutorClient(", "\n  private sharedTutorSettingsKey()");
const code = transformSync(`class Host { ${hostMethods} };module.exports=Host;`, { loader: "ts", format: "cjs" }).code;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const peerIdentity: CommunicationIdentity = { agentId: "peer-agent", vaultId: "peer-vault", kind: "tutor" };
const grant = (): TutorClientGrant => ({ clientId: "client-1", name: "Peer", createdAt: "2026-10-16T00:00:00Z", communication: true, communicationIdentity: peerIdentity, read: false, write: false, learningMemory: false, documents: [], targets: [], humanObjectIds: [] });
function hostFixture() {
  class Adapter { getBasePath() { return "/synthetic-vault"; } }
  const created = deferred<Record<string, unknown>>();
  const hostIdentity: CommunicationIdentity = { agentId: "host-agent", vaultId: "host-vault", kind: "tutor" };
  const controller = { close: vi.fn(async () => {}), revoke: vi.fn(async (_identity: CommunicationIdentity) => {}), gateway: {}, identity: hostIdentity };
  const create = vi.fn(() => created.promise);
  const toolsOptions: Record<string, unknown>[] = [], serverOptions: Record<string, unknown>[] = [], modalArguments: unknown[][] = [];
  const serverStop = vi.fn(async () => {}), publish = vi.fn(async () => "/synthetic-discovery.json"), remove = vi.fn(async () => {});
  const saveSettings = vi.fn(async () => {});
  const deps = {
    TutorCommunicationController: { create }, FileSystemAdapter: Adapter, detectDesktopPrivateStorage: () => ({ appData: "/synthetic-state" }),
    tutorServiceRunner: () => { throw new Error("model-use-unexpected"); }, StartupCancelled, authenticateTutorClient, createTutorPairing, communicationIdentityKey,
    TutorPairingModal: class {
      constructor(...args: unknown[]) { modalArguments.push(args); }
      open() { (modalArguments.at(-1)![5] as (value: TutorClientGrant) => void)(grant()); }
      close() {}
    },
    TutorMcpTools: class { close = vi.fn(async () => {}); constructor(options: Record<string, unknown>) { toolsOptions.push(options); } },
    LocalBoardMcpAdapter: class { constructor(_runtime: unknown, options: Record<string, unknown>) { serverOptions.push(options); } start = async () => ({ host: "127.0.0.1", port: 12345, token: "legacy" }); stop = serverStop; },
    TutorA2AService: class {}, publishTutorInstance: publish, removeTutorInstance: remove,
  };
  const module = { exports: {} }; new Function("module", ...Object.keys(deps), code)(module, ...Object.values(deps));
  type Host = {
    tutorCommunication(): Promise<typeof controller>; stopTutorCommunication(): Promise<void>;
    setTutorCommunicationEnabled(enabled: boolean): Promise<void>;
    setTutorCommunicationEngine(engine:"inherit"|"codex"):Promise<void>;
    applyBoardMcpCurrent(startup?: StartupLifetime): Promise<void>;
    revokeTutorClient(clientId: string): Promise<void>; pairTutorClient(name: string, signal?: AbortSignal, identity?: CommunicationIdentity): Promise<{ token: string; clientId: string }>;
    communicationController?: typeof controller; communicationInitialization?: Promise<typeof controller>;
    pluginUnloaded: boolean; settings: { memoryRoot: string; boardMcpEnabled: boolean; boardMcpReadOnly: boolean; tutorCommunicationEnabled: boolean; tutorCommunicationEngine:"inherit"|"codex";chatEngine:string; tutorPairings: ReturnType<typeof createTutorPairing>["record"][] };
    tutorTools?: { revoke(clientId: string): void; close(): Promise<void> };
  };
  const Host = module.exports as { new(): Host }; const host = new Host();
  const tasks = { cancelAll: vi.fn() }, toolsRevoke = vi.fn();
  Object.assign(host, {
    pluginUnloaded: false, upgrading: false, learningInputsPaused: false,
    app: { vault: { adapter: new Adapter(), getName: () => "Synthetic" }, workspace: { getActiveFile: () => null } },
    desktopState: {}, startupLifetime: new StartupLifetime(), settings: { memoryRoot: "Memory", boardMcpEnabled: true, boardMcpReadOnly: false, tutorCommunicationEnabled: true, tutorCommunicationEngine:"inherit",chatEngine:"opencode", tutorCodexCommand: "codex", tutorPairings: [] },
    agentSpawnEnv: () => ({ PATH: "/synthetic/bin" }), tutorSurfaces: async () => [], saveSettingsSecurely: saveSettings,
    tutorConversation: { tasks }, tutorTools: { revoke: toolsRevoke, close: vi.fn(async () => {}) },
    tutorContext: vi.fn(), librarySnapshot: { annotations: [] }, boardToolRuntime: {}, mcpApply: Promise.resolve(),
  });
  return { host, controller, created, create, toolsOptions, serverOptions, serverStop, publish, remove, modalArguments, tasks, toolsRevoke, saveSettings };
}

describe("production communication host integration", () => {
  it("uses one initializer and one durable controller per host", async () => {
    const f = hostFixture(); const a = f.host.tutorCommunication(), b = f.host.tutorCommunication();
    expect(a).toBe(b); expect(f.create).toHaveBeenCalledOnce(); f.created.resolve(f.controller);
    expect(await a).toBe(f.controller); expect(await b).toBe(f.controller); expect(await f.host.tutorCommunication()).toBe(f.controller);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ root: "Memory/communication", vaultPath: "/synthetic-vault", pairings: expect.any(Function) }));
  });
  it("closes a late initializer without publishing it after unload", async () => {
    const f = hostFixture(); const pending = f.host.tutorCommunication(); const rejection = expect(pending).rejects.toThrow("communication-service-unavailable");
    f.host.pluginUnloaded = true; const stopping = f.host.stopTutorCommunication(); f.created.resolve(f.controller);
    await rejection; await stopping; expect(f.controller.close).toHaveBeenCalled(); expect(f.host.communicationController).toBeUndefined();
  });
  it("does not publish an initializer that a stop operation invalidated", async () => {
    const f = hostFixture(); const pending = f.host.tutorCommunication(); const outcome = pending.then(() => "published", () => "stopped");
    const stopping = f.host.stopTutorCommunication(); f.created.resolve(f.controller); await stopping;
    expect(await outcome).toBe("stopped"); expect(f.host.communicationController).toBeUndefined(); expect(f.controller.close).toHaveBeenCalled();
  });
  it("does not start another controller while the old one is still shutting down", async () => {
    const f = hostFixture(); const closing = deferred<void>(); f.controller.close.mockImplementation(() => closing.promise);
    f.host.communicationController = f.controller;
    const stopping = f.host.stopTutorCommunication();
    const parallel = f.host.tutorCommunication().catch(() => undefined);
    await Promise.resolve(); expect(f.create).not.toHaveBeenCalled();
    closing.resolve(); await stopping; await parallel;
  });
  it("disabling the incoming MCP endpoint does not publish it or silently change the separate communication setting", async () => {
    const f = hostFixture(); f.host.settings.boardMcpEnabled = false; f.host.communicationController = f.controller;
    await f.host.applyBoardMcpCurrent();
    expect(f.publish).not.toHaveBeenCalled(); expect(f.host.settings.tutorCommunicationEnabled).toBe(true); expect(f.create).not.toHaveBeenCalled();
  });
  it("turning communication off closes its background controller and omits the gateway from MCP", async () => {
    const f = hostFixture(); f.host.communicationController = f.controller;
    await f.host.setTutorCommunicationEnabled(false);
    expect(f.controller.close).toHaveBeenCalled(); expect(f.host.communicationController).toBeUndefined(); expect(f.create).not.toHaveBeenCalled();
    expect(f.toolsOptions.at(-1)?.communication).toBeUndefined();
  });
  it("starts shutdown before waiting for settings persistence when communication is turned off", async () => {
    const f = hostFixture(); const saving = deferred<void>(); f.host.communicationController = f.controller;
    f.saveSettings.mockImplementation(() => saving.promise);
    const stopped = f.host.setTutorCommunicationEnabled(false);
    await Promise.resolve(); await Promise.resolve();
    const closeStartedBeforeSave = f.controller.close.mock.calls.length > 0;
    saving.resolve(); await stopped;
    expect(closeStartedBeforeSave).toBe(true);
  });
  it("drains the old collaboration engine before creating an independent replacement and preserves ordinary chat",async()=>{
    const f=hostFixture(),closing=deferred<void>();f.host.communicationController=f.controller;f.controller.close.mockImplementation(()=>closing.promise);
    const changing=f.host.setTutorCommunicationEngine("codex");
    expect(f.controller.close).toHaveBeenCalledOnce();expect(f.create).not.toHaveBeenCalled();
    closing.resolve();f.created.resolve(f.controller);await changing;
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({tutorEngine:"codex"}));
    expect(f.host.settings.chatEngine).toBe("opencode");
  });
  it("keeps collaboration stopped when its saved engine changes while disabled",async()=>{
    const f=hostFixture();f.host.settings.tutorCommunicationEnabled=false;
    await f.host.setTutorCommunicationEngine("codex");
    expect(f.host.settings.tutorCommunicationEngine).toBe("codex");expect(f.create).not.toHaveBeenCalled();expect(f.host.settings.chatEngine).toBe("opencode");
  });
  it("rejects an invalid collaboration engine before changing or stopping anything",async()=>{
    const f=hostFixture();await expect(f.host.setTutorCommunicationEngine("unexpected" as never)).rejects.toThrow("communication-engine-invalid");
    expect(f.controller.close).not.toHaveBeenCalled();expect(f.host.settings.tutorCommunicationEngine).toBe("inherit");
  });
  it("forwards requested pairing identity into the seventh modal argument and saves only the resulting grant", async () => {
    const f = hostFixture(); f.host.communicationController = f.controller;
    const paired = await f.host.pairTutorClient("Peer", new AbortController().signal, peerIdentity);
    expect(f.modalArguments[0]?.[6]).toEqual(peerIdentity); expect(paired.clientId).toBe("client-1"); expect(paired.token).toMatch(/^[a-f0-9]{64}$/);
    expect(f.host.settings.tutorPairings[0]?.grant).toEqual(grant()); expect(f.host.settings.tutorPairings[0]?.tokenHash).not.toBe(paired.token);
  });
  it("rejects an external pair request that impersonates the host before showing an authorization dialog", async () => {
    const f = hostFixture(); f.host.communicationController = f.controller;
    await expect(f.host.pairTutorClient("Impersonator", undefined, f.controller.identity)).rejects.toThrow("cannot-impersonate-host");
    expect(f.modalArguments).toEqual([]); expect(f.host.settings.tutorPairings).toEqual([]);
  });
  it("rejects reserved Codex and external identity claims before showing an authorization dialog", async () => {
    const f = hostFixture();
    for (const identity of [
      { ...peerIdentity, kind: "codex" as const }, { ...peerIdentity, kind: "human" as const },
      { ...peerIdentity, vaultId: "codex" }, { ...peerIdentity, vaultId: "external" }, { ...peerIdentity, agentId: "codex-space-1" },
    ]) await expect(f.host.pairTutorClient("Reserved", undefined, identity)).rejects.toThrow("identity-reserved");
    expect(f.modalArguments).toEqual([]); expect(f.create).not.toHaveBeenCalled(); expect(f.host.settings.tutorPairings).toEqual([]);
  });
  it("requires revoking an existing identity before pairing it again", async () => {
    const f = hostFixture(); f.host.communicationController = f.controller;
    const saved = createTutorPairing(grant()).record; f.host.settings.tutorPairings = [saved];
    await expect(f.host.pairTutorClient("Duplicate", undefined, peerIdentity)).rejects.toThrow("already-paired-revoke-before-repair");
    expect(f.modalArguments).toEqual([]); expect(f.host.settings.tutorPairings).toEqual([saved]);
  });
  it("revokes membership even when the controller is still initializing", async () => {
    const f = hostFixture(); f.host.settings.tutorPairings = [createTutorPairing(grant()).record];
    const initializing = f.host.tutorCommunication(); const revoked = f.host.revokeTutorClient("client-1"); f.created.resolve(f.controller);
    await initializing; await revoked;
    expect(f.host.settings.tutorPairings).toEqual([]); expect(f.toolsRevoke).toHaveBeenCalledWith("client-1"); expect(f.controller.revoke).toHaveBeenCalledWith(peerIdentity);
  });
  it("registers the communication gateway and publishes only the public host identity", async () => {
    const f = hostFixture(); f.host.communicationController = f.controller; await f.host.applyBoardMcpCurrent();
    expect(f.toolsOptions[0]?.communication).toBe(f.controller.gateway);
    expect(f.publish).toHaveBeenCalledWith("/synthetic-vault", "Synthetic", 12345, f.controller.identity);
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain("token");
    const pair = f.serverOptions[0]?.pair as (name: string, signal: AbortSignal, identity: CommunicationIdentity) => Promise<unknown>;
    await pair("Peer", new AbortController().signal, peerIdentity); expect(f.modalArguments.at(-1)?.[6]).toEqual(peerIdentity);
  });
});

describe("HTTP pairing identity input without a TCP listener", () => {
  async function pairRequest(identity: unknown) {
    const pair = vi.fn(async (_name: string, _signal: AbortSignal, _identity?: CommunicationIdentity) => ({ token: "a".repeat(64), clientId: "paired" }));
    const adapter = new LocalBoardMcpAdapter(new DefaultBoardToolRuntime(), { pair });
    const response = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writeHead: vi.fn(), end: vi.fn() });
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ name: "Other Tutor", communicationIdentity: identity }))]), { headers: { host: "127.0.0.1:1234" }, method: "POST", url: "/pair" });
    const internal = adapter as unknown as { server: { address(): { port: number } }; handleHttp(request: unknown, result: unknown, signal: AbortSignal): Promise<void> };
    internal.server = { address: () => ({ port: 1234 }) }; await internal.handleHttp(request, response, new AbortController().signal);
    return { pair, response };
  }
  it("passes the strict requested identity as the pair callback's third argument", async () => {
    const f = await pairRequest(peerIdentity); expect(f.pair).toHaveBeenCalledWith("Other Tutor", expect.any(AbortSignal), peerIdentity); expect(f.response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
  it("rejects malformed or overprivileged identity metadata before requesting user pairing", async () => {
    for (const identity of [{ ...peerIdentity, admin: true }, { ...peerIdentity, kind: "system" }, { ...peerIdentity, agentId: "" }]) {
      const f = await pairRequest(identity); expect(f.pair).not.toHaveBeenCalled(); expect(f.response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    }
  });
});
