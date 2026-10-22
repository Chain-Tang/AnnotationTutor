import type {
  BoardObject,
  BoardPoint,
  BoardSemanticKind,
  InkStroke,
} from "./board-types.js";

export type StrokeClassification = {
  kind: BoardSemanticKind;
  confidence: number;
};

function distance(a: BoardPoint, b: BoardPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Fast, local-only gesture classifier. Unknown ink remains untouched. */
export function classifyBoardStroke(
  object: BoardObject,
  stroke: InkStroke,
): StrokeClassification {
  const points = stroke.points;
  if (points.length < 2) return { kind: "unknown", confidence: 0 };
  let length = 0;
  for (let index = 1; index < points.length; index++)
    length += distance(points[index - 1]!, points[index]!);
  const first = points[0]!;
  const last = points.at(-1)!;
  const chord = distance(first, last);
  const diagonal = Math.hypot(object.width, object.height) || 1;
  const straightness = chord / Math.max(length, 1);
  const aspect = Math.max(object.width, object.height) /
    Math.max(1, Math.min(object.width, object.height));
  if (straightness > 0.965 && length > 10) {
    if (object.brush?.kind === "highlighter")
      return { kind: "highlight", confidence: Math.min(0.99, straightness) };
    if (object.width > object.height * 3)
      return { kind: "underline", confidence: Math.min(0.96, straightness) };
    return { kind: "line", confidence: Math.min(0.96, straightness) };
  }
  const closure = chord / diagonal;
  if (closure < 0.22 && points.length >= 8) {
    let corners = 0;
    const stride = Math.max(1, Math.floor(points.length / 24));
    for (let index = stride; index + stride < points.length; index += stride) {
      const a = points[index - stride]!;
      const b = points[index]!;
      const c = points[index + stride]!;
      const angle = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
      const turn = Math.min(angle, Math.PI * 2 - angle);
      if (turn > 0.65) corners++;
    }
    if (corners >= 3 && corners <= 7 && aspect < 4)
      return { kind: "rect", confidence: Math.min(0.92, 0.65 + corners * 0.04) };
    if (aspect < 4)
      return { kind: aspect < 1.35 ? "circle" : "ellipse", confidence: Math.max(0.65, 0.93 - closure) };
  }
  // Most short freehand input is handwriting. A conservative confidence keeps
  // automatic shape suggestions from replacing ink without confirmation.
  if (diagonal < 220 && length < 900)
    return { kind: "handwriting", confidence: 0.58 };
  return { kind: "unknown", confidence: 0.3 };
}

export function shouldMergeSemanticStrokes(
  prior: { object: BoardObject; stroke: InkStroke },
  next: { object: BoardObject; stroke: InkStroke },
): boolean {
  const a = prior.object.anchor;
  const b = next.object.anchor;
  const sameAnchor = a.kind === b.kind && (
    a.kind === "pdf" ? a.page === (b as typeof a).page :
      a.kind === "canvas" ? a.pageId === (b as typeof a).pageId :
        a.key === (b as typeof a).key
  );
  if (!sameAnchor) return false;
  const priorTime = prior.stroke.points.at(-1)?.t;
  const nextTime = next.stroke.points[0]?.t;
  if (priorTime !== undefined && nextTime !== undefined && nextTime - priorTime > 1400)
    return false;
  const gapX = Math.max(0, next.object.x - prior.object.x - prior.object.width, prior.object.x - next.object.x - next.object.width);
  const gapY = Math.max(0, next.object.y - prior.object.y - prior.object.height, prior.object.y - next.object.y - next.object.height);
  return Math.hypot(gapX, gapY) <= Math.max(36, (prior.object.height + next.object.height) * 1.5);
}
