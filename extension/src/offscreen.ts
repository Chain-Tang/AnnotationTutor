// Offscreen document: MV3 service workers have no DOM, so Readability (needs a
// real Document) and Turndown run here. The worker spins this document up on
// demand, posts rendered HTML in, and gets clean Markdown back. Relative asset
// URLs are resolved against the page URL first so the archived Markdown keeps
// working links once it leaves the origin.

import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { ConvertMessage, ConvertResult } from "./messages.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});
turndown.use(gfm);

/** Rewrite every relative href/src to an absolute URL rooted at the page URL. */
function absolutizeUrls(doc: Document, baseUrl: string): void {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[href],[src]"))) {
    for (const attr of ["href", "src"] as const) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      try {
        el.setAttribute(attr, new URL(value, baseUrl).href);
      } catch {
        // Leave unparseable values (e.g. "javascript:", "data:") untouched.
      }
    }
  }
}

/** Readability-extract the article body, falling back to the whole document. */
function convert(html: string, baseUrl: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  absolutizeUrls(doc, baseUrl);
  const article = new Readability(doc).parse();
  const contentHtml = article?.content ?? doc.body?.innerHTML ?? "";
  return turndown.turndown(contentHtml).trim();
}

chrome.runtime.onMessage.addListener(
  (
    message: ConvertMessage,
    _sender,
    sendResponse: (result: ConvertResult) => void
  ) => {
    if (message.type !== "convert") return undefined;
    try {
      sendResponse({ markdown: convert(message.html, message.baseUrl) });
    } catch (error) {
      sendResponse({
        markdown: "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    // Synchronous response already sent; no need to keep the channel open.
    return undefined;
  }
);
