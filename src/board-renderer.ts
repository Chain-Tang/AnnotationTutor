import { multiplyBoardMatrices } from "./board-surfaces.js";
import { regionBrushDabs } from "./board-brush-fill.js";
import { RoughGenerator } from "roughjs/bin/generator.js";
import type { Drawable, Op } from "roughjs/bin/core.js";
import {
  BOARD_FONT_FAMILY,
  boardFontCss,
  boardFontRevision,
  layoutBoardText,
  resolvedBoardTextStyle,
  type BoardTextLayout,
  type BoardTextMeasure,
} from "./board-fonts.js";
import { tutorCharacterPrimitives } from "./board-characters.js";
import {
  boardBrushOutline,
  brushComposite,
  brushTexture,
  visibleBoardPointSegments,
} from "./board-brushes.js";
import { brushDabColor, generateBrushDabs, renderBrushDabs, type BoardBrushDab } from "./board-paint.js";
import { brushEngineFor, brushNeedsRaster, missingBrushResources, type BrushResources } from "./board-brush-engine.js";
import { exportVectorAssetSvg, renderVectorAssetCanvas } from "./board-vector.js";
import type {
  BoardInk,
  BoardFillStyle,
  BoardBrushStyle,
  BoardBackground,
  BoardBlendMode,
  BoardLayer,
  BoardMatrix,
  BoardObject,
  BoardPoint,
  BoardTextStyle,
  BoardVectorAsset,
  TutorCharacterProfile,
} from "./board-types.js";

export function renderBoardBackgroundCanvas(
  context: CanvasRenderingContext2D,
  background: BoardBackground,
  rect: { x: number; y: number; width: number; height: number },
): void {
  context.save();
  context.globalAlpha = background.opacity;
  context.fillStyle = background.color;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  const spacing = Math.max(4, background.spacing);
  context.strokeStyle = background.kind === "dark" ? "#ffffff24" : "#6e768126";
  context.fillStyle = background.kind === "dark" ? "#ffffff35" : "#59636e38";
  context.lineWidth = 1;
  const left = Math.floor(rect.x / spacing) * spacing;
  const top = Math.floor(rect.y / spacing) * spacing;
  if (background.kind === "lined" || background.kind === "grid") {
    context.beginPath();
    for (let y = top; y <= rect.y + rect.height; y += spacing) {
      context.moveTo(rect.x, y);
      context.lineTo(rect.x + rect.width, y);
    }
    if (background.kind === "grid")
      for (let x = left; x <= rect.x + rect.width; x += spacing) {
        context.moveTo(x, rect.y);
        context.lineTo(x, rect.y + rect.height);
      }
    context.stroke();
  } else if (background.kind === "dots") {
    for (let y = top; y <= rect.y + rect.height; y += spacing)
      for (let x = left; x <= rect.x + rect.width; x += spacing) {
        context.beginPath();
        context.arc(x, y, 1.1, 0, Math.PI * 2);
        context.fill();
      }
  } else if (background.kind === "paper") {
    // Coordinate-derived noise remains identical after reopen and in exports.
    for (let y = top; y < rect.y + rect.height; y += 7)
      for (let x = left; x < rect.x + rect.width; x += 7) {
        const hash = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        if (hash % 7 === 0) context.fillRect(x + (hash % 5), y + ((hash >>> 3) % 5), 0.8, 0.8);
      }
  }
  context.restore();
}

export interface BoardRenderOptions {
  ink: BoardInk;
  /** Portable, display-only projection; never persisted into object geometry. */
  objectMatrices?: ReadonlyMap<string, BoardMatrix>;
  characters: readonly TutorCharacterProfile[];
  layers?: readonly BoardLayer[];
  background?: BoardBackground;
  resolveAsset?: (assetPath: string) => string | undefined;
  requestRender?: () => void;
  /** Prepared for this captured immutable batch only; never reused after edits. */
  pressureOutlines?: ReadonlyMap<string, Float64Array>;
  /** Await boardFontSvgCss and ensureBoardFonts before portable export. */
  fontCss?: string;
  measureText?: BoardTextMeasure;
  viewport?: { x: number; y: number; width: number; height: number };
  rasterUnderlay?: { url: string; x: number; y: number; width: number; height: number };
  vectorAssets?: readonly BoardVectorAsset[];
  brushResources?: BrushResources;
  missingBrushResource?: (hash: string) => void;
}

const normalizedPointCache = new WeakMap<readonly BoardPoint[], Map<string, BoardPoint[]>>();

type Paint = {
  stroke?: string;
  fill?: string;
  width: number;
  sketchSeed?: number;
  opacity?: number;
  texture?: "pencil" | "chalk" | "watercolor";
  textureSeed?: number;
  fillKind?: "solid" | "hachure" | "dots" | "paper";
};
interface DrawTarget {
  packedPath?(points: Float64Array, paint: Paint): void;
  push(matrix: BoardMatrix, appearance?: { opacity: number; blendMode: BoardBlendMode }): void;
  pop(): void;
  brushFill(points: readonly BoardPoint[], width: number, height: number, fill: BoardFillStyle): void;
  path(points: readonly BoardPoint[], paint: Paint, closed?: boolean): void;
  ellipse(x: number, y: number, rx: number, ry: number, paint: Paint): void;
  rect(x: number, y: number, width: number, height: number, paint: Paint): void;
  text(
    text: string,
    x: number,
    y: number,
    style: BoardTextStyle,
    color: string,
  ): void;
  image(url: string, width: number, height: number): void;
  rough(drawable: Drawable): void;
  dabs(dabs: readonly BoardBrushDab[], color: string, preventSelfOverlap?: boolean): void;
  materialPath(points: readonly BoardPoint[], style: BoardBrushStyle, width: number, color: string): void;
  vector(asset: BoardVectorAsset, width: number, height: number): void;
}

/** Stable point streams are never rewritten when a student resizes a stroke. */
export function normalizedBoardPoints(
  points: readonly BoardPoint[],
  width: number,
  height: number,
): BoardPoint[] {
  if (!points.length) return [];
  const last = points.at(-1)!;
  const key = `${width}:${height}:${points.length}:${last.x}:${last.y}:${last.pressure ?? ""}`;
  let entries = normalizedPointCache.get(points);
  if (!entries) {
    entries = new Map();
    normalizedPointCache.set(points, entries);
  }
  const cached = entries.get(key);
  if (cached) return cached;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = maxX - minX,
    spanY = maxY - minY;
  const normalized = points.map((point) => ({
    ...point,
    x: spanX > 0 ? ((point.x - minX) / spanX) * width : width / 2,
    y: spanY > 0 ? ((point.y - minY) / spanY) * height : height / 2,
  }));
  entries.set(key, normalized);
  if (entries.size > 4) entries.delete(entries.keys().next().value!);
  return normalized;
}

function objectMatrix(object: BoardObject): BoardMatrix {
  const angle = object.rotation ?? 0,
    cos = Math.cos(angle),
    sin = Math.sin(angle),fx=object.flipX?-1:1,fy=object.flipY?-1:1;
  return [cos*fx,sin*fx,-sin*fy,cos*fy,
    object.x+(object.flipX?cos*object.width:0)+(object.flipY?-sin*object.height:0),
    object.y+(object.flipX?sin*object.width:0)+(object.flipY?cos*object.height:0)];
}

type TextLayouter = (object: BoardObject) => BoardTextLayout;
const canvasTextLayouts = new WeakMap<CanvasRenderingContext2D, TextLayouter>();
function canvasTextLayout(context: CanvasRenderingContext2D): TextLayouter {
  const existing = canvasTextLayouts.get(context);
  if (existing) return existing;
  let fontRevision = boardFontRevision(context.canvas.ownerDocument);
  const layouts = new Map<string, BoardTextLayout>();
  const measure: BoardTextMeasure = (text, style) => {
    context.font = boardFontCss(style);
    return context.measureText(text).width;
  };
  const layout: TextLayouter = (object) => {
    const currentRevision = boardFontRevision(context.canvas.ownerDocument);
    if (currentRevision !== fontRevision) {
      layouts.clear();
      fontRevision = currentRevision;
    }
    const style = resolvedBoardTextStyle(object);
    const key = JSON.stringify([
      object.text ?? "",
      object.width,
      style.font,
      style.size,
      style.align,
    ]);
    const cached = layouts.get(key);
    if (cached) return cached;
    const result = layoutBoardText(
      object.text ?? "", style, object.width, measure,
    );
    layouts.set(key, result);
    if (layouts.size > 256) layouts.delete(layouts.keys().next().value!);
    return result;
  };
  canvasTextLayouts.set(context, layout);
  return layout;
}

function resolveInk(
  inkLayers: readonly BoardInk[],
  id: string,
): BoardInk[string] | undefined {
  for (const layer of inkLayers)
    if (Object.prototype.hasOwnProperty.call(layer, id)) return layer[id];
  return undefined;
}

function drawObjects(
  target: DrawTarget,
  objects: readonly BoardObject[],
  options: BoardRenderOptions & { layoutText?: TextLayouter },
  seen = new Set<string>(),
  inkLayers: readonly BoardInk[] = [options.ink],
): void {
  const layerMap = new Map(options.layers?.map(layer => [layer.id, layer]) ?? []);
  for (const object of objects) {
    const brush = object.brush;
    const layer = object.layerId ? layerMap.get(object.layerId) : undefined;
    if (layer && !layer.visible) continue;
    const opacity = (object.opacity ?? brush?.opacity ?? 1) * (layer?.opacity ?? 1);
    const blendMode = object.blendMode ?? layer?.blendMode ?? (brush ? brushComposite(brush.kind) : "normal");
    target.push(
      options.objectMatrices?.has(object.id) ? multiplyBoardMatrices(options.objectMatrices.get(object.id)!,objectMatrix(object)) : objectMatrix(object),
      opacity === 1 && blendMode === "normal" ? undefined : { opacity, blendMode },
    );
    const fill = object.fill?.kind && object.fill.kind !== "none" ? object.fill : undefined;
    if (fill?.kind === "brush" && fill.brush && ["path", "rect", "ellipse"].includes(object.kind)) {
      const boundary = object.kind === "path" ? normalizedBoardPoints(object.points ?? [], object.width, object.height)
        : object.kind === "rect" ? [{x:0,y:0},{x:object.width,y:0},{x:object.width,y:object.height},{x:0,y:object.height}]
        : Array.from({length:96},(_,i)=>({x:object.width*(1+Math.cos(i*Math.PI/48))/2,y:object.height*(1+Math.sin(i*Math.PI/48))/2}));
      target.brushFill(boundary, object.width, object.height, fill);
    }
    const paint: Paint = {
      stroke: object.color,
      width: object.strokeWidth,
      ...(fill && fill.kind !== "brush" ? {
        fill: fill.color,
        fillKind: fill.kind as "solid" | "hachure" | "dots" | "paper",
        opacity: fill.opacity,
        textureSeed: fill.seed,
      } : {}),
    };
    if (object.kind !== "ink" && object.drawingStyle?.kind === "sketch")
      paint.sketchSeed = object.drawingStyle.seed;
    switch (object.kind) {
      case "ink":
      case "path": {
        const prepared = options.pressureOutlines?.get(object.id);
        if (prepared && target.packedPath && object.kind === "ink" && object.brush?.kind === "pen" &&
          !brushNeedsRaster(object.brush) && !object.erasedRanges?.length) {
          target.packedPath(prepared, { fill: object.color, width: 0 });
          break;
        }
        const raw =
          object.kind === "ink"
            ? resolveInk(inkLayers, object.inkId ?? "")?.points
            : object.points;
        if (raw) {
          const normalized = normalizedBoardPoints(raw, object.width, object.height);
          const segments = object.kind === "ink"
            ? visibleBoardPointSegments(normalized, object.erasedRanges)
            : [normalized];
          for (const segment of segments) {
            const points = segment;
            if (points.length === 1)
            target.ellipse(
              points[0]!.x,
              points[0]!.y,
              object.strokeWidth / 2,
              object.strokeWidth / 2,
              { fill: object.color, width: 0 },
            );
            else if (object.brush && (brushNeedsRaster(object.brush) || (object.brush.kind !== "pen" &&
              !(object.brush.kind === "pencil" && object.strokeWidth <= 2)))) {
              target.materialPath(points, { ...object.brush, opacity: 1 }, object.strokeWidth, object.color);
            } else if (object.brush) {
              const outline = boardBrushOutline(segment, object, true);
              const texture = brushTexture(object.brush.kind);
              // Subpixel pencil grains are better represented by one pressure
              // outline with paper tooth. Avoid millions of tiny SVG ellipses
              // and repeated dab rendering for reference contours.
              if(texture === "pencil") target.path(outline,{fill:object.color,width:0,opacity:.55},true);
              target.path(outline, {
                fill: object.color,
                width: 0,
                ...(texture === "none" ? {} : { texture }),
                textureSeed: object.brush.seed,
                ...(texture === "pencil" ? {opacity:.45} : {}),
              }, true);
            } else target.path(points, paint, !!fill);
          }
        }
        break;
      }
      case "arrow": {
        const points = object.points?.length
          ? normalizedBoardPoints(object.points, object.width, object.height)
          : [
              { x: 0, y: 0 },
              { x: object.width, y: object.height },
            ];
        target.path(points, paint);
        const last = points.at(-1),
          prior = points.at(-2);
        if (last && prior) {
          const angle = Math.atan2(last.y - prior.y, last.x - prior.x);
          const head = Math.max(7, object.strokeWidth * 3.5);
          target.path(
            [
              {
                x: last.x - head * Math.cos(angle - Math.PI / 6),
                y: last.y - head * Math.sin(angle - Math.PI / 6),
              },
              last,
              {
                x: last.x - head * Math.cos(angle + Math.PI / 6),
                y: last.y - head * Math.sin(angle + Math.PI / 6),
              },
            ],
            paint,
          );
        }
        break;
      }
      case "rect":
        target.rect(0, 0, object.width, object.height, paint);
        break;
      case "ellipse":
        target.ellipse(
          object.width / 2,
          object.height / 2,
          object.width / 2,
          object.height / 2,
          paint,
        );
        break;
      case "text": {
        const style = resolvedBoardTextStyle(object);
        const layout = options.layoutText?.(object) ?? layoutBoardText(
          object.text ?? "",
          style,
          object.width,
          options.measureText,
        );
        for (const line of layout.lines)
          target.text(line.text, line.x, line.y, style, object.color);
        break;
      }
      case "sticker":
      case "character": {
        const id =
          object.kind === "sticker" ? object.assetId : object.characterId;
        const version =
          object.kind === "sticker"
            ? object.assetVersion
            : object.characterVersion;
        const profile = options.characters.find(
          (item) => item.id === id && item.version === version,
        );
        const key = `${id}:${version}`;
        const missing = (): void => {
          target.rect(
            1,
            1,
            Math.max(1, object.width - 2),
            Math.max(1, object.height - 2),
            { stroke: "#958d9e", width: 1 },
          );
          target.path(
            [
              { x: 1, y: 1 },
              { x: object.width - 1, y: object.height - 1 },
            ],
            { stroke: "#958d9e", width: 1 },
          );
          target.path(
            [
              { x: 1, y: object.height - 1 },
              { x: object.width - 1, y: 1 },
            ],
            { stroke: "#958d9e", width: 1 },
          );
        };
        if (!profile || seen.has(key) || seen.size >= 8) {
          missing();
          break;
        }
        if (profile.origin === "builtin") {
          target.push([object.width / 100, 0, 0, object.height / 100, 0, 0]);
          for (const shape of tutorCharacterPrimitives(
            profile.style === "book" ? "book" : "round",
            object.expression,
          )) {
            if (shape.kind === "ellipse")
              target.ellipse(shape.x, shape.y, shape.rx, shape.ry, {
                fill: shape.fill,
                stroke: shape.stroke,
                width: shape.lineWidth ?? 0,
              });
            else
              target.path(
                shape.points.map(([x, y]) => ({ x, y })),
                {
                  fill: shape.fill,
                  stroke: shape.stroke,
                  width: shape.lineWidth,
                },
                shape.closed,
              );
          }
          target.pop();
        } else if (profile.assetPath) {
          const url = options.resolveAsset?.(profile.assetPath);
          if (url) target.image(url, object.width, object.height);
          else missing();
          // Uploaded art stays intact; expression accessories sit around it.
          if (object.expression && object.expression !== "quiet") {
            const color = object.color;
            if (
              object.expression === "curious" ||
              object.expression === "thinking"
            )
              target.text(
                object.expression === "curious" ? "?" : "…",
                object.width * 0.84,
                object.height * 0.18,
                { font: "sans", size: object.height * 0.2, align: "left" },
                color,
              );
            else {
              const x = object.width * 0.91,
                y = object.height * 0.12,
                r = Math.min(object.width, object.height) * 0.06;
              target.path(
                [
                  { x: x - r, y },
                  { x: x + r, y },
                ],
                { stroke: color, width: 2 },
              );
              target.path(
                [
                  { x, y: y - r },
                  { x, y: y + r },
                ],
                { stroke: color, width: 2 },
              );
            }
          }
        } else if (profile.objects && profile.width > 0 && profile.height > 0) {
          target.push([
            object.width / profile.width,
            0,
            0,
            object.height / profile.height,
            0,
            0,
          ]);
          drawObjects(
            target,
            profile.objects,
            {...options,vectorAssets:[...(profile.vectorAssets??[]),...(options.vectorAssets??[])]},
            new Set([...seen, key]),
            profile.ink ? [profile.ink, ...inkLayers] : inkLayers,
          );
          target.pop();
        }
        break;
      }
      case "vector": {
        const asset = options.vectorAssets?.find(
          item => item.id === object.vectorAssetId && item.version === object.vectorAssetVersion,
        );
        if (asset) target.vector(asset, object.width, object.height);
        else target.rect(1, 1, Math.max(1, object.width - 2), Math.max(1, object.height - 2), {
          stroke: "#958d9e", width: 1,
        });
        break;
      }
    }
    target.pop();
  }
}

const sketchGenerator = new RoughGenerator();
const sketches = new Map<string, Drawable>();
function sketch(
  kind: "path" | "ellipse" | "rect",
  coordinates: number[],
  paint: Paint,
  closed = false,
): Drawable {
  const key = JSON.stringify([kind, coordinates, paint, closed]);
  const cached = sketches.get(key);
  if (cached) return cached;
  const options = {
    seed: Math.max(1, Math.abs(Math.trunc(paint.sketchSeed ?? 1)) % 2147483647),
    stroke: paint.stroke ?? "none",
    strokeWidth: paint.width,
    fill: paint.fill,
    fillStyle: "solid",
    roughness: 1,
    preserveVertices: true,
  };
  let result: Drawable;
  if (kind === "rect")
    result = sketchGenerator.rectangle(
      coordinates[0]!,
      coordinates[1]!,
      coordinates[2]!,
      coordinates[3]!,
      options,
    );
  else if (kind === "ellipse")
    result = sketchGenerator.ellipse(
      coordinates[0]!,
      coordinates[1]!,
      coordinates[2]!,
      coordinates[3]!,
      options,
    );
  else {
    const points: [number, number][] = [];
    for (let index = 0; index < coordinates.length; index += 2)
      points.push([coordinates[index]!, coordinates[index + 1]!]);
    result = closed
      ? sketchGenerator.polygon(points, options)
      : sketchGenerator.linearPath(points, options);
  }
  sketches.set(key, result);
  if (sketches.size > 512) sketches.delete(sketches.keys().next().value!);
  return result;
}
function roughPaint(drawable: Drawable, kind: string): Paint {
  const options = drawable.options;
  return kind === "fillPath"
    ? { fill: options.fill, width: 0 }
    : kind === "fillSketch"
      ? {
          stroke: options.fill,
          width: options.fillWeight ?? options.strokeWidth / 2,
        }
      : { stroke: options.stroke, width: options.strokeWidth };
}
function opPath(ops: readonly Op[]): string {
  return ops
    .map(
      ({ op, data }) =>
        `${op === "move" ? "M" : op === "lineTo" ? "L" : "C"}${data.map(n).join(" ")}`,
    )
    .join(" ");
}

type CachedImage = {
  image: HTMLImageElement;
  ready: boolean;
  failed: boolean;
  listeners: Set<() => void>;
};
const imagesByDocument = new WeakMap<Document, Map<string, CachedImage>>();
const patternsByContext = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern | string>>();

function seeded(seed: number): () => number {
  let state = (seed || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function canvasPaintFill(context: CanvasRenderingContext2D, paint: Paint): string | CanvasPattern {
  if (!paint.texture && (!paint.fillKind || paint.fillKind === "solid")) return paint.fill ?? "transparent";
  let cache = patternsByContext.get(context);
  if (!cache) {
    cache = new Map();
    patternsByContext.set(context, cache);
  }
  const key = JSON.stringify([paint.fill, paint.texture, paint.fillKind, paint.textureSeed]);
  const cached = cache.get(key);
  if (cached) return cached;
  const tile = context.canvas.ownerDocument.createElement("canvas");
  tile.width = tile.height = 32;
  const ctx = tile.getContext("2d");
  if (!ctx) return paint.fill ?? "transparent";
  const color = paint.fill ?? "#000000";
  const random = seeded(paint.textureSeed ?? 1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  const kind = paint.texture ?? paint.fillKind;
  if (kind === "hachure") {
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-8, 32); ctx.lineTo(32, -8);
    ctx.moveTo(8, 40); ctx.lineTo(40, 8);
    ctx.stroke();
  } else if (kind === "dots") {
    ctx.globalAlpha = 0.72;
    for (const [x, y] of [[8, 8], [24, 24]] as const) {
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    const count = kind === "watercolor" ? 34 : kind === "chalk" ? 72 : 52;
    ctx.globalAlpha = kind === "watercolor" ? 0.15 : kind === "paper" ? 0.16 : 0.36;
    for (let index = 0; index < count; index++) {
      const size = kind === "watercolor" ? 1 + random() * 5 : 0.45 + random() * 1.25;
      ctx.beginPath();
      ctx.arc(random() * 32, random() * 32, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const result = context.createPattern(tile, "repeat") ?? color;
  cache.set(key, result);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return result;
}

function imageFor(
  context: CanvasRenderingContext2D,
  url: string,
  onLoad?: () => void,
): CachedImage | null {
  const doc = context.canvas.ownerDocument;
  const ImageCtor = doc.defaultView?.Image;
  if (!ImageCtor) return null;
  let cache = imagesByDocument.get(doc);
  if (!cache) {
    cache = new Map();
    imagesByDocument.set(doc, cache);
  }
  let entry = cache.get(url);
  if (!entry) {
    const image = new ImageCtor();
    entry = { image, ready: false, failed: false, listeners: new Set() };
    cache.set(url, entry);
    const current = entry;
    image.onload = () => {
      current.ready = true;
      for (const listener of current.listeners) listener();
      current.listeners.clear();
    };
    image.onerror = () => {
      current.failed = true;
      current.listeners.clear();
    };
    image.src = url;
    // Bound decoded images while keeping the current entry reachable.
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
  }
  if (onLoad && !entry.ready && !entry.failed) entry.listeners.add(onLoad);
  return entry;
}

/** Export waits for the same decoded images used by the live renderer. */
export async function prepareBoardImages(context: CanvasRenderingContext2D, urls: readonly string[]): Promise<void> {
  await Promise.all([...new Set(urls)].map(url => new Promise<void>((resolve, reject) => {
    const entry = imageFor(context, url);
    if (!entry) { reject(new Error("image-decoder-unavailable")); return; }
    if (entry.ready) { resolve(); return; }
    if (entry.failed) { reject(new Error("image-decode-failed")); return; }
    const image = entry.image;
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("image-decode-failed")); };
    const timeout = setTimeout(fail, 10000);
    const cleanup = () => { clearTimeout(timeout); image.removeEventListener("load", done); image.removeEventListener("error", fail); };
    image.addEventListener("load", done, { once: true }); image.addEventListener("error", fail, { once: true });
  })));
}

const materialPointIds = new WeakMap<readonly BoardPoint[], number>();
let materialPointSequence = 0;
type MaterialRaster = {canvas:HTMLCanvasElement;x:number;y:number;width:number;height:number};
const materialRasters = new WeakMap<Document, {items:Map<string,MaterialRaster>;pixels:number}>();
export function materialRasterBudget(width: number, height: number): number {
  return Math.min(32_000_000,Math.max(12_000_000,Math.ceil(width*height*6)));
}
export function materialRasterScale(matrix: Pick<DOMMatrix, "a" | "b" | "c" | "d">): number {
  const deviceScale=Math.max(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));
  return Math.max(.5,Math.min(2,Math.ceil(deviceScale*4)/4));
}
function materialPathRaster(context:CanvasRenderingContext2D,points:readonly BoardPoint[],style:BoardBrushStyle,width:number,color:string,resources?:BrushResources,onMissing?:(hash:string)=>void) {
  const doc=context.canvas?.ownerDocument;if(!doc?.createElement||!points.length)return;
  const missing=missingBrushResources(style,resources);if(missing.length){if(onMissing)missing.forEach(onMissing);return;}
  let id=materialPointIds.get(points);if(!id){id=++materialPointSequence;materialPointIds.set(points,id);}
  // Rasterize only at the resolution the current viewport can display. A
  // fixed 2x raster at a 40% canvas zoom exhausted the bounded cache and
  // regenerated every textured stroke after each pan.
  const quality=materialRasterScale(context.getTransform());
  const key=JSON.stringify([id,style,width,color,quality]);
  let cache=materialRasters.get(doc);if(!cache){cache={items:new Map(),pixels:0};materialRasters.set(doc,cache);}
  const prior=cache.items.get(key);
  if(prior){cache.items.delete(key);cache.items.set(key,prior);return prior;}
  const pad=width*(2+(style.scatter??0));let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const point of points){minX=Math.min(minX,point.x);minY=Math.min(minY,point.y);maxX=Math.max(maxX,point.x);maxY=Math.max(maxY,point.y);}
  const x=minX-pad,y=minY-pad,w=maxX-minX+pad*2,h=maxY-minY+pad*2;
  const canvas=doc.createElement("canvas"),scale=Math.min(quality,1024/Math.max(w,h));
  canvas.width=Math.max(1,Math.ceil(w*scale));canvas.height=Math.max(1,Math.ceil(h*scale));
  const ctx=canvas.getContext("2d");if(!ctx)return;
  ctx.scale(canvas.width/w,canvas.height/h);ctx.translate(-x,-y);
  brushEngineFor(style).render(ctx,points,style,width,color,resources);
  const raster={canvas,x,y,width:w,height:h};cache.items.set(key,raster);
  cache.pixels+=canvas.width*canvas.height;
  const budget=materialRasterBudget(context.canvas.width,context.canvas.height);
  while(cache.items.size>4096||cache.pixels>budget){const oldest=cache.items.keys().next().value!,r=cache.items.get(oldest)!;cache.pixels-=r.canvas.width*r.canvas.height;cache.items.delete(oldest);}
  return raster;
}

const brushFillRasters = new WeakMap<Document, Map<string, HTMLCanvasElement>>();
function brushFillRaster(context: CanvasRenderingContext2D, width: number, height: number, fill: BoardFillStyle): HTMLCanvasElement | undefined {
  const doc = context.canvas?.ownerDocument;
  if (!doc?.createElement) return;
  let cache = brushFillRasters.get(doc); if (!cache) { cache = new Map(); brushFillRasters.set(doc, cache); }
  const key = JSON.stringify([width,height,fill]);
  const prior = cache.get(key); if (prior) return prior;
  const canvas = doc.createElement("canvas"), scale = Math.min(1.5,512/Math.max(width,height));
  canvas.width = Math.max(1,Math.ceil(width*scale)); canvas.height = Math.max(1,Math.ceil(height*scale));
  const ctx = canvas.getContext("2d"); if (!ctx) return;
  ctx.scale(canvas.width/width,canvas.height/height);
  renderBrushDabs(ctx,regionBrushDabs(width,height,fill),fill.color);
  cache.set(key,canvas);
  let pixels = [...cache.values()].reduce((sum,c)=>sum+c.width*c.height,0);
  while (cache.size > 512 || pixels > 8_000_000) { const oldest = cache.keys().next().value!; const c=cache.get(oldest)!; pixels-=c.width*c.height; cache.delete(oldest); }
  return canvas;
}

/** The caller sets the surface-to-canvas transform. We preserve its context. */
export function renderBoardCanvas(
  context: CanvasRenderingContext2D,
  objects: readonly BoardObject[],
  options: BoardRenderOptions,
): void {
  const finish = (paint: Paint): void => {
    const alpha = context.globalAlpha;
    if (paint.fill && paint.fill !== "none") {
      context.globalAlpha = alpha * (paint.opacity ?? 1);
      context.fillStyle = canvasPaintFill(context, paint);
      context.fill();
    }
    if (paint.stroke && paint.width > 0) {
      context.globalAlpha = alpha;
      context.strokeStyle = paint.stroke;
      context.lineWidth = paint.width;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
    }
    context.globalAlpha = alpha;
  };
  const target: DrawTarget = {
    packedPath(points, paint) {
      if (!points.length) return;
      context.beginPath(); context.moveTo(points[0]!, points[1]!);
      for (let i = 2; i < points.length; i += 2) context.lineTo(points[i]!, points[i + 1]!);
      context.closePath(); finish(paint);
    },
    push(matrix, appearance) {
      context.save();
      context.transform(...matrix);
      if (appearance) {
        context.globalAlpha *= appearance.opacity;
        context.globalCompositeOperation = appearance.blendMode === "normal"
          ? "source-over"
          : appearance.blendMode;
      }
    },
    pop() {
      context.restore();
    },
    brushFill(points, width, height, fill) {
      if (!points.length) return;
      context.save();
      try {
        context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
        for (const p of points.slice(1)) context.lineTo(p.x, p.y);
        context.closePath(); context.clip();
        context.globalAlpha *= fill.opacity;
        const raster = brushFillRaster(context, width, height, fill);
        if (raster) context.drawImage(raster, 0, 0, width, height);
        else renderBrushDabs(context, regionBrushDabs(width, height, fill), fill.color);
      } finally { context.restore(); }
    },
    path(points, paint, closed) {
      if (!points.length) return;
      if (paint.sketchSeed !== undefined) {
        target.rough(
          sketch(
            "path",
            points.flatMap((point) => [point.x, point.y]),
            paint,
            closed,
          ),
        );
        return;
      }
      context.beginPath();
      context.moveTo(points[0]!.x, points[0]!.y);
      for (let index = 1; index < points.length; index++) context.lineTo(points[index]!.x, points[index]!.y);
      if (closed) context.closePath();
      finish(paint);
    },
    ellipse(x, y, rx, ry, paint) {
      if (paint.sketchSeed !== undefined) {
        target.rough(
          sketch("ellipse", [x, y, Math.abs(rx) * 2, Math.abs(ry) * 2], paint),
        );
        return;
      }
      context.beginPath();
      context.ellipse(x, y, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
      finish(paint);
    },
    rect(x, y, width, height, paint) {
      if (paint.sketchSeed !== undefined) {
        target.rough(sketch("rect", [x, y, width, height], paint));
        return;
      }
      context.beginPath();
      context.rect(x, y, width, height);
      finish(paint);
    },
    text(text, x, y, style, color) {
      context.font = boardFontCss(style);
      context.fillStyle = color;
      context.textBaseline = "alphabetic";
      context.textAlign = "left";
      context.fillText(text, x, y);
    },
    rough(drawable) {
      for (const set of drawable.sets) {
        context.beginPath();
        for (const { op, data } of set.ops) {
          if (op === "move") context.moveTo(data[0]!, data[1]!);
          else if (op === "lineTo") context.lineTo(data[0]!, data[1]!);
          else
            context.bezierCurveTo(
              data[0]!,
              data[1]!,
              data[2]!,
              data[3]!,
              data[4]!,
              data[5]!,
            );
        }
        finish(roughPaint(drawable, set.type));
      }
    },
    materialPath(points, style, width, color) {
      const raster=materialPathRaster(context,points,style,width,color,options.brushResources,options.missingBrushResource);
      if(raster)context.drawImage(raster.canvas,raster.x,raster.y,raster.width,raster.height);
      else if(style.engineVersion!==2)target.dabs(generateBrushDabs(points,style,width),color,style.preventSelfOverlap);
    },
    dabs(dabs, color, preventSelfOverlap) {
      renderBrushDabs(context, dabs, color, "source-over", preventSelfOverlap);
    },
    image(url, width, height) {
      const cached = imageFor(context, url, options.requestRender);
      if (cached?.ready) context.drawImage(cached.image, 0, 0, width, height);
    },
    vector(asset, width, height) {
      renderVectorAssetCanvas(context, asset, width, height);
    },
  };
  context.save();
  try {
    drawObjects(target, objects, {
      ...options,
      // Custom measurers can depend on external mutable state, so keep their
      // original uncached behavior. Native canvas layouts use our font epoch.
      layoutText: options.measureText ? undefined : canvasTextLayout(context),
    });
  } finally {
    context.restore();
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function n(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

export function renderBoardSvg(
  objects: readonly BoardObject[],
  options: BoardRenderOptions & { width: number; height: number },
): string {
  const nodes: string[] = [];
  const patterns = new Map<string, string>();
  let brushClipSequence = 0;
  let backgroundNode = "";
  if (options.background) {
    const background = options.background;
    let fill = escapeXml(background.color);
    if (["lined", "grid", "dots", "paper"].includes(background.kind)) {
      const key = `board-background-${background.kind}-${n(background.spacing)}`;
      const spacing = n(background.spacing);
      const ink = background.kind === "dark" ? "#ffffff24" : "#6e768126";
      const body = background.kind === "lined"
        ? `<path d="M0 ${spacing}H${spacing}" stroke="${ink}"/>`
        : background.kind === "grid"
          ? `<path d="M0 ${spacing}H${spacing}M${spacing} 0V${spacing}" stroke="${ink}"/>`
          : background.kind === "dots"
            ? `<circle cx="1.5" cy="1.5" r="1.1" fill="${ink}"/>`
            : `<filter id="paper-noise"><feTurbulence type="fractalNoise" baseFrequency=".35" numOctaves="2" seed="37"/></filter><rect width="100%" height="100%" filter="url(#paper-noise)" opacity=".08"/>`;
      patterns.set(key, `<pattern id="${key}" width="${spacing}" height="${spacing}" patternUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="${fill}"/>${body}</pattern>`);
      fill = `url(#${key})`;
    }
    const viewport = options.viewport ?? { x: 0, y: 0, width: options.width, height: options.height };
    backgroundNode = `<rect x="${n(viewport.x)}" y="${n(viewport.y)}" width="${n(viewport.width)}" height="${n(viewport.height)}" fill="${fill}" opacity="${n(background.opacity)}"/>`;
  }
  const paintAttrs = (paint: Paint): string => {
    let fill = paint.fill ?? "none";
    const kind = paint.texture ?? paint.fillKind;
    if (fill !== "none" && kind && kind !== "solid") {
      const key = `${kind}-${(paint.textureSeed ?? 1) >>> 0}-${fill.replace(/[^a-z0-9]/gi, "")}`;
      if (!patterns.has(key)) {
        const color = escapeXml(fill);
        const body = kind === "hachure"
          ? `<path d="M-8 32L32-8M8 40L40 8" stroke="${color}" stroke-width="1.2" opacity=".75"/>`
          : kind === "dots"
            ? `<circle cx="8" cy="8" r="1.5" fill="${color}" opacity=".72"/><circle cx="24" cy="24" r="1.5" fill="${color}" opacity=".72"/>`
            : `<filter id="noise-${key}"><feTurbulence type="fractalNoise" baseFrequency="${kind === "watercolor" ? ".08" : ".32"}" numOctaves="2" seed="${paint.textureSeed ?? 1}"/><feComposite in="SourceGraphic" operator="in"/></filter><rect width="32" height="32" fill="${color}" opacity="${kind === "watercolor" ? ".35" : ".7"}" filter="url(#noise-${key})"/>`;
        patterns.set(key, `<pattern id="${key}" width="32" height="32" patternUnits="userSpaceOnUse">${body}</pattern>`);
      }
      fill = `url(#${key})`;
    }
    return `fill="${escapeXml(fill).replace(/&num;/g, "#")}" fill-opacity="${n(paint.opacity ?? 1)}" stroke="${escapeXml(paint.stroke ?? "none")}" stroke-width="${n(paint.width)}" stroke-linecap="round" stroke-linejoin="round"`;
  };
  const target: DrawTarget = {
    push(matrix, appearance) {
      const style = appearance
        ? ` opacity="${n(appearance.opacity)}" style="mix-blend-mode:${appearance.blendMode}"`
        : "";
      nodes.push(`<g transform="matrix(${matrix.map(n).join(" ")})"${style}>`);
    },
    pop() {
      nodes.push("</g>");
    },
    brushFill(points, width, height, fill) {
      if (!points.length) return;
      const id = `brush-region-${brushClipSequence++}`;
      const d = points.map((p,i)=>`${i ? "L" : "M"}${n(p.x)} ${n(p.y)}`).join(" ")+" Z";
      nodes.push(`<defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${d}" clip-rule="nonzero"/></clipPath></defs><g clip-path="url(#${id})" opacity="${n(fill.opacity)}">`);
      target.dabs(regionBrushDabs(width, height, fill), fill.color);
      nodes.push("</g>");
    },
    path(points, paint, closed) {
      if (!points.length) return;
      if (paint.sketchSeed !== undefined) {
        target.rough(
          sketch(
            "path",
            points.flatMap((point) => [point.x, point.y]),
            paint,
            closed,
          ),
        );
        return;
      }
      nodes.push(
        `<path d="${points.map((point, index) => `${index === 0 ? "M" : "L"}${n(point.x)} ${n(point.y)}`).join(" ")}${closed ? " Z" : ""}" ${paintAttrs(paint)}/>`,
      );
    },
    ellipse(x, y, rx, ry, paint) {
      if (paint.sketchSeed !== undefined) {
        target.rough(
          sketch("ellipse", [x, y, Math.abs(rx) * 2, Math.abs(ry) * 2], paint),
        );
        return;
      }
      nodes.push(
        `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(Math.abs(rx))}" ry="${n(Math.abs(ry))}" ${paintAttrs(paint)}/>`,
      );
    },
    rect(x, y, width, height, paint) {
      if (paint.sketchSeed !== undefined) {
        target.rough(sketch("rect", [x, y, width, height], paint));
        return;
      }
      nodes.push(
        `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" ${paintAttrs(paint)}/>`,
      );
    },
    text(text, x, y, style, color) {
      const family =
        style.font === "handwritten" ? BOARD_FONT_FAMILY : "sans-serif";
      nodes.push(
        `<text x="${n(x)}" y="${n(y)}" font-family="${escapeXml(family)}" font-size="${n(style.size)}" fill="${escapeXml(color)}" xml:space="preserve">${escapeXml(text)}</text>`,
      );
    },
    rough(drawable) {
      for (const set of drawable.sets)
        nodes.push(
          `<path d="${opPath(set.ops)}" ${paintAttrs(roughPaint(drawable, set.type))}/>`,
        );
    },
    materialPath(points, style, width, color) {
      if(brushNeedsRaster(style)){
        const doc=globalThis.document;
        const canvas=doc?.createElement("canvas"),context=canvas?.getContext("2d");
        if(context){
          const raster=materialPathRaster(context,points,style,width,color,options.brushResources,options.missingBrushResource);
          if(raster){nodes.push(`<image href="${raster.canvas.toDataURL("image/png")}" x="${n(raster.x)}" y="${n(raster.y)}" width="${n(raster.width)}" height="${n(raster.height)}"/>`);return;}
        }
        if(options.missingBrushResource)missingBrushResources(style,options.brushResources).forEach(options.missingBrushResource);
        return;
      }
      target.dabs(generateBrushDabs(points,style,width),color,style.preventSelfOverlap);
    },
    dabs(dabs, color, preventSelfOverlap) {
      if (preventSelfOverlap) nodes.push(`<g opacity="${n(Math.max(0, ...dabs.map(dab => dab.alpha)))}">`);
      for (const dab of dabs) {
        const dabColor = brushDabColor(color, dab.tone);
        const transform = `translate(${n(dab.x)} ${n(dab.y)}) rotate(${n(dab.rotation * 180 / Math.PI)})`;
        const opacity = preventSelfOverlap ? 1 : dab.alpha;
        if (dab.shape === "rect")
          nodes.push(`<rect x="${n(-dab.radiusX)}" y="${n(-dab.radiusY)}" width="${n(dab.radiusX * 2)}" height="${n(dab.radiusY * 2)}" rx="${n(Math.min(dab.radiusX, dab.radiusY) * (1 - dab.hardness))}" fill="${escapeXml(dabColor)}" opacity="${n(opacity)}" transform="${transform}"/>`);
        else if(dab.shape==="ring")
          nodes.push(`<ellipse cx="0" cy="0" rx="${n(dab.radiusX)}" ry="${n(dab.radiusY)}" fill="none" stroke="${escapeXml(dabColor)}" stroke-width="${n(Math.max(.4,Math.min(dab.radiusX,dab.radiusY)*.12))}" opacity="${n(opacity)}" transform="${transform}"/>`);
        else
          nodes.push(`<ellipse cx="0" cy="0" rx="${n(dab.radiusX)}" ry="${n(dab.radiusY)}" fill="${escapeXml(dabColor)}" opacity="${n(opacity)}" transform="${transform}"/>`);
      }
      if (preventSelfOverlap) nodes.push("</g>");
    },
    image(url, width, height) {
      // Reject executable references even when the renderer is used outside the
      // storage layer. Vault resource URLs and data images remain supported.
      if (
        !/^(?:data:image\/(?:png|jpeg|webp);base64,|app:|https?:|blob:|\.\.?\/)/i.test(
          url,
        )
      )
        return;
      nodes.push(
        `<image href="${escapeXml(url)}" width="${n(width)}" height="${n(height)}" preserveAspectRatio="none"/>`,
      );
    },
    vector(asset, width, height) {
      nodes.push(exportVectorAssetSvg(asset, { width, height }));
    },
  };
  drawObjects(target, objects, options);
  const defs = options.fontCss || patterns.size
    ? `<defs>${options.fontCss ? `<style>${escapeXml(options.fontCss)}</style>` : ""}${[...patterns.values()].join("")}</defs>`
    : "";
  const viewport = options.viewport ?? { x: 0, y: 0, width: options.width, height: options.height };
  const underlay = options.rasterUnderlay && /^(?:data:image\/(?:png|jpeg|webp);base64,|blob:)/i.test(options.rasterUnderlay.url)
    ? `<image href="${escapeXml(options.rasterUnderlay.url)}" x="${n(options.rasterUnderlay.x)}" y="${n(options.rasterUnderlay.y)}" width="${n(options.rasterUnderlay.width)}" height="${n(options.rasterUnderlay.height)}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(options.width)}" height="${n(options.height)}" viewBox="${n(viewport.x)} ${n(viewport.y)} ${n(viewport.width)} ${n(viewport.height)}">${defs}${backgroundNode}${underlay}${nodes.join("")}</svg>`;
}
