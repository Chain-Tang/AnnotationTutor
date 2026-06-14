import { describe, expect, it } from "vitest";
import { resolveAnchor } from "../src/anchors.js";
import type { Anchor } from "../src/model.js";

function anchor(overrides: Partial<Anchor>): Anchor {
  return {
    blockId: "ann-20260606-001",
    selectedText: "Multi-head attention",
    ...overrides
  };
}

describe("resolveAnchor", () => {
  it("resolves a block-id anchor with full confidence", () => {
    const markdown = "Intro line\n\nMulti-head attention is useful. ^ann-20260606-001\n";
    const result = resolveAnchor(markdown, anchor({}));
    expect(result.strategy).toBe("block-id");
    expect(result.line).toBe(2);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("falls back to exact selected text", () => {
    const markdown = "A paragraph mentioning Multi-head attention here.\n";
    const result = resolveAnchor(markdown, anchor({ blockId: "missing-id" }));
    expect(result.strategy).toBe("exact-text");
    expect(result.startOffset).toBeGreaterThanOrEqual(0);
  });


  it("requires confirmation for a fuzzy match", () => {
    const markdown = "Multi head attention allows the model to attend.\n";
    const result = resolveAnchor(
      markdown,
      anchor({ blockId: "missing", selectedText: "Multi-head attention allows" })
    );
    expect(result.strategy).toBe("fuzzy");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("reports not-found when nothing matches", () => {
    const result = resolveAnchor("totally unrelated content\n", anchor({
      blockId: "missing",
      selectedText: "zzzzzzzzzz qqqqqqqqqq"
    }));
    expect(result.strategy).toBe("not-found");
  });
});
