import { generateBrushDabs, type BoardBrushDab } from './board-paint.js';
import type { BoardFillStyle } from './board-types.js';

const cached = new WeakMap<BoardFillStyle, Map<string, BoardBrushDab[]>>();
/** Bounded, continuous native brush passes, later clipped to the shape. Unlike
 * scanline reconstruction these passes colour a whole region, not individual
 * sampled pixels. The same seed/recipe is used on screen and in SVG exports. */
export function regionBrushDabs(width: number, height: number, fill: BoardFillStyle): BoardBrushDab[] {
  if (!fill.brush || width <= 0 || height <= 0) return [];
  const key = JSON.stringify([width, height, fill]);
  let entries = cached.get(fill); if (!entries) { entries = new Map(); cached.set(fill, entries); }
  const prior = entries.get(key); if (prior) return prior;
  const brush = fill.brush, extent = Math.hypot(width, height);
  // Tiny regions need a few broad passes, not the same thousands of grains as
  // a large colour field. Keep the recipe independent of zoom/DPR.
  const size = Math.max(6, extent / 8), gap = size * (brush.kind === 'watercolor' ? .58 : brush.kind === 'oil' ? .4 : .48);
  const angle = brush.kind === 'crayon' ? -.55 : brush.kind === 'oil' ? -.2 : .08;
  const cos = Math.cos(angle), sin = Math.sin(angle), dabs: BoardBrushDab[] = [];
  let index = 0;
  for (let y = -extent / 2 - size; y <= extent / 2 + size; y += gap) {
    const points = [0, .25, .5, .75, 1].map((t, i) => {
      const x = (t - .5) * (extent + 2 * size), wave = Math.sin(t * Math.PI * 2 + index * .8) * size * .045;
      return { x: width / 2 + x * cos - (y + wave) * sin, y: height / 2 + x * sin + (y + wave) * cos,
        pressure: .6, t: i * 120 };
    });
    if (index % 2) { points.reverse(); points.forEach((p, i) => { p.t = i * 120; }); }
    dabs.push(...generateBrushDabs(points, { ...brush, seed: (fill.seed + index * 7919) >>> 0,
      pressure: false, pressureSize: 0, spacing: Math.max(.35, brush.spacing ?? .35),
      nibAngle: angle, roundness: brush.kind === 'oil' ? .65 : brush.roundness,
    }, size));
    index++;
  }
  // Avoid generating off-clip paint at display/export time.
  const bounded = dabs.filter(d => d.x + Math.max(d.radiusX, d.radiusY) >= 0 && d.y + Math.max(d.radiusX, d.radiusY) >= 0 &&
    d.x - Math.max(d.radiusX, d.radiusY) <= width && d.y - Math.max(d.radiusX, d.radiusY) <= height);
  entries.set(key, bounded); if (entries.size > 2) entries.delete(entries.keys().next().value!);
  return bounded;
}
