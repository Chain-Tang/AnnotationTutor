// Optional auto-run bridge: spawn an already-authenticated agent CLI (OpenCode by
// default) to review one annotation in a SINGLE model call, then return the
// review text so the plugin can write it into the annotation file itself.
//
// This is deliberately self-contained: we send the rubric + the selected text +
// the learner's note over stdin and read the reply from stdout. The agent does
// NOT crawl the Vault (no file reads, no edits, no tool round-trips), which is
// what made the old "let the agent read AGENTS.md, the inbox, the annotation and
// the source, then edit two files" flow slow. Files stay the source of truth —
// the plugin writes the returned review through the same Markdown path a manual
// review would use.
//
// The string helpers are pure so they can be unit-tested without a real CLI;
// only `runAgentCapture` touches `node:child_process`. No Obsidian imports here,
// so this module is importable from tests.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { IndexRecord } from "./model.js";
import { parseModelList } from "./agent-models.js";
import { reviewLanguageInstruction } from "./markdown/overview.js";
import { detectLanguageName } from "./lang.js";

export type CaptureOptions = {
  /** Executable to run, e.g. "opencode". Resolved via PATH (PATHEXT on Windows). */
  command: string;
  /** provider/model, e.g. "opencode/mimo-v2.5-free". Empty = the CLI's default. */
  model: string;
  /** The full instruction, sent over stdin (so multi-line content needs no quoting). */
  prompt: string;
  /** Hard timeout; the child is killed when it elapses. */
  timeoutMs: number;
  /** Working directory. Defaults to the OS temp dir so no project AGENTS.md loads. */
  cwd?: string;
  /** Optional streaming hook for stdout/stderr chunks. */
  onLog?: (chunk: string) => void;
};

export type CaptureResult = {
  /** True only on a clean exit code 0 that did not time out. */
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  /** The assistant's reply, extracted from the JSON event stream. */
  reviewText: string;
  /** Raw combined stdout + stderr, for diagnostics. */
  raw: string;
  /** Set when the process could not be spawned (e.g. command not found). */
  spawnError?: string;
};

const isWindows = process.platform === "win32";

/**
 * A GUI app (Obsidian) is often launched with a PATH that omits where CLIs like
 * `opencode` get installed, so a bare `opencode` fails with "not found":
 *  - Windows: the global npm bin dir (`%APPDATA%\npm`) predates the app's PATH.
 *  - macOS/Linux: an app launched from Finder/Dock/a desktop entry inherits a
 *    minimal PATH that omits Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) and
 *    per-user installs (`~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`).
 * Prepend the likely install dirs so the CLI resolves regardless of how Obsidian
 * was started. Pure and platform-injectable so both branches are unit-testable.
 * Returns the same `env` reference when nothing needs adding.
 */
export function spawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const extra = extraBinDirs(env, platform);
  if (extra.length === 0) return env;
  const sep = platform === "win32" ? ";" : ":";
  const norm = (dir: string): string => {
    const trimmed = dir.trim().replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ??
    (platform === "win32" ? "Path" : "PATH");
  const current = env[pathKey] ?? "";
  const have = new Set(current.split(sep).map(norm));
  const missing = extra.filter((dir) => !have.has(norm(dir)));
  if (missing.length === 0) return env;
  const prefix = missing.join(sep);
  return { ...env, [pathKey]: current ? `${prefix}${sep}${current}` : prefix };
}

/** Likely CLI install dirs for the platform that may be missing from a GUI PATH. */
function extraBinDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData ? [`${appData}\\npm`] : [];
  }
  const home = env.HOME;
  return [
    "/opt/homebrew/bin", // Apple Silicon Homebrew
    "/usr/local/bin", // Intel Homebrew + common installs
    ...(home
      ? [`${home}/.opencode/bin`, `${home}/.local/bin`, `${home}/.bun/bin`]
      : [])
  ];
}

/**
 * A self-contained review instruction. Everything the model needs is inline, so
 * it never has to read files. The persona is a helpful learning assistant: a
 * direct question gets a real answer (never a "work it out yourself" deflection),
 * and a stated understanding gets affirmed and gently corrected. The reply stays
 * terse and natural — a margin note, not a form. Only three labels are kept, and
 * only because `parseAgentReview` needs them to recover correctness (for status)
 * plus the displayed text; the labels themselves are hidden from the card.
 *
 * When no explicit `reviewLanguage` is set we detect the note's script and pin a
 * concrete target (e.g. Chinese), because free models otherwise drift to English.
 */
export function buildReviewPrompt(
  record: IndexRecord,
  reviewLanguage = "",
  profileSummary = ""
): string {
  const note = record.userNote ?? record.userNoteSummary ?? "";
  const target = reviewLanguage.trim() || detectLanguageName(note);
  const profile = profileSummary.trim();
  return [
    "You are a warm, knowledgeable learning assistant leaving a short note in the margin of a learner's book.",
    "Read the selected source text and the learner's note, then reply as a helpful tutor would.",
    "Reply with the note and nothing else — no preamble, no tool use, no headings, no bullet lists.",
    reviewLanguageInstruction(target),
    ...(profile
      ? [
          "",
          "What you know about this learner (tailor depth, examples, and tone to them):",
          '"""',
          profile,
          '"""'
        ]
      : []),
    "",
    "Use exactly these three labels, each starting on its own line, and write nothing else:",
    "Correctness: one of correct, partially_correct, incorrect, uncertain (judge the note; use uncertain when the note is purely a question).",
    "Comment: 2-5 sentences spoken directly to the learner. If the note asks a question, answer it clearly and completely in plain language — never tell the learner to work it out alone. If the note states an understanding, confirm what is right, gently correct any mistake, and add one helpful clarification.",
    "Question: optionally one short follow-up question that deepens understanding. If a question would not help, leave this line empty.",
    "",
    "Selected text from the source:",
    '"""',
    record.selectedText,
    '"""',
    "",
    "The learner's note:",
    '"""',
    note,
    '"""'
  ].join("\n");
}

/** Build the argv for a non-interactive JSON `opencode run`. Prompt goes via stdin. */
export function buildCaptureArgs(model: string): string[] {
  const args = ["run"];
  const trimmed = model.trim();
  if (trimmed) args.push("-m", trimmed);
  args.push("--format", "json");
  return args;
}

/**
 * Extract the assistant's text from an `opencode run --format json` stream. Each
 * line is one JSON event; the reply lives in `type:"text"` parts. Non-JSON lines
 * (stray logs) are ignored.
 */
export function extractReviewText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        part?: { type?: string; text?: string };
      };
      if (event.type === "text" && typeof event.part?.text === "string") {
        parts.push(event.part.text);
      }
    } catch {
      // Not a JSON event line — ignore.
    }
  }
  return parts.join("").trim();
}

/** Quote a single argument for cmd.exe (only when it contains metacharacters). */
export function quoteWinArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Join command + args into a single cmd.exe command line. */
export function buildWindowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWinArg).join(" ");
}

export async function runAgentCapture(
  opts: CaptureOptions
): Promise<CaptureResult> {
  const args = buildCaptureArgs(opts.model);
  const cwd = opts.cwd ?? tmpdir();
  return await new Promise<CaptureResult>((resolve) => {
    let raw = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: CaptureResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = isWindows
        ? spawn(buildWindowsCommandLine(opts.command, args), {
            cwd,
            shell: true,
            windowsHide: true,
            env: spawnEnv()
          })
        : spawn(opts.command, args, { cwd, shell: false, env: spawnEnv() });
    } catch (error) {
      finish({
        ok: false,
        code: null,
        timedOut: false,
        reviewText: "",
        raw: "",
        spawnError: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const append = (chunk: Buffer): void => {
      const text = chunk.toString();
      raw += text;
      opts.onLog?.(text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        code: null,
        timedOut,
        reviewText: "",
        raw,
        spawnError: error.message
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        reviewText: extractReviewText(raw),
        raw
      });
    });

    // Send the whole prompt over stdin so multi-line content needs no quoting.
    try {
      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    } catch {
      // If stdin is unavailable the child will exit; close handler reports it.
    }
  });
}

export type ModelListResult = {
  /** True on a clean exit that yielded at least one model id. */
  ok: boolean;
  /** The discovered `provider/model` ids. */
  models: string[];
  /** Raw combined stdout + stderr, for diagnostics. */
  raw: string;
  /** Set when the CLI could not be spawned or returned no usable models. */
  error?: string;
};

/**
 * Ask the agent CLI which models it can use (`opencode models`). This also doubles
 * as a connectivity/auth check: an authenticated CLI lists its providers' models,
 * so an empty list or a spawn error means it is unreachable or not signed in.
 * No inference happens, so it costs no quota.
 */
export async function listModels(
  command: string,
  timeoutMs = 20000
): Promise<ModelListResult> {
  const args = ["models"];
  return await new Promise<ModelListResult>((resolve) => {
    let raw = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: ModelListResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = isWindows
        ? spawn(buildWindowsCommandLine(command, args), {
            cwd: tmpdir(),
            shell: true,
            windowsHide: true,
            env: spawnEnv()
          })
        : spawn(command, args, { cwd: tmpdir(), shell: false, env: spawnEnv() });
    } catch (error) {
      finish({
        ok: false,
        models: [],
        raw: "",
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const append = (chunk: Buffer): void => {
      raw += chunk.toString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, models: [], raw, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const models = parseModelList(raw);
      if (timedOut) {
        finish({ ok: false, models, raw, error: "timed out" });
      } else if (models.length === 0) {
        finish({
          ok: false,
          models,
          raw,
          error: tailLine(raw) || `exit ${code ?? "unknown"}`
        });
      } else {
        finish({ ok: true, models, raw });
      }
    });
  });
}

/** Last non-empty line of text, for compact diagnostics. */
function tailLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
