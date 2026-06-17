import { describe, expect, it } from "vitest";
import {
  buildCaptureArgs,
  buildReviewPrompt,
  buildWindowsCommandLine,
  extractReviewText,
  quoteWinArg,
  spawnEnv
} from "../src/agent-runner.js";
import type { IndexRecord } from "../src/model.js";

const record: IndexRecord = {
  annotationId: "ANN-20260608-001",
  memoryFile: "Agent Memory/annotations/ANN-20260608-001.md",
  sourceFile: "Papers/Attention.md",
  anchor: "^ann-20260608-001",
  anchorOrigin: "generated",
  selectedText: "Multi-head attention lets the model attend to subspaces.",
  status: "agent_requested",
  concepts: [],
  relatedMemoryCells: [],
  userNote: "It runs attention in parallel and concatenates the results.",
  createdAt: "2026-06-08T09:00:00.000Z",
  updatedAt: "2026-06-08T09:00:00.000Z"
};

describe("buildReviewPrompt", () => {
  it("inlines the selected text and the learner's note", () => {
    const prompt = buildReviewPrompt(record);
    expect(prompt).toContain(record.selectedText);
    expect(prompt).toContain(record.userNote!);
  });

  it("specifies the three labels the parser expects, and no rubric labels", () => {
    const prompt = buildReviewPrompt(record);
    for (const label of ["Correctness:", "Comment:", "Question:"]) {
      expect(prompt).toContain(label);
    }
    // The verbose rubric is gone so the card reads like a margin note.
    expect(prompt).not.toContain("Strengths:");
    expect(prompt).not.toContain("Weaknesses:");
    expect(prompt).not.toContain("Source: opencode");
  });

  it("falls back to the note summary when the full note is absent", () => {
    const prompt = buildReviewPrompt({
      ...record,
      userNote: undefined,
      userNoteSummary: "summary only"
    });
    expect(prompt).toContain("summary only");
  });

  it("matches the note's language by default", () => {
    const prompt = buildReviewPrompt(record);
    expect(prompt).toContain("same language as the learner's note");
    expect(prompt).toContain("Keep the field labels and the Correctness value in English");
  });

  it("uses an explicit review language when given", () => {
    const prompt = buildReviewPrompt(record, "简体中文");
    expect(prompt).toContain("Write the review content in 简体中文.");
    expect(prompt).not.toContain("same language as the learner's note");
  });

  it("auto-pins the language from a CJK note so the model does not drift to English", () => {
    const prompt = buildReviewPrompt({
      ...record,
      userNote: "婴儿把坏的部分投射到客体上，于是害怕被客体报复。"
    });
    expect(prompt).toContain("Write the review content in Chinese.");
    expect(prompt).not.toContain("same language as the learner's note");
  });

  it("answers a direct question instead of deflecting", () => {
    const prompt = buildReviewPrompt(record);
    expect(prompt).toContain("answer it clearly and completely");
    expect(prompt).toContain("never tell the learner to work it out alone");
  });

  it("inlines a learner profile summary when provided, and omits it otherwise", () => {
    const withProfile = buildReviewPrompt(record, "", "Visual learner; new to ML.");
    expect(withProfile).toContain("What you know about this learner");
    expect(withProfile).toContain("Visual learner; new to ML.");
    expect(buildReviewPrompt(record)).not.toContain("What you know about this learner");
  });
});

describe("buildCaptureArgs", () => {
  it("requests JSON output and passes the model", () => {
    expect(buildCaptureArgs("opencode/mimo-v2.5-free")).toEqual([
      "run",
      "-m",
      "opencode/mimo-v2.5-free",
      "--format",
      "json"
    ]);
  });

  it("omits -m when no model is configured", () => {
    expect(buildCaptureArgs("  ")).toEqual(["run", "--format", "json"]);
  });
});

describe("extractReviewText", () => {
  it("joins the text parts from the JSON event stream", () => {
    const stream = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"Correctness: correct\\n"}}',
      '{"type":"text","part":{"type":"text","text":"Summary: looks good."}}',
      '{"type":"step_finish","part":{"type":"step-finish"}}'
    ].join("\n");
    expect(extractReviewText(stream)).toBe(
      "Correctness: correct\nSummary: looks good."
    );
  });

  it("ignores non-JSON and non-text lines", () => {
    const stream = [
      "warning: something",
      '{"type":"text","part":{"type":"text","text":"hi"}}',
      "not json"
    ].join("\n");
    expect(extractReviewText(stream)).toBe("hi");
  });

  it("returns empty string when there is no text event", () => {
    expect(extractReviewText('{"type":"step_finish","part":{}}')).toBe("");
  });
});

describe("quoteWinArg", () => {
  it("leaves simple args unquoted", () => {
    expect(quoteWinArg("run")).toBe("run");
    expect(quoteWinArg("opencode/mimo-v2.5-free")).toBe("opencode/mimo-v2.5-free");
  });

  it("quotes args with spaces and doubles embedded quotes", () => {
    expect(quoteWinArg("C:\\My Vault")).toBe('"C:\\My Vault"');
    expect(quoteWinArg('a "b"')).toBe('"a ""b"""');
  });
});

describe("buildWindowsCommandLine", () => {
  it("joins command and args, quoting only where needed", () => {
    expect(
      buildWindowsCommandLine("opencode", ["run", "-m", "opencode/x", "--format", "json"])
    ).toBe("opencode run -m opencode/x --format json");
  });
});

// spawnEnv augments a GUI app's (often minimal) PATH so the agent CLI resolves on
// every OS. It takes env + platform as injectable params so both branches are
// testable regardless of the host the suite runs on.
describe("spawnEnv", () => {
  describe("windows", () => {
    it("prepends the npm global-bin dir when missing", () => {
      const env = { APPDATA: "C:\\Users\\x\\AppData\\Roaming", Path: "C:\\Windows" };
      expect(spawnEnv(env, "win32").Path).toBe(
        "C:\\Users\\x\\AppData\\Roaming\\npm;C:\\Windows"
      );
    });

    it("is a no-op (same ref) when the npm dir is already present (case-insensitive)", () => {
      const env = { APPDATA: "C:\\A", Path: "c:\\a\\npm;C:\\Windows" };
      expect(spawnEnv(env, "win32")).toBe(env);
    });

    it("returns the env unchanged when APPDATA is absent", () => {
      const env = { Path: "C:\\Windows" };
      expect(spawnEnv(env, "win32")).toBe(env);
    });
  });

  describe("macOS / Linux", () => {
    it("prepends Homebrew and per-user bin dirs a GUI PATH tends to omit", () => {
      const env = { HOME: "/Users/x", PATH: "/usr/bin:/bin" };
      expect(spawnEnv(env, "darwin").PATH).toBe(
        "/opt/homebrew/bin:/usr/local/bin:/Users/x/.opencode/bin:" +
          "/Users/x/.local/bin:/Users/x/.bun/bin:/usr/bin:/bin"
      );
    });

    it("does not duplicate a dir already present", () => {
      const env = { HOME: "/home/x", PATH: "/usr/local/bin:/usr/bin" };
      expect(spawnEnv(env, "linux").PATH).toBe(
        "/opt/homebrew/bin:/home/x/.opencode/bin:/home/x/.local/bin:" +
          "/home/x/.bun/bin:/usr/local/bin:/usr/bin"
      );
    });

    it("skips per-user dirs when HOME is unset", () => {
      const env = { PATH: "/usr/bin" };
      expect(spawnEnv(env, "linux").PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
    });

    it("seeds PATH (key 'PATH') when the env has none", () => {
      const out = spawnEnv({}, "darwin");
      expect(out.PATH).toBe("/opt/homebrew/bin:/usr/local/bin");
    });

    it("returns the same ref when every dir is already present", () => {
      const env = {
        HOME: "/home/x",
        PATH:
          "/opt/homebrew/bin:/usr/local/bin:/home/x/.opencode/bin:" +
          "/home/x/.local/bin:/home/x/.bun/bin:/usr/bin"
      };
      expect(spawnEnv(env, "linux")).toBe(env);
    });
  });
});
