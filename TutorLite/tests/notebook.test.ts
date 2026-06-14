import { describe, expect, it } from "vitest";
import { buildNotebook } from "../src/markdown/notebook.js";
import type { IndexRecord } from "../src/model.js";

function record(overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    annotationId: "ANN-1",
    memoryFile: "Agent Memory/annotations/ANN-1.md",
    sourceFile: "Papers/Attention.md",
    anchor: "^ann-1",
    anchorOrigin: "generated",
    selectedText: "Multi-head attention",
    status: "reviewed",
    concepts: ["Attention", "ML"],
    relatedMemoryCells: [],
    createdAt: "2026-06-06T10:00:00.000Z",
    updatedAt: "2026-06-06T10:00:00.000Z",
    ...overrides
  };
}

const options = { memoryRoot: "Agent Memory", generatedAt: "2026-06-06T12:00:00.000Z" };

const records: IndexRecord[] = [
  record({
    annotationId: "ANN-1",
    anchor: "^ann-1",
    userNote: "Attention attends to several positions.",
    dialogue: [
      { role: "user", text: "Why several heads?", at: "2026-06-06T11:00:00.000Z" },
      { role: "agent", text: "Each head learns a different subspace.", at: "2026-06-06T11:00:05.000Z" }
    ]
  }),
  record({
    annotationId: "ANN-2",
    anchor: "^ann-2",
    selectedText: "Scaled dot-product attention",
    concepts: ["Attention"],
    createdAt: "2026-06-06T10:05:00.000Z"
  }),
  record({
    annotationId: "ANN-3",
    sourceFile: "Papers/RNN.md",
    anchor: "^ann-3",
    selectedText: "Recurrent networks process sequences",
    concepts: ["ML", "Sequence"],
    userNote: "RNNs keep a hidden state."
  })
];

describe("buildNotebook", () => {
  it("creates an index, a page per studied document, and concept chapters", () => {
    const files = buildNotebook(records, options);
    const paths = files.map((file) => file.path);
    expect(paths).toContain("Agent Memory/Notebook/Notebook.md");
    expect(paths).toContain("Agent Memory/Notebook/pages/Papers-Attention.md");
    expect(paths).toContain("Agent Memory/Notebook/pages/Papers-RNN.md");
    // "ML" is shared by both documents → a chapter; single-doc concepts are not.
    expect(paths).toContain("Agent Memory/Notebook/chapters/ML.md");
    expect(paths).not.toContain("Agent Memory/Notebook/chapters/Sequence.md");
    expect(paths).not.toContain("Agent Memory/Notebook/chapters/Attention.md");
  });

  it("indexes chapters and pages in the entry point", () => {
    const index = byPath(buildNotebook(records, options), "Agent Memory/Notebook/Notebook.md");
    expect(index).toContain("# Notebook");
    expect(index).toContain("[[Agent Memory/Notebook/chapters/ML|ML]] — 2 documents");
    expect(index).toContain("[[Agent Memory/Notebook/pages/Papers-Attention|Attention]]");
    expect(index).toContain("[[Agent Memory/Notebook/pages/Papers-RNN|RNN]]");
  });

  it("builds a page with context, original-text index, annotations, and dialogue", () => {
    const page = byPath(buildNotebook(records, options), "Agent Memory/Notebook/pages/Papers-Attention.md");
    expect(page).toContain("## Document context");
    expect(page).toContain("- Source: [[Papers/Attention|Attention]]");
    expect(page).toContain("## Original text index");
    // Block-reference link back into the source note.
    expect(page).toContain("[[Papers/Attention#^ann-1|Multi-head attention]]");
    expect(page).toContain("## Annotation content");
    expect(page).toContain("### ANN-1");
    expect(page).toContain("**Note:** Attention attends to several positions.");
    expect(page).toContain("## Dialogue context");
    expect(page).toContain("**You:** Why several heads?");
    expect(page).toContain("**Tutor:** Each head learns a different subspace.");
  });

  it("omits the dialogue section on pages without any dialogue", () => {
    const page = byPath(buildNotebook(records, options), "Agent Memory/Notebook/pages/Papers-RNN.md");
    expect(page).not.toContain("## Dialogue context");
  });

  it("lists member documents in a chapter", () => {
    const chapter = byPath(buildNotebook(records, options), "Agent Memory/Notebook/chapters/ML.md");
    expect(chapter).toContain("# ML");
    expect(chapter).toContain("[[Agent Memory/Notebook/pages/Papers-Attention|Attention]]");
    expect(chapter).toContain("[[Agent Memory/Notebook/pages/Papers-RNN|RNN]]");
  });

  it("includes an agent synthesis when provided", () => {
    const synthesis = new Map([["Papers/Attention.md", "You explored attention deeply."]]);
    const page = byPath(
      buildNotebook(records, { ...options, synthesis }),
      "Agent Memory/Notebook/pages/Papers-Attention.md"
    );
    expect(page).toContain("## Synthesis");
    expect(page).toContain("You explored attention deeply.");
  });

  it("is deterministic for identical inputs", () => {
    expect(buildNotebook(records, options)).toEqual(buildNotebook(records, options));
  });

  it("still produces an index when there are no annotations", () => {
    const files = buildNotebook([], options);
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain("No studied documents yet.");
  });
});

function byPath(files: { path: string; content: string }[], path: string): string {
  const file = files.find((item) => item.path === path);
  if (!file) throw new Error(`missing notebook file: ${path}`);
  return file.content;
}
