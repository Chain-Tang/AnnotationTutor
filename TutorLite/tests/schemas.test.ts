import { describe, expect, it } from "vitest";
import {
  cellTypeSchema,
  memoryCellSchema,
  sceneTypeSchema
} from "../src/schemas.js";

describe("memory schemas", () => {
  it("uses controlled types while allowing free-form tags", () => {
    expect(cellTypeSchema.safeParse("misconception").success).toBe(true);
    expect(cellTypeSchema.safeParse("favorite_color").success).toBe(false);
    expect(sceneTypeSchema.safeParse("course").success).toBe(true);
    expect(sceneTypeSchema.safeParse("conversation").success).toBe(false);

    const result = memoryCellSchema.safeParse({
      id: "CELL-20260607-001",
      type: "understanding",
      concept: "Attention",
      status: "stable",
      summary: "Understands scaled dot-product attention.",
      sourceAnnotations: ["ANN-20260607-001"],
      tags: ["custom-tag"],
      confidence: 0.9,
      createdAt: "2026-06-07T10:00:00.000Z",
      updatedAt: "2026-06-07T10:00:00.000Z"
    });
    expect(result.success).toBe(true);
  });
});
