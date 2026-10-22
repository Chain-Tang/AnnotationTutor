import { TEACHING_CONTROL_SCHEMA_ISSUES } from "./learning-stream-v3.js";
import type { ChatStreamResult } from "./api-stream.js";
import { CONNECTION_ISSUES, verifiedConnectionReceipt, type ConnectionIssue } from "./api-transport-receipt.js";

// Existing non-stream callers can still provide a diagnostic without claiming
// byte-level knowledge. Actual stream results always include receivedBytes.
type DiagnosticStreamResult = Omit<ChatStreamResult, "receivedBytes"> & Partial<Pick<ChatStreamResult, "receivedBytes">>;

export type ConversationDiagnostic = Readonly<{
  requestId: string;
  attemptId: string;
  entry: "sidebar" | "annotation";
  engine: "api" | "opencode" | "unknown";
  model: string;
  format: "text" | "json_object" | "reply_tool";
  status?: number;
  finishReason: "none" | "stop" | "length" | "tool_calls" | "function_call" | "content_filter" | "other";
  controlIssue?: typeof TEACHING_CONTROL_SCHEMA_ISSUES[number] | "rejected";
  protocolIssue?: typeof PROTOCOL_ISSUES[number];
  receivedBytes?: number;
  connectionIssue?: ConnectionIssue;
  outputChars: number;
  deltaCount: number;
  elapsedMs: number;
  ok: boolean;
  errorCode: "none" | "no-output" | "access" | "rate-limit" | "provider" | "cancelled" | "timeout" |
    "configuration" | "incomplete" | "output-limit" | "protocol" | "connection" | "unknown";
}>;

const records = new WeakMap<object, ConversationDiagnostic[]>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finishes = new Set(["stop", "length", "tool_calls", "function_call", "content_filter"]);
// Explicitly enumerated, never arbitrary provider/consumer error text.
const PROTOCOL_ISSUES = ["teaching-envelope-invalid", "teaching-envelope-key-invalid", "teaching-control-object-required",
  "teaching-control-invalid", "teaching-reply-string-required", "teaching-reply-escape-invalid", "teaching-reply-unicode-invalid",
  "teaching-reply-control-character", "teaching-envelope-extra-field", "teaching-envelope-trailing-content", "teaching-envelope-incomplete",
  "api-stream-json-invalid", "api-response-json-invalid",
  "api-reply-tool-invalid", "api-reply-tool-multiple", "api-reply-tool-identity", "api-reply-tool-name",
  "api-reply-tool-mixed-content", "api-reply-tool-after-finish", "api-reply-tool-missing"] as const;

function safeModel(value: string): string {
  if (typeof value !== "string") return "unknown";
  const model = value.trim();
  // Model IDs may contain provider prefixes, but diagnostics never retain a
  // URL, filesystem path, credential-shaped value or free-form settings text.
  if (!/^[a-z0-9][a-z0-9_.:/@+\-]*$/i.test(model) ||
    /^(?:https?:|file:|[a-z]:[\\/])/i.test(model) ||
    /(?:^|[/:@+])(?:sk-|bearer)|[a-z]+:\/\//i.test(model)) return "unknown";
  return model.slice(0, 128);
}

export function conversationFailureCode(result: DiagnosticStreamResult): ConversationDiagnostic["errorCode"] {
  if (result.ok) return result.text.trim() ? "none" : "no-output";
  if (result.status === 401 || result.status === 403) return "access";
  if (result.status === 429) return "rate-limit";
  if (result.status !== undefined && Number.isInteger(result.status) && result.status >= 500 && result.status <= 599) return "provider";
  const code = result.error ?? "";
  if (code === "cancelled" || code === "disposed") return "cancelled";
  if (code === "api-request-timeout") return "timeout";
  if (["missing-api-key", "missing-api-configuration", "unsupported-api-protocol", "invalid-api-url", "invalid-api-reply-tool"].includes(code)) return "configuration";
  if (/^incomplete-response: (?:length|max_tokens)$/.test(code) || /^api-(?:response|event|text)-too-large$/.test(code) ||
    /^teaching-(?:envelope|control|reply)-too-large$/.test(code) || code === "teaching-control-too-deep") return "output-limit";
  if (code === "incomplete-api-response" || code.startsWith("incomplete-response: ")) return "incomplete";
  if (code === "teaching-reply-consumer-unavailable") return "unknown";
  if (code === "api-stream-json-invalid" || code === "api-response-json-invalid") return "protocol";
  if (/^teaching-(?:envelope|control|reply|stream)-[a-z-]+$/.test(code)) return "protocol";
  if (/^api-reply-tool-[a-z-]+$/.test(code)) return "protocol";
  if (["api-secure-connection-failed","api-connection-failed","api-transport-failed"].includes(code)) return "connection";
  if (/^(?:connect |getaddrinfo |read )?(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/.test(code)) return "connection";
  return "unknown";
}

/** Keeps the parser's exact message for its one guarded format correction,
 * while exposing only a finite category to persisted/UI request statuses. */
export class ConversationTransportError extends Error {
  readonly category: ConversationDiagnostic["errorCode"];
  readonly receivedBytes?: number;
  readonly retryableConnection: boolean;
  readonly status?: number;
  constructor(result: DiagnosticStreamResult) {
    super(result.error || "empty-api-response");
    this.name = "ConversationTransportError";
    this.category = conversationFailureCode(result);
    const receipt = verifiedConnectionReceipt(result), bytes = receipt?.receivedBytes ?? result.receivedBytes, status = receipt?.status ?? result.status;
    this.receivedBytes = Number.isSafeInteger(bytes) && bytes! >= 0 ? bytes : undefined;
    this.status = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    this.retryableConnection = receipt?.retryableConnection === true;
  }
}

/** Plugin-local, memory-only receipts. No prompt, response, path, URL or error text. */
export function conversationDiagnostics(owner: object): readonly ConversationDiagnostic[] {
  return (records.get(owner) ?? []).map(record => ({ ...record }));
}

export function beginConversationDiagnostic(owner: object, input: {
  requestId?: string;
  entry: ConversationDiagnostic["entry"];
  engine: string;
  model: string;
  format: ConversationDiagnostic["format"];
}): { onDelta(delta: string, forward: (delta: string) => void): void; finish(result: DiagnosticStreamResult): void } {
  const startedAt = Date.now();
  const identity = {
    requestId: input.requestId && uuid.test(input.requestId) ? input.requestId : crypto.randomUUID(),
    attemptId: crypto.randomUUID(), entry: input.entry,
    engine: input.engine === "api" || input.engine === "opencode" ? input.engine : "unknown",
    model: safeModel(input.model), format: input.format === "reply_tool" ? "reply_tool" : input.format === "json_object" ? "json_object" : "text"
  } as const;
  let deltaCount = 0, finished = false;
  return {
    onDelta(delta, forward) {
      // Count transport content before the learning display gate. Preserve its
      // exception and cancellation behavior; never convert rejected text to help.
      if (!finished && delta.length) deltaCount++;
      forward(delta);
    },
    finish(result) {
      if (finished) return;
      finished = true;
      const errorCode = conversationFailureCode(result);
      const status = result.status !== undefined && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : undefined;
      const finishReason = !result.finishReason ? "none" : finishes.has(result.finishReason) ? result.finishReason as ConversationDiagnostic["finishReason"] : "other";
      const controlIssue = TEACHING_CONTROL_SCHEMA_ISSUES.find(issue => result.error === "teaching-control-schema-" + issue) ??
        (result.error === "teaching-control-rejected" ? "rejected" : undefined);
      const protocolIssue = PROTOCOL_ISSUES.find(issue => result.error === issue);
      const receivedBytes = Number.isSafeInteger(result.receivedBytes) && result.receivedBytes! >= 0 ? result.receivedBytes : undefined;
      const connectionIssue = CONNECTION_ISSUES.find(issue => result.connectionIssue === issue);
      const receipt: ConversationDiagnostic = {
        ...identity, ...(controlIssue ? {controlIssue} : {}), ...(protocolIssue ? {protocolIssue} : {}), ...(status === undefined ? {} : { status }), finishReason,
        ...(receivedBytes === undefined ? {} : {receivedBytes}), ...(connectionIssue ? {connectionIssue} : {}),
        outputChars: result.text.length, deltaCount, elapsedMs: Math.max(0, Date.now() - startedAt),
        ok: errorCode === "none", errorCode
      };
      const list = records.get(owner) ?? [];
      list.push(receipt);
      if (list.length > 50) list.splice(0, list.length - 50);
      records.set(owner, list);
    }
  };
}
