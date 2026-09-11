import { describe, expect, it } from "vitest";
import { locatePdfText } from "../src/pdf-highlighter.js";

describe("PDF text-layer matching", () => {
  it("maps a phrase across several PDF.js text nodes", () => {
    expect(locatePdfText(["Multi-head ", "attention", " works"], "Multi-head attention")).toEqual([
      { segment: 0, from: 0, to: 10 },
      { segment: 1, from: 0, to: 9 }
    ]);
  });

  it("retries with virtual spaces between positioned word spans", () => {
    expect(locatePdfText(["Weighted", "context"], "Weighted context")).toEqual([
      { segment: 0, from: 0, to: 8 },
      { segment: 1, from: 0, to: 7 }
    ]);
  });

  it("selects later occurrences for repeated annotations", () => {
    expect(locatePdfText(["memory and memory"], "memory", 1)).toEqual([
      { segment: 0, from: 11, to: 17 }
    ]);
  });

  it("returns null when the page text has drifted", () => {
    expect(locatePdfText(["unrelated page"], "attention")).toBeNull();
  });
});
