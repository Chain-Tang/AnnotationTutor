import { describe, expect, it } from "vitest";
import {
  buildCaptureNote,
  buildPageAppendSection,
  buildPageCaptureNote,
  captureNoteStem,
  isSameDayCapture,
  pageTemplateVars,
  parseCaptureFrontmatter,
  renderPageBody,
  type WebCaptureInput
} from "../src/web-capture.js";
import type { CapturePayload } from "../src/web-bridge/protocol.js";

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

  it("never derives path separators from an untrusted timestamp", () => {
    for (const capturedAt of ["/../../x", "../../evil", "\\..\\..\\x", "2026-10-09/../../x"]) {
      const stem = captureNoteStem({ ...baseInput, capturedAt });
      expect(stem).not.toMatch(/[\\/]/);
      expect(stem).toBe("Spaced-Repetition-101 undated");
    }
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

describe("isSameDayCapture", () => {
  const incoming = {
    url: "https://example.com/post",
    capturedAt: "2026-09-14T21:30:05.000Z"
  };

  it("matches the same URL on the same UTC day", () => {
    expect(
      isSameDayCapture(
        { url: "https://example.com/post", capturedAt: "2026-09-14T08:00:00.000Z" },
        incoming
      )
    ).toBe(true);
  });

  it("rejects a different day or a different page", () => {
    expect(
      isSameDayCapture(
        { url: "https://example.com/post", capturedAt: "2026-09-13T23:59:00.000Z" },
        incoming
      )
    ).toBe(false);
    expect(
      isSameDayCapture(
        { url: "https://example.com/other", capturedAt: "2026-09-14T08:00:00.000Z" },
        incoming
      )
    ).toBe(false);
  });

  it("rejects records missing metadata (not our capture note)", () => {
    expect(isSameDayCapture({ capturedAt: "2026-09-14T08:00:00.000Z" }, incoming)).toBe(
      false
    );
    expect(isSameDayCapture({ url: "https://example.com/post" }, incoming)).toBe(false);
  });
});

describe("buildPageAppendSection", () => {
  const pagePayload: CapturePayload = {
    v: 1,
    kind: "page",
    url: "https://example.com/post",
    title: "Example Post",
    capturedAt: "2026-09-14T15:30:05.000Z",
    markdown: "# Example Post\n\nFresh body text."
  };

  it("leads with a timestamped heading and carries the fresh body", () => {
    const section = buildPageAppendSection(pagePayload);
    expect(section).toContain("## 15:30 Re-captured");
    expect(section).toContain("Fresh body text.");
  });

  it("links the new raw snapshots as quote lines", () => {
    const section = buildPageAppendSection(pagePayload, {
      rendered: "_raw/Example-Post-2026-09-14 15.30.05.rendered.html",
      source: "_raw/Example-Post-2026-09-14 15.30.05.source.html"
    });
    expect(section).toContain(
      "> Raw: _raw/Example-Post-2026-09-14 15.30.05.rendered.html"
    );
    expect(section).toContain(
      "> Raw: _raw/Example-Post-2026-09-14 15.30.05.source.html"
    );
  });

  it("omits Raw lines when no snapshots were saved", () => {
    const section = buildPageAppendSection(pagePayload, {});
    expect(section).not.toContain("> Raw:");
  });

  it("still emits the heading when the Markdown body is empty", () => {
    const section = buildPageAppendSection(
      { ...pagePayload, markdown: "" },
      { rendered: "_raw/x.rendered.html" }
    );
    expect(section).toContain("## 15:30 Re-captured");
    expect(section).toContain("> Raw: _raw/x.rendered.html");
  });

  it("carries on-page highlights as an ==highlight== list with nested notes", () => {
    const section = buildPageAppendSection(
      {
        ...pagePayload,
        selections: [
          { exact: "first insight", prefix: "", suffix: "", note: "why it matters" },
          { exact: "second\nmultiline insight", prefix: "", suffix: "" }
        ]
      },
      {}
    );
    expect(section).toContain("## Highlights on this page");
    expect(section).toContain("- ==first insight==");
    expect(section).toContain("  - why it matters");
    expect(section).toContain("- ==second multiline insight==");
  });

  it("omits the Highlights section when the capture carried no highlights", () => {
    expect(buildPageAppendSection(pagePayload, {})).not.toContain("Highlights");
  });
});

describe("buildPageCaptureNote highlights", () => {
  const pagePayload: CapturePayload = {
    v: 1,
    kind: "page",
    url: "https://example.com/post",
    title: "Example Post",
    capturedAt: "2026-09-14T15:30:05.000Z",
    markdown: "Body text.",
    selections: [{ exact: "key sentence", prefix: "", suffix: "", note: "check this" }]
  };

  it("appends the Highlights section after the body", () => {
    const note = buildPageCaptureNote(pagePayload);
    const bodyAt = note.indexOf("Body text.");
    const hlAt = note.indexOf("## Highlights on this page");
    expect(hlAt).toBeGreaterThan(bodyAt);
    expect(note).toContain("- ==key sentence==");
    expect(note).toContain("  - check this");
  });

  it("writes no Highlights section without selections", () => {
    const bare: CapturePayload = { ...pagePayload, selections: undefined };
    expect(buildPageCaptureNote(bare)).not.toContain("Highlights");
  });
});

describe("renderPageBody", () => {
  const vars = pageTemplateVars({
    v: 1,
    kind: "page",
    url: "https://example.com/post",
    title: "Example Post",
    capturedAt: "2026-09-14T15:30:05.000Z",
    markdown: "Body text.",
    selections: [{ exact: "key sentence", prefix: "", suffix: "", note: "check this" }]
  });

  it("exposes the payload's metadata as template variables", () => {
    expect(vars.title).toBe("Example Post");
    expect(vars.url).toBe("https://example.com/post");
    expect(vars.date).toBe("2026-09-14");
    expect(vars.time).toBe("15:30");
    expect(vars.content).toBe("Body text.");
    expect(vars.highlights).toContain("## Highlights on this page");
  });

  it("renders a custom layout from the template", () => {
    const body = renderPageBody(
      "## {{title}}\n\nRead on {{date}} at {{time}}: {{url}}\n\n{{highlights}}\n\n{{content}}",
      vars
    );
    expect(body).toContain("## Example Post");
    expect(body).toContain("Read on 2026-09-14 at 15:30: https://example.com/post");
    const hlAt = body.indexOf("## Highlights on this page");
    const bodyAt = body.indexOf("Body text.");
    expect(hlAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(hlAt);
  });

  it("collapses the blank lines an empty variable leaves behind", () => {
    const bare = { ...vars, highlights: "" };
    expect(renderPageBody("{{content}}\n\n{{highlights}}", bare)).toBe("Body text.");
  });

  it("leaves unknown variables untouched so typos stay visible", () => {
    expect(renderPageBody("Keep {{unkown}} as-is", vars)).toContain("{{unkown}}");
  });

  it("does not re-substitute variables appearing inside the page content", () => {
    // A page about templating can carry literal {{title}} markers; splicing
    // {{content}} in first must not expose them to the remaining substitutions.
    const body = renderPageBody("{{content}}\n\n{{url}}", {
      ...vars,
      content: "Write {{title}} or {{content}} inside code samples."
    });
    expect(body).toContain("Write {{title}} or {{content}} inside code samples.");
  });
});

describe("buildPageCaptureNote template", () => {
  const pagePayload: CapturePayload = {
    v: 1,
    kind: "page",
    url: "https://example.com/post",
    title: "Example Post",
    capturedAt: "2026-09-14T15:30:05.000Z",
    markdown: "Body text.",
    selections: [{ exact: "key sentence", prefix: "", suffix: "" }]
  };

  it("uses the template for the note body while keeping frontmatter", () => {
    const note = buildPageCaptureNote(
      pagePayload,
      {},
      "# {{title}}\n\n{{highlights}}\n\n{{content}}"
    );
    expect(note).toContain("type: web-capture");
    expect(note).toContain('source-url: "https://example.com/post"');
    const titleAt = note.indexOf("# Example Post");
    const hlAt = note.indexOf("## Highlights on this page");
    const bodyAt = note.indexOf("Body text.");
    expect(titleAt).toBeGreaterThan(-1);
    expect(hlAt).toBeGreaterThan(titleAt);
    expect(bodyAt).toBeGreaterThan(hlAt);
  });

  it("reproduces the default layout when the template is empty", () => {
    const withEmpty = buildPageCaptureNote(pagePayload, {}, "");
    expect(withEmpty).toBe(buildPageCaptureNote(pagePayload, {}, "   "));
    expect(withEmpty).toBe(buildPageCaptureNote(pagePayload));
  });
});
