import { TEACHING_CONTROL_SCHEMA_ISSUES } from "./learning-stream-v3.js";
import type { ChatStreamResult } from "./api-stream.js";

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

function failureCode(result: ChatStreamResult): ConversationDiagnostic["errorCode"] {
  if (result.ok) return result.text.trim() ? "none" : "no-output";
  if (result.status === 401 || result.status === 403) return "access";
  if (result.status === 429) return "rate-limit";
  if (result.status !== undefined && Number.isInteger(result.status) && result.status >= 500 && result.status <= 599) return "provider";
  const code = result.error ?? "";
  if (code === "cancelled" || code === "disposed") return "cancelled";
  if (code === "api-request-timeout") return "timeout";
  if (["missing-api-key", "missing-api-configuration", "unsupported-api-protocol", "invalid-api-url", "invalid-api-reply-tool"].includes(code)) return "configuration";
  if (/^incomplete-response: (?:length|max_tokens)$/.test(code) || /^api-(?:response|event|text)-too-large$/.test(code)) return "output-limit";
  if (code === "incomplete-api-response" || code.startsWith("incomplete-response: ")) return "incomplete";
  if (/^teaching-(?:envelope|control|reply|stream)-[a-z-]+$/.test(code)) return "protocol";
  if (/^api-reply-tool-[a-z-]+$/.test(code)) return "protocol";
  if (["api-secure-connection-failed","api-connection-failed","api-transport-failed"].includes(code)) return "connection";
  if (/^(?:connect |getaddrinfo |read )?(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/.test(code)) return "connection";
  return "unknown";
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
}): { onDelta(delta: string, forward: (delta: string) => void): void; finish(result: ChatStreamResult): void } {
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
      const errorCode = failureCode(result);
      const status = result.status !== undefined && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : undefined;
      const finishReason = !result.finishReason ? "none" : finishes.has(result.finishReason) ? result.finishReason as ConversationDiagnostic["finishReason"] : "other";
      const controlIssue = TEACHING_CONTROL_SCHEMA_ISSUES.find(issue => result.error === "teaching-control-schema-" + issue) ??
        (result.error === "teaching-control-rejected" ? "rejected" : undefined);
      const receipt: ConversationDiagnostic = {
        ...identity, ...(controlIssue ? {controlIssue} : {}), ...(status === undefined ? {} : { status }), finishReason,
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
