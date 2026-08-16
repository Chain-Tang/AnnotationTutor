import { describe, expect, it } from "vitest";
import { parseMcpConfig, serializeMcpConfig } from "../src/mcp-config.js";

describe("parseMcpConfig", () => {
  it("treats empty input as an empty server list", () => {
    expect(parseMcpConfig("")).toEqual({ ok: true, servers: [] });
    expect(parseMcpConfig("   \n ")).toEqual({ ok: true, servers: [] });
  });

  it("rejects invalid JSON", () => {
    expect(parseMcpConfig("{ nope")).toEqual({ ok: false, error: "invalid-json" });
  });

  it("rejects arrays and primitives", () => {
    expect(parseMcpConfig("[]").ok).toBe(false);
    expect(parseMcpConfig('"fetch"').ok).toBe(false);
  });

  it("parses the wrapped mcpServers shape", () => {
    const result = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] }
        }
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers).toEqual([
      { name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }
    ]);
  });

  it("parses a bare named map of servers and keeps env strings only", () => {
    const result = parseMcpConfig(
      JSON.stringify({
        fetch: { command: "uvx", env: { TOKEN: "abc", SKIP: 42 } },
        notes: { command: "node", args: ["server.js", 7] }
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toEqual({
      name: "fetch",
      command: "uvx",
      env: { TOKEN: "abc" }
    });
    expect(result.servers[1]).toEqual({
      name: "notes",
      command: "node",
      args: ["server.js"]
    });
  });

  it("parses a single server carrying its own name", () => {
    const result = parseMcpConfig(
      JSON.stringify({ name: "zotero", command: "npx", args: ["-y", "zotero-mcp"] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers).toEqual([
      { name: "zotero", command: "npx", args: ["-y", "zotero-mcp"] }
    ]);
  });

  it("parses a bare single server with a default name", () => {
    const result = parseMcpConfig(JSON.stringify({ command: "uvx", args: ["mcp"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers[0]?.name).toBe("mcp-server");
  });

  it("rejects a map without any usable stdio server", () => {
    expect(parseMcpConfig(JSON.stringify({ fetch: { url: "https://x" } }))).toEqual({
      ok: false,
      error: "no-servers"
    });
  });

  it("drops a command carrying shell metacharacters but keeps safe siblings", () => {
    const result = parseMcpConfig(
      JSON.stringify({
        safe: { command: "node", args: ["server.js"] },
        evil: { command: "node ; rm -rf ~" }
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers.map((s) => s.name)).toEqual(["safe"]);
    expect(result.dropped).toEqual(["evil"]);
  });

  it("lists an HTTP-only entry (no command) among the dropped names", () => {
    const result = parseMcpConfig(
      JSON.stringify({
        notes: { command: "node" },
        remote: { url: "https://mcp.example" }
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers.map((s) => s.name)).toEqual(["notes"]);
    expect(result.dropped).toEqual(["remote"]);
  });
});

describe("serializeMcpConfig", () => {
  it("round-trips through the wrapped shape", () => {
    const servers = [{ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }];
    const text = serializeMcpConfig(servers);
    expect(parseMcpConfig(text)).toEqual({ ok: true, servers });
  });

  it("serializes an empty list as an empty string", () => {
    expect(serializeMcpConfig([])).toBe("");
  });
});
