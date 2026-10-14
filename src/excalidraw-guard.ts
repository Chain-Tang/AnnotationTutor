// Guardrail for agent-generated Excalidraw notes. The plugin never draws the
// diagram itself — the Obsidian Excalidraw plugin renders any note carrying
// the `excalidraw-plugin: parsed` frontmatter — but LLM output drifts from the
// format spec (extra fields, `[]` where `null` is required, timestamps). This
// module detects such notes and repairs the element JSON before the drawing
// plugin chokes on it. Pure, unit-tested; the file-format rules mirror the
// excalidraw-diagram skill spec (see docs/improvement-proposal.md §1.3).

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
  // Preserve native bindings, timestamps, typography and extension fields.
  // Only repair values that are demonstrably invalid, never valid user styles.
  if ("boundElements" in element && element.boundElements !== null && !Array.isArray(element.boundElements)) {
    element.boundElements = null; changed = true;
  }
  if (typeof element.id !== "string" || !element.id) {
    element.id = `el-${Math.random().toString(36).slice(2, 10)}`;
    changed = true;
  }
  // Missing typography gets defaults; existing typography is user-owned.
  if (element.type === "text") {
    if (typeof element.fontFamily !== "number" || !Number.isFinite(element.fontFamily) || element.fontFamily <= 0) {
      element.fontFamily = 5;
      changed = true;
    }
    if (typeof element.lineHeight !== "number" || !Number.isFinite(element.lineHeight) || element.lineHeight <= 0) {
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
