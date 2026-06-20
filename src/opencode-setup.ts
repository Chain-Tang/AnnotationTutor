// One-tap OpenCode setup: find where OpenCode lives and what environment it
// needs, so the plugin can spawn it the same way the user's terminal does.
//
// A GUI app (Obsidian launched from Finder/Dock/a desktop entry) inherits a
// MINIMAL environment — a short PATH that omits version managers (nvm, fnm,
// asdf), Bun/pnpm, Homebrew, and custom installs. So a bare `opencode` that
// works in the user's terminal fails from the plugin ("command not found"), and
// even an absolute path can fail if OpenCode needs its runtime (node/bun) on
// PATH. We fix both by asking the user's LOGIN shell for the resolved binary
// path and its full PATH, then reusing that PATH for every spawn.
//
// The string helpers are pure so they can be unit-tested without a shell; only
// `probeOpenCodeEnv` touches `node:child_process`. No Obsidian imports here, so
// this module is importable from tests.

import { spawn } from "node:child_process";

/** Sentinels we print so the shell's own startup output can't be confused for ours. */
const PATH_TAG = "__ATL_PATH__:";
const BIN_TAG = "__ATL_BIN__:";

/** What the login-shell probe discovered. */
export type ShellProbe = {
  /** The shell's full PATH (as a terminal would have it). Empty if unknown. */
  path: string;
  /** Absolute path to the resolved binary, or "" when not found. */
  opencode: string;
};

/**
 * The user's login shell, falling back to a per-platform default when $SHELL is
 * unset (e.g. some GUI launches don't export it). zsh is macOS's default; bash
 * elsewhere.
 */
export function defaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  const shell = env.SHELL?.trim();
  if (shell) return shell;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * Build a login + interactive shell invocation that prints the shell's PATH and
 * the resolved binary path, each on its own sentinel-tagged line. Login +
 * interactive (`-ilc`) so the user's profile — where version managers extend
 * PATH — is sourced. The binary name is sanitized before it reaches the script.
 */
export function buildShellProbe(
  shell: string,
  binName = "opencode"
): { command: string; args: string[] } {
  const safe = /^[A-Za-z0-9._-]+$/.test(binName) ? binName : "opencode";
  const script =
    `printf '%s%s\\n' '${PATH_TAG}' "$PATH"; ` +
    `printf '%s%s\\n' '${BIN_TAG}' "$(command -v ${safe} 2>/dev/null)"`;
  return { command: shell, args: ["-ilc", script] };
}

/**
 * Parse the probe output. Scans for the two sentinel lines so any greeting a
 * noisy `.zshrc`/`.bashrc` prints is ignored.
 */
export function parseShellProbe(stdout: string): ShellProbe {
  let path = "";
  let opencode = "";
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(PATH_TAG)) {
      path = line.slice(PATH_TAG.length).trim();
    } else if (line.startsWith(BIN_TAG)) {
      opencode = line.slice(BIN_TAG.length).trim();
    }
  }
  return { path, opencode };
}

/**
 * Prepend the discovered shell PATH dirs ahead of `currentPath`, de-duplicated
 * (case-sensitively — POSIX paths are). Returns `currentPath` unchanged when the
 * shell PATH adds nothing.
 */
export function mergeShellPath(
  currentPath: string,
  shellPath: string,
  sep = ":"
): string {
  const norm = (dir: string): string => dir.trim().replace(/\/+$/, "");
  const have = new Set(
    currentPath.split(sep).map(norm).filter(Boolean)
  );
  const additions = shellPath
    .split(sep)
    .map((dir) => dir.trim())
    .filter((dir) => dir && !have.has(norm(dir)));
  if (additions.length === 0) return currentPath;
  return currentPath
    ? `${additions.join(sep)}${sep}${currentPath}`
    : additions.join(sep);
}

/**
 * Ask the user's login shell where OpenCode is and what its PATH is. Resolves to
 * null on Windows (PATH there is resolved via PATHEXT + the npm global dir, see
 * agent-runner/acp-runner) or when the shell yields nothing useful.
 */
export async function probeOpenCodeEnv(opts: {
  binName?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ShellProbe | null> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return null;
  const env = opts.env ?? process.env;
  const { command, args } = buildShellProbe(defaultShell(platform, env), opts.binName);
  const timeoutMs = opts.timeoutMs ?? 8000;
  return await new Promise<ShellProbe | null>((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: ShellProbe | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, { env, windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const probe = parseShellProbe(out);
      finish(probe.path || probe.opencode ? probe : null);
    });
  });
}
