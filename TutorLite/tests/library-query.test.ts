import { describe, expect, it } from "vitest";
import { queryCells, queryScenes } from "../src/library-query.js";
import type {
  MemoryCellRecord,
  SceneRecord
} from "../src/library-index.js";

const cell: MemoryCellRecord = {
  id: "CELL-1",
  type: "misconception",
  concept: "Attention",
  status: "needs_review",
  summary: "Confuses Query and Key.",
  sourceAnnotations: ["ANN-1"],
  tags: ["transformer"],
  confidence: 0.8,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  path: "Agent Memory/memory-cells/CELL-1.md",
  sceneIds: ["SCENE-1"]
};

const scene: SceneRecord = {
  id: "SCENE-1",
  type: "topic",
  title: "Transformer",
  status: "active",
  summary: "Transformer study.",
  cells: ["CELL-1"],
  tags: ["paper"],
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  path: "Agent Memory/scenes/SCENE-1.md",
  sourceAnnotations: ["ANN-1"]
};

describe("memory library queries", () => {
  it("filters cells by text, type, status, and tag", () => {
    expect(queryCells([cell], { text: "query" })).toEqual([cell]);
    expect(queryCells([cell], { type: "misconception" })).toEqual([cell]);
    expect(queryCells([cell], { status: "stable" })).toEqual([]);
    expect(queryCells([cell], { tag: "transformer" })).toEqual([cell]);
  });

  it("filters scenes by text, type, status, and tag", () => {
    expect(queryScenes([scene], { text: "transformer" })).toEqual([scene]);
    expect(queryScenes([scene], { type: "topic" })).toEqual([scene]);
    expect(queryScenes([scene], { status: "archived" })).toEqual([]);
    expect(queryScenes([scene], { tag: "paper" })).toEqual([scene]);
  });
});
