import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { BoardBrushKind, BoardBrushStyle } from "./board-types.js";

export function pressureOutlineThinning(kind: BoardBrushKind): number {
  if (kind === "fountain") return 0.72;
  if (kind === "pen") return 0.48;
  if (["pencil", "chalk", "watercolor", "sumi", "oil"].includes(kind)) return 0.28;
  return 0;
}

export function pressureOutlineOptions(brush: BoardBrushStyle, width: number, simulatePressure: boolean): StrokeOptions {
  return {
    size: width, thinning: pressureOutlineThinning(brush.kind), smoothing: brush.smoothing,
    streamline: brush.streamline, simulatePressure, last: true,
    start: { cap: !["fountain", "marker", "highlighter"].includes(brush.kind) },
    end: { cap: !["fountain", "marker", "highlighter"].includes(brush.kind) },
  };
}

export interface PackedPressureStroke {
  id: string;
  /** x, y, pressure triples; NaN denotes absent pressure, never a coordinate. */
  samples: Float64Array;
  width: number;
  height: number;
  strokeWidth: number;
  brush: BoardBrushStyle;
  local?: boolean;
}

/** Same floating-point transform and perfect-freehand options as the renderer.
 * Only the derived geometry crosses back to the UI; original ink stays intact. */
export function packedPressureOutline(stroke: PackedPressureStroke): Float64Array {
  const { samples, width, height, brush } = stroke;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, missing = true;
  for (let i = 0; i < samples.length; i += 3) {
    minX = Math.min(minX, samples[i]!); maxX = Math.max(maxX, samples[i]!);
    minY = Math.min(minY, samples[i + 1]!); maxY = Math.max(maxY, samples[i + 1]!);
    if (!Number.isNaN(samples[i + 2]!)) missing = false;
  }
  const dx = maxX - minX, dy = maxY - minY;
  const points: number[][] = [];
  for (let i = 0; i < samples.length; i += 3) points.push([
    stroke.local ? samples[i]! : dx > 0 ? ((samples[i]! - minX) / dx) * width : width / 2,
    stroke.local ? samples[i + 1]! : dy > 0 ? ((samples[i + 1]! - minY) / dy) * height : height / 2,
    brush.pressure && !Number.isNaN(samples[i + 2]!) ? samples[i + 2]! : 0.5,
  ]);
  const outline = getStroke(points, pressureOutlineOptions(brush, stroke.strokeWidth, brush.pressure && missing));
  const packed = new Float64Array(outline.length * 2);
  for (let i = 0; i < outline.length; i++) {
    packed[i * 2] = outline[i]![0]!; packed[i * 2 + 1] = outline[i]![1]!;
  }
  return packed;
}
