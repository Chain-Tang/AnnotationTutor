import { describe, expect, it } from "vitest";
import {
  isReviewPlaceholder,
  parseAgentReview
} from "../src/markdown/review.js";

const CREATED = "2026-06-06T10:00:00.000Z";

describe("parseAgentReview", () => {
  it("treats the placeholder and empty text as no review", () => {
    expect(isReviewPlaceholder("_No review yet._")).toBe(true);
    expect(parseAgentReview("_No review yet._", CREATED)).toBeNull();
    expect(parseAgentReview("   ", CREATED)).toBeNull();
  });

  it("parses labelled bullet fields", () => {
    const review = parseAgentReview(
      [
        "- Correctness: partially_correct",
        "- Summary: Useful but incomplete.",
        "- Strengths:",
        "  - Recognizes the idea",
        "- Weaknesses:",
        "  - Omits projections",
        "- Suggested revision: Mention learned Q/K/V projections.",
        "- Socratic question: Why separate projections?"
      ].join("\n"),
      CREATED
    );
    expect(review?.correctness).toBe("partially_correct");
    expect(review?.summary).toBe("Useful but incomplete.");
    expect(review?.strengths).toEqual(["Recognizes the idea"]);
    expect(review?.weaknesses).toEqual(["Omits projections"]);
    expect(review?.suggestedRevision).toContain("projections");
    expect(review?.socraticQuestion).toContain("Why");
  });

  it("tolerates bold labels and source detection", () => {
    const review = parseAgentReview(
      "**Source:** Claude Code\n**Correctness:** correct\n**Summary:** Spot on.",
      CREATED
    );
    expect(review?.correctness).toBe("correct");
    expect(review?.source).toBe("claude-code");
  });

  it("returns null when correctness cannot be determined", () => {
    expect(parseAgentReview("This looks mostly right to me.", CREATED)).toBeNull();
  });
});
