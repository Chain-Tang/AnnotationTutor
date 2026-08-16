// Guardrail for agent-generated Excalidraw notes. The plugin never draws the
// diagram itself — the Obsidian Excalidraw plugin renders any note carrying
// the `excalidraw-plugin: parsed` frontmatter — but LLM output drifts from the
// format spec (extra fields, `[]` where `null` is required, timestamps). This
// module detects such notes and repairs the element JSON before the drawing
// plugin chokes on it. Pure, unit-tested; the file-format rules mirror the
// excalidraw-diagram skill spec (see docs/improvement-proposal.md §1.3).

/**
 * Fields the Excalidraw parsers reject or mis-handle when LLMs invent them.
 * Keep this list minimal and evidence-based: `frameId` (frame membership),
 * `index` (fractional index = z-order) and `versionNonce` are fields Excalidraw
 * itself writes, so stripping them corrupted real drawings.
 */
const FORBIDDEN_FIELDS = ["rawText"];

/** True when a note's content is an Obsidian Excalidraw document. */
export function isExcalidrawDoc(content: string): boolean {
  return /^---\r?\n[\s\S]*?excalidraw-plugin:\s*parsed[\s\S]*?\r?\n---/.test(
    content.slice(0, 500)
  );
}

/** Repair one raw element object in place semantics; returns what changed. */
export function repairExcalidrawElement(
  element: Record<string, unknown>
): { changed: boolean } {
  let changed = false;
  for (const field of FORBIDDEN_FIELDS) {
    if (field in element) {
      delete element[field];
      changed = true;
    }
  }
  // `boundElements` must be null (not []) and `updated` must be 1 (not a
  // timestamp) for excalidraw.com compatibility. Only flag `changed` when the
  // value really moves — a non-empty array is already valid, and claiming a
  // repair on it made every sanitize pass rewrite the file.
  if ("boundElements" in element && element.boundElements !== null) {
    const bound = element.boundElements;
    const next = Array.isArray(bound) && bound.length > 0 ? bound : null;
    if (next !== bound) {
      element.boundElements = next;
      changed = true;
    }
  }
  if ("updated" in element && element.updated !== 1) {
    element.updated = 1;
    changed = true;
  }
  if (typeof element.id !== "string" || !element.id) {
    element.id = `el-${Math.random().toString(36).slice(2, 10)}`;
    changed = true;
  }
  // Text elements need the handwritten family + a sane line height to render
  // like the skill's design spec intends.
  if (element.type === "text") {
    if (element.fontFamily !== 5) {
      element.fontFamily = 5;
      changed = true;
    }
    if (element.lineHeight !== 1.25) {
      element.lineHeight = 1.25;
      changed = true;
    }
    if (typeof element.text === "string" && typeof element.originalText !== "string") {
      element.originalText = element.text;
      changed = true;
    }
  }
  return { changed };
}

/**
 * Sanitize a whole Excalidraw note: locate the JSON drawing block inside the
 * `%%` fence, repair its elements, and splice the repaired JSON back in.
 * Returns null when the note has no parseable drawing block (leave it alone —
 * the Excalidraw plugin may store compressed data we must not touch).
 */
export function sanitizeExcalidrawDoc(
  content: string
): { content: string; repaired: boolean } | null {
  const fence = locateJsonBlock(content);
  if (!fence) return null;
  let data: unknown;
  try {
    data = JSON.parse(fence.json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const doc = data as Record<string, unknown>;
  const elements = doc.elements;
  if (!Array.isArray(elements)) return null;
  let changed = false;
  for (const element of elements) {
    if (element && typeof element === "object") {
      const { changed: elementChanged } = repairExcalidrawElement(
        element as Record<string, unknown>
      );
      if (elementChanged) changed = true;
    }
  }
  if (!changed) return { content, repaired: false };
  // Keep the trailing newline the original block had, or the closing fence
  // glues onto the last JSON line and breaks the code block.
  const rebuilt = `${JSON.stringify(doc, null, 2)}\n`;
  const next =
    content.slice(0, fence.start) + rebuilt + content.slice(fence.end);
  // Last line of defence against a write-event-write loop: a repair that ends up
  // byte-identical is not a repair, however the flags above were set.
  if (next === content) return { content, repaired: false };
  return { content: next, repaired: true };
}

/**
 * Position of the ```json drawing block. The drawing lives in the `%%` data
 * region at the document tail; everything before the first `%%` marker is
 * user-rendered Markdown and may contain ```json blocks of its own — never
 * touch those.
 */
function locateJsonBlock(
  content: string
): { start: number; end: number; json: string } | null {
  const dataRegion = content.indexOf("%%");
  if (dataRegion < 0) return null;
  const openFence = content.indexOf("```json", dataRegion);
  if (openFence < 0) return null;
  const start = content.indexOf("\n", openFence);
  if (start < 0) return null;
  const end = content.indexOf("```", start + 1);
  if (end < 0) return null;
  return { start: start + 1, end, json: content.slice(start + 1, end) };
}
