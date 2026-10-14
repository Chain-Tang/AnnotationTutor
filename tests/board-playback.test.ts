import { describe, expect, it } from "vitest";
import { BoardVectorPlayback } from "../src/board-playback.js";
import type { BoardVectorAsset } from "../src/board-types.js";

const asset: BoardVectorAsset = {
  format: "board-vector-v1", id: "scene", version: 1, name: "Scene", width: 100, height: 100,
  rootIds: ["root"], createdAt: "2026-09-16T00:00:00.000Z",
  nodes: [
    { id: "root", name: "Root", kind: "group", transform: [1, 0, 0, 1, 0, 0], opacity: 1, blendMode: "normal", visible: true, locked: false },
    { id: "curve", parentId: "root", name: "Curve", kind: "path", transform: [1, 0, 0, 1, 0, 0], opacity: 1, blendMode: "normal", visible: true, locked: false, path: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 10, y: 10 }, { op: "L", x: 20, y: 5 }, { op: "L", x: 30, y: 20 }] },
  ],
};
describe("vector progressive reveal", () => {
  it("can skip animation and produces one final immutable asset", async () => {
    const player = new BoardVectorPlayback(); player.setSpeed("instant");
    const output = []; for await (const event of player.play(asset)) output.push(event);
    expect(output.map(event => event.type)).toContain("frame");
    expect(output.at(-1)).toEqual({ type: "complete", asset });
    expect(asset.nodes[1]?.path).toHaveLength(4);
  });
  it("cancels without yielding a completed asset", async () => {
    const player = new BoardVectorPlayback(), output = [];
    for await (const event of player.play(asset)) { output.push(event); if (event.type === "frame") player.cancel(); }
    expect(output.at(-1)).toEqual({ type: "cancelled" });
    expect(output.some(event => event.type === "complete")).toBe(false);
  });
});
