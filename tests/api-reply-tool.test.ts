import { describe, expect, it, vi } from "vitest";
import { streamChatCompletion, type HttpStream } from "../src/api-stream.js";
import { learningApiProtocol } from "../src/learning-api-protocol.js";
import { TeachingStreamV3 } from "../src/learning-stream-v3.js";
import { parseLearningControlV3 } from "../src/learning-control-v3.js";

const base = () => ({ baseUrl: "https://api.deepseek.com/v1", apiKey: "test-only", model: "deepseek-flash", messages: [{ role: "user", content: "hello" }], timeoutMs: 1000,
  ...learningApiProtocol("https://api.deepseek.com/v1", "deepseek-flash", true).options });
const envelope = JSON.stringify({ control: { action: { type: "none" }, replyRelation: "unrelated" }, reply: "可以休息一下。" });
const event = (delta: unknown, finish_reason: unknown = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const header = (argumentsText = "") => ({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "submit_teaching_reply", arguments: argumentsText } }] });
const args = (text: string) => ({ tool_calls: [{ index: 0, function: { arguments: text } }] });
const end = event({}, "tool_calls") + "data: [DONE]\n\n";
const stream = (data: string): HttpStream => async request => { request.onResponse({ status: 200, contentType: "text/event-stream" }); for (const c of data) request.onChunk(c); };

describe("single structured return function", () => {
  it("streams only identified arguments through the existing learning validator, before completion", async () => {
    const replies = vi.fn(), controls = vi.fn(), parser = new TeachingStreamV3({ validateControl: parseLearningControlV3, onControl: controls, onReply: replies });
    let finish!: () => void;
    const transport: HttpStream = async request => {
      const body = JSON.parse(request.body);
      expect(body).toMatchObject({ tool_choice: { type: "function", function: { name: "submit_teaching_reply" } }, thinking: { type: "disabled" } });
      expect(body.tools).toHaveLength(1); expect(body).not.toHaveProperty("response_format");
      request.onResponse({ status: 200, contentType: "text/event-stream" });
      request.onChunk(event({ reasoning_content: "private reasoning" }));
      request.onChunk(event(header(envelope.slice(0, -2))));
      await new Promise<void>(resolve => { finish = resolve; });
      request.onChunk(event(args(envelope.slice(-2))) + end);
    };
    const pending = streamChatCompletion({ ...base(), fast: false, onDelta: delta => parser.push(delta) }, transport);
    expect(replies.mock.calls.map(c => c[0]).join("")).toBe("可以休息一下。");
    finish();
    expect(await pending).toMatchObject({ ok: true, text: envelope, finishReason: "tool_calls" });
    expect(parser.finish().reply).toBe("可以休息一下。"); expect(controls).toHaveBeenCalledOnce();
  });
  it("buffers argument fragments until name, type and ID are known", async () => {
    const reply = vi.fn();
    const data = event({ tool_calls: [{ index: 0, function: { arguments: envelope.slice(0, 20), name: "submit_" } }] }) +
      event({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "teaching_reply", arguments: envelope.slice(20) } }] }) + end;
    expect(await streamChatCompletion({ ...base(), onDelta: reply }, stream(data))).toMatchObject({ ok: true, text: envelope });
    expect(reply).toHaveBeenCalledExactlyOnceWith(envelope);
  });
  it("supports a complete gateway response without inventing token chunks", async () => {
    const onDelta = vi.fn(), transport: HttpStream = async request => {
      request.onResponse({ status: 200, contentType: "application/json" });
      const { index: _index, ...call } = header(envelope).tool_calls[0]!;
      request.onChunk(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] }));
    };
    expect(await streamChatCompletion({ ...base(), onDelta }, transport)).toMatchObject({ ok: true, text: envelope });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith(envelope);
  });
  it.each([
    [event({ content: "An untracked answer" }) + end, "api-reply-tool-mixed-content"],
    [event({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: envelope } }] }) + end, "api-reply-tool-name"],
    [event({ tool_calls: [header(envelope).tool_calls[0], { index: 1 }] }) + end, "api-reply-tool-multiple"],
    [event({ tool_calls: [{ index: 1, function: { arguments: envelope } }] }) + end, "api-reply-tool-multiple"],
    [event({ tool_calls: [{ index: 0, function: { arguments: envelope } }] }) + end, "api-reply-tool-missing"],
    [event(header(envelope)) + event(header(envelope)) + end, "api-reply-tool-identity"],
    [event(header(envelope)) + event({}, "stop") + "data: [DONE]\n\n", "incomplete-response: stop"],
    [event(header(envelope)), "incomplete-api-response"],
    [event(header(envelope)) + event({}, "tool_calls") + event(args("late")) + "data: [DONE]\n\n", "api-reply-tool-after-finish"],
  ])("rejects malformed or unrelated tool traffic without dispatching: %#", async (data, error) => {
    const result = await streamChatCompletion(base(), stream(data));
    expect(result).toMatchObject({ ok: false, error });
  });
  it("retains the host parser failure and stops after cancellation, never executing tools", async () => {
    const parser = new TeachingStreamV3({ validateControl: parseLearningControlV3, onControl: () => {}, onReply: () => {} });
    expect(await streamChatCompletion({ ...base(), onDelta: d => parser.push(d) }, stream(event(header("not JSON")) + end))).toMatchObject({ ok: false, error: "teaching-envelope-invalid" });
    const abort = new AbortController(), onDelta = vi.fn(() => abort.abort());
    expect(await streamChatCompletion({ ...base(), signal: abort.signal, onDelta }, stream(event(header(envelope.slice(0, 25))) + event(args(envelope.slice(25))) + end))).toMatchObject({ ok: false, error: "cancelled", text: envelope.slice(0, 25) });
    expect(onDelta).toHaveBeenCalledOnce();
  });
  it("rejects contradictory return modes before any request is sent", async () => {
    const transport = vi.fn<HttpStream>();
    expect(await streamChatCompletion({ ...base(), responseFormat: { type: "json_object" } }, transport)).toMatchObject({ ok: false, error: "invalid-api-reply-tool" });
    expect(transport).not.toHaveBeenCalled();
  });
});
