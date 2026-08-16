import { describe, expect, it } from "vitest";
import {
  buildPageCaptureNote,
  buildSelectionCaptureNote,
  parseCaptureFrontmatter
} from "../src/web-capture.js";
import type { CapturePayload } from "../src/web-bridge/protocol.js";

const selectionPayload: CapturePayload = {
  v: 1,
  kind: "selection",
  url: "https://example.com/spaced",
  title: "Spaced Repetition",
  capturedAt: "2026-08-13T09:00:00.000Z",
  markdown: "",
  selections: [
    {
      exact: "retrieval practice",
      prefix: "core is ",
      suffix: " today",
      note: "why it works"
    },
    { exact: "second highlight", prefix: "", suffix: "" }
  ]
};

describe("buildSelectionCaptureNote", () => {
  const note = buildSelectionCaptureNote(selectionPayload, "cap-abc");

  it("writes the primary TextQuoteSelector into frontmatter", () => {
    expect(note).toContain('anchor-exact: "retrieval practice"');
    expect(note).toContain('anchor-prefix: "core is "');
    expect(note).toContain('anchor-suffix: " today"');
  });

  it("anchors each selection as its own quote block", () => {
    expect(note).toContain("> retrieval practice ^cap-abc");
    expect(note).toContain("> second highlight ^cap-abc-1");
  });

  it("collects learner notes under My understanding", () => {
    const understanding = note.slice(note.indexOf("## My understanding"));
    expect(understanding).toContain("why it works");
  });

  it("keeps source metadata round-trippable", () => {
    const parsed = parseCaptureFrontmatter(note);
    expect(parsed.title).toBe("Spaced Repetition");
    expect(parsed.url).toBe("https://example.com/spaced");
    expect(parsed.capturedAt).toBe("2026-08-13T09:00:00.000Z");
  });
});

const pagePayload: CapturePayload = {
  v: 1,
  kind: "page",
  url: "https://example.com/article",
  title: "Long Article",
  capturedAt: "2026-08-14T10:00:00.000Z",
  markdown: "# Long Article\n\nThe body in Markdown."
};

describe("buildPageCaptureNote", () => {
  it("embeds the Markdown body and tags the note as a page", () => {
    const note = buildPageCaptureNote(pagePayload);
    expect(note).toContain("type: web-capture");
    expect(note).toContain("  - web-page");
    expect(note).toContain("The body in Markdown.");
  });

  it("records raw-HTML sibling paths when they are stored", () => {
    const note = buildPageCaptureNote(pagePayload, {
      rendered: "_raw/Long-Article.rendered.html",
      source: "_raw/Long-Article.source.html"
    });
    expect(note).toContain('raw-rendered: "_raw/Long-Article.rendered.html"');
    expect(note).toContain('raw-source: "_raw/Long-Article.source.html"');
  });

  it("omits the body when Markdown conversion is turned off", () => {
    const note = buildPageCaptureNote({ ...pagePayload, markdown: "" });
    expect(note).not.toContain("The body in Markdown.");
    expect(note).toContain("type: web-capture");
  });
});
