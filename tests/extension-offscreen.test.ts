// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConvertResult } from "../extension/src/messages.js";

type Listener = (
  message: { type: string; html: string; baseUrl: string },
  sender: unknown,
  respond: (result: ConvertResult) => void
) => unknown;
let listener: Listener;

beforeAll(async () => {
  // Stub browser messaging only. Run the real offscreen entry point, installed
  // Readability, DOMParser and Turndown so dependency upgrades exercise capture.
  vi.stubGlobal("chrome", { runtime: { onMessage: { addListener(callback: Listener) { listener = callback; } } } });
  const entry = "../extension/src/offscreen.js";
  await import(entry);
});
afterAll(() => vi.unstubAllGlobals());

function convert(html: string, baseUrl = "https://example.com/articles/page") {
  let result: ConvertResult | undefined;
  const keepChannelOpen = listener({ type: "convert", html, baseUrl }, {}, response => { result = response; });
  expect(keepChannelOpen).toBeUndefined();
  expect(result).toBeDefined();
  expect(result!.error).toBeUndefined();
  return result!.markdown;
}
const paragraph = "Students connect evidence with a clear explanation and compare each new idea with the source material. ".repeat(8);
function article(content: string, title = "Learning from evidence and examples") {
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${paragraph}</p>${content}<p>${paragraph}</p></article></body></html>`;
}

describe("offscreen capture with patched Readability", () => {
  it("converts the extracted article through the real message listener", () => {
    const markdown = convert(article("<p>中文正文：把学习证据和实际理解联系起来。</p><script>window.untrusted = true;</script>"));
    expect(markdown).toContain("中文正文：把学习证据和实际理解联系起来。");
    expect(markdown).toContain("Students connect evidence");
    expect(markdown).not.toContain("window.untrusted");
  });

  it("resolves relative links and images against the captured page URL", () => {
    const markdown = convert(article('<p><a href="../sources/reference">Study reference</a></p><p><img src="/images/evidence.png" alt="Evidence diagram"></p>'));
    expect(markdown).toContain("[Study reference](https://example.com/sources/reference)");
    expect(markdown).toContain("![Evidence diagram](https://example.com/images/evidence.png)");
  });

  it("keeps data tables as GFM Markdown", () => {
    const markdown = convert(article("<table><thead><tr><th>Concept</th><th>Definition</th></tr></thead><tbody><tr><td>Evidence</td><td>Observed support for a learning claim</td></tr><tr><td>Practice</td><td>Repeated application with feedback</td></tr></tbody></table>"));
    expect(markdown).toMatch(/\| Concept \| Definition \|/);
    expect(markdown).toMatch(/\| Evidence \| Observed support for a learning claim \|/);
    expect(markdown).toMatch(/\| --- \| --- \|/);
  });

  it("handles a long title with many hierarchy separators", () => {
    const title = `${"Section of a long title / ".repeat(2000)}Final article | Site`;
    const markdown = convert(article("<p>The captured article still completes.</p>", title));
    expect(markdown).toContain("The captured article still completes.");
  });

  it("returns an empty Markdown result for an empty document", () => {
    expect(convert("<!doctype html><html><head><title></title></head><body></body></html>")).toBe("");
  });
});
