// Killing an agent process is not enough: `opencode acp` spawns its own MCP
// server children, and on Windows a bare `child.kill()` only takes down the
// direct child (or the cmd.exe shell when we had to fall back to one), leaving
// orphans that hold memory and ports. This module decides *how* to kill a tree
// per platform; the decision is pure so it is unit-tested, and the thin wrapper
// does the actual spawning.

import { spawn, type ChildProcess } from "node:child_process";

/**
 * How to terminate a whole process tree on `platform`. Windows has no process
 * groups, so we shell out to `taskkill /T` (kill tree) `/F` (force). Elsewhere
 * null means "no helper needed" — the caller signals the process directly.
 */
export function treeKillSpec(
  pid: number | undefined,
  platform: string
): { command: string; args: string[] } | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (platform !== "win32") return null;
  return { command: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
}

/**
 * Terminate `child` and everything it spawned. Best-effort: a process that is
 * already gone is not an error, so every step swallows its failure.
 */
export function killProcessTree(child: ChildProcess): void {
  const spec = treeKillSpec(child.pid, process.platform);
  if (spec) {
    try {
      spawn(spec.command, spec.args, { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      // taskkill unavailable — fall through to the plain kill below.
    }
  }
  try {
    child.kill();
  } catch {
    // already gone
  }
}
