import type { BoardAnchor, BoardObject } from "./board-types.js";

const anchorKey = (anchor: BoardAnchor): string => anchor.kind === "pdf"
  ? `pdf:${anchor.page}`
  : anchor.kind === "canvas" ? `canvas:${anchor.pageId}` : `md:${anchor.key}`;

/** Derived preview/export positions; nested drawing data is only read by renderers. */
export function portableBoardObjects(source: readonly BoardObject[]): {
  objects: BoardObject[]; width: number; height: number;
} {
  const objects = source.map(object => ({ ...object }));
  const groups = new Map<string, BoardObject[]>();
  for (const object of objects) {
    const key = anchorKey(object.anchor), group = groups.get(key);
    if (group) group.push(object);
    else groups.set(key, [object]);
  }
  let y = 20, width = 600;
  for (const group of groups.values()) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, padding = 20;
    for (const object of group) {
      const angle = object.rotation ?? 0, c = Math.cos(angle), s = Math.sin(angle);
      const rightX = object.width * c, rightY = object.width * s;
      const downX = -object.height * s, downY = object.height * c;
      // Include every rotated corner without allocating a flattened point array.
      minX = Math.min(minX, object.x, object.x + rightX, object.x + downX, object.x + rightX + downX);
      minY = Math.min(minY, object.y, object.y + rightY, object.y + downY, object.y + rightY + downY);
      maxX = Math.max(maxX, object.x, object.x + rightX, object.x + downX, object.x + rightX + downX);
      maxY = Math.max(maxY, object.y, object.y + rightY, object.y + downY, object.y + rightY + downY);
      padding = Math.max(padding, object.strokeWidth * 2);
    }
    for (const object of group) {
      object.x += padding - minX;
      object.y += y + padding - minY;
    }
    y += Math.max(1, maxY - minY) + padding * 2;
    width = Math.max(width, Math.max(1, maxX - minX) + padding * 2);
  }
  return { objects, width, height: Math.max(100, y) };
}
