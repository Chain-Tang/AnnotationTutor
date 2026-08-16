import { describe, expect, it } from "vitest";
import {
  buildCaptureNote,
  captureNoteStem,
  parseCaptureFrontmatter,
  type WebCaptureInput
} from "../src/web-capture.js";

const baseInput: WebCaptureInput = {
  selection: "间隔重复的核心是提取练习。",
  url: "https://example.com/articles/spaced-repetition?ref=home",
  title: "Spaced Repetition 101",
  capturedAt: "2026-08-13T09:00:00.000Z"
};

describe("captureNoteStem", () => {
  it("prefers the page title, slugified and day-stamped", () => {
    expect(captureNoteStem(baseInput)).toBe("Spaced-Repetition-101 2026-08-13");
  });

  it("falls back to the URL host when there is no title", () => {
    const stem = captureNoteStem({ ...baseInput, title: undefined });
    expect(stem).toBe("example.com 2026-08-13");
  });

  it("uses a generic stem when neither title nor url exists", () => {
    const stem = captureNoteStem({
      selection: "x",
      capturedAt: "2026-08-13T00:00:00.000Z"
    });
    expect(stem).toBe("web-capture 2026-08-13");
  });

  it("strips filesystem-hostile characters", () => {
    const stem = captureNoteStem({
      selection: "x",
      title: 'A: *bad* <name> | "quoted"',
      capturedAt: "2026-08-13T00:00:00.000Z"
    });
    expect(stem).not.toMatch(/[:*<>|"]/);
  });
});

describe("buildCaptureNote", () => {
  it("puts metadata in frontmatter and the selection in an anchored quote", () => {
    const note = buildCaptureNote(baseInput, "cap-001");
    expect(note).toContain("type: web-capture");
    expect(note).toContain('title: "Spaced Repetition 101"');
    expect(note).toContain('source-url: "https://example.com/articles/spaced-repetition?ref=home"');
    expect(note).toContain("> 间隔重复的核心是提取练习。 ^cap-001");
    expect(note).toContain("## My understanding");
  });

  it("omits optional fields when absent", () => {
    const note = buildCaptureNote(
      { selection: "text", capturedAt: "2026-08-13T00:00:00.000Z" },
      "cap-002"
    );
    expect(note).not.toContain("title:");
    expect(note).not.toContain("source-url:");
  });

  it("quotes every line of a multiline selection", () => {
    const note = buildCaptureNote(
      { selection: "line one\nline two", capturedAt: "2026-08-13T00:00:00.000Z" },
      "cap-003"
    );
    expect(note).toContain("> line one\n> line two ^cap-003");
  });
});

describe("parseCaptureFrontmatter", () => {
  it("round-trips the metadata written by buildCaptureNote", () => {
    const parsed = parseCaptureFrontmatter(buildCaptureNote(baseInput, "cap-004"));
    expect(parsed.title).toBe("Spaced Repetition 101");
    expect(parsed.url).toBe(
      "https://example.com/articles/spaced-repetition?ref=home"
    );
    expect(parsed.capturedAt).toBe("2026-08-13T09:00:00.000Z");
  });

  it("returns an empty object for notes without frontmatter", () => {
    expect(parseCaptureFrontmatter("# just a note")).toEqual({});
  });

  it("round-trips a LaTeX/backslash title without corrupting the YAML", () => {
    // `$\alpha$` would emit `\a` — an illegal YAML escape — unless the backslash
    // is escaped first; the parser must then undo it to recover the original.
    const input: WebCaptureInput = {
      selection: "x",
      title: 'On $\\alpha$ and "quoted" terms',
      capturedAt: "2026-08-13T00:00:00.000Z"
    };
    const note = buildCaptureNote(input, "cap-005");
    expect(note).toContain('title: "On $\\\\alpha$ and \\"quoted\\" terms"');
    const parsed = parseCaptureFrontmatter(note);
    expect(parsed.title).toBe('On $\\alpha$ and "quoted" terms');
  });
});
