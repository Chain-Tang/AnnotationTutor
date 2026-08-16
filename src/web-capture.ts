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
  const day = input.capturedAt.slice(0, 10);
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
 * A capture note for a full-page archive: frontmatter plus the extension's
 * Turndown output. Sibling raw-HTML paths (rendered DOM, server source) are
 * recorded in frontmatter when stored, so the note links back to the originals.
 */
export function buildPageCaptureNote(
  payload: CapturePayload,
  raw: { rendered?: string; source?: string } = {}
): string {
  const lines = captureHead(payload);
  if (raw.rendered) lines.push(`raw-rendered: ${yamlQuote(raw.rendered)}`);
  if (raw.source) lines.push(`raw-source: ${yamlQuote(raw.source)}`);
  lines.push("tags:", "  - web-capture", "  - web-page", "---", "");
  const body = payload.markdown.trim();
  if (body) lines.push(body, "");
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
