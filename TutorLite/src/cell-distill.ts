// Pure helpers for turning a model reply (or a review's correctness) into the
// fields of a memory cell. Extracted from main.ts so they can be unit-tested
// without an Obsidian runtime.

import type { MemoryCell } from "./model.js";

const CELL_TYPES: readonly MemoryCell["type"][] = [
  "understanding",
  "misconception",
  "goal",
  "difficulty",
  "strategy",
  "progress"
];

/** Pull the first JSON object out of a model reply (tolerant of surrounding prose). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[0]);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asCellType(value: unknown): MemoryCell["type"] {
  return CELL_TYPES.includes(value as MemoryCell["type"])
    ? (value as MemoryCell["type"])
    : "understanding";
}

export function asConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.6;
}

/** Map a review's correctness to the kind of memory cell it implies. */
export function cellTypeForCorrectness(correctness: string | undefined): MemoryCell["type"] {
  if (correctness === "incorrect") return "misconception";
  if (correctness === "uncertain") return "difficulty";
  return "understanding";
}

/** A starting confidence for an auto cell, from the review's correctness. */
export function confidenceForCorrectness(correctness: string | undefined): number {
  switch (correctness) {
    case "correct":
      return 0.85;
    case "partially_correct":
      return 0.5;
    case "incorrect":
      return 0.3;
    case "uncertain":
      return 0.4;
    default:
      return 0.6;
  }
}
