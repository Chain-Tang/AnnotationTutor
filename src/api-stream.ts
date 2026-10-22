import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chatCompletionsUrl, extractApiError, extractApiReviewText } from "./api-runner.js";
import { SocketTransportError, recordConnectionReceipt, type ConnectionIssue } from "./api-transport-receipt.js";
export { CONNECTION_ISSUES, SocketTransportError, verifiedConnectionReceipt, type ConnectionIssue } from "./api-transport-receipt.js";

const MAX_BODY = 4_000_000;
const MAX_EVENT = 256_000;
const MAX_TEXT = 1_000_000;

export type HttpStream = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** A bounded reconnect may opt out of pooling; TLS verification is unchanged. */
  freshConnection?: boolean;
  signal?: AbortSignal;
  onResponse: (response: { status: number; contentType: string }) => void;
  onChunk: (chunk: string) => void;
}) => Promise<void>;

/** Only socket/response errors enter here. Parser and presenter exceptions
 * preserve their own identity; no provider call is automatically replayed. */
function socketFailure(error:unknown):SocketTransportError {
  const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
  const message=error instanceof Error?error.message:"";
  // Certificate errors take precedence even when a library appends unrelated
  // OpenSSL details. A reconnect never weakens certificate verification.
  if (/CERT|SELF_SIGNED|ISSUER|VERIFY_LEAF|ALTNAME/.test(code)) return new SocketTransportError("tls-certificate");
  if (["ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC", "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC", "ERR_OSSL_BAD_DECRYPT"].includes(code))
    return new SocketTransportError("tls-record");
  if(/^ERR_(?:SSL|TLS|OSSL)_/.test(code)||/OPENSSL_internal:(?:BAD_DECRYPT|DECRYPTION_FAILED)|\b(?:SSL|TLS)\b.*(?:alert|handshake|certificate)/i.test(message))return new SocketTransportError("tls-handshake");
  const socketIssues: Readonly<Record<string, ConnectionIssue>> = {ECONNRESET:"reset", ECONNREFUSED:"refused", ENOTFOUND:"dns-not-found", EAI_AGAIN:"dns-temporary", ETIMEDOUT:"timeout", EPIPE:"pipe"};
  const issue = socketIssues[code];
  return new SocketTransportError(issue ?? "unknown");
}

/** Desktop transport: actual incremental bytes, hard timeout and socket cancellation. */
export const nodeHttpStream: HttpStream = (input) => new Promise((resolve, reject) => {
  if (input.signal?.aborted) { reject(new Error("cancelled")); return; }
  let url: URL;
  try {
    url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported-api-protocol");
    if (url.username || url.password) throw new Error("invalid-api-url");
  } catch (error) { reject(error); return; }
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let total = 0;
  const finish = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    if (error) { req.destroy(); reject(error); }
    else resolve();
  };
  const abort = (): void => finish(new Error("cancelled"));
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: "POST",
    ...(input.freshConnection ? { agent: false as const } : {}),
    headers: { ...input.headers, "Content-Length": Buffer.byteLength(input.body), "Accept-Encoding": "identity" },
  }, (response) => {
    try { input.onResponse({ status: response.statusCode ?? 0, contentType: String(response.headers["content-type"] ?? "") }); }
    catch (error) { finish(error); return; }
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      if (settled) return;
      total += Buffer.byteLength(chunk);
      if (total > MAX_BODY) { finish(new Error("api-response-too-large")); return; }
      try { input.onChunk(chunk); } catch (error) { finish(error); }
    });
    response.on("end", () => finish());
    response.on("error", error=>finish(socketFailure(error)));
    response.on("aborted", () => finish(new Error("incomplete-api-response")));
  });
  req.on("error", error=>finish(socketFailure(error)));
  timer = setTimeout(() => finish(new Error("api-request-timeout")), Math.max(1, input.timeoutMs));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) { abort(); return; }
  req.end(input.body);
});

/** SSE framing is separate from JSON parsing; network chunks can split any character or line. */
export class SseDecoder {
  private pending: string[] = [];
  private pendingLength = 0;
  private skipLineFeed = false;
  private data: string[] = [];
  private eventLength = 0;
  constructor(private readonly onData: (data: string) => void) {}
  public push(chunk: string): void {
    // Scan each incoming character once. In particular, one-character chunks
    // must not repeatedly concatenate/rescan a growing, unterminated JSON line.
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const code = chunk.charCodeAt(index);
      if (this.skipLineFeed) {
        this.skipLineFeed = false;
        if (code === 10) { start = index + 1; continue; }
      }
      if (code !== 10 && code !== 13) continue;
      this.append(chunk.slice(start, index));
      this.flushLine();
      this.skipLineFeed = code === 13;
      start = index + 1;
    }
    this.append(chunk.slice(start));
  }
  public finish(): void {
    if (this.pendingLength) this.flushLine();
    this.skipLineFeed = false;
    this.line("");
  }
  private append(part: string): void {
    if (!part) return;
    this.pendingLength += part.length;
    if (this.pendingLength + this.eventLength > MAX_EVENT) throw new Error("api-event-too-large");
    this.pending.push(part);
  }
  private flushLine(): void {
    const line = this.pending.join("");
    this.pending = [];
    this.pendingLength = 0;
    this.line(line);
  }
  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.onData(this.data.join("\n"));
      this.data = [];
      this.eventLength = 0;
      return;
    }
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).replace(/^ /, "");
    this.eventLength += value.length;
    if (this.eventLength > MAX_EVENT) throw new Error("api-event-too-large");
    this.data.push(value);
  }
}

export type ChatStreamResult = { ok: boolean; text: string; receivedBytes: number; status?: number; error?: string; finishReason?: string;
  connectionIssue?: ConnectionIssue; retryableConnection?: boolean };
export type StructuredReplyTool = { name: string; description: string; parameters: Record<string, unknown> };
export type ChatStreamOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** OpenAI-compatible text or multimodal messages. */
  messages: unknown[];
  responseFormat?: {type:"json_object"};
  /** One host-selected return function, never dispatched as an executable tool.
   * Its raw arguments stream into the caller's bounded schema validator. */
  structuredReply?: StructuredReplyTool;
  timeoutMs: number;
  freshConnection?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  temperature?: number;
  /** Interactive replies may disable provider thinking where explicitly supported. */
  fast?: boolean;
};

export async function streamChatCompletion(options: ChatStreamOptions, transport: HttpStream = nodeHttpStream): Promise<ChatStreamResult> {
  let text = "", body = "", status: number | undefined, contentType = "", finishReason: string | undefined;
  let receivedBytes = 0;
  let consumerFailure: unknown;
  let done = false;
  const emit = (delta: string): void => {
    if (options.signal?.aborted) throw new Error("cancelled");
    if (text.length + delta.length > MAX_TEXT) throw new Error("api-text-too-large");
    text += delta;
    if (delta) {
      try { options.onDelta?.(delta); }
      catch (error) { consumerFailure = error; throw error; }
    }
  };
  let toolId = "", toolName = "", toolType = "", toolSeen = false, pendingArguments = "";
  const toolDelta = (raw: unknown): void => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("api-reply-tool-invalid");
    const call = raw as { index?: unknown; id?: unknown; type?: unknown; function?: unknown };
    if (call.index !== 0) throw new Error("api-reply-tool-multiple");
    toolSeen = true;
    if (call.id !== undefined) {
      if (typeof call.id !== "string" || !call.id || call.id.length > 512 || toolId) throw new Error("api-reply-tool-identity");
      toolId = call.id;
    }
    if (call.type !== undefined) {
      if (call.type !== "function" || toolType) throw new Error("api-reply-tool-identity");
      toolType = call.type;
    }
    if (call.function !== undefined) {
      if (!call.function || typeof call.function !== "object" || Array.isArray(call.function)) throw new Error("api-reply-tool-invalid");
      const fn = call.function as { name?: unknown; arguments?: unknown };
      if (fn.name !== undefined) {
        if (typeof fn.name !== "string" || !fn.name || toolName.length + fn.name.length > 128) throw new Error("api-reply-tool-name");
        toolName += fn.name;
        if (!options.structuredReply!.name.startsWith(toolName)) throw new Error("api-reply-tool-name");
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== "string") throw new Error("api-reply-tool-invalid");
        if (text.length + pendingArguments.length + fn.arguments.length > MAX_TEXT) throw new Error("api-text-too-large");
        pendingArguments += fn.arguments;
      }
    }
    // Arguments arriving before a complete identity cannot become visible help.
    if (toolId && toolType === "function" && toolName === options.structuredReply!.name && pendingArguments) {
      const argumentsDelta = pendingArguments; pendingArguments = ""; emit(argumentsDelta);
    }
  };
  const decoder = new SseDecoder((data) => {
    if (done) return;
    if (data === "[DONE]") { done = true; return; }
    let parsed: {
      error?: unknown;
      choices?: { index?: number; delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[];
    };
    try { parsed = JSON.parse(data) as typeof parsed; }
    catch { throw new Error("api-stream-json-invalid"); }
    if (parsed.error) throw new Error(extractApiError(data));
    const choice = parsed.choices?.find(item => item.index === 0 || item.index === undefined);
    if (options.structuredReply) {
      const delta = choice?.delta;
      if (delta?.content !== undefined && delta.content !== null && (typeof delta.content !== "string" || delta.content.trim())) throw new Error("api-reply-tool-mixed-content");
      if (delta?.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 1) throw new Error("api-reply-tool-multiple");
        if (delta.tool_calls.length) {
          if (finishReason) throw new Error("api-reply-tool-after-finish");
          toolDelta(delta.tool_calls[0]);
        }
      }
    } else if (typeof choice?.delta?.content === "string") emit(choice.delta.content);
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
  });
  try {
    if (!options.apiKey.trim()) throw new Error("missing-api-key");
    if (!options.model.trim() || !options.baseUrl.trim()) throw new Error("missing-api-configuration");
    if (options.structuredReply && (options.responseFormat || !/^[A-Za-z0-9_-]{1,128}$/.test(options.structuredReply.name) ||
      !options.structuredReply.parameters || typeof options.structuredReply.parameters !== "object" ||
      JSON.stringify(options.structuredReply).length > 65_536)) throw new Error("invalid-api-reply-tool");
    // DeepSeek enables thinking by default. Its explicit opt-out belongs only
    // on its own API; OpenAI-compatible gateways need not implement this field.
    const disableThinking = (options.fast === true || !!options.structuredReply) &&
      new URL(options.baseUrl).hostname === "api.deepseek.com" && /^deepseek-/i.test(options.model.trim());
    await transport({
      url: chatCompletionsUrl(options.baseUrl),
      headers: { Authorization: `Bearer ${options.apiKey.trim()}`, "Content-Type": "application/json; charset=utf-8", Accept: "text/event-stream" },
      body: JSON.stringify({ model: options.model.trim(), messages: options.messages, ...(options.responseFormat ? {response_format:options.responseFormat}:{}), temperature: options.temperature ?? 0.3, stream: true,
        ...(options.structuredReply ? { tools: [{ type: "function", function: options.structuredReply }], tool_choice: { type: "function", function: { name: options.structuredReply.name } } } : {}),
        ...(disableThinking ? { thinking: { type: "disabled" } } : {}) }),
      timeoutMs: options.timeoutMs,
      ...(options.freshConnection ? {freshConnection:true} : {}),
      signal: options.signal,
      onResponse: response => { status = response.status; contentType = response.contentType; },
      onChunk: chunk => {
        // Count before parsing: comments, split events and tool identity bytes
        // are still received data even when they never produce a text delta.
        receivedBytes += Buffer.byteLength(chunk);
        if (options.signal?.aborted) throw new Error("cancelled");
        if (status && status >= 200 && status < 300 && /text\/event-stream/i.test(contentType)) decoder.push(chunk);
        else {
          body += chunk;
          if (body.length > MAX_BODY) throw new Error("api-response-too-large");
        }
      },
    });
    if (options.signal?.aborted) throw new Error("cancelled");
    if (!status || status < 200 || status >= 300) return { ok: false, text, receivedBytes, status, error: extractApiError(body) || `http-${status ?? 0}` };
    if (/text\/event-stream/i.test(contentType)) {
      decoder.finish();
      if (!done && !finishReason) throw new Error("incomplete-api-response");
    } else {
      // Some compatible gateways ignore stream:true. Preserve compatibility,
      // but never simulate chunks or a typewriter for their complete response.
      let parsed: { choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown } }[] };
      try { parsed = JSON.parse(body) as typeof parsed; }
      catch { throw new Error("api-response-json-invalid"); }
      finishReason = parsed.choices?.[0]?.finish_reason;
      if (options.structuredReply) {
        const message = parsed.choices?.[0]?.message;
        if (message?.content !== undefined && message.content !== null && (typeof message.content !== "string" || message.content.trim())) throw new Error("api-reply-tool-mixed-content");
        if (!Array.isArray(message?.tool_calls) || message.tool_calls.length !== 1) throw new Error("api-reply-tool-missing");
        toolDelta({ ...message.tool_calls[0], index: 0 });
      } else emit(extractApiReviewText(body));
    }
    if (options.structuredReply) {
      if (!toolSeen || !toolId || toolType !== "function" || toolName !== options.structuredReply.name || pendingArguments) throw new Error("api-reply-tool-missing");
      if (finishReason !== "tool_calls") throw new Error(`incomplete-response: ${finishReason ?? "none"}`);
    } else if (finishReason && finishReason !== "stop") throw new Error(`incomplete-response: ${finishReason}`);
    return { ok: true, text, receivedBytes, status, finishReason };
  } catch (error) {
    const result:ChatStreamResult = { ok: false, text, receivedBytes, status, finishReason, error: error instanceof Error ? error.message : String(error) };
    const connection = error !== consumerFailure ? recordConnectionReceipt(result,error,receivedBytes,status) : undefined;
    if (connection) { result.connectionIssue=connection.connectionIssue;result.retryableConnection=connection.retryableConnection; }
    return result;
  }
}
