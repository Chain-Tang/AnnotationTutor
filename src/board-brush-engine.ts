import type { BoardBrushKind, BoardBrushStyle, BoardPoint } from "./board-types.js";
import { generateBrushDabs, renderBrushDabs, brushDabColor, type BoardBrushDab } from "./board-paint.js";

/** Decoded resources are supplied by the host. This module never reads a Vault or URL. */
export type BrushResources = ReadonlyMap<string, CanvasImageSource>;
export type BrushRenderResult = { drawn: boolean; missing: string[] };
export interface BrushEngine {
  readonly version: number;
  render(context: CanvasRenderingContext2D, points: readonly BoardPoint[], style: BoardBrushStyle,
    width: number, color: string, resources?: BrushResources, worldOrigin?: { x: number; y: number }): BrushRenderResult;
}

export function missingBrushResources(style: BoardBrushStyle, resources?: BrushResources): string[] {
  if (style.engineVersion !== 2) return [];
  return [style.tipHash, style.grainHash, style.paperHash]
    .filter((hash): hash is string => !!hash && !resources?.has(hash));
}

const texturedKinds = new Set<BoardBrushKind>(["pencil", "chalk", "crayon", "watercolor", "sumi", "oil"]);
export function brushNeedsRaster(style: BoardBrushStyle): boolean {
  return style.engineVersion === 2 && (!!(style.tipHash || style.grainHash || style.paperHash) || texturedKinds.has(style.kind));
}

const proceduralCache = new WeakMap<Document, Map<BoardBrushKind, HTMLCanvasElement>>();
function paperTooth(document: Document, kind: BoardBrushKind): HTMLCanvasElement {
  let cache = proceduralCache.get(document);
  if (!cache) { cache = new Map(); proceduralCache.set(document, cache); }
  const existing = cache.get(kind); if (existing) return existing;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("brush-paper-canvas-unavailable");
  const image = context.createImageData(128, 128);
  const hash = (x: number, y: number): number => {
    let value = Math.imul(x + 137, 73856093) ^ Math.imul(y + 263, 19349663);
    value ^= value >>> 16; value = Math.imul(value, 2246822519); value ^= value >>> 13;
    return (value >>> 0) / 0xffffffff;
  };
  const grain = kind === "chalk" ? 5 : kind === "watercolor" ? 9 : kind === "oil" ? 3 : 2;
  const strength = kind === "chalk" ? 0.72 : kind === "pencil" ? 0.52 : kind === "crayon" ? 0.42 : kind === "watercolor" ? 0.25 : kind === "sumi" ? 0.28 : 0.12;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const fine = hash(x, y), coarse = hash(Math.floor(x / grain), Math.floor(y / grain));
    const tooth = kind === "watercolor" ? coarse * 0.75 + fine * 0.25 : fine * 0.55 + coarse * 0.45;
    const offset = (y * 128 + x) * 4;
    image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 255;
    image.data[offset + 3] = Math.round(255 * (1 - strength * (1 - tooth)));
  }
  context.putImageData(image, 0, 0); cache.set(kind, canvas); return canvas;
}

function textureCanvas(document: Document, source: CanvasImageSource, strength: number): HTMLCanvasElement {
  const dimensions = source as { width: number; height: number };
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width; canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("brush-texture-canvas-unavailable");
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const luminance = (image.data[offset]! * 0.2126 + image.data[offset + 1]! * 0.7152 + image.data[offset + 2]! * 0.0722) / 255;
    const opacity = image.data[offset + 3]! / 255;
    image.data[offset] = 255; image.data[offset + 1] = 255; image.data[offset + 2] = 255;
    image.data[offset + 3] = Math.round(255 * (1 - strength * (1 - luminance * opacity)));
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

const maskCache = new WeakMap<Document, Map<string, HTMLCanvasElement>>();
function trimCanvasCache(cache: Map<string, HTMLCanvasElement>, maxEntries: number, maxPixels: number): void {
  let pixels = 0;
  for (const canvas of cache.values()) pixels += canvas.width * canvas.height;
  while ((cache.size > maxEntries || pixels > maxPixels) && cache.size > 1) {
    const oldest = cache.keys().next().value!;
    const canvas = cache.get(oldest)!;
    pixels -= canvas.width * canvas.height;
    cache.delete(oldest);
  }
}
function cachedMask(document: Document, hash: string, source: CanvasImageSource, strength: number): HTMLCanvasElement {
  let cache = maskCache.get(document);
  if (!cache) { cache = new Map(); maskCache.set(document, cache); }
  const key = `${hash}:${strength.toFixed(3)}`;
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  const canvas = textureCanvas(document, source, strength);
  cache.set(key, canvas);
  trimCanvasCache(cache, 24, 8_000_000);
  return canvas;
}

const tipCache = new WeakMap<Document, Map<string, HTMLCanvasElement>>();
function tintedTip(document: Document, hash: string, source: CanvasImageSource, color: string): HTMLCanvasElement {
  let cache = tipCache.get(document);
  if (!cache) { cache = new Map(); tipCache.set(document, cache); }
  const key = `${hash}:${color}`;
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  const dimensions = source as { width: number; height: number };
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width; canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("brush-tip-canvas-unavailable");
  context.drawImage(source, 0, 0);
  // Transparent PNG tips use their authored alpha (including white soft tips).
  // Opaque grayscale tips use darkness as coverage, like black-on-white scans.
  const mask = context.getImageData(0, 0, canvas.width, canvas.height);
  let transparentPixels = 0;
  for (let offset = 3; offset < mask.data.length; offset += 4) {
    if (mask.data[offset]! < 128) transparentPixels++;
  }
  const hasTransparency = transparentPixels > mask.data.length / 400;
  if (!hasTransparency) for (let offset = 0; offset < mask.data.length; offset += 4) {
    const luminance = (mask.data[offset]! * 0.2126 + mask.data[offset + 1]! * 0.7152 + mask.data[offset + 2]! * 0.0722) / 255;
    mask.data[offset + 3] = Math.round(mask.data[offset + 3]! * (1 - luminance));
  }
  context.putImageData(mask, 0, 0);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  cache.set(key, canvas);
  trimCanvasCache(cache, 32, 8_000_000);
  return canvas;
}

export function renderRawBrushDabs(context: CanvasRenderingContext2D, dabs: readonly BoardBrushDab[],
  style: BoardBrushStyle, color: string, resources?: BrushResources): void {
  const tip = style.tipHash ? resources?.get(style.tipHash) : undefined;
  const document = context.canvas?.ownerDocument;
  if (!tip || !document) {
    renderBrushDabs(context, dabs, color, context.globalCompositeOperation, style.preventSelfOverlap);
    return;
  }
  for (const dab of dabs) {
    if (dab.alpha <= 0) continue;
    if (dab.shape === "ring") { renderBrushDabs(context, [dab], color, context.globalCompositeOperation); continue; }
    const stamp = tintedTip(document, style.tipHash!, tip, brushDabColor(color, dab.tone));
    context.save(); context.globalAlpha *= dab.alpha;
    context.translate(dab.x, dab.y); context.rotate(dab.rotation);
    context.drawImage(stamp, -dab.radiusX, -dab.radiusY, dab.radiusX * 2, dab.radiusY * 2);
    context.restore();
  }
}

/** Applies fixed board-space tooth after raw ink has accumulated. */
export function applyBrushTextureMask(context: CanvasRenderingContext2D, style: BoardBrushStyle,
  resources: BrushResources | undefined, bounds: { x: number; y: number; width: number; height: number },
  worldOrigin = { x: 0, y: 0 }): void {
  const document = context.canvas?.ownerDocument;
  if (!document) return;
  const masks: HTMLCanvasElement[] = [];
  for (const [hash, strength] of [[style.grainHash, style.grainStrength ?? 0.6], [style.paperHash, 0.45]] as const) {
    if (hash && strength > 0 && resources?.has(hash)) masks.push(cachedMask(document, hash, resources.get(hash)!, strength));
  }
  if (texturedKinds.has(style.kind) && !style.paperHash) masks.push(paperTooth(document, style.kind));
  for (const mask of masks) {
    const pattern = context.createPattern(mask, "repeat"); if (!pattern) continue;
    context.save(); context.globalCompositeOperation = "destination-in";
    context.translate(-worldOrigin.x, -worldOrigin.y);
    context.fillStyle = pattern;
    context.fillRect(bounds.x + worldOrigin.x, bounds.y + worldOrigin.y, bounds.width, bounds.height);
    context.restore();
  }
}

/** Legacy snapshots always use their original geometry renderer. */
export const legacyBrushEngine: BrushEngine = {
  version: 1,
  render(context, points, style, width, color) {
    renderBrushDabs(context, generateBrushDabs(points, style, width), color, context.globalCompositeOperation, style.preventSelfOverlap);
    return { drawn: true, missing: [] };
  },
};

/** Resource-backed v2 engine. Rasterisation is bounded; textures are locked to board coordinates. */
export const resourceBrushEngine: BrushEngine = {
  version: 2,
  render(context, points, style, width, color, resources, worldOrigin = { x: 0, y: 0 }) {
    const missing = missingBrushResources(style, resources);
    if (missing.length) return { drawn: false, missing };
    const dabs = generateBrushDabs(points, style, width);
    if (!dabs.length) return { drawn: false, missing: [] };
    const document = context.canvas?.ownerDocument;
    if (!document || !brushNeedsRaster(style)) {
      renderBrushDabs(context, dabs, color, context.globalCompositeOperation, style.preventSelfOverlap);
      return { drawn: true, missing: [] };
    }
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const dab of dabs) {
      left = Math.min(left, dab.x - dab.radiusX - 2); top = Math.min(top, dab.y - dab.radiusY - 2);
      right = Math.max(right, dab.x + dab.radiusX + 2); bottom = Math.max(bottom, dab.y + dab.radiusY + 2);
    }
    left = Math.floor(left); top = Math.floor(top); right = Math.ceil(right); bottom = Math.ceil(bottom);
    const widthPx = Math.max(1, right - left), heightPx = Math.max(1, bottom - top);
    const scale = Math.min(1, 4096 / Math.max(widthPx, heightPx), Math.sqrt(12_000_000 / (widthPx * heightPx)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(widthPx * scale)); canvas.height = Math.max(1, Math.ceil(heightPx * scale));
    const paint = canvas.getContext("2d");
    if (!paint) return { drawn: false, missing: [] };
    paint.scale(canvas.width / widthPx, canvas.height / heightPx);
    paint.translate(-left, -top);
    renderRawBrushDabs(paint, dabs, style, color, resources);
    applyBrushTextureMask(paint, style, resources, { x: left, y: top, width: widthPx, height: heightPx }, worldOrigin);
    context.drawImage(canvas, left, top, widthPx, heightPx);
    return { drawn: true, missing: [] };
  },
};

export function brushEngineFor(style: BoardBrushStyle): BrushEngine {
  return style.engineVersion === 2 ? resourceBrushEngine : legacyBrushEngine;
}
