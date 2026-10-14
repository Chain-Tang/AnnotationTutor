import { describe, expect, it } from "vitest";
import { BoardSpatialIndex } from "../src/board-spatial.js";
import type { BoardInk, BoardObject } from "../src/board-types.js";

describe("board capacity fixture", () => {
  it("indexes 5,000 objects backed by 500,000 raw samples and keeps hit queries bounded", () => {
    const objects: BoardObject[] = [];
    const ink: BoardInk = {};
    for (let index = 0; index < 5_000; index++) {
      const inkId = `INK-${index}`;
      ink[inkId] = {
        id: inkId,
        createdAt: "2026-09-14T00:00:00.000Z",
        points: Array.from({ length: 100 }, (_, point) => ({ x: point, y: Math.sin(point / 8) * 4, pressure: point / 100 })),
      };
      objects.push({
        id: `OBJ-${index}`, kind: "ink", anchor: { kind: "canvas", pageId: "main" },
        x: (index % 100) * 120, y: Math.floor(index / 100) * 40,
        width: 100, height: 16, color: "#000000", strokeWidth: 3, inkId,
        createdBy: "human", editedBy: "human", revision: 1, groupId: `GROUP-${index}`,
      });
    }
    expect(Object.values(ink).reduce((total, stroke) => total + stroke.points.length, 0)).toBe(500_000);
    const index = new BoardSpatialIndex();
    index.rebuild(objects, "fixture");
    const samples: number[] = [];
    for (let query = 0; query < 200; query++) {
      const start = performance.now();
      const found = index.search({ kind: "canvas", pageId: "main" }, { x: query * 20, y: query * 5, width: 800, height: 600 });
      samples.push(performance.now() - start);
      expect(found.length).toBeLessThan(400);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.95)]!).toBeLessThan(8);
  });
});
