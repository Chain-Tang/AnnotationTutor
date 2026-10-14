import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeHttpStream, SseDecoder, streamChatCompletion, type HttpStream } from "../src/api-stream.js";

const opts = () => ({ baseUrl: "https://api.example.test/v1", apiKey: "test-only", model: "vision", messages: [{ role: "user", content: "hi" }], timeoutMs: 1000 });
const chunk = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const end = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const mockStream = (data: string, status = 200, contentType = "text/event-stream"): HttpStream => async input => {
  input.onResponse({ status, contentType });
  for (const char of data) input.onChunk(char);
};

describe("streaming chat transport", () => {
  afterEach(() => vi.useRealTimers());
  it("frames split CRLF and multiline SSE data and ignores comments", () => {
    const received: string[] = [];
    const decoder = new SseDecoder(data => received.push(data));
    for (const char of ': heartbeat\r\ndata: first\r\ndata: second\r\n\r\ndata: last') decoder.push(char);
    decoder.finish();
    expect(received).toEqual(["first\nsecond", "last"]);
  });
  it("limits incomplete and complete oversized frames", () => {
    expect(() => new SseDecoder(() => {}).push("x".repeat(256001))).toThrow("api-event-too-large");
    expect(() => new SseDecoder(() => {}).push(`data: ${"x".repeat(256001)}\n\n`)).toThrow("api-event-too-large");
  });
  it("handles a near-limit event delivered one character at a time and resets for the next event", () => {
    const received: string[] = [];
    const decoder = new SseDecoder(data => received.push(data));
    const payload = "中".repeat(240_000);
    // Regression: concatenating and searching the entire pending line per
    // character made this adversarial but valid segmentation quadratic.
    for (const char of `data: ${payload}\r\n\r\ndata: next\n\n`) decoder.push(char);
    expect(received).toEqual([payload, "next"]);
  });
  it("frames many events from large chunks and joins CRLF split across chunk boundaries", () => {
    const received: string[] = [];
    const decoder = new SseDecoder(data => received.push(data));
    const payload = "abc".repeat(50_000);
    decoder.push(`data: ${payload}\r`);
    decoder.push("\ndata: tail\r\n\r");
    decoder.push("\n" + "data: next\n\n".repeat(1000));
    decoder.finish();
    expect(received).toHaveLength(1001);
    expect(received[0]).toBe(`${payload}\ntail`);
    expect(received.slice(1)).toEqual(Array(1000).fill("next"));
  });
  it("accepts standalone CR boundaries and still flushes an unterminated final event", () => {
    const received: string[] = [];
    const decoder = new SseDecoder(data => received.push(data));
    for (const char of "data: first\r\rdata: final") decoder.push(char);
    decoder.finish();
    expect(received).toEqual(["first", "final"]);
  });
  it("emits actual content before the transport finishes, preserves Chinese and ignores reasoning", async () => {
    let finish!: () => void;
    const received: string[] = [];
    const transport: HttpStream = async input => {
      expect(JSON.parse(input.body)).toMatchObject({ stream: true, model: "vision" });
      input.onResponse({ status: 200, contentType: "text/event-stream; charset=utf-8" });
      input.onChunk('data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n\n');
      input.onChunk(chunk("你好"));
      await new Promise<void>(resolve => { finish = resolve; });
      input.onChunk(chunk("！") + end);
    };
    const pending = streamChatCompletion({ ...opts(), onDelta: delta => received.push(delta) }, transport);
    expect(received).toEqual(["你好"]);
    finish();
    expect(await pending).toMatchObject({ ok: true, text: "你好！" });
    expect(received).toEqual(["你好", "！"]);
  });
  it("rejects truncated, invalid, filtered and oversized streams", async () => {
    for (const data of [chunk("partial"), "data: {bad}\n\n", 'data: {"choices":[{"finish_reason":"length"}]}\n\n', chunk("x".repeat(256001))]) {
      expect((await streamChatCompletion(opts(), mockStream(data))).ok).toBe(false);
    }
  });
  it("reports HTTP and streamed provider errors without a retry", async () => {
    expect(await streamChatCompletion(opts(), mockStream('{"error":{"message":"Image unsupported"}}', 400, "application/json"))).toMatchObject({ ok: false, status: 400, error: "Image unsupported" });
    expect(await streamChatCompletion(opts(), mockStream('data: {"error":{"message":"quota"}}\n\n'))).toMatchObject({ ok: false, error: "quota" });
  });
  it("accepts gateways returning complete JSON without inventing token-sized chunks", async () => {
    const onDelta = vi.fn();
    const response = JSON.stringify({ choices: [{ message: { content: "full reply" }, finish_reason: "stop" }] });
    expect(await streamChatCompletion({ ...opts(), onDelta }, mockStream(response, 200, "application/json"))).toMatchObject({ ok: true, text: "full reply" });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("full reply");
  });
  it("stops processing injected transport chunks after cancellation", async () => {
    const controller = new AbortController();
    const onDelta = vi.fn(() => controller.abort());
    expect(await streamChatCompletion({ ...opts(), signal: controller.signal, onDelta }, mockStream(chunk("first") + chunk("late") + end))).toMatchObject({ ok: false, error: "cancelled", text: "first" });
    expect(onDelta).toHaveBeenCalledTimes(1);
  });
  it("destroys the actual HTTP connection promptly when aborted", async () => {
    let response!: ServerResponse;
    let requestSeen!: () => void;
    const seen = new Promise<void>(resolve => { requestSeen = resolve; });
    const server = createServer((_request, reply) => {
      response = reply;
      reply.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.write(chunk("你好"));
      requestSeen();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const controller = new AbortController();
    const pending = streamChatCompletion({ ...opts(), baseUrl: `http://127.0.0.1:${address.port}`, signal: controller.signal });
    try {
      await seen;
      const closed = new Promise<void>(resolve => response.once("close", resolve));
      controller.abort();
      expect(await pending).toMatchObject({ ok: false, error: "cancelled" });
      await closed;
      expect(response.destroyed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("enforces a wall-clock timeout even while a server stays connected", async () => {
    const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write(": ready\n\n"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    try {
      expect(await streamChatCompletion({ ...opts(), baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 25 })).toMatchObject({ ok: false, error: "api-request-timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("refuses unsupported protocols before sending credentials", async () => {
    await expect(nodeHttpStream({ url: "file:///tmp/a", body: "{}", headers: {}, timeoutMs: 100, onChunk: () => {}, onResponse: () => {} })).rejects.toThrow("unsupported-api-protocol");
  });
});

describe("interactive provider latency setting", () => {
  it("disables thinking only for explicit fast requests to the official DeepSeek API with DeepSeek models", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport: HttpStream = async input => {
      bodies.push(JSON.parse(input.body));
      input.onResponse({ status: 200, contentType: "text/event-stream" });
      input.onChunk(end);
    };
    await streamChatCompletion({ ...opts(), baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", fast: true }, transport);
    expect(bodies[0]).toMatchObject({ thinking: { type: "disabled" } });
    const configurations = [
      { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
      { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", fast: false },
      { baseUrl: "https://third-party.example/v1", model: "deepseek-flash", fast: true },
      { baseUrl: "https://api.deepseek.com.proxy.example/v1", model: "deepseek-flash", fast: true },
      { baseUrl: "https://api.deepseek.com/v1", model: "other-vision-model", fast: true },
    ];
    for (const configuration of configurations) {
      await streamChatCompletion({ ...opts(), ...configuration }, transport);
      expect(bodies.at(-1)).not.toHaveProperty("thinking");
    }
  });
});
