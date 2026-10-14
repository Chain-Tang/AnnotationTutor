import { describe, expect, it } from "vitest";
import {
  OFFICIAL_WEB_CLIPPER_TEMPLATE_VERSION,
  TUTOR_ANALYSIS_MARKER,
  appendTutorAnalysis,
  officialWebClipperTemplate,
  officialWebClipperTemplateJson,
  parseOfficialClipperNote
} from "../src/official-web-clipper.js";

describe("official Web Clipper template", () => {
  it("generates a versioned Tutor template for the configured capture folder", () => {
    const template = officialWebClipperTemplate("/Agent Memory/captures/");
    expect(template.schemaVersion).toBe("0.1.0");
    expect(template.path).toBe("Agent Memory/captures");
    expect(template.properties).toContainEqual({
      name: "tutor_capture",
      value: OFFICIAL_WEB_CLIPPER_TEMPLATE_VERSION,
      type: "text"
    });
    expect(JSON.parse(officialWebClipperTemplateJson("Clips"))).toMatchObject({
      name: "Tutor Web Capture",
      path: "Clips"
    });
  });

  it("recognizes only explicitly marked official Tutor captures", () => {
    const note = [
      "---",
      "type: web-capture",
      "tutor_capture: official-v1",
      "capture_source: obsidian-web-clipper",
      "tutor_analysis: pending",
      'title: "A paper"',
      'source-url: "https://example.com/paper"',
      "captured-at: 2026-09-16T12:00:00+08:00",
      "---",
      "## Captured content",
      "Source text"
    ].join("\n");
    expect(parseOfficialClipperNote(note)).toMatchObject({
      metadata: { title: "A paper", analysis: "pending" },
      document: {
        url: "https://example.com/paper",
        markdown: "## Captured content\nSource text",
        source: "obsidian-web-clipper"
      }
    });
    expect(parseOfficialClipperNote(note.replace("official-v1", "other"))).toBeNull();
    expect(parseOfficialClipperNote("---\ntype: web-capture\n---\nordinary")).toBeNull();
  });

  it("appends one idempotent versioned Tutor analysis block", () => {
    const first = appendTutorAnalysis("source\n", "summary");
    expect(first).toContain(TUTOR_ANALYSIS_MARKER);
    expect(first).toContain("## Tutor analysis\n\nsummary");
    expect(appendTutorAnalysis(first, "duplicate")).toBe(first);
  });
});
