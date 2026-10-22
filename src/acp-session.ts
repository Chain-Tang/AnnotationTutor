// A persistent, multi-turn ACP session for the chat sidebar.
//
// Where `acp-runner.ts` runs a single throwaway review, this keeps the child and
// the ACP session alive so the chat can exchange many turns with contextual
// memory (the agent remembers the conversation server-side), switch between
// plan/build mode mid-session, and read Vault files on demand. Protocol verified
// against OpenCode 1.16.2 (`opencode acp`):
//
//   initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:true}}}
//   session/new {cwd, mcpServers:[]} -> {sessionId, configOptions}
//   session/set_config_option {sessionId, configId:"model"|"mode", value}
//   session/prompt {sessionId, prompt:[{type:"text", text}]} -> {stopReason}
//   (streamed) session/update: agent_message_chunk = answer, agent_thought_chunk
//              = reasoning, tool_call(_update) = a tool the agent is running.
//   (agent->client) fs/read_text_file -> {content}; session/request_permission.
//
// The driver is transport-agnostic (send is injected) so it is unit-tested
// without a real CLI; only `startAcpSession` touches child_process.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { spawnEnv } from "./agent-runner.js";
import { resolveAcpSpawn } from "./acp-runner.js";
import { killProcessTree } from "./process-tree.js";
import { AcpTurnDiagnostics } from "./ai-execution.js";

/** One slash command the agent runtime advertises (available_commands_update). */
export type AcpCommand = { name: string; description?: string };

/** A stdio MCP server passed to `session/new` (the only kind ACP requires). */
export type McpServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** The learner's answer to an interactive permission prompt. */
export type PermissionChoice = "allow_once" | "allow_always" | "reject_once";

/** A streamed event surfaced to the chat UI as a turn unfolds. */
export type AcpStreamEvent =
  | { type: "message"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; title: string; status?: string }
  | { type: "mode"; mode: string }
  | { type: "commands"; commands: AcpCommand[] };

/** The result of one prompt turn. */
export type AcpTurnResult = {
  ok: boolean;
  text: string;
  stopReason?: string;
  error?: string;
  diagnostic?: string;
};

/** ACP content blocks accepted by a prompt (images are capability-gated). */
export type AcpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export type AcpSessionOptions = {
  cwd: string;
  model: string;
  onUpdate: (event: AcpStreamEvent) => void;
  /** Serve a file the agent asks to read, already guarded to the Vault. null = refuse. */
  readFile?: (path: string) => Promise<string | null>;
  /** Stdio MCP servers handed to `session/new`. Omitted = none. */
  mcpServers?: McpServerConfig[];
  /**
   * Interactive gate for write/execute permission prompts (reads are
   * auto-allowed without consulting it). Absent = decline, as before.
   */
  requestPermission?: (tool: { kind?: string; title?: string }) => Promise<PermissionChoice>;
  /** Board sessions require the agent to advertise image prompt support. */
  requireImageSupport?: boolean;
  /** Board sessions never silently inherit a different model. */
  strictModelSelection?: boolean;
  /** Tool-free agents receive their entire context in the prompt; deny every tool. */
  denyTools?: boolean;
  /** Optional dedicated runtime agent, confirmed before accepting prompts. */
  requiredMode?: string;
  maxTurnChars?: number;
  beginTurn?: (sessionId: string) => void;
  endTurn?: () => void;
  turnDiagnostic?: () => Promise<string | undefined>;
};

type Outgoing = Record<string, unknown>;
type Incoming = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: { sessionId?: string; stopReason?: string } & Record<string, unknown>;
  error?: { code?: number; message?: string };
  params?: {
    path?: string;
    update?: {
      sessionUpdate?: string;
      title?: string;
      status?: string;
      kind?: string;
      content?: { type?: string; text?: string };
      availableCommands?: { name?: string; description?: string }[];
      configOptions?: { id?: string; currentValue?: unknown }[];
    };
    toolCall?: { kind?: string; title?: string };
    options?: PermissionOption[];
  } & Record<string, unknown>;
};

export type PermissionOption = { optionId?: string; kind?: string; name?: string };
export type PermissionParams = {
  options?: PermissionOption[];
  toolCall?: { kind?: string; title?: string };
};

/**
 * True when a permission prompt is for a read-only tool (safe to auto-allow).
 * Only the protocol's `kind` counts: `title` is free text the agent controls, so
 * matching read verbs in it let a destructive call (`kind:"execute"`,
 * `title:"find . -delete"`) walk straight through the gate. A prompt that omits
 * `kind` is treated as unknown, i.e. never auto-allowed.
 */
export function isReadOnlyTool(tool?: { kind?: string; title?: string }): boolean {
  if (!tool?.kind) return false;
  return /^(read|search|fetch|list)$/i.test(tool.kind);
}

/**
 * Decide how to answer a `session/request_permission`. Reads are auto-allowed
 * when `allowReads` is set (so the agent can pull in the whole article); writes
 * and command execution are declined (the preview-then-apply edit flow handles
 * those). Pure, so it is unit-tested.
 */
/** Select the first offered option matching one of `kinds` (in priority order). */
export function pickPermissionOption(
  params: PermissionParams,
  kinds: string[]
): Record<string, unknown> {
  const options = params.options ?? [];
  for (const kind of kinds) {
    const match = options.find(
      (o) => (o.kind ?? "").toLowerCase() === kind && o.optionId
    );
    if (match?.optionId) {
      return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

export function permissionOutcome(
  params: PermissionParams,
  allowReads: boolean
): Record<string, unknown> {
  const allow = allowReads && isReadOnlyTool(params.toolCall);
  return pickPermissionOption(
    params,
    allow
      ? ["allow_once", "allow_always", "allow"]
      : ["reject_once", "reject_always", "reject"]
  );
}

export class AcpSession {
  private nextId = 1;
  private readonly pending = new Map<number, (msg: Incoming) => void>();
  private sessionId: string | null = null;
  private currentMode = "";
  private turnText = "";
  private startGate: Promise<void> | null = null;
  private closed = false;
  private failure: string | null = null;
  private advertisedCommands: AcpCommand[] = [];
  private imageSupport = false;

  public constructor(
    private readonly send: (message: Outgoing) => void,
    private readonly opts: AcpSessionOptions
  ) {}

  public get error(): string | null {
    return this.failure;
  }

  /** The latest slash-command list the runtime advertised (empty until then). */
  public get commands(): AcpCommand[] {
    return this.advertisedCommands;
  }

  public get supportsImages(): boolean {
    return this.imageSupport;
  }

  /** Run the handshake once; resolves when the session is ready (or failed). */
  public start(): Promise<void> {
    if (!this.startGate) this.startGate = this.handshake();
    return this.startGate;
  }

  /** Send one user turn. Streams chunks via onUpdate; resolves at end_turn. */
  public async prompt(
    text: string | AcpPromptContent[],
    options: { mode?: string } = {}
  ): Promise<AcpTurnResult> {
    await this.start();
    if (this.failure) return { ok: false, text: "", error: this.failure };
    if (!this.sessionId) return { ok: false, text: "", error: "no session" };
    const content = typeof text === "string" ? [{ type: "text" as const, text }] : text;
    if (content.some((block) => block.type === "image") && !this.imageSupport) {
      return { ok: false, text: "", error: "image-not-supported" };
    }

    const mode = options.mode?.trim();
    if (mode && this.opts.requiredMode && mode !== this.opts.requiredMode) {
      return { ok: false, text: "", error: "board-mode-unconfirmed" };
    }
    if (mode && mode !== this.currentMode) {
      this.currentMode = mode;
      await this.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "mode",
        value: mode
      });
      this.opts.onUpdate({ type: "mode", mode });
    }

    this.turnText = "";
    this.opts.beginTurn?.(this.sessionId);
    const res = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: content
    });
    const diagnostic = await this.opts.turnDiagnostic?.();
    this.opts.endTurn?.();
    if (res.error) {
      return {
        ok: false,
        text: this.turnText.trim(),
        error: res.error.message ?? "agent error", diagnostic
      };
    }
    if (!this.turnText.trim() && diagnostic) return {ok:false,text:"",error:diagnostic,diagnostic,stopReason:res.result?.stopReason};
    return {
      ok: true,
      text: this.turnText.trim(),
      stopReason: res.result?.stopReason, diagnostic
    };
  }

  /** Ask the agent to stop its current prompt. Dispose also settles local waits. */
  public cancel(): void {
    if (this.closed || !this.sessionId) return;
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
  }

  /** Feed one parsed JSON-RPC message received from the agent. */
  public receive(message: Incoming): void {
    if (this.closed || !message) return;
    if (message.id !== undefined && message.method === undefined) {
      const handler = this.pending.get(message.id as number);
      if (handler) {
        this.pending.delete(message.id as number);
        handler(message);
      }
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "session/update") this.onUpdate(message);
      else if (message.id !== undefined) void this.onAgentRequest(message);
    }
  }

  /** Reject every in-flight request — e.g. the process died. */
  public fail(error: string): void {
    if (this.closed) return;
    this.failure = error;
    for (const handler of this.pending.values()) handler({ error: { message: error } });
    this.pending.clear();
  }

  /**
   * Tear the session down, settling every in-flight request first. Dropping
   * them instead would leave the caller's `await prompt()` pending forever —
   * and with it the chat view's busy flag, which silently swallows every later
   * message (the learner hitting "new chat" mid-turn is enough to trigger it).
   */
  public dispose(): void {
    if (this.closed) return;
    for (const handler of this.pending.values()) {
      handler({ error: { message: "session disposed" } });
    }
    this.pending.clear();
    this.closed = true;
  }

  private async handshake(): Promise<void> {
    try {
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: !this.opts.denyTools && Boolean(this.opts.readFile), writeTextFile: false }
        }
      });
      if (init.error) throw new Error(init.error.message ?? "initialize failed");
      const capabilities = init.result?.agentCapabilities as { promptCapabilities?: { image?: boolean } } | undefined;
      this.imageSupport = capabilities?.promptCapabilities?.image === true;
      if (this.opts.requireImageSupport && !this.imageSupport) {
        throw new Error("image-not-supported");
      }
      if (this.opts.strictModelSelection && !this.opts.model.trim()) {
        throw new Error("model-selection-unconfirmed");
      }
      const created = await this.request("session/new", {
        cwd: this.opts.cwd,
        mcpServers: (this.opts.denyTools ? [] : this.opts.mcpServers ?? []).map((server) => ({
          name: server.name,
          command: server.command,
          ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
          ...(server.env && Object.keys(server.env).length > 0
            ? { env: Object.entries(server.env).map(([name, value]) => ({ name, value })) }
            : {})
        }))
      });
      if (created.error) throw new Error(created.error.message ?? "session/new failed");
      this.sessionId = created.result?.sessionId ?? null;
      if (!this.sessionId) throw new Error("no sessionId returned");
      if (this.opts.requiredMode) {
        const modeResult = await this.request("session/set_config_option", {
          sessionId: this.sessionId, configId: "mode", value: this.opts.requiredMode
        });
        const config = modeResult.result?.configOptions;
        const mode = Array.isArray(config) ? config.find((item: { id?: string }) => item?.id === "mode") : undefined;
        if (modeResult.error || mode?.currentValue !== this.opts.requiredMode) throw new Error("board-mode-unconfirmed");
        this.currentMode = this.opts.requiredMode;
      }
      if (this.opts.model.trim()) {
        // Ordinary chat retains its historical fallback; board sessions must
        // confirm the chosen model before sending any image content.
        const selected = await this.request("session/set_config_option", {
          sessionId: this.sessionId,
          configId: "model",
          value: this.opts.model.trim()
        });
        if (this.opts.strictModelSelection) {
          const config = selected.result?.configOptions;
          const model = Array.isArray(config)
            ? config.find((item: { id?: string }) => item?.id === "model")
            : undefined;
          if (selected.error || model?.currentValue !== this.opts.model.trim()) {
            throw new Error(`model-selection-unconfirmed${selected.error?.message ? `: ${selected.error.message}` : ""}`);
          }
        }
      }
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }

  private request(method: string, params: Outgoing): Promise<Incoming> {
    if (this.failure || this.closed) {
      return Promise.resolve({ error: { message: this.failure ?? "closed" } });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onUpdate(message: Incoming): void {
    const update = message.params?.update;
    if (!update) return;
    const kind = update.sessionUpdate;
    const text = update.content?.text;
    if (kind === "config_option_update" && this.opts.strictModelSelection) {
      const selected = update.configOptions?.find((item) => item.id === "model");
      if (selected && selected.currentValue !== this.opts.model.trim()) {
        this.cancel();
        this.fail("model-selection-unconfirmed");
        return;
      }
    }
    if (kind === "config_option_update" && this.opts.requiredMode) {
      const selected = update.configOptions?.find((item) => item.id === "mode");
      if (selected && selected.currentValue !== this.opts.requiredMode) {
        this.cancel();
        this.fail("board-mode-unconfirmed");
        return;
      }
    }
    if (
      kind === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof text === "string"
    ) {
      if (this.opts.maxTurnChars && this.turnText.length + text.length > this.opts.maxTurnChars) {
        this.cancel();
        this.fail("response-too-large");
        return;
      }
      this.turnText += text;
      this.opts.onUpdate({ type: "message", text });
    } else if (kind === "agent_thought_chunk" && typeof text === "string") {
      this.opts.onUpdate({ type: "thought", text });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      this.opts.onUpdate({
        type: "tool",
        title: update.title ?? update.kind ?? "tool",
        ...(update.status ? { status: update.status } : {})
      });
    } else if (kind === "available_commands_update") {
      const commands: AcpCommand[] = [];
      for (const command of update.availableCommands ?? []) {
        const name = command?.name?.trim();
        if (!name) continue;
        commands.push({
          name,
          ...(command.description?.trim() ? { description: command.description.trim() } : {})
        });
      }
      this.advertisedCommands = commands;
      this.opts.onUpdate({ type: "commands", commands });
    }
  }

  private async onAgentRequest(message: Incoming): Promise<void> {
    const method = message.method ?? "";
    const id = message.id;
    if (method === "fs/read_text_file") {
      const path = typeof message.params?.path === "string" ? message.params.path : "";
      let content: string | null = null;
      if (path && this.opts.readFile && !this.opts.denyTools) {
        try {
          content = await this.opts.readFile(path);
        } catch {
          content = null;
        }
      }
      if (content === null) {
        this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: "cannot read file" } });
      } else {
        this.send({ jsonrpc: "2.0", id, result: { content } });
      }
      return;
    }
    if (method.includes("request_permission")) {
      void this.answerPermission(message);
      return;
    }
    // We advertised no other client capability.
    this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
  }
  /**
   * Answer a permission prompt: kind-verified reads auto-allow, everything else
   * goes through the interactive gate when one is wired, and is declined
   * otherwise. A prompt racing with dispose() is dropped rather than answered.
   */
  private async answerPermission(message: Incoming): Promise<void> {
    const params = message.params ?? {};
    const tool = params.toolCall;
    let choice: PermissionChoice = "reject_once";
    if (this.opts.denyTools) {
      choice = "reject_once";
    } else if (isReadOnlyTool(tool)) {
      choice = "allow_once";
    } else if (this.opts.requestPermission) {
      try {
        choice = await this.opts.requestPermission(tool ?? {});
      } catch {
        choice = "reject_once";
      }
    }
    if (this.closed) return;
    const kinds =
      choice === "allow_once"
        ? ["allow_once", "allow"]
        : choice === "allow_always"
          ? ["allow_always", "allow_once", "allow"]
          : ["reject_once", "reject_always", "reject"];
    this.send({
      jsonrpc: "2.0",
      id: message.id,
      result: pickPermissionOption(params, kinds)
    });
  }
}

export type AcpSessionHandle = {
  session: AcpSession;
  dispose: () => void;
};

/** Cap on retained stderr — enough for a stack trace, bounded for a long session. */
const STDERR_LIMIT = 8192;

export const BOARD_ACP_MODE = "tutor-board";
export type AcpToolFreeRole = "board" | "conversation";

/** Parse one model's capability metadata from OpenCode's verbose catalog. */
export function acpModelImageSupport(catalog: string, model: string): boolean | null {
  const lines = catalog.split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() === model.trim());
  if (at < 0) return null;
  const content = lines.slice(at + 1).join("\n").trimStart();
  if (!content.startsWith("{")) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const parsed = JSON.parse(content.slice(0, index + 1)) as { capabilities?: { input?: { image?: unknown } } };
        const supported = parsed.capabilities?.input?.image;
        return typeof supported === "boolean" ? supported : null;
      } catch { return null; }
    }
  }
  return null;
}

async function verifyAcpImageModel(opts: { command: string; cwd: string; model: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<void> {
  const spec = resolveAcpSpawn(opts.command);
  await new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new Error("session cancelled")); return; }
    const child = spawn(spec.command, ["models", "--verbose"], { cwd: opts.cwd, env: spawnEnv(opts.env), shell: spec.shell, windowsHide: true, stdio: "pipe" });
    child.stdin?.end();
    let output = "", settled = false;
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); opts.signal?.removeEventListener("abort", abort);
      if (error) { killProcessTree(child); reject(new Error(error)); } else resolve();
    };
    const abort = (): void => finish("session cancelled");
    const timer = setTimeout(() => finish("image-capability-unconfirmed: catalog timeout"), opts.timeoutMs);
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4_000_000) finish("image-capability-unconfirmed: catalog too large");
    });
    // Drain stderr without retaining configuration/provider diagnostics.
    child.stderr?.on("data", () => {});
    child.on("error", () => finish("image-capability-unconfirmed: catalog unavailable"));
    child.on("close", (code) => {
      if (code !== 0) { finish("image-capability-unconfirmed: catalog unavailable"); return; }
      const support = acpModelImageSupport(output, opts.model);
      finish(support === true ? undefined : support === false ? "image-not-supported" : "image-capability-unconfirmed");
    });
  });
}

/** Per-child configuration: ordinary sessions preserve their complete environment. */
export function acpSessionEnvironment(base: NodeJS.ProcessEnv, denyTools: boolean, boardMode = BOARD_ACP_MODE, toolFreeRole: AcpToolFreeRole = "board"): NodeJS.ProcessEnv {
  if (!denyTools) return { ...base };
  let config: Record<string, unknown> = {};
  if (base.OPENCODE_CONFIG_CONTENT?.trim()) {
    try {
      const parsed: unknown = JSON.parse(base.OPENCODE_CONFIG_CONTENT);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid config");
      config = parsed as Record<string, unknown>;
    } catch { throw new Error("board-runtime-config-invalid"); }
  }
  const configuredAgents = config.agent && typeof config.agent === "object" && !Array.isArray(config.agent) ? config.agent as Record<string, unknown> : {};
  // Agent rules are appended after the user's global rules. A distinct primary
  // agent therefore also blocks tools that a user's build agent auto-allows.
  // Sources: opencode.ai/docs/permissions/ and OpenCode's Agent permission merge.
  const conversation = toolFreeRole === "conversation";
  return { ...base, OPENCODE_CONFIG_CONTENT: JSON.stringify({
    ...config, default_agent: boardMode,
    agent: { ...configuredAgents, [boardMode]: {
      mode: "primary", permission: { "*": "deny" },
      description: conversation ? "Tutor conversation: follow each turn's output protocol" : "Tutor visual board: return drawing JSON only",
      prompt: conversation
        ? "You are Tutor's conversation agent. Use only the supplied conversation context. Follow the output protocol specified for each turn. Do not use tools or access files, terminals, or external services."
        : "You are Tutor's visual board agent. Use only the supplied screenshot and context. Return drawing JSON. Do not use tools."
    } }
  }) };
}

/** Spawn `opencode acp` and run the handshake, returning a live session. */
export async function startAcpSession(opts: {
  command: string;
  model: string;
  cwd: string;
  onUpdate: (event: AcpStreamEvent) => void;
  readFile?: (path: string) => Promise<string | null>;
  mcpServers?: McpServerConfig[];
  requestPermission?: (tool: { kind?: string; title?: string }) => Promise<PermissionChoice>;
  onExit?: (reason: string) => void;
  startTimeoutMs?: number;
  requireImageSupport?: boolean;
  strictModelSelection?: boolean;
  denyTools?: boolean;
  /** Instruction role for the isolated tool-free agent; drawing stays the default. */
  toolFreeRole?: AcpToolFreeRole;
  signal?: AbortSignal;
  maxTurnChars?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<AcpSessionHandle> {
  if (opts.signal?.aborted) throw new Error("session cancelled");
  if (opts.requireImageSupport) {
    await verifyAcpImageModel({ command: opts.command, cwd: opts.cwd, model: opts.model, timeoutMs: opts.startTimeoutMs ?? 30000, signal: opts.signal, env: opts.env });
  }
  const spec = resolveAcpSpawn(opts.command);
  // A unique mode avoids deep-merging an existing user agent's per-tool allows.
  const boardMode = opts.denyTools ? `${BOARD_ACP_MODE}-${randomUUID()}` : undefined;
  let child;
  try {
    child = spawn(spec.command, [...spec.args, "--print-logs", "--log-level", "ERROR"], {
      cwd: opts.cwd,
      env: acpSessionEnvironment(spawnEnv(opts.env), Boolean(opts.denyTools), boardMode, opts.toolFreeRole),
      stdio: "pipe",
      windowsHide: true,
      shell: spec.shell
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  let stderr = "";
  const diagnostics = new AcpTurnDiagnostics();
  let disposed = false;
  const session = new AcpSession(
    (message) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        // stdin closed; the close handler reports it.
      }
    },
    {
      cwd: opts.cwd,
      model: opts.model,
      onUpdate: opts.onUpdate,
      requireImageSupport: opts.requireImageSupport,
      strictModelSelection: opts.strictModelSelection,
      denyTools: opts.denyTools,
      requiredMode: boardMode,
      maxTurnChars: opts.maxTurnChars,
      beginTurn: sessionId => diagnostics.begin(sessionId),
      endTurn: () => diagnostics.end(),
      // stderr and stdout are separate pipes. Give pending error lines one
      // bounded event-loop turn to arrive before reporting an empty completion.
      turnDiagnostic: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return diagnostics.current(); },
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.requestPermission ? { requestPermission: opts.requestPermission } : {})
    }
  );

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      session.receive(JSON.parse(trimmed) as Incoming);
    } catch {
      // Not a JSON-RPC line — ignore.
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics.push(chunk.toString());
    // A chatty agent would otherwise grow this string for the whole session;
    // only the tail matters because lastLine() reports the final line.
    stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
  });
  const onGone = (reason: string): void => {
    if (disposed) return;
    session.fail(reason);
    opts.onExit?.(reason);
  };
  child.on("error", (error) => onGone(error.message));
  child.on("close", () => onGone(lastLine(stderr) || "opencode acp exited"));

  const dispose = (): void => {
    disposed = true;
    session.dispose();
    try {
      rl.close();
    } catch {
      // already closed
    }
    // The agent spawns MCP servers of its own; kill the tree, not just the head.
    killProcessTree(child);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { dispose(); reject(new Error("session cancelled")); };
    opts.signal?.addEventListener("abort", abort, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("opencode acp did not respond")),
      opts.startTimeoutMs ?? 30000
    );
  });
  try {
    await Promise.race([session.start(), timeout, cancelled]);
  } catch (error) {
    dispose();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) opts.signal?.removeEventListener("abort", abort);
  }
  if (session.error) {
    dispose();
    throw new Error(session.error);
  }
  return { session, dispose };
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  return last.length > 200 ? `${last.slice(0, 197)}…` : last;
}
