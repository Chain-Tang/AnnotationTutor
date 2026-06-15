import { describe, expect, it } from "vitest";
import { classifyCells, isStrength, isWeakness } from "../src/learning.js";
import type { MemoryCell } from "../src/model.js";

function cell(overrides: Partial<MemoryCell> = {}): MemoryCell {
  return {
    id: "MEM-1",
    type: "understanding",
    concept: "C",
    status: "new",
    summary: "s",
    sourceAnnotations: ["ANN-1"],
    tags: [],
    confidence: 0.6,
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
    ...overrides
  };
}

describe("classifyCells", () => {
  it("routes misconceptions/low-confidence to weaknesses, understanding to strengths", () => {
    const cells = [
      cell({ id: "MEM-1", type: "understanding", confidence: 0.9 }),
      cell({ id: "MEM-2", type: "misconception", confidence: 0.4 }),
      cell({ id: "MEM-3", type: "understanding", confidence: 0.3 }) // low conf → weakness
    ];
    const { strengths, weaknesses } = classifyCells(cells);
    expect(strengths.map((c) => c.id)).toEqual(["MEM-1"]);
    expect(weaknesses.map((c) => c.id)).toEqual(["MEM-3", "MEM-2"]); // weakest first
  });

  it("collects strategy cells as problem-solving methods", () => {
    const { methods } = classifyCells([
      cell({ id: "MEM-1", type: "strategy", confidence: 0.7 }),
      cell({ id: "MEM-2", type: "understanding" })
    ]);
    expect(methods.map((c) => c.id)).toEqual(["MEM-1"]);
  });

  it("treats stable/high-confidence as strengths and needs_review as weakness", () => {
    expect(isStrength(cell({ status: "stable", confidence: 0.2 }))).toBe(true);
    expect(isWeakness(cell({ status: "needs_review", confidence: 0.9, type: "goal" }))).toBe(true);
  });
});
