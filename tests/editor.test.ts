import { describe, expect, it } from "vitest";
import {
  detectBlockId,
  findBlockInLines,
  findTableInLines
} from "../src/editor.js";

describe("findBlockInLines", () => {
  const lines = [
    "First paragraph line one,",
    "first paragraph line two.",
    "",
    "A paragraph immediately before a heading.",
    "## A heading with no blank line above",
    "",
    "Body of the section."
  ];

  it("expands a multi-line paragraph to its blank-line bounds", () => {
    expect(findBlockInLines(lines, 0)).toEqual({ startLine: 0, endLine: 1 });
    expect(findBlockInLines(lines, 1)).toEqual({ startLine: 0, endLine: 1 });
  });

  it("does not let a paragraph absorb a following heading", () => {
    // Line 3 is a paragraph; line 4 is a heading with no blank line between.
    // The block must stop at line 3, so the block id lands on the paragraph.
    expect(findBlockInLines(lines, 3)).toEqual({ startLine: 3, endLine: 3 });
  });

  it("treats a heading as its own block", () => {
    expect(findBlockInLines(lines, 4)).toEqual({ startLine: 4, endLine: 4 });
  });

  it("does not let a paragraph absorb a preceding heading", () => {
    expect(findBlockInLines(lines, 6)).toEqual({ startLine: 6, endLine: 6 });
  });
});

describe("Markdown table anchors", () => {
  const table = [
    "Before",
    "",
    "| Concept | Meaning |",
    "| --- | --- |",
    "| Attention | Weighted context |",
    "| Memory | Durable knowledge |",
    "^ann-table",
    "",
    "After"
  ];

  it("finds the complete table from a selected cell row", () => {
    expect(findTableInLines(table, 4)).toEqual({ startLine: 2, endLine: 5 });
  });

  it("does not mistake an ordinary pipe for a table", () => {
    expect(findTableInLines(["alpha | beta", "ordinary text"], 0)).toBeNull();
  });

  it("recognizes a standalone table block id", () => {
    expect(detectBlockId("^ann-table")).toBe("ann-table");
  });
});
