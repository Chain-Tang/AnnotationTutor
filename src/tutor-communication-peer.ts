import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivateFile } from "./private-file-io.js";
import { communicationIdentityKey, communicationIdentitySchema, type CommunicationIdentity } from "./tutor-communication.js";

export type LocalTutorInstance = {
  id: string; name: string; port: number; pid: number; startedAt?: string;
  identity?: CommunicationIdentity;
};
export type TutorCommunicationPeerCredential = {
  token: string; clientId?: string; hostIdentity?: CommunicationIdentity;
};
export type TutorCommunicationPeerIdentity = { host: CommunicationIdentity; caller: CommunicationIdentity };
export type TutorCommunicationPeerOptions = {
  instanceId: string;
  identity: CommunicationIdentity;
  readCredential: (instanceId: string) => Promise<TutorCommunicationPeerCredential | undefined>;
  writeCredential: (instanceId: string, credential: TutorCommunicationPeerCredential) => Promise<void>;
  fetch?: typeof fetch;
  discover?: () => Promise<LocalTutorInstance[]>;
};
export const TUTOR_COMMUNICATION_PEER_LIMITS = Object.freeze({ requestBytes: 128 * 1024, responseBytes: 2 * 1024 * 1024 });
const instancePattern = /^[a-f0-9]{24}$/;
const sameIdentity = (a: CommunicationIdentity, b: CommunicationIdentity) => communicationIdentityKey(a) === communicationIdentityKey(b);

/** Obsidian runs this code in a renderer. Its window.fetch adds browser Origin/CORS
 * behavior, so local peer traffic must use Node HTTP while the server keeps its
 * browser-origin rejection. This adapter never follows redirects or other hosts. */
async function nodeLoopbackFetch(url: URL, init: RequestInit): Promise<Response> {
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
    !["/pair", "/mcp"].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error("communication-peer-origin-mismatch");
  if (init.body !== undefined && typeof init.body !== "string") throw new Error("communication-peer-body-denied");
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(url, { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), signal: init.signal ?? undefined }, incoming => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
        }
        const status = incoming.statusCode ?? 500;
        const empty = [204, 205, 304].includes(status);
        if (empty) incoming.resume();
        // Use this renderer's Web Stream constructor: Node's toWeb() stream can
        // belong to a different realm than Obsidian's Response implementation.
        const iterator = incoming[Symbol.asyncIterator]();
        const body = empty ? null : new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const part = await iterator.next();
              if (part.done) controller.close(); else controller.enqueue(new Uint8Array(part.value as Buffer));
            } catch (error) { controller.error(error); }
          },
          async cancel() { incoming.destroy(); await iterator.return?.(); },
        });
        resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    request.once("error", reject);
    request.end(init.body);
  });
}

/** Read-only service metadata. This helper never reads credentials, opens a vault or requests pairing. */
export async function discoverLocalTutorInstances(directory = join(homedir(), ".local", "share", "tutor", "instances")): Promise<LocalTutorInstance[]> {
  let files: string[];
  try { files = await readdir(directory); } catch { return []; }
  const result: LocalTutorInstance[] = [];
  for (const file of files.filter(name => /^[a-f0-9]{24}\.json$/.test(name)).sort()) {
    try {
      const value: unknown = JSON.parse((await readPrivateFile(join(directory, file), 16 * 1024)).toString("utf8"));
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== "string" || !instancePattern.test(entry.id) || `${entry.id}.json` !== file ||
        typeof entry.port !== "number" || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 ||
        typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid < 1 ||
        typeof entry.name !== "string" || entry.name.length > 256) continue;
      process.kill(entry.pid, 0);
      const identity = entry.identity === undefined ? undefined : communicationIdentitySchema.parse(entry.identity);
      result.push({ id: entry.id, port: entry.port, pid: entry.pid, name: entry.name,
        ...(typeof entry.startedAt === "string" ? { startedAt: entry.startedAt.slice(0, 100) } : {}), ...(identity ? { identity } : {}) });
    } catch {}
  }
  return result;
}

/** A fixed peer identity and target vault. Tokens are supplied by the host's private credential store. */
export class TutorCommunicationPeer {
  private readonly instanceId: string;
  private readonly identity: CommunicationIdentity;
  private readonly options: TutorCommunicationPeerOptions;
  private readonly stop = new AbortController();
  private readonly clients = new Set<Client>();
  private closed = false;

  constructor(options: TutorCommunicationPeerOptions) {
    if (!instancePattern.test(options.instanceId)) throw new Error("communication-peer-invalid-instance");
    this.instanceId = options.instanceId;
    this.identity = communicationIdentitySchema.parse(options.identity);
    this.options = { ...options, instanceId: this.instanceId, identity: this.identity };
  }

  private async instance(): Promise<LocalTutorInstance> {
    if (this.closed) throw new Error("communication-peer-closed");
    const entries = await (this.options.discover ?? discoverLocalTutorInstances)();
    const entry = entries.find(item => item.id === this.instanceId);
    if (!entry) throw new Error("communication-peer-unavailable");
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error("communication-peer-invalid-port");
    return { ...entry, ...(entry.identity ? { identity: communicationIdentitySchema.parse(entry.identity) } : {}) };
  }

  private signal(signal: AbortSignal | undefined, timeout = 30_000): AbortSignal {
    return AbortSignal.any([this.stop.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
  }

  private async boundedFetch(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    if (typeof init.body === "string" && Buffer.byteLength(init.body) > TUTOR_COMMUNICATION_PEER_LIMITS.requestBytes) throw new Error("communication-peer-request-too-large");
    const response = await (this.options.fetch ?? nodeLoopbackFetch)(url, { ...init, redirect: "error", signal });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("communication-peer-redirect-denied"); }
    if (response.url && (new URL(response.url).origin !== url.origin || new URL(response.url).pathname !== url.pathname)) { await response.body?.cancel(); throw new Error("communication-peer-origin-mismatch"); }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > TUTOR_COMMUNICATION_PEER_LIMITS.responseBytes) { await response.body?.cancel(); throw new Error("communication-peer-response-too-large"); }
    const reader = response.body?.getReader();
    if (!reader) return response;
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) { controller.close(); return; }
          bytes += part.value.length;
          if (bytes > TUTOR_COMMUNICATION_PEER_LIMITS.responseBytes) { await reader.cancel(); throw new Error("communication-peer-response-too-large"); }
          controller.enqueue(part.value);
        } catch (error) { controller.error(error); }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private async session<T>(entry: LocalTutorInstance, credential: TutorCommunicationPeerCredential, signal: AbortSignal | undefined, use: (client: Client, verified: TutorCommunicationPeerIdentity, identityResult: CallToolResult) => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(credential.token)) throw new Error("communication-peer-not-paired");
    const endpoint = new URL(`http://127.0.0.1:${entry.port}/mcp`);
    const boundSignal = this.signal(signal, 120_000);
    const guarded: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.search || url.hash || url.username || url.password) throw new Error("communication-peer-origin-mismatch");
      if (!["GET", "POST", "DELETE"].includes(request.method)) throw new Error("communication-peer-method-denied");
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${credential.token}`);
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.text();
      return this.boundedFetch(url, { method: request.method, headers, ...(body === undefined ? {} : { body }) }, AbortSignal.any([boundSignal, request.signal]));
    };
    const client = new Client({ name: "tutor-communication-peer", version: "1" });
    this.clients.add(client);
    const abort = () => { void client.close(); };
    boundSignal.addEventListener("abort", abort, { once: true });
    try {
      boundSignal.throwIfAborted();
      await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: guarded }), { signal: boundSignal, timeout: 30_000 });
      const identityResult = await client.callTool({ name: "tutor_communication_identity", arguments: {} }, undefined, { signal: boundSignal, timeout: 30_000 }) as CallToolResult;
      if (identityResult.isError) throw new Error("communication-peer-identity-unavailable");
      const raw = identityResult.structuredContent;
      const host = communicationIdentitySchema.parse(raw?.host), caller = communicationIdentitySchema.parse(raw?.caller);
      if (host.kind !== "tutor" || !sameIdentity(caller, this.identity) ||
        (entry.identity && !sameIdentity(host, entry.identity)) ||
        (credential.hostIdentity && !sameIdentity(host, communicationIdentitySchema.parse(credential.hostIdentity)))) throw new Error("communication-peer-identity-mismatch");
      return await use(client, { host, caller }, identityResult);
    } finally {
      boundSignal.removeEventListener("abort", abort);
      this.clients.delete(client);
      await client.close().catch(() => {});
    }
  }

  /** Explicitly request the target vault's Obsidian authorization dialog. No other method pairs. */
  async pair(input: { name: string; signal?: AbortSignal }): Promise<TutorCommunicationPeerIdentity> {
    if (!input.name.trim() || input.name.length > 80) throw new Error("communication-peer-invalid-name");
    const entry = await this.instance();
    const signal = this.signal(input.signal, 125_000);
    const response = await this.boundedFetch(new URL(`http://127.0.0.1:${entry.port}/pair`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: input.name, communicationIdentity: this.identity }),
    }, signal);
    if (!response.ok) throw new Error(`communication-peer-pairing-http-${response.status}`);
    const data = await response.json() as { token?: unknown; clientId?: unknown };
    if (typeof data.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token) || typeof data.clientId !== "string" || !data.clientId || data.clientId.length > 200) throw new Error("communication-peer-invalid-pairing");
    const credential: TutorCommunicationPeerCredential = { token: data.token, clientId: data.clientId };
    return this.session(entry, credential, signal, async (_client, verified) => {
      signal.throwIfAborted();
      await this.options.writeCredential(this.instanceId, { ...credential, hostIdentity: verified.host });
      return verified;
    });
  }

  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CallToolResult> {
    if (!/^tutor_communication_[a-z][a-z0-9_]*$/.test(name)) throw new Error("communication-peer-tool-denied");
    if ("instanceId" in args) throw new Error("communication-peer-routing-fixed");
    if (Buffer.byteLength(JSON.stringify(args)) > TUTOR_COMMUNICATION_PEER_LIMITS.requestBytes - 1024) throw new Error("communication-peer-request-too-large");
    const entry = await this.instance();
    const credential = await this.options.readCredential(this.instanceId);
    if (!credential || !credential.hostIdentity) throw new Error("communication-peer-not-paired");
    return this.session(entry, { ...credential }, signal, async (client, _verified, identityResult) => name === "tutor_communication_identity" ? identityResult :
      await client.callTool({ name, arguments: args }, undefined, { signal: this.signal(signal, 120_000), timeout: 120_000 }) as CallToolResult);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop.abort();
    await Promise.allSettled([...this.clients].map(client => client.close()));
  }
}
