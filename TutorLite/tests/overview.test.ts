import { describe, expect, it } from "vitest";
import {
  copyablePrompt,
  renderAgentInstructions,
  renderAnnotationIndex,
  renderCellIndex,
  renderOverview,
  renderRecentLearning,
  renderSceneIndex,
  reviewLanguageInstruction
} from "../src/markdown/overview.js";
import type { IndexRecord, MemoryCell, Scene } from "../src/model.js";

const record: IndexRecord = {
  annotationId: "ANN-20260606-001",
  memoryFile: "Agent Memory/annotations/ANN-20260606-001.md",
  sourceFile: "Papers/Attention.md",
  anchor: "^ann-20260606-001",
  anchorOrigin: "generated",
  selectedText: "Multi-head attention",
  status: "agent_requested",
  concepts: ["Attention"],
  relatedMemoryCells: [],
  userNoteSummary: "My note.",
  createdAt: "2026-06-06T10:00:00.000Z",
  updatedAt: "2026-06-06T10:00:00.000Z"
};

const options = { memoryRoot: "Agent Memory", generatedAt: "2026-06-06T12:00:00.000Z" };

describe("overview generation", () => {
  it("renders a deterministic overview with relative links", () => {
    const overview = renderOverview([record], [], options);
    expect(overview).toContain("# Annotation Memory");
    expect(overview).toContain("ANN-20260606-001");
    expect(overview).toContain("`annotations/ANN-20260606-001.md`");
    expect(overview).toContain("- Recently studied:");
    expect(overview).toContain("Updated: 2026-06-06T12:00:00.000Z");
    // Deterministic given identical inputs.
    expect(renderOverview([record], [], options)).toBe(overview);
  });

  it("lists needs-attention items in recent learning", () => {
    const recent = renderRecentLearning([record], options);
    expect(recent).toContain("## Needs Attention");
    expect(recent).toContain("ANN-20260606-001 (agent_requested)");
  });

  it("renders agent instructions referencing the memory root", () => {
    const instructions = renderAgentInstructions({
      memoryRoot: "Agent Memory",
      memoryWriteMode: "confirmation",
      allowPreferenceWrites: false
    });
    expect(instructions).toContain("Agent Memory/annotations/");
    expect(instructions).toContain("Never overwrite");
    expect(instructions).toContain("proposals/pending");
    expect(instructions).toContain("Do not read or update `profiles/preferences.md`");
    // The agent is now told to read the learner profile + recent learning.
    expect(instructions).toContain("Agent Memory/profiles/learner-profile.md");
    expect(instructions).toContain("Agent Memory/recent-learning.md");
  });

  it("builds a copyable per-annotation prompt", () => {
    const prompt = copyablePrompt(record);
    expect(prompt).toContain("ANN-20260606-001");
    expect(prompt).toContain("Agent Review");
    expect(prompt).toContain("`Papers/Attention.md`");
  });

  it("instructs the agent on review language (default: match the note)", () => {
    expect(reviewLanguageInstruction()).toContain(
      "same language as the learner's note"
    );
    expect(reviewLanguageInstruction("Français")).toContain(
      "Write the review content in Français."
    );
    // Labels must stay English so the review parser still recognizes them.
    expect(reviewLanguageInstruction("日本語")).toContain(
      "Keep the field labels and the Correctness value in English"
    );
    // Both the copyable prompt and AGENTS.md carry the rule.
    expect(copyablePrompt(record, "Español")).toContain(
      "Write the review content in Español."
    );
    expect(
      renderAgentInstructions({ memoryRoot: "Agent Memory" })
    ).toContain("same language as the learner's note");
  });

  it("renders rebuildable Obsidian indexes with wikilinks", () => {
    const cell: MemoryCell = {
      id: "CELL-20260607-001",
      type: "understanding",
      concept: "Attention",
      status: "stable",
      summary: "Understands attention.",
      sourceAnnotations: [record.annotationId],
      tags: [],
      confidence: 0.9,
      createdAt: "2026-06-07T10:00:00.000Z",
      updatedAt: "2026-06-07T10:00:00.000Z"
    };
    const scene: Scene = {
      id: "SCENE-transformer",
      type: "topic",
      title: "Transformer",
      status: "active",
      summary: "Transformer study.",
      cells: [cell.id],
      tags: [],
      createdAt: "2026-06-07T10:00:00.000Z",
      updatedAt: "2026-06-07T10:00:00.000Z"
    };
    expect(renderAnnotationIndex([record], options)).toContain(
      "[[Agent Memory/annotations/ANN-20260606-001|ANN-20260606-001]]"
    );
    expect(renderCellIndex([cell], options)).toContain(
      "[[Agent Memory/memory-cells/CELL-20260607-001|Attention]]"
    );
    expect(renderSceneIndex([scene], options)).toContain(
      "[[Agent Memory/scenes/SCENE-transformer|Transformer]]"
    );
  });
});
