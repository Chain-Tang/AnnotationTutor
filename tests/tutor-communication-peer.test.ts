import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { discoverLocalTutorInstances, TutorCommunicationPeer, TUTOR_COMMUNICATION_PEER_LIMITS, type LocalTutorInstance, type TutorCommunicationPeerCredential } from "../src/tutor-communication-peer.js";
import type { CommunicationIdentity } from "../src/tutor-communication.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.unstubAllGlobals(); } });
const caller: CommunicationIdentity = { agentId: "tutor-beta", vaultId: "vault-beta", kind: "tutor" };
const host: CommunicationIdentity = { agentId: "tutor-alpha", vaultId: "vault-alpha", kind: "tutor" };
const instanceId = "a".repeat(24), token = "1".repeat(64);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function service(options: { host?: CommunicationIdentity; reportedCaller?: CommunicationIdentity; invoke?: (name: string, args: Record<string, unknown>) => Promise<unknown> } = {}) {
  const actualHost = options.host ?? host;
  let pairedCaller: CommunicationIdentity | undefined;
  const pairRequests: Record<string, unknown>[] = [], toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const origins: (string | undefined)[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const http = createServer((request, response) => { void (async () => {
    origins.push(request.headers.origin);
    if (request.headers.origin) { response.writeHead(403); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/pair") {
      pairRequests.push(body); pairedCaller = body.communicationIdentity;
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ token, clientId: "peer-client" })); return;
    }
    if (request.url !== "/mcp" || request.headers.authorization !== `Bearer ${token}` || !pairedCaller) { response.writeHead(401); response.end(); return; }
    const mcp = new Server({ name: "peer-fixture", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args = {} } = request.params;
      const value = name === "tutor_communication_identity" ? { host: actualHost, caller: options.reportedCaller ?? pairedCaller } :
        { value: options.invoke ? await options.invoke(name, args) : { name, args, host: actualHost } };
      if (name !== "tutor_communication_identity") toolCalls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport); await transport.handleRequest(request, response, body);
  })().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }); });
  http.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); });
  const entry: LocalTutorInstance = { id: instanceId, name: "Alpha", port: (http.address() as import("node:net").AddressInfo).port, pid: process.pid, identity: actualHost };
  return { entry, pairRequests, toolCalls, origins };
}

function peer(entry: LocalTutorInstance, options: { identity?: CommunicationIdentity; fetch?: typeof fetch; discover?: () => Promise<LocalTutorInstance[]> } = {}) {
  const credentials = new Map<string, TutorCommunicationPeerCredential>();
  const writes: string[] = [], reads: string[] = [];
  const client = new TutorCommunicationPeer({ instanceId: entry.id, identity: options.identity ?? caller, fetch: options.fetch, discover: options.discover ?? (async () => [entry]),
    readCredential: async id => { reads.push(id); return credentials.get(id); },
    writeCredential: async (id, value) => { writes.push(id); credentials.set(id, value); } });
  cleanup.push(() => client.close());
  return { client, credentials, reads, writes };
}

describe("fixed Tutor communication peer", () => {
  it("uses Node HTTP in a renderer even when global fetch cannot access the loopback service", async () => {
    const rendererFetch = vi.fn(async () => { throw new Error("renderer fetch blocked by Origin/CORS"); });
    vi.stubGlobal("fetch", rendererFetch);
    const remote = await service(), f = peer(remote.entry);
    expect(await f.client.pair({ name: "Tutor Beta" })).toEqual({ host, caller });
    const result = await f.client.call("tutor_communication_mailbox", { spaceId: "shared" });
    expect(result.structuredContent?.value).toEqual({ name: "tutor_communication_mailbox", args: { spaceId: "shared" }, host });
    expect(rendererFetch).not.toHaveBeenCalled();
    expect(remote.origins.length).toBeGreaterThan(1);
    expect(remote.origins.every(origin => origin === undefined)).toBe(true);
  });

  it("pairs only explicitly through the target UI endpoint, verifies identities, then routes communication calls", async () => {
    const remote = await service(), f = peer(remote.entry);
    await expect(f.client.call("tutor_communication_mailbox", {})).rejects.toThrow("communication-peer-not-paired");
    expect(remote.pairRequests).toHaveLength(0);
    expect(await f.client.pair({ name: "Tutor Beta" })).toEqual({ host, caller });
    expect(remote.pairRequests).toEqual([{ name: "Tutor Beta", communicationIdentity: caller }]);
    expect(f.credentials.get(instanceId)).toEqual({ token, clientId: "peer-client", hostIdentity: host });
    expect(f.writes).toEqual([instanceId]);
    const result = await f.client.call("tutor_communication_mailbox", { spaceId: "philosophy" });
    expect(result.structuredContent).toEqual({ value: { name: "tutor_communication_mailbox", args: { spaceId: "philosophy" }, host } });
    expect(remote.toolCalls).toEqual([{ name: "tutor_communication_mailbox", args: { spaceId: "philosophy" } }]);
    await expect(f.client.call("tutor_start_task", {})).rejects.toThrow("communication-peer-tool-denied");
    await expect(f.client.call("tutor_communication_send", { instanceId: "b".repeat(24) })).rejects.toThrow("communication-peer-routing-fixed");
    expect(remote.pairRequests).toHaveLength(1);
  });

  it("never accepts a different caller or writes a credential for an unverified pairing", async () => {
    const remote = await service({ reportedCaller: { ...caller, agentId: "some-other-agent" } }), f = peer(remote.entry);
    await expect(f.client.pair({ name: "Tutor Beta" })).rejects.toThrow("communication-peer-identity-mismatch");
    expect(f.writes).toHaveLength(0); expect(f.credentials.size).toBe(0); expect(remote.toolCalls).toHaveLength(0);
  });

  it("pins the discovered and recorded host identities before any space or message operation", async () => {
    const remote = await service(), f = peer(remote.entry);
    await f.client.pair({ name: "Tutor Beta" });
    f.credentials.set(instanceId, { token, hostIdentity: { ...host, agentId: "old-host" } });
    await expect(f.client.call("tutor_communication_send", { text: "hello" })).rejects.toThrow("communication-peer-identity-mismatch");
    expect(remote.toolCalls).toHaveLength(0);
    const g = peer({ ...remote.entry, identity: { ...host, agentId: "unexpected-host" } });
    await expect(g.client.pair({ name: "Tutor Beta" })).rejects.toThrow("communication-peer-identity-mismatch");
    expect(g.writes).toHaveLength(0);
  });

  it("keeps two independent vault sessions fixed while requests overlap", async () => {
    const entered = deferred(), release = deferred();
    const first = await service({ invoke: async () => { entered.resolve(); await release.promise; return "first"; } });
    const secondHost: CommunicationIdentity = { agentId: "tutor-gamma", vaultId: "vault-gamma", kind: "tutor" };
    const second = await service({ host: secondHost });
    const a = peer(first.entry), b = peer({ ...second.entry, id: "b".repeat(24) });
    await a.client.pair({ name: "Beta to Alpha" }); await b.client.pair({ name: "Beta to Gamma" });
    const pending = a.client.call("tutor_communication_mailbox", { spaceId: "a" });
    await entered.promise;
    const result = await b.client.call("tutor_communication_mailbox", { spaceId: "b" });
    expect(result.structuredContent?.value).toEqual({ name: "tutor_communication_mailbox", args: { spaceId: "b" }, host: secondHost });
    release.resolve(); expect((await pending).structuredContent?.value).toBe("first");
    expect(a.reads.every(id => id === instanceId)).toBe(true); expect(b.reads.every(id => id === "b".repeat(24))).toBe(true);
  });

  it("reports unavailable services and enforces bounded requests, redirect policy and response bodies", async () => {
    const entry: LocalTutorInstance = { id: instanceId, name: "unused", port: 1, pid: process.pid, identity: host };
    const missing = peer(entry, { discover: async () => [] });
    await expect(missing.client.call("tutor_communication_identity")).rejects.toThrow("communication-peer-unavailable");
    const oversized = peer(entry);
    await expect(oversized.client.call("tutor_communication_send", { text: "x".repeat(TUTOR_COMMUNICATION_PEER_LIMITS.requestBytes) })).rejects.toThrow("communication-peer-request-too-large");
    let requests = 0;
    const redirect = peer(entry, { fetch: async (_input, init) => { requests++; expect(init?.redirect).toBe("error"); return new Response(null, { status: 307, headers: { location: "https://example.com" } }); } });
    await expect(redirect.client.pair({ name: "Test" })).rejects.toThrow("communication-peer-redirect-denied"); expect(requests).toBe(1);
    const large = peer(entry, { fetch: async () => new Response("x".repeat(TUTOR_COMMUNICATION_PEER_LIMITS.responseBytes + 1)) });
    await expect(large.client.pair({ name: "Test" })).rejects.toThrow("communication-peer-response-too-large");
  });

  it("aborts an in-flight call on close and does not reconnect or create a daemon", async () => {
    const entered = deferred(), release = deferred();
    const remote = await service({ invoke: async () => { entered.resolve(); await release.promise; return "late"; } }), f = peer(remote.entry);
    await f.client.pair({ name: "Tutor Beta" });
    const pending = f.client.call("tutor_communication_mailbox", {}).catch(error => error);
    await entered.promise;
    await f.client.close(); release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    await expect(f.client.call("tutor_communication_identity")).rejects.toThrow("communication-peer-closed");
    expect(remote.pairRequests).toHaveLength(1);
  });
});

it("discovers only bounded, live local metadata and never follows a credential file or symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutor-peer-discovery-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const entry = { version: 1, id: instanceId, name: "Alpha", port: 12345, pid: process.pid, identity: host, token: "must-not-be-returned" };
  await writeFile(join(directory, `${instanceId}.json`), JSON.stringify(entry));
  await writeFile(join(directory, `${"b".repeat(24)}.json`), JSON.stringify({ ...entry, id: "b".repeat(24), port: 70000 }));
  await writeFile(join(directory, "other.txt"), "invalid");
  await symlink(join(directory, `${instanceId}.json`), join(directory, `${"c".repeat(24)}.json`));
  expect(await discoverLocalTutorInstances(directory)).toEqual([{ id: instanceId, name: "Alpha", port: 12345, pid: process.pid, identity: host }]);
});
