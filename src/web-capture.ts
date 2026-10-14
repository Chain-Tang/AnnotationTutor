// Web-capture helpers: turn a page or selection sent by the external browser
// extension into a learning annotation. This mirrors Zotero's "capture into
// library" step, but the destination is the learning loop — the capture note
// becomes the annotation's source file, and the annotation flows straight into
// review / memory cells. Note assembly is pure (unit-tested); the DOM
// extraction and Markdown conversion happen in the browser extension.

import type { CapturePayload } from "./web-bridge/protocol.js";

export type WebCaptureInput = {
  selection: string;
  url?: string;
  title?: string;
  capturedAt: string; // ISO timestamp
};

/** A filesystem-friendly stem for the capture note. */
export function captureNoteStem(input: WebCaptureInput): string {
  const base =
    input.title?.trim() ||
    input.url?.trim().replace(/^https?:\/\//, "").split(/[/?#]/)[0] ||
    "web-capture";
  const slug = base
    .replace(/[\\/:*?"<>|#^\[\]]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
  // The bridge validates ISO timestamps; keep every other caller safe too.
  const day = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(input.capturedAt) ? input.capturedAt.slice(0, 10) : "undated";
  return slug ? `${slug} ${day}` : `web-capture ${day}`;
}

/**
 * Wrap a value as a YAML double-quoted scalar. Backslash must be escaped before
 * the quote, or a LaTeX/BibTeX title like `$\alpha$` emits `\a` — an illegal
 * YAML escape that breaks the whole frontmatter block.
 */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Inverse of {@link yamlQuote}: undo `\"`→`"` first, then `\\`→`\`. */
function yamlUnquote(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * The Markdown capture note. The selection lives in a quote block so the
 * annotation can anchor to it with a block id; source metadata goes into
 * frontmatter so later citation export can read it back.
 */
export function buildCaptureNote(input: WebCaptureInput, blockId: string): string {
  const lines = ["---", "type: web-capture"];
  if (input.title?.trim()) lines.push(`title: ${yamlQuote(input.title.trim())}`);
  if (input.url?.trim()) lines.push(`source-url: ${yamlQuote(input.url.trim())}`);
  lines.push(`captured-at: ${input.capturedAt}`);
  lines.push("tags:", "  - web-capture", "---", "");
  const selection = input.selection.trim();
  const quoted = selection
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  lines.push(quoted + ` ^${blockId}`, "");
  lines.push("## My understanding", "");
  return lines.join("\n");
}

/** Frontmatter head shared by capture notes assembled from an extension payload. */
function captureHead(payload: CapturePayload): string[] {
  const lines = ["---", "type: web-capture"];
  if (payload.title.trim()) lines.push(`title: ${yamlQuote(payload.title.trim())}`);
  if (payload.url.trim()) lines.push(`source-url: ${yamlQuote(payload.url.trim())}`);
  lines.push(`captured-at: ${payload.capturedAt}`);
  return lines;
}

/**
 * A capture note for one or more highlighted selections sent by the browser
 * extension. The primary selection's TextQuoteSelector goes into frontmatter so
 * a later visit can relocate it; each selection becomes an anchorable quote
 * block, and any learner notes collect under "## My understanding".
 */
export function buildSelectionCaptureNote(
  payload: CapturePayload,
  blockId: string
): string {
  const selections = payload.selections ?? [];
  const lines = captureHead(payload);
  const primary = selections[0];
  if (primary) {
    lines.push(`anchor-exact: ${yamlQuote(primary.exact)}`);
    lines.push(`anchor-prefix: ${yamlQuote(primary.prefix)}`);
    lines.push(`anchor-suffix: ${yamlQuote(primary.suffix)}`);
  }
  lines.push("tags:", "  - web-capture", "---", "");
  selections.forEach((selection, index) => {
    const id = index === 0 ? blockId : `${blockId}-${index}`;
    const quoted = selection.exact
      .trim()
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    lines.push(`${quoted} ^${id}`, "");
  });
  lines.push("## My understanding", "");
  const notes = selections
    .map((selection) => selection.note?.trim())
    .filter((note): note is string => Boolean(note));
  if (notes.length > 0) lines.push(notes.join("\n\n"), "");
  return lines.join("\n");
}

/**
 * The "## Highlights" section for page captures that carried the learner's
 * on-page highlights: each becomes an `==highlight==` list item with its note
 * nested beneath. Empty when the payload carried none — the section simply
 * stays absent rather than heading an empty list.
 */
function highlightSection(payload: CapturePayload): string[] {
  const selections = payload.selections ?? [];
  const lines: string[] = [];
  for (const selection of selections) {
    const text = selection.exact.replace(/\r?\n/g, " ").trim();
    if (!text) continue;
    if (lines.length === 0) lines.push("## Highlights on this page", "");
    lines.push(`- ==${text}==`);
    const note = selection.note?.trim();
    if (note) lines.push(`  - ${note.replace(/\r?\n/g, " ")}`);
  }
  return lines.length === 0 ? [] : [...lines, ""];
}

/**
 * Variables available to a page-capture note body template. `content` is the
 * extension's Markdown conversion of the page, `highlights` the "## Highlights
 * on this page" block built from the payload's selections.
 */
export interface PageTemplateVars {
  title: string;
  url: string;
  date: string;
  time: string;
  content: string;
  highlights: string;
}

/** Template variables a custom `webPageTemplate` may reference. */
export const PAGE_TEMPLATE_VARIABLES = [
  "{{title}}",
  "{{url}}",
  "{{date}}",
  "{{time}}",
  "{{content}}",
  "{{highlights}}"
] as const;

/**
 * Render a page-capture note body from a custom template. One single-pass
 * replace — with a sequential chain, page content that itself contains a
 * literal `{{title}}` (docs about templating, code samples) would get
 * re-substituted after `{{content}}` was spliced in. Unknown `{{vars}}` are
 * left untouched so typos stay visible; runs of blank lines created by empty
 * variables (e.g. no highlights) collapse to a single blank line.
 */
export function renderPageBody(template: string, vars: PageTemplateVars): string {
  const rendered = template.replace(
    /\{\{(title|url|date|time|content|highlights)\}\}/g,
    (_match, key: string) => vars[key as keyof PageTemplateVars]
  );
  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The vars for one page payload. Exposed for tests and for the settings UI's
 * default-template hint; `highlights` carries its section heading.
 */
export function pageTemplateVars(payload: CapturePayload): PageTemplateVars {
  return {
    title: payload.title.trim(),
    url: payload.url.trim(),
    date: payload.capturedAt.slice(0, 10),
    time: payload.capturedAt.slice(11, 16),
    content: payload.markdown.trim(),
    highlights: highlightSection(payload).join("\n").trimEnd()
  };
}

/**
 * A capture note for a full-page archive: frontmatter plus the extension's
 * Turndown output. Sibling raw-HTML paths (rendered DOM, server source) are
 * recorded in frontmatter when stored, so the note links back to the originals.
 * On-page highlights ride along as a highlight list section. A custom
 * `template` (from `webPageTemplate`) re-arranges the body; empty keeps the
 * default `content, then highlights` layout byte-identical to history.
 */
export function buildPageCaptureNote(
  payload: CapturePayload,
  raw: { rendered?: string; source?: string } = {},
  template = ""
): string {
  const lines = captureHead(payload);
  if (raw.rendered) lines.push(`raw-rendered: ${yamlQuote(raw.rendered)}`);
  if (raw.source) lines.push(`raw-source: ${yamlQuote(raw.source)}`);
  lines.push("tags:", "  - web-capture", "  - web-page", "---", "");
  const custom = template.trim();
  if (custom) {
    lines.push(renderPageBody(custom, pageTemplateVars(payload)), "");
  } else {
    const body = payload.markdown.trim();
    if (body) lines.push(body, "");
    lines.push(...highlightSection(payload));
  }
  return lines.join("\n");
}

/** Read source metadata back out of a capture note's frontmatter. */
export function parseCaptureFrontmatter(
  content: string
): { title?: string; url?: string; capturedAt?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const out: { title?: string; url?: string; capturedAt?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^(title|source-url|captured-at):\s*(.+)$/.exec(line.trim());
    if (!kv) continue;
    const value = yamlUnquote(kv[2]!.trim());
    if (kv[1] === "title") out.title = value;
    else if (kv[1] === "source-url") out.url = value;
    else out.capturedAt = value;
  }
  return out;
}

/**
 * True when `incoming` is a re-capture of a page already archived the same
 * (UTC) day: same source URL and a same-day `captured-at`. Such a capture
 * appends to the existing note instead of forking a sibling file.
 */
export function isSameDayCapture(
  existing: { url?: string; capturedAt?: string },
  incoming: { url: string; capturedAt: string }
): boolean {
  if (!existing.url || !existing.capturedAt) return false;
  return (
    existing.url === incoming.url &&
    existing.capturedAt.slice(0, 10) === incoming.capturedAt.slice(0, 10)
  );
}

/**
 * The section appended to an existing same-day capture note on re-capture: a
 * timestamped heading, the fresh Markdown body, and links to the new raw
 * snapshots. Mirrors {@link buildPageCaptureNote}'s body conventions, and the
 * heading language matches the note's existing hard-coded sections.
 */
export function buildPageAppendSection(
  payload: CapturePayload,
  raw: { rendered?: string; source?: string } = {}
): string {
  const lines: string[] = [];
  const time = payload.capturedAt.slice(11, 16) || "re-captured";
  lines.push(`## ${time} Re-captured`, "");
  const body = payload.markdown.trim();
  if (body) lines.push(body, "");
  lines.push(...highlightSection(payload));
  if (raw.rendered) lines.push(`> Raw: ${raw.rendered}`);
  if (raw.source) lines.push(`> Raw: ${raw.source}`);
  return lines.join("\n").trimEnd();
}
