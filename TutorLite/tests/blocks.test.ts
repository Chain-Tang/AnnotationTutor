import { describe, expect, it } from "vitest";
import {
  extractBlocks,
  formatList,
  fromBlockquote,
  parseList,
  parseMetadata,
  replaceBlock,
  splitSections,
  startSentinel,
  endSentinel,
  toBlockquote,
  truncate
} from "../src/markdown/blocks.js";

describe("sentinel blocks", () => {
  const doc = [
    startSentinel("annotation", "ANN-1"),
    "body one",
    endSentinel("annotation", "ANN-1"),
    "",
    startSentinel("task", "TASK-1"),
    "body two",
    endSentinel("task", "TASK-1")
  ].join("\n");

  it("extracts blocks by kind", () => {
    expect(extractBlocks(doc, "annotation")).toHaveLength(1);
    expect(extractBlocks(doc, "task")[0]?.body.trim()).toBe("body two");
    expect(extractBlocks(doc)).toHaveLength(2);
  });

  it("ignores a start without a matching end", () => {
    const broken = `${startSentinel("annotation", "ANN-2")}\nno end here\n`;
    expect(extractBlocks(broken)).toHaveLength(0);
  });

  it("replaces a block in place", () => {
    const block = extractBlocks(doc, "annotation")[0]!;
    const result = replaceBlock(doc, block, "REPLACED");
    expect(result).toContain("REPLACED");
    expect(result).not.toContain("body one");
    expect(result).toContain("body two");
  });
});

describe("field helpers", () => {
  it("splits lead and sections", () => {
    const { lead, sections } = splitSections(
      "- Key: value\n\n### Selected Text\n\n> quote\n\n### User Note\n\nplain"
    );
    expect(lead).toContain("- Key: value");
    expect(sections.get("Selected Text")).toContain("> quote");
    expect(sections.get("User Note")).toBe("plain");
  });

  it("parses metadata bullets", () => {
    const meta = parseMetadata("- Status: saved\n- Anchor: `^ann-1`");
    expect(meta.get("status")).toBe("saved");
    expect(meta.get("anchor")).toBe("`^ann-1`");
  });

  it("round-trips lists and blockquotes", () => {
    expect(parseList(formatList(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseList(formatList([]))).toEqual([]);
    expect(fromBlockquote(toBlockquote("line one\n\nline two"))).toBe(
      "line one\n\nline two"
    );
  });

  it("truncates long text to one line", () => {
    expect(truncate("a\nb  c", 100)).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});
