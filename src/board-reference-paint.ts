import type { BoardAnchor, BoardObject, BoardRect, BoardPoint } from './board-types.js';
import { defaultBoardBrush } from './board-brushes.js';
import { traceReferenceRegions, type ReferencePixels } from './board-reference-regions.js';
import { referencePaintPresets, referencePaintStyleSchema, type ReferencePaintStyle } from './board-reference-style.js';
export type { ReferencePixels } from './board-reference-regions.js';

/** Native region geometry plus independent brush contours. The fill stores its
 * brush recipe, never a bitmap. Display/export replay the same clipped strokes. */
export function reconstructReference(
  image: ReferencePixels, target: BoardRect, anchor: BoardAnchor, groupId: string,
  budget = 6000, style: ReferencePaintStyle = referencePaintPresets.illustration,
): { objects: BoardObject[]; samplingWidth: number; samplingHeight: number; regionCount: number } {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 ||
      image.width * image.height > 1_000_000 || image.data.length !== image.width * image.height * 4)
    throw new Error('invalid-reference-pixels');
  if (![target.x,target.y,target.width,target.height].every(Number.isFinite) || target.width <= 0 || target.height <= 0 || target.width > 2000 || target.height > 2000)
    throw new Error('invalid-reference-target');
  if (!Number.isInteger(budget) || budget < 32 || budget > 10000) throw new Error('invalid-stroke-budget');
  style = referencePaintStyleSchema.parse(style);
  let size = Math.min(384, Math.max(image.width, image.height)), palette = 32, minArea = 8;
  for (;;) {
    const traced = traceReferenceRegions(image, size, palette, minArea);
    const dx = target.width / traced.width, dy = target.height / traced.height;
    const fills: BoardObject[] = [], outlines: BoardObject[] = [];
    let sequence = 0;
    const object = (points: BoardPoint[], color: string): BoardObject => {
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
      return { id: `${groupId}-${sequence++}`, kind: 'path', anchor: structuredClone(anchor),
        x: target.x + x * dx, y: target.y + y * dy, width: width * dx, height: height * dy,
        points: points.map(p => ({ x: (p.x - x) * dx, y: (p.y - y) * dy })), color, strokeWidth: .1,
        createdBy: 'tutor', editedBy: 'tutor', revision: 1, groupId, selectionGroupId: groupId };
    };
    for (const region of traced.regions) {
      const loops = region.loops.filter(loop => loop.length >= 3);
      if (!loops.length) continue;
      // Retraced zero-width bridges join opposite-winding loops in one native
      // path. They cancel under nonzero fill; transparent holes stay holes.
      const start = loops[0]![0]!, points: BoardPoint[] = [start];
      for (const loop of loops) points.push(loop[0]!, ...loop.slice(1), loop[0]!, start);
      if (points.length > 19000) throw new Error('reference-contour-too-complex');
      const fill = object(points, '#00000000');
      const rgb = [1,3,5].map(i => parseInt(region.color.slice(i, i + 2), 16));
      const material = style.colorMode === 'brush' && (region.area >= 24 || image.width*image.height<=64) && Math.min(fill.width,fill.height)>2 && Math.min(...rgb)<245;
      fill.fill = { kind: material ? 'brush' : 'solid', color: region.color, opacity: 1, seed: sequence,
        ...(material ? { brush: { ...defaultBoardBrush(style.colorBrush, sequence), pressure: false,
          ...(style.colorBrush === 'watercolor' ? {opacity:.9,flow:.38,pressureFlow:0,pressureOpacity:0} : {}) } } : {}) };
      fills.push(fill);
      // Avoid outlining the outer white paper, palette speckles or shading
      // slivers. Contours keep their source colour instead of adding black edges.
      if (region.area < 12 || Math.min(...rgb) > 242) continue;
      for (const loop of loops) {
        const contour = object([...loop, loop[0]!], region.color);
        if (Math.max(contour.width, contour.height) < Math.min(dx, dy) * 3) continue;
        contour.color = '#' + rgb.map(v => Math.round(v * .96).toString(16).padStart(2, '0')).join('');
        contour.strokeWidth = Math.max(.45, Math.min(1.4, Math.min(dx, dy) * .85));
        contour.brush = { ...defaultBoardBrush(style.outlineBrush, sequence), pressure: false, pressureSize: 0,
          smoothing: .45, streamline: 0, opacity: 1, spacing: .16 };
        outlines.push(contour);
      }
    }
    const objects = [...fills, ...outlines];
    if (objects.length <= Math.min(budget,1200)) return { objects, samplingWidth: traced.width, samplingHeight: traced.height, regionCount: fills.length };
    // Budget controls complete regions, never truncates the bottom of the image.
    if (palette > 10) { palette = Math.max(10, Math.floor(palette * .65)); minArea *= 2; }
    else if (size > 8) size = Math.max(8, Math.floor(size * .75));
    else throw new Error('reference-stroke-budget-exceeded');
  }
}

/** A cancellable preview, then exactly one host commit. Frame count is bounded. */
export async function playReferenceStrokes(objects: readonly BoardObject[], options: {
  signal?: AbortSignal; valid:()=>boolean; instant:()=>boolean;
  preview:(objects:readonly BoardObject[])=>void; wait:()=>Promise<void>;
}): Promise<void> {
  for (let count=0;count<objects.length;) {
    if (options.signal?.aborted || !options.valid()) throw new Error('reference-paint-cancelled');
    count=options.instant()?objects.length:Math.min(objects.length,count+Math.max(1,Math.ceil(objects.length/120)));
    options.preview(objects.slice(0,count));
    await options.wait();
  }
  if (options.signal?.aborted || !options.valid()) throw new Error('reference-paint-cancelled');
}
