import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { streamChatCompletion, type HttpStream } from "../src/api-stream.js";
import { beginConversationDiagnostic, conversationDiagnostics, type ConversationDiagnostic } from "../src/conversation-diagnostics.js";
import { buildApiMessages } from "../src/chat-prompt.js";
import { learningApiProtocol } from "../src/learning-api-protocol.js";
import { t } from "../src/i18n.js";
import { TeachingStreamV3 } from "../src/learning-stream-v3.js";
import { LearningV3Store } from "../src/learning-v3.js";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { LearningDialogueV3 } from "../src/learning-dialogue-v3.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import { runLearningTurnV3 } from "../src/learning-runner-v3.js";
import type { TutorRunnerInput } from "../src/tutor-conversation.js";

// Execute the actual main.ts call sites and actual SSE parser. Only the HTTP
// boundary is fake: this suite makes no Obsidian, model or network calls.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
function method(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Conversation host fixture boundaries changed");
  return source.slice(start, end);
}
const methods = method("  private async runTutorTransport(", "\n  /** Coalesce the rapid geometry writes") +
  method("  private async runIsolatedTutorTurn(", "\n  public async replyInAnnotation(") +
  method("  public conversationDiagnostics(", "\n\n  private tutorJournal");
const code = transformSync(`class Host {${methods}};module.exports=Host;`, { loader: "ts", format: "cjs" }).code;
type Host = {
  settings: { apiModel: string; apiBaseUrl: string };
  runTutorTransport(input: TutorRunnerInput): Promise<{ text: string }>;
  runIsolatedTutorTurn(input: TutorRunnerInput): Promise<{ text: string }>;
  conversationDiagnostics(): readonly ConversationDiagnostic[];
};
type Response = { chunks: string[]; status?: number };
const end = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const valid = JSON.stringify({ control: { action: { type: "none" }, replyRelation: "unrelated" }, reply: "明确说明" });

function fixture(entry: "sidebar" | "annotation", responses: Response[], protocol = true) {
  let index = 0;
  const transport = vi.fn<HttpStream>(async request => {
    const response = responses[index++]; if (!response) throw new Error("unexpected-extra-request");
    request.onResponse({ status: response.status ?? 200, contentType: response.status ? "application/json" : "text/event-stream" });
    for (const part of response.chunks) request.onChunk(part);
  });
  const module = { exports: {} };
  const dependencies = { beginConversationDiagnostic, conversationDiagnostics, streamChatCompletion, nodeHttpStream: transport, buildApiMessages, learningApiProtocol, t };
  new Function("module", ...Object.keys(dependencies), code)(module, ...Object.values(dependencies));
  const Host = module.exports as { new(): Host }, host = new Host();
  Object.assign(host, { settings: { chatEngine: "api", reviewLanguage: "Chinese", apiKey: "TEST_PRIVATE_KEY", apiBaseUrl: "https://api.example.test/v1", apiModel: "provider/actual-model", teachingMode: "guide" }, chatTimeoutMs: () => 1000 });
  const reply = vi.fn(), consumeAdditionalModelCall = vi.fn();
  const input: TutorRunnerInput = { text: "PRIVATE_USER_TEXT", history: [], historyOffset: 0, signal: new AbortController().signal,
    options: { mode: "ask", learningRequestId: crypto.randomUUID(), context: { chat: { content: "PRIVATE_SOURCE", ...(protocol ? { teachingControl: "Return the ordered JSON envelope." } : {}) } } },
    onReply: reply, onEvent: vi.fn(), consumeAdditionalModelCall };
  const run = (value = input) => entry === "sidebar" ? host.runTutorTransport(value) : host.runIsolatedTutorTurn(value);
  return { host, input, reply, transport, run, consumeAdditionalModelCall };
}

describe.each(["sidebar", "annotation"] as const)("%s Direct API diagnostic wiring", entry => {
  it("uses one named return function on the actual configured official route and keeps the same learning validator", async () => {
    const payload = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "submit_teaching_reply", arguments: valid } }] } }] };
    const toolEnd = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    const r = fixture(entry, [{ chunks: [`data: ${JSON.stringify(payload)}\n\n`, toolEnd] }]);
    r.host.settings.apiBaseUrl = "https://api.deepseek.com/v1"; r.host.settings.apiModel = "deepseek-flash";
    const parser = new TeachingStreamV3({ validateControl: value => value, onControl: () => {}, onReply: r.reply });
    r.input.onReply = delta => parser.push(delta);
    await expect(r.run()).resolves.toEqual({ text: valid });
    expect(parser.finish().reply).toBe("明确说明"); expect(r.reply).toHaveBeenCalledExactlyOnceWith("明确说明");
    const sent = JSON.parse(r.transport.mock.calls[0]![0].body);
    expect(sent).toMatchObject({ model: "deepseek-flash", tool_choice: { type: "function", function: { name: "submit_teaching_reply" } }, thinking: { type: "disabled" } });
    expect(sent).not.toHaveProperty("response_format"); expect(sent.tools).toHaveLength(1);
    expect(r.host.conversationDiagnostics()[0]).toMatchObject({ format: "reply_tool", finishReason: "tool_calls", errorCode: "none" });
    expect(r.transport).toHaveBeenCalledOnce(); expect(r.consumeAdditionalModelCall).not.toHaveBeenCalled();
  });
  it("does not add a tool to ordinary chat even on the official endpoint", async () => {
    const r = fixture(entry, [{ chunks: [chunk("自然回复"), end] }], false);
    r.host.settings.apiBaseUrl = "https://api.deepseek.com/v1"; r.host.settings.apiModel = "deepseek-flash";
    await expect(r.run()).resolves.toEqual({ text: "自然回复" });
    const sent = JSON.parse(r.transport.mock.calls[0]![0].body);
    expect(sent).not.toHaveProperty("tools"); expect(sent).not.toHaveProperty("tool_choice"); expect(sent).not.toHaveProperty("response_format");
    expect(r.host.conversationDiagnostics()[0]).toMatchObject({ format: "text", finishReason: "stop" });
  });
  it("preserves missing return-channel failures without retry or exposing untracked prose", async () => {
    const r = fixture(entry, [{ chunks: [chunk("未验证的正文"), end] }]);
    r.host.settings.apiBaseUrl = "https://api.deepseek.com/v1"; r.host.settings.apiModel = "deepseek-flash";
    await expect(r.run()).rejects.toThrow("api-reply-tool-mixed-content");
    expect(r.reply).not.toHaveBeenCalled(); expect(r.transport).toHaveBeenCalledOnce(); expect(r.consumeAdditionalModelCall).not.toHaveBeenCalled();
    expect(r.host.conversationDiagnostics()[0]).toMatchObject({ format: "reply_tool", errorCode: "protocol" });
  });
  it("records successful actual transport deltas and exposes only detached diagnostics", async () => {
    const r = fixture(entry, [{ chunks: [chunk(valid.slice(0, 25)), chunk(valid.slice(25)), end] }]);
    await expect(r.run()).resolves.toEqual({ text: valid });
    expect(r.reply.mock.calls.map(row => row[0]).join("")).toBe(valid);
    const receipt = r.host.conversationDiagnostics()[0]!;
    expect(receipt).toMatchObject({ entry, engine: "api", model: "provider/actual-model", format: "json_object", requestId: r.input.options.learningRequestId,
      status: 200, finishReason: "stop", outputChars: valid.length, deltaCount: 2, ok: true, errorCode: "none" });
    expect(receipt.attemptId).not.toBe(receipt.requestId);
    (receipt as { model: string }).model = "changed";
    expect(r.host.conversationDiagnostics()[0]!.model).toBe("provider/actual-model");
    expect(JSON.stringify(r.host.conversationDiagnostics())).not.toMatch(/PRIVATE|明确说明|api\.example/);
    expect(r.transport).toHaveBeenCalledOnce(); expect(r.consumeAdditionalModelCall).not.toHaveBeenCalled();
  });

  it("reports empty successful completions without retrying or changing the UI error", async () => {
    const r = fixture(entry, [{ chunks: [end] }]);
    await expect(r.run()).rejects.toThrow(t("chat.empty"));
    expect(r.host.conversationDiagnostics()[0]).toMatchObject({ status: 200, finishReason: "stop", outputChars: 0, deltaCount: 0, ok: false, errorCode: "no-output" });
    expect(r.reply).not.toHaveBeenCalled(); expect(r.transport).toHaveBeenCalledOnce();
    expect(r.consumeAdditionalModelCall).not.toHaveBeenCalled();
  });

  it("preserves HTTP 403 while keeping its private error message out of diagnostics", async () => {
    const r = fixture(entry, [{ status: 403, chunks: ['{"error":{"message":"PRIVATE_PROVIDER_ERROR"}}'] }]);
    await expect(r.run()).rejects.toThrow("PRIVATE_PROVIDER_ERROR");
    expect(r.host.conversationDiagnostics()[0]).toMatchObject({ status: 403, finishReason: "none", outputChars: 0, deltaCount: 0, ok: false, errorCode: "access" });
    expect(JSON.stringify(r.host.conversationDiagnostics())).not.toContain("PRIVATE");
    expect(r.transport).toHaveBeenCalledOnce(); expect(r.consumeAdditionalModelCall).not.toHaveBeenCalled();
  });

  it("counts rejected bytes before the parser without swallowing its exact error", async () => {
    const raw = "not JSON", r = fixture(entry, [{ chunks: [chunk(raw), end] }]);
    const parser = new TeachingStreamV3({ validateControl: value => value, onControl: () => {}, onReply: r.reply });
    r.input.onReply = delta => parser.push(delta);
    await expect(r.run()).rejects.toThrow("teaching-envelope-invalid");
    expect(r.host.conversationDiagnostics()[0]).toMatchObject({ status: 200, outputChars: raw.length, deltaCount: 1, errorCode: "protocol", ok: false });
    expect(r.reply).not.toHaveBeenCalled(); expect(r.transport).toHaveBeenCalledOnce();
  });

  it("captures the sent model and preserves ordinary text mode", async () => {
    const r = fixture(entry, [{ chunks: [chunk("reply"), end] }], false);
    r.input.onReply = () => { r.host.settings.apiModel = "replacement-model"; };
    await r.run();
    expect(JSON.parse(r.transport.mock.calls[0]![0].body)).not.toHaveProperty("response_format");
    expect(r.host.conversationDiagnostics()[0]).toMatchObject({ model: "provider/actual-model", format: "text" });
  });

  it.each(["protocol", "empty", "access"] as const)("keeps the learning runner's bounded correction and budget behavior for %s", async kind => {
    const first: Response = kind === "protocol" ? { chunks: [chunk("not JSON"), end] } : kind === "empty" ? { chunks: [end] } : { status: 403, chunks: ['{"error":{"message":"PRIVATE_PROVIDER_ERROR"}}'] };
    const r = fixture(entry, [first, { chunks: [chunk(valid), end] }]);
    const files = new Map<string, string>();
    const io = { read: async (path: string) => files.get(path) ?? null, list: async () => [...files.keys()], write: async (path: string, text: string) => { files.set(path, text); }, compareWrite: async (path: string, before: string | null, text: string) => { if ((files.get(path) ?? null) !== before) throw new Error("conflict"); files.set(path, text); } };
    const dialogue = new LearningDialogueV3(new LearningCommandsV3(new LearningV3Store(io, "learning/v3")));
    const turn = await dialogue.prepare({ authority: localLearnerAuthority(), conversationId: crypto.randomUUID(), requestId: r.input.options.learningRequestId!, source: { path: "synthetic.md", version: "v1" }, entry, kind: "conversation", text: "解释一下" });
    const pending = runLearningTurnV3({ dialogue, turn, signal: r.input.signal, ensureCurrent: async () => {}, present: r.reply,
      transport: (instructions, onReply) => r.run({ ...r.input, onReply, options: { ...r.input.options, context: { chat: { teachingControl: instructions } } } }),
      onProtocolCorrection: () => r.consumeAdditionalModelCall() });
    if (kind === "protocol") {
      await expect(pending).resolves.toMatchObject({ text: "明确说明" });
      expect(r.transport).toHaveBeenCalledTimes(2); expect(r.consumeAdditionalModelCall).toHaveBeenCalledOnce();
      expect(r.host.conversationDiagnostics().map(row => row.errorCode)).toEqual(["protocol", "none"]);
      expect(new Set(r.host.conversationDiagnostics().map(row => row.requestId)).size).toBe(1);
      expect(new Set(r.host.conversationDiagnostics().map(row => row.attemptId)).size).toBe(2);
    } else {
      await expect(pending).rejects.toThrow(kind === "empty" ? t("chat.empty") : "PRIVATE_PROVIDER_ERROR");
      expect(r.transport).toHaveBeenCalledOnce(); expect(r.consumeAdditionalModelCall).not.toHaveBeenCalled();
    }
    expect(files.size).toBe(0);
  });
});
