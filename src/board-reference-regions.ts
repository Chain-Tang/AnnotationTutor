import type { BoardPoint } from './board-types.js';

export type ReferencePixels = { width: number; height: number; data: Uint8ClampedArray };
export type ReferenceRegion = { color: string; area: number; loops: BoardPoint[][] };
type RGB = [number, number, number];
type Bin = { key: number; rgb: RGB; count: number };
const distance = (a: RGB, b: RGB): number => a.reduce((sum, v, i) => sum + (v - b[i]!) ** 2, 0);
const hex = (rgb: RGB): string => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

/** A weighted palette retains dominant colours instead of rounding each RGB
 * channel independently. All ordering/tie breaks are deterministic. */
function paletteOf(bins: Bin[], count: number): RGB[] {
  const boxes = [bins];
  const ranges = (box: Bin[]) => [0, 1, 2].map(c => {
    let min = 255, max = 0;
    for (const bin of box) { min = Math.min(min, bin.rgb[c]!); max = Math.max(max, bin.rgb[c]!); }
    return max - min;
  });
  while (boxes.length < count) {
    let index = -1, score = -1;
    boxes.forEach((box, i) => {
      const value = Math.max(...ranges(box)) * Math.sqrt(box.reduce((n, b) => n + b.count, 0));
      if (box.length > 1 && value > score) { score = value; index = i; }
    });
    if (index < 0) break;
    const box = boxes[index]!, range = ranges(box), channel = range.indexOf(Math.max(...range));
    box.sort((a, b) => a.rgb[channel]! - b.rgb[channel]! || a.key - b.key);
    const half = box.reduce((n, b) => n + b.count, 0) / 2;
    let sum = 0, cut = 1;
    for (; cut < box.length; cut++) { sum += box[cut - 1]!.count; if (sum >= half) break; }
    cut = Math.min(cut, box.length - 1);
    boxes.splice(index, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map(box => {
    const total = box.reduce((n, b) => n + b.count, 0);
    return [0, 1, 2].map(c => box.reduce((n, b) => n + b.rgb[c]! * b.count, 0) / total) as RGB;
  });
}

function simplify(points: BoardPoint[], tolerance: number): BoardPoint[] {
  if (points.length < 5) return points;
  const first = points[0]!;
  let split = 1, farthest = 0;
  points.forEach((p, i) => { const d = (p.x - first.x) ** 2 + (p.y - first.y) ** 2; if (d > farthest) { split = i; farthest = d; } });
  const open = (list: BoardPoint[]): BoardPoint[] => {
    const keep = new Set([0, list.length - 1]), stack = [[0, list.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!, p = list[a!]!, q = list[b!]!;
      const dx = q.x - p.x, dy = q.y - p.y, length = dx * dx + dy * dy;
      let best = -1, max = tolerance * tolerance;
      for (let i = a! + 1; i < b!; i++) {
        const v = list[i]!, t = length ? Math.max(0, Math.min(1, ((v.x - p.x) * dx + (v.y - p.y) * dy) / length)) : 0;
        const d = (v.x - p.x - t * dx) ** 2 + (v.y - p.y - t * dy) ** 2;
        if (d > max) { best = i; max = d; }
      }
      if (best >= 0) { keep.add(best); stack.push([a!, best], [best, b!]); }
    }
    return [...keep].sort((a, b) => a - b).map(i => list[i]!);
  };
  const reduced = [...open(points.slice(0, split + 1)).slice(0, -1), ...open([...points.slice(split), first]).slice(0, -1)];
  // Cut short stair-step corners while retaining long right-angle corners in
  // architectural/diagram art. Two passes yield a smooth native polyline.
  let smooth = reduced;
  for (let pass = 0; pass < 2; pass++) {
    const next: BoardPoint[] = [];
    smooth.forEach((p, i) => {
      const a = smooth[(i + smooth.length - 1) % smooth.length]!, b = smooth[(i + 1) % smooth.length]!;
      const u = Math.hypot(p.x - a.x, p.y - a.y), v = Math.hypot(b.x - p.x, b.y - p.y);
      const dot = u * v ? ((p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y)) / (u * v) : 1;
      if (u > 4 && v > 4 && dot < .35) next.push(p);
      else { next.push({ x: p.x * .8 + a.x * .2, y: p.y * .8 + a.y * .2 }); next.push({ x: p.x * .8 + b.x * .2, y: p.y * .8 + b.y * .2 }); }
    });
    smooth = next;
  }
  return smooth.length >= 3 ? smooth : reduced;
}

/** Connected colour regions, with opposite-winding inner loops for holes.
 * Transparent pixels never become white paint, including enclosed holes. */
export function traceReferenceRegions(image: ReferencePixels, size = 384, paletteSize = 40, minArea = 4): {
  regions: ReferenceRegion[]; width: number; height: number;
} {
  const scale = Math.min(1, size / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  const keys = new Int32Array(width * height).fill(-1), bins = new Map<number, Bin>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (Math.min(image.height - 1, Math.floor((y + .5) / scale)) * image.width + Math.min(image.width - 1, Math.floor((x + .5) / scale))) * 4;
    const alpha = image.data[p + 3]! / 255;
    if (alpha < .08) continue;
    const rgb = [0, 1, 2].map(c => image.data[p + c]! * alpha + 255 * (1 - alpha)) as RGB;
    const key = (Math.round(rgb[0]) >> 3) * 1024 + (Math.round(rgb[1]) >> 3) * 32 + (Math.round(rgb[2]) >> 3);
    keys[y * width + x] = key;
    const bin = bins.get(key);
    if (bin) { bin.count++; rgb.forEach((v, c) => { bin.rgb[c] = bin.rgb[c]! + (v - bin.rgb[c]!) / bin.count; }); }
    else bins.set(key, { key, rgb, count: 1 });
  }
  if (!bins.size) return { regions: [], width, height };
  const palette = paletteOf([...bins.values()], paletteSize), lookup = new Map<number, number>();
  for (const bin of bins.values()) {
    let closest = 0, best = Infinity;
    palette.forEach((rgb, i) => { const d = distance(bin.rgb, rgb); if (d < best) { closest = i; best = d; } });
    lookup.set(bin.key, closest);
  }
  let labels = keys.map(key => key < 0 ? -1 : lookup.get(key)!);
  // Remove isolated palette flicker inside similarly coloured areas. Strong
  // boundaries and alpha holes are not blurred into neighbouring shapes.
  for (let pass=0;pass<2;pass++) {
    const next=labels.slice();
    for (let y=1;y<height-1;y++) for(let x=1;x<width-1;x++) {
      const p=y*width+x, current=labels[p]!; if(current<0)continue;
      const votes=new Map<number,number>();
      for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const value=labels[p+oy*width+ox]!;if(value>=0)votes.set(value,(votes.get(value)??0)+1);}
      for(const [value,count] of votes)if(value!==current&&count>=5&&distance(palette[current]!,palette[value]!)<4800){next[p]=value;break;}
    }
    labels=next;
  }
  const ids = new Int32Array(labels.length).fill(-1), queue = new Int32Array(labels.length);
  const components: Array<{ color: number; area: number; parent: number }> = [];
  const neighbours = (p: number): number[] => [p % width ? p - 1 : -1, p % width < width - 1 ? p + 1 : -1, p >= width ? p - width : -1, p + width < ids.length ? p + width : -1];
  for (let p = 0; p < labels.length; p++) {
    if (labels[p]! < 0 || ids[p]! >= 0) continue;
    const id = components.length, component = { color: labels[p]!, area: 0, parent: id };
    components.push(component); ids[p] = id; queue[0] = p;
    for (let start = 0, end = 1; start < end; start++) {
      const pixel = queue[start]!; component.area++;
      for (const n of neighbours(pixel)) if (n >= 0 && ids[n] === -1 && labels[n] === component.color) { ids[n] = id; queue[end++] = n; }
    }
  }
  const root = (i: number): number => { let r = i; while (components[r]!.parent !== r) r = components[r]!.parent; while (i !== r) { const next = components[i]!.parent; components[i]!.parent = r; i = next; } return r; };
  // Merge only tiny touching islands; detached marks and transparent holes survive.
  for (let p = 0; p < ids.length; p++) {
    if (ids[p]! < 0) continue;
    const i = root(ids[p]!), item = components[i]!;
    if (item.area >= (labels.length < 256 ? 1 : minArea)) continue;
    let best = -1, score = Infinity;
    for (const n of neighbours(p)) if (n >= 0 && ids[n]! >= 0) {
      const j = root(ids[n]!); if (i === j) continue;
      const d = distance(palette[item.color]!, palette[components[j]!.color]!);
      if (d < score) { score = d; best = j; }
    }
    if (best >= 0) { item.parent = best; components[best]!.area += item.area; }
  }
  // Tiny-region merges can make formerly separate neighbours the same colour.
  // Coalesce them before tracing, otherwise a flat tree becomes hundreds of
  // independent regions despite having a single palette colour.
  for (let p=0;p<ids.length;p++) {
    if(ids[p]!<0)continue;
    for(const n of [p%width<width-1?p+1:-1,p+width<ids.length?p+width:-1]) {
      if(n<0||ids[n]!<0)continue;
      const i=root(ids[p]!),j=root(ids[n]!);if(i===j)continue;
      if(distance(palette[components[i]!.color]!,palette[components[j]!.color]!)<600) {
        const [small,big]=components[i]!.area<components[j]!.area?[i,j]:[j,i];
        components[small]!.parent=big;components[big]!.area+=components[small]!.area;
      }
    }
  }
  for (let p = 0; p < ids.length; p++) if (ids[p]! >= 0) ids[p] = root(ids[p]!);
  type Edge = { start: number; end: number; direction: number };
  const edgesByRegion = new Map<number, Edge[]>(), stride = width + 1;
  for (let p = 0; p < ids.length; p++) {
    const id = ids[p]!; if (id < 0) continue;
    const x = p % width, y = Math.floor(p / width), a = y * stride + x;
    const edges = edgesByRegion.get(id) ?? []; edgesByRegion.set(id, edges);
    if (y === 0 || ids[p - width] !== id) edges.push({ start: a, end: a + 1, direction: 0 });
    if (x === width - 1 || ids[p + 1] !== id) edges.push({ start: a + 1, end: a + stride + 1, direction: 1 });
    if (y === height - 1 || ids[p + width] !== id) edges.push({ start: a + stride + 1, end: a + stride, direction: 2 });
    if (x === 0 || ids[p - 1] !== id) edges.push({ start: a + stride, end: a, direction: 3 });
  }
  const regions: ReferenceRegion[] = [];
  for (const [id, edges] of edgesByRegion) {
    const starts = new Map<number, number[]>(), used = new Uint8Array(edges.length), loops: BoardPoint[][] = [];
    edges.forEach((edge, i) => { const list = starts.get(edge.start) ?? []; list.push(i); starts.set(edge.start, list); });
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const points: BoardPoint[] = [], first = edges[i]!.start; let next = i;
      for (let walked = 0; walked <= edges.length; walked++) {
        const edge = edges[next]!; used[next] = 1; points.push({ x: edge.start % stride, y: Math.floor(edge.start / stride) });
        if (edge.end === first) break;
        const candidates = (starts.get(edge.end) ?? []).filter(n => !used[n]);
        if (!candidates.length) throw new Error('reference-open-contour');
        const turn = (n: number) => [1, 0, 3, 2].indexOf((edges[n]!.direction - edge.direction + 4) % 4);
        candidates.sort((a, b) => turn(a) - turn(b)); next = candidates[0]!;
      }
      if (points.length >= 3) loops.push(components[id]!.area > 4 ? simplify(points, .55) : points);
    }
    regions.push({ color: hex(palette[components[id]!.color]!), area: components[id]!.area, loops });
  }
  regions.sort((a, b) => b.area - a.area);
  return { regions, width, height };
}
