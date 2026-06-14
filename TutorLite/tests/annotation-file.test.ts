import { describe, expect, it } from "vitest";
import {
  parseAnnotationFile,
  serializeAnnotation,
  updateAnnotationMarkdown
} from "../src/markdown/annotation-file.js";
import type { Annotation } from "../src/model.js";

function sample(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ANN-20260606-001",
    sourceFile: "Papers/Attention.md",
    anchor: {
      blockId: "ann-20260606-001",
      selectedText: "Multi-head attention"
    },
    userNote: "My understanding of the idea.",
    status: "saved",
    concepts: ["Attention"],
    relatedMemoryCells: [],
    createdAt: "2026-06-06T10:00:00.000Z",
    updatedAt: "2026-06-06T10:00:00.000Z",
    ...overrides
  };
}

const AGENT_REVIEW = [
  "- Correctness: partially_correct",
  "- Summary: Good start but incomplete.",
  "- Strengths:",
  "  - Names the core idea",
  "- Weaknesses:",
  "  - Misses learned projections"
].join("\n");

describe("annotation file", () => {
  it("round-trips the plugin-owned fields", () => {
    const serialized = serializeAnnotation(sample());
    expect(serialized).toMatch(/^---\nschema: 2\nkind: annotation\n/);
    expect(serialized).toContain("anchor_origin: generated");
    const parsed = parseAnnotationFile(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe("ANN-20260606-001");
    expect(parsed?.sourceFile).toBe("Papers/Attention.md");
    expect(parsed?.anchor.blockId).toBe("ann-20260606-001");
    expect(parsed?.anchor.selectedText).toBe("Multi-head attention");
    expect(parsed?.userNote).toBe("My understanding of the idea.");
    expect(parsed?.concepts).toEqual(["Attention"]);
    expect(parsed?.status).toBe("saved");
  });

  it("serialization is idempotent", () => {
    const once = serializeAnnotation(sample());
    const twice = serializeAnnotation(parseAnnotationFile(once)!);
    expect(twice).toBe(once);
  });

  it("preserves an agent review when the plugin updates the note", () => {
    const withReview = serializeAnnotation(sample()).replace(
      "_No review yet._",
      AGENT_REVIEW
    );
    const updated = updateAnnotationMarkdown(withReview, {
      userNote: "Revised understanding."
    });
    expect(updated).not.toBeNull();
    const parsed = parseAnnotationFile(updated!);
    expect(parsed?.userNote).toBe("Revised understanding.");
    expect(parsed?.reviewText).toContain("Misses learned projections");
    expect(parsed?.status).toBe("reviewed");
    expect(parsed?.review?.correctness).toBe("partially_correct");
  });

  it("marks an unparseable review as reviewed_unstructured", () => {
    const withReview = serializeAnnotation(sample()).replace(
      "_No review yet._",
      "looks mostly fine to me"
    );
    const parsed = parseAnnotationFile(withReview);
    expect(parsed?.status).toBe("reviewed_unstructured");
    expect(parsed?.review).toBeUndefined();
    expect(parsed?.reviewText).toContain("looks mostly fine");
  });

  it("returns null when updating non-annotation markdown", () => {
    expect(updateAnnotationMarkdown("not an annotation", { status: "archived" })).toBeNull();
  });

  it("round-trips dialogue turns through the ## Dialogue section", () => {
    const withDialogue = sample({
      dialogue: [
        { role: "user", text: "Why does this matter?", at: "2026-06-06T11:00:00.000Z" },
        {
          role: "agent",
          text: "Because it lets the model attend to several positions at once.\n\nWant an example?",
          at: "2026-06-06T11:00:05.000Z"
        }
      ]
    });
    const serialized = serializeAnnotation(withDialogue);
    expect(serialized).toContain("## Dialogue");
    expect(serialized).toContain("### You — 2026-06-06T11:00:00.000Z");
    expect(serialized).toContain("### Tutor — 2026-06-06T11:00:05.000Z");

    const parsed = parseAnnotationFile(serialized);
    expect(parsed?.dialogue).toHaveLength(2);
    expect(parsed?.dialogue?.[0]).toMatchObject({
      role: "user",
      text: "Why does this matter?"
    });
    expect(parsed?.dialogue?.[1]?.role).toBe("agent");
    // The blank line inside the multi-paragraph agent turn survives the round trip.
    expect(parsed?.dialogue?.[1]?.text).toBe(
      "Because it lets the model attend to several positions at once.\n\nWant an example?"
    );
    // Idempotent serialize → parse → serialize.
    expect(serializeAnnotation(parsed!)).toBe(serialized);
  });

  it("preserves dialogue when the plugin patches the note", () => {
    const withDialogue = serializeAnnotation(
      sample({
        dialogue: [{ role: "user", text: "Quick question", at: "2026-06-06T11:00:00.000Z" }]
      })
    );
    const updated = updateAnnotationMarkdown(withDialogue, {
      userNote: "Edited note."
    });
    const parsed = parseAnnotationFile(updated!);
    expect(parsed?.userNote).toBe("Edited note.");
    expect(parsed?.dialogue).toHaveLength(1);
    expect(parsed?.dialogue?.[0]?.text).toBe("Quick question");
  });

  it("omits the Dialogue section when there are no turns", () => {
    expect(serializeAnnotation(sample())).not.toContain("## Dialogue");
  });

  it("reads the legacy sentinel format and upgrades it on edit", () => {
    const legacy = [
      "<!-- annotation-tutor:annotation:start ANN-20260606-001 -->",
      "",
      "## ANN-20260606-001",
      "- Source file: `Papers/Attention.md`",
      "- Anchor: `^ann-20260606-001`",
      "- Status: saved",
      "- Concepts: Attention",
      "- Created at: 2026-06-06T10:00:00.000Z",
      "- Updated at: 2026-06-06T10:00:00.000Z",
      "- Related memory cells: None",
      "",
      "### Selected Text",
      "",
      "> Multi-head attention",
      "",
      "### User Note",
      "",
      "> My understanding.",
      "",
      "### Agent Review",
      "",
      AGENT_REVIEW,
      "",
      "### Review History",
      "",
      "<!-- annotation-tutor:annotation:end ANN-20260606-001 -->",
      ""
    ].join("\n");

    const parsed = parseAnnotationFile(legacy);
    expect(parsed?.anchorOrigin).toBe("legacy");
    expect(parsed?.reviewText).toContain("Good start");

    const upgraded = updateAnnotationMarkdown(legacy, {
      userNote: "Updated without losing review."
    });
    expect(upgraded).toMatch(/^---\nschema: 2\nkind: annotation\n/);
    expect(upgraded).toContain("Updated without losing review.");
    expect(upgraded).toContain("Good start but incomplete.");
  });
});
