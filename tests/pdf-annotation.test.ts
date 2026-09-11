import { describe, expect, it } from "vitest";
import {
  normalizePdfSelection,
  parsePdfPageNumber,
  pdfAnchorId,
  pdfSelectionActionPoint
} from "../src/pdf-annotation.js";

describe("PDF annotation helpers", () => {
  it("normalizes PDF.js whitespace without changing the words", () => {
    expect(normalizePdfSelection("  Multi-head\n attention\u00a0works.  ")).toBe(
      "Multi-head attention works."
    );
  });

  it("accepts only positive integer page numbers", () => {
    expect(parsePdfPageNumber("12")).toBe(12);
    expect(parsePdfPageNumber("0")).toBeUndefined();
    expect(parsePdfPageNumber("2.5")).toBeUndefined();
    expect(parsePdfPageNumber(undefined)).toBeUndefined();
  });

  it("builds a block-id-safe synthetic PDF anchor", () => {
    expect(pdfAnchorId("ANN-20260908-001", 7)).toBe(
      "pdf-page-7-ann-20260908-001"
    );
  });

  it("places the PDF selection action inside the viewport", () => {
    expect(
      pdfSelectionActionPoint(
        { left: 740, right: 790, top: 540, bottom: 560 },
        800,
        600
      )
    ).toEqual({ x: 656, y: 496 });
    expect(
      pdfSelectionActionPoint(
        { left: 20, right: 60, top: 20, bottom: 40 },
        800,
        600
      )
    ).toEqual({ x: 68, y: 48 });
  });
});
