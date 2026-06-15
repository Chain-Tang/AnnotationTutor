// Classify memory cells into the learner's strengths, weaknesses, and
// problem-solving methods, from the fields cells already carry (type / status /
// confidence). Pure (only a type import) so it is unit-testable and reused by the
// notebook's learner summary and the opt-in weakness-training command.

import type { MemoryCell } from "./model.js";

export type LearningClassification = {
  strengths: MemoryCell[];
  weaknesses: MemoryCell[];
  methods: MemoryCell[];
};

/** A cell that signals solid understanding. */
export function isStrength(cell: MemoryCell): boolean {
  return (
    cell.type === "understanding" ||
    cell.type === "strategy" ||
    cell.status === "stable" ||
    cell.confidence >= 0.8
  );
}

/** A cell that signals a gap to revisit. */
export function isWeakness(cell: MemoryCell): boolean {
  return (
    cell.type === "misconception" ||
    cell.type === "difficulty" ||
    cell.status === "needs_review" ||
    cell.confidence < 0.5
  );
}

/**
 * Split cells into strengths / weaknesses / methods. Weakness takes priority over
 * strength when a cell matches both (gaps deserve attention first); `methods`
 * cross-cuts (every `strategy` cell). Each list is deterministically sorted.
 */
export function classifyCells(cells: MemoryCell[]): LearningClassification {
  const strengths: MemoryCell[] = [];
  const weaknesses: MemoryCell[] = [];
  const methods: MemoryCell[] = [];
  for (const cell of cells) {
    if (cell.type === "strategy") methods.push(cell);
    if (isWeakness(cell)) weaknesses.push(cell);
    else if (isStrength(cell)) strengths.push(cell);
  }
  // Weakest first for weaknesses; strongest first for strengths; newest methods first.
  weaknesses.sort((a, b) => a.confidence - b.confidence || a.id.localeCompare(b.id));
  strengths.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  methods.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { strengths, weaknesses, methods };
}
