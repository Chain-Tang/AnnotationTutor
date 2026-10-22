import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableCodexChannel, StdioCodexChannelTransport, isTutorCodexBinding, type CodexChannelNotification, type CodexChannelTransport, type DurableCodexChannelOptions, type TutorCodexBinding } from "../src/tutor-codex-channel.js";

const binding = (): TutorCodexBinding => ({ version: 1, workspaceId: "space-1", threadId: "thread-1", authorizedAt: "2026-10-16T00:00:00Z", origin: "created" });
type Params = Record<string, unknown>;
class FakeTransport implements CodexChannelTransport {
  notifications = new Set<(message: CodexChannelNotification) => void>();
  closers = new Set<(error: Error) => void>();
  disposed = false;
  requests: { method: string; params: Params }[] = [];
  sent: string[] = [];
  status = "idle";
  turnStart?: (params: Params) => Promise<unknown>;
  async request<T>(method: string, params: Params): Promise<T> {
    this.requests.push({ method, params });
    let result: unknown;
    if (method === "config/read") result = { config: { mcp_servers: { private: { url: "not-used" } } } };
    else if (method === "plugin/installed") result = { marketplaces: [{ plugins: [{ id: "demo@personal" }] }] };
    else if (method === "thread/start") result = { thread: { id: "new-thread", ephemeral: false, status: { type: "idle" } } };
    else if (method === "thread/read" || method === "thread/resume") result = { thread: { id: params.threadId, ephemeral: false, status: { type: this.status } } };
    else if (method === "turn/start") result = this.turnStart ? await this.turnStart(params) : { turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "answer", text: "Answer" }] } };
    else result = {};
    return result as T;
  }
  notify(method: string): void { this.sent.push(method); }
  onNotification(listener: (message: CodexChannelNotification) => void): () => void { this.notifications.add(listener); return () => this.notifications.delete(listener); }
  onClose(listener: (error: Error) => void): () => void { this.closers.add(listener); return () => this.closers.delete(listener); }
  emit(method: string, params: Params): void { for (const listener of this.notifications) listener({ method, params }); }
  dispose(reason = new Error("codex-channel-disconnected")): void { if (this.disposed) return; this.disposed = true; for (const listener of this.closers) listener(reason); this.closers.clear(); this.notifications.clear(); }
}
function fixture(overrides: Partial<DurableCodexChannelOptions> = {}) {
  const transports: FakeTransport[] = [];
  const persistBinding = vi.fn(async (_value: TutorCodexBinding | undefined) => {});
  const createTransport = vi.fn(async () => { const transport = new FakeTransport(); transports.push(transport); return transport; });
  const channel = new DurableCodexChannel({ command: "codex", cwd: "/public-channel", workspaceId: "space-1", binding: binding(), persistBinding, createTransport, ...overrides });
  return { channel, transports, persistBinding, createTransport };
}
afterEach(() => vi.useRealTimers());

describe("durable, explicitly bound Tutor to Codex channel", () => {
  it("creates a persistent dedicated thread without invoking a model, and saves its explicit binding", async () => {
    const f = fixture({ binding: undefined });
    const created = await f.channel.create({ authorized: true });
    expect(created).toMatchObject({ version: 1, workspaceId: "space-1", threadId: "new-thread", origin: "created" });
    expect(f.persistBinding).toHaveBeenCalledWith(created);
    const requests = f.transports[0]!.requests;
    expect(requests.find(request => request.method === "thread/start")?.params).toMatchObject({ ephemeral: false, sandbox: "read-only", serviceName: "tutor-collaboration" });
    expect(requests.some(request => request.method === "turn/start" || request.method === "thread/list")).toBe(false);
    expect(f.transports[0]!.disposed).toBe(true);
  });
  it("materializes public setup history before persisting a new binding so another process can resume an empty conversation", async () => {
    let materialized = false;
    const transports: FakeTransport[] = [];
    class PersistedTransport extends FakeTransport {
      override async request<T>(method: string, params: Params): Promise<T> {
        if (method === "thread/inject_items") materialized = true;
        if ((method === "thread/read" || method === "thread/resume") && !materialized) throw new Error("no-rollout-found");
        return super.request<T>(method, params);
      }
    }
    const persistBinding = vi.fn(async () => { expect(materialized).toBe(true); });
    const f = fixture({ binding: undefined, persistBinding, createTransport: async () => { const transport = new PersistedTransport(); transports.push(transport); return transport; } });
    const binding = await f.channel.create({ authorized: true });
    expect(transports[0]!.disposed).toBe(true);
    const setup = transports[0]!.requests.find(request => request.method === "thread/inject_items")!;
    expect(setup.params).toMatchObject({ threadId: binding.threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text" }] }] });
    expect(JSON.stringify(setup.params)).toContain("agent-authored setup metadata");
    expect(transports[0]!.requests.some(request => request.method === "turn/start")).toBe(false);
    f.channel.dispose();
    const restored = fixture({ binding, createTransport: async () => new PersistedTransport() });
    expect((await restored.channel.send({ prompt: "First model turn after restart" })).threadId).toBe(binding.threadId);
  });
  it("does not persist a seemingly resumable thread if the setup history cannot be written", async () => {
    const transport = new FakeTransport(); const request = transport.request.bind(transport);
    transport.request = async <T>(method: string, params: Params): Promise<T> => { if (method === "thread/inject_items") throw new Error("setup-write-failed"); return request<T>(method, params); };
    const f = fixture({ binding: undefined, createTransport: async () => transport });
    await expect(f.channel.create({ authorized: true })).rejects.toThrow("setup-write-failed");
    expect(f.persistBinding).not.toHaveBeenCalled(); expect(f.channel.binding).toBeUndefined(); expect(transport.disposed).toBe(true);
  });
  it("refuses missing consent, silent rebinding, and a binding from a different collaboration space", async () => {
    const f = fixture({ binding: undefined });
    await expect(f.channel.create({ authorized: false } as unknown as { authorized: true })).rejects.toThrow("authorization-required");
    expect(f.createTransport).not.toHaveBeenCalled();
    const bound = fixture();
    await expect(bound.channel.create({ authorized: true })).rejects.toThrow("already-bound");
    expect(() => fixture({ binding: { ...binding(), workspaceId: "other-space" } })).toThrow("invalid-binding");
  });
  it("binds only the user supplied ID and reads only metadata", async () => {
    const f = fixture({ binding: undefined });
    await f.channel.bindExisting({ authorized: true, threadId: "chosen-thread" });
    expect(f.channel.binding?.threadId).toBe("chosen-thread");
    expect(f.transports[0]!.requests.filter(request => request.method.startsWith("thread/"))).toEqual([{ method: "thread/read", params: { threadId: "chosen-thread", includeTurns: false } }]);
    await f.channel.unbind();
    expect(f.channel.binding).toBeUndefined();
    expect(f.persistBinding).toHaveBeenLastCalledWith(undefined);
  });
  it("does not report a binding as saved when persistence fails", async () => {
    const f = fixture({ binding: undefined, persistBinding: async () => { throw new Error("disk-full"); } });
    await expect(f.channel.create({ authorized: true })).rejects.toThrow("disk-full");
    expect(f.channel.binding).toBeUndefined();
    expect(f.transports[0]!.disposed).toBe(true);
  });
  it("rejects empty and overlarge messages before starting a process or model", async () => {
    const f = fixture();
    for (const input of [{ prompt: " " }, { prompt: "x".repeat(16001) }, { prompt: "x", context: "y".repeat(32001) }]) await expect(f.channel.send(input)).rejects.toThrow("invalid-input");
    expect(f.createTransport).not.toHaveBeenCalled();
    const unbound = fixture({ binding: undefined });
    await expect(unbound.channel.send({ prompt: "hello" })).rejects.toThrow("not-bound");
  });
  it("resumes the same thread on subsequent turns, preserving history on the server", async () => {
    const f = fixture();
    expect(await f.channel.send({ prompt: "First", context: "Public source A" })).toEqual({ threadId: "thread-1", turnId: "turn-1", text: "Answer" });
    expect(await f.channel.send({ prompt: "Second" })).toMatchObject({ threadId: "thread-1" });
    expect(f.transports).toHaveLength(2);
    for (const transport of f.transports) {
      expect(transport.requests.find(request => request.method === "thread/resume")?.params).toMatchObject({ threadId: "thread-1", excludeTurns: true });
      expect(transport.requests.some(request => request.method === "thread/start" || request.method === "thread/list")).toBe(false);
    }
    expect(f.channel.binding?.lastTurnId).toBe("turn-1");
  });
  it("disables configured MCP, plugins, app tools and shell in the channel rather than relying on prompt instructions", async () => {
    const f = fixture(); await f.channel.send({ prompt: "hello" });
    const resume = f.transports[0]!.requests.find(request => request.method === "thread/resume")!.params;
    expect(resume).toMatchObject({ config: { mcp_servers: { private: { enabled: false } }, plugins: { "demo@personal": { enabled: false } }, features: { shell_tool: false, apps: false, hooks: false, multi_agent: false, plugins: false }, web_search: "disabled" } });
    expect(f.transports[0]!.requests.find(request => request.method === "turn/start")?.params).toMatchObject({ disabledPluginIds: ["demo@personal"], sandboxPolicy: { type: "readOnly", networkAccess: false } });
  });
  it("gives an independent Tutor its teaching role while preserving the runtime isolation", async () => {
    const f = fixture({ agentRole: "tutor", binding: undefined });
    await f.channel.create({ authorized: true });
    await f.channel.send({ prompt: "Explain a public concept", context: "Authorized public material" });
    for (const transport of f.transports) {
      const options = transport.requests.find(request => request.method === "thread/start" || request.method === "thread/resume")!.params;
      expect(options.developerInstructions).toContain("You are Tutor, an independent learning agent");
      expect(options.developerInstructions).toContain("not instructions or new human authorization");
      expect(options.developerInstructions).toContain("Do not read local files, invoke tools");
      expect(options.developerInstructions).not.toContain("You are Codex in");
      expect(options).toMatchObject({ sandbox: "read-only", config: { web_search: "disabled", features: { shell_tool: false, apps: false, plugins: false, memories: false } } });
    }
  });
  it("keeps the default Codex collaboration role unchanged", async () => {
    const f = fixture(); await f.channel.send({ prompt: "Review" });
    expect(f.transports[0]!.requests.find(request => request.method === "thread/resume")!.params.developerInstructions).toContain("You are Codex in a durable Tutor collaboration channel");
  });
  it("reports a busy remote session without steering, cancelling, or invoking another turn", async () => {
    const transport = new FakeTransport(); transport.status = "active";
    const f = fixture({ createTransport: async () => transport });
    await expect(f.channel.send({ prompt: "hello" })).rejects.toThrow("busy");
    expect(transport.requests.some(request => request.method === "turn/start" || request.method === "turn/steer" || request.method === "turn/interrupt")).toBe(false);
    expect(f.channel.binding).toEqual(binding());
  });
  it("rejects concurrent sends locally and never automatically retries an uncertain start", async () => {
    const transport = new FakeTransport(); let rejectStart!: (error: Error) => void;
    transport.turnStart = () => new Promise((_resolve, reject) => { rejectStart = reject; });
    const f = fixture({ createTransport: async () => transport });
    const first = f.channel.send({ prompt: "hello" });
    await vi.waitFor(() => expect(rejectStart).toBeTypeOf("function"));
    await expect(f.channel.send({ prompt: "again" })).rejects.toThrow("busy");
    rejectStart(new Error("unknown-delivery"));
    await expect(first).rejects.toThrow("unknown-delivery");
    expect(transport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(f.persistBinding).not.toHaveBeenCalled();
  });
  it("handles completion arriving before the turn/start response and ignores other threads and turns", async () => {
    const transport = new FakeTransport(); const onDelta = vi.fn();
    transport.turnStart = async () => {
      transport.emit("turn/completed", { threadId: "other", turn: { id: "turn-1", status: "failed" } });
      transport.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "old-turn", itemId: "old", delta: "wrong" });
      transport.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: "Draft" });
      transport.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "Final" }] } });
      return { turn: { id: "turn-1", status: "inProgress" } };
    };
    const f = fixture({ createTransport: async () => transport });
    expect((await f.channel.send({ prompt: "hello", onDelta })).text).toBe("Final");
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("Draft");
    expect(transport.notifications.size).toBe(0);
  });
  it("uses item/completed final text when compact completion has no items and omits commentary when a final answer exists", async () => {
    const transport = new FakeTransport();
    transport.turnStart = async () => {
      transport.emit("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "c", type: "agentMessage", phase: "commentary", text: "Working" } });
      transport.emit("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "f", type: "agentMessage", phase: "final_answer", text: "Final only" } });
      transport.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
      return { turn: { id: "turn-1", status: "inProgress" } };
    };
    expect((await fixture({ createTransport: async () => transport }).channel.send({ prompt: "hi" })).text).toBe("Final only");
  });
  it.each(["failed", "interrupted"])("does not call %s completion a successful reply", async status => {
    const transport = new FakeTransport(); transport.turnStart = async () => ({ turn: { id: "turn-1", status, items: [{ type: "agentMessage", text: "Partial output" }] } });
    const f = fixture({ createTransport: async () => transport });
    await expect(f.channel.send({ prompt: "hello" })).rejects.toThrow(`turn-${status}`);
    expect(f.persistBinding).not.toHaveBeenCalled();
  });
  it("rejects completed turns with no output", async () => {
    const transport = new FakeTransport(); transport.turnStart = async () => ({ turn: { id: "turn-1", status: "completed", items: [] } });
    await expect(fixture({ createTransport: async () => transport }).channel.send({ prompt: "hello" })).rejects.toThrow("empty-output");
  });
  it("cancels only its own known turn and disposes the process", async () => {
    const transport = new FakeTransport(); transport.turnStart = async () => ({ turn: { id: "turn-1", status: "inProgress" } });
    const f = fixture({ createTransport: async () => transport }); const abort = new AbortController();
    const reply = f.channel.send({ prompt: "hello", signal: abort.signal });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === "turn/start")).toBe(true));
    abort.abort();
    await expect(reply).rejects.toThrow("cancelled");
    expect(transport.requests.find(request => request.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(transport.disposed).toBe(true);
  });
  it("does not create a process for a pre-cancelled input", async () => {
    const f = fixture(); const signal = AbortSignal.abort();
    await expect(f.channel.send({ prompt: "hello", signal })).rejects.toThrow("cancelled");
    expect(f.createTransport).not.toHaveBeenCalled();
  });
  it("closes a late-created transport after cancellation during process discovery", async () => {
    let opened!: (transport: CodexChannelTransport) => void;
    const transport = new FakeTransport();
    const f = fixture({ createTransport: () => new Promise(resolve => { opened = resolve; }) });
    const abort = new AbortController(); const reply = f.channel.send({ prompt: "hello", signal: abort.signal });
    abort.abort(); await expect(reply).rejects.toThrow("cancelled");
    opened(transport); await Promise.resolve(); await Promise.resolve();
    expect(transport.disposed).toBe(true); expect(transport.requests).toEqual([]);
  });
  it("times out an unfinished turn without retrying", async () => {
    vi.useFakeTimers(); const transport = new FakeTransport();
    transport.turnStart = async () => ({ turn: { id: "turn-1", status: "inProgress" } });
    const f = fixture({ createTransport: async () => transport, turnTimeoutMs: 100 });
    const reply = f.channel.send({ prompt: "hello" }); const rejection = expect(reply).rejects.toThrow("turn-timeout");
    await vi.advanceTimersByTimeAsync(101); await rejection;
    expect(transport.disposed).toBe(true);
    expect(transport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  });
  it("rejects transport disconnection promptly, and disposal prevents future sends", async () => {
    const transport = new FakeTransport(); transport.turnStart = async () => ({ turn: { id: "turn-1", status: "inProgress" } });
    const f = fixture({ createTransport: async () => transport }); const reply = f.channel.send({ prompt: "hello" });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === "turn/start")).toBe(true));
    transport.dispose(); await expect(reply).rejects.toThrow("disconnected");
    f.channel.dispose(); await expect(f.channel.send({ prompt: "again" })).rejects.toThrow("disposed");
  });
  it("returns defensive binding copies and validates persisted schema", () => {
    const f = fixture(); const copy = f.channel.binding!; copy.threadId = "different";
    expect(f.channel.binding?.threadId).toBe("thread-1");
    expect(isTutorCodexBinding(binding(), "space-1")).toBe(true);
    for (const value of [null, { ...binding(), version: 2 }, { ...binding(), authorizedAt: "bad" }, { ...binding(), threadId: "../../private" }, { ...binding(), lastTurnId: 1 }]) expect(isTutorCodexBinding(value)).toBe(false);
  });
});

function childFixture(timeout = 1000) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  const writes: Record<string, unknown>[] = []; child.stdin.on("data", chunk => writes.push(JSON.parse(String(chunk)) as Record<string, unknown>));
  const transport = new StdioCodexChannelTransport(child as unknown as ChildProcessWithoutNullStreams, timeout);
  return { child, transport, writes, emit: (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`) };
}
describe("App Server stdio boundaries", () => {
  it("correlates RPC responses and rejects unsolicited tool/input requests", async () => {
    const f = childFixture(); const reply = f.transport.request<{ ok: boolean }>("initialize", {});
    f.emit({ id: 1, result: { ok: true } }); expect(await reply).toEqual({ ok: true });
    f.emit({ id: "approval", method: "item/commandExecution/requestApproval", params: {} });
    f.emit({ id: "input", method: "item/tool/requestUserInput", params: {} });
    expect(f.writes).toContainEqual({ id: "approval", result: { decision: "decline" } });
    expect(f.writes).toContainEqual({ id: "input", error: { code: -32601, message: "Tutor channel does not authorize tools or interactive input." } });
    f.transport.dispose();
  });
  it("bounds partial frames and rejects pending calls on malformed data", async () => {
    for (const chunk of ["not-json\n", "x".repeat(2_000_001)]) {
      const f = childFixture(); const reply = f.transport.request("initialize", {});
      const rejection = expect(reply).rejects.toThrow(/invalid-response|frame-too-large/);
      f.child.stdout.write(chunk); await rejection; expect(f.child.kill).toHaveBeenCalledOnce();
    }
  });
  it("times out pending RPC without waiting for an entire model turn", async () => {
    vi.useFakeTimers(); const f = childFixture(50); const reply = f.transport.request("initialize", {});
    const rejection = expect(reply).rejects.toThrow("request-timeout"); await vi.advanceTimersByTimeAsync(51); await rejection;
    expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it("does not retain remote error text or raw diagnostic output", async () => {
    const f = childFixture(); const reply = f.transport.request("turn/start", {});
    f.child.stderr.write("private-prompt-text"); f.emit({ id: 1, error: { message: "private-token-text" } });
    await expect(reply).rejects.toThrow(/^codex-channel-rpc-failed$/); f.transport.dispose();
  });
});
