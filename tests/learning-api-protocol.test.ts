import { describe, expect, it } from "vitest";
import { z } from "zod";
import { learningApiProtocol, supportsLearningReplyTool } from "../src/learning-api-protocol.js";
import { learningControlV3Schema } from "../src/learning-control-v3.js";

describe("learning return channel capability boundary", () => {
  it.each(["https://api.deepseek.com", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/"])("uses the configured official endpoint: %s", url => {
    expect(supportsLearningReplyTool(url, "deepseek-flash")).toBe(true);
    expect(learningApiProtocol(url, "deepseek-flash", true)).toMatchObject({ format: "reply_tool", options: { structuredReply: { name: "submit_teaching_reply" } } });
    expect(learningApiProtocol(url, "deepseek-flash", false)).toEqual({ format: "text", options: {} });
  });
  it.each([
    "https://api.deepseek.com/beta", "https://api.deepseek.com/anthropic", "http://api.deepseek.com/v1",
    "https://api.deepseek.com:8443/v1", "https://api.deepseek.com.proxy.example/v1", "https://other.example/v1",
    "https://user:password@api.deepseek.com/v1", "https://api.deepseek.com/v1?token=private", "https://api.deepseek.com/v1#alternate", "invalid",
  ])("preserves JSON mode instead of guessing capability: %s", url => {
    expect(supportsLearningReplyTool(url, "deepseek-flash")).toBe(false);
    expect(learningApiProtocol(url, "deepseek-flash", true)).toEqual({ format: "json_object", options: { responseFormat: { type: "json_object" } } });
  });
  it("does not guess from a model prefix and reuses the actual action schema", () => {
    expect(supportsLearningReplyTool("https://api.deepseek.com/v1", "deepseek-unverified-model")).toBe(false);
    const spec = learningApiProtocol("https://api.deepseek.com/v1", "deepseek-flash", true).options.structuredReply!;
    const control = (spec.parameters.properties as Record<string, unknown>).control;
    const { $schema: _ignored, ...nested } = z.toJSONSchema(learningControlV3Schema, { target: "draft-7" });
    expect(control).toEqual(nested);
    expect(spec.parameters).toMatchObject({ required: ["control", "reply"], additionalProperties: false });
    expect(spec).not.toHaveProperty("strict"); // No beta endpoint or unverified strict-mode claim.
  });
});
