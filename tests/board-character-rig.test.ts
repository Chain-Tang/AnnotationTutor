import { describe, expect, it } from "vitest";
import { DefaultBoardCharacterResolver } from "../src/board-character-rig.js";
import type { BoardCharacterDefinition, BoardCharacterRecipe, BoardVectorAsset } from "../src/board-types.js";

const asset: BoardVectorAsset = {
  format: "board-vector-v1", id: "hero", version: 1, name: "Hero", width: 100, height: 180,
  rootIds: ["root"], createdAt: "2026-09-16T00:00:00.000Z",
  nodes: [
    { id: "root", name: "Hero", kind: "group", transform: [1, 0, 0, 1, 0, 0], opacity: 1, blendMode: "normal", visible: true, locked: false },
    { id: "eyes-happy", parentId: "root", name: "Happy eyes", kind: "path", semanticRole: "eyes", transform: [1, 0, 0, 1, 0, 0], opacity: 0, blendMode: "normal", visible: true, locked: false, path: [{ op: "M", x: 20, y: 30 }, { op: "Q", x1: 30, y1: 20, x: 40, y: 30 }] },
    { id: "shirt-a", parentId: "root", name: "Shirt A", kind: "shape", semanticRole: "outfit", transform: [1, 0, 0, 1, 0, 0], opacity: 1, blendMode: "normal", visible: true, locked: false, shape: { kind: "rect", x: 20, y: 80, width: 60, height: 60 } },
    { id: "shirt-b", parentId: "root", name: "Shirt B", kind: "shape", semanticRole: "outfit", transform: [1, 0, 0, 1, 0, 0], opacity: 1, blendMode: "normal", visible: false, locked: false, shape: { kind: "rect", x: 20, y: 80, width: 60, height: 60 } },
  ],
};
const definition: BoardCharacterDefinition = {
  format: "board-character-v1", id: "hero-definition", version: 1, name: "Hero", vectorAssetId: "hero", vectorAssetVersion: 1,
  rig: { joints: [{ id: "head", name: "Head", x: 50, y: 40 }] },
  parts: [
    { id: "casual", name: "Casual", slot: "top", rootNodeId: "shirt-a", layer: 1 },
    { id: "uniform", name: "Uniform", slot: "top", rootNodeId: "shirt-b", layer: 1 },
  ],
  faceControls: [{ id: "happy-eyes", channel: "emotion", nodeIds: ["eyes-happy"], min: 0, max: 1 }],
  presets: [
    { id: "neutral", kind: "pose", values: {} },
    { id: "wave", kind: "gesture", values: { "node.root.rotate": 0.1 } },
    { id: "uniform-look", kind: "outfit", values: { uniform: true } },
    { id: "book", kind: "prop", values: {} },
    { id: "cup", kind: "prop", values: {} },
  ],
  rules: { exclusiveSlots: ["top"], handOccupancy: [{ presetId: "book", hands: ["left"] }, { presetId: "cup", hands: ["left"] }], layerOrder: ["top"] },
  createdAt: "2026-09-16T00:00:00.000Z",
};
const recipe = (overrides: Partial<BoardCharacterRecipe> = {}): BoardCharacterRecipe => ({
  definitionId: "hero-definition", definitionVersion: 1, pose: "neutral", gestures: ["wave"],
  expression: { emotion: { "happy-eyes": 0.8 }, mouth: {}, blink: {}, gaze: {}, micro: {} },
  outfit: "uniform-look", props: ["book"], ...overrides,
});

describe("static character composition", () => {
  it("mixes face channels and switches exclusive outfit parts", () => {
    const resolver = new DefaultBoardCharacterResolver(), result = resolver.resolve(definition, recipe(), asset);
    expect(result.nodes.find(node => node.id === "eyes-happy")?.opacity).toBe(0.8);
    expect(result.nodes.find(node => node.id === "shirt-a")?.visible).toBe(false);
    expect(result.nodes.find(node => node.id === "shirt-b")?.visible).toBe(true);
    expect(result.nodes.find(node => node.id === "root")?.transform).not.toEqual([1, 0, 0, 1, 0, 0]);
  });
  it("rejects conflicting hand props before geometry is changed", () => {
    const validation = new DefaultBoardCharacterResolver().validateRecipe(definition, recipe({ props: ["book", "cup"] }));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/left hand/);
  });
});
