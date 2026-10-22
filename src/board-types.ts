/** Portable inspiration-board contracts. No host/runtime dependencies. */
export type BoardPoint = {
  x: number;
  y: number;
  pressure?: number;
  t?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
};
export type BoardRect = { x: number; y: number; width: number; height: number };
export type BoardSelectionRegion =
  | { kind: "rect"; bounds: BoardRect }
  | { kind: "polygon"; bounds: BoardRect; points: BoardPoint[] }
  | {
      kind: "raster-mask";
      bounds: BoardRect;
      assetHash: string;
      width: number;
      height: number;
    };
export type BoardMatrix = [number, number, number, number, number, number];
export type BoardPathCommand =
  | { op: "M" | "L"; x: number; y: number }
  | { op: "Q"; x1: number; y1: number; x: number; y: number }
  | { op: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | {
      op: "A";
      rx: number;
      ry: number;
      rotation: number;
      largeArc: boolean;
      sweep: boolean;
      x: number;
      y: number;
    }
  | { op: "Z" };
export type BoardVectorGradientStop = { offset: number; color: string; opacity: number };
export type BoardVectorPaint =
  | { kind: "none" }
  | { kind: "solid"; color: string; opacity: number }
  | {
      kind: "linear-gradient";
      id: string;
      from: BoardPoint;
      to: BoardPoint;
      stops: BoardVectorGradientStop[];
    }
  | {
      kind: "radial-gradient";
      id: string;
      center: BoardPoint;
      radius: number;
      focal?: BoardPoint;
      stops: BoardVectorGradientStop[];
    }
  | { kind: "pattern"; id: string; componentId: string; width: number; height: number };
export type BoardVectorStroke = {
  paint: BoardVectorPaint;
  width: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  dash?: number[];
  dashOffset?: number;
};
export type BoardVectorNode = {
  id: string;
  name: string;
  kind: "group" | "path" | "shape" | "text" | "image" | "component-instance";
  semanticRole?: string;
  parentId?: string;
  transform: BoardMatrix;
  opacity: number;
  blendMode: BoardBlendMode;
  visible: boolean;
  locked: boolean;
  clipPathId?: string;
  fill?: BoardVectorPaint;
  stroke?: BoardVectorStroke;
  fillRule?: "nonzero" | "evenodd";
  path?: BoardPathCommand[];
  shape?:
    | { kind: "rect"; x: number; y: number; width: number; height: number; rx?: number; ry?: number }
    | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
    | { kind: "line"; x1: number; y1: number; x2: number; y2: number };
  text?: { value: string; x: number; y: number; style: BoardTextStyle };
  /** Images are content-addressed board resources; URLs never enter the scene. */
  image?: { assetHash: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number };
  componentId?: string;
};
export type BoardVectorAsset = {
  format: "board-vector-v1";
  id: string;
  version: number;
  name: string;
  width: number;
  height: number;
  rootIds: string[];
  nodes: BoardVectorNode[];
  /** Named component roots can be instantiated without copying their source nodes. */
  components?: Array<{ id: string; name: string; rootId: string }>;
  geometryHash?: string;
  createdAt: string;
};
export type BoardAnchor =
  | { kind: "markdown"; key: string; quote: string; sourceLine?: number }
  | { kind: "pdf"; page: number }
  | { kind: "canvas"; pageId: string };
export type BoardActor = "human" | "tutor";
export type BoardBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "soft-light"
  | "hard-light";
export type BoardBrushKind =
  | "pen"
  | "fountain"
  | "pencil"
  | "marker"
  | "highlighter"
  | "chalk"
  | "crayon"
  | "watercolor"
  | "sumi"
  | "oil";
export type BoardBrushStyle = {
  kind: BoardBrushKind;
  opacity: number;
  pressure: boolean;
  smoothing: number;
  streamline: number;
  nibAngle?: number;
  /** Dab-engine controls. Older vector strokes omit these fields. */
  flow?: number;
  hardness?: number;
  spacing?: number;
  roundness?: number;
  scatter?: number;
  grainScale?: number;
  grainStrength?: number;
  stabilization?: number;
  pressureSize?: number;
  pressureFlow?: number;
  pressureOpacity?: number;
  /** Directional fibre and paint-body controls used by material brushes. */
  bristleDensity?: number;
  dryness?: number;
  impasto?: number;
  preventSelfOverlap?: boolean;
  /** Missing means the original dab renderer; v2 snapshots opt into resource-aware rendering. */
  engineVersion?: 2;
  tipHash?: string;
  grainHash?: string;
  paperHash?: string;
  resourceHashes?: string[];
  seed: number;
};
export type BoardFillStyle = {
  kind: "none" | "solid" | "hachure" | "dots" | "paper" | "brush";
  /** Native brush recipe for deterministic region painting, clipped to its boundary. */
  brush?: BoardBrushStyle;
  color: string;
  opacity: number;
  seed: number;
};
export type BoardLayer = {
  id: string;
  name: string;
  order: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BoardBlendMode;
  /** v4 fields are optional while a v1-v3 document is being lazily upgraded. */
  kind?: "vector" | "paint" | "group";
  parentId?: string;
  alphaLocked?: boolean;
  clippedToBelow?: boolean;
};
export type BoardArtboard = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
  background: string;
  exportPreset: "screen" | "print" | "custom";
};
export type BoardBrushResourceRef = {
  hash: string;
  mimeType: "image/png" | "image/webp";
  width: number;
  height: number;
  path?: string;
  license?: string;
  author?: string;
  source?: string;
};
export type BoardBrushDefinition = {
  formatVersion: 1 | 2;
  id: string;
  version: number;
  name: string;
  engine: "outline" | "dab";
  kind: BoardBrushKind;
  style: BoardBrushStyle;
  tip?: BoardBrushResourceRef;
  grain?: BoardBrushResourceRef;
  paper?: BoardBrushResourceRef;
  /** Numeric, data-only subset of MyPaint presets; no code or external references. */
  myb?: {
    version: 3;
    settings: Record<string, { base_value: number; inputs?: Record<string, Array<[number, number]>> }>;
  };
  author?: string;
  license?: string;
  source?: string;
};
export type BoardPaintOperation = {
  id: string;
  layerId: string;
  type: "stroke" | "erase" | "fill" | "gradient";
  bounds: BoardRect;
  affectedTiles: string[];
  color: string;
  opacity: number;
  strokeWidth?: number;
  inkId?: string;
  brush?: BoardBrushStyle;
  /** Deterministic alpha-mask bytes live in the board asset store. */
  maskAssetHash?: string;
  maskWidth?: number;
  maskHeight?: number;
  fillTolerance?: number;
  /** Captured at operation time, never retroactively applied to earlier strokes. */
  alphaLocked?: boolean;
  clipRect?: BoardRect;
  /** v5 selection clip. clipRect remains readable for older documents. */
  selection?: BoardSelectionRegion;
  gradient?: {
    kind: "linear" | "radial";
    from: BoardPoint;
    to: BoardPoint;
    endColor: string;
  };
  createdAt: string;
  revision: number;
};
export type BoardTileRef = {
  key: string;
  layerId: string;
  x: number;
  y: number;
  revision: number;
  checksum: string;
  path: string;
  /** Inclusive paint-operation revision represented by the tile bytes. */
  operationFromRevision?: number;
  operationToRevision?: number;
  dependencies?: string[];
  byteLength?: number;
};
export type BoardTileManifest = {
  format: "board-tiles-v1";
  tileSize: 512;
  gutter: number;
  checkpointRevision: number;
  compression?: "deflate-rgba-v1";
  tiles: BoardTileRef[];
};
export type BoardBackground = {
  kind: "plain" | "dark" | "lined" | "grid" | "dots" | "paper";
  color: string;
  spacing: number;
  opacity: number;
};
export type BoardTextStyle = {
  font: "handwritten" | "sans";
  size: number;
  align: "left" | "center" | "right";
};
export type BoardDrawingStyle = { kind: "clean" | "sketch"; seed: number };
export type BoardMarkdownAnchorRecord = {
  id: string;
  from: number;
  to: number;
  quote: string;
  before: string;
  after: string;
  blockId?: string;
  aliases: string[];
  status: "located" | "missing";
};
export type BoardMarkdownAnchorState = {
  textVersion: string;
  entries: BoardMarkdownAnchorRecord[];
};
export type BoardExpression =
  | "thinking"
  | "curious"
  | "discovery"
  | "encouraging"
  | "celebrating"
  | "quiet";
export type InkStroke = { id: string; points: BoardPoint[]; createdAt: string };
export type BoardInk = Record<string, InkStroke>;
export type InkRecognition = {
  text: string;
  alternatives: string[];
  language: string;
  provider: string;
  model?: string;
  engineVersion?: string;
  recognizedAt: string;
  userCorrected: boolean;
  confidence?: number;
  segments?: Array<{ text: string; strokeIds: string[] }>;
};
export type BoardSemanticKind =
  | "handwriting"
  | "underline"
  | "highlight"
  | "circle"
  | "connector"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "unknown";
export type BoardSemanticGroup = {
  id: string;
  objectIds: string[];
  kind: BoardSemanticKind;
  confidence: number;
  replacementObjectIds?: string[];
  recognition?: InkRecognition;
  createdAt: string;
  updatedAt: string;
};
export type BoardInkPackRef = {
  id: string;
  strokeIds: string[];
  sealed: boolean;
  pointCount: number;
};
export type BoardInkManifest = {
  format: "ink-pack-v1";
  packs: BoardInkPackRef[];
};
export type BoardObject = {
  id: string;
  kind:
    | "ink"
    | "path"
    | "arrow"
    | "rect"
    | "ellipse"
    | "text"
    | "character"
    | "sticker"
    | "vector";
  anchor: BoardAnchor;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise radians around the object's x/y origin. */
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  color: string;
  strokeWidth: number;
  layerId?: string;
  opacity?: number;
  blendMode?: BoardBlendMode;
  brush?: BoardBrushStyle;
  fill?: BoardFillStyle;
  sourceInkIds?: string[];
  /** Inclusive sample intervals hidden by the non-destructive point eraser. */
  erasedRanges?: Array<[number, number]>;
  /** Ink/path points use local coordinates in the object's original size. */
  points?: BoardPoint[];
  inkId?: string;
  text?: string;
  textStyle?: BoardTextStyle;
  drawingStyle?: BoardDrawingStyle;
  /** Visual grouping is independent of the history transaction groupId. */
  selectionGroupId?: string;
  /** Learner-defined character part; persists with editable objects/assets. */
  characterPart?: { id: string; name: string };
  assetId?: string;
  assetVersion?: number;
  characterId?: string;
  characterVersion?: number;
  expression?: BoardExpression;
  vectorAssetId?: string;
  vectorAssetVersion?: number;
  characterRecipe?: BoardCharacterRecipe;
  createdBy: BoardActor;
  editedBy: BoardActor;
  revision: number;
  groupId: string;
};
export type BoardCharacterJoint = {
  id: string;
  name: string;
  parentId?: string;
  x: number;
  y: number;
  minAngle?: number;
  maxAngle?: number;
};
export type BoardCharacterDefinition = {
  format: "board-character-v1";
  id: string;
  version: number;
  name: string;
  vectorAssetId: string;
  vectorAssetVersion: number;
  rig: { joints: BoardCharacterJoint[] };
  parts: Array<{
    id: string;
    name: string;
    slot: string;
    rootNodeId: string;
    layer: number;
    exclusive?: boolean;
  }>;
  faceControls: Array<{
    id: string;
    channel: "emotion" | "mouth" | "blink" | "gaze" | "micro";
    nodeIds: string[];
    min: number;
    max: number;
  }>;
  presets: Array<{
    id: string;
    kind: "pose" | "emotion" | "gesture" | "outfit" | "prop";
    values: Record<string, number | string | boolean>;
  }>;
  rules: {
    exclusiveSlots: string[];
    handOccupancy: Array<{ presetId: string; hands: Array<"left" | "right"> }>;
    layerOrder: string[];
  };
  createdAt: string;
};
export type BoardCharacterRecipe = {
  definitionId: string;
  definitionVersion: number;
  pose: string;
  gestures: string[];
  expression: {
    emotion: Record<string, number>;
    mouth: Record<string, number>;
    blink: Record<string, number>;
    gaze: Record<string, number>;
    micro: Record<string, number>;
  };
  outfit?: string;
  props: string[];
  geometryHash?: string;
};
export type TutorCharacterProfile = {
  id: string;
  version: number;
  name: string;
  origin: "builtin" | "uploaded" | "co_created";
  style: "round" | "book" | "custom";
  width: number;
  height: number;
  createdAt: string;
  assetPath?: string;
  objects?: BoardObject[];
  ink?: BoardInk;
  vectorAssets?: BoardVectorAsset[];
  characterDefinitions?: BoardCharacterDefinition[];
  usage?: "character" | "sticker" | "both";
  tags?: string[];
};
/** Per-user visibility only; profile manifests stay immutable for old artwork. */
export type BoardAssetLibraryState = {
  formatVersion: 1;
  hiddenProfileIds: string[];
  /** Per-expression visibility for immutable built-in cards. */
  hiddenStickerKeys: string[];
  updatedAt: string;
};
export type BoardDocument = {
  schemaVersion: 1 | 2 | 3 | 4 | 5;
  id: string;
  title?: string;
  sourceFile: string;
  sourceType: "markdown" | "pdf" | "standalone";
  sourceRevision: string;
  markdownAnchors?: BoardMarkdownAnchorState;
  revision: number;
  objects: BoardObject[];
  layers?: BoardLayer[];
  background?: BoardBackground;
  semanticGroups?: BoardSemanticGroup[];
  inkManifest?: BoardInkManifest;
  artboards?: BoardArtboard[];
  brushDefinitions?: BoardBrushDefinition[];
  paintOperations?: BoardPaintOperation[];
  tileManifest?: BoardTileManifest;
  palette?: string[];
  characterId: string;
  characterVersion: number;
  vectorAssets?: BoardVectorAsset[];
  characterDefinitions?: BoardCharacterDefinition[];
  createdAt: string;
  updatedAt: string;
};
export type BoardBundle = { document: BoardDocument; ink: BoardInk; layout?: import("./board-layout.js").BoardLayoutManifest;
  /** Runtime recovery metadata, deliberately absent from the geometry manifest. */
  recovery?: { baseline: BoardDocument; conflicted: boolean } };

export type BoardShareFormat =
  | "png"
  | "jpeg"
  | "webp"
  | "svg"
  | "pdf"
  | "ora"
  | "tutorboard"
  | "gallery";
export type BoardShareRequest = {
  document: BoardDocument;
  ink: BoardInk;
  format: BoardShareFormat;
  artboardIds?: string[];
  scale?: number;
  dpi?: number;
  transparent?: boolean;
  title?: string;
  author?: string;
  license?: string;
  includeHidden?: boolean;
  includePrivateMetadata?: boolean;
};
export type BoardShareResult = {
  provider: string;
  format: BoardShareFormat;
  path?: string;
  shared: boolean;
};
export interface BoardShareProvider {
  readonly id: string;
  availability(): Promise<{ available: boolean; reason?: string }>;
  share(request: BoardShareRequest): Promise<BoardShareResult>;
}

export type RecognitionRequest = {
  strokes: InkStroke[];
  languages: string[];
  textContext?: string;
  writingArea: { width: number; height: number };
  imageBase64?: string;
};
export type RecognitionResult = Omit<InkRecognition, "recognizedAt" | "userCorrected">;
export interface RecognitionProvider {
  readonly id: string;
  availability(): Promise<{ available: boolean; reason?: string }>;
  recognize(request: RecognitionRequest, signal?: AbortSignal): Promise<RecognitionResult>;
}
export type BoardSnapshot = {
  pngBase64: string;
  width: number;
  height: number;
  /** Image pixels -> canonical coordinates of the single target anchor. */
  imageToBoard: BoardMatrix;
  anchor: BoardAnchor;
  layoutRevision: string;
};
export type BoardOperation =
  | { type: "add"; object: BoardObject }
  | {
      type: "update";
      objectId: string;
      expectedRevision: number;
      object: BoardObject;
    }
  | { type: "remove"; objectId: string; expectedRevision: number };
export type BoardAgentRequest = {
  boardId: string;
  sessionId: string;
  requestId: string;
  baseRevision: number;
  sourceRevision: string;
  bufferRevision?: string;
  projectionId?: string;
  layoutRevision?: number;
  sourceFile: string;
  anchor: BoardAnchor;
  snapshot: BoardSnapshot;
  objects: BoardObject[];
  /** Host-owned original object coordinates -> this screenshot's pixels.
   * Layout attachments may give objects in one region different transforms. */
  objectToImage?: Record<string, BoardMatrix>;
  instruction: string;
  context: string;
  learningSummary?: string;
  /** Optional independent, fallible qualitative observations for teaching. */
  learningInsightSummary?: string;
  /** Selects the bounded prompt/tool policy without changing the transport. */
  purpose?: "teaching" | "artist";
  /** Visual-feedback round for staged artist sessions (1..3). */
  feedbackRound?: number;
  /** Host-authored feedback for one bounded protocol correction, never user data. */
  protocolCorrection?: string;
  /** Semantic action intent survives into validation even without drawing keywords. */
  requiresDrawing?: boolean;
  math?: boolean;
  /** Host-reserved blank area in snapshot pixels; never supplied by the model. */
  drawingArea?: BoardRect;
  /** Screenshot pixels per CSS pixel, for host-computed labels and strokes. */
  drawingPixelRatio?: number;
  character: TutorCharacterProfile | null;
  availableAssets?: TutorCharacterProfile[];
  /** Shared Tutor conversation; previous screenshots are never retained here. */
  history?: { role: "user" | "assistant"; content: string }[];
};
/** Text deltas and validated, transient drawings; persist only a successful result. */
export type BoardAgentEvent =
  | { type: "reply"; text: string }
  | { type: "reset" }
  | { type: "preview"; operations: BoardOperation[] };
export type BoardAgentResult =
  | {
      ok: true;
      operations: BoardOperation[];
      description: string;
      requestId: string;
      baseRevision: number;
    }
  | { ok: false; error: string; code?: string;
      failure?: import("./ai-execution.js").AIExecutionFailure;
      drawingBounds?: { x: number; y: number; width: number; height: number; imageWidth: number; imageHeight: number } };
export interface BoardAgent {
  request(request: BoardAgentRequest, onEvent?: (event: BoardAgentEvent) => void): Promise<BoardAgentResult>;
  cancel(): void;
  dispose(): void;
}

export type BoardCreationMode = "auto" | "illustration" | "brush" | "mechanics" | "vector" | "character";
export type ImageGenerationRequest = {
  requestId: string;
  prompt: string;
  width: number;
  height: number;
  quality: "preview" | "standard" | "high";
  transparent: boolean;
  referenceImages?: Array<{ bytes: Uint8Array; mimeType: string; role: "reference" | "style" }>;
  mask?: { bytes: Uint8Array; mimeType: "image/png"; x: number; y: number; width: number; height: number };
  seed?: number;
  /** Provider-neutral advanced controls; unsupported providers may ignore them. */
  count?: number;
  negativePrompt?: string;
  promptExtend?: boolean;
  promptExtendMode?: "direct" | "agent";
  thinking?: boolean;
  watermark?: boolean;
};
export type ImageGenerationCandidate = {
  id: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  model: string;
  modelVersion?: string;
  seed?: number;
  latencyMs: number;
  costUsd?: number;
  provenance: {
    provider: string;
    generatedAt: string;
    revisedFrom?: string;
    providerRequestId?: string;
    outputTier?: string;
  };
};
export interface ImageGenerationProvider {
  readonly id: string;
  capabilities(): Promise<{
    generation: boolean;
    editing: boolean;
    mask: boolean;
    references: boolean;
    transparency: boolean;
    partialPreviews: boolean;
    seed: boolean;
  }>;
  availability(): Promise<{ available: boolean; reason?: string }>;
  generate(
    request: ImageGenerationRequest,
    signal?: AbortSignal,
    onPreview?: (candidate: ImageGenerationCandidate) => void,
  ): Promise<ImageGenerationCandidate[]>;
  edit(
    request: ImageGenerationRequest & { source: ImageGenerationCandidate },
    signal?: AbortSignal,
    onPreview?: (candidate: ImageGenerationCandidate) => void,
  ): Promise<ImageGenerationCandidate[]>;
  cancel(requestId: string): void;
}

export type BoardArtistStage = "composition" | "large-forms" | "details";
export type BoardArtistStrategy = "single-prompt" | "few-shot" | "planner-tools";
export type BoardArtistCheckpoint = {
  stage: BoardArtistStage;
  round: number;
  operations: BoardOperation[];
  snapshot?: BoardSnapshot;
  description: string;
  /** Time from stage request to the first schema-valid transient operation preview. */
  firstPreviewLatencyMs?: number;
};
export type BoardArtistSessionRequest = {
  board: BoardAgentRequest;
  maxFeedbackRounds?: number;
  strategy?: BoardArtistStrategy;
};
export interface BoardArtistSession {
  run(
    request: BoardArtistSessionRequest,
    signal?: AbortSignal,
    onCheckpoint?: (checkpoint: BoardArtistCheckpoint) => void,
  ): Promise<BoardCreationResult>;
  cancel(): void;
  dispose(): void;
}

export type BoardCreationResult =
  | {
      kind: "raster-layer";
      mode: "illustration";
      candidates: ImageGenerationCandidate[];
      editable: "pixels";
      provenance: Record<string, unknown>;
    }
  | {
      kind: "brush-group";
      mode: "brush";
      operations: BoardOperation[];
      checkpoints: BoardArtistCheckpoint[];
      editable: "native-brushes";
      provenance: Record<string, unknown>;
    }
  | {
      kind: "mechanics-group";
      mode: "mechanics";
      operations: BoardOperation[];
      semanticDocument: unknown;
      warnings: string[];
      editable: "vector-objects";
      provenance: Record<string, unknown>;
    }
  | {
      kind: "vector-scene";
      mode: "vector";
      asset: BoardVectorAsset;
      editable: "vector-nodes";
      provenance: Record<string, unknown>;
    }
  | {
      kind: "character-instance";
      mode: "character";
      recipe: BoardCharacterRecipe;
      asset: BoardVectorAsset;
      editable: "character-controls";
      provenance: Record<string, unknown>;
    };

export type VectorizationRequest = {
  requestId: string;
  mode: "trace" | "semantic";
  image: { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number };
  prompt?: string;
  maxColors?: number;
  simplify?: number;
};
export type VectorizationResult = {
  asset: BoardVectorAsset;
  source: { provider: string; model?: string; generatedAt: string };
  latencyMs: number;
  editability: { namedPartRatio: number; pathCount: number; commandCount: number };
  stages?: Array<{
    stage: "preprocess" | "plan" | "generate" | "validate" | "repair" | "complete";
    startedAt: string;
    completedAt?: string;
    message?: string;
  }>;
  semanticPartRatio?: number;
  visualDifference?: number;
  repairCount?: number;
  warnings: string[];
};
export type VectorizationProgress = {
  stage: "preprocess" | "plan" | "generate" | "validate" | "repair" | "complete";
  message?: string;
  asset?: BoardVectorAsset;
  repairRound?: number;
};
export interface VectorizationProvider {
  readonly id: string;
  availability(): Promise<{ available: boolean; reason?: string }>;
  capabilities(): Promise<{ trace: boolean; semantic: boolean; previews: boolean }>;
  vectorize(
    request: VectorizationRequest,
    signal?: AbortSignal,
    onPreview?: (asset: BoardVectorAsset) => void,
    onProgress?: (progress: VectorizationProgress) => void,
  ): Promise<VectorizationResult>;
}

export type BoardToolEvent =
  | { type: "result"; data: Record<string, unknown> }
  | { type: "diff"; created: string[]; updated: string[]; removed: string[]; affected?: BoardRect }
  | { type: "preview"; asset: BoardVectorAsset; stage?: string }
  | { type: "checkpoint"; id: string; warnings: string[] }
  | { type: "warning"; code: string; message: string }
  | { type: "complete"; revision: number };
export type BoardToolCall = { name: string; arguments: Record<string, unknown> };
export type BoardToolDescriptor = {
  name: string;
  category: "scene" | "transaction" | "node" | "vector" | "layout" | "character" | "validation";
  description: string;
  write: boolean;
};
export interface BoardToolRuntime {
  capabilities(): { maxNodesPerCall: number; maxSessionNodes: number; maxPathCommands: number; categories: string[] };
  searchTools(query?: string, category?: BoardToolDescriptor["category"]): BoardToolDescriptor[];
  beginTransaction(input: { artboardId: string; baseRevision: number; asset?: BoardVectorAsset }): Promise<{ transactionId: string }>;
  call(transactionId: string, call: BoardToolCall): AsyncIterable<BoardToolEvent>;
  checkpoint(transactionId: string): Promise<{ id: string; asset: BoardVectorAsset; warnings: string[] }>;
  commit(transactionId: string): Promise<{ asset: BoardVectorAsset; revision: number }>;
  rollback(transactionId: string): Promise<void>;
}
export interface BoardCharacterResolver {
  validateRecipe(definition: BoardCharacterDefinition, recipe: BoardCharacterRecipe): { valid: boolean; errors: string[]; warnings: string[] };
  resolve(definition: BoardCharacterDefinition, recipe: BoardCharacterRecipe, source: BoardVectorAsset): BoardVectorAsset;
  bakeToVectorAsset(definition: BoardCharacterDefinition, recipe: BoardCharacterRecipe, source: BoardVectorAsset): BoardVectorAsset;
}
export interface BoardMcpAdapter {
  readonly running: boolean;
  start(): Promise<{ host: "127.0.0.1"; port: number; token: string }>;
  stop(): Promise<void>;
}
