import { getStroke } from "perfect-freehand";
import { pressureOutlineOptions } from "./board-pressure-geometry.js";
import type {
  BoardBrushKind,
  BoardBrushStyle,
  BoardObject,
  BoardPoint,
} from "./board-types.js";

export const BOARD_BRUSHES: readonly BoardBrushKind[] = [
  "pen",
  "fountain",
  "pencil",
  "marker",
  "highlighter",
  "chalk",
  "crayon",
  "watercolor",
  "sumi",
  "oil",
];

export function defaultBoardBrush(
  kind: BoardBrushKind = "pen",
  seed = 1,
): BoardBrushStyle {
  const opacity =
    kind === "highlighter" ? 0.3
      : kind === "watercolor" ? 0.38
      : kind === "sumi" ? 0.9
      : kind === "oil" ? 0.92
      : kind === "pencil" ? 0.72
      : kind === "chalk" ? 0.78
      : kind === "marker" ? 0.88
      : 1;
  if (kind === "crayon") return { kind, opacity: 1, pressure: true, smoothing: .35, streamline: .25,
    flow: .65, hardness: .88, spacing: .13, roundness: .72, scatter: .04, grainScale: .7, grainStrength: .65,
    stabilization: .2, pressureSize: .2, pressureFlow: .3, pressureOpacity: .1, seed: seed >>> 0 };
  return {
    kind,
    opacity,
    pressure: !["marker", "highlighter"].includes(kind),
    smoothing: kind === "pencil" ? 0.35 : kind === "sumi" ? 0.52 : kind === "oil" ? 0.42 : 0.6,
    streamline: kind === "marker" ? 0.25 : 0.5,
    flow: kind === "watercolor" ? 0.12 : kind === "sumi" ? 0.62 : kind === "oil" ? 0.78 : kind === "pencil" || kind === "chalk" ? 0.25 : kind === "highlighter" ? 0.32 : 1,
    hardness: kind === "watercolor" ? 0.18 : kind === "sumi" ? 0.55 : kind === "oil" ? 0.86 : kind === "chalk" ? 0.55 : kind === "pencil" ? 0.7 : 1,
    spacing: kind === "highlighter" ? 0.16 : 0.1,
    roundness: kind === "fountain" || kind === "highlighter" ? 0.2 : kind === "sumi" ? 0.3 : kind === "oil" ? 0.42 : kind === "marker" ? 0.35 : 1,
    scatter: kind === "chalk" ? 0.8 : kind === "pencil" ? 0.35 : kind === "watercolor" ? 0.12 : 0,
    grainScale: kind === "watercolor" ? 2 : kind === "chalk" ? 1.2 : 0.7,
    grainStrength: kind === "chalk" ? 0.88 : kind === "pencil" ? 0.72 : kind === "watercolor" ? 0.42 : 0,
    stabilization: 0.2,
    pressureSize: kind === "pen" || kind === "sumi" ? 0.85 : kind === "fountain" || kind === "pencil" || kind === "chalk" || kind === "watercolor" || kind === "oil" ? 0.35 : 0,
    pressureFlow: kind === "pencil" || kind === "chalk" ? 0.9 : kind === "watercolor" ? 0.55 : 0,
    pressureOpacity: kind === "pencil" ? 0.65 : kind === "chalk" ? 0.6 : kind === "watercolor" ? 0.45 : 0,
    bristleDensity: kind === "oil" ? 0.68 : kind === "sumi" ? 0.55 : 0,
    dryness: kind === "sumi" ? 0.32 : kind === "oil" ? 0.18 : 0,
    impasto: kind === "oil" ? 0.62 : 0,
    ...(kind === "highlighter" ? { preventSelfOverlap: true } : {}),
    ...(kind === "fountain" || kind === "sumi" || kind === "oil" ? { nibAngle: -Math.PI / 4 } : {}),
    seed: seed >>> 0,
  };
}

/** New Studio strokes opt into the v2 renderer; persisted v1 snapshots stay untouched. */
export function studioBoardBrush(kind: BoardBrushKind = "pen", seed = 1): BoardBrushStyle {
  const original = defaultBoardBrush(kind, seed);
  switch (kind) {
    case "pencil": return { ...original, engineVersion: 2, opacity: 0.9, flow: 0.82, grainStrength: 0.58, pressureFlow: 0.42, pressureOpacity: 0.2 };
    case "chalk": return { ...original, engineVersion: 2, opacity: 0.94, flow: 0.72, grainStrength: 0.72, pressureFlow: 0.52 };
    case "watercolor": return { ...original, engineVersion: 2, opacity: 0.52, flow: 0.2, grainStrength: 0.36 };
    case "sumi": return { ...original, engineVersion: 2, flow: 0.74, dryness: 0.26 };
    case "oil": return { ...original, engineVersion: 2, flow: 0.88, impasto: 0.78, bristleDensity: 0.72 };
    default: return { ...original, engineVersion: 2 };
  }
}

export function brushComposite(kind: BoardBrushKind): "normal" | "multiply" {
  return ["pencil", "marker", "highlighter", "chalk", "watercolor", "sumi"].includes(kind)
    ? "multiply"
    : "normal";
}

export function brushTexture(
  kind: BoardBrushKind,
): "none" | "pencil" | "chalk" | "watercolor" {
  if (kind === "pencil" || kind === "chalk" || kind === "watercolor") return kind;
  return "none";
}

const outlineCache = new WeakMap<readonly BoardPoint[], Map<string, BoardPoint[]>>();

/**
 * Produce a replayable pressure outline while leaving the captured samples intact.
 * The cache is tied to the immutable point array and bounded per stroke.
 */
export function boardBrushOutline(
  points: readonly BoardPoint[],
  object: Pick<BoardObject, "width" | "height" | "strokeWidth" | "brush">,
  pointsAreLocal = false,
): BoardPoint[] {
  const brush = object.brush ?? defaultBoardBrush();
  let entries = outlineCache.get(points);
  if (!entries) {
    entries = new Map();
    outlineCache.set(points, entries);
  }
  const key = [
    object.width,
    object.height,
    object.strokeWidth,
    brush.kind,
    brush.pressure,
    brush.smoothing,
    brush.streamline,
    brush.nibAngle,
    brush.flow,
    brush.hardness,
    brush.spacing,
    brush.roundness,
    brush.scatter,
    brush.grainScale,
    brush.grainStrength,
    brush.pressureSize,
    brush.pressureFlow,
    brush.pressureOpacity,
    brush.bristleDensity,
    brush.dryness,
    brush.impasto,
    pointsAreLocal,
  ].join(":");
  const cached = entries.get(key);
  if (cached) return cached;
  if (!points.length) return [];

  let minX = 0, minY = 0, spanX = object.width, spanY = object.height;
  if (!pointsAreLocal) {
    let maxX = -Infinity, maxY = -Infinity;
    minX = Infinity;
    minY = Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    spanX = maxX - minX;
    spanY = maxY - minY;
  }
  // Local, pressure-aware samples already have the exact geometry required by
  // perfect-freehand (which defaults missing pressure to .5). Copy only the
  // array for its mutable parameter contract, preserving immutable samples;
  // avoid allocating a second object for every point of a cold scene.
  const input = pointsAreLocal && brush.pressure ? points.slice() : points.map(point => ({
    x: pointsAreLocal ? point.x : spanX > 0 ? ((point.x - minX) / spanX) * object.width : object.width / 2,
    y: pointsAreLocal ? point.y : spanY > 0 ? ((point.y - minY) / spanY) * object.height : object.height / 2,
    pressure: brush.pressure && point.pressure !== undefined ? point.pressure : 0.5,
  }));
  const outline = getStroke(input, pressureOutlineOptions(brush, object.strokeWidth,
    brush.pressure && points.every(point => point.pressure === undefined))).map(([x, y]) => ({ x, y }));
  entries.set(key, outline);
  if (entries.size > 8) entries.delete(entries.keys().next().value!);
  return outline;
}

/** Split a stroke around non-destructive erased sample intervals. */
const visibleSegmentCache = new WeakMap<readonly BoardPoint[], Map<string, readonly (readonly BoardPoint[])[]>>();
export function visibleBoardPointSegments(
  points: readonly BoardPoint[],
  erased: readonly [number, number][] = [],
): readonly (readonly BoardPoint[])[] {
  // Preserve the normalized stream's identity: the material raster cache is
  // keyed by it. Copying an untouched stroke forced every pan/zoom redraw to
  // regenerate its expensive textured brush image.
  if (!erased.length) return points.length ? [points] : [];
  const key = JSON.stringify(erased);
  let entries = visibleSegmentCache.get(points);
  if (!entries) { entries = new Map(); visibleSegmentCache.set(points, entries); }
  const cached = entries.get(key);
  if (cached) return cached;
  const hidden = [...erased]
    .map(([from, to]) => [Math.max(0, Math.min(from, to)), Math.min(points.length - 1, Math.max(from, to))] as const)
    .sort((a, b) => a[0] - b[0]);
  const output: BoardPoint[][] = [];
  let cursor = 0;
  for (const [from, to] of hidden) {
    if (from > cursor) output.push(points.slice(cursor, from));
    cursor = Math.max(cursor, to + 1);
  }
  if (cursor < points.length) output.push(points.slice(cursor));
  const result = output.filter(segment => segment.length > 0);
  entries.set(key, result);
  if (entries.size > 8) entries.delete(entries.keys().next().value!);
  return result;
}
