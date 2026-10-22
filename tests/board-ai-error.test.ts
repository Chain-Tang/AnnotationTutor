import { describe, expect, it } from "vitest";
import { describeBoardAiError } from "../src/board-ai-error.js";

describe("board AI error presentation", () => {
  it("explains insufficient balance without exposing the raw provider message", () => {
    expect(describeBoardAiError(new Error("http-402: Insufficient Balance (request_id: f4f0009d-47ec-4817-ae42-dd602c485aaf)"))).toEqual({
      kind: "quota",
      title: "模型服务额度不足",
      message: "画板和原作品没有改变。请检查当前模型服务的余额或额度，也可以在设置中改用其他已配置的模型。",
      requestId: "f4f0009d-47ec-4817-ae42-dd602c485aaf",
    });
  });

  it.each([
    ["http-401: Unauthorized", "auth"],
    ["http-429: Too Many Requests", "rate-limit"],
    ["http-503: unavailable", "service"],
    ["request timed out", "network"],
    ["unexpected parser failure", "unknown"],
  ])("classifies %s", (input, kind) => {
    const result = describeBoardAiError(input);
    expect(result.kind).toBe(kind);
    expect(result.message).toContain("原作品没有改变");
    expect(JSON.stringify(result)).not.toContain(input);
  });
});
