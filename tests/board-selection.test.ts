import { describe, expect, it } from "vitest";
import {
  boundsForPoints,
  flipObjects,
  hitTransformHandle,
  moveObjects,
  objectIntersectsRegion,
  pointInPolygon,
  rotateObjects,
  scaleObjects,
  selectionBounds,
} from "../src/board-selection.js";
import type { BoardObject } from "../src/board-types.js";

const object = (id: string, x: number, y: number, width = 20, height = 20): BoardObject => ({
  id, kind: "rect", anchor: { kind: "canvas", pageId: "main" }, x, y, width, height,
  color: "#111111", strokeWidth: 2, createdBy: "human", editedBy: "human", revision: 1, groupId: id,
});

describe("professional board selection geometry", () => {
  it("selects concave polygons without reducing them to a rectangle", () => {
    const polygon = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 80 }, { x: 0, y: 80 }];
    expect(pointInPolygon({ x: 10, y: 60 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 60, y: 60 }, polygon)).toBe(false);
    expect(objectIntersectsRegion(object("inside", 5, 45, 8, 8), { kind: "polygon", bounds: boundsForPoints(polygon), points: polygon })).toBe(true);
    expect(objectIntersectsRegion(object("notch", 50, 50, 8, 8), { kind: "polygon", bounds: boundsForPoints(polygon), points: polygon })).toBe(false);
  });

  it("moves every selected object and calculates their shared bounds", () => {
    const objects = [object("a", 10, 10), object("b", 50, 30), object("c", 100, 100)];
    const ids = new Set(["a", "b"]);
    expect(selectionBounds(objects, ids)).toEqual({ x: 10, y: 10, width: 60, height: 40 });
    expect(moveObjects(objects, ids, 7, -3).map(item => [item.id, item.x, item.y])).toEqual([
      ["a", 17, 7], ["b", 57, 27], ["c", 100, 100],
    ]);
  });

  it("scales and rotates a multi-object selection without changing unselected objects", () => {
    const objects = [object("a", 0, 0, 10, 10), object("b", 20, 20, 10, 10), object("c", 80, 80)];
    const ids = new Set(["a", "b"]), bounds = { x: 0, y: 0, width: 30, height: 30 };
    const scaled = scaleObjects(objects, ids, bounds, { x: 10, y: 10, width: 60, height: 30 });
    expect(scaled[0]).toMatchObject({ x: 10, y: 10, width: 20, height: 10 });
    expect(scaled[1]).toMatchObject({ x: 50, y: 30, width: 20, height: 10 });
    expect(scaled[2]).toEqual(objects[2]);
    const rotated = rotateObjects(objects, ids, bounds, Math.PI / 2);
    expect(rotated[0]!.rotation).toBeCloseTo(Math.PI / 2);
    expect(rotated[2]).toEqual(objects[2]);
  });

  it("distinguishes resize and rotation handles", () => {
    const bounds = { x: 10, y: 20, width: 100, height: 60 };
    expect(hitTransformHandle({ x: 110, y: 80 }, bounds, 5)).toBe("se");
    expect(hitTransformHandle({ x: 60, y: 5 }, bounds, 5)).toBe("rotate");
    expect(hitTransformHandle({ x: 60, y: 50 }, bounds, 5)).toBeNull();
  });

  it("mirrors a complete multi-selection and preserves unselected objects",()=>{
    const objects=[object("a",10,10,20,10),object("b",60,20,10,20),object("c",200,200)],ids=new Set(["a","b"]),bounds={x:10,y:10,width:60,height:30};
    const horizontal=flipObjects(objects,ids,bounds,"horizontal");
    expect(horizontal[0]).toMatchObject({x:50,flipX:true});expect(horizontal[1]).toMatchObject({x:10,flipX:true});expect(horizontal[2]).toEqual(objects[2]);
    const restored=flipObjects(horizontal,ids,bounds,"horizontal");expect(restored[0]).toMatchObject({x:10,flipX:false});
  });
});
