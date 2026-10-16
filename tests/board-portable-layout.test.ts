import { describe, expect, it } from "vitest";
import { portableBoardObjects } from "../src/board-portable-layout.js";
import { renderBoardSvg } from "../src/board-renderer.js";
import type { BoardAnchor, BoardObject } from "../src/board-types.js";

function object(id: string, anchor: BoardAnchor, overrides: Partial<BoardObject> = {}): BoardObject {
  return { id, kind: "rect", anchor, x: 100, y: 80, width: 30, height: 10,
    color: "#123456", strokeWidth: 2, createdBy: "human", editedBy: "human", revision: 1, groupId: id,
    ...overrides };
}

describe("portable board preview layout", () => {
  it("keeps minimum dimensions for an empty board", () => {
    expect(portableBoardObjects([])).toEqual({ objects: [], width: 600, height: 100 });
  });

  it("preserves draw order, groups anchors by first appearance and includes rotated corners", () => {
    const source = [
      object("first", { kind: "markdown", key: "same", quote: "First quote" }, { strokeWidth: 16 }),
      object("pdf", { kind: "pdf", page: 1 }, { x: -50, y: -60, width: 0, height: 0 }),
      object("second", { kind: "markdown", key: "same", quote: "Updated quote" }, { x: 150, y: 90, width: 20 }),
      object("rotated", { kind: "canvas", pageId: "same" }, { x: 100, y: 0, width: 80, rotation: Math.PI / 2 }),
    ];
    const before = structuredClone(source);
    const result = portableBoardObjects(source);
    expect(result.objects.map(item => item.id)).toEqual(source.map(item => item.id));
    expect(result.objects.map(item => [item.x, item.y])).toEqual([[32, 52], [20, 124], [82, 62], [30, 165]]);
    expect(result.width).toBe(600);
    expect(result.height).toBe(265);
    expect(source).toEqual(before);
    expect(result.objects.every((item, index) => item !== source[index])).toBe(true);
  });

  it("does not traverse raw samples or mutate nested data while preparing and rendering a preview", () => {
    let sampleReads = 0;
    const points = Object.freeze([
      Object.freeze({ get x() { sampleReads++; return 0; }, y: 0 }),
      Object.freeze({ get x() { sampleReads++; return 10; }, y: 10 }),
    ]);
    const source = Object.freeze([Object.freeze(object("path", Object.freeze({ kind: "canvas", pageId: "main" }), {
      kind: "path", points: points as unknown as BoardObject["points"],
    }))]);
    const result = portableBoardObjects(source);
    expect(result.objects[0]!.points).toBe(points);
    expect(sampleReads).toBe(0);
    expect(() => renderBoardSvg(result.objects, { width: result.width, height: result.height, ink: {}, characters: [] })).not.toThrow();
    expect(source[0]!.x).toBe(100);
    expect(source[0]!.y).toBe(80);
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
  });

  it("classifies each of 5,000 distinct anchors once and shares 500,000 read-only samples", () => {
    let anchorReads = 0;
    const source = Array.from({ length: 5_000 }, (_, index) => object(`object-${index}`, {
      kind: "markdown", get key() { anchorReads++; return `anchor-${index}`; }, quote: "Fixture",
    }, { kind: "path", points: Array.from({ length: 100 }, (_, point) => ({ x: point, y: point / 2 })) }));
    const result = portableBoardObjects(source);
    expect(anchorReads).toBe(5_000);
    expect(result.objects).toHaveLength(5_000);
    expect(result.objects.every((item, index) => item.points === source[index]!.points)).toBe(true);
    expect(result.objects.at(-1)!.y).toBe(249_990);
  });

  it("lays out a large shared anchor without spreading all corners into a function call", () => {
    const source = Array.from({ length: 40_000 }, (_, index) => object(`object-${index}`,
      { kind: "canvas", pageId: "main" }, { x: index, y: index }));
    const result = portableBoardObjects(source);
    expect(result.objects).toHaveLength(40_000);
    expect(result.width).toBe(40_069);
    expect(result.height).toBe(40_069);
    expect(result.objects.at(-1)).toMatchObject({ x: 40_019, y: 40_039 });
  });
});
