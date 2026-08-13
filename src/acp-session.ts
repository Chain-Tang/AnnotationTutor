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
import { spawnEnv } from "./agent-runner.js";
import { resolveAcpSpawn } from "./acp-runner.js";

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
};

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

/** True when a permission prompt is for a read-only tool (safe to auto-allow). */
export function isReadOnlyTool(tool?: { kind?: string; title?: string }): boolean {
  if (!tool) return false;
  if (tool.kind && /^(read|search|fetch|list)$/i.test(tool.kind)) return true;
  const title = tool.title ?? "";
  return /\b(read|view|open|search|grep|list|find|fetch|glob)\b/i.test(title);
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

  /** Run the handshake once; resolves when the session is ready (or failed). */
  public start(): Promise<void> {
    if (!this.startGate) this.startGate = this.handshake();
    return this.startGate;
  }

  /** Send one user turn. Streams chunks via onUpdate; resolves at end_turn. */
  public async prompt(
    text: string,
    options: { mode?: string } = {}
  ): Promise<AcpTurnResult> {
    await this.start();
    if (this.failure) return { ok: false, text: "", error: this.failure };
    if (!this.sessionId) return { ok: false, text: "", error: "no session" };

    const mode = options.mode?.trim();
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
    const res = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }]
    });
    if (res.error) {
      return {
        ok: false,
        text: this.turnText.trim(),
        error: res.error.message ?? "agent error"
      };
    }
    return {
      ok: true,
      text: this.turnText.trim(),
      stopReason: res.result?.stopReason
    };
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

  public dispose(): void {
    this.closed = true;
    this.pending.clear();
  }

  private async handshake(): Promise<void> {
    try {
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: Boolean(this.opts.readFile), writeTextFile: false }
        }
      });
      if (init.error) throw new Error(init.error.message ?? "initialize failed");
      const created = await this.request("session/new", {
        cwd: this.opts.cwd,
        mcpServers: (this.opts.mcpServers ?? []).map((server) => ({
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
      if (this.opts.model.trim()) {
        // A failed model switch is non-fatal — keep the session's default.
        await this.request("session/set_config_option", {
          sessionId: this.sessionId,
          configId: "model",
          value: this.opts.model.trim()
        });
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
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  private onUpdate(message: Incoming): void {
    const update = message.params?.update;
    if (!update) return;
    const kind = update.sessionUpdate;
    const text = update.content?.text;
    if (
      kind === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof text === "string"
    ) {
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
      if (path && this.opts.readFile) {
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
   * Answer a permission prompt: reads auto-allow, writes/executes go through
   * the interactive gate when one is wired, and decline otherwise. A prompt
   * racing with dispose() is dropped rather than answered.
   */
  private async answerPermission(message: Incoming): Promise<void> {
    const params = message.params ?? {};
    const tool = params.toolCall;
    let choice: PermissionChoice = "reject_once";
    if (isReadOnlyTool(tool)) {
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
}): Promise<AcpSessionHandle> {
  const spec = resolveAcpSpawn(opts.command);
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: spawnEnv(),
      stdio: "pipe",
      windowsHide: true,
      shell: spec.shell
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  let stderr = "";
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
    stderr += chunk.toString();
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
    try {
      child.kill();
    } catch {
      // already gone
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("opencode acp did not respond")),
      opts.startTimeoutMs ?? 30000
    );
  });
  try {
    await Promise.race([session.start(), timeout]);
  } catch (error) {
    dispose();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
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
