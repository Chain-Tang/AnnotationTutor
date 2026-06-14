// Identifier helpers. Pure (no Obsidian), so they can be unit tested.
//
// IDs follow the spec convention `PREFIX-YYYYMMDD-NNN` (e.g. ANN-20260606-001).
// The daily sequence number is derived from existing IDs so the plugin never
// needs a persistent counter.

export type IdPrefix = "ANN" | "MEM" | "TASK";

export function dateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function nextSequence(
  existingIds: Iterable<string>,
  prefix: IdPrefix,
  stamp: string
): number {
  const pattern = new RegExp(`^${prefix}-${stamp}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const match = pattern.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

export function makeId(
  prefix: IdPrefix,
  existingIds: Iterable<string>,
  date = new Date()
): string {
  const stamp = dateStamp(date);
  const sequence = nextSequence(existingIds, prefix, stamp);
  return `${prefix}-${stamp}-${String(sequence).padStart(3, "0")}`;
}

/** Block id (no caret) for an annotation, e.g. ANN-20260606-001 -> ann-20260606-001. */
export function blockIdForAnnotation(annotationId: string): string {
  return annotationId.toLowerCase();
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}
