import { describe, expect, it } from "vitest";
import {
  freeModels,
  isFreeModel,
  parseModelList,
  pickDefaultModel
} from "../src/agent-models.js";

const SAMPLE = `opencode/big-pickle
opencode/deepseek-v4-flash-free
opencode/mimo-v2.5-free
opencode/nemotron-3-ultra-free`;

describe("agent model catalog", () => {
  it("parses well-formed provider/model ids and drops noise", () => {
    const out = parseModelList(
      `Available models:\n${SAMPLE}\n\n  opencode/mimo-v2.5-free  \nnot a model`
    );
    expect(out).toEqual([
      "opencode/big-pickle",
      "opencode/deepseek-v4-flash-free",
      "opencode/mimo-v2.5-free",
      "opencode/nemotron-3-ultra-free"
    ]);
  });

  it("classifies free models by the -free token, not substrings like 'freedom'", () => {
    expect(isFreeModel("opencode/mimo-v2.5-free")).toBe(true);
    expect(isFreeModel("opencode/big-pickle")).toBe(false);
    expect(isFreeModel("vendor/freedom-pro")).toBe(false);
    expect(freeModels(parseModelList(SAMPLE))).toEqual([
      "opencode/deepseek-v4-flash-free",
      "opencode/mimo-v2.5-free",
      "opencode/nemotron-3-ultra-free"
    ]);
  });

  it("keeps a still-available configured model", () => {
    const models = parseModelList(SAMPLE);
    expect(pickDefaultModel(models, "opencode/mimo-v2.5-free")).toBe(
      "opencode/mimo-v2.5-free"
    );
  });

  it("falls back to the first free model when the configured one is gone", () => {
    const models = parseModelList(SAMPLE);
    // A typo'd / removed model is not in the catalog → pick the first free one.
    expect(pickDefaultModel(models, "opencode/deepseek-v4-flah-free")).toBe(
      "opencode/deepseek-v4-flash-free"
    );
    expect(pickDefaultModel(models, "")).toBe("opencode/deepseek-v4-flash-free");
  });

  it("falls back to any model, then the current value, when nothing is free", () => {
    expect(pickDefaultModel(["vendor/paid-a", "vendor/paid-b"], "")).toBe(
      "vendor/paid-a"
    );
    expect(pickDefaultModel([], "vendor/keep")).toBe("vendor/keep");
  });
});
