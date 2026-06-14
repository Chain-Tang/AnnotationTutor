import { describe, expect, it } from "vitest";
import {
  shouldRemoveAnnotationBlockId,
  validateProposalCandidate
} from "../src/memory-policy.js";
import { serializeProfile } from "../src/markdown/profile-file.js";
import { serializeScene } from "../src/markdown/scene-file.js";
import type {
  IndexRecord,
  LearnerProfile,
  MemoryProposal,
  Scene
} from "../src/model.js";

function record(
  id: string,
  anchorOrigin: "generated" | "existing" | "legacy",
  anchor = "^shared"
): IndexRecord {
  return {
    annotationId: id,
    memoryFile: `Agent Memory/annotations/${id}.md`,
    sourceFile: "Source.md",
    anchor,
    anchorOrigin,
    selectedText: "text",
    status: "saved",
    concepts: [],
    relatedMemoryCells: [],
    createdAt: "2026-06-07T10:00:00.000Z",
    updatedAt: "2026-06-07T10:00:00.000Z"
  };
}

describe("memory policy", () => {
  it("removes only the last plugin-generated block id", () => {
    const generated = record("ANN-1", "generated");
    expect(shouldRemoveAnnotationBlockId(generated, [generated])).toBe(true);
    expect(
      shouldRemoveAnnotationBlockId(generated, [
        generated,
        record("ANN-2", "generated")
      ])
    ).toBe(false);
    expect(
      shouldRemoveAnnotationBlockId(record("ANN-1", "existing"), [
        record("ANN-1", "existing")
      ])
    ).toBe(false);
    expect(
      shouldRemoveAnnotationBlockId(record("ANN-1", "legacy"), [
        record("ANN-1", "legacy")
      ])
    ).toBe(false);
  });

  it("validates a proposal candidate against its declared target kind", () => {
    const scene: Scene = {
      id: "SCENE-transformer",
      type: "topic",
      title: "Transformer",
      status: "active",
      summary: "A scene.",
      cells: [],
      tags: [],
      createdAt: "2026-06-07T10:00:00.000Z",
      updatedAt: "2026-06-07T10:00:00.000Z"
    };
    const proposal: MemoryProposal = {
      id: "PROP-1",
      operation: "create",
      targetKind: "scene",
      targetPath: "scenes/SCENE-transformer.md",
      status: "pending",
      candidate: serializeScene(scene),
      createdAt: "2026-06-07T10:00:00.000Z"
    };
    expect(validateProposalCandidate(proposal, false).ok).toBe(true);
    expect(
      validateProposalCandidate(
        { ...proposal, targetKind: "memory-cell" },
        false
    ).ok
    ).toBe(false);
  });

  it("rejects profile proposals whose evidence is absent from the library", () => {
    const profile: LearnerProfile = {
      id: "learner-profile",
      kind: "learner-profile",
      title: "Learner Profile",
      status: "active",
      summary: "Profile.",
      claims: [
        {
          statement: "Needs examples.",
          evidence: ["CELL-1", "SCENE-1"]
        }
      ],
      tags: [],
      updatedAt: "2026-06-07T10:00:00.000Z"
    };
    const proposal: MemoryProposal = {
      id: "PROP-3",
      operation: "update",
      targetKind: "learner-profile",
      targetPath: "profiles/learner-profile.md",
      status: "pending",
      candidate: serializeProfile(profile),
      createdAt: "2026-06-07T10:00:00.000Z"
    };
    expect(
      validateProposalCandidate(proposal, false, new Set(["CELL-1"]))
    ).toEqual({
      ok: false,
      message: "Profile evidence does not exist in the memory library"
    });
    expect(
      validateProposalCandidate(
        proposal,
        false,
        new Set(["CELL-1", "SCENE-1"])
      ).ok
    ).toBe(true);
  });

  it("rejects preferences proposals while preference writes are disabled", () => {
    const preferences: LearnerProfile = {
      id: "preferences",
      kind: "preferences",
      title: "Preferences",
      status: "active",
      summary: "Optional preferences.",
      claims: [{ statement: "Uses Chinese.", evidence: ["CELL-1"] }],
      tags: [],
      updatedAt: "2026-06-07T10:00:00.000Z"
    };
    const proposal: MemoryProposal = {
      id: "PROP-2",
      operation: "create",
      targetKind: "preferences",
      targetPath: "profiles/preferences.md",
      status: "pending",
      candidate: serializeProfile(preferences),
      createdAt: "2026-06-07T10:00:00.000Z"
    };
    expect(validateProposalCandidate(proposal, false)).toEqual({
      ok: false,
      message: "Preference memory writes are disabled"
    });
    expect(validateProposalCandidate(proposal, true).ok).toBe(true);
  });
});
