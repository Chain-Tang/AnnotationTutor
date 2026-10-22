import { describe, expect, it } from "vitest";
import { deriveScenes, sceneIdFromTitle } from "../src/memory-derive.js";
import { sceneSchema } from "../src/schemas.js";
import { parseSceneFile, serializeScene } from "../src/markdown/scene-file.js";
import type { MemoryCell } from "../src/model.js";

function cell(overrides: Partial<MemoryCell> = {}): MemoryCell {
  return {
    id: "MEM-1",
    type: "understanding",
    concept: "Attention",
    status: "new",
    summary: "Understands attention.",
    sourceAnnotations: ["ANN-1"],
    tags: [],
    confidence: 0.6,
    createdAt: "2026-06-14T10:00:00.000Z",
    updatedAt: "2026-06-14T10:00:00.000Z",
    ...overrides
  };
}

const at = "2026-06-14T12:00:00.000Z";

describe("deriveScenes", () => {
  it.each(["注意力", "学習", "Café", "a".repeat(200)])("persists schema-valid scenes for %s", concept => {
    const scene = deriveScenes([cell({ id: "MEM-1", concept }), cell({ id: "MEM-2", concept })], at)[0]!;
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    expect(scene.id).toBe(sceneIdFromTitle(concept));
    expect(parseSceneFile(serializeScene(scene, "Agent Memory"))).toEqual(scene);
    expect(scene.title).toBe(concept);
  });

  it("uses distinct stable Unicode ids while preserving existing ASCII ids", () => {
    expect(sceneIdFromTitle("Attention")).toBe("SCENE-Attention");
    expect(sceneIdFromTitle("C++ & templates")).toBe("SCENE-C-templates");
    expect(sceneIdFromTitle("注意力")).not.toBe(sceneIdFromTitle("投射"));
    expect(sceneIdFromTitle("投射，")).toBe(sceneIdFromTitle("投射"));
    expect(sceneIdFromTitle("CAFÉ")).toBe(sceneIdFromTitle("cafe\u0301"));
  });

  it("groups two or more cells sharing a concept into one scene", () => {
    const scenes = deriveScenes(
      [
        cell({ id: "MEM-1", concept: "Attention" }),
        cell({ id: "MEM-2", concept: "Attention" }),
        cell({ id: "MEM-3", concept: "Recurrence" }) // lone concept → no scene
      ],
      at
    );
    expect(scenes).toHaveLength(1);
    const scene = scenes[0]!;
    expect(scene.id).toBe("SCENE-Attention");
    expect(scene.title).toBe("Attention");
    expect(scene.type).toBe("topic");
    expect(scene.cells).toEqual(["MEM-1", "MEM-2"]);
    expect(scene.tags).toContain("auto");
  });

  it("makes scene ids schema-safe from messy concept names", () => {
    const scenes = deriveScenes(
      [
        cell({ id: "MEM-1", concept: "C++ & templates" }),
        cell({ id: "MEM-2", concept: "C++ & templates" })
      ],
      at
    );
    expect(scenes[0]!.id).toMatch(/^SCENE-[A-Za-z0-9_-]+$/);
  });

  it("merges concepts that differ only by case or punctuation", () => {
    const scenes = deriveScenes(
      [
        cell({ id: "MEM-1", concept: "Projection" }),
        cell({ id: "MEM-2", concept: "projection." }),
        cell({ id: "MEM-3", concept: "投射" }),
        cell({ id: "MEM-4", concept: "投射，" })
      ],
      at
    );
    expect(scenes).toHaveLength(2);
    const byTitle = Object.fromEntries(scenes.map((scene) => [scene.title, scene.cells]));
    // The first-seen spelling becomes the display title; both variants group.
    expect(byTitle["Projection"]).toEqual(["MEM-1", "MEM-2"]);
    expect(byTitle["投射"]).toEqual(["MEM-3", "MEM-4"]);
  });

  it("is deterministic and ignores blank concepts", () => {
    const cells = [
      cell({ id: "MEM-1", concept: "  " }),
      cell({ id: "MEM-2", concept: "  " })
    ];
    expect(deriveScenes(cells, at)).toEqual([]);
  });
});
