// OpenCode review engine over the Agent Client Protocol (ACP).
//
// This is the connection mode that actually works from inside Electron, where a
// one-shot `opencode run` fails (Bun does not drain a Node stdin pipe, and the
// `build` agent loop exits with no text). ACP keeps stdin open and exchanges
// newline-delimited JSON-RPC, which the agent reads incrementally via readline —
// the same approach the `claudian` plugin uses. Protocol verified against
// OpenCode 1.16.2 (`opencode acp`):
//
//   initialize {protocolVersion:1, clientCapabilities:{fs:{...}}}
//   session/new {cwd, mcpServers:[]} -> {sessionId, configOptions}
//   session/set_config_option {sessionId, configId:"model", value}
//   session/prompt {sessionId, prompt:[{type:"text", text}]} -> {stopReason}
//   (streamed) session/update: update.sessionUpdate === "agent_message_chunk"
//              carries the answer text; "agent_thought_chunk" is reasoning (skip).
//
// The conversation driver is transport-agnostic (send is injected) so it is
// unit-tested without a real CLI; only `runAcpReview` touches child_process.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { spawnEnv } from "./agent-runner.js";

const isWindows = process.platform === "win32";

export type AcpReviewResult = {
  /** True when the turn completed and produced assistant text. */
  ok: boolean;
  reviewText: string;
  timedOut?: boolean;
  stopReason?: string;
  /** Set on spawn failure, protocol error, or a clean exit with no text. */
  error?: string;
};

/** Outcome of the protocol-level conversation (no transport concerns). */
export type AcpOutcome = {
  ok: boolean;
  reviewText: string;
  stopReason?: string;
  error?: string;
};

type Outgoing = Record<string, unknown>;
type Incoming = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: { sessionId?: string; stopReason?: string } & Record<string, unknown>;
  error?: { code?: number; message?: string };
  params?: {
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
  } & Record<string, unknown>;
};

/**
 * Drives one ACP review turn. Feed it parsed JSON-RPC messages via `receive`;
 * it sends requests through the injected `send` and resolves `done` with the
 * accumulated assistant text once the prompt turn ends.
 */
export class AcpReviewConversation {
  private nextId = 1;
  private readonly stageById = new Map<number, string>();
  private sessionId: string | null = null;
  private text = "";
  private finished = false;
  private resolveDone!: (outcome: AcpOutcome) => void;
  public readonly done: Promise<AcpOutcome>;

  public constructor(
    private readonly send: (message: Outgoing) => void,
    private readonly opts: { cwd: string; model: string; prompt: string }
  ) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Begin the handshake. */
  public start(): void {
    this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
      },
      "initialize"
    );
  }

  /** Feed one parsed JSON-RPC message received from the agent. */
  public receive(message: Incoming): void {
    if (this.finished || !message) return;
    // A response to one of our requests (has id, no method).
    if (message.id !== undefined && message.method === undefined) {
      const stage = this.stageById.get(message.id as number);
      this.stageById.delete(message.id as number);
      this.onResponse(stage, message);
      return;
    }
    // A request or notification from the agent.
    if (typeof message.method === "string") {
      if (message.method === "session/update") this.onUpdate(message);
      if (message.id !== undefined) this.answerAgentRequest(message);
    }
  }

  /** Abort with an error (e.g. the process died). */
  public fail(error: string): void {
    this.finish({ ok: false, reviewText: this.text.trim(), error });
  }

  private finish(outcome: AcpOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveDone(outcome);
  }

  private request(method: string, params: Outgoing, stage: string): void {
    const id = this.nextId++;
    this.stageById.set(id, stage);
    this.send({ jsonrpc: "2.0", id, method, params });
  }

  private onResponse(stage: string | undefined, message: Incoming): void {
    if (message.error) {
      // A failed model switch is non-fatal — proceed with the default model.
      if (stage === "config") {
        this.sendPrompt();
        return;
      }
      this.fail(message.error.message ?? "agent error");
      return;
    }
    if (stage === "initialize") {
      this.request(
        "session/new",
        { cwd: this.opts.cwd, mcpServers: [] },
        "new"
      );
    } else if (stage === "new") {
      this.sessionId = message.result?.sessionId ?? null;
      if (!this.sessionId) {
        this.fail("no sessionId returned");
        return;
      }
      if (this.opts.model.trim()) {
        this.request(
          "session/set_config_option",
          { sessionId: this.sessionId, configId: "model", value: this.opts.model.trim() },
          "config"
        );
      } else {
        this.sendPrompt();
      }
    } else if (stage === "config") {
      this.sendPrompt();
    } else if (stage === "prompt") {
      this.finish({
        ok: true,
        reviewText: this.text.trim(),
        stopReason: message.result?.stopReason
      });
    }
  }

  private sendPrompt(): void {
    this.request(
      "session/prompt",
      {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: this.opts.prompt }]
      },
      "prompt"
    );
  }

  private onUpdate(message: Incoming): void {
    const update = message.params?.update;
    if (
      update?.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      this.text += update.content.text;
    }
  }

  /** Keep the turn moving by answering agent->client requests defensively. */
  private answerAgentRequest(message: Incoming): void {
    const method = message.method ?? "";
    if (method.includes("request_permission")) {
      // A review needs no tools, so decline any permission prompt.
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "cancelled" } }
      });
    } else {
      // We advertised no fs/terminal capability; refuse anything else.
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "unsupported" }
      });
    }
  }
}

/**
 * Extract the target `.exe` from an npm `.cmd` shim, resolving its `%dp0%`
 * (= the shim's own directory). Returns null when the shim has no `.exe` ref.
 */
export function exeFromCmdShim(cmdPath: string, content: string): string | null {
  const match = /"([^"\n]*\.exe)"/i.exec(content);
  if (!match || !match[1]) return null;
  const dir = win32.dirname(cmdPath);
  const prefix = dir.endsWith("\\") || dir.endsWith("/") ? dir : `${dir}\\`;
  return win32.normalize(match[1].replace(/%~?dp0%\\?/i, prefix));
}

/**
 * Resolve how to spawn `<command> acp`. On Windows we must avoid running the
 * `.cmd` shim through cmd.exe (its stdio piping is unreliable, exactly the bug
 * that breaks `opencode run`): find the real `.exe` and spawn it directly.
 */
export function resolveAcpSpawn(command: string): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const cmd = command.trim() || "opencode";
  if (!isWindows) return { command: cmd, args: ["acp"], shell: false };

  const exe = resolveWindowsExe(cmd);
  if (exe) return { command: exe, args: ["acp"], shell: false };
  // Last resort: let cmd.exe resolve it (may be unreliable for stdio).
  return { command: cmd, args: ["acp"], shell: true };
}

/** Find the real opencode `.exe` on Windows, following npm `.cmd` shims. */
function resolveWindowsExe(command: string): string | null {
  const hasSep = command.includes("\\") || command.includes("/");
  if (command.toLowerCase().endsWith(".exe")) {
    return existsSync(command) ? command : null;
  }
  if (hasSep && /\.(cmd|bat)$/i.test(command)) {
    return readShim(command);
  }
  if (hasSep) return existsSync(command) ? command : null;

  // Bare name: search PATH (plus the npm global-bin dir) for an exe or shim.
  const appData = process.env.APPDATA;
  const dirs = [
    ...(process.env.PATH ?? process.env.Path ?? "").split(";"),
    ...(appData ? [`${appData}\\npm`] : [])
  ].filter(Boolean);
  for (const dir of dirs) {
    const exe = join(dir.trim(), `${command}.exe`);
    if (existsSync(exe)) return exe;
  }
  for (const dir of dirs) {
    const shim = join(dir.trim(), `${command}.cmd`);
    if (existsSync(shim)) {
      const exe = readShim(shim);
      if (exe) return exe;
    }
  }
  return null;
}

function readShim(cmdPath: string): string | null {
  try {
    const exe = exeFromCmdShim(cmdPath, readFileSync(cmdPath, "utf8"));
    return exe && existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** Run one review against `opencode acp`, returning the assistant text. */
export async function runAcpReview(opts: {
  command: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  cwd?: string;
}): Promise<AcpReviewResult> {
  const spec = resolveAcpSpawn(opts.command);
  const cwd = opts.cwd ?? tmpdir();
  return await new Promise<AcpReviewResult>((resolve) => {
    let settled = false;
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env: spawnEnv(),
        stdio: "pipe",
        windowsHide: true,
        shell: spec.shell
      });
    } catch (error) {
      resolve({
        ok: false,
        reviewText: "",
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const finish = (result: AcpReviewResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(result);
    };

    const conversation = new AcpReviewConversation(
      (message) => {
        try {
          child.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
          // stdin closed; the close handler will report it.
        }
      },
      { cwd, model: opts.model, prompt: opts.prompt }
    );

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      try {
        conversation.receive(JSON.parse(trimmed) as Incoming);
      } catch {
        // Not a JSON-RPC line — ignore.
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) =>
      finish({ ok: false, reviewText: "", error: error.message })
    );
    child.on("close", () => {
      if (!settled) {
        finish({
          ok: false,
          reviewText: "",
          error: lastLine(stderr) || "opencode acp exited before replying"
        });
      }
    });

    timer = setTimeout(
      () => finish({ ok: false, reviewText: "", timedOut: true }),
      opts.timeoutMs
    );

    void conversation.done.then((outcome) =>
      finish({
        ok: outcome.ok && outcome.reviewText.length > 0,
        reviewText: outcome.reviewText,
        stopReason: outcome.stopReason,
        error: outcome.error
      })
    );
    conversation.start();
  });
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  return last.length > 200 ? `${last.slice(0, 197)}…` : last;
}
