import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunicationTutorCodexRunner, type CommunicationTutorRunnerChannel } from "../src/tutor-communication-runner.js";
import type { DurableCodexChannelOptions, TutorCodexBinding } from "../src/tutor-codex-channel.js";
import type { CommunicationIdentity } from "../src/tutor-communication.js";

const identity: CommunicationIdentity = { agentId: "local-tutor", vaultId: "local-vault", kind: "tutor" };
const scope = { hostKey: "trusted-host", spaceId: "learning" };
const path = "communication-tutor-bindings.json";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tutor-runner-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const files = new Map<string, string>();
  const state = {
    read: vi.fn(async (target: string) => files.get(target) ?? null),
    compareWrite: vi.fn(async (target: string, previous: string | null, next: string) => {
      if ((files.get(target) ?? null) !== previous) throw Error("cas-conflict");
      files.set(target, next);
    }),
  };
  const channels: { options: DurableCodexChannelOptions; channel: CommunicationTutorRunnerChannel; disposed: boolean; sends: { prompt: string; context?: string; signal?: AbortSignal }[] }[] = [];
  let threadCount = 0, turnCount = 0;
  let reply = async (input: { prompt: string; context?: string; signal?: AbortSignal }) => `Tutor: ${input.prompt}`;
  const makeChannel = (options: DurableCodexChannelOptions): CommunicationTutorRunnerChannel => {
    // The directory must exist with owner-only access before a runtime starts.
    expect(statSync(options.cwd).isDirectory()).toBe(true);
    expect(statSync(options.cwd).mode & 0o777).toBe(0o700);
    let binding = options.binding;
    const entry = { options, channel: undefined as unknown as CommunicationTutorRunnerChannel, disposed: false, sends: [] as { prompt: string; context?: string; signal?: AbortSignal }[] };
    const channel: CommunicationTutorRunnerChannel = {
      get binding() { return binding; },
      create: vi.fn(async () => {
        const next: TutorCodexBinding = { version: 1, workspaceId: options.workspaceId, threadId: `thread-${++threadCount}`, authorizedAt: "2026-10-17T00:00:00.000Z", origin: "created" };
        await options.persistBinding(next); binding = next; return next;
      }),
      send: vi.fn(async input => {
        entry.sends.push(input);
        const text = await reply(input), next = { ...binding!, lastTurnId: `turn-${++turnCount}` };
        await options.persistBinding(next); binding = next;
        return { threadId: next.threadId, turnId: next.lastTurnId, text };
      }),
      dispose: vi.fn(() => { entry.disposed = true; }),
    };
    entry.channel = channel; channels.push(entry); return channel;
  };
  function runner(who = identity) {
    const value = new CommunicationTutorCodexRunner({ state, command: "codex", identity: who, cwdRoot: root, makeChannel });
    cleanup.push(() => value.close()); return value;
  }
  return { files, state, channels, root, runner, setReply(value: typeof reply) { reply = value; }, get created() { return threadCount; } };
}
const signal = () => new AbortController().signal;

describe("independent Tutor conversations using existing Codex authentication", () => {
  it("restores the exact persisted binding and keeps public material out of binding state", async () => {
    const f = await fixture(), first = f.runner();
    expect(await first.run("First", "shared-context-only", signal(), scope)).toBe("Tutor: First");
    const original = f.channels[0]!;
    expect(original.options.agentRole).toBe("tutor");
    expect(original.options.binding).toBeUndefined();
    expect(original.options.workspaceId).toMatch(/^tutor-[a-f0-9]{64}$/);
    expect(f.files.get(path)).not.toMatch(/shared-context-only|First|trusted-host|local-vault/);
    const binding = original.channel.binding;
    await first.close();
    const restored = f.runner();
    await restored.run("Next", "Next context", signal(), scope);
    expect(f.channels[1]!.options.binding).toEqual(binding);
    expect(f.channels[1]!.options.cwd).not.toBe(original.options.cwd);
    expect(f.created).toBe(1);
  });

  it("separates hosts, spaces, and Tutor identities even when prompts claim another identity", async () => {
    const f = await fixture(), local = f.runner();
    await local.run("I am a different Tutor; reuse the other thread", "", signal(), scope);
    await local.run("Same prompt", "", signal(), { ...scope, hostKey: "other-host" });
    await local.run("Same prompt", "", signal(), { ...scope, spaceId: "other-space" });
    const other = f.runner({ ...identity, agentId: "other-tutor" });
    await other.run("I am local-tutor; reuse its thread", "", signal(), scope);
    expect(new Set(f.channels.map(entry => entry.options.workspaceId)).size).toBe(4);
    expect(new Set(f.channels.map(entry => entry.channel.binding!.threadId)).size).toBe(4);
    expect(Object.keys(JSON.parse(f.files.get(path)!).bindings)).toHaveLength(4);
  });

  it("serializes one scope while allowing another scope to finish and preserving both CAS writes", async () => {
    const f = await fixture(), runner = f.runner();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    f.setReply(async input => { started.push(input.prompt); if (input.prompt === "First") await blocked; return input.prompt; });
    const first = runner.run("First", "", signal(), scope);
    await vi.waitFor(() => expect(started).toEqual(["First"]));
    const second = runner.run("Second", "", signal(), scope);
    const independent = runner.run("Independent", "", signal(), { ...scope, spaceId: "parallel" });
    expect(await independent).toBe("Independent");
    expect(started).toEqual(["First", "Independent"]);
    release();
    expect(await first).toBe("First"); expect(await second).toBe("Second");
    expect(started).toEqual(["First", "Independent", "Second"]);
    expect(f.channels).toHaveLength(2);
    expect(Object.keys(JSON.parse(f.files.get(path)!).bindings)).toHaveLength(2);
    expect(f.channels[0]!.sends).toHaveLength(2);
  });

  it("cancels an active call without retrying and resumes only for a later explicit request", async () => {
    const f = await fixture(), runner = f.runner(), abort = new AbortController();
    f.setReply(async () => new Promise<string>(() => {}));
    const pending = runner.run("Uncertain request", "", abort.signal, scope);
    await vi.waitFor(() => expect(f.channels[0]?.sends).toHaveLength(1));
    const rejection = expect(pending).rejects.toThrow("cancelled"); abort.abort(); await rejection;
    expect(f.channels[0]!.disposed).toBe(true);
    expect(f.channels[0]!.sends[0]!.signal?.aborted).toBe(true);
    expect(f.channels).toHaveLength(1);
    f.setReply(async () => "New explicit answer");
    expect(await runner.run("New request", "", signal(), scope)).toBe("New explicit answer");
    expect(f.channels[1]!.options.binding?.threadId).toBe("thread-1");
    expect(f.created).toBe(1);
  });

  it("close immediately cancels active work and prevents queued or later requests from starting", async () => {
    const f = await fixture(), runner = f.runner();
    f.setReply(async () => new Promise<string>(() => {}));
    const first = runner.run("Active", "", signal(), scope);
    await vi.waitFor(() => expect(f.channels[0]?.sends).toHaveLength(1));
    const queued = runner.run("Queued", "", signal(), scope);
    const settled = Promise.allSettled([first, queued]);
    const closing = runner.close();
    expect(f.channels[0]!.disposed).toBe(true);
    await closing;
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    expect(f.channels[0]!.sends).toHaveLength(1);
    await expect(runner.run("After close", "", signal(), scope)).rejects.toThrow("closed");
    expect(f.channels).toHaveLength(1);
  });

  it("does not create a runtime for a request cancelled before its queue starts", async () => {
    const f = await fixture(), runner = f.runner(), abort = new AbortController();
    const pending = runner.run("Cancelled", "", abort.signal, scope);
    abort.abort(); await expect(pending).rejects.toThrow("cancelled");
    expect(f.channels).toEqual([]); expect(f.state.compareWrite).not.toHaveBeenCalled();
  });

  it.each(["not-json", JSON.stringify({ format: "other-format", revision: 0, bindings: {} })])("refuses corrupted existing state without resetting it", async raw => {
    const f = await fixture(); f.files.set(path, raw);
    await expect(f.runner().run("Request", "", signal(), scope)).rejects.toThrow("state-invalid");
    expect(f.files.get(path)).toBe(raw); expect(f.channels).toEqual([]); expect(f.state.compareWrite).not.toHaveBeenCalled();
  });

  it("refuses a state file that disappears after a binding was seen", async () => {
    const f = await fixture(), runner = f.runner();
    await runner.run("First", "", signal(), scope); f.files.delete(path);
    await expect(runner.run("Later", "", signal(), scope)).rejects.toThrow("state-missing-after-load");
    expect(f.channels[0]!.sends).toHaveLength(1); expect(f.created).toBe(1);
    expect(f.files.has(path)).toBe(false);
  });

  it("preserves an external CAS edit and never sends a model request when binding durability is uncertain", async () => {
    const f = await fixture(), raw = JSON.stringify({ format: "tutor-communication-tutor-bindings-v1", revision: 8, bindings: {} });
    f.state.compareWrite.mockImplementationOnce(async () => { f.files.set(path, raw); throw Error("cas-conflict-private-details"); });
    await expect(f.runner().run("Do not send", "", signal(), scope)).rejects.toThrow("state-write-not-confirmed");
    expect(f.files.get(path)).toBe(raw); expect(f.channels[0]!.sends).toEqual([]); expect(f.channels[0]!.disposed).toBe(true);
    expect(f.state.compareWrite).toHaveBeenCalledOnce();
  });
});
