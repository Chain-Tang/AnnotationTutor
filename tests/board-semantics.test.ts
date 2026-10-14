import { describe, expect, it } from "vitest";
import { classifyBoardStroke, shouldMergeSemanticStrokes } from "../src/board-semantics.js";
import type { BoardObject, InkStroke } from "../src/board-types.js";

const object = (width: number, height: number): BoardObject => ({
  id: "OBJ-1", kind: "ink", anchor: { kind: "canvas", pageId: "main" },
  x: 0, y: 0, width, height, color: "#000000", strokeWidth: 3,
  inkId: "INK-1", createdBy: "human", editedBy: "human", revision: 1, groupId: "GROUP-1",
});
const stroke = (points: Array<[number, number, number?]>): InkStroke => ({
  id: "INK-1", createdAt: new Date(0).toISOString(),
  points: points.map(([x, y, t]) => ({ x, y, t })),
});

describe("board gesture semantics", () => {
  it("classifies a straight horizontal stroke as an underline", () => {
    expect(classifyBoardStroke(object(100, 2), stroke([[0, 0], [50, 1], [100, 0]])).kind).toBe("underline");
  });

  it("classifies a closed round stroke without replacing it", () => {
    const points = Array.from({ length: 25 }, (_, index) => {
      const angle = (index / 24) * Math.PI * 2;
      return [50 + Math.cos(angle) * 48, 50 + Math.sin(angle) * 48] as [number, number];
    });
    expect(classifyBoardStroke(object(100, 100), stroke(points)).kind).toBe("circle");
  });

  it("groups nearby strokes but not strokes on another canvas", () => {
    const first = { object: object(20, 20), stroke: stroke([[0, 0, 10], [20, 20, 20]]) };
    const secondObject = { ...object(20, 20), id: "OBJ-2", x: 24, inkId: "INK-2" };
    const secondStroke = { ...stroke([[0, 0, 30], [20, 20, 40]]), id: "INK-2" };
    expect(shouldMergeSemanticStrokes(first, { object: secondObject, stroke: secondStroke })).toBe(true);
    expect(shouldMergeSemanticStrokes(first, { object: { ...secondObject, anchor: { kind: "canvas", pageId: "other" } }, stroke: secondStroke })).toBe(false);
  });
});
