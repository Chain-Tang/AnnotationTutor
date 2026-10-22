import RBush from "rbush";
import type { BoardAnchor, BoardInk, BoardObject, BoardPoint, BoardRect } from "./board-types.js";

type Entry = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  order: number;
};

export function boardAnchorKey(anchor: BoardAnchor): string {
  if (anchor.kind === "pdf") return `pdf:${anchor.page}`;
  if (anchor.kind === "canvas") return `canvas:${anchor.pageId}`;
  return `md:${anchor.key}`;
}

export function boardObjectBounds(object: BoardObject): BoardRect {
  const angle = object.rotation ?? 0;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const corners = [
    [0, 0], [object.width, 0], [0, object.height], [object.width, object.height],
  ].map(([x = 0, y = 0]) => ({
    x: object.x + x * cos - y * sin,
    y: object.y + x * sin + y * cos,
  }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of corners) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Per-anchor R-trees keep unrelated Markdown blocks and PDF pages isolated. */
export class BoardSpatialIndex {
  private readonly trees = new Map<string, RBush<Entry>>();
  private readonly objects = new Map<string, BoardObject>();
  private ink: BoardInk = {};
  private revisionKey = "";

  /** Release the original ink as well as the derived index on scene teardown. */
  public clear(): void {
    this.trees.clear(); this.objects.clear(); this.ink = {}; this.revisionKey = "";
  }

  public rebuild(objects: readonly BoardObject[], revisionKey = "", ink: BoardInk = {}): void {
    if (revisionKey && revisionKey === this.revisionKey) return;
    this.trees.clear();
    this.objects.clear();
    this.ink = ink;
    const batches = new Map<string, Entry[]>();
    objects.forEach((object, order) => {
      this.objects.set(object.id, object);
      const bounds = boardObjectBounds(object);
      const entry: Entry = {
        id: object.id,
        order,
        minX: bounds.x - object.strokeWidth / 2,
        minY: bounds.y - object.strokeWidth / 2,
        maxX: bounds.x + bounds.width + object.strokeWidth / 2,
        maxY: bounds.y + bounds.height + object.strokeWidth / 2,
      };
      const key = boardAnchorKey(object.anchor);
      const batch = batches.get(key) ?? [];
      batch.push(entry);
      batches.set(key, batch);
    });
    for (const [key, entries] of batches) {
      const tree = new RBush<Entry>(16);
      tree.load(entries);
      this.trees.set(key, tree);
    }
    this.revisionKey = revisionKey;
  }

  public search(anchor: BoardAnchor, rect: BoardRect, padding = 0): BoardObject[] {
    const entries = this.trees.get(boardAnchorKey(anchor))?.search({
      minX: rect.x - padding,
      minY: rect.y - padding,
      maxX: rect.x + rect.width + padding,
      maxY: rect.y + rect.height + padding,
    }) ?? [];
    return entries
      .sort((a, b) => a.order - b.order)
      .flatMap(entry => {
        const object = this.objects.get(entry.id);
        return object ? [object] : [];
      });
  }

  public hit(anchor: BoardAnchor, point: BoardPoint, padding = 6): BoardObject[] {
    return this.search(anchor, { x: point.x, y: point.y, width: 0, height: 0 }, padding)
      .filter(object => preciseHit(object, point, padding, object.inkId ? this.ink[object.inkId]?.points : undefined))
      .reverse();
  }
}

function segmentDistance(point: BoardPoint, a: BoardPoint, b: BoardPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function preciseHit(object: BoardObject, point: BoardPoint, padding: number, inkPoints?: readonly BoardPoint[]): boolean {
  const angle = -(object.rotation ?? 0), cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = point.x - object.x, dy = point.y - object.y;
  const local = { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  const tolerance = padding + object.strokeWidth / 2;
  if (object.kind === "ellipse") {
    const rx = Math.max(object.width / 2, 0.001), ry = Math.max(object.height / 2, 0.001);
    const value = ((local.x - rx) / rx) ** 2 + ((local.y - ry) / ry) ** 2;
    return object.fill?.kind !== undefined && object.fill.kind !== "none"
      ? value <= 1 + tolerance / Math.min(rx, ry)
      : Math.abs(Math.sqrt(value) - 1) * Math.min(rx, ry) <= tolerance;
  }
  const raw = object.kind === "ink" ? inkPoints : object.points;
  if (["ink", "path", "arrow"].includes(object.kind) && raw?.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of raw) {
      minX = Math.min(minX, item.x); minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x); maxY = Math.max(maxY, item.y);
    }
    const spanX = maxX - minX, spanY = maxY - minY;
    const points = raw.map((item) => ({
      x: spanX ? ((item.x - minX) / spanX) * object.width : object.width / 2,
      y: spanY ? ((item.y - minY) / spanY) * object.height : object.height / 2,
    }));
    for (let i = 1; i < points.length; i++)
      if (segmentDistance(local, points[i - 1]!, points[i]!) <= tolerance) return true;
    return false;
  }
  return local.x >= -tolerance && local.y >= -tolerance &&
    local.x <= object.width + tolerance && local.y <= object.height + tolerance;
}
