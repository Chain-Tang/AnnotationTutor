import { describe, expect, it } from "vitest";
import { boardBrushOutline, defaultBoardBrush, visibleBoardPointSegments } from "../src/board-brushes.js";
import frozenOutlines from './fixtures/board-outline-c37.json' with {type:'json'};
import type {BoardBrushStyle} from '../src/board-types.js';

describe("pressure brushes and non-destructive erasing", () => {
  it.each(frozenOutlines.cases)('preserves saved C37 outline geometry and immutable samples: $name',fixture=>{
    const points=fixture.points.map(point=>Object.freeze({...point}));Object.freeze(points);
    const before=JSON.stringify(points),object={...fixture.object,brush:fixture.object.brush as BoardBrushStyle};
    expect(boardBrushOutline(points,object,fixture.local)).toEqual(fixture.outline);
    expect(JSON.stringify(points)).toBe(before);
    expect(points[0]).toMatchObject({t:0,tiltX:12,tiltY:-14});
  });
  it("derives a deterministic pressure outline without mutating samples", () => {
    const points = [{ x: 0, y: 0, pressure: 0.1 }, { x: 50, y: 4, pressure: 0.9 }, { x: 100, y: 0, pressure: 0.3 }];
    const before = structuredClone(points);
    const object = { width: 100, height: 4, strokeWidth: 12, brush: defaultBoardBrush("fountain", 42) };
    const first = boardBrushOutline(points, object, true);
    expect(boardBrushOutline(points, object, true)).toBe(first);
    expect(first.length).toBeGreaterThan(3);
    expect(points).toEqual(before);
  });
  it("splits visible intervals while retaining original point indices", () => {
    const points = Array.from({ length: 10 }, (_, x) => ({ x, y: 0 }));
    expect(visibleBoardPointSegments(points, [[3, 5]])).toEqual([points.slice(0, 3), points.slice(6)]);
    expect(visibleBoardPointSegments(points, [[3, 5]])).toBe(visibleBoardPointSegments(points, [[3, 5]]));
    expect(visibleBoardPointSegments(points)[0]).toBe(points);
  });
});
