import { describe, expect, it, vi } from "vitest";
import { createBoardSnapIndex, snapBoardObject } from "../src/board-snap.js";
import type { BoardObject } from "../src/board-types.js";

function object(id: number, x = id * 40, y = id * 25): BoardObject {
  return { id: `object-${id}`, kind: "rect", anchor: { kind: "pdf", page: 1 }, x, y, width: 20, height: 12,
    color: "#000000", strokeWidth: 2, createdBy: "human", editedBy: "human", revision: 1, groupId: `group-${id}` };
}
function originalSnap(object: BoardObject, candidates: readonly BoardObject[]) {
  const axis = (key: "x" | "y", dimension: "width" | "height") => {
    let best: { delta: number; guide: number } | undefined;
    for (const other of candidates)
      for (const target of [other[key], other[key] + other[dimension] / 2, other[key] + other[dimension]])
        for (const value of [object[key], object[key] + object[dimension] / 2, object[key] + object[dimension]]) {
          const delta = target - value;
          if (Math.abs(delta) <= 5 && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, guide: target };
        }
    return best;
  };
  const x = axis("x", "width"), y = axis("y", "height");
  return { object: { ...object, x: object.x + (x?.delta ?? 0), y: object.y + (y?.delta ?? 0) }, guides: { x: x?.guide, y: y?.guide } };
}

describe("gesture snap coordinates", () => {
  it("retains the original target/value tie order, duplicates and inclusive five-unit threshold", () => {
    const candidates = [object(1, 5, -5), object(2, -5, 5), object(3, 5, 5), object(4, -5, -5)];
    const index = createBoardSnapIndex(candidates, new Set(), () => "page");
    for (let x = -25; x <= 25; x += 0.5) {
      const moved = object(0, x, -x);
      expect(snapBoardObject(moved, index, "page")).toEqual(originalSnap(moved, candidates));
    }
  });

  it("matches the previous scan over varied geometry while separating selected objects and surfaces", () => {
    let seed = 42;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const objects = Array.from({ length: 180 }, (_, id) => ({ ...object(id, Math.round(random() * 500), Math.round(random() * 300)), width: Math.round(random() * 60), height: Math.round(random() * 40) }));
    const selected = new Set(objects.slice(0, 10).map(item => item.id));
    const surface = (item: BoardObject) => Number(item.id.split("-")[1]) % 2 ? "odd" : "even";
    const index = createBoardSnapIndex(objects, selected, surface);
    for (let id = 0; id < 100; id++) {
      const moved = object(id % 10, random() * 500, random() * 300);
      expect(snapBoardObject(moved, index, surface(moved))).toEqual(originalSnap(moved,
        objects.filter(item => !selected.has(item.id) && surface(item) === surface(moved))));
    }
    expect(snapBoardObject(objects[0]!, index, undefined).guides).toEqual({ x: undefined, y: undefined });
  });

  it("resolves 5,000 objects once and bounds 100 selected queries by binary searches", () => {
    const objects = Array.from({ length: 5_000 }, (_, id) => object(id));
    const selected = new Set(objects.slice(0, 100).map(item => item.id));
    const surface = vi.fn(() => "page");
    const index = createBoardSnapIndex(objects, selected, surface);
    expect(surface).toHaveBeenCalledTimes(4_900);
    let coordinatesRead = 0;
    const group = index.get("page")!;
    for (const axis of [group.x, group.y]) axis.values = new Proxy(axis.values, {
      get(target, key, receiver) { if (/^\d+$/.test(String(key))) coordinatesRead++; return Reflect.get(target, key, receiver); },
    });
    for (const source of objects.slice(0, 100)) snapBoardObject({ ...source, x: source.x + 4_001, y: source.y + 2_501 }, index, "page");
    expect(surface).toHaveBeenCalledTimes(4_900);
    expect(coordinatesRead).toBeLessThan(50_000);
  });
});
