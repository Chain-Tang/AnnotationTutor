import { describe, expect, it } from "vitest";
import { compileThreeCharacterCover, defaultThreeCharacterArtworkPlan } from "../src/board-comic-cover.js";
import { refineComicCoverWithModel } from "../src/board-artwork-agent.js";

const addition = {
  id: "crimson-extra-ink", name: "Cheek hatching", kind: "path", parentId: "crimson-head", semanticRole: "face",
  transform: [1, 0, 0, 1, 0, 0], opacity: 1, blendMode: "normal", visible: true, locked: false,
  path: [{ op: "M", x: 365, y: 423 }, { op: "L", x: 377, y: 427 }],
  fill: { kind: "none" }, stroke: { paint: { kind: "solid", color: "#151321", opacity: 1 }, width: 2, lineCap: "round", lineJoin: "round" },
};

describe("comic artwork model refinement", () => {
  it("adds only validated, editable geometry in a draft", async () => {
    const original = compileThreeCharacterCover(defaultThreeCharacterArtworkPlan());
    const result = await refineComicCoverWithModel({ asset: original, model: { complete: async () => JSON.stringify({ description: "Face ink", nodes: [addition] }) }, imageDataUrl: "data:image/png;base64,AA==", signal: new AbortController().signal });
    expect(result.createdIds).toEqual([addition.id]);
    expect(result.asset.nodes).toHaveLength(original.nodes.length + 1);
    expect(original.nodes.some(node => node.id === addition.id)).toBe(false);
  });

  it("rejects image nodes and unknown parents without mutating the source", async () => {
    const original = compileThreeCharacterCover(defaultThreeCharacterArtworkPlan());
    const before = structuredClone(original);
    await expect(refineComicCoverWithModel({ asset: original, model: { complete: async () => JSON.stringify({ description: "unsafe", nodes: [{ ...addition, id: "bad", parentId: "missing" }] }) }, imageDataUrl: "data:image/png;base64,AA==", signal: new AbortController().signal })).rejects.toThrow();
    expect(original).toEqual(before);
  });
});
