// The localhost half of the Web Clipper bridge: a 127.0.0.1-only HTTP server the
// browser extension POSTs full-page archives to (payloads too large for the
// obsidian:// URI channel). Bearer-token gated and CORS/PNA-aware so Chrome's
// Private Network Access preflight succeeds. Node sockets live here; every
// request decision (auth, CORS headers, payload validation) reuses the pure
// helpers in protocol.ts.

import http from "node:http";
import {
  bridgeCorsHeaders,
  isBridgeAuthorized,
  parseCapturePayload,
  type CapturePayload
} from "./protocol.js";

export type WebBridgeOptions = {
  port: number;
  token: string;
  onCapture: (payload: CapturePayload) => Promise<void> | void;
  onError?: (error: unknown) => void;
};

/** Cap on a single request body — full pages with inline assets can be large. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const JSON_HEADERS = { "Content-Type": "application/json" };

export class WebBridgeServer {
  private server: http.Server | null = null;

  public constructor(private readonly options: WebBridgeOptions) {}

  public get running(): boolean {
    return this.server !== null;
  }

  /** Bind to loopback and start accepting requests; rejects if the port is taken. */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        resolve();
        return;
      }
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.once("error", (error) => {
        this.server = null;
        this.options.onError?.(error);
        reject(error);
      });
      // Loopback only: the bridge must never be reachable from the network.
      server.listen(this.options.port, "127.0.0.1", () => {
        this.server = server;
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    for (const [key, value] of Object.entries(bridgeCorsHeaders(origin))) {
      res.setHeader(key, value);
    }
    // Preflight: headers are already set, just acknowledge.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Pairing probe: confirm only when the token matches, so the extension can
    // tell "wrong/rotated token" from "server down".
    if (req.method === "GET" && req.url === "/ping") {
      const ok = isBridgeAuthorized(req.headers.authorization, this.options.token);
      res.writeHead(ok ? 200 : 401, JSON_HEADERS);
      res.end(JSON.stringify({ ok, v: 1 }));
      return;
    }
    if (req.method === "POST" && req.url === "/capture") {
      await this.handleCapture(req, res);
      return;
    }
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  }

  private async handleCapture(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (!isBridgeAuthorized(req.headers.authorization, this.options.token)) {
      res.writeHead(401, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "payload too large" }));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "invalid json" }));
      return;
    }
    const payload = parseCapturePayload(parsed);
    if (!payload) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "invalid payload" }));
      return;
    }
    try {
      await this.options.onCapture(payload);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      this.options.onError?.(error);
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "write failed" }));
    }
  }
}

/** Read the request body as UTF-8, aborting past {@link MAX_BODY_BYTES}. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
