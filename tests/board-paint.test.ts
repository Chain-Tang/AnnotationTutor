import { describe, expect, it } from "vitest";
import { BOARD_BRUSHES, defaultBoardBrush } from "../src/board-brushes.js";
import { affectedBoardTiles, floodFillMask, generateBrushDabs } from "../src/board-paint.js";

const points = Array.from({ length: 32 }, (_, index) => ({
  x: index * 3,
  y: 10 + Math.sin(index / 4) * 6,
  pressure: 0.15 + index / 40,
  t: index * 8,
  tiltX: 35,
  tiltY: -20,
}));

describe("v4 paint engine", () => {
  it("replays deterministically and gives every built-in brush distinct dab geometry", () => {
    const signatures = BOARD_BRUSHES.map(kind => {
      const style = defaultBoardBrush(kind, 42);
      const first = generateBrushDabs(points, style, 12);
      expect(generateBrushDabs(points, style, 12)).toEqual(first);
      expect(first.length).toBeGreaterThan(2);
      return JSON.stringify(first.slice(0, 18).map(dab => [dab.shape, +dab.radiusX.toFixed(2), +dab.radiusY.toFixed(2), +dab.alpha.toFixed(3), +dab.grain.toFixed(2), +(dab.tone ?? 0).toFixed(2)]));
    });
    expect(new Set(signatures).size).toBe(BOARD_BRUSHES.length);
  });

  it("gives sumi dry gaps and oil deterministic impasto ridges", () => {
    const sumi = generateBrushDabs(points, { ...defaultBoardBrush("sumi", 91), dryness: 0.9 }, 24);
    const oil = generateBrushDabs(points, { ...defaultBoardBrush("oil", 91), bristleDensity: 0.82, impasto: 0.9 }, 24);
    expect(sumi.some(dab => dab.grain > 0.7)).toBe(true);
    expect(oil.some(dab => Math.abs(dab.tone ?? 0) > 0.3)).toBe(true);
    expect(oil.filter(dab => dab.shape === "rect").length).toBeGreaterThan(sumi.filter(dab => dab.shape === "rect").length);
    expect(generateBrushDabs(points, { ...defaultBoardBrush("oil", 91), bristleDensity: 0.82, impasto: 0.9 }, 24)).toEqual(oil);
  });

  it("indexes gutter-expanded 512px tiles without seams", () => {
    expect(affectedBoardTiles({ x: 510, y: 510, width: 4, height: 4 })).toEqual(["0:0", "1:0", "0:1", "1:1"]);
  });

  it("fills only a contiguous color region and honors transparent-pixel lock", () => {
    const pixels = new Uint8ClampedArray([
      10, 10, 10, 255, 10, 10, 10, 255, 240, 240, 240, 255,
      10, 10, 10, 255, 10, 10, 10, 255, 240, 240, 240, 255,
    ]);
    expect([...floodFillMask(pixels, 3, 2, 0, 0, 3)]).toEqual([255, 255, 0, 255, 255, 0]);
    pixels[3] = 0;
    expect([...floodFillMask(pixels, 3, 2, 0, 0, 3, true)]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
