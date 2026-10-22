import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const idA = "a".repeat(24), idB = "b".repeat(24), idC = "c".repeat(24);
const tokenA = "1".repeat(64), tokenB = "2".repeat(64), tokenC = "3".repeat(64);
const schema = { type: "object" as const, properties: {}, additionalProperties: false };
const basicTool: Tool = { name: "tutor_status", inputSchema: schema, description: "Current vault", annotations: { readOnlyHint: true, destructiveHint: false } };
const data = (result: Awaited<ReturnType<Client["callTool"]>>) => result.structuredContent as Record<string, any>;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(selected?: string) {
  const home = await mkdtemp(join(tmpdir(), "tutor-connector-unit-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, ".local", "share", "tutor");
  await mkdir(join(root, "instances"), { recursive: true });
  await mkdir(join(root, "clients"), { recursive: true });
  const publish = async (id: string, port: number, token?: string) => {
    await writeFile(join(root, "instances", `${id}.json`), JSON.stringify({ id, port, pid: process.pid, name: `vault-${id[0]}` }));
    if (token) await writeFile(join(root, "clients", `codex-${id}.json`), JSON.stringify({ token, clientId: id }));
  };
  const connect = async () => {
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    env.HOME = home;
    delete env.TUTOR_INSTANCE_ID;
    if (selected) env.TUTOR_INSTANCE_ID = selected;
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "host-plugins/tutor/scripts/connector-source.mjs")], env, stderr: "pipe" });
    const client = new Client({ name: "connector-test", version: "1" });
    await client.connect(transport);
    cleanup.push(() => client.close());
    return client;
  };
  return { root, publish, connect };
}

async function service(vault: string, initialToken: string, options: { tools?: Tool[]; invoke?: (name: string, args: Record<string, unknown>, authorization: string) => Promise<Record<string, unknown>> } = {}) {
  let token = initialToken, nextToken = initialToken, pairCalls = 0;
  const calls: { name: string; args: Record<string, unknown>; authorization: string }[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: HttpServer = createServer((request, response) => { void (async () => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/pair") {
      pairCalls++;
      token = nextToken;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ token, clientId: `${vault}-repaired` }));
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    const mcp = new Server({ name: vault, version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.tools ?? [basicTool] }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      const args = request.params.arguments ?? {};
      calls.push({ name: request.params.name, args, authorization });
      const result = options.invoke ? await options.invoke(request.params.name, args, authorization) : { vault, args };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  })().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }); });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { port: (server.address() as import("node:net").AddressInfo).port, calls, pairCalls: () => pairCalls, repairToken: (value: string) => { nextToken = value; } };
}

describe("multi-vault Tutor connector", () => {
  it("pins concurrent routed calls to each vault and strips connector-only routing arguments", async () => {
    const entered = deferred(), release = deferred();
    const a = await service("A", tokenA, { invoke: async (_name, args) => { entered.resolve(); await release.promise; return { vault: "A", args }; } });
    const b = await service("B", tokenB);
    const f = await fixture(idA);
    await f.publish(idA, a.port, tokenA); await f.publish(idB, b.port, tokenB);
    const client = await f.connect();
    const first = client.callTool({ name: "tutor_status", arguments: { instanceId: idA } });
    await entered.promise;
    expect(data(await client.callTool({ name: "tutor_status", arguments: { instanceId: idB } })).vault).toBe("B");
    expect(data(await client.callTool({ name: "tutor_connect", arguments: { instanceId: idB } }))).toMatchObject({ connected: true, instanceId: idB });
    release.resolve();
    expect(data(await first)).toEqual({ vault: "A", args: {} });
    expect(data(await client.callTool({ name: "tutor_status", arguments: {} })).vault).toBe("B");
    expect(a.calls[0]).toEqual({ name: "tutor_status", args: {}, authorization: `Bearer ${tokenA}` });
    expect(b.calls.every(call => call.authorization === `Bearer ${tokenB}` && !("instanceId" in call.args))).toBe(true);
    expect(a.pairCalls() + b.pairCalls()).toBe(0);
  });

  it("discovers tools from all paired vaults, including communication tools and conflicting schemas", async () => {
    const sharedA: Tool = { name: "tutor_shared", inputSchema: { ...schema, properties: { a: { type: "string" } }, required: ["a"] }, outputSchema: { type: "object", properties: { a: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false } };
    const sharedB: Tool = { name: "tutor_shared", inputSchema: { ...schema, properties: { b: { type: "number" } }, required: ["b"] }, outputSchema: { type: "object", properties: { b: { type: "number" } } }, annotations: { readOnlyHint: false, destructiveHint: true } };
    const a = await service("A", tokenA, { tools: [basicTool, sharedA] });
    const b = await service("B", tokenB, { tools: [basicTool, sharedB, { name: "tutor_communication_mailbox", inputSchema: schema }, { name: "tutor_instances", inputSchema: schema }, { name: "non_tutor_tool", inputSchema: schema }] });
    const c = await service("C", tokenC, { tools: [{ name: "tutor_unpaired", inputSchema: schema }] });
    const f = await fixture(idA);
    await f.publish(idA, a.port, tokenA); await f.publish(idB, b.port, tokenB); await f.publish(idC, c.port);
    const client = await f.connect();
    const tools = (await client.listTools()).tools;
    expect(tools.filter(tool => tool.name === "tutor_instances")).toHaveLength(1);
    expect(tools.map(tool => tool.name)).not.toContain("non_tutor_tool");
    expect(tools.map(tool => tool.name)).not.toContain("tutor_unpaired");
    const mailbox = tools.find(tool => tool.name === "tutor_communication_mailbox")!;
    expect(mailbox.description).toContain(idB);
    expect(mailbox.inputSchema.properties?.instanceId).toMatchObject({ type: "string", pattern: "^[a-f0-9]{24}$" });
    const shared = tools.find(tool => tool.name === "tutor_shared")!;
    expect(shared.inputSchema.anyOf).toHaveLength(2);
    expect(shared.outputSchema).toBeUndefined();
    expect(shared.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const variants = shared.inputSchema.anyOf as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }[];
    expect(variants.map(variant => variant.required[0])).toEqual(["a", "b"]);
    expect(variants.every(variant => variant.properties.instanceId && variant.additionalProperties === false)).toBe(true);
    expect(data(await client.callTool({ name: "tutor_communication_mailbox", arguments: { instanceId: idB } })).vault).toBe("B");
    expect(data(await client.callTool({ name: "tutor_shared", arguments: { instanceId: idA, a: "value" } }))).toEqual({ vault: "A", args: { a: "value" } });
    expect(data(await client.callTool({ name: "tutor_shared", arguments: { instanceId: idB, b: 7 } }))).toEqual({ vault: "B", args: { b: 7 } });
    expect(c.pairCalls()).toBe(0);
    expect(JSON.stringify(tools)).not.toContain(tokenA);
    expect(JSON.stringify(tools)).not.toContain(tokenB);
  });

  it("keeps explicit diagnostics separate from the default and never pairs invalid or unpaired targets", async () => {
    const a = await service("A", tokenA), b = await service("B", tokenB), c = await service("C", tokenC);
    const f = await fixture(idA);
    await f.publish(idA, a.port, tokenA); await f.publish(idB, b.port, tokenB); await f.publish(idC, c.port);
    const client = await f.connect();
    expect(data(await client.callTool({ name: "tutor_diagnose", arguments: { instanceId: idB } }))).toMatchObject({ available: true, instanceId: idB });
    expect(data(await client.callTool({ name: "tutor_status", arguments: {} })).vault).toBe("A");
    for (const instanceId of ["../escape", null, 123]) {
      const result = await client.callTool({ name: "tutor_status", arguments: { instanceId } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("Invalid instanceId");
    }
    const unpaired = await client.callTool({ name: "tutor_status", arguments: { instanceId: idC } });
    expect(unpaired.isError).toBe(true); expect(JSON.stringify(unpaired)).toContain("not paired");
    expect(c.pairCalls()).toBe(0); expect(c.calls).toHaveLength(0);
    expect(data(await client.callTool({ name: "tutor_status", arguments: {} })).vault).toBe("A");
  });

  it("requires a target when multiple vaults have no selection and preserves the one-vault fallback", async () => {
    const a = await service("A", tokenA), b = await service("B", tokenB);
    const f = await fixture();
    await f.publish(idA, a.port, tokenA);
    const client = await f.connect();
    expect(data(await client.callTool({ name: "tutor_status", arguments: {} })).vault).toBe("A");
    await f.publish(idB, b.port, tokenB);
    expect((await client.callTool({ name: "tutor_status", arguments: {} })).isError).toBe(true);
    expect(data(await client.callTool({ name: "tutor_status", arguments: { instanceId: idB } })).vault).toBe("B");
  });

  it("refreshes only the repaired vault's credential while another vault request remains active", async () => {
    const entered = deferred(), release = deferred();
    const a = await service("A", tokenA);
    const b = await service("B", tokenB, { invoke: async () => { entered.resolve(); await release.promise; return { vault: "B" }; } });
    const f = await fixture(idB);
    await f.publish(idA, a.port, tokenA); await f.publish(idB, b.port, tokenB);
    const client = await f.connect();
    expect(data(await client.callTool({ name: "tutor_status", arguments: { instanceId: idA } })).vault).toBe("A");
    const pending = client.callTool({ name: "tutor_status", arguments: { instanceId: idB } });
    await entered.promise;
    a.repairToken(tokenC);
    expect(data(await client.callTool({ name: "tutor_connect", arguments: { instanceId: idA, repair: true } }))).toMatchObject({ connected: true, instanceId: idA });
    expect(data(await client.callTool({ name: "tutor_status", arguments: {} })).vault).toBe("A");
    release.resolve(); expect(data(await pending).vault).toBe("B");
    expect(a.calls.at(-1)?.authorization).toBe(`Bearer ${tokenC}`);
    expect(b.calls[0]?.authorization).toBe(`Bearer ${tokenB}`);
    expect(JSON.parse(await readFile(join(f.root, "clients", `codex-${idA}.json`), "utf8")).token).toBe(tokenC);
    expect(JSON.parse(await readFile(join(f.root, "clients", `codex-${idB}.json`), "utf8")).token).toBe(tokenB);
    expect(a.pairCalls()).toBe(1); expect(b.pairCalls()).toBe(0);
  });

  it("does not close an active request when that same vault is re-paired", async () => {
    const entered = deferred(), release = deferred();
    let requestCount = 0;
    const a = await service("A", tokenA, { invoke: async (_name, _args, authorization) => {
      if (++requestCount === 1) { entered.resolve(); await release.promise; }
      return { vault: "A", oldGrant: authorization === `Bearer ${tokenA}` };
    } });
    const f = await fixture(idA);
    await f.publish(idA, a.port, tokenA);
    const client = await f.connect();
    const pending = client.callTool({ name: "tutor_status", arguments: {} });
    await entered.promise;
    a.repairToken(tokenC);
    expect((await client.callTool({ name: "tutor_connect", arguments: { instanceId: idA, repair: true } })).isError).toBeFalsy();
    expect(data(await client.callTool({ name: "tutor_status", arguments: {} })).oldGrant).toBe(false);
    release.resolve();
    expect(data(await pending)).toEqual({ vault: "A", oldGrant: true });
    expect(a.calls.map(call => call.authorization)).toEqual([`Bearer ${tokenA}`, `Bearer ${tokenC}`]);
  });
});
