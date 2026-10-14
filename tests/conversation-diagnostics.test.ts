import { describe, expect, it, vi } from "vitest";
import { beginConversationDiagnostic, conversationDiagnostics } from "../src/conversation-diagnostics.js";
import type { ChatStreamResult } from "../src/api-stream.js";

const input = () => ({ requestId: crypto.randomUUID(), entry: "sidebar" as const, engine: "api", model: "provider/deepseek-flash", format: "json_object" as const });

describe("bounded private conversation diagnostics", () => {
  it("counts transport content before forwarding and preserves a consumer exception", () => {
    const owner = {}, attempt = beginConversationDiagnostic(owner, input()), failure = new Error("PRIVATE_CONSUMER_ERROR");
    const forward = vi.fn(() => { throw failure; });
    expect(() => attempt.onDelta("PRIVATE_RESPONSE", forward)).toThrow(failure);
    attempt.finish({ ok: false, text: "PRIVATE_RESPONSE", status: 200, error: failure.message });
    expect(forward).toHaveBeenCalledExactlyOnceWith("PRIVATE_RESPONSE");
    expect(conversationDiagnostics(owner)[0]).toMatchObject({ outputChars: 16, deltaCount: 1, errorCode: "unknown", ok: false });
    expect(JSON.stringify(conversationDiagnostics(owner))).not.toContain("PRIVATE");
  });

  it("keeps fifty attempt receipts per owner, copies reads, and settles each attempt once", () => {
    const owner = {}, other = {}, request = input();
    for (let index = 0; index < 55; index++) {
      const attempt = beginConversationDiagnostic(owner, request);
      attempt.finish({ ok: true, text: "x".repeat(index), status: 200, finishReason: "stop" });
      attempt.finish({ ok: false, text: "duplicate", error: "PRIVATE" });
    }
    const read = conversationDiagnostics(owner);
    expect(read).toHaveLength(50); expect(read[0]!.outputChars).toBe(5);
    expect(new Set(read.map(row => row.attemptId)).size).toBe(50);
    expect(read.every(row => row.requestId === request.requestId)).toBe(true);
    (read[0] as { model: string }).model = "MUTATED";
    (read as unknown[]).pop();
    expect(conversationDiagnostics(owner)).toHaveLength(50);
    expect(conversationDiagnostics(owner)[0]!.model).toBe(request.model);
    expect(conversationDiagnostics(other)).toEqual([]);
  });

  it.each(["https://host/path?token=SECRET", "/vault/PRIVATE.md", "C:/vault/PRIVATE.md", "sk-PRIVATE_KEY", "provider/sk-PRIVATE_KEY", "model@sk-PRIVATE_KEY", "Bearer PRIVATE_KEY", "model\nPRIVATE"])("does not retain unsafe model metadata: %s", model => {
    const owner = {}, attempt = beginConversationDiagnostic(owner, { ...input(), requestId: "PRIVATE_REQUEST_TEXT", model, engine: "PRIVATE_ENGINE" });
    attempt.finish({ ok: false, text: "PRIVATE_REPLY", error: "PRIVATE_ERROR", status: 999, finishReason: "PRIVATE_FINISH" });
    const row = conversationDiagnostics(owner)[0]!;
    expect(row).toMatchObject({ engine: "unknown", model: "unknown", finishReason: "other", errorCode: "unknown" });
    expect(row.status).toBeUndefined(); expect(row.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(row)).not.toContain("PRIVATE");
  });

  it("bounds valid model identifiers and preserves whitespace output as a no-output receipt", () => {
    const owner = {}, attempt = beginConversationDiagnostic(owner, { ...input(), model: "m".repeat(200) });
    attempt.onDelta("  \n", () => {});
    attempt.finish({ ok: true, text: "  \n", status: 200, finishReason: "stop" });
    expect(conversationDiagnostics(owner)[0]).toMatchObject({ model: "m".repeat(128), outputChars: 3, deltaCount: 1, errorCode: "no-output", ok: false });
  });

  it.each([
    [{ ok: false, text: "", status: 403, error: "PRIVATE" }, "access"],
    [{ ok: false, text: "", status: 429, error: "PRIVATE" }, "rate-limit"],
    [{ ok: false, text: "", status: 503, error: "PRIVATE" }, "provider"],
    [{ ok: false, text: "", error: "cancelled" }, "cancelled"],
    [{ ok: false, text: "", error: "api-request-timeout" }, "timeout"],
    [{ ok: false, text: "", error: "teaching-envelope-trailing-content" }, "protocol"],
    [{ ok: false, text: "", error: "api-reply-tool-missing" }, "protocol"],
    [{ ok: false, text: "", error: "invalid-api-reply-tool" }, "configuration"],
    [{ ok: false, text: "", error: "incomplete-response: length" }, "output-limit"],
    [{ ok: false, text: "", error: "incomplete-api-response" }, "incomplete"],
    [{ ok: false, text: "", error: "missing-api-key" }, "configuration"],
    [{ ok: false, text: "", error: "connect ECONNREFUSED PRIVATE_ENDPOINT" }, "connection"],
    [{ ok: true, text: "", status: 200 }, "no-output"],
    [{ ok: true, text: "reply", status: 200, finishReason: "stop" }, "none"]
  ] as const)("classifies only finite codes without storing raw errors: %#", (result, errorCode) => {
    const owner = {}; beginConversationDiagnostic(owner, input()).finish(result as ChatStreamResult);
    expect(conversationDiagnostics(owner)[0]!.errorCode).toBe(errorCode);
    expect(JSON.stringify(conversationDiagnostics(owner))).not.toContain("PRIVATE");
  });
  it("retains only a finite control failure category, never arbitrary issue paths",()=>{
    const owner={};
    for(const code of ["teaching-control-schema-question-id","teaching-control-rejected","teaching-control-schema-PRIVATE_SECRET"])
      beginConversationDiagnostic(owner,input()).finish({ok:false,text:"PRIVATE_REPLY",error:code,status:200});
    expect(conversationDiagnostics(owner).map(row=>row.controlIssue)).toEqual(["question-id","rejected",undefined]);
    expect(JSON.stringify(conversationDiagnostics(owner))).not.toContain("PRIVATE");
  });

});
