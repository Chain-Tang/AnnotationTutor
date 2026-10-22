import { describe, expect, it } from "vitest";
import { jpegBase64ToPdf, jpegPagesToPdf } from "../src/board-export.js";

describe("board PDF export", () => {
  it("wraps a JPEG as a valid single-page PDF with a cross-reference table", () => {
    const pdf = jpegBase64ToPdf(btoa("fake-jpeg"), 640, 480);
    const text = new TextDecoder().decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("xref\n0 6");
    expect(text.endsWith("%%EOF\n")).toBe(true);
  });
  it("writes one PDF page for every Artboard", () => {
    const pdf = jpegPagesToPdf([
      { base64: btoa("page-one"), width: 640, height: 480 },
      { base64: btoa("page-two"), width: 1080, height: 1920 },
    ]);
    const text = new TextDecoder().decode(pdf);
    expect(text).toContain("/Count 2");
    expect(text.match(/\/Type \/Page /g)).toHaveLength(2);
    expect(text).toContain("/MediaBox [0 0 1080 1920]");
  });
});
