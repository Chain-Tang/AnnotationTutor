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
    expect(sys).toContain("Write your reply in Chinese.");
    expect(sys).not.toContain("Correctness");
    expect(sys).not.toContain("field labels");
  });
});

describe("contextBlock", () => {
  it("keeps a runtime source capability out of both model transports",()=>{
    const ctx={sourceBinding:"private-host-buffer-capability",notePath:"Math.md",content:"x²"};
    expect(contextBlock(ctx,true)).not.toContain(ctx.sourceBinding);
    expect(opencodePreamble(ctx,"Chinese")).not.toContain(ctx.sourceBinding);
    expect(JSON.stringify(buildApiMessages([],ctx,"继续","Chinese"))).not.toContain(ctx.sourceBinding);
  });
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

  it("surfaces the learner's active study scenes when provided", () => {
    const block = contextBlock(
      { notePath: "A.md", sceneSummary: "Transformers (topic, 3 cells)" },
      false
    );
    expect(block).toContain("The learner's active study scenes:");
    expect(block).toContain("Transformers (topic, 3 cells)");
    // Absent when no scenes are known.
    expect(contextBlock({ notePath: "A.md" }, false)).not.toContain(
      "The learner's active study scenes:"
    );
  });
});

describe("opencodePreamble", () => {
  it("supplies bounded source text without promising file access in isolated conversations",()=>{
    const prompt=opencodePreamble({notePath:"Math.md",content:"x²",teachingControl:'Respond ONLY with valid JSON.'},"Chinese",{allowFileTools:false});
    expect(prompt).toContain("x²");expect(prompt).toContain("ONLY with valid JSON");
    expect(prompt).toContain("no file tools");expect(prompt).not.toContain("may read the full note");
    expect(prompt).not.toContain("Correctness");
  });
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
