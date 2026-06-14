import { describe, expect, it } from "vitest";
import {
  buildLibrarySnapshot,
  parseLibraryCache,
  serializeLibraryCache
} from "../src/library-index.js";
import { serializeAnnotation } from "../src/markdown/annotation-file.js";
import { serializeMemoryCell } from "../src/markdown/memory-cell-file.js";
import { serializeProfile } from "../src/markdown/profile-file.js";
import { serializeScene } from "../src/markdown/scene-file.js";
import type {
  Annotation,
  LearnerProfile,
  MemoryCell,
  Scene
} from "../src/model.js";

const annotation: Annotation = {
  id: "ANN-20260607-001",
  sourceFile: "Papers/Attention.md",
  anchor: { blockId: "ann-20260607-001", selectedText: "attention" },
  anchorOrigin: "generated",
  userNote: "My note",
  status: "saved",
  concepts: ["Attention"],
  relatedMemoryCells: ["CELL-20260607-001"],
  createdAt: "2026-06-07T10:00:00.000Z",
  updatedAt: "2026-06-07T10:00:00.000Z"
};

const cell: MemoryCell = {
  id: "CELL-20260607-001",
  type: "understanding",
  concept: "Attention",
  status: "stable",
  summary: "The learner understands attention.",
  sourceAnnotations: [annotation.id],
  tags: ["transformer"],
  confidence: 0.9,
  createdAt: "2026-06-07T10:00:00.000Z",
  updatedAt: "2026-06-07T10:00:00.000Z"
};

const scene: Scene = {
  id: "SCENE-transformers",
  type: "topic",
  title: "Transformers",
  status: "active",
  summary: "Transformer learning.",
  cells: [cell.id],
  tags: ["transformer"],
  createdAt: "2026-06-07T10:00:00.000Z",
  updatedAt: "2026-06-07T10:00:00.000Z"
};

const profile: LearnerProfile = {
  id: "learner-profile",
  kind: "learner-profile",
  title: "Learner Profile",
  status: "active",
  summary: "Auditable learner profile.",
  claims: [
    {
      statement: "Benefits from examples.",
      evidence: [cell.id, scene.id]
    }
  ],
  tags: [],
  updatedAt: "2026-06-07T10:00:00.000Z"
};

describe("memory library index", () => {
  it("builds all library records and derives scene source annotations", () => {
    const snapshot = buildLibrarySnapshot({
      annotations: [
        {
          path: `Agent Memory/annotations/${annotation.id}.md`,
          content: serializeAnnotation(annotation)
        }
      ],
      cells: [
        {
          path: `Agent Memory/memory-cells/${cell.id}.md`,
          content: serializeMemoryCell(cell)
        }
      ],
      scenes: [
        {
          path: `Agent Memory/scenes/${scene.id}.md`,
          content: serializeScene(scene)
        }
      ],
      profiles: [
        {
          path: "Agent Memory/profiles/learner-profile.md",
          content: serializeProfile(profile)
        }
      ],
      proposals: []
    });

    expect(snapshot.annotations).toHaveLength(1);
    expect(snapshot.cells[0]?.sceneIds).toEqual([scene.id]);
    expect(snapshot.scenes[0]?.sourceAnnotations).toEqual([annotation.id]);
    expect(snapshot.profiles).toEqual([profile]);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("keeps malformed files out of the active index and reports them", () => {
    const snapshot = buildLibrarySnapshot({
      annotations: [],
      cells: [{ path: "Agent Memory/memory-cells/broken.md", content: "bad" }],
      scenes: [],
      profiles: [],
      proposals: []
    });
    expect(snapshot.cells).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      {
        path: "Agent Memory/memory-cells/broken.md",
        kind: "memory-cell",
        message: "Invalid memory-cell Markdown"
      }
    ]);
  });

  it("retains the last valid record when an agent temporarily writes malformed Markdown", () => {
    const valid = buildLibrarySnapshot({
      annotations: [],
      cells: [
        {
          path: `Agent Memory/memory-cells/${cell.id}.md`,
          content: serializeMemoryCell(cell)
        }
      ],
      scenes: [],
      profiles: [],
      proposals: []
    });
    const reconciled = buildLibrarySnapshot(
      {
        annotations: [],
        cells: [
          {
            path: `Agent Memory/memory-cells/${cell.id}.md`,
            content: "partially written"
          }
        ],
        scenes: [],
        profiles: [],
        proposals: []
      },
      valid
    );
    expect(reconciled.cells[0]?.id).toBe(cell.id);
    expect(reconciled.diagnostics).toHaveLength(1);
    expect(reconciled.files[`Agent Memory/memory-cells/${cell.id}.md`]).toBe(
      valid.files[`Agent Memory/memory-cells/${cell.id}.md`]
    );
  });

  it("round-trips a V2 cache and ignores corrupted cache input", () => {
    const snapshot = buildLibrarySnapshot({
      annotations: [],
      cells: [],
      scenes: [],
      profiles: [],
      proposals: []
    });
    expect(parseLibraryCache(serializeLibraryCache(snapshot))).toEqual(snapshot);
    expect(parseLibraryCache("not json")).toBeNull();
    expect(parseLibraryCache('{"version":1}')).toBeNull();
  });

  it("excludes a learner-profile claim whose evidence is not in the library", () => {
    const snapshot = buildLibrarySnapshot({
      annotations: [],
      cells: [],
      scenes: [],
      profiles: [
        {
          path: "Agent Memory/profiles/learner-profile.md",
          content: serializeProfile(profile)
        }
      ],
      proposals: []
    });
    expect(snapshot.profiles).toEqual([]);
    expect(snapshot.diagnostics[0]?.message).toBe(
      "Profile evidence does not exist in the memory library"
    );
    expect(snapshot.diagnostics[0]?.recoverable).toBe(false);
  });
});
