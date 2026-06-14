import { describe, expect, it } from "vitest";
import {
  parseMemoryCellFile,
  serializeMemoryCell
} from "../src/markdown/memory-cell-file.js";
import {
  parseSceneFile,
  serializeScene
} from "../src/markdown/scene-file.js";
import {
  parseProfileFile,
  serializeProfile
} from "../src/markdown/profile-file.js";
import type { LearnerProfile, MemoryCell, Scene } from "../src/model.js";

const cell: MemoryCell = {
  id: "CELL-20260607-001",
  type: "misconception",
  concept: "Query and Key",
  status: "needs_review",
  summary: "The learner still mixes up Query and Key.",
  sourceAnnotations: ["ANN-20260606-001"],
  tags: ["transformer"],
  confidence: 0.85,
  agentGuidance: "Ask for a retrieval analogy.",
  createdAt: "2026-06-07T10:00:00.000Z",
  updatedAt: "2026-06-07T10:00:00.000Z"
};

describe("memory library markdown", () => {
  it("round-trips a YAML V2 memory cell with evidence links", () => {
    const markdown = serializeMemoryCell(cell, "Agent Memory");
    expect(markdown).toContain("kind: memory-cell");
    expect(markdown).toContain(
      "[[Agent Memory/annotations/ANN-20260606-001|ANN-20260606-001]]"
    );
    expect(parseMemoryCellFile(markdown)).toEqual(cell);
  });

  it("rejects a memory cell without annotation evidence", () => {
    const markdown = serializeMemoryCell(
      { ...cell, sourceAnnotations: [] },
      "Agent Memory"
    );
    expect(parseMemoryCellFile(markdown)).toBeNull();
  });

  it("round-trips a scene whose cells are Obsidian links", () => {
    const scene: Scene = {
      id: "SCENE-transformer-learning",
      type: "topic",
      title: "Transformer Learning",
      status: "active",
      summary: "Learning context for transformer concepts.",
      cells: ["CELL-20260607-001"],
      tags: ["transformer"],
      createdAt: "2026-06-07T10:00:00.000Z",
      updatedAt: "2026-06-07T10:00:00.000Z"
    };
    const markdown = serializeScene(scene, "Agent Memory");
    expect(markdown).toContain(
      "[[Agent Memory/memory-cells/CELL-20260607-001|CELL-20260607-001]]"
    );
    expect(parseSceneFile(markdown)).toEqual(scene);
  });

  it("requires two evidence links for every learner-profile claim", () => {
    const profile: LearnerProfile = {
      id: "learner-profile",
      kind: "learner-profile",
      title: "Learner Profile",
      status: "active",
      summary: "An auditable view of the learner.",
      claims: [
        {
          statement: "The learner benefits from analogy-first explanations.",
          evidence: ["CELL-20260607-001", "SCENE-transformer-learning"]
        }
      ],
      tags: ["learning"],
      updatedAt: "2026-06-07T10:00:00.000Z"
    };
    const markdown = serializeProfile(profile, "Agent Memory");
    expect(parseProfileFile(markdown)).toEqual(profile);

    const invalid = serializeProfile(
      {
        ...profile,
        claims: [{ statement: "Unsupported claim.", evidence: ["CELL-1"] }]
      },
      "Agent Memory"
    );
    expect(parseProfileFile(invalid)).toBeNull();
  });
});
