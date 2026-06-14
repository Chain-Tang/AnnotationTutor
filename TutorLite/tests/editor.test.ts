import { describe, expect, it } from "vitest";
import { findBlockInLines } from "../src/editor.js";

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
