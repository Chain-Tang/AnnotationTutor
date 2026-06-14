import { describe, expect, it } from "vitest";
import {
  buildApiMessages,
  contextBlock,
  NOTE_CONTENT_BUDGET,
  opencodePreamble,
  tutorSystemPrompt
} from "../src/chat-prompt.js";

describe("tutorSystemPrompt", () => {
  it("frames a helpful assistant and pins the language", () => {
    const sys = tutorSystemPrompt("Chinese");
    expect(sys).toContain("learning assistant");
    expect(sys).toContain("Never refuse to answer");
    expect(sys).toContain("tailor your depth");
    expect(sys).toContain("Write the review content in Chinese.");
  });
});

describe("contextBlock", () => {
  it("includes the note path and selection, and the body only when asked", () => {
    const ctx = {
      notePath: "Psych/Klein.md",
      selection: "对客体的恐惧",
      content: "# Klein\nfull body text"
    };
    const withoutBody = contextBlock(ctx, false);
    expect(withoutBody).toContain("Current note: Psych/Klein.md");
    expect(withoutBody).toContain("对客体的恐惧");
    expect(withoutBody).not.toContain("full body text");
    expect(contextBlock(ctx, true)).toContain("full body text");
  });

  it("truncates a very long note body", () => {
    const content = "x".repeat(NOTE_CONTENT_BUDGET + 500);
    const block = contextBlock({ content }, true);
    expect(block).toContain("…(truncated)");
    expect(block.length).toBeLessThan(content.length);
  });

  it("surfaces the learner profile when provided", () => {
    const block = contextBlock(
      { notePath: "A.md", profileSummary: "Prefers worked examples." },
      false
    );
    expect(block).toContain("What you know about this learner:");
    expect(block).toContain("Prefers worked examples.");
    // Absent when no profile is known.
    expect(contextBlock({ notePath: "A.md" }, false)).not.toContain(
      "What you know about this learner:"
    );
  });
});

describe("opencodePreamble", () => {
  it("points the agent at the note path for on-demand reads", () => {
    const preamble = opencodePreamble({ notePath: "A.md", selection: "s" }, "");
    expect(preamble).toContain("read the full note with your file tools");
    expect(preamble).toContain("path: A.md");
  });

  it("carries the learner profile into the preamble", () => {
    const preamble = opencodePreamble(
      { notePath: "A.md", profileSummary: "Beginner in statistics." },
      ""
    );
    expect(preamble).toContain("Beginner in statistics.");
  });
});

describe("buildApiMessages", () => {
  it("prepends a system message and appends the new user turn after history", () => {
    const messages = buildApiMessages(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" }
      ],
      { notePath: "A.md" },
      "what next?",
      ""
    );
    expect(messages[0]!.role).toBe("system");
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user"
    ]);
    expect(messages.at(-1)).toEqual({ role: "user", content: "what next?" });
  });
});
