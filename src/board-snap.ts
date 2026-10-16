import type { BoardObject } from "./board-types.js";

type SnapCoordinate = { value: number; order: number };
type SnapAxis = { values: SnapCoordinate[] };
type SnapGroup = { x: SnapAxis; y: SnapAxis };
export type BoardSnapIndex = ReadonlyMap<string, SnapGroup>;

function axis(values: SnapCoordinate[]): SnapAxis {
  values.sort((a, b) => a.value - b.value || a.order - b.order);
  return { values };
}

/** Capture candidates once at gesture start; each axis keeps original tie order. */
export function createBoardSnapIndex(
  objects: readonly BoardObject[],
  selected: ReadonlySet<string>,
  surfaceId: (object: BoardObject) => string | undefined,
): BoardSnapIndex {
  const groups = new Map<string, { x: SnapCoordinate[]; y: SnapCoordinate[] }>();
  objects.forEach((object, index) => {
    if (selected.has(object.id)) return;
    const id = surfaceId(object);
    if (id === undefined) return;
    let group = groups.get(id);
    if (!group) { group = { x: [], y: [] }; groups.set(id, group); }
    [object.x, object.x + object.width / 2, object.x + object.width].forEach((value, offset) => group.x.push({ value, order: index * 3 + offset }));
    [object.y, object.y + object.height / 2, object.y + object.height].forEach((value, offset) => group.y.push({ value, order: index * 3 + offset }));
  });
  return new Map([...groups].map(([id, group]) => [id, { x: axis(group.x), y: axis(group.y) }]));
}

function lowerBound(values: readonly SnapCoordinate[], value: number): number {
  let low = 0, high = values.length;
  while (low < high) { const mid = (low + high) >>> 1; if (values[mid]!.value < value) low = mid + 1; else high = mid; }
  return low;
}

/** First original candidate for a coordinate, including duplicate coordinates. */
function coordinateAt(source: SnapAxis, index: number): SnapCoordinate | undefined {
  const coordinate = source.values[index];
  if (!coordinate) return;
  return source.values[lowerBound(source.values, coordinate.value)];
}

function snapAxis(source: SnapAxis, values: readonly number[]): { delta: number; guide: number } | undefined {
  let best: { delta: number; guide: number; order: number; valueOrder: number } | undefined;
  values.forEach((value, valueOrder) => {
    const at = lowerBound(source.values, value);
    // Only each neighbor can be closest; duplicate targets use their earliest
    // source order, matching the original strict-improvement nested loops.
    for (const target of [coordinateAt(source, at), coordinateAt(source, at - 1)]) {
      if (!target) continue;
      const delta = target.value - value, distance = Math.abs(delta);
      if (distance > 5) continue;
      if (!best || distance < Math.abs(best.delta) || (distance === Math.abs(best.delta) &&
        (target.order < best.order || (target.order === best.order && valueOrder < best.valueOrder))))
        best = { delta, guide: target.value, order: target.order, valueOrder };
    }
  });
  return best;
}

export function snapBoardObject(object: BoardObject, index: BoardSnapIndex, surfaceId: string | undefined): {
  object: BoardObject; guides: { x?: number; y?: number };
} {
  const group = surfaceId === undefined ? undefined : index.get(surfaceId);
  const x = group && snapAxis(group.x, [object.x, object.x + object.width / 2, object.x + object.width]);
  const y = group && snapAxis(group.y, [object.y, object.y + object.height / 2, object.y + object.height]);
  return { object: { ...object, x: object.x + (x?.delta ?? 0), y: object.y + (y?.delta ?? 0) }, guides: { x: x?.guide, y: y?.guide } };
}
