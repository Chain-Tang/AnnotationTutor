// Derive higher-level memory structures from cells. Pure (no Obsidian), so it is
// unit-testable; the store writes the resulting scene files.

import type { MemoryCell, Scene } from "./model.js";

/**
 * Group memory cells into scenes by shared concept: a scene per concept that has
 * two or more cells (a single cell needs no grouping). Deterministic given the
 * cells + timestamp. Generated scenes carry the `auto` tag so the store can tell
 * them apart from any hand-authored scene.
 */
export function deriveScenes(cells: MemoryCell[], generatedAt: string): Scene[] {
  const byKey = new Map<string, { title: string; cells: MemoryCell[] }>();
  for (const cell of cells) {
    const concept = cell.concept.trim();
    if (!concept) continue;
    const key = conceptKey(concept);
    if (!key) continue;
    const group = byKey.get(key);
    if (group) group.cells.push(cell);
    else byKey.set(key, { title: concept, cells: [cell] });
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.cells.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({
      id: `SCENE-${slug(group.title)}`,
      type: "topic" as const,
      title: group.title,
      status: "active" as const,
      summary: `Auto-grouped from ${group.cells.length} memory cells about ${group.title}.`,
      cells: group.cells.map((cell) => cell.id).sort(),
      tags: ["auto"],
      createdAt: generatedAt,
      updatedAt: generatedAt
    }));
}

/**
 * A case- and punctuation-insensitive grouping key, so cells whose concepts differ
 * only by capitalization or stray punctuation ("Projection", "projection.") still
 * land in one scene. Empty when the concept has no letters or digits.
 */
function conceptKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A scene-id-safe slug (matches the schema's ^SCENE-[A-Za-z0-9_-]+$). */
function slug(value: string): string {
  const out = value
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return out || "topic";
}

/**
 * The scene id for a hand-authored scene with the given title, using the same
 * slug rule as the auto-derived scenes so manual and derived ids never diverge.
 */
export function sceneIdFromTitle(title: string): string {
  return `SCENE-${slug(title.trim())}`;
}
