import { z } from "zod";
import type {
  BoardActor,
  BoardAnchor,
  BoardDocument,
  BoardInk,
  BoardLayer,
  BoardMarkdownAnchorState,
  BoardObject,
  BoardSnapshot,
  BoardTextStyle,
  BoardVectorAsset,
  BoardCharacterDefinition,
  BoardCharacterRecipe,
  InkStroke,
  TutorCharacterProfile,
} from "./board-types.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const dimension = z.number().finite().min(0).max(100_000);
const timestamp = z.string().datetime({ offset: true });
const actor = z.enum(["human", "tutor"]);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const vaultPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/^[A-Za-z][A-Za-z\d+.-]*:/.test(path) &&
      !path.includes("\\") &&
      !path.split("/").some((part) => part === ".." || part === "."),
    "Expected a vault-relative path",
  );

export const boardTextStyleSchema = z.object({
  font: z.enum(["handwritten", "sans"]),
  size: z.number().finite().positive().max(512),
  align: z.enum(["left", "center", "right"]),
}).strict();

export const boardDrawingStyleSchema = z.object({
  kind: z.enum(["clean", "sketch"]),
  seed: z.number().int().min(0).max(0xffffffff),
}).strict();

const color = z.string().regex(
  /^(?:#[\da-fA-F]{3}|#[\da-fA-F]{4}|#[\da-fA-F]{6}|#[\da-fA-F]{8}|[A-Za-z]{1,24})$/,
);
const unit = z.number().finite().min(0).max(1);
export const boardBrushStyleSchema = z.object({
  kind: z.enum(["pen", "fountain", "pencil", "marker", "highlighter", "chalk", "crayon", "watercolor", "sumi", "oil"]),
  opacity: unit,
  pressure: z.boolean(),
  smoothing: unit,
  streamline: unit,
  nibAngle: z.number().finite().min(-Math.PI).max(Math.PI).optional(),
  flow: unit.optional(),
  hardness: unit.optional(),
  spacing: z.number().finite().min(0.01).max(4).optional(),
  roundness: unit.optional(),
  scatter: z.number().finite().min(0).max(8).optional(),
  grainScale: z.number().finite().min(0.05).max(32).optional(),
  grainStrength: unit.optional(),
  stabilization: unit.optional(),
  pressureSize: unit.optional(),
  pressureFlow: unit.optional(),
  pressureOpacity: unit.optional(),
  bristleDensity: unit.optional(),
  dryness: unit.optional(),
  impasto: unit.optional(),
  preventSelfOverlap: z.boolean().optional(),
  engineVersion: z.literal(2).optional(),
  tipHash: z.string().regex(/^[a-f\d]{64}$/i).optional(),
  grainHash: z.string().regex(/^[a-f\d]{64}$/i).optional(),
  paperHash: z.string().regex(/^[a-f\d]{64}$/i).optional(),
  resourceHashes: z.array(z.string().regex(/^[a-f\d]{64}$/i)).max(8).optional(),
  seed: z.number().int().min(0).max(0xffffffff),
}).strict();
export const boardFillStyleSchema = z.object({
  kind: z.enum(["none", "solid", "hachure", "dots", "paper", "brush"]),
  brush: boardBrushStyleSchema.optional(),
  color,
  opacity: unit,
  seed: z.number().int().min(0).max(0xffffffff),
}).strict().refine(fill => (fill.kind === "brush") === !!fill.brush, "Brush fills require a brush recipe; other fill kinds must omit it");
export const boardLayerSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  order: z.number().int().min(0).max(10_000),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: unit,
  blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light"]),
  kind: z.enum(["vector", "paint", "group"]).optional(),
  parentId: id.optional(),
  alphaLocked: z.boolean().optional(),
  clippedToBelow: z.boolean().optional(),
}).strict();
export const boardBackgroundSchema = z.object({
  kind: z.enum(["plain", "dark", "lined", "grid", "dots", "paper"]),
  color,
  spacing: z.number().finite().min(4).max(512),
  opacity: unit,
}).strict();

export const boardArtboardSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  x: coordinate,
  y: coordinate,
  width: dimension.positive(),
  height: dimension.positive(),
  dpi: z.number().finite().min(36).max(2400),
  background: color,
  exportPreset: z.enum(["screen", "print", "custom"]),
}).strict();

const sha256 = z.string().regex(/^[a-f\d]{64}$/i);
export const boardBrushResourceRefSchema = z.object({
  hash: sha256,
  mimeType: z.enum(["image/png", "image/webp"]),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  path: vaultPath.optional(),
  license: z.string().min(1).max(160).optional(),
  author: z.string().min(1).max(300).optional(),
  source: z.string().url().max(2048).optional(),
}).strict();
export const boardBrushDefinitionSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  id,
  version,
  name: z.string().min(1).max(160),
  engine: z.enum(["outline", "dab"]),
  kind: z.enum(["pen", "fountain", "pencil", "marker", "highlighter", "chalk", "crayon", "watercolor", "sumi", "oil"]),
  style: boardBrushStyleSchema,
  tip: boardBrushResourceRefSchema.optional(),
  grain: boardBrushResourceRefSchema.optional(),
  paper: boardBrushResourceRefSchema.optional(),
  myb: z.object({
    version: z.literal(3),
    settings: z.record(z.string().regex(/^[a-z][a-z\d_]{0,63}$/i), z.object({
      base_value: z.number().finite().min(-1000).max(1000),
      inputs: z.record(z.string().regex(/^[a-z][a-z\d_]{0,63}$/i), z.array(z.tuple([
        z.number().finite().min(-1000).max(1000), z.number().finite().min(-1000).max(1000),
      ])).max(64)).optional(),
    }).strict()).refine(settings=>Object.keys(settings).length<=128,"Too many MyPaint settings"),
  }).strict().optional(),
  author: z.string().min(1).max(300).optional(),
  license: z.string().min(1).max(160).optional(),
  source: z.string().url().max(2048).optional(),
}).strict().superRefine((brush, context) => {
  if (brush.formatVersion === 1 && (brush.paper || brush.myb)) context.addIssue({ code: "custom", message: "v1 brushes cannot contain paper or MyPaint data" });
  if (brush.myb && JSON.stringify(brush.myb).length > 64_000) context.addIssue({ code: "custom", message: "MyPaint data exceeds 64 KB" });
  for(const role of ["tip","grain","paper"] as const){
    const hash=brush.style[`${role}Hash`];
    if(brush.formatVersion===2&&brush[role]&&!hash)context.addIssue({code:"custom",message:`${role} resource is missing its style hash`});
    if(hash&&hash.toLowerCase()!==brush[role]?.hash.toLowerCase())context.addIssue({code:"custom",message:`${role} hash does not match its resource`});
  }
});
export const boardPaintOperationSchema = z.object({
  id,
  layerId: id,
  type: z.enum(["stroke", "erase", "fill", "gradient"]),
  bounds: z.object({ x: coordinate, y: coordinate, width: dimension, height: dimension }).strict(),
  affectedTiles: z.array(z.string().regex(/^-?\d+:-?\d+$/)).max(100_000),
  color,
  opacity: unit,
  strokeWidth: z.number().finite().min(0.1).max(1000).optional(),
  inkId: id.optional(),
  brush: boardBrushStyleSchema.optional(),
  maskAssetHash: sha256.optional(),
  maskWidth: z.number().int().min(1).max(16384).optional(),
  maskHeight: z.number().int().min(1).max(16384).optional(),
  fillTolerance: z.number().finite().min(0).max(255).optional(),
  alphaLocked:z.boolean().optional(),
  clipRect:z.object({x:coordinate,y:coordinate,width:dimension,height:dimension}).strict().optional(),
  selection:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("rect"),bounds:z.object({x:coordinate,y:coordinate,width:dimension,height:dimension}).strict()}).strict(),
    z.object({kind:z.literal("polygon"),bounds:z.object({x:coordinate,y:coordinate,width:dimension,height:dimension}).strict(),points:z.array(z.object({x:coordinate,y:coordinate}).strict()).min(3).max(20_000)}).strict(),
    z.object({kind:z.literal("raster-mask"),bounds:z.object({x:coordinate,y:coordinate,width:dimension,height:dimension}).strict(),assetHash:sha256,width:z.number().int().min(1).max(16384),height:z.number().int().min(1).max(16384)}).strict(),
  ]).optional(),
  gradient: z.object({
    kind: z.enum(["linear", "radial"]),
    from: z.object({ x: coordinate, y: coordinate }).strict(),
    to: z.object({ x: coordinate, y: coordinate }).strict(),
    endColor: color,
  }).strict().optional(),
  createdAt: timestamp,
  revision,
}).strict().superRefine((operation, ctx) => {
  if ((operation.type === "stroke" || operation.type === "erase") && (!operation.inkId || !operation.brush || !operation.strokeWidth))
    ctx.addIssue({ code: "custom", message: "Paint strokes and erases require ink and a brush snapshot" });
  if (operation.type === "fill" && (!operation.maskAssetHash || !operation.maskWidth || !operation.maskHeight))
    ctx.addIssue({ code: "custom", message: "Paint fills require a deterministic mask" });
  if (operation.type === "gradient" && !operation.gradient)
    ctx.addIssue({ code: "custom", message: "Gradient operations require gradient geometry" });
});
export const boardTileManifestSchema = z.object({
  format: z.literal("board-tiles-v1"),
  tileSize: z.literal(512),
  gutter: z.number().int().min(1).max(32),
  checkpointRevision: revision,
  compression:z.literal("deflate-rgba-v1").optional(),
  tiles: z.array(z.object({
    key: z.string().regex(/^-?\d+:-?\d+$/),
    layerId: id,
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
    revision,
    checksum: sha256,
    path: vaultPath,
    operationFromRevision:revision.optional(),
    operationToRevision:revision.optional(),
    dependencies:z.array(sha256).max(4096).optional(),
    byteLength:z.number().int().min(0).max(512*1024*1024).optional(),
  }).strict()).max(100_000),
}).strict();
const inkRecognitionSchema = z.object({
  text: z.string().max(20_000),
  alternatives: z.array(z.string().max(20_000)).max(20),
  language: z.string().min(1).max(80),
  provider: z.string().min(1).max(160),
  model: z.string().max(300).optional(),
  engineVersion: z.string().max(300).optional(),
  recognizedAt: timestamp,
  userCorrected: z.boolean(),
  confidence: unit.optional(),
  segments: z.array(z.object({
    text: z.string().max(5000),
    strokeIds: z.array(id).min(1).max(5000),
  }).strict()).max(5000).optional(),
}).strict();
export const boardSemanticGroupSchema = z.object({
  id,
  objectIds: z.array(id).min(1).max(5000),
  kind: z.enum(["handwriting", "underline", "highlight", "circle", "connector", "arrow", "line", "rect", "ellipse", "unknown"]),
  confidence: unit,
  replacementObjectIds: z.array(id).max(5000).optional(),
  recognition: inkRecognitionSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
export const boardInkManifestSchema = z.object({
  format: z.literal("ink-pack-v1"),
  packs: z.array(z.object({
    id,
    strokeIds: z.array(id).min(1).max(512),
    sealed: z.boolean(),
    pointCount: z.number().int().min(1).max(5_000_000),
  }).strict()).max(100_000),
}).strict().superRefine((manifest, ctx) => {
  const packs = new Set<string>();
  const strokes = new Set<string>();
  for (const pack of manifest.packs) {
    if (packs.has(pack.id)) ctx.addIssue({ code: "custom", message: "Duplicate ink pack ID" });
    packs.add(pack.id);
    for (const stroke of pack.strokeIds) {
      if (strokes.has(stroke)) ctx.addIssue({ code: "custom", message: "Ink stroke belongs to multiple packs" });
      strokes.add(stroke);
    }
  }
});

export const boardMarkdownAnchorStateSchema: z.ZodType<BoardMarkdownAnchorState> = z.object({
  textVersion: z.string().max(1000),
  entries: z.array(z.object({
    id: z.string().min(1).max(1000),
    from: z.number().int().min(0).max(50_000_000),
    to: z.number().int().min(0).max(50_000_000),
    quote: z.string().max(20_000),
    before: z.string().max(20_000),
    after: z.string().max(20_000),
    blockId: z.string().min(1).max(1000).optional(),
    aliases: z.array(z.string().min(1).max(1000)).max(1000),
    status: z.enum(["located", "missing"]),
  }).strict().refine(entry => entry.to >= entry.from, "Invalid anchor range")).max(20_000),
}).strict().superRefine((state, ctx) => {
  const seen = new Set<string>();
  for (const entry of state.entries) {
    if (seen.has(entry.id)) ctx.addIssue({ code: "custom", message: "Duplicate markdown anchor ID" });
    seen.add(entry.id);
  }
});

export const boardPointSchema = z
  .object({
    x: coordinate,
    y: coordinate,
    pressure: z.number().finite().min(0).max(1).optional(),
    t: z.number().finite().min(0).optional(),
    tiltX: z.number().finite().min(-90).max(90).optional(),
    tiltY: z.number().finite().min(-90).max(90).optional(),
    twist: z.number().finite().min(0).max(359).optional(),
  })
  .strict();

export const boardPathCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["M", "L"]), x: coordinate, y: coordinate }).strict(),
  z.object({ op: z.literal("Q"), x1: coordinate, y1: coordinate, x: coordinate, y: coordinate }).strict(),
  z.object({ op: z.literal("C"), x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate, x: coordinate, y: coordinate }).strict(),
  z.object({
    op: z.literal("A"), rx: dimension.positive(), ry: dimension.positive(),
    rotation: z.number().finite().min(-3600).max(3600), largeArc: z.boolean(), sweep: z.boolean(),
    x: coordinate, y: coordinate,
  }).strict(),
  z.object({ op: z.literal("Z") }).strict(),
]);
const boardGradientStopSchema = z.object({ offset: unit, color, opacity: unit }).strict();
export const boardVectorPaintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("solid"), color, opacity: unit }).strict(),
  z.object({
    kind: z.literal("linear-gradient"), id, from: boardPointSchema, to: boardPointSchema,
    stops: z.array(boardGradientStopSchema).min(2).max(64),
  }).strict(),
  z.object({
    kind: z.literal("radial-gradient"), id, center: boardPointSchema, radius: dimension.positive(),
    focal: boardPointSchema.optional(), stops: z.array(boardGradientStopSchema).min(2).max(64),
  }).strict(),
  z.object({ kind: z.literal("pattern"), id, componentId: id, width: dimension.positive(), height: dimension.positive() }).strict(),
]);
const boardVectorStrokeSchema = z.object({
  paint: boardVectorPaintSchema,
  width: z.number().finite().min(0.01).max(10_000),
  lineCap: z.enum(["butt", "round", "square"]),
  lineJoin: z.enum(["miter", "round", "bevel"]),
  dash: z.array(z.number().finite().min(0).max(100_000)).max(64).optional(),
  dashOffset: coordinate.optional(),
}).strict();
export const boardVectorNodeSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  kind: z.enum(["group", "path", "shape", "text", "image", "component-instance"]),
  semanticRole: z.string().min(1).max(160).optional(),
  parentId: id.optional(),
  transform: z.tuple([coordinate, coordinate, coordinate, coordinate, coordinate, coordinate]),
  opacity: unit,
  blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light"]),
  visible: z.boolean(),
  locked: z.boolean(),
  clipPathId: id.optional(),
  fill: boardVectorPaintSchema.optional(),
  stroke: boardVectorStrokeSchema.optional(),
  fillRule: z.enum(["nonzero", "evenodd"]).optional(),
  path: z.array(boardPathCommandSchema).min(1).max(50_000).optional(),
  shape: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("rect"), x: coordinate, y: coordinate, width: dimension, height: dimension, rx: dimension.optional(), ry: dimension.optional() }).strict(),
    z.object({ kind: z.literal("ellipse"), cx: coordinate, cy: coordinate, rx: dimension, ry: dimension }).strict(),
    z.object({ kind: z.literal("line"), x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate }).strict(),
  ]).optional(),
  text: z.object({ value: z.string().max(20_000), x: coordinate, y: coordinate, style: boardTextStyleSchema }).strict().optional(),
  image: z.object({ assetHash: sha256, mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), width: dimension.positive(), height: dimension.positive() }).strict().optional(),
  componentId: id.optional(),
}).strict().superRefine((node, ctx) => {
  const payloads = [node.path, node.shape, node.text, node.image, node.componentId].filter(value => value !== undefined).length;
  if (node.kind === "path" && !node.path) ctx.addIssue({ code: "custom", message: "Path nodes require commands" });
  if (node.kind === "shape" && !node.shape) ctx.addIssue({ code: "custom", message: "Shape nodes require geometry" });
  if (node.kind === "text" && !node.text) ctx.addIssue({ code: "custom", message: "Text nodes require text geometry" });
  if (node.kind === "image" && !node.image) ctx.addIssue({ code: "custom", message: "Image nodes require a content-addressed resource" });
  if (node.kind === "component-instance" && !node.componentId) ctx.addIssue({ code: "custom", message: "Component instances require a component" });
  if ((node.kind === "group" && payloads > 0) || (node.kind !== "group" && payloads !== 1))
    ctx.addIssue({ code: "custom", message: "Vector node payload must match its kind" });
});

export const boardVectorAssetSchema: z.ZodType<BoardVectorAsset> = z.object({
  format: z.literal("board-vector-v1"), id, version, name: z.string().min(1).max(160),
  width: dimension.positive(), height: dimension.positive(), rootIds: z.array(id).min(1).max(5000),
  nodes: z.array(boardVectorNodeSchema).min(1).max(5000),
  components: z.array(z.object({ id, name: z.string().min(1).max(160), rootId: id }).strict()).max(512).optional(),
  geometryHash: sha256.optional(), createdAt: timestamp,
}).strict().superRefine((asset, ctx) => {
  const nodes = new Map(asset.nodes.map(node => [node.id, node]));
  if (nodes.size !== asset.nodes.length) ctx.addIssue({ code: "custom", message: "Duplicate vector node ID" });
  let commands = 0;
  for (const node of asset.nodes) {
    commands += node.path?.length ?? 0;
    if (node.parentId && !nodes.has(node.parentId)) ctx.addIssue({ code: "custom", message: `Unknown vector parent: ${node.parentId}` });
    if (node.clipPathId && !nodes.has(node.clipPathId)) ctx.addIssue({ code: "custom", message: `Unknown clip path: ${node.clipPathId}` });
    const ancestry = new Set<string>([node.id]);
    let cursor = node.parentId;
    while (cursor) {
      if (ancestry.has(cursor)) { ctx.addIssue({ code: "custom", message: `Cyclic vector hierarchy: ${node.id}` }); break; }
      ancestry.add(cursor); cursor = nodes.get(cursor)?.parentId;
    }
  }
  if (commands > 50_000) ctx.addIssue({ code: "custom", message: "Vector asset exceeds 50,000 path commands" });
  for (const root of asset.rootIds) if (!nodes.has(root) || nodes.get(root)?.parentId)
    ctx.addIssue({ code: "custom", message: `Invalid vector root: ${root}` });
  if (new Set(asset.rootIds).size !== asset.rootIds.length)
    ctx.addIssue({ code: "custom", message: "Duplicate vector root ID" });
  const components = new Set<string>();
  const componentRoots = new Map<string, string>();
  for (const component of asset.components ?? []) {
    if (components.has(component.id)) ctx.addIssue({ code: "custom", message: `Duplicate vector component: ${component.id}` });
    components.add(component.id);
    componentRoots.set(component.id, component.rootId);
    if (!nodes.has(component.rootId)) ctx.addIssue({ code: "custom", message: `Unknown component root: ${component.rootId}` });
  }
  for (const node of asset.nodes) if (node.componentId && !components.has(node.componentId))
    ctx.addIssue({ code: "custom", message: `Unknown component: ${node.componentId}` });
  for (const node of asset.nodes) for (const paint of [node.fill, node.stroke?.paint])
    if (paint?.kind === "pattern" && !components.has(paint.componentId))
      ctx.addIssue({ code: "custom", message: `Unknown pattern component: ${paint.componentId}` });
  const children = new Map<string, typeof asset.nodes>();
  for (const node of asset.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const edges = new Map<string, Set<string>>();
  const collect = (nodeId: string, result: Set<string>, seen = new Set<string>()): void => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = nodes.get(nodeId); if (!node) return;
    if (node.componentId) result.add(node.componentId);
    for (const child of children.get(nodeId) ?? []) collect(child.id, result, seen);
  };
  for (const [componentId, rootId] of componentRoots) { const result = new Set<string>(); collect(rootId, result); edges.set(componentId, result); }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (componentId: string): boolean => {
    if (visiting.has(componentId)) return true;
    if (visited.has(componentId)) return false;
    visiting.add(componentId);
    for (const dependency of edges.get(componentId) ?? []) if (visit(dependency)) return true;
    visiting.delete(componentId); visited.add(componentId); return false;
  };
  for (const componentId of components) if (visit(componentId)) {
    ctx.addIssue({ code: "custom", message: `Cyclic vector component reference: ${componentId}` });
    break;
  }
});

const channelValuesSchema = z.record(id, unit);
export const boardCharacterRecipeSchema: z.ZodType<BoardCharacterRecipe> = z.object({
  definitionId: id, definitionVersion: version, pose: id, gestures: z.array(id).max(16),
  expression: z.object({ emotion: channelValuesSchema, mouth: channelValuesSchema, blink: channelValuesSchema, gaze: channelValuesSchema, micro: channelValuesSchema }).strict(),
  outfit: id.optional(), props: z.array(id).max(16), geometryHash: sha256.optional(),
}).strict();
export const boardCharacterDefinitionSchema: z.ZodType<BoardCharacterDefinition> = z.object({
  format: z.literal("board-character-v1"), id, version, name: z.string().min(1).max(160), vectorAssetId: id, vectorAssetVersion: version,
  rig: z.object({ joints: z.array(z.object({ id, name: z.string().min(1).max(160), parentId: id.optional(), x: coordinate, y: coordinate, minAngle: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2).optional(), maxAngle: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2).optional() }).strict()).max(256) }).strict(),
  parts: z.array(z.object({ id, name: z.string().min(1).max(160), slot: id, rootNodeId: id, layer: z.number().int().min(-10_000).max(10_000), exclusive: z.boolean().optional() }).strict()).max(1024),
  faceControls: z.array(z.object({ id, channel: z.enum(["emotion", "mouth", "blink", "gaze", "micro"]), nodeIds: z.array(id).min(1).max(128), min: unit, max: unit }).strict()).max(512),
  presets: z.array(z.object({
    id,
    kind: z.enum(["pose", "emotion", "gesture", "outfit", "prop"]),
    values: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/), z.union([z.number().finite(), z.string().max(160), z.boolean()])),
  }).strict()).max(1024),
  rules: z.object({ exclusiveSlots: z.array(id).max(128), handOccupancy: z.array(z.object({ presetId: id, hands: z.array(z.enum(["left", "right"])).min(1).max(2) }).strict()).max(512), layerOrder: z.array(id).max(1024) }).strict(),
  createdAt: timestamp,
}).strict();

export const boardAnchorSchema: z.ZodType<BoardAnchor> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("markdown"),
        key: z.string().min(1).max(1000),
        quote: z.string().max(20_000),
        sourceLine: z.number().int().min(0).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("pdf"),
        page: z.number().int().min(1).max(1_000_000),
      })
      .strict(),
    z.object({
      kind: z.literal("canvas"),
      pageId: id,
    }).strict(),
  ],
);

export const inkStrokeSchema: z.ZodType<InkStroke> = z
  .object({
    id,
    points: z.array(boardPointSchema).min(1).max(100_000),
    createdAt: timestamp,
  })
  .strict();

export const boardInkSchema: z.ZodType<BoardInk> = z
  .record(id, inkStrokeSchema)
  .superRefine((ink, ctx) => {
    for (const [key, stroke] of Object.entries(ink)) {
      if (key !== stroke.id)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Ink key must match stroke ID",
        });
    }
  });

export const boardObjectSchema: z.ZodType<BoardObject> = z
  .object({
    id,
    kind: z.enum([
      "ink",
      "path",
      "arrow",
      "rect",
      "ellipse",
      "text",
      "character",
      "sticker",
      "vector",
    ]),
    anchor: boardAnchorSchema,
    x: coordinate,
    y: coordinate,
    width: dimension,
    height: dimension,
    rotation: z.number().finite().min(-1000).max(1000).optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    color,
    // Studio and AI material brushes intentionally support broad block-in
    // strokes; the compact document overlay still clamps its own UI to 64px.
    strokeWidth: z.number().finite().min(0.1).max(200),
    layerId: id.optional(),
    opacity: unit.optional(),
    blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light"]).optional(),
    brush: boardBrushStyleSchema.optional(),
    fill: boardFillStyleSchema.optional(),
    sourceInkIds: z.array(id).max(5000).optional(),
    erasedRanges: z.array(z.tuple([
      z.number().int().min(0).max(100_000),
      z.number().int().min(0).max(100_000),
    ])).max(5000).optional(),
    points: z.array(boardPointSchema).min(1).max(20_000).optional(),
    inkId: id.optional(),
    text: z.string().max(2000).optional(),
    textStyle: boardTextStyleSchema.optional(),
    drawingStyle: boardDrawingStyleSchema.optional(),
    selectionGroupId: id.optional(),
    characterPart: z.object({id,name:z.string().trim().min(1).max(80)}).strict().optional(),
    assetId: id.optional(),
    assetVersion: version.optional(),
    characterId: id.optional(),
    characterVersion: version.optional(),
    expression: z
      .enum([
        "thinking",
        "curious",
        "discovery",
        "encouraging",
        "celebrating",
        "quiet",
      ])
      .optional(),
    vectorAssetId: id.optional(),
    vectorAssetVersion: version.optional(),
    characterRecipe: boardCharacterRecipeSchema.optional(),
    createdBy: actor,
    editedBy: actor,
    revision,
    groupId: id,
  })
  .strict()
  .superRefine((object, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (object.kind === "ink" && (!object.inkId || object.points))
      issue(
        "Ink objects reference immutable ink and cannot duplicate point data",
      );
    if (object.kind === "path" && !object.points?.length)
      issue("Paths require local points");
    if (object.kind === "text" && object.text === undefined)
      issue("Text objects require text");
    if (object.textStyle && object.kind !== "text")
      issue("Text style belongs to text objects");
    if (object.kind === "sticker" && (!object.assetId || !object.assetVersion))
      issue("Stickers require a versioned asset");
    if (object.kind !== "sticker" && (object.assetId || object.assetVersion))
      issue("Asset references belong to sticker objects");
    if (
      object.kind === "character" &&
      (!object.characterId || !object.characterVersion)
    )
      issue("Character objects require a versioned profile");
    if (object.kind === "vector" && (!object.vectorAssetId || !object.vectorAssetVersion))
      issue("Vector objects require a versioned vector asset");
    if (object.kind !== "vector" && (object.vectorAssetId || object.vectorAssetVersion || object.characterRecipe))
      issue("Vector references belong to vector objects");
  });

export const boardDocumentSchema: z.ZodType<BoardDocument> = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    id,
    title: z.string().trim().min(1).max(160).optional(),
    sourceFile: vaultPath,
    sourceType: z.enum(["markdown", "pdf", "standalone"]),
    sourceRevision: z.string().max(1000),
    markdownAnchors: boardMarkdownAnchorStateSchema.optional(),
    revision,
    objects: z.array(boardObjectSchema).max(20_000),
    layers: z.array(boardLayerSchema).min(1).max(256).optional(),
    background: boardBackgroundSchema.optional(),
    semanticGroups: z.array(boardSemanticGroupSchema).max(20_000).optional(),
    inkManifest: boardInkManifestSchema.optional(),
    artboards: z.array(boardArtboardSchema).max(256).optional(),
    brushDefinitions: z.array(boardBrushDefinitionSchema).max(2048).optional(),
    paintOperations: z.array(boardPaintOperationSchema).max(500_000).optional(),
    tileManifest: boardTileManifestSchema.optional(),
    palette: z.array(color).max(256).optional(),
    characterId: id,
    characterVersion: version,
    vectorAssets: z.array(boardVectorAssetSchema).max(2048).optional(),
    characterDefinitions: z.array(boardCharacterDefinitionSchema).max(512).optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((document, ctx) => {
    if (document.sourceType !== "markdown" && document.markdownAnchors)
      ctx.addIssue({ code: "custom", message: "Only Markdown boards can contain Markdown anchor metadata" });
    const layerList = document.layers ?? [];
    const layers = new Set(layerList.map(layer => layer.id));
    if (layers.size !== (document.layers?.length ?? 0))
      ctx.addIssue({ code: "custom", message: "Duplicate board layer ID" });
    const seen = new Set<string>();
    const vectorAssets = new Map((document.vectorAssets ?? []).map(asset => [`${asset.id}:${asset.version}`, asset]));
    if (vectorAssets.size !== (document.vectorAssets?.length ?? 0))
      ctx.addIssue({ code: "custom", message: "Duplicate vector asset version" });
    for (const object of document.objects) {
      if (seen.has(object.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate board object ID: ${object.id}`,
        });
      const expectedAnchor = document.sourceType === "standalone" ? "canvas" : document.sourceType;
      if (object.anchor.kind !== expectedAnchor)
        ctx.addIssue({
          code: "custom",
          message: "Object anchor must match source type",
        });
      if (object.layerId && document.layers && !layers.has(object.layerId))
        ctx.addIssue({ code: "custom", message: `Unknown object layer: ${object.layerId}` });
      if (object.kind === "vector" && !vectorAssets.has(`${object.vectorAssetId}:${object.vectorAssetVersion}`))
        ctx.addIssue({ code: "custom", message: `Unknown vector asset: ${object.vectorAssetId}:${object.vectorAssetVersion}` });
      seen.add(object.id);
    }
    const layerById = new Map(layerList.map(layer => [layer.id, layer]));
    for (const layer of layerList) {
      if (layer.parentId === layer.id)
        ctx.addIssue({ code: "custom", message: `Layer cannot parent itself: ${layer.id}` });
      if (layer.parentId && layerById.get(layer.parentId)?.kind !== "group")
        ctx.addIssue({ code: "custom", message: `Layer parent must be a group: ${layer.id}` });
      const ancestry = new Set<string>();
      let cursor = layer;
      while (cursor.parentId) {
        if (ancestry.has(cursor.parentId)) {
          ctx.addIssue({ code: "custom", message: `Cyclic layer hierarchy: ${layer.id}` });
          break;
        }
        ancestry.add(cursor.parentId);
        const parent = layerById.get(cursor.parentId);
        if (!parent) break;
        cursor = parent;
      }
    }
    const artboards = new Set<string>();
    for (const artboard of document.artboards ?? []) {
      if (artboards.has(artboard.id)) ctx.addIssue({ code: "custom", message: `Duplicate artboard ID: ${artboard.id}` });
      artboards.add(artboard.id);
    }
    const brushDefinitions = new Set<string>();
    for (const brush of document.brushDefinitions ?? []) {
      const key = `${brush.id}:${brush.version}`;
      if (brushDefinitions.has(key)) ctx.addIssue({ code: "custom", message: `Duplicate brush version: ${key}` });
      brushDefinitions.add(key);
    }
    const operations = new Set<string>();
    for (const operation of document.paintOperations ?? []) {
      if (operations.has(operation.id)) ctx.addIssue({ code: "custom", message: `Duplicate paint operation: ${operation.id}` });
      operations.add(operation.id);
      const layer = layerById.get(operation.layerId);
      if (!layer || layer.kind !== "paint") ctx.addIssue({ code: "custom", message: `Paint operation requires a paint layer: ${operation.id}` });
    }
    const tileKeys = new Set<string>();
    for (const tile of document.tileManifest?.tiles ?? []) {
      const key = `${tile.layerId}:${tile.key}`;
      if (tileKeys.has(key)) ctx.addIssue({ code: "custom", message: `Duplicate tile checkpoint: ${key}` });
      tileKeys.add(key);
      if (layerById.get(tile.layerId)?.kind !== "paint") ctx.addIssue({ code: "custom", message: `Tile checkpoint requires a paint layer: ${key}` });
    }
    const definitions = new Set<string>();
    for (const definition of document.characterDefinitions ?? []) {
      const key = `${definition.id}:${definition.version}`;
      if (definitions.has(key)) ctx.addIssue({ code: "custom", message: `Duplicate character definition: ${key}` });
      definitions.add(key);
      const asset = vectorAssets.get(`${definition.vectorAssetId}:${definition.vectorAssetVersion}`);
      if (!asset) ctx.addIssue({ code: "custom", message: `Character definition requires vector asset: ${key}` });
      const nodeIds = new Set(asset?.nodes.map(node => node.id) ?? []);
      for (const part of definition.parts) if (!nodeIds.has(part.rootNodeId)) ctx.addIssue({ code: "custom", message: `Unknown character part root: ${part.rootNodeId}` });
      for (const control of definition.faceControls) for (const nodeId of control.nodeIds)
        if (!nodeIds.has(nodeId)) ctx.addIssue({ code: "custom", message: `Unknown face control node: ${nodeId}` });
    }
  });

export const tutorCharacterProfileSchema: z.ZodType<TutorCharacterProfile> = z
  .object({
    id,
    version,
    name: z.string().min(1).max(160),
    origin: z.enum(["builtin", "uploaded", "co_created"]),
    style: z.enum(["round", "book", "custom"]),
    width: dimension.positive(),
    height: dimension.positive(),
    createdAt: timestamp,
    assetPath: vaultPath.optional(),
    // A single reference repaint can contain up to 6,000 native strokes.
    objects: z.array(boardObjectSchema).max(6000).optional(),
    ink: boardInkSchema.optional(),
    vectorAssets:z.array(boardVectorAssetSchema).max(128).optional(),
    characterDefinitions:z.array(boardCharacterDefinitionSchema).max(128).optional(),
    usage: z.enum(["character", "sticker", "both"]).optional(),
    tags: z.array(z.string().min(1).max(80)).max(40).optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.origin === "uploaded" && !profile.assetPath)
      ctx.addIssue({
        code: "custom",
        message: "Uploaded characters require an asset",
      });
    if (profile.origin === "co_created" && !profile.objects?.length)
      ctx.addIssue({
        code: "custom",
        message: "Co-created characters require objects",
      });
    for (const object of profile.objects ?? []) {
      if(object.kind==="vector"&&!profile.vectorAssets?.some(a=>a.id===object.vectorAssetId&&a.version===object.vectorAssetVersion))ctx.addIssue({code:"custom",message:"Missing character vector version"});
      if (object.kind === "ink" && object.inkId && (!profile.ink || !Object.hasOwn(profile.ink, object.inkId)))
        ctx.addIssue({
          code: "custom",
          message: `Missing character ink: ${object.inkId}`,
        });
    }
  });

export const boardSnapshotSchema: z.ZodType<BoardSnapshot> = z
  .object({
    pngBase64: z
      .string()
      .min(1)
      .max(32_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    imageToBoard: z.tuple([
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
    ]),
    anchor: boardAnchorSchema,
    layoutRevision: z.string().min(1).max(1000),
  })
  .strict()
  .refine(
    (snapshot) =>
      Math.abs(
        snapshot.imageToBoard[0] * snapshot.imageToBoard[3] -
          snapshot.imageToBoard[1] * snapshot.imageToBoard[2],
      ) > 1e-12,
    "Snapshot coordinate transform must be invertible",
  );

export function parseBoardDocument(content: string | unknown): BoardDocument {
  return boardDocumentSchema.parse(
    typeof content === "string" ? JSON.parse(content) : content,
  );
}

export function validateBoardDocument(document: unknown): BoardDocument {
  return boardDocumentSchema.parse(document);
}

/** Compare live and saved scenes without mistaking lazy defaults or pack IDs for artwork edits.
 * This projection is never persisted and contains the original immutable ink separately. */
export function comparableBoardSourceDocument(document: BoardDocument): BoardDocument {
  let value = validateBoardDocument(document);
  while (value.schemaVersion < 5) value = upgradeBoardDocument(value);
  return { ...value, inkManifest: { format: "ink-pack-v1", packs: [] } };
}

/** Advance exactly one durable schema step per save, preserving legacy IDs. */
export function upgradeBoardDocument(document: BoardDocument): BoardDocument {
  const valid = validateBoardDocument(document);
  // Keep the historical v1 -> v2 checkpoint intact. Reopening that v2 file
  // and saving again performs the v3 container upgrade.
  if (valid.schemaVersion === 1)
    return validateBoardDocument({ ...valid, schemaVersion: 2 });
  if (valid.schemaVersion === 5) return valid;
  const baseLayers: BoardLayer[] = valid.layers?.length ? valid.layers : [{
      id: "layer-default",
      name: "Drawing",
      order: 0,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: "normal",
    }];
  if (valid.schemaVersion <= 2) return validateBoardDocument({
    ...valid,
    schemaVersion: 3,
    layers: baseLayers,
    background: valid.background ?? {
      kind: "plain",
      color: "#ffffff",
      spacing: 24,
      opacity: 1,
    },
    semanticGroups: valid.semanticGroups ?? [],
    inkManifest: valid.inkManifest ?? { format: "ink-pack-v1", packs: [] },
  });
  if (valid.schemaVersion === 4) return validateBoardDocument({
    ...valid,
    schemaVersion: 5,
    vectorAssets: valid.vectorAssets ?? [],
    characterDefinitions: valid.characterDefinitions ?? [],
  });
  const layers = baseLayers.map(layer => ({
    ...layer,
    kind: layer.kind ?? "vector" as const,
    alphaLocked: layer.alphaLocked ?? false,
    clippedToBelow: layer.clippedToBelow ?? false,
  }));
  return validateBoardDocument({
    ...valid,
    schemaVersion: 4,
    layers,
    artboards: valid.artboards ?? (valid.sourceType === "standalone" ? [{
      id: "artboard-main",
      name: "Artwork",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      dpi: 144,
      background: valid.background?.color ?? "#ffffff",
      exportPreset: "screen",
    }] : []),
    brushDefinitions: valid.brushDefinitions ?? [],
    paintOperations: valid.paintOperations ?? [],
    tileManifest: valid.tileManifest ?? {
      format: "board-tiles-v1",
      tileSize: 512,
      gutter: 2,
      checkpointRevision: 0,
      tiles: [],
    },
    palette: valid.palette ?? ["#111827", "#ffffff", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6"],
  });
}

export function validateBoardInk(document: BoardDocument, ink: BoardInk): void {
  boardInkSchema.parse(ink);
  for (const object of document.objects) {
    if (object.kind === "ink" && (!object.inkId || !Object.hasOwn(ink, object.inkId)))
      throw new Error(`Missing immutable ink for ${object.id}`);
  }
  for (const operation of document.paintOperations ?? []) {
    if (operation.inkId && !Object.hasOwn(ink, operation.inkId))
      throw new Error(`Missing immutable ink for paint operation ${operation.id}`);
  }
}

export function createBoardDocument(
  sourceFile: string,
  sourceType: BoardDocument["sourceType"],
  boardId = `BOARD-${crypto.randomUUID()}`,
): BoardDocument {
  const now = new Date().toISOString();
  return boardDocumentSchema.parse({
    schemaVersion: 2,
    id: boardId,
    ...(sourceType === "standalone" ? { title: "未命名画作" } : {}),
    sourceFile,
    sourceType,
    sourceRevision: "",
    revision: 0,
    objects: [],
    layers: [{
      id: "layer-default",
      name: "Drawing",
      order: 0,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: "normal",
    }],
    background: { kind: "plain", color: "#ffffff", spacing: 24, opacity: 1 },
    semanticGroups: [],
    inkManifest: { format: "ink-pack-v1", packs: [] },
    characterId: "tutor-round",
    characterVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
function contentOf(object: BoardObject): string {
  const { revision: _revision, editedBy: _editedBy, ...content } = object;
  return JSON.stringify(content);
}

/** Measurements are derived only after the object's final fonts are available. */
export type BoardTextGeometryUpdate = {
  id: string;
  text: string;
  width: number;
  textStyle: BoardTextStyle;
  height: number;
};
const textGeometryUpdatesSchema = z.array(z.object({
  id,
  text: z.string().max(2000),
  width: dimension,
  textStyle: boardTextStyleSchema,
  height: dimension,
}).strict()).superRefine((updates, context) => {
  const seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.id))
      context.addIssue({ code: "custom", message: "Duplicate text geometry ID" });
    seen.add(update.id);
  }
});

/** A full Tutor response is one transaction; undo is a new monotonic revision. */
/** Optional display metadata shares artwork undo, without changing saved geometry. */
export interface BoardHistoryCompanion {
  capture(): unknown;
  restore(snapshot: unknown): void;
}
export class BoardHistory {
  private current: BoardDocument;
  private readonly past: BoardDocument[] = [];
  private readonly future: BoardDocument[] = [];
  private companion?: BoardHistoryCompanion;
  private readonly pastCompanions: unknown[] = [];
  private readonly futureCompanions: unknown[] = [];
  private readonly objectRevisions = new Map<string, number>();
  public constructor(
    document: BoardDocument,
    private readonly limit = 100,
    recoveryBaseline?: BoardDocument,
  ) {
    this.current = validateBoardDocument(document);
    if (recoveryBaseline) {
      const baseline = validateBoardDocument(recoveryBaseline);
      if (baseline.id !== this.current.id || baseline.sourceFile !== this.current.sourceFile || baseline.sourceType !== this.current.sourceType)
        throw new Error("board-recovery-target");
      if (JSON.stringify(baseline) !== JSON.stringify(this.current)) this.past.push(baseline);
    }
    for (const object of this.current.objects)
      this.objectRevisions.set(object.id, object.revision);
  }
  public get document(): BoardDocument {
    return copy(this.current);
  }
  /** Stable, un-cloned snapshot for read-only rendering. Never mutate this value;
   * all edits must continue through transact() so undo and validation stay intact. */
  public get renderDocument(): Readonly<BoardDocument> {
    return this.current;
  }
  /** Version checks must not clone thousands of strokes on every frame. */
  public get revision(): number { return this.current.revision; }
  public get canUndo(): boolean {
    return this.past.length > 0;
  }
  public get canRedo(): boolean {
    return this.future.length > 0;
  }
  public attachCompanion(companion: BoardHistoryCompanion): void {
    this.companion = companion;
    this.pastCompanions.length = this.past.length;
    this.futureCompanions.length = this.future.length;
  }
  /** Explicit layout association consumes one ordinary undo step. */
  public checkpoint(): void {
    this.transact(draft => { draft.revision++; });
  }

  /** Adopt a split's exact source revision, preserving local drawing history.
   * Recreating timestamps independently makes identical saves look conflicting. */
  public receiveMetadata(document: BoardDocument): boolean {
    const next = validateBoardDocument(document);
    const artwork = (value: BoardDocument) => {
      const { revision, updatedAt, sourceRevision, markdownAnchors, ...rest } = value;
      return rest;
    };
    if (next.revision < this.current.revision
      || JSON.stringify(artwork(next)) !== JSON.stringify(artwork(this.current))) return false;
    this.current = next;
    return true;
  }

  /** Relocation changes the locator in every undo state, never the work's identity. */
  public receiveSourceMove(document: BoardDocument): void {
    const next = validateBoardDocument(document);
    const artwork = (value: BoardDocument) => {
      const { sourceFile, revision, updatedAt, inkManifest, ...rest } = comparableBoardSourceDocument(value);
      return rest;
    };
    if (next.revision < this.current.revision || JSON.stringify(artwork(next)) !== JSON.stringify(artwork(this.current)))
      throw new Error("board-source-move-scene-changed");
    const move = (value: BoardDocument) => {
      let moved = validateBoardDocument({ ...value, sourceFile: next.sourceFile });
      while (moved.schemaVersion < next.schemaVersion) moved = upgradeBoardDocument(moved);
      return moved;
    };
    const past = this.past.map(move), future = this.future.map(move);
    this.current = next;
    this.past.splice(0, this.past.length, ...past);
    this.future.splice(0, this.future.length, ...future);
  }

  /** Source metadata advances the board version without consuming an undo step. */
  public updateSourceRevision(sourceRevision: string): boolean {
    if (sourceRevision === this.current.sourceRevision) return false;
    this.current = validateBoardDocument({
      ...this.current,
      sourceRevision,
      revision: this.current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  /** Anchor relocation is source metadata, independent of drawing undo/redo. */
  public updateMarkdownAnchors(state: BoardMarkdownAnchorState): boolean {
    const markdownAnchors = boardMarkdownAnchorStateSchema.parse(state);
    if (JSON.stringify(markdownAnchors) === JSON.stringify(this.current.markdownAnchors)) return false;
    this.current = validateBoardDocument({
      ...this.current,
      markdownAnchors,
      revision: this.current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
  /** Paint checkpoints are derived caches and never consume an artwork undo step. */
  public updateTileManifest(tileManifest: BoardDocument["tileManifest"]): boolean {
    if (JSON.stringify(tileManifest) === JSON.stringify(this.current.tileManifest)) return false;
    this.current = validateBoardDocument({ ...this.current, tileManifest });
    return true;
  }

  /**
   * Font readiness refines derived height without adding a drawing action.
   * Match text, width and the resolved explicit style in every history state:
   * undo can never revive removed text, and redo receives the same font metrics.
   * Returns whether the visible document changed; history-only refreshes are idle.
   */
  public refreshTextGeometry(updates: readonly BoardTextGeometryUpdate[]): boolean {
    const measured = new Map(
      textGeometryUpdatesSchema.parse(updates).map(update => [update.id, update]),
    );
    if (!measured.size) return false;
    const refresh = (document: BoardDocument): BoardDocument => {
      let changed = false;
      const objects = document.objects.map(object => {
        if (object.kind !== "text" || !object.textStyle) return object;
        // Legacy text derives its font size from height. It must retain that
        // source geometry rather than treating height as a measured property.
        const update = measured.get(object.id), style = object.textStyle;
        if (!update || object.text !== update.text || object.width !== update.width ||
          style.font !== update.textStyle.font || style.size !== update.textStyle.size ||
          style.align !== update.textStyle.align || object.height === update.height)
          return object;
        changed = true;
        return { ...object, height: update.height };
      });
      return changed ? { ...document, objects } : document;
    };
    const visible = refresh(this.current), changed = visible !== this.current;
    // Validate the new visible revision before changing any history state.
    const current = changed ? validateBoardDocument({
      ...visible, revision: this.current.revision + 1, updatedAt: new Date().toISOString(),
    }) : this.current;
    const past = this.past.map(refresh), future = this.future.map(refresh);
    this.current = current;
    this.past.splice(0, this.past.length, ...past);
    this.future.splice(0, this.future.length, ...future);
    return changed;
  }

  public transact(
    mutator: (draft: BoardDocument) => void,
    by: BoardActor = "human",
    authorizedObjectIds:ReadonlySet<string>=new Set(),
  ): BoardDocument {
    const companion = this.companion?.capture();
    const draft = this.document;
    mutator(draft);
    if (JSON.stringify(draft) === JSON.stringify(this.current))
      return this.document;
    const next = this.prepare(draft, by, true,authorizedObjectIds);
    this.past.push(this.current);
    this.pastCompanions.push(companion);
    if (this.past.length > this.limit) { this.past.shift(); this.pastCompanions.shift(); }
    this.future.length = 0;
    this.futureCompanions.length = 0;
    this.current = next;
    return this.document;
  }
  public undo(): BoardDocument | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(this.current);
    this.futureCompanions.push(this.companion?.capture());
    const companion = this.pastCompanions.pop();
    this.current = this.prepare(previous, "human", false);
    if (companion !== undefined) this.companion?.restore(companion);
    return this.document;
  }
  public redo(): BoardDocument | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.current);
    this.pastCompanions.push(this.companion?.capture());
    const companion = this.futureCompanions.pop();
    this.current = this.prepare(next, "human", false);
    if (companion !== undefined) this.companion?.restore(companion);
    return this.document;
  }
  /** Explicit external reload discards history belonging to the old revision. */
  public replace(document: BoardDocument): void {
    this.current = validateBoardDocument(document);
    this.past.length = 0;
    this.future.length = 0;
    this.pastCompanions.length = 0;
    this.futureCompanions.length = 0;
    this.objectRevisions.clear();
    for (const object of this.current.objects)
      this.objectRevisions.set(object.id, object.revision);
  }
  private prepare(
    document: BoardDocument,
    by: BoardActor,
    enforceOwnership: boolean,
    authorizedObjectIds:ReadonlySet<string>=new Set(),
  ): BoardDocument {
    const next = copy(document);
    if (
      next.id !== this.current.id ||
      next.sourceType !== this.current.sourceType
    )
      throw new Error("A transaction cannot replace board identity");
    const old = new Map(
      this.current.objects.map((object) => [object.id, object]),
    );
    if (enforceOwnership && by === "tutor") {
      const proposed = new Map(
        next.objects.map((object) => [object.id, object]),
      );
      for (const object of this.current.objects) {
        if (authorizedObjectIds.has(object.id)||(object.createdBy !== "human" && object.editedBy !== "human")) continue;
        const replacement = proposed.get(object.id);
        if (!replacement || contentOf(replacement) !== contentOf(object))
          throw new Error("Tutor cannot modify human objects");
      }
    }
    for (const object of next.objects) {
      const before = old.get(object.id);
      if (before) object.createdBy = before.createdBy;
      else if (enforceOwnership) object.createdBy = by;
      if (!before || contentOf(before) !== contentOf(object)) {
        object.editedBy = by;
        object.revision = (this.objectRevisions.get(object.id) ?? 0) + 1;
      } else {
        object.editedBy = before.editedBy;
        object.revision = before.revision;
      }
    }
    next.revision = this.current.revision + 1;
    next.sourceRevision = this.current.sourceRevision;
    next.schemaVersion = this.current.schemaVersion;
    if (this.current.markdownAnchors) next.markdownAnchors = copy(this.current.markdownAnchors);
    else delete next.markdownAnchors;
    next.createdAt = this.current.createdAt;
    next.updatedAt = new Date().toISOString();
    const valid = validateBoardDocument(next);
    for (const object of valid.objects)
      this.objectRevisions.set(object.id, object.revision);
    return valid;
  }
}
