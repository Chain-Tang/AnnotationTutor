import type { BoardObject, BoardPoint, BoardRect, BoardSelectionRegion } from "./board-types.js";
import { boardObjectBounds } from "./board-spatial.js";

const EPSILON = 1e-7;

export function normalizeRect(rect: BoardRect): BoardRect {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

export function boundsForPoints(points: readonly BoardPoint[]): BoardRect {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x); top = Math.min(top, point.y);
    right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function pointInRect(point: BoardPoint, rect: BoardRect, padding = 0): boolean {
  const value = normalizeRect(rect);
  return point.x >= value.x - padding && point.x <= value.x + value.width + padding &&
    point.y >= value.y - padding && point.y <= value.y + value.height + padding;
}

export function pointInPolygon(point: BoardPoint, polygon: readonly BoardPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!, b = polygon[previous]!;
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(a: BoardPoint, b: BoardPoint, c: BoardPoint): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}
function segmentIntersects(a: BoardPoint, b: BoardPoint, c: BoardPoint, d: BoardPoint): boolean {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d), o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  return (o1 > EPSILON) !== (o2 > EPSILON) && (o3 > EPSILON) !== (o4 > EPSILON);
}

function rectCorners(rect: BoardRect): BoardPoint[] {
  const value = normalizeRect(rect), right = value.x + value.width, bottom = value.y + value.height;
  return [{ x: value.x, y: value.y }, { x: right, y: value.y }, { x: right, y: bottom }, { x: value.x, y: bottom }];
}

export function rectIntersectsPolygon(rect: BoardRect, polygon: readonly BoardPoint[]): boolean {
  if (polygon.length < 3) return false;
  const corners = rectCorners(rect);
  if (corners.some(point => pointInPolygon(point, polygon))) return true;
  if (polygon.some(point => pointInRect(point, rect))) return true;
  for (let a = 0; a < corners.length; a++) {
    const first = corners[a]!, second = corners[(a + 1) % corners.length]!;
    for (let b = 0; b < polygon.length; b++)
      if (segmentIntersects(first, second, polygon[b]!, polygon[(b + 1) % polygon.length]!)) return true;
  }
  return false;
}

export function regionContainsPoint(region: BoardSelectionRegion, point: BoardPoint): boolean {
  if (region.kind === "rect" || region.kind === "raster-mask") return pointInRect(point, region.bounds);
  return pointInPolygon(point, region.points);
}

export function objectIntersectsRegion(object: BoardObject, region: BoardSelectionRegion): boolean {
  const bounds = boardObjectBounds(object);
  if (region.kind === "polygon") return rectIntersectsPolygon(bounds, region.points);
  const selection = normalizeRect(region.bounds), objectBounds = normalizeRect(bounds);
  return objectBounds.x <= selection.x + selection.width && objectBounds.x + objectBounds.width >= selection.x &&
    objectBounds.y <= selection.y + selection.height && objectBounds.y + objectBounds.height >= selection.y;
}

export function selectionBounds(objects: readonly BoardObject[], ids: ReadonlySet<string>): BoardRect | null {
  if (!ids.size) return null;
  const selected = objects.filter(object => ids.has(object.id));
  if (!selected.length) return null;
  const boxes = selected.map(boardObjectBounds);
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

export type BoardTransformHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";
export function hitTransformHandle(point: BoardPoint, bounds: BoardRect, radius: number): BoardTransformHandle | null {
  const x = bounds.x, y = bounds.y, right = x + bounds.width, bottom = y + bounds.height, cx = x + bounds.width / 2, cy = y + bounds.height / 2;
  const handles: Array<[BoardTransformHandle, BoardPoint]> = [
    ["nw", { x, y }], ["n", { x: cx, y }], ["ne", { x: right, y }], ["e", { x: right, y: cy }],
    ["se", { x: right, y: bottom }], ["s", { x: cx, y: bottom }], ["sw", { x, y: bottom }], ["w", { x, y: cy }],
    ["rotate", { x: cx, y: y - radius * 3 }],
  ];
  return handles.find(([, handle]) => Math.hypot(point.x - handle.x, point.y - handle.y) <= radius)?.[0] ?? null;
}

export function moveObjects(objects: readonly BoardObject[], ids: ReadonlySet<string>, dx: number, dy: number): BoardObject[] {
  return objects.map(object => ids.has(object.id) ? { ...object, x: object.x + dx, y: object.y + dy } : object);
}

export function scaleObjects(
  objects: readonly BoardObject[],
  ids: ReadonlySet<string>,
  original: BoardRect,
  targetInput: BoardRect,
): BoardObject[] {
  const target = normalizeRect(targetInput), sourceWidth = Math.max(EPSILON, original.width), sourceHeight = Math.max(EPSILON, original.height);
  const sx = target.width / sourceWidth, sy = target.height / sourceHeight;
  return objects.map(object => ids.has(object.id) ? {
    ...object,
    x: target.x + (object.x - original.x) * sx,
    y: target.y + (object.y - original.y) * sy,
    width: Math.max(0.1, object.width * sx),
    height: Math.max(0.1, object.height * sy),
    strokeWidth: Math.max(0.1, object.strokeWidth * Math.sqrt(Math.abs(sx * sy))),
  } : object);
}

export function rotateObjects(
  objects: readonly BoardObject[], ids: ReadonlySet<string>, bounds: BoardRect, radians: number,
): BoardObject[] {
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2, cos = Math.cos(radians), sin = Math.sin(radians);
  return objects.map(object => {
    if (!ids.has(object.id)) return object;
    const ox = object.x + object.width / 2, oy = object.y + object.height / 2, dx = ox - cx, dy = oy - cy;
    const nx = cx + dx * cos - dy * sin, ny = cy + dx * sin + dy * cos;
    return { ...object, x: nx - object.width / 2, y: ny - object.height / 2, rotation: (object.rotation ?? 0) + radians };
  });
}

export function flipObjects(objects:readonly BoardObject[],ids:ReadonlySet<string>,bounds:BoardRect,axis:"horizontal"|"vertical"):BoardObject[]{
  return objects.map(object=>{
    if(!ids.has(object.id))return object;
    return axis==="horizontal"
      ?{...object,x:bounds.x*2+bounds.width-(object.x+object.width),flipX:!object.flipX}
      :{...object,y:bounds.y*2+bounds.height-(object.y+object.height),flipY:!object.flipY};
  });
}
