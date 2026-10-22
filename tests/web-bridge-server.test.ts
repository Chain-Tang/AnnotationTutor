import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipperPairingStore, clipperDigest } from "../src/web-bridge/pairing.js";
import { WebBridgeServer, type ClipperRequestReceipt, type WebBridgeOptions } from "../src/web-bridge/server.js";

const origin = "chrome-extension://abcdefghijklmnop";
const servers: WebBridgeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); });

function config(extra: Partial<WebBridgeOptions> = {}) {
  const onCapture = vi.fn();
  const persist = vi.fn(async (_records: ClipperRequestReceipt[]) => {});
  const auth = new ClipperPairingStore({ vaultId: "test-vault", targetDirectory: "Clippings", clients: [], persist: async () => {} });
  const options: WebBridgeOptions = { port: 0, auth, onPairingRequest: async () => null,
    requestJournal: { records: [], persist }, onCapture, ...extra };
  const server = new WebBridgeServer(options);
  servers.push(server);
  return { server, auth, persist, onCapture };
}

async function token(auth: ClipperPairingStore) {
  const proof = randomBytes(32).toString("hex");
  const challenge = auth.request({ v: 2, name: "Test browser", capabilities: ["capture"], proofHash: clipperDigest(proof) }, origin);
  auth.approve(challenge.challengeId, { capabilities: ["capture"], targetDirectory: "Approved" });
  const result = await auth.claim(challenge.challengeId, proof, origin);
  if (result.state !== "paired") throw new Error("Pairing failed");
  return result.token;
}

function request(server: WebBridgeServer, method: string, path: string, headers: http.OutgoingHttpHeaders = {}, body = "") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.port!, method, path,
      headers: { Origin: origin, ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.end(body);
  });
}

describe("Web bridge HTTP boundary", () => {
  it("answers trusted private-network preflight without granting capture authority", async () => {
    const h = config(); await h.server.start();
    for (const trusted of [origin, "moz-extension://test-browser", "safari-web-extension://test-browser"]) {
      const response = await request(h.server, "OPTIONS", "/capture", { Origin: trusted, "Access-Control-Request-Private-Network": "true" });
      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(trusted);
      expect(response.headers["access-control-allow-private-network"]).toBe("true");
      expect(response.headers.vary).toBe("Origin");
      expect((await request(h.server, "POST", "/capture", { Origin: trusted }, "{}")).status).toBe(401);
    }
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it.each(["https://example.com", "null", "", `${origin}/forged`])("denies untrusted preflight origin %j without CORS reflection", async untrusted => {
    const h = config(); await h.server.start();
    const response = await request(h.server, "OPTIONS", "/capture", { Origin: untrusted });
    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it("rejects a forged Host even when it carries approved client credentials", async () => {
    const h = config(); await h.server.start();
    const bearer = await token(h.auth);
    const response = await request(h.server, "POST", "/capture", { Host: "evil.example", Authorization: `Bearer ${bearer}` }, "{}");
    expect(response.status).toBe(421);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and missing request identity before a capture can write", async () => {
    const h = config(); await h.server.start();
    const headers = { Authorization: `Bearer ${await token(h.auth)}`, "Content-Type": "application/json" };
    const malformed = await request(h.server, "POST", "/capture", headers, "{broken");
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toMatchObject({ error: "invalid-json" });
    const missing = await request(h.server, "POST", "/capture", headers, JSON.stringify({ v: 1, kind: "page", url: "https://example.com", title: "Test", capturedAt: new Date().toISOString(), markdown: "Synthetic" }));
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toMatchObject({ error: "request-id-required" });
    expect(h.onCapture).not.toHaveBeenCalled();
  });

  it("fails startup before listening if the durable journal has duplicate identities", async () => {
    const record: ClipperRequestReceipt = { clientId: randomUUID(), requestId: randomUUID(), digest: "a".repeat(64),
      kind: "capture", state: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const persist = vi.fn(async (_records: ClipperRequestReceipt[]) => {});
    const h = config({ requestJournal: { records: [record, { ...record }], persist } });
    await expect(h.server.start()).rejects.toThrow("clipper-request-identity-conflict");
    expect(h.server.running).toBe(false);
    expect(h.server.port).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("fails startup before listening if journal persistence is unavailable", async () => {
    const h = config({ requestJournal: { records: [], persist: async () => { throw new Error("disk unavailable"); } } });
    await expect(h.server.start()).rejects.toThrow("disk unavailable");
    expect(h.server.running).toBe(false);
    expect(h.server.port).toBeNull();
  });
});
