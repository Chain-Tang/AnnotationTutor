import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DurableCodexChannel, isTutorCodexBinding, type CodexChannelReply, type DurableCodexChannelOptions, type TutorCodexBinding } from "./tutor-codex-channel.js";
import { communicationIdentityKey, communicationIdentitySchema, communicationSpaceIdSchema, type CommunicationIdentity } from "./tutor-communication.js";
import type { CommunicationStoreIO } from "./tutor-communication-store.js";

export interface CommunicationTutorRunnerScope { hostKey: string; spaceId: string }
export interface CommunicationTutorRunnerChannel {
  readonly binding: TutorCodexBinding | undefined;
  create(input: { authorized: true }): Promise<TutorCodexBinding>;
  send(input: { prompt: string; context?: string; signal?: AbortSignal }): Promise<CodexChannelReply>;
  dispose(): void;
}
export interface CommunicationTutorCodexRunnerOptions {
  state: CommunicationStoreIO;
  command: string;
  identity: CommunicationIdentity;
  env?: NodeJS.ProcessEnv;
  cwdRoot?: string;
  makeChannel?: (options: DurableCodexChannelOptions) => CommunicationTutorRunnerChannel;
}
const path = "communication-tutor-bindings.json";
const workspacePattern = /^tutor-[a-f0-9]{64}$/;
const stateSchema = z.object({
  format: z.literal("tutor-communication-tutor-bindings-v1"),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bindings: z.record(z.string().regex(workspacePattern), z.unknown()),
}).strict();
type BindingState = { format: "tutor-communication-tutor-bindings-v1"; revision: number; bindings: Record<string, TutorCodexBinding> };
type ChannelSlot = { channel: CommunicationTutorRunnerChannel; cwd: string };
const failure = (code: string) => new Error(`communication-tutor-${code}`);

/** Each Tutor/scope owns one conversation. No prompt text selects an identity,
 * host, existing chat, directory, credentials, or another Tutor's binding. */
export class CommunicationTutorCodexRunner {
  private readonly identityKey: string;
  private readonly slots = new Map<string, ChannelSlot>();
  private readonly queues = new Map<string, Promise<string>>();
  private readonly active = new Set<AbortController>();
  private readonly directories = new Set<string>();
  private stateTail: Promise<unknown> = Promise.resolve();
  private lastRevision = -1;
  private lastRaw: string | null = null;
  private readonly knownBindings = new Map<string, string>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: CommunicationTutorCodexRunnerOptions) {
    const identity = communicationIdentitySchema.parse(options.identity);
    if (identity.kind !== "tutor") throw failure("invalid-identity");
    this.identityKey = communicationIdentityKey(identity);
  }
  private check(signal?: AbortSignal): void {
    if (this.closed) throw failure("closed");
    if (signal?.aborted) throw failure("cancelled");
  }
  private workspace(scope: CommunicationTutorRunnerScope): string {
    if (!scope || typeof scope.hostKey !== "string" || !scope.hostKey.trim() || scope.hostKey.length > 2000 || /[\u0000-\u001f\u007f]/.test(scope.hostKey)
      || !communicationSpaceIdSchema.safeParse(scope.spaceId).success) throw failure("invalid-scope");
    return `tutor-${createHash("sha256").update(JSON.stringify([this.identityKey, scope.hostKey, scope.spaceId])).digest("hex")}`;
  }
  private serializeState<T>(work: () => Promise<T>): Promise<T> {
    const next = this.stateTail.catch(() => {}).then(work); this.stateTail = next; return next;
  }
  private async load(): Promise<{ raw: string | null; value: BindingState }> {
    let raw: string | null;
    try { raw = await this.options.state.read(path); } catch { throw failure("state-unavailable"); }
    if (raw === null) {
      if (this.lastRevision >= 0) throw failure("state-missing-after-load");
      return { raw, value: { format: "tutor-communication-tutor-bindings-v1", revision: 0, bindings: {} } };
    }
    if (Buffer.byteLength(raw) > 1_000_000) throw failure("state-too-large");
    let parsed: z.infer<typeof stateSchema>;
    try { parsed = stateSchema.parse(JSON.parse(raw)); } catch { throw failure("state-invalid"); }
    if (Object.keys(parsed.bindings).length > 256) throw failure("state-too-large");
    const bindings: Record<string, TutorCodexBinding> = {}, threads = new Set<string>();
    for (const [workspaceId, binding] of Object.entries(parsed.bindings)) {
      if (!isTutorCodexBinding(binding, workspaceId) || binding.origin !== "created" || threads.has(binding.threadId)) throw failure("state-invalid");
      threads.add(binding.threadId); bindings[workspaceId] = { ...binding };
    }
    if (parsed.revision < this.lastRevision || (parsed.revision === this.lastRevision && raw !== this.lastRaw)) throw failure("state-regressed");
    for (const [workspaceId, threadId] of this.knownBindings) if (bindings[workspaceId]?.threadId !== threadId) throw failure("binding-changed-after-load");
    this.lastRevision = parsed.revision; this.lastRaw = raw;
    for (const [workspaceId, binding] of Object.entries(bindings)) this.knownBindings.set(workspaceId, binding.threadId);
    return { raw, value: { ...parsed, bindings } };
  }
  private persist(workspaceId: string, binding: TutorCodexBinding | undefined): Promise<void> {
    return this.serializeState(async () => {
      this.check();
      if (!isTutorCodexBinding(binding, workspaceId) || binding.origin !== "created") throw failure("invalid-binding");
      const { raw, value } = await this.load(); this.check();
      const previous = value.bindings[workspaceId];
      if (previous && previous.threadId !== binding.threadId) throw failure("binding-replacement-denied");
      if (Object.entries(value.bindings).some(([key, entry]) => key !== workspaceId && entry.threadId === binding.threadId)) throw failure("binding-reuse-denied");
      if (!previous && Object.keys(value.bindings).length >= 256) throw failure("state-too-large");
      value.bindings[workspaceId] = { ...binding }; value.revision++;
      const next = JSON.stringify(value);
      try { await this.options.state.compareWrite(path, raw, next); } catch { throw failure("state-write-not-confirmed"); }
      this.lastRaw = next; this.lastRevision = value.revision; this.knownBindings.set(workspaceId, binding.threadId);
    });
  }
  private async slot(workspaceId: string, binding: TutorCodexBinding | undefined, signal: AbortSignal): Promise<ChannelSlot> {
    const previous = this.slots.get(workspaceId);
    if (previous) {
      if (previous.channel.binding?.threadId !== binding?.threadId) throw failure("binding-changed-after-load");
      return previous;
    }
    const root = this.options.cwdRoot ?? join(tmpdir(), "tutor-communication-runtime");
    await mkdir(root, { recursive: true, mode: 0o700 }); this.check(signal);
    const cwd = await mkdtemp(join(root, `${workspaceId}-`)); this.directories.add(cwd);
    await chmod(cwd, 0o700); this.check(signal);
    const channel = (this.options.makeChannel ?? (options => new DurableCodexChannel(options)))({
      command: this.options.command, cwd, env: this.options.env, workspaceId, binding,
      agentRole: "tutor", persistBinding: value => this.persist(workspaceId, value),
    });
    const slot = { channel, cwd }; this.slots.set(workspaceId, slot); return slot;
  }
  private async execute(workspaceId: string, prompt: string, context: string, signal: AbortSignal): Promise<string> {
    this.check(signal);
    const abort = new AbortController(), cancel = () => abort.abort();
    this.active.add(abort); signal.addEventListener("abort", cancel, { once: true });
    let slot: ChannelSlot | undefined;
    const stop = () => { slot?.channel.dispose(); };
    abort.signal.addEventListener("abort", stop, { once: true });
    const guarded = async <T>(promise: Promise<T>): Promise<T> => {
      if (abort.signal.aborted) { void promise.catch(() => {}); throw failure("cancelled"); }
      return new Promise<T>((resolve, reject) => {
        const cancelled = () => reject(failure("cancelled"));
        abort.signal.addEventListener("abort", cancelled, { once: true });
        promise.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", cancelled));
      });
    };
    try {
      const loaded = await guarded(this.serializeState(() => this.load())); this.check(abort.signal);
      slot = await this.slot(workspaceId, loaded.value.bindings[workspaceId], abort.signal); this.check(abort.signal);
      if (!slot.channel.binding) await guarded(slot.channel.create({ authorized: true }));
      this.check(abort.signal);
      const result = await guarded(slot.channel.send({ prompt, context, signal: abort.signal })); this.check(abort.signal);
      if (!result.text.trim()) throw failure("empty-output");
      return result.text;
    } catch (error) {
      const failed = slot ?? this.slots.get(workspaceId);
      failed?.channel.dispose(); if (failed && this.slots.get(workspaceId) === failed) this.slots.delete(workspaceId);
      throw error;
    } finally {
      this.active.delete(abort); signal.removeEventListener("abort", cancel); abort.signal.removeEventListener("abort", stop);
    }
  }
  run(prompt: string, context: string, signal: AbortSignal, scope: CommunicationTutorRunnerScope): Promise<string> {
    try { this.check(signal); } catch (error) { return Promise.reject(error); }
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000 || typeof context !== "string" || context.length > 32000) return Promise.reject(failure("invalid-input"));
    let workspaceId: string; try { workspaceId = this.workspace(scope); } catch (error) { return Promise.reject(error); }
    const next = (this.queues.get(workspaceId) ?? Promise.resolve()).catch(() => {}).then(() => this.execute(workspaceId, prompt, context, signal));
    this.queues.set(workspaceId, next);
    const settled = () => { if (this.queues.get(workspaceId) === next) this.queues.delete(workspaceId); };
    void next.then(settled, settled); return next;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const abort of this.active) abort.abort();
    for (const slot of this.slots.values()) slot.channel.dispose();
    this.closing = (async () => {
      await Promise.allSettled([...this.queues.values()]); await this.stateTail.catch(() => {});
      this.slots.clear();
      await Promise.all([...this.directories].map(directory => rm(directory, { recursive: true, force: true }).catch(() => {})));
      this.directories.clear();
    })();
    return this.closing;
  }
}
