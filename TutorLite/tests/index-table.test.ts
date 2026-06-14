import { describe, expect, it } from "vitest";
import {
  buildRecords,
  IndexTable,
  recordFromAnnotation
} from "../src/index-table.js";
import { serializeAnnotation } from "../src/markdown/annotation-file.js";
import type { Annotation } from "../src/model.js";

function sample(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ANN-20260606-001",
    sourceFile: "Papers/Attention.md",
    anchor: {
      blockId: "ann-20260606-001",
      selectedText: "Multi-head attention"
    },
    userNote: "Note text.",
    status: "saved",
    concepts: ["Attention"],
    relatedMemoryCells: [],
    createdAt: "2026-06-06T10:00:00.000Z",
    updatedAt: "2026-06-06T10:00:00.000Z",
    ...overrides
  };
}

describe("index table", () => {
  it("builds records from annotation files and skips unreadable ones", () => {
    const files = [
      {
        path: "Agent Memory/annotations/ANN-20260606-001.md",
        content: serializeAnnotation(sample())
      },
      { path: "Agent Memory/annotations/broken.md", content: "garbage" }
    ];
    const { records, errors } = buildRecords(files);
    expect(records).toHaveLength(1);
    expect(records[0]?.anchor).toBe("^ann-20260606-001");
    expect(errors).toEqual(["Agent Memory/annotations/broken.md"]);
  });

  it("derives a record summary from the annotation", () => {
    const record = recordFromAnnotation(
      sample(),
      "Agent Memory/annotations/ANN-20260606-001.md"
    );
    expect(record.userNoteSummary).toBe("Note text.");
    expect(record.concepts).toEqual(["Attention"]);
  });

  it("queries by status, concept, review state, and text", () => {
    const table = new IndexTable([
      recordFromAnnotation(sample(), "a.md"),
      recordFromAnnotation(
        sample({
          id: "ANN-20260606-002",
          status: "reviewed",
          concepts: ["Transformers"],
          updatedAt: "2026-06-06T11:00:00.000Z"
        }),
        "b.md"
      )
    ]);
    expect(table.query({ status: "reviewed" })).toHaveLength(1);
    expect(table.query({ concept: "Transformers" })).toHaveLength(1);
    expect(table.query({ reviewState: "unreviewed" })).toHaveLength(1);
    expect(table.query({ text: "transformers" })).toHaveLength(1);
    // Sorted by updatedAt desc.
    expect(table.query()[0]?.annotationId).toBe("ANN-20260606-002");
  });

  it("survives a JSON round-trip and tolerates garbage", () => {
    const table = new IndexTable([recordFromAnnotation(sample(), "a.md")]);
    const restored = IndexTable.fromJson(table.toJson());
    expect(restored.all()).toHaveLength(1);
    expect(IndexTable.fromJson("not json").all()).toEqual([]);
  });
});
