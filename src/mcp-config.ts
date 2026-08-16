// Paste-friendly MCP server configuration, ported from Qoderian's
// mcp-config-parser. Learners paste whatever shape they found in a README —
// a wrapped `mcpServers` object, a named map of servers, a single server with
// a name field, or a bare `{command, args}` object — and get a canonical list
// ready for the ACP `session/new` mcpServers parameter. Pure, unit-tested.

import type { McpServerConfig } from "./acp-session.js";

export type McpParseResult =
  | { ok: true; servers: McpServerConfig[]; dropped?: string[] }
  | { ok: false; error: string };

/** Normalize one raw server object; returns null when it is not usable. */
function normalizeServer(
  name: string,
  raw: unknown
): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!command || !name.trim()) return null;
  // Reject shell metacharacters in the command: a config pasted from anywhere
  // could chain commands ("node ; rm -rf ~") if it ever reaches a shell. Args
  // and env are passed as an argv array / map, so only `command` needs this.
  if (/[\n\r;|&`$]/.test(command)) return null;
  const args = Array.isArray(obj.args)
    ? obj.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const env: Record<string, string> = {};
  if (obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)) {
    for (const [key, value] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return {
    name: name.trim(),
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {})
  };
}

/**
 * Parse pasted MCP configuration text into stdio server definitions. Accepts
 * four shapes: `{mcpServers: {...}}`, a map of named servers, one server with
 * an inline `name`, or a bare single server. Only stdio servers (with a
 * `command`) are supported — that is all ACP's session/new takes.
 */
export function parseMcpConfig(text: string): McpParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, servers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not-an-object" };
  }
  const obj = parsed as Record<string, unknown>;

  // Shape 1: { mcpServers: { name: {command,...}, ... } }
  const wrapped = obj.mcpServers;
  if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    return collectServers(wrapped as Record<string, unknown>);
  }

  // Shape 3: a single server carrying its own name field.
  if (typeof obj.command === "string") {
    const name = typeof obj.name === "string" && obj.name.trim()
      ? obj.name
      : "mcp-server";
    const server = normalizeServer(name, obj);
    return server ? { ok: true, servers: [server] } : { ok: false, error: "no-command" };
  }

  // Shape 2/4: a map of named servers (or one unnamed entry — rejected since a
  // stdio server without a name cannot be surfaced to the agent).
  return collectServers(obj);
}

function collectServers(entries: Record<string, unknown>): McpParseResult {
  const servers: McpServerConfig[] = [];
  const dropped: string[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    const server = normalizeServer(name, raw);
    if (server) servers.push(server);
    // A named entry we could not use (HTTP-only, no command, unsafe command) is
    // worth surfacing rather than silently swallowing.
    else if (name.trim()) dropped.push(name.trim());
  }
  if (servers.length === 0) return { ok: false, error: "no-servers" };
  return { ok: true, servers, ...(dropped.length > 0 ? { dropped } : {}) };
}

/** Canonical JSON for persisting a parsed server list back into settings. */
export function serializeMcpConfig(servers: McpServerConfig[]): string {
  if (servers.length === 0) return "";
  return JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, s])) }, null, 2);
}
