// Web-capture helpers: turn a selection from an embedded browser view (Surfing
// and friends) into a learning annotation. This mirrors Zotero's "capture into
// library" step, but the destination is the learning loop — the capture note
// becomes the annotation's source file, and the annotation flows straight into
// review / memory cells. Matching and note assembly are pure (unit-tested);
// the DOM extraction itself lives on the plugin side.

/** viewType fragments that mark a leaf as an embedded browser (case-insensitive). */
export const BROWSER_VIEW_HINTS = ["surfing", "browser", "webview"];

/**
 * True when a leaf's viewType looks like an embedded browser. Learners can add
 * their plugin's viewType via settings (`webCaptureViewTypes`), so an exact
 * match against the configured list wins before the heuristic hints.
 */
export function isBrowserLikeView(viewType: string, extra: string[] = []): boolean {
  const type = viewType.trim().toLowerCase();
  if (!type) return false;
  if (extra.some((item) => item.trim().toLowerCase() === type)) return true;
  return BROWSER_VIEW_HINTS.some((hint) => type.includes(hint));
}

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
 * The Markdown capture note. The selection lives in a quote block so the
 * annotation can anchor to it with a block id; source metadata goes into
 * frontmatter so later citation export can read it back.
 */
export function buildCaptureNote(input: WebCaptureInput, blockId: string): string {
  const lines = ["---", "type: web-capture"];
  if (input.title?.trim()) lines.push(`title: "${input.title.trim().replace(/"/g, "'")}"`);
  if (input.url?.trim()) lines.push(`source-url: "${input.url.trim()}"`);
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
    const value = kv[2]!.trim().replace(/^"|"$/g, "");
    if (kv[1] === "title") out.title = value;
    else if (kv[1] === "source-url") out.url = value;
    else out.capturedAt = value;
  }
  return out;
}
