import type { BoardBrushKind, BoardBrushStyle, BoardPaintOperation, BoardPoint, BoardRect } from "./board-types.js";

export const BOARD_TILE_SIZE = 512 as const;
export const BOARD_TILE_GUTTER = 2;

export type BoardBrushDab = {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
  alpha: number;
  shape: "ellipse" | "rect" | "ring";
  hardness: number;
  grain: number;
  /** Ephemeral, bounded colour shift used by impasto bristle ridges. */
  tone?: number;
};

export type ResolvedBoardBrush = Required<Omit<BoardBrushStyle, "resourceHashes" | "engineVersion" | "tipHash" | "grainHash" | "paperHash">> & {
  resourceHashes: string[];
  engineVersion?: 2;
};

const defaults: Record<BoardBrushKind, Partial<ResolvedBoardBrush>> = {
  pen: { flow: 1, hardness: 1, spacing: 0.12, roundness: 1, pressureSize: 0.85, pressureFlow: 0, pressureOpacity: 0 },
  fountain: { flow: 1, hardness: 1, spacing: 0.1, roundness: 0.22, pressureSize: 0.3, pressureFlow: 0, pressureOpacity: 0, nibAngle: -Math.PI / 4 },
  pencil: { flow: 0.24, hardness: 0.7, spacing: 0.09, roundness: 0.7, scatter: 0.35, grainScale: 0.7, grainStrength: 0.72, pressureSize: 0.3, pressureFlow: 0.9, pressureOpacity: 0.65 },
  marker: { flow: 0.72, hardness: 0.92, spacing: 0.13, roundness: 0.35, pressureSize: 0.12, pressureFlow: 0.15, pressureOpacity: 0.08 },
  highlighter: { flow: 0.32, hardness: 0.88, spacing: 0.16, roundness: 0.2, pressureSize: 0, pressureFlow: 0, pressureOpacity: 0, preventSelfOverlap: true },
  chalk: { flow: 0.25, hardness: 0.55, spacing: 0.08, roundness: 0.9, scatter: 0.8, grainScale: 1.2, grainStrength: 0.88, pressureSize: 0.35, pressureFlow: 0.85, pressureOpacity: 0.6 },
  crayon: { flow: .65, hardness: .88, spacing: .13, roundness: .72, scatter: .04, grainScale: .7, grainStrength: .65, pressureSize: .2, pressureFlow: .3, pressureOpacity: .1 },
  watercolor: { flow: 0.12, hardness: 0.18, spacing: 0.1, roundness: 0.82, scatter: 0.12, grainScale: 2, grainStrength: 0.42, pressureSize: 0.35, pressureFlow: 0.55, pressureOpacity: 0.45 },
  sumi: { flow: 0.62, hardness: 0.55, spacing: 0.075, roundness: 0.3, scatter: 0.08, grainStrength: 0.36, pressureSize: 0.88, pressureFlow: 0.72, pressureOpacity: 0.42, bristleDensity: 0.55, dryness: 0.32, nibAngle: -Math.PI / 4 },
  oil: { flow: 0.78, hardness: 0.86, spacing: 0.075, roundness: 0.42, scatter: 0.03, grainStrength: 0.16, pressureSize: 0.35, pressureFlow: 0.25, pressureOpacity: 0.08, bristleDensity: 0.68, dryness: 0.18, impasto: 0.62, nibAngle: -Math.PI / 4 },
};

export function resolveBoardBrush(style: BoardBrushStyle): ResolvedBoardBrush {
  const preset = defaults[style.kind];
  return {
    kind: style.kind,
    opacity: style.opacity,
    pressure: style.pressure,
    smoothing: style.smoothing,
    streamline: style.streamline,
    nibAngle: style.nibAngle ?? preset.nibAngle ?? 0,
    flow: style.flow ?? preset.flow ?? 1,
    hardness: style.hardness ?? preset.hardness ?? 1,
    spacing: style.spacing ?? preset.spacing ?? 0.1,
    roundness: style.roundness ?? preset.roundness ?? 1,
    scatter: style.scatter ?? preset.scatter ?? 0,
    grainScale: style.grainScale ?? preset.grainScale ?? 1,
    grainStrength: style.grainStrength ?? preset.grainStrength ?? 0,
    stabilization: style.stabilization ?? 0,
    pressureSize: style.pressureSize ?? preset.pressureSize ?? 0,
    pressureFlow: style.pressureFlow ?? preset.pressureFlow ?? 0,
    pressureOpacity: style.pressureOpacity ?? preset.pressureOpacity ?? 0,
    bristleDensity: style.bristleDensity ?? preset.bristleDensity ?? 0,
    dryness: style.dryness ?? preset.dryness ?? 0,
    impasto: style.impasto ?? preset.impasto ?? 0,
    preventSelfOverlap: style.preventSelfOverlap ?? preset.preventSelfOverlap ?? false,
    resourceHashes: [...(style.resourceHashes ?? [])],
    engineVersion: style.engineVersion,
    seed: style.seed >>> 0,
  };
}

function randomFactory(seed: number): () => number {
  let value = seed >>> 0 || 0x9e3779b9;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

function pressureOf(point: BoardPoint, brush: ResolvedBoardBrush): number {
  return brush.pressure ? Math.max(0.02, Math.min(1, point.pressure ?? 0.5)) : 0.5;
}

function interpolate(a: BoardPoint, b: BoardPoint, ratio: number): BoardPoint {
  const mix = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? y ?? 0) + ((y ?? x ?? 0) - (x ?? y ?? 0)) * ratio;
  return {
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
    pressure: mix(a.pressure, b.pressure),
    t: mix(a.t, b.t),
    tiltX: mix(a.tiltX, b.tiltX),
    tiltY: mix(a.tiltY, b.tiltY),
    twist: mix(a.twist, b.twist),
  };
}

/** Deterministic, distance-resampled dabs. Identical samples and brush snapshots replay bit-for-bit. */
export function generateBrushDabs(
  points: readonly BoardPoint[],
  style: BoardBrushStyle,
  size: number,
): BoardBrushDab[] {
  if (!points.length || size <= 0) return [];
  const brush = resolveBoardBrush(style);
  const random = randomFactory(brush.seed);
  const samples: Array<{ point: BoardPoint; angle: number; speed: number; progress: number }> = [];
  const step = Math.max(0.35, size * brush.spacing);
  let carry = 0;
  if (points.length === 1) samples.push({ point: points[0]!, angle: brush.nibAngle, speed: 0, progress: 0 });
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!;
    const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
    if (!distance) continue;
    const angle = Math.atan2(dy, dx);
    const elapsed = Math.max(1, (b.t ?? index * 16) - (a.t ?? (index - 1) * 16));
    const speed = Math.min(1, distance / elapsed / Math.max(0.12, size / 18));
    for (let walked = step - carry; walked <= distance; walked += step)
      samples.push({ point: interpolate(a, b, walked / distance), angle, speed, progress: (index - 1 + walked / distance) / Math.max(1, points.length - 1) });
    carry = (carry + distance) % step;
  }
  if (!samples.length) samples.push({ point: points.at(-1)!, angle: brush.nibAngle, speed: 0, progress: 1 });

  return materialSamples(samples,brush,size,random);
}

type DabSample={point:BoardPoint;angle:number;speed:number;progress:number};
function materialSamples(samples:readonly DabSample[],brush:ResolvedBoardBrush,size:number,random:()=>number):BoardBrushDab[]{
  const output: BoardBrushDab[] = [];
  for (const { point, angle, speed, progress } of samples) {
    const pressure = pressureOf(point, brush);
    const diameter = size * (1 - brush.pressureSize + brush.pressureSize * pressure);
    const alpha = Math.min(1, brush.opacity * brush.flow *
      (1 - brush.pressureFlow + brush.pressureFlow * pressure) *
      (1 - brush.pressureOpacity + brush.pressureOpacity * pressure));
    const tilt = Math.min(1, Math.hypot(point.tiltX ?? 0, point.tiltY ?? 0) / 90);
    const scatter = diameter * brush.scatter;
    const place = (radiusX: number, radiusY: number, rotation: number, amount: number, shape: BoardBrushDab["shape"], hardness = brush.hardness, grain = brush.grainStrength, offsetX = 0, offsetY = 0, tone?: number) => {
      output.push({
        x: point.x + offsetX + (random() - 0.5) * scatter,
        y: point.y + offsetY + (random() - 0.5) * scatter,
        radiusX: Math.max(0.15, radiusX),
        radiusY: Math.max(0.15, radiusY),
        rotation,
        alpha: Math.max(0, Math.min(1, alpha * amount)),
        shape,
        hardness,
        grain,
        ...(tone === undefined ? {} : { tone: Math.max(-1, Math.min(1, tone)) }),
      });
    };
    switch (brush.kind) {
      case "pen":
        place(diameter / 2, diameter / 2, angle, 1, "ellipse");
        break;
      case "fountain": {
        const tiltAngle = point.tiltX || point.tiltY ? Math.atan2(point.tiltY ?? 0, point.tiltX ?? 0) : brush.nibAngle;
        place(diameter / 2, diameter * Math.max(0.08, brush.roundness * (1 - tilt * 0.45)) / 2, tiltAngle, 1, "ellipse");
        break;
      }
      case "pencil":
        for (let grain = 0; grain < 4; grain++) place(diameter * (0.12 + random() * 0.13), diameter * (0.08 + random() * 0.1), angle + random() * 0.5, 0.45 + random() * 0.45, "ellipse", 0.65, 0.9);
        break;
      case "marker":
        place(diameter / 2, diameter * brush.roundness / 2, brush.nibAngle || angle, 0.88, "rect", 0.94, 0.05);
        place(diameter / 2, Math.max(0.5, diameter * brush.roundness * 0.08), brush.nibAngle || angle, 0.2, "rect", 1, 0);
        break;
      case "highlighter":
        place(diameter / 2, diameter * brush.roundness / 2, brush.nibAngle || angle, 1, "rect", 0.9, 0);
        break;
      case "chalk":
        if (random() > 0.16)
          for (let grain = 0; grain < 7; grain++) place(diameter * (0.035 + random() * 0.12), diameter * (0.035 + random() * 0.12), random() * Math.PI, 0.25 + random() * 0.65, "ellipse", 0.6, 1);
        break;
      case "crayon":
        // Dense wax body with fine paper-tooth skips, unlike loose chalk dust.
        place(diameter * .5, diameter * .36, angle, .82, "ellipse", .88, .36);
        for (let grain = 0; grain < 3; grain++) {
          const offset = (random() - .5) * diameter * .7;
          place(diameter * .09, diameter * (.04 + random() * .07), angle, .28 + random() * .3,
            "rect", 1, .8, -Math.sin(angle) * offset, Math.cos(angle) * offset, (random() - .5) * .1);
        }
        break;
      case "watercolor":
        place(diameter * 0.64, diameter * 0.5, angle + (random() - 0.5) * 0.25, 0.44, "ellipse", 0.08, 0.35);
        place(diameter * 0.55, diameter * 0.43, angle, 0.32, "ellipse", 0.12, 0.22);
        place(diameter * 0.67, diameter * 0.52, angle, 0.14, "ellipse", 0.82, 0.12);
        if (brush.engineVersion === 2 && speed < 0.72)
          place(diameter * 0.69, diameter * 0.54, angle, 0.16 * (1 - speed * 0.5), "ring", 0.72, 0.15, 0, 0, -0.16);
        break;
      case "sumi": {
        const tiltAngle = point.tiltX || point.tiltY
          ? Math.atan2(point.tiltY ?? 0, point.tiltX ?? 0)
          : (point.twist !== undefined ? point.twist * Math.PI / 180 : angle * 0.72 + brush.nibAngle * 0.28);
        const dry = Math.min(0.94, brush.dryness * (0.35 + speed * 1.05));
        const pooling = (progress < 0.1 || progress > 0.9) && speed < 0.42 ? 1.2 : 1;
        if (random() > dry * 0.46)
          place(diameter * 0.54, diameter * brush.roundness * 0.72, tiltAngle, 0.7 * pooling, "ellipse", 0.48, 0.3);
        const hairs = 3 + Math.round(brush.bristleDensity * 7);
        const nx = -Math.sin(tiltAngle), ny = Math.cos(tiltAngle);
        for (let hair = 0; hair < hairs; hair++) {
          if (random() < dry * (0.18 + hair / hairs * 0.34)) continue;
          const lateral = (hair / Math.max(1, hairs - 1) - 0.5) * diameter * 0.78;
          place(diameter * (0.18 + random() * 0.16), Math.max(0.18, diameter * (0.018 + random() * 0.036)), tiltAngle, (0.2 + random() * 0.42) * pooling, "ellipse", 0.72, 0.48 + dry * 0.4, nx * lateral, ny * lateral);
        }
        if (pooling > 1) place(diameter * 0.62, diameter * 0.2, tiltAngle, 0.2, "ellipse", 0.12, 0.18);
        break;
      }
      case "oil": {
        const rotation = point.twist !== undefined ? point.twist * Math.PI / 180 : brush.nibAngle || angle;
        const count = 4 + Math.round(brush.bristleDensity * 12);
        const nx = -Math.sin(rotation), ny = Math.cos(rotation);
        for (let bristle = 0; bristle < count; bristle++) {
          const normalized = bristle / Math.max(1, count - 1) - 0.5;
          if (random() < brush.dryness * (0.1 + Math.abs(normalized) * 0.4)) continue;
          const lateral = normalized * diameter * 0.92;
          const ridge = Math.sin((bristle + 1) * 2.399 + brush.seed * 0.001);
          place(
            diameter * (0.2 + random() * 0.13),
            Math.max(0.2, diameter * (0.025 + (1 - brush.bristleDensity) * 0.035)),
            rotation,
            0.38 + random() * 0.42,
            "rect",
            0.94,
            0.08 + brush.dryness * 0.3,
            nx * lateral,
            ny * lateral,
            ridge * brush.impasto,
          );
        }
        place(diameter * 0.5, diameter * brush.roundness * 0.34, rotation, 0.2, "rect", 0.82, 0.12, 0, 0, -0.2 * brush.impasto);
        break;
      }
    }
  }
  return output;
}

/** Append-only sampling with the same spacing, RNG and pressure rules as final rendering.
 * Sumi's end pooling depends on the eventual total length and is deliberately excluded. */
export class BoardDabStream {
  private count=1;private carry=0;private produced=false;
  private readonly brush:ResolvedBoardBrush;private readonly random:()=>number;
  constructor(style:BoardBrushStyle,private readonly size:number){this.brush=resolveBoardBrush(style);this.random=randomFactory(this.brush.seed);if(style.kind==="sumi")throw new Error("sumi-needs-final-length");}
  append(points:readonly BoardPoint[]):BoardBrushDab[]{
    const samples:DabSample[]=[],step=Math.max(.35,this.size*this.brush.spacing);
    for(let index=this.count;index<points.length;index++){
      const a=points[index-1]!,b=points[index]!,dx=b.x-a.x,dy=b.y-a.y,distance=Math.hypot(dx,dy);if(!distance)continue;
      const elapsed=Math.max(1,(b.t??index*16)-(a.t??(index-1)*16)),speed=Math.min(1,distance/elapsed/Math.max(.12,this.size/18));
      for(let walked=step-this.carry;walked<=distance;walked+=step)samples.push({point:interpolate(a,b,walked/distance),angle:Math.atan2(dy,dx),speed,progress:0});
      this.carry=(this.carry+distance)%step;
    }
    this.count=points.length;this.produced ||= samples.length>0;return materialSamples(samples,this.brush,this.size,this.random);
  }
  get hasSamples():boolean{return this.produced;}
}

export function boardTileKey(x: number, y: number): string {
  return `${x}:${y}`;
}

export function affectedBoardTiles(bounds: BoardRect, gutter = BOARD_TILE_GUTTER): string[] {
  if (bounds.width < 0 || bounds.height < 0) return [];
  const left = Math.floor((bounds.x - gutter) / BOARD_TILE_SIZE);
  const top = Math.floor((bounds.y - gutter) / BOARD_TILE_SIZE);
  const right = Math.floor((bounds.x + bounds.width + gutter) / BOARD_TILE_SIZE);
  const bottom = Math.floor((bounds.y + bounds.height + gutter) / BOARD_TILE_SIZE);
  const keys: string[] = [];
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) keys.push(boardTileKey(x, y));
  return keys;
}

export function renderBrushDabs(
  context: CanvasRenderingContext2D,
  dabs: readonly BoardBrushDab[],
  color: string,
  composite: GlobalCompositeOperation = "source-over",
  preventSelfOverlap = false,
): void {
  context.save();
  const baseAlpha = context.globalAlpha;
  context.fillStyle = color;
  context.globalCompositeOperation = composite;
  if (preventSelfOverlap && dabs.length) {
    context.beginPath();
    for (const dab of dabs) {
      context.save();
      context.translate(dab.x, dab.y);
      context.rotate(dab.rotation);
      if (dab.shape === "rect") context.rect(-dab.radiusX, -dab.radiusY, dab.radiusX * 2, dab.radiusY * 2);
      else context.ellipse(0, 0, dab.radiusX, dab.radiusY, 0, 0, Math.PI * 2);
      context.restore();
    }
    context.globalAlpha = baseAlpha * Math.max(...dabs.map(dab => dab.alpha));
    context.fill();
    context.restore();
    return;
  }
  for (const dab of dabs) {
    if (dab.alpha <= 0) continue;
    const hash = (Math.imul(Math.round(dab.x * 97), 73856093) ^ Math.imul(Math.round(dab.y * 89), 19349663)) >>> 0;
    const grainAlpha = 1 - dab.grain * 0.34 + (hash / 0xffffffff) * dab.grain * 0.34;
    const featherSteps = dab.shape === "ellipse" && dab.hardness < 0.95 ? 4 : 1;
    context.save();
    context.fillStyle = brushDabColor(color, dab.tone);
    context.translate(dab.x, dab.y);
    context.rotate(dab.rotation);
    for (let step = 0; step < featherSteps; step++) {
      const inset = featherSteps === 1 ? 0 : (1 - dab.hardness) * 0.34 * (step / (featherSteps - 1));
      context.globalAlpha = baseAlpha * dab.alpha * grainAlpha / featherSteps;
      if (dab.shape === "rect") context.fillRect(-dab.radiusX, -dab.radiusY, dab.radiusX * 2, dab.radiusY * 2);
      else {
        context.beginPath();
        context.ellipse(0, 0, dab.radiusX * (1 - inset), dab.radiusY * (1 - inset), 0, 0, Math.PI * 2);
        if(dab.shape==="ring"){
          context.lineWidth=Math.max(0.4,Math.min(dab.radiusX,dab.radiusY)*0.12);
          context.strokeStyle=context.fillStyle;
          context.stroke();
        }else context.fill();
      }
    }
    context.restore();
  }
  context.restore();
}

/** Apply the same small, deterministic sRGB tone shift in Canvas and SVG renderers. */
export function brushDabColor(color: string, tone = 0): string {
  if (!tone) return color;
  const match = /^#([\da-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1]!, 16);
  const amount = Math.max(-1, Math.min(1, tone)) * 0.18;
  const channel = (shift: number): number => {
    const source = (value >> shift) & 0xff;
    return Math.round(amount >= 0 ? source + (255 - source) * amount : source * (1 + amount));
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** Returns a deterministic binary selection mask for contiguous pixel fills. */
export function floodFillMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number,
  alphaLocked = false,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const queued = new Uint8Array(width * height);
  const x0 = Math.floor(startX), y0 = Math.floor(startY);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height || pixels.length !== width * height * 4) return mask;
  const origin = (y0 * width + x0) * 4;
  if (alphaLocked && pixels[origin + 3] === 0) return mask;
  const target = [pixels[origin]!, pixels[origin + 1]!, pixels[origin + 2]!, pixels[origin + 3]!];
  const accepted = (offset: number) => {
    if (alphaLocked && pixels[offset + 3] === 0) return false;
    return Math.max(
      Math.abs(pixels[offset]! - target[0]!),
      Math.abs(pixels[offset + 1]! - target[1]!),
      Math.abs(pixels[offset + 2]! - target[2]!),
      Math.abs(pixels[offset + 3]! - target[3]!),
    ) <= tolerance;
  };
  const queue = new Int32Array(width * height * 2);
  let head = 0, tail = 0;
  const enqueue = (x: number, y: number) => {
    const index = y * width + x;
    if (queued[index]) return;
    queued[index] = 1;
    queue[tail++] = x; queue[tail++] = y;
  };
  enqueue(x0, y0);
  while (head < tail) {
    const x = queue[head++]!, y = queue[head++]!, index = y * width + x;
    if (mask[index] || !accepted(index * 4)) continue;
    mask[index] = 255;
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }
  return mask;
}

export class BoardTileCache<T> {
  private readonly entries = new Map<string, { revision: number; value: T; dirty: boolean }>();
  public get(layerId: string, key: string, revision: number): T | undefined {
    const entry = this.entries.get(`${layerId}:${key}`);
    return entry && !entry.dirty && entry.revision === revision ? entry.value : undefined;
  }
  public set(layerId: string, key: string, revision: number, value: T): void {
    this.entries.set(`${layerId}:${key}`, { revision, value, dirty: false });
  }
  public invalidate(operation: Pick<BoardPaintOperation, "layerId" | "affectedTiles">): void {
    for (const key of operation.affectedTiles) {
      const entry = this.entries.get(`${operation.layerId}:${key}`);
      if (entry) entry.dirty = true;
    }
  }
  public clearLayer(layerId: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(`${layerId}:`)) this.entries.delete(key);
  }
  public clear(): void { this.entries.clear(); }
}
