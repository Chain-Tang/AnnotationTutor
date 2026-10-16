import type { BoardSourceMoveParticipant } from "../board-store.js";
import type { SurfaceTransactionJournal } from "../surface-transaction-journal.js";
import { SurfaceCommitError, requireDurableSurfaceCommit, type SurfaceCommitReceipt } from "../tutor-surface.js";
import {renderVectorInspector} from "../board-vector-inspector.js";
import type {planVectorEdit} from "../board-vector-agent.js";
import { BoardRenderMetrics } from "../board-metrics.js";
import { boardCameraPreviewTransform } from "../board-camera-preview.js";
import { planProgressiveScene } from "../board-progressive-render.js";
import { BoardOutlinePreparation, canPreparePressureOutline } from "../board-outline-preparation.js";
import { LiveBrushPainter } from "../board-live-paint.js";
import { StudioLayerRenderer, canPreviewOnStaticScene } from "../board-layer-renderer.js";
import { TutorBoardSurface } from "../tutor-board-surface.js";
import { requestBoardWithRepair } from "../board-agent.js";
import { TutorTaskCoordinator, type ContextGrant } from "../tutor-task.js";
import type { TutorAction } from "../tutor-intent.js";
import { ItemView, Notice, Modal, Menu, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { deflateSync, inflateSync } from "fflate";
import type { TutorCharacterProfile, BoardAgent, BoardArtistStrategy, BoardBundle, BoardObject, BoardPoint, BoardBrushKind, BoardBrushStyle, BoardVectorAsset, ImageGenerationCandidate, ImageGenerationProvider, BoardSelectionRegion, VectorizationProvider } from "../board-types.js";
import { BoardHistory, upgradeBoardDocument } from "../board-model.js";
import { BOARD_BRUSHES, brushComposite, defaultBoardBrush, studioBoardBrush } from "../board-brushes.js";
import { affectedBoardTiles, floodFillMask } from "../board-paint.js";
import { brushEngineFor, missingBrushResources } from "../board-brush-engine.js";
import { boardGalleryMarkdown, buildOpenRasterArchive, buildTutorBoardArchive } from "../board-share.js";
import { exportTutorBrush, importTutorBrush, sha256Hex } from "../board-brush-pack.js";
import { jpegPagesToPdf } from "../board-export.js";
import { BoardSpatialIndex, boardObjectBounds } from "../board-spatial.js";
import { decorateBoardButton } from "../board-ui.js";
import { BOARD_BRUSH_DEFAULT_WIDTHS, BrushSizeControl, paintBoardBrushPreview, positionBoardBrushCursor } from "../board-brush-ui.js";
import {
  prepareBoardImages,
  renderBoardBackgroundCanvas,
  renderBoardCanvas,
  renderBoardSvg,
} from "../board-renderer.js";
import { t } from "../i18n.js";
import { applyBoardOperations, createBoardArtistSession } from "../board-ai.js";
import { describeBoardAiError } from "../board-ai-error.js";
import { mechanicsTemplateFromInstruction, renderMechanicsDiagram, validateMechanicsDiagram } from "../board-mechanics.js";
import { isBoardImage1KSize } from "../settings-config.js";
import { exportVectorAssetSvg, importSafeSvg, renderVectorAssetCanvas } from "../board-vector.js";
import { createRasterTraceVectorizationProvider } from "../board-vectorization.js";
import { BOARD_ARTWORK_STAGES, createThreeCharacterCoverSession, defaultThreeCharacterArtworkPlan, inspectThreeCharacterCover, type BoardArtworkStage } from "../board-comic-cover.js";
import { refineComicCoverWithModel } from "../board-artwork-agent.js";
import { BoardPaintCheckpointService, type RestoredBoardTile } from "../board-paint-checkpoint.js";
import {
  boundsForPoints,
  flipObjects,
  hitTransformHandle,
  moveObjects,
  objectIntersectsRegion,
  pointInPolygon,
  pointInRect,
  rotateObjects,
  scaleObjects,
  selectionBounds,
  type BoardTransformHandle,
} from "../board-selection.js";

export const BOARD_VIEW_TYPE = "annotation-tutor-lite-board";
type Tool = "select" | "pan" | "pen" | "erase" | "lasso" | "fill" | "gradient" | "eyedropper" | "transform" | "crop" | "arrow" | "rect" | "ellipse" | "text";
type Host = {
  vectorPlan?(input:Omit<Parameters<typeof planVectorEdit>[0],"connection">):ReturnType<typeof planVectorEdit>;
  tasks?: TutorTaskCoordinator;
  transactions?:SurfaceTransactionJournal;
  connection?(): { engine: string; model: string };
  resolveAction?(text: string, signal: AbortSignal): Promise<TutorAction>;
  assets?(): Promise<TutorCharacterProfile[]>;
  saveAsset?(profile: TutorCharacterProfile): Promise<void>;
  resolveAsset?(path: string): string;
  imageAssetFolder?(): string;
  readAsset?(path: string): Promise<ArrayBuffer>;
  open(sourceFile: string): Promise<BoardBundle>;
  chooseVersion?(sourceFile: string, boardId: string): Promise<void>;
  save(bundle: BoardBundle, previewSvg?: string): Promise<void>;
  writeExport?(path: string, data: string | ArrayBuffer): Promise<void>;
  writeBrushResource?(hash: string, mimeType: "image/png" | "image/webp", data: ArrayBuffer): Promise<string>;
  writePaintAsset?(hash: string, data: ArrayBuffer): Promise<void>;
  readPaintAsset?(hash: string): Promise<ArrayBuffer | null>;
  writePaintTile?(boardId:string,layerId:string,key:string,revision:number,data:ArrayBuffer):Promise<string>;
  readPaintTile?(path:string):Promise<ArrayBuffer|null>;
  createAgent?(): BoardAgent;
  openSettings?(): void;
  createImageProvider?(): ImageGenerationProvider | null;
  createVectorizationProvider?(mode:"trace"|"semantic"):VectorizationProvider|null;
  artworkComplete?(input:{prompt:string;imageDataUrl:string},signal:AbortSignal):Promise<string>;
  imageGenerationDefaults?(): {
    width: number;
    height: number;
    count: number;
    negativePrompt: string;
    seed?: number;
    promptExtend: boolean;
    promptExtendMode: "direct" | "agent";
    thinking: boolean;
    watermark: boolean;
  };
};
const anchor = { kind: "canvas", pageId: "main" } as const;
const id = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`;
const copy = <T>(value: T): T => structuredClone(value);
function pointBounds(points: readonly BoardPoint[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Infinite-canvas view sharing the same versioned document/ink protocol as overlays. */
export class StandaloneBoardView extends ItemView {
  private embeddedImages = new Map<string, string>();
  private imageBytes = new Map<string, Uint8Array>();
  private resolveImage = (path: string) => this.embeddedImages.get(path) ?? this.host.resolveAsset?.(path) ?? path;
  private profiles: TutorCharacterProfile[] = [];
  private sourceFile = "";
  private bundle: BoardBundle | null = null;
  private history: BoardHistory | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private staticCanvas: HTMLCanvasElement | null = null;
  private progressCanvas: HTMLCanvasElement | null = null;
  private progressiveFrame = 0;
  private progressiveGeneration = 0;
  private progressiveKey = "";
  private outlinePreparation: BoardOutlinePreparation | null = null;
  public lastProgressiveRender: { durationMs: number; maxStepMs: number; steps: number; objects: number;
    preparationMs: number; workerBatches: number; maxGapMs: number } | null = null;
  public progressiveRenderEnabled = true;
  private backgroundCanvas?:HTMLCanvasElement;
  private draftCanvas?:HTMLCanvasElement;
  private visibleObjects:BoardObject[]=[];
  private staticRenderKey = "";
  private cameraPreviewTimer = 0;
  private renderedCamera: { key: string; revision: number; width: number; height: number; ratio: number; pan: { x: number; y: number }; zoom: number; rotation: number; mirrored: boolean; center: { x: number; y: number }; objects: BoardObject[] | null } | null = null;
  private readonly paintAssets = new Map<string, Uint8Array>();
  private readonly brushBytes = new Map<string, Uint8Array>();
  private readonly brushImages = new Map<string, ImageBitmap>();
  private readonly missingBrushHashes = new Set<string>();
  private brushLoad:Promise<void>|null=null;
  private readonly fillCanvases = new Map<string, HTMLCanvasElement>();
  private checkpointService?:BoardPaintCheckpointService;
  private readonly restoredTiles=new Map<string,{tile:RestoredBoardTile;canvas:HTMLCanvasElement}>();
  private tileRestoreKey="";
  private visiblePaintViewport:{x:number;y:number;width:number;height:number}|null=null;
  private minimap: HTMLCanvasElement | null = null;
  private minimapObjectCache: { objects: readonly BoardObject[]; revision: number; boxes: ReturnType<typeof boardObjectBounds>[]; left: number; top: number; right: number; bottom: number } | null = null;
  private observer: ResizeObserver | null = null;
  private readonly spatial = new BoardSpatialIndex();
  private tool: Tool = "pen";
  private brush:BoardBrushStyle = studioBoardBrush("pen");
  private color = "#292929";
  private width = 3;
  private readonly brushWidths = new Map<BoardBrushKind, number>(
    BOARD_BRUSHES.map(kind => [kind, BOARD_BRUSH_DEFAULT_WIDTHS[kind]]),
  );
  private sizeControl: BrushSizeControl | null = null;
  private brushCursor: HTMLDivElement | null = null;
  private activeLayerId = "layer-default";
  private pan = { x: 0, y: 0 };
  private zoom = 1;
  private pendingInitialFit = false;
  private raf = 0;
  private saveTimer = 0;
  private previewTimer = 0;
  private previewSave: Promise<void> | null = null;
  private saveTail: Promise<void> = Promise.resolve();
  private savePending = 0;
  private sceneDirty = false;
  private saveEpoch = 0;
  private flushWork: Promise<void> | null = null;
  private closeWork: Promise<void> | null = null;
  private transitions = 0;
  private spaceDown = false;
  private readonly selectedIds = new Set<string>();
  private activeArtboardId = "artboard-main";
  private statusEl: HTMLElement | null = null;
  private canvasRotation = 0;
  public readonly renderMetrics=new BoardRenderMetrics();
  private readonly livePainter=new LiveBrushPainter();
  private readonly layerRenderer=new StudioLayerRenderer();
  private layerFingerprintKey="";
  private layerFingerprints=new Map<string,string>();
  private paintSelection?:BoardSelectionRegion;
  private mirrorPreview = false;
  private symmetry = false;
  private draftObjects: BoardObject[] | null = null;
  private draftRenderRevision = 0;
  private refreshVectorInspector?:()=>void;
  private refreshSelectionInspector?:()=>void;
  private aiAbort: AbortController | null = null;
  private aiAgent: BoardAgent | null = null;
  private closeAiPanel: (() => void) | null = null;
  private readonly touches = new Map<number, BoardPoint>();
  private pinch: { distance: number; zoom: number; world: BoardPoint } | null = null;
  private gesture: null | {
    pointerId: number;
    mode: Tool;
    startClient: BoardPoint;
    startWorld: BoardPoint;
    lastClient: BoardPoint;
    points: BoardPoint[];
    seed: number;
    before?: BoardObject[];
    objectIds?: string[];
    selectionBounds?: { x: number; y: number; width: number; height: number };
    transformHandle?: BoardTransformHandle;
    shiftKey?: boolean;
    altKey?: boolean;
  } = null;

  public constructor(leaf: WorkspaceLeaf, private readonly host: Host) {
    super(leaf);
  }
  public override getViewType(): string { return BOARD_VIEW_TYPE; }
  public override getDisplayText(): string { return t("board.standaloneTitle"); }
  public override getIcon(): string { return "presentation"; }
  public override getState(): Record<string, unknown> { return { sourceFile: this.sourceFile }; }
  private surfaceInstance?: TutorBoardSurface;
  private closed = false;
  private loadGeneration = 0;
  private stateGeneration = 0;
  private boardLoad: Promise<void> | null = null;
  private stateReady: Promise<void> = Promise.resolve();
  private sourceMoveIdle: Promise<void> | null = null;
  private resolveSourceMoveIdle?: () => void;
  private loadError: unknown;

  /** Restored leaves can have the right type before their asynchronous state is ready. */
  public async whenReady(): Promise<void> {
    await this.stateReady;
    if (this.boardLoad) await this.boardLoad;
    if (this.closed || this.transitions || !this.history || !this.bundle) throw this.loadError ?? new Error("studio-not-ready");
  }

  public toolSurface(): TutorBoardSurface {
    if (this.closed || this.transitions || !this.history || !this.bundle) throw new Error("studio-not-ready");
    if (this.surfaceInstance?.id !== this.history.document.id) {
      const generation = this.loadGeneration;
      const history = this.history, bundle = this.bundle;
      const alive = () => !this.closed && !this.transitions && generation === this.loadGeneration &&
        this.history === history && this.bundle === bundle && this.containerEl.isConnected;
      const assertCurrent = () => { if (!alive()) throw new Error("surface-closed"); };
      this.surfaceInstance = new TutorBoardSurface(this.history.document.id, "studio", {
        assets:()=>this.profiles,history: () => history, ink: () => bundle.ink, alive,
        selection: () => [...this.selectedIds],
        capture: async () => { assertCurrent(); await this.prepareImages(); assertCurrent(); return this.snapshotForObjects(history.document.objects); },
        preview: async (objects,assets) => { assertCurrent(); await this.prepareImages(); assertCurrent(); return objects ? renderBoardSvg(objects, { width: this.activeArtboard().width, height: this.activeArtboard().height, ink: bundle.ink, characters: this.profiles, resolveAsset: this.resolveImage, vectorAssets: assets??history.document.vectorAssets,brushResources:this.brushImages,missingBrushResource:this.reportMissingBrushResource }) : this.preview(); },
        changed: () => { assertCurrent(); this.sceneDirty = true; this.saveEpoch++; this.staticRenderKey = ""; this.schedule(); },
        save: async () => { assertCurrent(); this.sceneDirty = true; await this.saveScene(); assertCurrent(); this.queueDerivedPreview(); },
      });
    }
    if(this.host.transactions)this.surfaceInstance.useTransactions(this.host.transactions);
    return this.surfaceInstance;
  }
  public conversationTarget():{boardId:string;artboardId:string;layerId:string;sourceFile:string}{
    if(this.closed||this.transitions||!this.history)throw new Error("studio-not-ready");
    return {boardId:this.history.document.id,artboardId:this.activeArtboard().id,layerId:this.activeLayerId,sourceFile:this.sourceFile};
  }
  public boardToolContext(artboardId: string): { asset?: BoardVectorAsset; objectId?:string; revision: number; boardId: string; artboardId: string; layerId: string; sourceFile: string } {
    if (this.closed || this.transitions || !this.history) throw new Error("Open a Tutor Studio board before connecting Board MCP");
    if (artboardId !== "active" && !this.history.document.artboards?.some(item => item.id === artboardId))
      throw new Error(`Unknown Artboard: ${artboardId}`);
    const selected = this.history.document.objects.find(item => this.selectedIds.has(item.id) && item.kind === "vector");
    const object = selected ?? [...this.history.document.objects].reverse().find(item => item.kind === "vector"&&item.createdBy==="tutor"&&item.editedBy==="tutor");
    const asset = object ? this.history.document.vectorAssets?.find(item => item.id === object.vectorAssetId && item.version === object.vectorAssetVersion) : undefined;
    if (this.statusEl) this.statusEl.textContent = "AI 正在编辑隔离草稿…";
    return { ...(asset ? { asset: copy(asset) } : {}), objectId:object?.id,revision: this.history.document.revision,
      boardId: this.history.document.id, layerId: this.activeLayerId, artboardId: artboardId === "active" ? this.activeArtboard().id : artboardId, sourceFile: this.sourceFile };
  }
  public commitBoardToolAsset(artboardId: string, baseRevision: number, asset: BoardVectorAsset, layerId = this.activeLayerId, boundObjectId?:string): void {
    if (this.closed || this.transitions || !this.history || this.history.document.revision !== baseRevision)
      throw new Error(`Board revision conflict: expected ${baseRevision}, found ${this.history?.document.revision ?? "closed"}`);
    const artboard = artboardId === "active"
      ? this.activeArtboard()
      : this.history.document.artboards?.find(item => item.id === artboardId);
    if (!artboard) throw new Error(`Unknown Artboard: ${artboardId}`);
    let objectId = boundObjectId;
    if(!this.layerEditable(layerId))throw new Error("layer-locked");
    if(objectId&&!this.history.document.objects.some(o=>o.id===objectId&&o.kind==="vector"))throw new Error("bound-object-unavailable");
    this.history.transact(document => {
      document.vectorAssets ??= [];
      const next=copy(asset);next.version=Math.max(0,...document.vectorAssets.filter(a=>a.id===asset.id).map(a=>a.version))+1;
      document.vectorAssets.push(next);
      if(objectId){const object=document.objects.find(o=>o.id===objectId)!;if(!this.layerEditable(object.layerId))throw new Error("layer-locked");object.vectorAssetId=next.id;object.vectorAssetVersion=next.version;object.revision++;object.editedBy="tutor";}
      if (!objectId) {
        objectId = id("VECTOR-OBJECT");
        const scale = Math.min(1, artboard.width * 0.65 / asset.width, artboard.height * 0.65 / asset.height);
        const width = asset.width * scale, height = asset.height * scale;
        document.objects.push({
          id: objectId, kind: "vector", vectorAssetId: next.id, vectorAssetVersion: next.version,
          anchor, x: artboard.x + (artboard.width - width) / 2, y: artboard.y + (artboard.height - height) / 2,
          width, height, color: "#292929", strokeWidth: 1, layerId,
          createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: id("BOARD-TOOL"),
        });
      }
    }, "tutor",new Set(boundObjectId?[boundObjectId]:[]));
    this.selectedIds.clear(); if (objectId) this.selectedIds.add(objectId);
    this.commit(); this.staticRenderKey = ""; this.schedule();
    if (this.statusEl) this.statusEl.textContent = "AI 场景已提交 · 可整体撤销";
  }
  public override setState(state: unknown, result: ViewStateResult): Promise<void> {
    const generation = ++this.stateGeneration;
    const update = this.applyState(state, result, generation);
    this.stateReady = update;
    // Obsidian sometimes restores view state without awaiting its promise.
    void update.catch(() => {});
    return update;
  }
  private async applyState(state: unknown, result: ViewStateResult, generation: number): Promise<void> {
    await super.setState(state, result);
    if (this.sourceMoveIdle) await this.sourceMoveIdle;
    const source = (state as { sourceFile?: unknown } | null)?.sourceFile;
    if (this.closed || generation !== this.stateGeneration || typeof source !== "string" || !source) return;
    if (source !== this.sourceFile) {
      this.beginTransition();
      try {
        this.connectionChanged(); this.aiAbort?.abort();
        this.loadGeneration++;
        this.surfaceInstance = undefined;
        this.checkpointService?.dispose(); this.checkpointService = undefined;
        await this.flush();
        if (this.closed || generation !== this.stateGeneration) return;
        this.releaseScene();
        this.boardLoad = null; this.brushLoad = null;
        this.sourceFile = source;
      } catch(error) {
        if(!this.closed&&generation===this.stateGeneration&&this.history&&this.bundle){this.createCheckpointService();this.schedule();}
        throw error;
      } finally { this.endTransition(); }
    }
    await this.loadBoard();
  }
  public override async onOpen(): Promise<void> {
    if(this.closeWork)await this.closeWork.catch(()=>{});
    this.closed = false;
    this.contentEl.inert = !!this.transitions;
    this.contentEl.addClass("atl-standalone-board");
    // A failed close retains its authoritative scene; never reload over it.
    if (this.history && this.bundle) { this.stateReady = Promise.resolve(); this.createCheckpointService(); this.renderShell(); return; }
    if (this.sourceFile) await (this.stateReady=this.loadBoard());
  }
  private loadBoard(): Promise<void> {
    if (this.boardLoad) return this.boardLoad;
    if (this.history && this.bundle) return Promise.resolve();
    const generation = ++this.loadGeneration;
    this.loadError = undefined;
    this.renderLoadState(false);
    const loading = this.loadBoardNow(generation).catch(error => {
      if (!this.closed && generation === this.loadGeneration) {
        this.loadError = error;
        this.history = null; this.bundle = null;
        this.renderLoadState(true);
      }
      throw error;
    }).finally(() => { if (this.boardLoad === loading) this.boardLoad = null; });
    this.boardLoad = loading;
    void loading.catch(() => {});
    return loading;
  }

  private beginTransition(): void { this.transitions++; this.contentEl.inert = true; }
  private endTransition(): void { this.transitions--; this.contentEl.inert = this.closed || this.transitions > 0; }
  private createCheckpointService():void{
    this.checkpointService?.dispose();this.checkpointService=undefined;this.tileRestoreKey="";
    if(this.host.readPaintTile&&this.host.writePaintTile)this.checkpointService=new BoardPaintCheckpointService({
      read:path=>this.host.readPaintTile!(path),
      write:input=>this.host.writePaintTile!(input.boardId,input.layerId,input.key,input.revision,input.bytes),
    });
  }
  private renderLoadState(failed: boolean): void {
    this.stopCameraPreview();
    this.cancelProgressiveRender();
    this.renderedCamera = null;
    this.observer?.disconnect();
    this.canvas = null;
    this.contentEl.empty();
    const status = this.contentEl.createDiv({cls:"atl-studio-load",text:t(failed ? "upgrade.studioLoadFailed" : "upgrade.studioLoading")});
    status.setAttribute("role", failed ? "alert" : "status");
    if (failed) {
      const retry = status.createEl("button", {text:t("upgrade.studioRetry")});
      retry.onclick = () => { this.stateReady=this.loadBoard(); void this.stateReady.catch(() => {}); };
    }
  }
  private async loadBoardNow(generation: number, selected?: BoardBundle): Promise<void> {
    const source = this.sourceFile;
    const current = () => !this.closed && generation === this.loadGeneration && this.sourceFile === source;
    const bundle = selected ?? await this.host.open(source);
    if (!current()) return;
    const profiles = await this.host.assets?.() ?? [];
    if (!current()) return;
    if (selected) this.releaseScene();
    this.bundle = bundle;
    this.profiles = profiles;
    for(const image of this.brushImages.values())image.close();
    this.brushImages.clear();this.brushBytes.clear();this.missingBrushHashes.clear();
    if (this.bundle.document.sourceType === "standalone") {
      while (this.bundle.document.schemaVersion < 5)
        this.bundle.document = upgradeBoardDocument(this.bundle.document);
    }
    let baseline = this.bundle.recovery?.baseline;
    if (baseline && this.bundle.document.sourceType === "standalone") {
      while (baseline.schemaVersion < 5) baseline = upgradeBoardDocument(baseline);
    }
    this.history = new BoardHistory(this.bundle.document, 100, baseline);
    this.sceneDirty = !!this.bundle.recovery;
    this.restoredTiles.clear();this.createCheckpointService();
    this.activeLayerId = this.bundle.document.layers?.[0]?.id ?? "layer-default";
    this.paintSelection=undefined;this.layerRenderer.clear();this.livePainter.clear();
    const visibleLayers = new Set((this.bundle.document.layers ?? []).filter(layer => layer.visible).map(layer => layer.id));
    const latestVisible = [...this.bundle.document.objects].reverse().find(object => visibleLayers.has(object.layerId ?? "layer-default"));
    const containing = latestVisible && this.bundle.document.artboards?.find(artboard => {
      const x = latestVisible.x + latestVisible.width / 2, y = latestVisible.y + latestVisible.height / 2;
      return x >= artboard.x && x <= artboard.x + artboard.width && y >= artboard.y && y <= artboard.y + artboard.height;
    });
    this.activeArtboardId = containing?.id ?? this.bundle.document.artboards?.[0]?.id ?? "artboard-main";
    this.pendingInitialFit = true;
    this.renderShell();
    if (this.bundle.recovery && this.statusEl) this.statusEl.textContent = t(this.bundle.recovery.conflicted ? "board.recoveredConflict" : "board.recoveredDraft");
    const fitInitialView = () => {
      if (!current() || !this.canvas?.isConnected) return;
      const page = this.activeArtboard();
      const invalidPage = !Number.isFinite(page.x) || !Number.isFinite(page.y) || !Number.isFinite(page.width) || !Number.isFinite(page.height)
        || page.width < 64 || page.height < 64 || page.width > 16384 || page.height > 16384;
      if (invalidPage) {
        this.fitContent(); this.pendingInitialFit = false;
        if (this.statusEl) this.statusEl.textContent = "画面边界异常 · 已适应内容";
      }
      else if (this.history?.document.objects.length && !containing) { this.fitContent(); this.pendingInitialFit = false; }
      else this.fitArtboard();
    };
    requestAnimationFrame(fitInitialView);
    // Obsidian can attach a leaf before its split has its final dimensions.
    // ResizeObserver is not guaranteed to fire again after that first layout.
    this.contentEl.ownerDocument.defaultView?.setTimeout(() => {
      if (current() && this.pendingInitialFit && this.canvas?.isConnected) fitInitialView();
    }, 180);
    void this.loadPaintAssets();
    void this.loadBrushResources();
  }
  private reportMissingBrushResource = (hash:string):void => {
    this.missingBrushHashes.add(hash);
    if(this.statusEl)this.statusEl.textContent=`笔刷资源缺失 · ${this.missingBrushHashes.size} 项；原墨与检查点已保留`;
  };
  private loadBrushResources():Promise<void>{
    if(this.brushLoad)return this.brushLoad;
    const loading=this.loadBrushResourcesNow().finally(()=>{if(this.brushLoad===loading)this.brushLoad=null;});
    this.brushLoad=loading;return loading;
  }
  private async loadBrushResourcesNow():Promise<void>{
    if(!this.history||!this.host.readAsset)return;
    const generation=this.loadGeneration;
    const current=()=>!this.closed && generation===this.loadGeneration;
    const definitions=this.history.document.brushDefinitions??[];
    for(const ref of definitions.flatMap(brush=>[brush.tip,brush.grain,brush.paper])){
      if(!ref||this.brushImages.has(ref.hash))continue;
      if(!ref.path){this.reportMissingBrushResource(ref.hash);continue;}
      try{
        const bytes=new Uint8Array(await this.host.readAsset(ref.path));
        if(!current())return;
        if(await sha256Hex(bytes)!==ref.hash.toLowerCase())throw new Error("brush-checksum-mismatch");
        const image=await createImageBitmap(new Blob([bytes.slice().buffer],{type:ref.mimeType}));
        if(image.width!==ref.width||image.height!==ref.height){image.close();throw new Error("brush-dimensions-mismatch");}
        if(!current()){image.close();return;}
        this.brushBytes.set(ref.hash,bytes);this.brushImages.set(ref.hash,image);
        this.missingBrushHashes.delete(ref.hash);
      }catch{if(current())this.reportMissingBrushResource(ref.hash);}
    }
    if(!current())return;
    this.layerRenderer.clear();this.staticRenderKey="";this.schedule();
  }
  private async loadPaintAssets(): Promise<void> {
    if (!this.host.readPaintAsset || !this.history) return;
    const generation=this.loadGeneration;
    for (const operation of this.history.document.paintOperations ?? []) {
      if (!operation.maskAssetHash || this.paintAssets.has(operation.maskAssetHash)) continue;
      try {
        const compressed = await this.host.readPaintAsset(operation.maskAssetHash);
        if(this.closed || generation!==this.loadGeneration)return;
        if (compressed) this.paintAssets.set(operation.maskAssetHash, new Uint8Array(compressed));
      } catch { /* A missing fill mask remains recoverable from the operation/checkpoint chain. */ }
    }
    if(this.closed || generation!==this.loadGeneration)return;
    this.staticRenderKey = "";
    this.schedule();
  }
  private renderShell(): void {
    this.stopCameraPreview();
    this.cancelProgressiveRender();
    this.renderedCamera = null;
    this.minimapObjectCache = null;
    this.closeAiPanel?.();
    this.contentEl.empty();
    this.contentEl.addClass("atl-studio");
    this.contentEl.toggleClass("is-compact",this.contentEl.clientWidth<900);
    const toolbar = this.contentEl.createDiv({ cls: "atl-studio-topbar" });
    const inspectorToggle=this.studioButton(toolbar,t("upgrade.studioProperties"),"panel-right",false,()=>{
      this.contentEl.toggleClass("show-compact-inspector",!this.contentEl.hasClass("show-compact-inspector"));
      inspectorToggle.setAttribute("aria-expanded",String(this.contentEl.hasClass("show-compact-inspector")));
    });
    inspectorToggle.addClass("atl-studio-inspector-toggle");inspectorToggle.setAttribute("aria-expanded","false");
    const title = toolbar.createEl("input", { cls: "atl-studio-title", type: "text" });
    title.value = this.history?.document.title || this.sourceFile.split("/").pop()?.replace(/\.tutorboard\.md$|\.md$/i, "") || t("board.standaloneTitle");
    title.setAttribute("aria-label", t("board.standaloneTitle"));
    title.onchange = () => {
      const value = title.value.trim();
      if (!value || !this.history) { title.value = this.history?.document.title || "未命名画作"; return; }
      if (value === this.history.document.title) return;
      this.history.transact(document => { document.title = value; }, "human");
      this.commit();
    };
    const artboard = toolbar.createEl("select", { cls: "atl-studio-artboard" });
    artboard.setAttribute("aria-label", "Artboard");
    for (const value of this.history?.document.artboards ?? []) artboard.add(new Option(`${value.name} · ${value.width}×${value.height}`, value.id));
    artboard.value = this.activeArtboardId;
    artboard.title = "选择画面边界；边界外仍可在无限画布上绘制";
    artboard.onchange = () => { this.activeArtboardId = artboard.value; this.fitArtboard(); };
    const configure = this.studioButton(toolbar, "画面设置", "frame", false, () => this.configureArtboard(false));
    configure.classList.add("atl-studio-artboard-settings");
    const historyActions = toolbar.createDiv({ cls: "atl-studio-topbar-group" });
    this.studioButton(historyActions, "撤销", "undo-2", false, () => { if (this.history?.undo()) this.commit(); });
    this.studioButton(historyActions, "重做", "redo-2", false, () => { if (this.history?.redo()) this.commit(); });
    this.statusEl = toolbar.createSpan({ cls: "atl-studio-save-state", text: t("board.saved") });
    const zoom = toolbar.createSpan({ cls: "atl-studio-zoom", text: "100%" });
    zoom.dataset.zoom = "true";
    this.studioButton(toolbar, "适应画面边界", "scan", false, () => this.fitArtboard());
    this.studioButton(toolbar, "适应全部内容", "focus", false, () => this.fitContent());
    const aiButton = this.studioButton(toolbar, "与 Tutor 共画", "paintbrush-2", true, () => {});
    aiButton.classList.add("atl-studio-tutor-action");
    aiButton.onclick = () => this.openAiCreationPanel(aiButton);
    const svgFile = toolbar.createEl("input", { type: "file" });
    svgFile.accept = ".svg,image/svg+xml"; svgFile.hidden = true;
    svgFile.onchange = () => {
      const file = svgFile.files?.[0];
      if (file) void this.importSvgFile(file);
      svgFile.value = "";
    };
    const more = this.studioButton(toolbar, "更多创作工具", "ellipsis", false, () => {});
    more.onclick = event => {
      const menu = new Menu();
      if (this.host.chooseVersion) menu.addItem(item => item.setTitle(t("board.sourceBranchesTitle")).setIcon("history").onClick(() => {
        if (this.closed || this.transitions || !this.history) return;
        void this.host.chooseVersion!(this.sourceFile, this.history.document.id).catch(error => new Notice(t("board.error", {detail: String(error)})));
      }));
      menu.addItem(item => item.setTitle("新建画面边界").setIcon("frame").onClick(() => this.configureArtboard(true)));
      menu.addItem(item => item.setTitle("导入 SVG").setIcon("file-up").onClick(() => svgFile.click()));
      menu.addItem(item => item.setTitle("矢量化选区或图层").setIcon("vector-square").onClick(() => this.openVectorizationDialog()));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("三角色漫画创作示范").setIcon("book-open").onClick(() => this.openComicCoverChallenge()));
      menu.showAtMouseEvent(event);
    };
    const exportFormat = toolbar.createEl("select", { cls: "atl-studio-export-format", attr: { "aria-label": t("board.export") } });
    for (const format of ["png", "jpeg", "webp", "svg", "pdf", "ora", "tutorboard", "gallery"] as const)
      exportFormat.add(new Option(format.toUpperCase(), format));
    const exportButton = this.studioButton(toolbar, t("board.export"), "download", true, () => {});
    exportButton.onclick = () => void this.exportArtwork(exportFormat.value as "png" | "jpeg" | "webp" | "svg" | "pdf" | "ora" | "tutorboard" | "gallery");
    this.studioButton(toolbar, "分享", "share-2", false, () => void this.shareArtwork());
    this.studioButton(toolbar, "沉浸模式", "maximize", false, () => this.contentEl.toggleClass("is-immersive", !this.contentEl.hasClass("is-immersive")));

    const left = this.contentEl.createDiv({ cls: "atl-studio-tools" });
    const toolLabels: Record<Tool, string> = {
      select: t("board.select"), pan: t("board.pan"), pen: t("board.pen"), erase: t("board.erase"),
      lasso: t("board.paintSelection"), fill: t("board.fill"), gradient: "渐变", eyedropper: "吸管", transform: "变换", crop: "裁切",
      arrow: t("board.arrow"), rect: t("board.rect"), ellipse: t("board.ellipse"), text: t("board.text"),
    };
    for (const tool of Object.keys(toolLabels) as Tool[]) {
      const icon: Record<Tool, string> = { select:"mouse-pointer-2", pan:"hand", pen:"brush", erase:"eraser", lasso:"lasso", fill:"paint-bucket", gradient:"blend", eyedropper:"pipette", transform:"move", crop:"crop", arrow:"move-up-right", rect:"square", ellipse:"circle", text:"type" };
      const button = left.createEl("button", { attr: { "aria-label": toolLabels[tool], title: toolLabels[tool] } });
      setIcon(button, icon[tool]);
      button.type = "button";
      button.dataset.tool = tool;
      button.onclick = () => { this.tool = tool; this.refreshTools(); };
    }

    const right = this.contentEl.createDiv({ cls: "atl-studio-inspector" });
    const inspectorHeader = right.createDiv({ cls: "atl-studio-inspector-header" });
    inspectorHeader.createEl("strong", { text: "创作工作台" });
    inspectorHeader.createEl("span", { text: "笔刷 · 颜色 · 图层" });
    this.refreshSelectionInspector=this.renderSelectionInspector(right);
    this.refreshVectorInspector=renderVectorInspector(right,{document:()=>this.history!.document,selection:()=>this.primarySelection(),select:id=>{this.selectedIds.clear();if(id)this.selectedIds.add(id);this.refreshSelectionInspector?.();this.schedule();},transact:fn=>{if(!this.layerEditable(this.activeLayerId))throw new Error(t("board.layerLocked"));this.history!.transact(fn,"human");},changed:()=>{this.commit();this.refreshSelectionInspector?.();},layer:()=>this.activeLayerId,profiles:()=>this.profiles,save:async profile=>{if(!this.host.saveAsset)throw new Error("asset-storage-unavailable");await this.host.saveAsset(profile);this.profiles=await this.host.assets?.()??this.profiles;},edit:prompt=>this.previewVectorEdit(prompt)});
    const brushPanel = right.createEl("details", { cls: "atl-studio-panel" });
    brushPanel.open = true;
    const brushSummary = brushPanel.createEl("summary", { text: `${t("board.brush")} · ${t(`board.${this.brush.kind}`)}` });
    const brushGrid = brushPanel.createDiv({ cls: "atl-studio-brush-grid" });
    for (const kind of BOARD_BRUSHES) {
      const button = brushGrid.createEl("button", { cls: "atl-studio-brush-card", attr: { "aria-label": t(`board.${kind}`) } });
      button.dataset.brush = kind;
      const preview = button.createEl("canvas");
      button.createSpan({ text: t(`board.${kind}`) });
      button.onclick = () => {
        this.brushWidths.set(this.brush.kind, this.width);
        this.brush = studioBoardBrush(kind, crypto.getRandomValues(new Uint32Array(1))[0]!);
        this.width = this.brushWidths.get(kind) ?? BOARD_BRUSH_DEFAULT_WIDTHS[kind];
        this.tool = "pen";
        this.sizeControl?.setKind(kind, this.width);
        brushSummary.textContent = `${t("board.brush")} · ${t(`board.${kind}`)}`;
        syncBrushControls();
        this.refreshTools();
        this.schedule();
      };
      paintBoardBrushPreview(preview, kind, Math.min(BOARD_BRUSH_DEFAULT_WIDTHS[kind], 28), this.color,
        kind===this.brush.kind?this.brush:studioBoardBrush(kind,0x51f15e),this.brushImages);
    }
    this.sizeControl = new BrushSizeControl(brushPanel, {
      kind: this.brush.kind, color: this.color, value: this.width, min: 1, max: 200, label: t("board.width"),
      style:()=>this.brush,resources:this.brushImages,
      pressureLabel: t("board.pressureRange"),
      onInput: value => { this.width = value; this.brushWidths.set(this.brush.kind, value); this.schedule(); },
      onCommit: value => this.commitBrushWidth(value),
    });
    const advanced = brushPanel.createEl("details", { cls: "atl-studio-brush-advanced" });
    advanced.createEl("summary", { text: "笔刷细节 · 流量、压力与质感" });
    const brushRange = (label: string, key: "flow" | "opacity" | "hardness" | "spacing" | "roundness" | "nibAngle" | "scatter" | "grainStrength" | "stabilization" | "smoothing" | "pressureSize" | "pressureFlow" | "pressureOpacity" | "bristleDensity" | "dryness" | "impasto", min: number, max: number, step: number, scale = 100) => {
      const row = advanced.createDiv({ cls: "atl-studio-control" }); row.dataset.brushParam = key; row.createSpan({ text: label });
      const input = row.createEl("input", { type: "range" }); input.min = String(min); input.max = String(max); input.step = String(step);
      const raw = this.brush[key] ?? (key === "nibAngle" ? 0 : key === "spacing" ? 0.1 : 0);
      input.value = String(Math.round(raw * scale));
      const output = row.createEl("output", { text: key === "nibAngle" ? `${input.value}°` : `${input.value}%` });
      input.oninput = () => {
        this.brush = { ...this.brush, [key]: Number(input.value) / scale };
        output.textContent = key === "nibAngle" ? `${input.value}°` : `${input.value}%`;
        this.refreshCurrentBrushPreview();
      };
    };
    brushRange("流量", "flow", 1, 100, 1);
    brushRange("透明度", "opacity", 1, 100, 1);
    brushRange("硬度", "hardness", 0, 100, 1);
    brushRange("间距", "spacing", 1, 100, 1);
    brushRange("圆度", "roundness", 5, 100, 1);
    brushRange("笔头角度", "nibAngle", -180, 180, 1, 180 / Math.PI);
    brushRange("散布", "scatter", 0, 200, 1);
    brushRange("颗粒", "grainStrength", 0, 100, 1);
    brushRange("稳定器", "stabilization", 0, 100, 1);
    brushRange("平滑", "smoothing", 0, 100, 1);
    const pressureRow = advanced.createDiv({ cls: "atl-studio-control" }); pressureRow.createSpan({ text: "压力" });
    const pressure = pressureRow.createEl("input", { type: "checkbox" }); pressure.checked = this.brush.pressure;
    pressure.onchange = () => { this.brush = { ...this.brush, pressure: pressure.checked }; this.refreshCurrentBrushPreview(); };
    brushRange("压力→尺寸", "pressureSize", 0, 100, 1);
    brushRange("压力→流量", "pressureFlow", 0, 100, 1);
    brushRange("压力→透明", "pressureOpacity", 0, 100, 1);
    brushRange("鬃毛密度", "bristleDensity", 0, 100, 1);
    brushRange("干湿度", "dryness", 0, 100, 1);
    brushRange("厚涂脊线", "impasto", 0, 100, 1);
    const syncBrushControls = () => {
      for (const row of advanced.querySelectorAll<HTMLElement>("[data-brush-param]")) {
        const key = row.dataset.brushParam as keyof typeof this.brush;
        row.hidden = (key === "impasto" && this.brush.kind !== "oil") || ((key === "dryness" || key === "bristleDensity") && this.brush.kind !== "sumi" && this.brush.kind !== "oil");
        const input = row.querySelector<HTMLInputElement>('input[type="range"]');
        if (!input) continue;
        const scale = key === "nibAngle" ? 180 / Math.PI : 100;
        input.value = String(Math.round(((this.brush[key] as number | undefined) ?? 0) * scale));
        const output = row.querySelector("output");
        if (output) output.textContent = key === "nibAngle" ? `${input.value}°` : `${input.value}%`;
      }
      pressure.checked = this.brush.pressure;
    };
    syncBrushControls();
    const brushActions = advanced.createDiv({ cls: "atl-studio-layer-actions atl-studio-brush-actions" });
    const importBrush = brushActions.createEl("button", { text: "导入 .tutorbrush" });
    const brushFile = brushActions.createEl("input", { type: "file" }); brushFile.accept = ".tutorbrush,application/zip"; brushFile.hidden = true;
    importBrush.onclick = () => brushFile.click();
    brushFile.onchange = () => { const file = brushFile.files?.[0]; if (file) void this.importBrushFile(file); brushFile.value = ""; };
    const exportBrush = brushActions.createEl("button", { text: "导出当前笔刷" });
    exportBrush.onclick = () => void this.exportCurrentBrush();

    const colorPanel = right.createEl("details", { cls: "atl-studio-panel" }); colorPanel.open = true;
    colorPanel.createEl("summary", { text: t("board.color") });
    const colorRow = colorPanel.createDiv({ cls: "atl-studio-color-row" });
    const color = colorRow.createEl("input", { type: "color", cls: "atl-studio-color-wheel" });
    color.value = this.color;
    color.title = t("board.color");
    const hex = colorRow.createEl("input", { type: "text", cls: "atl-studio-hex" }); hex.value = this.color; hex.setAttribute("aria-label", "Hex 颜色值");
    color.oninput = () => { this.color = color.value; hex.value = color.value; this.refreshBrushPreviews(); };
    hex.onchange = () => { if (/^#[a-f\d]{6}$/i.test(hex.value)) { this.color = hex.value; color.value = hex.value; this.refreshBrushPreviews(); } };
    const swatches = colorPanel.createDiv({ cls: "atl-studio-swatches" });
    for (const value of this.history?.document.palette ?? []) {
      const swatch = swatches.createEl("button", { attr: { "aria-label": value } }); swatch.style.backgroundColor = value;
      swatch.onclick = () => { this.color = value; color.value = value; hex.value = value; this.refreshBrushPreviews(); };
    }

    const layerPanel = right.createEl("details", { cls: "atl-studio-panel" }); layerPanel.open = true;
    layerPanel.createEl("summary", { text: t("board.layers") });
    const layerList = layerPanel.createDiv({ cls: "atl-studio-layer-list" });
    this.renderStudioLayers(layerList);
    layerPanel.createDiv({ cls: "atl-studio-subheading", text: "新建图层" });
    const layerActions = layerPanel.createDiv({ cls: "atl-studio-layer-actions atl-studio-create-layers" });
    for (const [label, kind, icon] of [["矢量", "vector", "pen-tool"], ["绘画", "paint", "paintbrush"], ["分组", "group", "folder-plus"]] as const) {
      const add = layerActions.createEl("button", { cls: "atl-studio-create-layer", attr: { "aria-label": `新建${label}图层`, title: `新建${label}图层` } });
      setIcon(add, icon); add.createSpan({ text: label }); add.onclick = () => this.addStudioLayer(kind);
    }
    const paperRow = layerPanel.createEl("label", { cls: "atl-studio-paper-row" });
    paperRow.createSpan({ text: "纸张" });
    const background = paperRow.createEl("select", { attr: { "aria-label": "纸张材质" } });
    for (const kind of ["plain", "dark", "lined", "grid", "dots", "paper"])
      background.add(new Option(t(`board.${kind}`), kind));
    background.value = this.bundle?.document.background?.kind ?? "plain";
    background.onchange = () => {
      this.history?.transact((document) => {
        const kind = background.value as NonNullable<typeof document.background>["kind"];
        document.background = { kind, color: kind === "dark" ? "#202124" : "#fffdf7", spacing: 24, opacity: 1 };
      }, "human");
      this.commit();
    };
    const viewPanel = right.createEl("details", { cls: "atl-studio-panel atl-studio-view-panel" });
    viewPanel.createEl("summary", { text: "画布视图" });
    const viewGrid = viewPanel.createDiv({ cls: "atl-studio-view-grid" });
    const viewButton = (label: string, icon: string, action: () => void) => {
      const button = viewGrid.createEl("button", { cls: "atl-studio-view-action", attr: { "aria-label": label, title: label } });
      if (icon === "board:symmetry") decorateBoardButton(button, "symmetry"); else setIcon(button, icon);
      button.createSpan({ text: label }); button.setAttribute("aria-label", label); button.title = label; button.onclick = action; return button;
    };
    const viewState = viewPanel.createDiv({ cls: "atl-studio-view-state" });
    const refreshViewState = () => {
      mirror.toggleClass("is-active", this.mirrorPreview); mirror.setAttribute("aria-pressed", String(this.mirrorPreview));
      symmetry.toggleClass("is-active", this.symmetry); symmetry.setAttribute("aria-pressed", String(this.symmetry));
      viewState.textContent = `旋转 ${Math.round(this.canvasRotation * 180 / Math.PI)}° · 镜像${this.mirrorPreview ? "开" : "关"} · 对称${this.symmetry ? "开" : "关"}`;
    };
    viewButton("默认视图", "scan", () => {
      this.canvasRotation = 0; this.mirrorPreview = false;
      const page = this.activeArtboard();
      if (page.width < 64 || page.height < 64) this.fitContent(); else this.fitArtboard();
      refreshViewState();
    });
    viewButton("旋转 +15°", "rotate-cw", () => { this.canvasRotation = (this.canvasRotation + Math.PI / 12) % (Math.PI * 2); refreshViewState(); this.schedule(); });
    const mirror = viewButton("镜像预览", "flip-horizontal-2", () => { this.mirrorPreview = !this.mirrorPreview; refreshViewState(); this.schedule(); });
    const symmetry = viewButton("对称绘制", "board:symmetry", () => { this.symmetry = !this.symmetry; refreshViewState(); });
    refreshViewState();
    viewPanel.createDiv({ cls: "atl-studio-view-help", text: "镜像只改变预览；对称绘制会生成对应笔迹。" });
    const stage = this.contentEl.createDiv({ cls: "atl-standalone-stage" });
    stage.createDiv({ cls: "atl-studio-stage-hint", text: "无限画布 · 空格拖动 · 滚轮缩放" });
    const welcome = stage.createDiv({ cls: "atl-studio-welcome" });
    welcome.createEl("strong", { text: "从第一笔开始，Tutor 陪你一起画" });
    welcome.createEl("span", { text: "左侧选画笔起稿；需要协助时，点击上方「与 Tutor 共画」。作品会自动保存在 Vault。" });
    this.staticCanvas = stage.createEl("canvas", { cls: "atl-studio-static-canvas" });
    this.staticCanvas.setAttribute("aria-hidden", "true");
    this.progressCanvas = stage.createEl("canvas", { cls: "atl-studio-progress-canvas" });
    this.progressCanvas.setAttribute("aria-hidden", "true");
    this.canvas = stage.createEl("canvas", { cls: "atl-studio-active-canvas" });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", t("board.standaloneTitle"));
    this.brushCursor = stage.createDiv({ cls: "atl-board-brush-cursor" });
    this.brushCursor.hidden = true;
    this.minimap = stage.createEl("canvas", { cls: "atl-board-minimap" });
    this.installInput();
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => {
      const compact=this.contentEl.clientWidth<900,changed=compact!==this.contentEl.hasClass("is-compact");
      this.contentEl.toggleClass("is-compact",compact);
      if(changed && this.history?.document.objects.length){this.focusContent();return;}
      if (this.pendingInitialFit) {
        const page = this.activeArtboard();
        if (page.width < 64 || page.height < 64) { this.fitContent(); this.pendingInitialFit = false; }
        else this.fitArtboard();
      }
      else this.schedule();
    });
    this.observer.observe(stage);this.observer.observe(this.contentEl);
    this.refreshTools();
    this.schedule();
  }
  private studioButton(parent: HTMLElement, label: string, icon: string, showLabel: boolean, callback: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: `atl-studio-action${showLabel ? " has-label" : ""}`, attr: { "aria-label": label, title: label } });
    button.type = "button";
    setIcon(button.createSpan({ cls: "atl-studio-action-icon" }), icon);
    if (showLabel) button.createSpan({ cls: "atl-studio-action-label", text: label });
    button.onclick = callback;
    return button;
  }

  private snapshotForObjects(objects: readonly BoardObject[]) {
    const artboard = this.activeArtboard();
    const maxSide = 1536;
    const scale = Math.min(1, maxSide / Math.max(artboard.width, artboard.height));
    const width = Math.max(1, Math.round(artboard.width * scale));
    const height = Math.max(1, Math.round(artboard.height * scale));
    const canvas = this.contentEl.ownerDocument.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context || !this.bundle || !this.history) throw new Error("Canvas 2D is unavailable");
    context.fillStyle = artboard.background; context.fillRect(0, 0, width, height);
    context.save(); context.scale(scale, scale); context.translate(-artboard.x, -artboard.y);
    renderBoardBackgroundCanvas(context, this.history.document.background ?? { kind: "plain", color: artboard.background, spacing: 24, opacity: 1 }, artboard);
    this.renderLayeredScene(context,this.history.document,[...objects]);
    context.restore();
    return {
      pngBase64: canvas.toDataURL("image/png").split(",")[1]!, width, height,
      imageToBoard: [1 / scale, 0, 0, 1 / scale, artboard.x, artboard.y] as [number, number, number, number, number, number],
      anchor, layoutRevision: `studio:${this.history.document.revision}:${artboard.id}`,
    };
  }

  private async previewVectorEdit(instruction:string):Promise<void>{
    if(!instruction.trim()||!this.host.vectorPlan)return;
    const surface=this.toolSurface();if(this.host.transactions)surface.useTransactions(this.host.transactions);
    const scene=await surface.read(),tasks=this.host.tasks??new TutorTaskCoordinator();
    const task=tasks.start({clientId:"obsidian",target:scene.target}),signal=tasks.signal(task.id,"obsidian");
    const modal=new Modal(this.app);modal.titleEl.textContent=t("board.preciseEdit");
    const status=modal.contentEl.createDiv({text:t("board.thinking")});modal.onClose=()=>tasks.cancel(task.id,"obsidian");modal.open();
    try{
      tasks.phase(task.id,"obsidian","drafting",this.host.connection?.());tasks.consume(task.id,"obsidian","modelCalls");
      const plan=await this.host.vectorPlan({scene,instruction,signal,task});
      if(signal.aborted)return;
      const change={id:crypto.randomUUID(),taskId:task.id,targetId:surface.id,baseRevision:scene.target.revision,operations:plan.operations,dependencies:[]};
      const svg=await surface.preview(change);if(signal.aborted)return;
      const preview=modal.contentEl.createEl("img",{attr:{alt:t("board.preview")}});preview.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;preview.style.maxHeight="50vh";
      status.textContent=plan.message;tasks.propose(task.id,"obsidian",[{id:change.id,type:"changes",data:change}]);
      const apply=modal.contentEl.createEl("button",{text:t("board.apply")});
      apply.onclick=()=>{apply.disabled=true;void surface.commit(change,{clientId:"obsidian",targets:[surface.id],read:true,write:true,humanObjectIds:scene.selection,learningMemory:false,onSurfaceCommit:receipt=>tasks.recordSurfaceCommit(receipt)},signal).then(()=>{tasks.complete(task.id,"obsidian");this.refreshVectorInspector?.();modal.close();}).catch(error=>{if(error instanceof SurfaceCommitError)tasks.recordSurfaceCommit(error.result.receipt,true);else tasks.fail(task.id,"obsidian","commit-failed",String(error));status.textContent=error instanceof SurfaceCommitError?(error.result.receipt.durability==="not-applied"?"本次修改没有应用，原有作品保留。":"保存结果需要核对。请勿重复生成；原有作品保留。"):String(error);});};
    }catch(error){tasks.fail(task.id,"obsidian","vector-edit-failed",String(error));status.textContent=String(error);}
  }

  /** Sidebar uses the same candidate lifecycle as the Studio's own panel. */
  public async imageCandidatesFromConversation(prompt:string,signal:AbortSignal):Promise<string>{
    if(signal.aborted)throw new DOMException("Cancelled","AbortError");
    const trigger=this.contentEl.querySelector<HTMLButtonElement>("button");if(!trigger)throw new Error("studio-not-ready");
    this.openAiCreationPanel(trigger);
    const panel=this.contentEl.querySelector<HTMLElement>(".atl-studio-ai-panel")!;
    const mode=panel.querySelector<HTMLSelectElement>('select[aria-label="创作模式"]')!;
    mode.value="illustration";mode.dispatchEvent(new Event("change"));
    panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="创作要求"]')!.value=prompt;
    const run=panel.querySelector<HTMLButtonElement>('[data-action="generate"]')!;
    const cancel=()=>this.closeAiPanel?.();signal.addEventListener("abort",cancel,{once:true});
    try{
      await run.onclick?.call(run,new PointerEvent("click"));
      if(signal.aborted)throw new DOMException("Cancelled","AbortError");
      const status=panel.querySelector<HTMLElement>(".atl-studio-ai-status")!.textContent??"";
      if(!panel.querySelector(".atl-studio-ai-candidate"))throw new Error(status||"image-candidates-missing");
      return status;
    }finally{signal.removeEventListener("abort",cancel);}
  }

  private openAiCreationPanel(trigger: HTMLButtonElement): void {
    this.closeAiPanel?.();
    this.contentEl.querySelector(".atl-studio-ai-panel")?.remove();
    const panel = this.contentEl.createDiv({ cls: "atl-studio-ai-panel" });
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "与 Tutor 共画");
    const header = panel.createDiv({ cls: "atl-studio-ai-header" });
    const heading = header.createDiv();
    heading.createEl("strong", { text: "与 Tutor 共画" });
    heading.createEl("small", { text: "先预览，再由你决定是否加入作品" });
    const close = header.createEl("button", { attr: { "aria-label": "关闭共画面板", title: "关闭" } });
    setIcon(close, "x");
    panel.createEl("label", { cls: "atl-studio-ai-field-label", text: "创作方式" });
    const mode = panel.createEl("select", { attr: { "aria-label": "创作模式" } });
    for (const [value, label] of [["brush", "原生画笔 · 逐笔可编辑"], ["illustration", "参考图 · 生成整张图片"], ["mechanics", "结构示意图 · 可编辑"], ["math", "函数与极限图"], ["auto", "由 Tutor 选择方式"]] as const)
      mode.add(new Option(label, value));
    const strategyRow = panel.createEl("details", { cls: "atl-studio-ai-strategy" });
    const strategySummary = strategyRow.createEl("summary", { text: "画笔策略 · 三阶段创作" });
    const artistStrategy = strategyRow.createEl("select", { attr: { "aria-label": "AI 画笔实验策略" } });
    artistStrategy.add(new Option("规划器＋三阶段工具（推荐）", "planner-tools"));
    artistStrategy.add(new Option("少样例模板", "few-shot"));
    artistStrategy.add(new Option("单一长提示词", "single-prompt"));
    artistStrategy.onchange = () => { strategySummary.textContent = `画笔策略 · ${artistStrategy.selectedOptions[0]?.textContent ?? "三阶段创作"}`; };
    panel.createEl("label", { cls: "atl-studio-ai-field-label", text: "创作要求" });
    const instruction = panel.createEl("textarea", { attr: { placeholder: "例如：画一只色彩丰富的小动物，保留当前构图…", "aria-label": "创作要求" } });
    instruction.rows = 5;
    const defaults = this.host.imageGenerationDefaults?.() ?? {
      width: 1024, height: 1024, count: 2, negativePrompt: "", promptExtend: true,
      promptExtendMode: "direct" as const, thinking: true, watermark: false,
    };
    const imageControls = panel.createDiv({ cls: "atl-studio-ai-image-controls" });
    const sizeRow = imageControls.createDiv({ cls: "atl-studio-ai-size-row" });
    sizeRow.createSpan({ text: "尺寸" });
    const widthInput = sizeRow.createEl("input", { type: "number", attr: { "aria-label": "生成图宽度", min: "1", step: "1" } });
    widthInput.value = String(defaults.width);
    sizeRow.createSpan({ text: "×" });
    const heightInput = sizeRow.createEl("input", { type: "number", attr: { "aria-label": "生成图高度", min: "1", step: "1" } });
    heightInput.value = String(defaults.height);
    const artboardSize = sizeRow.createEl("button", { text: "按 Artboard 比例设为 1K" });
    artboardSize.type = "button";
    artboardSize.onclick = () => {
      const artboard = this.activeArtboard();
      const ratio = artboard.width / artboard.height;
      widthInput.value = String(Math.max(1, Math.round(Math.sqrt(1024 * 1024 * ratio))));
      heightInput.value = String(Math.max(1, Math.round(Math.sqrt(1024 * 1024 / ratio))));
    };
    const optionRow = imageControls.createDiv({ cls: "atl-studio-ai-option-row" });
    const countLabel = optionRow.createEl("label", { text: "候选 " });
    const count = countLabel.createEl("select", { attr: { "aria-label": "候选数量" } });
    for (let value = 1; value <= 6; value++) count.add(new Option(String(value), String(value)));
    count.value = String(defaults.count);
    const seedLabel = optionRow.createEl("label", { text: "种子 " });
    const seed = seedLabel.createEl("input", { type: "number", attr: { "aria-label": "随机种子", min: "0", max: "2147483647", placeholder: "随机" } });
    if (defaults.seed !== undefined) seed.value = String(defaults.seed);
    const negative = imageControls.createEl("textarea", { attr: { "aria-label": "负面提示词", placeholder: "不希望出现的内容或画面缺陷…" } });
    negative.rows = 2; negative.value = defaults.negativePrompt;
    const switchRow = imageControls.createDiv({ cls: "atl-studio-ai-switch-row" });
    const addSwitch = (label: string, checked: boolean) => {
      const wrapper = switchRow.createEl("label");
      const input = wrapper.createEl("input", { type: "checkbox" }); input.checked = checked;
      wrapper.appendText(label); return input;
    };
    const promptExtend = addSwitch("提示词扩写", defaults.promptExtend);
    const thinking = addSwitch("思考模式", defaults.thinking);
    const watermark = addSwitch("水印", defaults.watermark);
    const promptMode = optionRow.createEl("select", { attr: { "aria-label": "提示词扩写模式" } });
    promptMode.add(new Option("Direct 扩写", "direct")); promptMode.add(new Option("Agent 扩写", "agent"));
    promptMode.value = defaults.promptExtendMode;
    const presetRow = imageControls.createDiv({ cls: "atl-studio-ai-preset-row" });
    presetRow.createSpan({ text: "生成预设" });
    const quickPreset = presetRow.createEl("button", { text: "快速预览" }); quickPreset.type = "button";
    quickPreset.onclick = () => { promptExtend.checked = true; promptMode.value = "direct"; thinking.checked = false; };
    const qualityPreset = presetRow.createEl("button", { text: "精细生成" }); qualityPreset.type = "button";
    qualityPreset.onclick = () => { promptExtend.checked = true; promptMode.value = "agent"; thinking.checked = true; };
    const candidateGrid = panel.createDiv({ cls: "atl-studio-ai-candidates" });
    const candidateUrls: string[] = [];
    const paths = new Map<ImageGenerationCandidate, string>();
    const candidateProfiles = new Map<ImageGenerationCandidate, TutorCharacterProfile>();
    let selectedCandidate: ImageGenerationCandidate | null = null;
    let editSource: ImageGenerationCandidate | null = null;
    let revealPaused = false, revealResume: (() => void) | null = null;
    let reveal = Promise.resolve();
    let revealError: unknown;
    const clearCandidates = () => {
      for (const url of candidateUrls.splice(0)) URL.revokeObjectURL(url);
      candidateGrid.empty(); paths.clear(); candidateProfiles.clear();
      selectedCandidate = null;
    };
    const route = panel.createDiv({ cls: "atl-studio-ai-route", text: "实际模式：等待输入" });
    const status = panel.createDiv({ cls: "atl-studio-ai-status", text: "Tutor 会先构图，再逐笔显示可编辑内容。只有点击生成后才会发送当前画面。" });
    status.setAttribute("aria-live", "polite");
    const errorBox = panel.createDiv({ cls: "atl-studio-ai-error" }); errorBox.hidden = true;
    errorBox.setAttribute("role", "alert");
    const errorHeader = errorBox.createDiv({ cls: "atl-studio-ai-error-header" });
    setIcon(errorHeader.createSpan(), "circle-alert");
    const errorTitle = errorHeader.createEl("strong");
    const errorMessage = errorBox.createEl("p");
    const errorRequest = errorBox.createEl("small"); errorRequest.hidden = true;
    const settingsButton = errorBox.createEl("button", { text: "检查模型设置" });
    settingsButton.onclick = () => this.host.openSettings?.();
    settingsButton.hidden = !this.host.openSettings;
    const clearError = () => { errorBox.hidden = true; panel.removeAttribute("data-error"); };
    const showError = (error: unknown) => {
      const info = describeBoardAiError(error);
      panel.dataset.error = info.kind;
      errorTitle.textContent = info.title;
      errorMessage.textContent = info.message;
      errorRequest.textContent = info.requestId ? `服务请求编号：${info.requestId}` : "";
      errorRequest.hidden = !info.requestId;
      errorBox.hidden = false;
      status.textContent = "未加入任何新内容。";
      run.textContent = "重新尝试";
    };
    const playback = panel.createDiv({ cls: "atl-studio-ai-playback" }); playback.hidden = true;
    const actions = panel.createDiv({ cls: "atl-studio-ai-actions" });
    const revealPause = playback.createEl("button", { text: "暂停笔迹" });
    const revealSpeed = playback.createEl("select", { attr: { "aria-label": "Tutor 作画速度" } });
    for (const [value, label] of [["1", "1×"], ["2", "2×"], ["instant", "立即完成"]] as const) revealSpeed.add(new Option(label, value));
    revealPause.disabled = true; revealSpeed.disabled = true;
    const stopReveal = () => { revealPaused = false; revealResume?.(); revealResume = null; revealPause.textContent = "暂停笔迹"; };
    revealPause.onclick = () => { revealPaused = !revealPaused; revealPause.textContent = revealPaused ? "继续笔迹" : "暂停笔迹"; if (!revealPaused) { revealResume?.(); revealResume = null; } };
    revealSpeed.onchange = () => { if (revealSpeed.value === "instant") stopReveal(); };
    const refine = actions.createEl("button", { text: "继续编辑选中图" }); refine.hidden = true;
    const run = actions.createEl("button", { cls: "mod-cta", text: "开始共画" });
    run.dataset.action="generate";
    const cancel = actions.createEl("button", { text: "取消本次" }); cancel.hidden = true; cancel.disabled = true;
    const insert = actions.createEl("button", { text: t("board.insertCandidate") }); insert.hidden = true;
    const inspect = actions.createEl("button", { text: "核对保存结果" }); inspect.hidden = true;
    const retrySave = actions.createEl("button", { text: "只重试保存" }); retrySave.hidden = true;
    const target = { boardId: this.history!.document.id, source: this.sourceFile, artboard: copy(this.activeArtboard()), layerId: this.activeLayerId };
    let baseRevision = this.history!.document.revision;
    const tasks = this.host.tasks ?? new TutorTaskCoordinator();
    let taskId: string | undefined;
    type DrawingStart = { surface: TutorBoardSurface; taskId: string; changeId: string; baseRevision: string; before: BoardObject[]; humanObjectIds: string[] };
    let drawingStart: DrawingStart | undefined;
    let committing = false;
    let persistingCandidate = false;
    let receipt: SurfaceCommitReceipt | undefined;
    let reconciliation: { start: DrawingStart; grant: ContextGrant } | undefined;
    const receiptStatus = () => receipt?.durability === "committed" ? "修改已保存；取消不会撤回已经保存的内容。"
      : receipt?.durability === "not-applied" ? "本次修改没有应用，原有作品保留。"
      : receipt ? "保存结果需要核对。请勿重复生成或再次插入；先核对，再只重试保存。"
      : committing ? "已请求取消，正在核对写入结果。" : "已取消，原作品没有改变。";
    const taskActive = () => taskId && !["cancelled", "failed", "completed"].includes(tasks.get(taskId, "obsidian").state);
    const setRunningUi = (running: boolean, selected = mode.value) => {
      run.disabled = running || committing || persistingCandidate || !!reconciliation;
      cancel.hidden = !(running || committing); cancel.disabled = !(running || committing);
      playback.hidden = !(running && selected === "brush");
      revealPause.disabled = !running || selected !== "brush";
      revealSpeed.disabled = !running || selected !== "brush";
    };
    const phase = (name: string) => { if (taskActive()) tasks.phase(taskId!, "obsidian", name, this.host.connection?.()); };
    const finish = () => { if (taskActive()) tasks.complete(taskId!, "obsidian"); };
    const failed = () => { if (taskActive()) tasks.fail(taskId!, "obsidian", "studio-execution-failed", "Studio execution failed"); };
    const startTask = () => {
      if (taskActive()) tasks.cancel(taskId!, "obsidian");
      const task = tasks.start({ clientId: "obsidian", target: { id: target.boardId, source: target.source, revision: String(baseRevision), surface: "studio" } });
      taskId = task.id;
      drawingStart = { surface: this.toolSurface(), taskId: task.id, changeId: id("STUDIO-COMMIT"), baseRevision: String(baseRevision),
        before: copy(this.history!.document.objects), humanObjectIds: [...this.selectedIds] };
      receipt = undefined;
      tasks.signal(task.id, "obsidian").addEventListener("abort", () => { if (taskId === task.id) { stopReveal(); this.aiAbort?.abort(); pending = null; setPreview(null); } }, { once: true });
      phase("starting");
    };
    const assertTarget = () => {
      if (taskId && !taskActive()) throw new Error("task-inactive");
      if (this.history?.document.id !== target.boardId || this.sourceFile !== target.source || !panel.isConnected) throw new Error("studio-target-unavailable");
      if (this.activeArtboardId !== target.artboard.id || this.activeLayerId !== target.layerId) throw new Error("studio-target-changed");
      if (this.history.document.revision !== baseRevision) throw new Error("studio-revision-conflict");
      const layer = this.history.document.layers?.find(item => item.id === target.layerId);
      if (!layer || layer.locked) throw new Error("studio-layer-unavailable");
    };
    const grantFor = (start: DrawingStart): ContextGrant => ({ clientId: "obsidian", targets: [start.surface.id], read: true, write: true,
      humanObjectIds: [...start.humanObjectIds], learningMemory: false, onSurfaceCommit: next => {
        tasks.recordSurfaceCommit(next);
        if (drawingStart === start) receipt = copy(next);
      } });
    const withDrawingLayers = (objects: BoardObject[]) => {
      const existing = new Set(drawingStart?.before.map(object => object.id));
      return objects.map(object => object.layerId || existing.has(object.id) ? object : { ...object, layerId: target.layerId });
    };
    const setCommitting = (value: boolean) => {
      committing = value; mode.disabled = value || persistingCandidate || !!reconciliation; refine.disabled = value || persistingCandidate || !!reconciliation;
      insert.disabled = value || persistingCandidate || !!reconciliation; inspect.disabled = value; retrySave.disabled = value;
      setRunningUi(false);
    };
    const commitObjects = async (objects: BoardObject[], success: string): Promise<void> => {
      if (!drawingStart || committing || reconciliation) return;
      const start = drawingStart, grant = grantFor(start);
      setCommitting(true);
      try {
        assertTarget(); phase("committing");
        const result = await start.surface.commitPreparedDrawing({ id: start.changeId, taskId: start.taskId, targetId: start.surface.id,
          baseRevision: start.baseRevision, before: start.before, after: copy(objects), dependencies: [] }, grant, tasks.signal(start.taskId, "obsidian"));
        requireDurableSurfaceCommit(result);
        tasks.recordSurfaceCommit(result.receipt, true); receipt = copy(result.receipt);
        baseRevision = Number(result.target.revision); insert.hidden = true; run.textContent = "开始共画";
        status.textContent = success;
      } catch (error) {
        if (error instanceof SurfaceCommitError) {
          receipt = copy(error.result.receipt); tasks.recordSurfaceCommit(receipt, true);
          if (receipt.durability !== "not-applied") { reconciliation = { start, grant }; inspect.hidden = false; retrySave.hidden = true; }
          status.textContent = receiptStatus();
        } else {
          tasks.fail(start.taskId, "obsidian", "studio-commit-failed", "Studio commit was not confirmed.");
          status.textContent = tasks.signal(start.taskId, "obsidian").aborted && tasks.get(start.taskId, "obsidian").state === "cancelled"
            ? "已取消，原作品没有改变。" : `本次修改未应用：${String(error)}`;
        }
      } finally {
        pending = null; setPreview(null); setCommitting(false);
      }
    };
    const recover = async (action: "inspect" | "retry-save") => {
      if (!reconciliation || committing) return;
      const current = reconciliation, abort = new AbortController(); this.aiAbort = abort; setCommitting(true);
      try {
        const result = await current.start.surface.recoverCommit(current.start.changeId, current.grant, abort.signal, action);
        receipt = copy(result.receipt); tasks.recordSurfaceCommit(receipt, true);
        status.textContent = receiptStatus();
        retrySave.hidden = receipt.durability !== "applied-not-durable";
        if (receipt.durability === "committed" || receipt.durability === "not-applied") {
          reconciliation = undefined; inspect.hidden = true; retrySave.hidden = true; insert.hidden = true;
          baseRevision = Number(result.target.revision); run.textContent = "开始共画";
        }
      } catch (error) {
        if (error instanceof SurfaceCommitError) { receipt = copy(error.result.receipt); tasks.recordSurfaceCommit(receipt, true); }
        status.textContent = receiptStatus(); retrySave.hidden = true;
      } finally { if (this.aiAbort === abort) this.aiAbort = null; setCommitting(false); }
    };
    inspect.onclick = () => recover("inspect"); retrySave.onclick = () => recover("retry-save");
    insert.onclick = async () => {
      if (insert.disabled || !selectedCandidate || !this.host.saveAsset || !paths.has(selectedCandidate) || !drawingStart || committing || reconciliation || !taskActive()) return;
      const candidate = selectedCandidate, start = drawingStart;
      persistingCandidate = true; insert.disabled = true; mode.disabled = true; refine.disabled = true; setRunningUi(true);
      try {
        assertTarget();
        const profile: TutorCharacterProfile = candidateProfiles.get(candidate) ?? { id: id("ASSET"), version: 1, name: "Studio image", origin: "uploaded", style: "custom", usage: "sticker", createdAt: new Date().toISOString(), width: candidate.width, height: candidate.height, assetPath: paths.get(candidate)! };
        candidateProfiles.set(candidate, profile);
        await this.host.saveAsset(profile); assertTarget();
        if (drawingStart !== start) throw new Error("studio-task-changed");
        if (!this.profiles.some(asset => asset.id === profile.id && asset.version === profile.version)) this.profiles.push(profile);
        const scale = Math.min(1, target.artboard.width * .8 / profile.width, target.artboard.height * .8 / profile.height);
        const width = profile.width * scale, height = profile.height * scale;
        const object: BoardObject = { id: id("IMAGE"), groupId: id("IMAGE-GROUP"), kind: "sticker", assetId: profile.id, assetVersion: profile.version, anchor, x: target.artboard.x + (target.artboard.width - width) / 2, y: target.artboard.y + (target.artboard.height - height) / 2, width, height, layerId: target.layerId, color: "#000000", strokeWidth: 1, createdBy: "tutor", editedBy: "tutor", revision: 1 };
        await commitObjects([...start.before, object], t("board.candidateInserted"));
      } catch { status.textContent = taskActive() ? "候选已保留；资源保存未确认，尚未插入作品。可重试保存候选。" : receiptStatus(); }
      finally { persistingCandidate = false; setCommitting(false); }
    };
    let pending: BoardObject[] | null = null;
    const setPreview = (objects: BoardObject[] | null) => { if (!panel.isConnected) return; if (objects && taskActive()) tasks.emit(taskId!, "obsidian", { type: "preview", data: { objects: objects.length } }); this.draftObjects = objects; this.draftRenderRevision++; this.staticRenderKey = ""; this.schedule(); };
    const ownerDocument = panel.ownerDocument;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panel.contains(target) && !trigger.contains(target)) reset();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); reset(); } };
    const reset = () => {
      ownerDocument.removeEventListener("pointerdown", outside, true);
      ownerDocument.removeEventListener("keydown", escape, true);
      stopReveal(); if (taskActive()) tasks.cancel(taskId!, "obsidian"); if (!this.host.tasks) tasks.dispose();
      this.aiAbort?.abort(); this.aiAbort = null; this.aiAgent?.dispose(); this.aiAgent = null;
      setPreview(null); clearCandidates(); panel.remove(); if (this.closeAiPanel === reset) this.closeAiPanel = null; trigger.focus();
    };
    ownerDocument.addEventListener("pointerdown", outside, true);
    ownerDocument.addEventListener("keydown", escape, true);
    this.closeAiPanel = reset;
    close.onclick = reset;
    cancel.onclick = () => { stopReveal(); setRunningUi(false); if (taskActive()) tasks.cancel(taskId!, "obsidian"); pending = null; this.aiAbort?.abort(); status.textContent = receiptStatus(); setPreview(null); };
    const refreshModeControls = () => {
      imageControls.toggleClass("is-hidden", mode.value !== "illustration");
      strategyRow.toggleClass("is-hidden", mode.value === "illustration" || mode.value === "mechanics");
      playback.hidden = true;
    };
    mode.onchange = () => { if (committing || persistingCandidate || reconciliation) { status.textContent = receiptStatus(); return; } stopReveal(); setRunningUi(false); clearError(); if (taskActive()) tasks.cancel(taskId!, "obsidian"); taskId = undefined; this.aiAbort?.abort(); pending = null; insert.hidden = true; editSource = null; refine.hidden = true; run.textContent = "开始共画"; status.textContent = "模式已切换；原作品不会被覆盖。"; setPreview(null); clearCandidates(); refreshModeControls(); };
    refreshModeControls();
    refine.onclick = () => {
      if (!selectedCandidate) return;
      editSource = selectedCandidate;
      run.textContent = "编辑选中候选";
      status.textContent = "已锁定选中候选。请把创作要求改为本轮修改指令，再点击“编辑选中候选”。";
      instruction.focus(); instruction.select();
    };
    instruction.oninput = () => { route.textContent = t("board.semanticPending"); clearError(); };
    run.onclick = async () => {
      if (committing || persistingCandidate || reconciliation || run.disabled) return;
      clearError();
      if (pending) {
        await commitObjects(pending, "已保存到画板，可整体撤销。");
        return;
      }
      const prompt = instruction.value.trim();
      if (!prompt || !this.history || !this.bundle) { status.textContent = "请先描述要创作的内容。"; return; }
      revealError = undefined; reveal = Promise.resolve(); stopReveal();
      let selected = mode.value;
      baseRevision = this.history.document.revision; startTask();
      if (selected === "auto") {
        const classifyAbort = new AbortController(); this.aiAbort = classifyAbort; setRunningUi(true, "auto");
        status.textContent = t("board.semanticPending"); phase("classifying");
        try {
          if (!this.host.resolveAction) throw new Error("semantic-router-unavailable");
          tasks.consume(taskId!, "obsidian", "modelCalls");
          const action = await this.host.resolveAction(prompt, classifyAbort.signal);
          if (classifyAbort.signal.aborted) return;
          assertTarget();
          if (action.intent !== "draw") { status.textContent = t("board.semanticNotDrawing"); finish(); return; }
          selected = action.drawing.mode === "reference" ? "illustration" : action.drawing.mode === "math" ? "math" : "brush";
        } catch (error) { showError(error); return; }
        finally { setRunningUi(false); if (this.aiAbort === classifyAbort) this.aiAbort = null; }
      }
      try { assertTarget(); } catch (error) { status.textContent = String(error); return; }
      route.textContent = `实际模式：${selected === "mechanics" ? "结构示意图" : selected === "illustration" ? "AI 插画" : "AI 画笔"}`;
      if (selected === "mechanics") {
        try {
          const diagram = mechanicsTemplateFromInstruction(prompt), validation = validateMechanicsDiagram(diagram);
          if (!validation.valid) throw new Error(validation.errors.join("；"));
          const operations = renderMechanicsDiagram(diagram, { artboard: this.activeArtboard(), anchor, layerId: this.activeLayerId, groupId: id("MECHANICS") });
          pending = applyBoardOperations(drawingStart!.before, operations);
          setPreview(pending); run.textContent = "确认加入";
          status.textContent = validation.warnings.length ? `语义校验通过；${validation.warnings.join("；")}` : "语义校验通过。请检查预览后确认加入。";
        } catch (error) { status.textContent = `结构图生成失败：${String(error)}`; }
        return;
      }
      if (selected === "illustration" && this.host.createImageProvider) {
        const requestedWidth = Number.parseInt(widthInput.value, 10);
        const requestedHeight = Number.parseInt(heightInput.value, 10);
        if (!isBoardImage1KSize(requestedWidth, requestedHeight)) {
          status.textContent = "尺寸必须处于 1K 档：262,144–2,250,000 总像素，宽高比 1:8–8:1。";
          return;
        }
        const requestedSeed = seed.value.trim() ? Number.parseInt(seed.value, 10) : undefined;
        if (requestedSeed !== undefined && (!Number.isInteger(requestedSeed) || requestedSeed < 0 || requestedSeed > 2_147_483_647)) {
          status.textContent = "随机种子必须是 0–2147483647 的整数，或留空。";
          return;
        }
        clearCandidates(); insert.hidden = true;
        status.textContent = `正在生成 ${count.value} 张 ${requestedWidth}×${requestedHeight} 候选…`; setRunningUi(true, selected);
        const abort = new AbortController(); this.aiAbort = abort;
        try {
          const provider = this.host.createImageProvider();
          if (!provider) throw new Error("请先在设置 → AI 图像生成中启用 Provider");
          phase("generating-image"); tasks.consume(taskId!, "obsidian", "modelCalls");
          const available = await provider.availability();
          if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
          assertTarget();
          if (!available.available) throw new Error(available.reason ?? "图像 Provider 不可用");
          const request = {
            requestId: id("IMAGE"), prompt, width: requestedWidth, height: requestedHeight,
            quality: "preview", transparent: false, count: Number(count.value),
            negativePrompt: negative.value.trim(),
            ...(requestedSeed !== undefined ? { seed: requestedSeed } : {}),
            promptExtend: promptExtend.checked,
            promptExtendMode: promptMode.value as "direct" | "agent",
            thinking: thinking.checked,
            watermark: watermark.checked,
          } as const;
          const candidates = editSource
            ? await provider.edit({ ...request, source: editSource }, abort.signal)
            : await provider.generate(request, abort.signal);
          if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
          assertTarget();
          const folder = this.host.imageAssetFolder?.();
          if (!folder) throw new Error("studio-image-assets-unavailable");
          if (!this.host.writeExport) throw new Error("当前 Vault 不支持保存候选图");
          for (const [index, candidate] of candidates.entries()) {
            const path = `${folder}/candidate-${Date.now()}-${index + 1}.${candidate.mimeType.split("/")[1]}`;
            await this.host.writeExport(path, candidate.bytes.buffer.slice(candidate.bytes.byteOffset, candidate.bytes.byteOffset + candidate.bytes.byteLength) as ArrayBuffer);
            if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            assertTarget(); paths.set(candidate, path);
            const candidateBuffer = candidate.bytes.buffer.slice(
              candidate.bytes.byteOffset,
              candidate.bytes.byteOffset + candidate.bytes.byteLength,
            ) as ArrayBuffer;
            const url = URL.createObjectURL(new Blob([candidateBuffer], { type: candidate.mimeType }));
            candidateUrls.push(url);
            const card = candidateGrid.createEl("button", { cls: "atl-studio-ai-candidate", attr: { "aria-label": `选择候选 ${index + 1}`, "aria-pressed": String(index === 0) } });
            card.createEl("img", { attr: { src: url, alt: `候选 ${index + 1}` } });
            card.createSpan({ text: `候选 ${index + 1} · ${candidate.width}×${candidate.height}` });
            if (index === 0) { card.addClass("is-selected"); selectedCandidate = candidate; }
            card.onclick = () => {
              selectedCandidate = candidate;
              for (const item of candidateGrid.querySelectorAll<HTMLButtonElement>(".atl-studio-ai-candidate")) {
                const active = item === card; item.toggleClass("is-selected", active); item.setAttribute("aria-pressed", String(active));
              }
            };
          }
          if (taskActive()) tasks.emit(taskId!, "obsidian", { type: "preview", data: { candidates: candidates.length } });
          phase("awaiting-selection");
          editSource = null; insert.hidden = candidates.length === 0; refine.hidden = candidates.length === 0; run.textContent = "重新生成";
          status.textContent = `已下载并保存 ${candidates.length} 张候选到 ${folder}；请点击“加入作品”将选中候选放入目标图层。`;
        } catch (error) { if (abort.signal.aborted) status.textContent = "已取消，原作品没有改变。"; else showError(error); failed(); }
        finally { setRunningUi(false); if (this.aiAbort === abort) this.aiAbort = null; }
        return;
      }
      if (!this.host.createAgent) { status.textContent = "当前未配置可用的视觉画板模型。"; return; }
      if (selected === "illustration") { status.textContent = "请先配置图像 Provider，或明确选择 AI 画笔模式。"; return; }
      else status.textContent = "构图规划中…";
      setRunningUi(true, selected); const abort = new AbortController(); this.aiAbort = abort; const agent = this.host.createAgent(); this.aiAgent = agent;
      const original = drawingStart!.before; phase("drawing-preview");
      const cancelAgent = () => agent.cancel(); abort.signal.addEventListener("abort", cancelAgent, { once: true });
      try {
        if (selected === "math") {
          tasks.consume(taskId!, "obsidian", "modelCalls");
          const result = await requestBoardWithRepair(agent, { boardId: target.boardId, sessionId: id("MATH"), requestId: id("MATH"), baseRevision, sourceRevision: this.history.document.sourceRevision, sourceFile: target.source, anchor, snapshot: this.snapshotForObjects(original), objects: original, instruction: prompt, context: JSON.stringify(target.artboard), character: null, requiresDrawing: true, math: true }, undefined, () => !abort.signal.aborted && panel.isConnected);
          if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
          assertTarget(); if (!result.ok) throw new Error(result.error);
          pending = withDrawingLayers(applyBoardOperations(original, result.operations));
          setPreview(pending); run.textContent = "确认加入"; status.textContent = result.description || "数学图预览完成"; return;
        }
        const session = createBoardArtistSession({
          agent,
          renderCheckpoint: async (objects) => this.snapshotForObjects(objects),
        });
        const strategy = artistStrategy.value as BoardArtistStrategy;
        const result = await session.run({ board: {
          boardId: this.history.document.id, sessionId: id("ARTIST-SESSION"), requestId: id("ARTIST"),
          baseRevision: this.history.document.revision, sourceRevision: this.history.document.sourceRevision,
          sourceFile: this.sourceFile, anchor, snapshot: this.snapshotForObjects(original), objects: original,
          instruction: prompt, context: JSON.stringify({ artboard: this.activeArtboard(), layers: this.history.document.layers }),
          character: null, purpose: "artist",
        }, maxFeedbackRounds: 3, strategy }, abort.signal, (checkpoint) => {
          if (abort.signal.aborted || this.aiAbort !== abort) return;
          reveal = reveal.then(async () => {
            assertTarget();
            const totalRounds = strategy === "planner-tools" ? 3 : 1;
            status.textContent = `第 ${checkpoint.round}/${totalRounds} 阶段 · Tutor 正在落笔：${checkpoint.description || checkpoint.stage}`;
            for (const operation of checkpoint.operations) {
              if (abort.signal.aborted || !panel.isConnected) return;
              if (revealPaused) await new Promise<void>(resolve => { revealResume = resolve; });
              if (abort.signal.aborted) return;
              pending = withDrawingLayers(applyBoardOperations(pending ?? original, [operation]));
              setPreview(pending);
              if (revealSpeed.value !== "instant") await new Promise(resolve => setTimeout(resolve, revealSpeed.value === "2" ? 24 : 48));
            }
          }).catch(error => { revealError = error; });
        });
        await reveal;
        if (revealError) throw revealError;
        if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        assertTarget();
        if (result.kind !== "brush-group") throw new Error("unexpected-artist-result");
        pending = withDrawingLayers(applyBoardOperations(original, result.operations));
        setPreview(pending); run.textContent = "确认加入";
        status.textContent = `${strategy === "planner-tools" ? "三阶段" : "单阶段"}逐笔预览完成，共 ${result.operations.length} 个可编辑操作；确认后才会写入作品。`;
      } catch (error) {
        pending = null; if (this.aiAbort === abort) setPreview(null);
        if (abort.signal.aborted) status.textContent = "已取消，原作品没有改变。"; else showError(error); failed();
      } finally {
        abort.signal.removeEventListener("abort", cancelAgent); setRunningUi(false); if (this.aiAbort === abort) this.aiAbort = null; agent.dispose(); if (this.aiAgent === agent) this.aiAgent = null;
      }
    };
    instruction.focus();
  }
  private commitBrushWidth(value: number): void {
    this.width = value;
    this.brushWidths.set(this.brush.kind, value);
    const selectedId = this.primarySelection();
    if (!selectedId || !this.history) return;
    const selected = this.history.document.objects.find(object => object.id === selectedId);
    if (!selected || selected.strokeWidth === value) return;
    this.history.transact(document => {
      const target = document.objects.find(object => object.id === selectedId);
      if (target) target.strokeWidth = value;
    }, "human");
    this.commit();
  }
  private async exportCurrentBrush(): Promise<void> {
    const name = t(`board.${this.brush.kind}`);
    const brush = {
      formatVersion: 2 as const,
      id: `custom-${this.brush.kind}`,
      version: 1,
      name,
      engine: this.brush.kind === "pen" ? "outline" as const : "dab" as const,
      kind: this.brush.kind,
      style: copy(this.brush),
      author: "Tutor Studio user",
      license: "CC0-1.0",
    };
    const definition=this.history?.document.brushDefinitions?.find(item=>item.tip?.hash===this.brush.tipHash||item.grain?.hash===this.brush.grainHash||item.paper?.hash===this.brush.paperHash);
    const complete={...brush,tip:definition?.tip,grain:definition?.grain,paper:definition?.paper};
    const archive = await exportTutorBrush({ brush: complete, resources: this.brushBytes });
    const path = await this.writeArtwork("tutorbrush", archive);
    new Notice(`已导出笔刷：${path}`);
  }
  private async importBrushFile(file: File): Promise<void> {
    try {
      const imported = await importTutorBrush(new Uint8Array(await file.arrayBuffer()));
      const definition = copy(imported.brush);
      for (const resource of [definition.tip, definition.grain, definition.paper]) {
        if (!resource) continue;
        const bytes = imported.resources.get(resource.hash.toLowerCase());
        if (!bytes) throw new Error(`Missing resource ${resource.hash}`);
        if (this.host.writeBrushResource)
          resource.path = await this.host.writeBrushResource(resource.hash, resource.mimeType, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      }
      const hashes=[definition.tip?.hash,definition.grain?.hash,definition.paper?.hash].filter((hash):hash is string=>!!hash);
      definition.style={...definition.style,engineVersion:2,
        tipHash:definition.tip?.hash,grainHash:definition.grain?.hash,paperHash:definition.paper?.hash,resourceHashes:hashes};
      this.history?.transact(document => {
        document.brushDefinitions ??= [];
        document.brushDefinitions = document.brushDefinitions.filter(item => item.id !== definition.id || item.version !== definition.version);
        document.brushDefinitions.push(definition);
      });
      this.brush = copy(definition.style);
      await this.loadBrushResources();
      this.tool = "pen";
      this.commit(); this.renderShell();
      new Notice(`已导入笔刷：${definition.name}`);
    } catch (error) {
      new Notice(`笔刷导入失败：${String(error)}`);
    }
  }
  private async importSvgFile(file: File): Promise<void> {
    if (!this.history) return;
    try {
      const vectorId = id("VECTOR"), imported = importSafeSvg(await file.text(), {
        id: vectorId, name: file.name.replace(/\.svg$/i, "") || "Imported SVG",
        parser: new this.contentEl.ownerDocument.defaultView!.DOMParser(),
      });
      const artboard = this.activeArtboard();
      const scale = Math.min(1, artboard.width * 0.6 / imported.asset.width, artboard.height * 0.6 / imported.asset.height);
      const width = imported.asset.width * scale, height = imported.asset.height * scale;
      const objectId = id("VECTOR-OBJECT");
      this.history.transact(document => {
        document.vectorAssets ??= [];
        document.vectorAssets.push(imported.asset);
        document.objects.push({
          id: objectId, kind: "vector", vectorAssetId: imported.asset.id, vectorAssetVersion: imported.asset.version,
          anchor, x: artboard.x + (artboard.width - width) / 2, y: artboard.y + (artboard.height - height) / 2,
          width, height, color: "#292929", strokeWidth: 1, layerId: this.activeLayerId,
          createdBy: "human", editedBy: "human", revision: 1, groupId: id("SVG-IMPORT"),
        });
      }, "human");
      this.selectedIds.clear(); this.selectedIds.add(objectId);
      this.commit(); this.staticRenderKey = ""; this.schedule();
      new Notice(imported.warnings.length ? `SVG 已导入；${imported.warnings.join("；")}` : "SVG 已作为可编辑矢量场景导入");
    } catch (error) {
      new Notice(`SVG 导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async captureVectorizationImage():Promise<{bytes:Uint8Array;mimeType:"image/png";width:number;height:number;bounds:{x:number;y:number;width:number;height:number}}>{
    if(!this.history||!this.bundle)throw new Error("studio-not-ready");await this.prepareImages();
    const document=this.history.document,selection=this.selectedBounds(document.objects),bounds=selection??this.activeArtboard(),maxSide=1024,scale=Math.min(1,maxSide/Math.max(bounds.width,bounds.height));
    const width=Math.max(1,Math.round(bounds.width*scale)),height=Math.max(1,Math.round(bounds.height*scale)),canvas=this.contentEl.ownerDocument.createElement("canvas");canvas.width=width;canvas.height=height;
    const context=canvas.getContext("2d");if(!context)throw new Error("capture-canvas-unavailable");context.setTransform(scale,0,0,scale,-bounds.x*scale,-bounds.y*scale);context.beginPath();context.rect(bounds.x,bounds.y,bounds.width,bounds.height);context.clip();
    if(!selection){context.fillStyle=this.activeArtboard().background;context.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);}
    const objects=selection?document.objects.filter(object=>this.selectedIds.has(object.id)):document.objects.filter(object=>(object.layerId??"layer-default")===this.activeLayerId);
    if(!selection)this.drawPaintOperations(context,document,new Set([this.activeLayerId]),Infinity,true);
    renderBoardCanvas(context,objects,{ink:this.bundle.ink,characters:this.profiles,resolveAsset:this.resolveImage,layers:document.layers,vectorAssets:document.vectorAssets,brushResources:this.brushImages,missingBrushResource:this.reportMissingBrushResource});
    const encoded=canvas.toDataURL("image/png").split(",")[1]??"",binary=atob(encoded),bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
    return {bytes,mimeType:"image/png",width,height,bounds};
  }
  private openComicCoverChallenge():void{
    if(!this.history)return;
    const boardId=this.history.document.id,baseRevision=this.history.revision;
    const modal=new Modal(this.app);modal.setTitle("三人激战 · 原生可编辑封面");
    modal.contentEl.addClass("atl-comic-challenge");
    modal.contentEl.createEl("p",{text:"2048×3072 · 三名原创角色 · 命名矢量部件。先查看六阶段预览，再作为一个可撤销事务加入独立 Artboard。"});
    const palette=modal.contentEl.createDiv({cls:"atl-comic-palette"}),plan=defaultThreeCharacterArtworkPlan();
    const swatches:Array<["red"|"blue"|"gold",string]>=[["red","赤红角色"],["blue","蓝色角色"],["gold","金色角色"]];
    const colorInputs=swatches.map(([key,label])=>{const row=palette.createEl("label");row.createSpan({text:label});const input=row.createEl("input",{type:"color",attr:{"aria-label":label}});input.value=plan.palette[key];return [key,input] as const;});
    const stageNav=modal.contentEl.createDiv({cls:"atl-comic-stages"});
    const stageNames:Record<BoardArtworkStage,string>={composition:"构图", "large-forms":"人物大形",ink:"墨线",color:"上色",texture:"网点特效",review:"完成检查"};
    const stageButtons=new Map<BoardArtworkStage,HTMLButtonElement>();
    const previews=new Map<BoardArtworkStage,BoardVectorAsset>();
    const preview=modal.contentEl.createEl("img",{cls:"atl-comic-preview",attr:{alt:"三角色漫画封面阶段预览"}});
    preview.tabIndex=0;preview.setAttribute("title","点击或按回车放大预览");preview.onclick=()=>preview.toggleClass("is-expanded",!preview.hasClass("is-expanded"));preview.onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();preview.click();}};
    let previewUrl:string|undefined,pending:BoardVectorAsset|undefined,abort:AbortController|undefined,paused=false,resume:((value?:void)=>void)|undefined;
    const setPreview=(asset:BoardVectorAsset)=>{if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(new Blob([exportVectorAssetSvg(asset,{width:800,height:1200})],{type:"image/svg+xml"}));preview.src=previewUrl;};
    for(const stage of BOARD_ARTWORK_STAGES){const button=stageNav.createEl("button",{text:stageNames[stage]});button.disabled=true;button.type="button";button.setAttribute("aria-label",`查看${stageNames[stage]}阶段`);button.onclick=()=>{const asset=previews.get(stage);if(asset){setPreview(asset);for(const [key,item] of stageButtons)item.toggleClass("is-active",key===stage);}};stageButtons.set(stage,button);}
    const consentRow=modal.contentEl.createEl("label",{cls:"atl-studio-cloud-consent"}),consent=consentRow.createEl("input",{type:"checkbox"});consentRow.appendText(" 允许将这幅预览发送给已配置的视觉模型补绘原生节点");
    const status=modal.contentEl.createDiv({cls:"atl-studio-ai-status",text:"准备生成可编辑预览；当前作品保持不变。"}),actions=modal.contentEl.createDiv({cls:"modal-button-container"});
    const run=actions.createEl("button",{text:"生成六阶段预览"}),pause=actions.createEl("button",{text:"暂停"}),retry=actions.createEl("button",{text:"重试网点"}),enhance=actions.createEl("button",{text:"AI 补绘（实验）"}),cancel=actions.createEl("button",{text:"取消"}),insert=actions.createEl("button",{text:"加入独立 Artboard"});
    pause.disabled=true;retry.disabled=true;enhance.disabled=true;cancel.disabled=true;insert.disabled=true;
    const start=async()=>{run.disabled=true;insert.disabled=true;enhance.disabled=true;pause.disabled=false;cancel.disabled=false;retry.disabled=true;paused=false;pause.textContent="暂停";pending=undefined;previews.clear();for(const button of stageButtons.values())button.disabled=true;abort?.abort();abort=new AbortController();for(const [key,input]of colorInputs)plan.palette[key]=input.value;
      try{const created=await createThreeCharacterCoverSession(plan,{signal:abort.signal,onStage:async event=>{if(abort?.signal.aborted)throw new DOMException("Cancelled","AbortError");previews.set(event.stage,event.asset);const button=stageButtons.get(event.stage)!;button.disabled=false;button.textContent=`${stageNames[event.stage]} ✓`;for(const [key,item]of stageButtons)item.toggleClass("is-active",key===event.stage);setPreview(event.asset);status.textContent=`${stageNames[event.stage]}：${event.asset.nodes.length} 个可编辑节点 · ${event.elapsedMs}ms${event.warnings.length?` · ${event.warnings.join("；")}`:""}`;if(paused)await new Promise<void>(resolve=>{resume=resolve;});if(abort?.signal.aborted)throw new DOMException("Cancelled","AbortError");}});if(this.history?.document.id!==boardId||this.history.revision!==baseRevision)throw new Error("画板已改变，请重新生成预览");const inspection=inspectThreeCharacterCover(created,plan);if(!inspection.valid)throw new Error(inspection.warnings.join("；"));pending=created;insert.disabled=false;retry.disabled=false;enhance.disabled=!this.host.artworkComplete;status.textContent=`完成：${created.nodes.length} 个原生节点，命名可编辑率 ${Math.round(inspection.editablePartRatio*100)}%。请检查成品后加入。`;
      }catch(error){pending=undefined;status.textContent=abort?.signal.aborted?"已取消；原作品未改变。":`生成失败：${error instanceof Error?error.message:String(error)}`;}finally{run.disabled=false;pause.disabled=true;cancel.disabled=true;resume?.();resume=undefined;}};
    run.onclick=()=>void start();
    pause.onclick=()=>{paused=!paused;pause.textContent=paused?"继续":"暂停";if(!paused){resume?.();resume=undefined;}};
    retry.onclick=()=>{plan.seed=(plan.seed+1)>>>0;void start();};
    enhance.onclick=async()=>{if(!pending||!this.host.artworkComplete)return;if(!consent.checked){status.textContent="请先确认将当前封面预览发送给视觉模型。";return;}
      const original=pending,controller=new AbortController();abort=controller;enhance.disabled=true;insert.disabled=true;cancel.disabled=false;
      try{const canvas=this.contentEl.ownerDocument.createElement("canvas");canvas.width=400;canvas.height=600;const context=canvas.getContext("2d");if(!context)throw new Error("预览画布不可用");renderVectorAssetCanvas(context,original,400,600);status.textContent="视觉模型正在补绘原生矢量细节…";
        const result=await refineComicCoverWithModel({asset:original,model:{complete:(input,signal)=>this.host.artworkComplete!(input,signal)},imageDataUrl:canvas.toDataURL("image/png"),signal:controller.signal,onPreview:asset=>{setPreview(asset);}});
        if(this.history?.document.id!==boardId||this.history.revision!==baseRevision)throw new Error("画板已改变，请重新生成");pending=result.asset;previews.set("review",result.asset);setPreview(result.asset);status.textContent=`AI 补绘完成：新增 ${result.createdIds.length} 个可编辑节点，用时 ${result.latencyMs}ms。请核对画面。`;
      }catch(error){pending=original;setPreview(original);status.textContent=controller.signal.aborted?"AI 补绘已取消；原预览保留。":`AI 补绘失败：${error instanceof Error?error.message:String(error)}。原预览保留。`;}finally{enhance.disabled=false;insert.disabled=false;cancel.disabled=true;}};
    cancel.onclick=()=>{abort?.abort();resume?.();resume=undefined;};
    insert.onclick=()=>{if(!pending||!this.history)return;if(this.history.document.id!==boardId||this.history.revision!==baseRevision){status.textContent="画板已改变，请重新生成预览。";insert.disabled=true;return;}
      const asset=copy(pending),reference=previews.get("composition"),referenceAsset=reference?copy(reference):undefined,layerId=id("COMIC-LAYER"),referenceLayerId=id("COMIC-REFERENCE-LAYER"),artboardId=id("COMIC-ARTBOARD"),objectId=id("COMIC-OBJECT"),current=this.activeArtboard();asset.id=id("COMIC-VECTOR");if(referenceAsset)referenceAsset.id=id("COMIC-REFERENCE-VECTOR");
      const x=current.x+current.width+160,y=current.y;
      this.history.transact(document=>{document.layers??=[];const nextOrder=Math.max(-1,...document.layers.map(item=>item.order))+1;if(referenceAsset)document.layers.push({id:referenceLayerId,name:"构图参考 · 隐藏",order:nextOrder,visible:false,locked:true,opacity:1,blendMode:"normal",kind:"vector",alphaLocked:false,clippedToBelow:false});document.layers.push({id:layerId,name:"NOVA COLLISION · 原生矢量",order:nextOrder+(referenceAsset?1:0),visible:true,locked:false,opacity:1,blendMode:"normal",kind:"vector",alphaLocked:false,clippedToBelow:false});document.artboards??=[];document.artboards.push({id:artboardId,name:"NOVA COLLISION",x,y,width:2048,height:3072,dpi:300,background:plan.palette.paper,exportPreset:"print"});document.vectorAssets??=[];document.vectorAssets.push(asset);if(referenceAsset){document.vectorAssets.push(referenceAsset);document.objects.push({id:id("COMIC-REFERENCE-OBJECT"),kind:"vector",vectorAssetId:referenceAsset.id,vectorAssetVersion:referenceAsset.version,anchor,x,y,width:2048,height:3072,color:plan.palette.ink,strokeWidth:1,layerId:referenceLayerId,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:id("COMIC-REFERENCE-GROUP")});}document.objects.push({id:objectId,kind:"vector",vectorAssetId:asset.id,vectorAssetVersion:asset.version,anchor,x,y,width:2048,height:3072,color:plan.palette.ink,strokeWidth:1,layerId,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:id("COMIC-GROUP")});},"tutor");
      this.activeArtboardId=artboardId;this.activeLayerId=layerId;this.selectedIds.clear();this.selectedIds.add(objectId);this.commit();this.renderShell();modal.close();requestAnimationFrame(()=>{if(this.canvas?.isConnected)this.fitArtboard();});new Notice("三人激战封面已加入；可双击进入矢量部件编辑。");
    };
    modal.onClose=()=>{abort?.abort();resume?.();if(previewUrl)URL.revokeObjectURL(previewUrl);};modal.open();
  }
  private openVectorizationDialog():void{
    const modal=new Modal(this.app);modal.setTitle("矢量化当前选区或图层");
    const mode=modal.contentEl.createEl("select",{attr:{"aria-label":"矢量化模式"}});mode.add(new Option("快速描摹（本地）","trace"));mode.add(new Option("语义重建（视觉模型）","semantic"));
    const prompt=modal.contentEl.createEl("textarea",{attr:{placeholder:"可选：描述需要保留的角色部件和层级","aria-label":"语义重建要求"}});prompt.rows=4;
    const consentRow=modal.contentEl.createEl("label",{cls:"atl-studio-cloud-consent"}),consent=consentRow.createEl("input",{type:"checkbox"});consentRow.appendText(" 允许仅将当前选区/当前图层及上述提示词发送给已配置的视觉模型");consentRow.hidden=true;
    mode.onchange=()=>{consentRow.hidden=mode.value!=="semantic";};
    const status=modal.contentEl.createDiv({cls:"atl-studio-ai-status",text:"只处理当前选区；没有对象选区时处理当前图层。"}),actions=modal.contentEl.createDiv({cls:"modal-button-container"});
    const run=actions.createEl("button",{text:"生成预览"}),insert=actions.createEl("button",{text:"加入画板"});insert.hidden=true;let pending:BoardVectorAsset|undefined,pendingBounds:{x:number;y:number;width:number;height:number}|undefined,abort:AbortController|undefined;
    run.onclick=async()=>{run.disabled=true;insert.hidden=true;abort?.abort();abort=new AbortController();try{const selectedMode=mode.value as "trace"|"semantic";if(selectedMode==="semantic"&&!consent.checked)throw new Error("请先确认仅上传当前选区或当前图层");const capture=await this.captureVectorizationImage(),provider=selectedMode==="trace"?(this.host.createVectorizationProvider?.("trace")??createRasterTraceVectorizationProvider()):(this.host.createVectorizationProvider?.("semantic")??null);if(!provider)throw new Error("当前未配置支持图像输入的视觉模型");const available=await provider.availability();if(!available.available)throw new Error(available.reason??"矢量化 Provider 不可用");status.textContent=selectedMode==="trace"?"正在本地描摹…":"正在规划语义部件…";const result=await provider.vectorize({requestId:id("VECTORIZE"),mode:selectedMode,image:capture,prompt:prompt.value.trim(),maxColors:16,simplify:.55},abort.signal,asset=>{pending=asset;},progress=>{status.textContent=progress.message??progress.stage;});pending=result.asset;pendingBounds=capture.bounds;insert.hidden=false;status.textContent=`预览完成：${result.asset.nodes.length} 个节点，语义部件率 ${Math.round((result.semanticPartRatio??result.editability.namedPartRatio)*100)}%。${result.warnings.join("；")}`;}catch(error){status.textContent=abort?.signal.aborted?"已取消，原作品未改变。":`矢量化失败：${error instanceof Error?error.message:String(error)}`;}finally{run.disabled=false;}};
    insert.onclick=()=>{if(!pending||!pendingBounds||!this.history)return;const asset=copy(pending),objectId=id("VECTOR-OBJECT"),layerId=id("LAYER");this.history.transact(document=>{document.layers??=[];document.layers.push({id:layerId,name:"矢量化结果",order:Math.max(-1,...document.layers.map(layer=>layer.order))+1,visible:true,locked:false,opacity:1,blendMode:"normal",kind:"vector",alphaLocked:false,clippedToBelow:false});document.vectorAssets??=[];document.vectorAssets.push(asset);document.objects.push({id:objectId,kind:"vector",vectorAssetId:asset.id,vectorAssetVersion:asset.version,anchor,x:pendingBounds!.x,y:pendingBounds!.y,width:pendingBounds!.width,height:pendingBounds!.height,color:"#292929",strokeWidth:1,layerId,createdBy:"human",editedBy:"human",revision:1,groupId:id("VECTORIZE")});},"human");this.activeLayerId=layerId;this.selectedIds.clear();this.selectedIds.add(objectId);this.commit();modal.close();};
    modal.onClose=()=>abort?.abort();modal.open();
  }
  private renderStudioLayers(parent: HTMLElement): void {
    parent.empty();
    const layers = [...(this.history?.document.layers ?? [])].sort((a, b) => b.order - a.order);
    for (const layer of layers) {
      const row = parent.createDiv({ cls: "atl-studio-layer-row" });
      row.toggleClass("is-active", layer.id === this.activeLayerId);
      row.style.setProperty("--atl-layer-depth", layer.parentId ? "1" : "0");
      row.tabIndex = 0;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", `${layer.name}，${layer.kind === "paint" ? "绘画" : layer.kind === "group" ? "分组" : "矢量"}图层${layer.id === this.activeLayerId ? "，当前图层" : ""}`);
      const visible = row.createEl("button", { text: layer.visible ? t("board.visible") : "显示图层" });
      decorateBoardButton(visible, layer.visible ? "visible" : "hidden");
      visible.onclick = (event) => { event.stopPropagation(); this.history?.transact(document => { const target = document.layers?.find(item => item.id === layer.id); if (target) target.visible = !target.visible; }); this.commitAndRebuild(); };
      const kindIcon = row.createSpan({ cls: "atl-studio-layer-kind", attr: { "aria-hidden": "true" } });
      setIcon(kindIcon, layer.kind === "paint" ? "paintbrush" : layer.kind === "group" ? "folder" : "pen-tool");
      row.createSpan({ cls: "atl-studio-layer-name", text: layer.name });
      const lock = row.createEl("button", { text: layer.locked ? "解锁图层" : "锁定图层" });
      decorateBoardButton(lock, layer.locked ? "unlock" : "lock");
      lock.onclick = (event) => { event.stopPropagation(); this.history?.transact(document => { const target = document.layers?.find(item => item.id === layer.id); if (target) target.locked = !target.locked; }); this.commitAndRebuild(); };
      row.onclick = () => { this.activeLayerId = layer.id; this.renderStudioLayers(parent); };
      row.onkeydown = event => { if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); row.click(); } };
      if (layer.kind !== "group") {
        const flags = row.createDiv({ cls: "atl-studio-layer-flags" });
        const alpha = flags.createEl("button", { cls: "atl-studio-layer-toggle", attr: { title: "锁定透明像素" } });
        setIcon(alpha, "lock-keyhole"); alpha.createSpan({ text: "透明锁" });
        alpha.toggleClass("is-active", !!layer.alphaLocked);
        alpha.setAttribute("aria-pressed", String(!!layer.alphaLocked));
        alpha.setAttribute("aria-label", "锁定透明像素");
        alpha.onclick = (event) => { event.stopPropagation(); this.history?.transact(document => { const target = document.layers?.find(item => item.id === layer.id); if (target) target.alphaLocked = !target.alphaLocked; }); this.commitAndRebuild(); };
        const clip = flags.createEl("button", { cls: "atl-studio-layer-toggle", attr: { title: "剪贴到下方图层" } });
        setIcon(clip, "combine"); clip.createSpan({ text: "剪贴" });
        clip.toggleClass("is-active", !!layer.clippedToBelow);
        clip.setAttribute("aria-pressed", String(!!layer.clippedToBelow));
        clip.setAttribute("aria-label", "剪贴到下方图层");
        clip.onclick = (event) => { event.stopPropagation(); this.history?.transact(document => { const target = document.layers?.find(item => item.id === layer.id); if (target) target.clippedToBelow = !target.clippedToBelow; }); this.commitAndRebuild(); };
      }
    }
  }
  private addStudioLayer(kind: "vector" | "paint" | "group"): void {
    const idValue = id("LAYER");
    this.history?.transact(document => {
      const order = Math.max(-1, ...(document.layers ?? []).map(layer => layer.order)) + 1;
      document.layers ??= [];
      document.layers.push({ id: idValue, name: kind === "paint" ? "绘画图层" : kind === "group" ? "图层组" : "矢量图层", order, visible: true, locked: false, opacity: 1, blendMode: "normal", kind, alphaLocked: false, clippedToBelow: false });
    });
    this.activeLayerId = idValue;
    this.commitAndRebuild();
  }
  private configureArtboard(create: boolean): void {
    if (!this.history) return;
    const current = this.activeArtboard();
    const modal = new Modal(this.app); modal.setTitle(create ? "新建画面边界" : "画面设置");
    modal.contentEl.addClass("atl-studio-artboard-modal");
    modal.contentEl.createEl("p", { text: "无限画布可以继续在边界外绘制；画面边界只决定裁切、DPI 与导出范围。" });
    const preset = modal.contentEl.createEl("select", { attr: { "aria-label": "画面预设" } });
    for (const [value, label] of [["custom", "自定义"], ["studio", "绘画 · 1280×720"], ["screen", "屏幕 · 1920×1080"], ["square", "方形 · 2048×2048"], ["portrait", "插画 · 2048×3072"], ["a4", "A4 · 2480×3508"]] as const) preset.add(new Option(label, value));
    const form = modal.contentEl.createDiv({ cls: "atl-studio-artboard-form" });
    const existingArtboards = this.history.document.artboards ?? [];
    const suggestedX = create && existingArtboards.length ? Math.max(...existingArtboards.map(item => item.x + item.width)) + 160 : current.x;
    const field = (label: string, value: string, type: "text" | "number") => {
      const row = form.createEl("label"); row.createSpan({ text: label });
      const input = row.createEl("input", { type, attr: { "aria-label": label } }); input.value = value;
      return input;
    };
    const name = field("名称", create ? `画面 ${(this.history.document.artboards?.length ?? 0) + 1}` : current.name, "text");
    const xInput = field("位置 X", String(suggestedX), "number");
    const yInput = field("位置 Y", String(create ? 0 : current.y), "number");
    const widthInput = field("宽度 · px", String(current.width), "number");
    const heightInput = field("高度 · px", String(current.height), "number");
    const dpiInput = field("DPI · 仅影响打印尺寸", String(current.dpi), "number");
    const background = field("背景颜色", current.background, "text");
    preset.onchange = () => {
      const sizes: Record<string, [number, number, number]> = { studio: [1280,720,144], screen: [1920,1080,144], square: [2048,2048,144], portrait: [2048,3072,300], a4: [2480,3508,300] };
      const size = sizes[preset.value]; if (!size) return;
      widthInput.value = String(size[0]); heightInput.value = String(size[1]); dpiInput.value = String(size[2]);
    };
    const error = modal.contentEl.createDiv({ cls: "atl-studio-artboard-error" });
    const actions = modal.contentEl.createDiv({ cls: "modal-button-container" });
    if (!create) {
      const reset = actions.createEl("button", { text: "恢复 1280×720 · 原点" });
      reset.onclick = () => { preset.value = "studio"; xInput.value = "0"; yInput.value = "0"; widthInput.value = "1280"; heightInput.value = "720"; dpiInput.value = "144"; error.textContent = "已填写推荐值；点击「应用设置」后才会更改作品。"; };
    }
    const cancel = actions.createEl("button", { text: "取消" }); cancel.onclick = () => modal.close();
    const save = actions.createEl("button", { cls: "mod-cta", text: create ? "新建画面" : "应用设置" });
    save.onclick = () => {
      const width = Number(widthInput.value), height = Number(heightInput.value), dpi = Number(dpiInput.value), positionX = Number(xInput.value), positionY = Number(yInput.value);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 16384 || height > 16384 || !Number.isFinite(positionX) || !Number.isFinite(positionY) || Math.abs(positionX) > 1_000_000 || Math.abs(positionY) > 1_000_000 || !Number.isInteger(dpi) || dpi < 36 || dpi > 600 || !/^#[a-f\d]{6}$/i.test(background.value) || !name.value.trim()) {
        error.textContent = "请输入名称、X/Y 坐标、64–16384px 的整数尺寸、36–600 DPI 和 #RRGGBB 背景色。"; return;
      }
      const artboardId = create ? id("ARTBOARD") : current.id;
      this.history!.transact(document => {
        document.artboards ??= [];
        const value = { id: artboardId, name: name.value.trim(), x: positionX, y: positionY, width, height, dpi, background: background.value, exportPreset: dpi >= 240 ? "print" as const : "screen" as const };
        if (create) document.artboards.push(value);
        else document.artboards.splice(document.artboards.findIndex(item => item.id === current.id), 1, value);
      }, "human");
      this.activeArtboardId = artboardId; this.commit(); this.renderShell(); modal.close();
      requestAnimationFrame(() => this.fitArtboard());
    };
    modal.open(); name.focus();
  }
  private commitAndRebuild(): void {
    this.commit();
    const parent = this.contentEl.querySelector<HTMLElement>(".atl-studio-layer-list");
    if (parent) this.renderStudioLayers(parent);
  }
  private renderSelectionInspector(parent:HTMLElement):()=>void{
    const panel=parent.createEl("details",{cls:"atl-studio-panel atl-selection-inspector"});panel.open=true;panel.createEl("summary",{text:"选择与变换"});const body=panel.createDiv();
    const refresh=()=>{
      body.empty();if(!this.history)return;const document=this.history.document,box=selectionBounds(document.objects,this.selectedIds);
      if(this.paintSelection){
        const region=body.createDiv({cls:"atl-studio-selection-region"});
        region.createSpan({text:"绘画选区生效中 · 位图笔迹仅落在圈内"});
        const clear=region.createEl("button",{text:t("board.clearPaintSelection")});
        clear.onclick=()=>{this.paintSelection=undefined;refresh();this.schedule();};
      }
      if(!box){body.createDiv({cls:"setting-item-description",text:"选择一个或多个对象后，可精确移动、缩放、旋转、翻转或删除。"});return;}
      body.createDiv({cls:"setting-item-description",text:`已选择 ${this.selectedIds.size} 个对象`});
      const applyBounds=(target:{x:number;y:number;width:number;height:number})=>{const ids=new Set(this.selectedIds);this.history?.transact(d=>{d.objects=scaleObjects(d.objects,ids,box,target);},"human");this.commit();refresh();this.refreshVectorInspector?.();};
      const field=(label:string,value:number,onchange:(value:number)=>void)=>{const row=body.createEl("label",{cls:"atl-studio-control"});row.createSpan({text:label});const input=row.createEl("input",{type:"number",attr:{"aria-label":label}});input.value=String(Math.round(value*100)/100);input.onchange=()=>{const next=Number(input.value);if(Number.isFinite(next))onchange(next);else refresh();};return input;};
      field("X",box.x,value=>applyBounds({...box,x:value}));field("Y",box.y,value=>applyBounds({...box,y:value}));field("宽度",box.width,value=>applyBounds({...box,width:Math.max(.1,value)}));field("高度",box.height,value=>applyBounds({...box,height:Math.max(.1,value)}));
      const primary=document.objects.find(object=>object.id===this.primarySelection());field("旋转（°）",(primary?.rotation??0)*180/Math.PI,value=>{const radians=value*Math.PI/180,ids=new Set(this.selectedIds);this.history?.transact(d=>{d.objects=d.objects.map(object=>ids.has(object.id)?{...object,rotation:radians}:object);},"human");this.commit();refresh();});
      const actions=body.createDiv({cls:"atl-studio-layer-actions"});
      for(const [label,axis] of [["水平翻转","horizontal"],["垂直翻转","vertical"]] as const){const button=actions.createEl("button",{text:label});button.onclick=()=>{const ids=new Set(this.selectedIds);this.history?.transact(d=>{d.objects=flipObjects(d.objects,ids,box,axis);},"human");this.commit();refresh();};}
      const remove=actions.createEl("button",{text:"删除选中"});remove.onclick=()=>{const ids=new Set(this.selectedIds);this.history?.transact(d=>{d.objects=d.objects.filter(object=>!ids.has(object.id));},"human");this.selectedIds.clear();this.commit();refresh();this.refreshVectorInspector?.();};
    };refresh();return refresh;
  }
  private refreshTools(): void {
    for (const button of this.contentEl.querySelectorAll<HTMLButtonElement>("[data-tool]"))
      button.classList.toggle("is-active", button.dataset.tool === this.tool);
    for (const button of this.contentEl.querySelectorAll<HTMLButtonElement>("[data-brush]"))
      button.classList.toggle("is-active", button.dataset.brush === this.brush.kind);
  }
  private refreshBrushPreviews(): void {
    this.sizeControl?.setColor(this.color);
    for (const canvas of this.contentEl.querySelectorAll<HTMLCanvasElement>(".atl-studio-brush-card canvas")) {
      const kind = canvas.closest<HTMLElement>("[data-brush]")?.dataset.brush as BoardBrushKind | undefined;
      if (kind) paintBoardBrushPreview(canvas, kind, Math.min(BOARD_BRUSH_DEFAULT_WIDTHS[kind], 28), this.color,
        kind===this.brush.kind?this.brush:studioBoardBrush(kind,0x51f15e),this.brushImages);
    }
  }
  private refreshCurrentBrushPreview(): void {
    this.sizeControl?.refresh();
    const canvas=this.contentEl.querySelector<HTMLCanvasElement>(`.atl-studio-brush-card[data-brush="${this.brush.kind}"] canvas`);
    if(canvas)paintBoardBrushPreview(canvas,this.brush.kind,Math.min(BOARD_BRUSH_DEFAULT_WIDTHS[this.brush.kind],28),this.color,this.brush,this.brushImages);
  }
  private installInput(): void {
    const canvas = this.canvas!;
    const active = () => !this.closed && !this.transitions && this.canvas === canvas && !!this.history;
    canvas.onpointerdown = (event) => {
      if (!active()) return;
      const client = { x: event.offsetX, y: event.offsetY };
      if (event.button !== 0) return;
      this.pendingInitialFit = false;
      if (event.pointerType === "touch") {
        this.touches.set(event.pointerId, client);
        if (this.touches.size === 2 && (!this.gesture || this.gesture.mode === "pan")) {
          const [a, b] = [...this.touches.values()];
          const center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
          this.pinch = { distance: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), zoom: this.zoom, world: this.toWorld(center) };
          this.gesture = null;
          canvas.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (this.gesture) return;
      const mode: Tool = event.pointerType === "touch" || this.spaceDown ? "pan" : this.tool;
      const world = this.toWorld(client);
      if (mode === "eyedropper") {
        const context = this.staticCanvas?.getContext("2d"), ratio = this.contentEl.ownerDocument.defaultView?.devicePixelRatio || 1;
        if (context) {
          const pixel = context.getImageData(Math.max(0, Math.floor(event.offsetX * ratio)), Math.max(0, Math.floor(event.offsetY * ratio)), 1, 1).data;
          this.color = `#${[pixel[0], pixel[1], pixel[2]].map(value => value!.toString(16).padStart(2, "0")).join("")}`;
          this.renderShell();
        }
        return;
      }
      if (mode === "fill") {
        void this.fillAt(world);
        return;
      }
      if (!["pan","select","transform","lasso","crop"].includes(mode) && !this.layerEditable(this.activeLayerId)) { new Notice(t("board.layerLocked")); return; }
      if (mode === "text") {
        const value = window.prompt(t("board.textPlaceholder"));
        if (value) {
          this.history?.transact(document => document.objects.push({ id: id("OBJ"), kind: "text", anchor, x: world.x, y: world.y, width: 320, height: 48, color: this.color, strokeWidth: 1, layerId: this.activeLayerId, text: value, textStyle: { font: "sans", size: 28, align: "left" }, createdBy: "human", editedBy: "human", revision: 1, groupId: id("GROUP") }));
          this.commit();
        }
        return;
      }
      const interactionMode: Tool = mode === "transform" ? "select" : mode;
      if (interactionMode === "select" || interactionMode === "erase") {
        const activeLayer = this.history?.renderDocument.layers?.find(layer => layer.id === this.activeLayerId);
        if (interactionMode === "erase" && activeLayer?.kind === "paint") {
          if (activeLayer.locked) { new Notice(t("board.layerLocked")); return; }
          event.preventDefault();
          canvas.setPointerCapture(event.pointerId);
          this.gesture = {
            pointerId: event.pointerId, mode: "erase", startClient: client, lastClient: client, startWorld: world,
            points: [{ ...world, pressure: event.pressure, t: event.timeStamp, tiltX: event.tiltX, tiltY: event.tiltY, twist: event.twist }],
            seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
          };
          return;
        }
        const selectedBounds = this.selectedBounds();
        const handle = selectedBounds ? hitTransformHandle(world, selectedBounds, 9 / this.zoom) : null;
        const insideSelection = !!selectedBounds && pointInRect(world, selectedBounds, 4 / this.zoom);
        const object = insideSelection || handle
          ? this.history?.renderDocument.objects.find(item => this.selectedIds.has(item.id))
          : this.hit(world);
        if (object && interactionMode === "erase") {
          this.history?.transact((document) => { document.objects = document.objects.filter((item) => item.id !== object.id); }, "human");
          this.commit();
        }
        if (interactionMode === "erase") return;
        if (!insideSelection && !handle) this.selectObject(object, event.shiftKey);
        this.refreshSelectionInspector?.();
        this.refreshVectorInspector?.();
        this.schedule();
        if (!object) return;
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        this.gesture = {
          pointerId: event.pointerId, mode: "select", startClient: client, lastClient: client, startWorld: world,
          points: [world], seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
          before: copy(this.history!.document.objects), objectIds: [...this.selectedIds],
          ...(selectedBounds ? { selectionBounds: copy(selectedBounds) } : {}),
          ...(handle ? { transformHandle: handle } : {}), shiftKey: event.shiftKey, altKey: event.altKey,
        };
        return;
      }
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      this.gesture = {
        pointerId: event.pointerId, mode: interactionMode, startClient: client, lastClient: client,
        startWorld: world,
        points: [{ ...world, pressure: event.pressure, t: event.timeStamp, tiltX: event.tiltX, tiltY: event.tiltY, twist: event.twist }],
        seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
      };
    };
    canvas.onpointermove = (event) => {
      if (!active()) return;
      if (this.brushCursor && this.tool === "pen") positionBoardBrushCursor(this.brushCursor, event, this.brush.kind, this.width, canvas.getBoundingClientRect(), this.zoom);
      else if (this.brushCursor) this.brushCursor.hidden = true;
      if (event.pointerType === "touch" && this.touches.has(event.pointerId)) {
        this.touches.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
        if (this.pinch && this.touches.size >= 2) {
          const [a, b] = [...this.touches.values()];
          const center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
          const distance = Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y));
          this.zoom = Math.max(0.1, Math.min(8, this.pinch.zoom * distance / this.pinch.distance));
          this.pan = { x: center.x - this.pinch.world.x * this.zoom, y: center.y - this.pinch.world.y * this.zoom };
          this.queueCameraRefine();
          this.schedule();
          return;
        }
      }
      const gesture = this.gesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const client = { x: event.offsetX, y: event.offsetY };
      if (gesture.mode === "pan") {
        this.pan.x += client.x - gesture.lastClient.x;
        this.pan.y += client.y - gesture.lastClient.y;
        this.queueCameraRefine();
      } else if (gesture.mode === "select" && gesture.before && gesture.objectIds?.length) {
        const world = this.toWorld(client);
        const selected = new Set(gesture.objectIds);
        if (gesture.transformHandle === "rotate" && gesture.selectionBounds) {
          const bounds = gesture.selectionBounds, center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          const start = Math.atan2(gesture.startWorld.y - center.y, gesture.startWorld.x - center.x);
          const end = Math.atan2(world.y - center.y, world.x - center.x);
          this.draftObjects = rotateObjects(gesture.before, selected, bounds, end - start);
        } else if (gesture.transformHandle && gesture.selectionBounds) {
          const source = gesture.selectionBounds, target = { ...source };
          const dx = world.x - gesture.startWorld.x, dy = world.y - gesture.startWorld.y;
          if (gesture.transformHandle.includes("w")) { target.x += dx; target.width -= dx; }
          if (gesture.transformHandle.includes("e")) target.width += dx;
          if (gesture.transformHandle.includes("n")) { target.y += dy; target.height -= dy; }
          if (gesture.transformHandle.includes("s")) target.height += dy;
          if (gesture.shiftKey) {
            const ratio = source.width / Math.max(0.001, source.height);
            if (Math.abs(target.width - source.width) >= Math.abs(target.height - source.height)) target.height = target.width / ratio;
            else target.width = target.height * ratio;
          }
          if (gesture.altKey) {
            target.x = source.x - (target.width - source.width) / 2;
            target.y = source.y - (target.height - source.height) / 2;
          }
          this.draftObjects = scaleObjects(gesture.before, selected, source, target);
        } else {
          const dx = world.x - gesture.startWorld.x, dy = world.y - gesture.startWorld.y;
          this.draftObjects = moveObjects(gesture.before, selected, dx, dy);
        }
      } else if (gesture.mode === "pen" || gesture.mode === "erase" || gesture.mode === "lasso") {
        const events = event.getCoalescedEvents?.() ?? [event];
        for (const part of events.length ? events : [event]) {
          const rect = canvas.getBoundingClientRect();
          const point = this.toWorld({ x: part.clientX - rect.left, y: part.clientY - rect.top });
          const previous = gesture.points.at(-1);
          if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= (gesture.mode === "lasso" ? 2 / this.zoom : 0))
            gesture.points.push({ ...point, pressure: part.pressure, t: part.timeStamp, tiltX: part.tiltX, tiltY: part.tiltY, twist: part.twist });
        }
      }
      gesture.lastClient = client;
      this.schedule();
    };
    const release = (event: PointerEvent) => {
      if (!active()) return;
      if (event.pointerType === "touch") {
        this.touches.delete(event.pointerId);
        if (this.pinch) {
          if (this.touches.size < 2) { this.pinch = null; this.queueCameraRefine(70); }
          return;
        }
      }
      const gesture = this.gesture;
      if (gesture?.pointerId === event.pointerId) {
        const rect = canvas.getBoundingClientRect();
        const client = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        gesture.lastClient = client;
        if ((gesture.mode === "pen" || gesture.mode === "erase") && event.type === "pointerup") {
          const point = this.toWorld(client), previous = gesture.points.at(-1);
          if (!previous || previous.x !== point.x || previous.y !== point.y)
            gesture.points.push({ ...point, pressure: event.pressure, t: event.timeStamp, tiltX: event.tiltX, tiltY: event.tiltY, twist: event.twist });
        }
      }
      this.finish(event.pointerId);
      if (gesture?.mode === "pan") this.queueCameraRefine(70);
    };
    canvas.onpointerup = release;
    canvas.onpointercancel = release;
    canvas.onpointerleave = () => { if (this.brushCursor) this.brushCursor.hidden = true; };
    canvas.onwheel = (event) => {
      if (!active()) return;
      event.preventDefault();
      this.pendingInitialFit = false;
      const before = this.toWorld({ x: event.offsetX, y: event.offsetY });
      this.zoom = Math.max(0.1, Math.min(8, this.zoom * Math.exp(-event.deltaY * 0.0015)));
      this.pan.x = event.offsetX - before.x * this.zoom;
      this.pan.y = event.offsetY - before.y * this.zoom;
      this.queueCameraRefine();
      this.schedule();
    };
    canvas.onkeydown = (event) => {
      if (!active()) return;
      if (event.code === "Space") { this.spaceDown = true; event.preventDefault(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey ? this.history?.redo() : this.history?.undo()) this.commit();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && this.selectedIds.size) {
        event.preventDefault();
        const selected = new Set(this.selectedIds);
        if([...selected].some(id=>!this.layerEditable(this.history?.renderDocument.objects.find(o=>o.id===id)?.layerId)))return;
        this.history?.transact((document) => {
          document.objects = document.objects.filter((object) => !selected.has(object.id));
        }, "human");
        this.selectedIds.clear();
        this.commit();
        this.refreshSelectionInspector?.();this.refreshVectorInspector?.();
      }
      if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key) && this.selectedIds.size && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1, dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
          dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0, selected = new Set(this.selectedIds);
        this.history?.transact(document => { document.objects = moveObjects(document.objects, selected, dx, dy); }, "human");
        this.commit();
        this.refreshSelectionInspector?.();
      }
      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        this.width = this.sizeControl?.step(event.key === "[" ? -1 : 1) ?? this.width;
      }
    };
    canvas.onkeyup = (event) => { if (event.code === "Space") this.spaceDown = false; };
    canvas.onblur = () => (this.spaceDown = false);
  }
  private async fillAt(world: BoardPoint): Promise<void> {
    if(this.closed || this.transitions)return;
    const document = this.history?.renderDocument;
    if (!document || !this.bundle) return;
    const source=this.sourceFile,history=this.history,revision=document.revision,generation=this.loadGeneration,color=this.color,opacity=this.brush.opacity;
    if(!this.layerEditable(this.activeLayerId)){new Notice(t("board.layerLocked"));return;}
    const layer = document.layers?.find(item => item.id === this.activeLayerId);
    if (layer?.kind !== "paint") {
      const object = this.hit(world);
      if (object && ["path", "rect", "ellipse"].includes(object.kind)) {
        this.history?.transact(draft => { const target = draft.objects.find(item => item.id === object.id); if (target) target.fill = { kind: "solid", color: this.color, opacity: this.brush.opacity, seed: this.brush.seed }; });
        this.commit();
      } else new Notice("矢量填充请点击闭合图形；连续区域填充需要绘画图层");
      return;
    }
    if (layer.locked) { new Notice(t("board.layerLocked")); return; }
    const artboard = this.activeArtboard();
    if (artboard.width > 16384 || artboard.height > 16384) { new Notice("连续填充目前支持最大 16384×16384 的 Artboard"); return; }
    const localX = Math.floor(world.x - artboard.x), localY = Math.floor(world.y - artboard.y);
    if (localX < 0 || localY < 0 || localX >= artboard.width || localY >= artboard.height) return;
    const layerCanvas = this.renderArtboardCanvas(new Set([layer.id]), false, artboard), context = layerCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const image = context.getImageData(0, 0, layerCanvas.width, layerCanvas.height);
    const tolerance = 24;
    const mask = floodFillMask(image.data, image.width, image.height, localX, localY, tolerance, !!layer.alphaLocked);
    if (!mask.some(value => value !== 0)) return;
    if(this.paintSelection){for(let i=0;i<mask.length;i++){const point={x:artboard.x+i%image.width,y:artboard.y+Math.floor(i/image.width)};if(!this.selectionContains(this.paintSelection,point))mask[i]=0;}}
    if (layer.alphaLocked) {
      for (let index = 0; index < mask.length; index++) {
        if (mask[index]) mask[index] = image.data[index * 4 + 3]!;
      }
    }
    const compressed = deflateSync(mask, { level: 6 }), hash = await sha256Hex(compressed);
    if(this.closed||this.transitions||this.loadGeneration!==generation||this.history!==history||history?.revision!==revision)return;
    this.paintAssets.set(hash, compressed);
    if (this.host.writePaintAsset)
      await this.host.writePaintAsset(hash, compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer);
    if(this.closed||this.transitions||this.loadGeneration!==generation||this.sourceFile!==source||this.history!==history||this.history?.revision!==revision){return;}
    this.history?.transact(draft => {
      draft.paintOperations ??= [];
      draft.paintOperations.push({
        id: id("PAINT"), layerId: layer.id, type: "fill", bounds: { x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height },
        affectedTiles: affectedBoardTiles(artboard), color, opacity,
        maskAssetHash: hash, maskWidth: image.width, maskHeight: image.height, fillTolerance: tolerance,
        createdAt: new Date().toISOString(), revision: draft.revision + 1,
      });
    });
    this.fillCanvases.clear();
    this.commit();
  }
  private finish(pointerId: number): void {
    const gesture = this.gesture, draft = this.draftObjects, history = this.history, revision = history?.revision;
    try { this.finishGesture(pointerId); }
    catch (error) {
      // Validation failures must leave the gesture retryable. If the transaction
      // already committed, do not resurrect it after a later UI failure.
      if (this.history === history && history?.revision === revision) { this.gesture = gesture; this.draftObjects = draft; }
      throw error;
    }
  }
  private finishGesture(pointerId: number): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== pointerId) return;
    this.livePainter.clear();
    this.gesture = null;
    if ((gesture.mode === "pen" || gesture.mode === "erase") && gesture.points.length) {
      const activeLayer = this.history?.renderDocument.layers?.find(layer => layer.id === this.activeLayerId);
      if (!activeLayer || !this.layerEditable(activeLayer.id) || activeLayer.kind === "group" || (gesture.mode === "erase" && activeLayer.kind !== "paint")) {
        new Notice(activeLayer?.locked ? t("board.layerLocked") : "请先选择矢量或绘画图层");
      } else {
        const pendingInk: BoardBundle["ink"] = {};
        const groupId = id("GROUP"), append = (document: BoardBundle["document"], source: BoardPoint[], seed: number) => {
          const bounds = pointBounds(source), inkId = id("INK");
          pendingInk[inkId] = {
            id: inkId, createdAt: new Date().toISOString(),
            points: source.map(point => ({ ...point, x: point.x - bounds.x, y: point.y - bounds.y })),
          };
            if (activeLayer.kind === "paint") {
              const operationBrush = gesture.mode === "erase" ? defaultBoardBrush("pen", seed) : { ...copy(this.brush), seed };
              document.paintOperations ??= [];
              document.paintOperations.push({
                id: id("PAINT"), layerId: activeLayer.id, type: gesture.mode === "erase" ? "erase" : "stroke", bounds,
                affectedTiles: affectedBoardTiles({ x: bounds.x - this.width, y: bounds.y - this.width, width: bounds.width + this.width * 2, height: bounds.height + this.width * 2 }),
                color: gesture.mode === "erase" ? "#000000" : this.color, opacity: gesture.mode === "erase" ? 1 : this.brush.opacity, strokeWidth: this.width, inkId,
                brush: operationBrush, alphaLocked:activeLayer.alphaLocked,selection:this.paintSelection?copy(this.paintSelection):undefined,createdAt: new Date().toISOString(),
                revision: document.revision + 1,
              });
            } else if (gesture.mode === "pen") {
              document.objects.push({
                id: id("OBJ"), kind: "ink", anchor, ...bounds, color: this.color,
                strokeWidth: this.width, brush: { ...copy(this.brush), seed },
                layerId: this.activeLayerId, inkId, createdBy: "human", editedBy: "human",
                revision: 1, groupId,
              });
            }
        };
        this.history?.transact(document=>{
        append(document, gesture.points, gesture.seed);
        const artboard = this.history?.renderDocument.artboards?.find(item => item.id === this.activeArtboardId);
        if (this.symmetry && artboard) {
          const axis = artboard.x + artboard.width / 2;
          append(document, gesture.points.map(point => ({ ...point, x: axis * 2 - point.x, tiltX: point.tiltX === undefined ? undefined : -point.tiltX })), (gesture.seed ^ 0x9e3779b9) >>> 0);
        }
        }, "human");
        Object.assign(this.bundle!.ink, pendingInk);
        this.commit();
        if(activeLayer.kind==="paint"&&!this.closed&&!this.transitions){this.checkpointService?.invalidate(activeLayer.id,pointBounds(gesture.points));void this.maybeCheckpointPaintLayer(activeLayer.id);}
      }
    } else if (gesture.mode === "lasso") {
      const polygon = gesture.points.length >= 3 ? gesture.points.map(({x,y})=>({x,y})) : [gesture.startWorld,this.toWorld(gesture.lastClient)];
      if (polygon.length >= 3) {
        const bounds = boundsForPoints(polygon);
        this.paintSelection={kind:"polygon",bounds,points:polygon};
        const matching = this.history?.renderDocument.objects.filter(object=>this.layerEditable(object.layerId)&&objectIntersectsRegion(object,this.paintSelection!))??[];
        this.selectedIds.clear(); for(const object of matching)this.selectedIds.add(object.id);
        this.refreshSelectionInspector?.();
        this.refreshVectorInspector?.();
      }
    } else if (gesture.mode === "crop") {
      const end = this.toWorld(gesture.lastClient), bounds = pointBounds([gesture.startWorld, end]);
      if (Math.hypot(bounds.width, bounds.height) > 16) {
        this.history?.transact(document => { const target = document.artboards?.find(item => item.id === this.activeArtboardId); if (target) Object.assign(target, bounds); });
        this.commit(); this.fitArtboard();
      }
    } else if (gesture.mode === "gradient") {
      const end = this.toWorld(gesture.lastClient), bounds = pointBounds([gesture.startWorld, end]);
      const layer = this.history?.renderDocument.layers?.find(item => item.id === this.activeLayerId);
      if (layer?.kind === "paint" && this.layerEditable(layer.id) && Math.hypot(bounds.width, bounds.height) > 3) {
        this.history?.transact(document => {
          document.paintOperations ??= [];
          document.paintOperations.push({ id: id("PAINT"), layerId: layer.id, type: "gradient", bounds, affectedTiles: affectedBoardTiles(bounds), color: this.color, opacity: this.brush.opacity,alphaLocked:layer.alphaLocked,selection:this.paintSelection?copy(this.paintSelection):undefined,gradient: { kind: "linear", from: gesture.startWorld, to: end, endColor: "#ffffff" }, createdAt: new Date().toISOString(), revision: document.revision + 1 });
        });
        this.commit();
      } else new Notice("渐变需要一个未锁定的绘画图层");
    } else if (["arrow", "rect", "ellipse"].includes(gesture.mode)) {
      const end = this.toWorld(gesture.lastClient);
      const bounds = pointBounds([gesture.startWorld, end]);
      if (Math.hypot(bounds.width, bounds.height) > 3) {
        const object: BoardObject = {
          id: id("OBJ"), kind: gesture.mode as "arrow" | "rect" | "ellipse", anchor,
          ...bounds, color: this.color, strokeWidth: this.width, layerId: this.activeLayerId,
          ...(gesture.mode === "arrow" ? { points: [
            { x: gesture.startWorld.x - bounds.x, y: gesture.startWorld.y - bounds.y },
            { x: end.x - bounds.x, y: end.y - bounds.y },
          ] } : {}),
          drawingStyle: { kind: "clean", seed: gesture.seed }, createdBy: "human", editedBy: "human",
          revision: 1, groupId: id("GROUP"),
        };
        this.history?.transact((document) => document.objects.push(object), "human");
        this.commit();
      }
    } else if (gesture.mode === "select" && this.draftObjects) {
      const objects = this.draftObjects;
      this.draftObjects = null;
      this.history?.transact((document) => { document.objects = copy(objects); }, "human");
      this.commit();
      this.refreshSelectionInspector?.();
      this.refreshVectorInspector?.();
    }
    this.schedule();
  }
  private toWorld(point: BoardPoint): BoardPoint {
    const canvas = this.canvas;
    if (!canvas || (!this.canvasRotation && !this.mirrorPreview))
      return { x: (point.x - this.pan.x) / this.zoom, y: (point.y - this.pan.y) / this.zoom };
    const rect = canvas.getBoundingClientRect(), cx = rect.width / 2, cy = rect.height / 2;
    const dx = point.x - cx, dy = point.y - cy;
    const cos = Math.cos(-this.canvasRotation), sin = Math.sin(-this.canvasRotation);
    let x = dx * cos - dy * sin, y = dx * sin + dy * cos;
    if (this.mirrorPreview) x = -x;
    x += cx; y += cy;
    return { x: (x - this.pan.x) / this.zoom, y: (y - this.pan.y) / this.zoom };
  }
  private layerEditable(id?:string):boolean {
    const layers=this.history?.renderDocument.layers??[];let layer=layers.find(l=>l.id===id);const seen=new Set<string>();
    while(layer){if(layer.locked||!layer.visible||seen.has(layer.id))return false;seen.add(layer.id);layer=layers.find(l=>l.id===layer!.parentId);}
    return true;
  }
  private selectionContains(region: BoardSelectionRegion, point: BoardPoint): boolean {
    return region.kind === "polygon" ? pointInPolygon(point, region.points) : pointInRect(point, region.bounds);
  }
  private clipSelection(context: CanvasRenderingContext2D, region: BoardSelectionRegion): void {
    context.beginPath();
    if (region.kind === "polygon" && region.points.length) {
      context.moveTo(region.points[0]!.x, region.points[0]!.y);
      for (const point of region.points.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
    } else context.rect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
    context.clip();
  }
  private primarySelection(): string | null { return this.selectedIds.values().next().value ?? null; }
  private selectedBounds(objects = this.history?.renderDocument.objects ?? []): ReturnType<typeof selectionBounds> {
    return selectionBounds(objects, this.selectedIds);
  }
  private selectObject(object: BoardObject | undefined, additive: boolean): void {
    if (!object) { if (!additive) this.selectedIds.clear(); return; }
    const group = object.selectionGroupId;
    const ids = group && this.history
      ? this.history.renderDocument.objects.filter(item => item.selectionGroupId === group && this.layerEditable(item.layerId)).map(item => item.id)
      : [object.id];
    if (!additive) this.selectedIds.clear();
    for (const id of ids) additive && this.selectedIds.has(id) ? this.selectedIds.delete(id) : this.selectedIds.add(id);
  }
  private hit(point: BoardPoint): BoardObject | undefined {
    const document = this.history?.renderDocument;
    if (!document) return;
    this.spatial.rebuild(document.objects, String(document.revision), this.bundle?.ink);
    return this.spatial.hit(anchor, point, 8 / this.zoom).find(object=>this.layerEditable(object.layerId));
  }
  private schedule(): void {
    if (this.closed || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; if(!this.closed)this.draw(); });
  }
  private queueCameraRefine(delay = 120): void {
    if (this.cameraPreviewTimer) clearTimeout(this.cameraPreviewTimer);
    this.cameraPreviewTimer = window.setTimeout(() => {
      this.cameraPreviewTimer = 0;
      if (this.closed) return;
      if (this.gesture?.mode === "pan" || this.pinch || (this.staticCanvas?.style.transform && this.gesture?.mode === "pen")) {
        this.queueCameraRefine(120);
        return;
      }
      this.staticRenderKey = "";
      this.schedule();
    }, delay);
  }
  private stopCameraPreview(): void {
    if (this.cameraPreviewTimer) clearTimeout(this.cameraPreviewTimer);
    this.cameraPreviewTimer = 0;
    if (this.staticCanvas) this.staticCanvas.style.transform = "";
    if (this.progressCanvas) this.progressCanvas.style.transform = "";
  }
  private cancelProgressiveRender(): void {
    this.progressiveGeneration++;
    this.outlinePreparation?.cancel();
    if (this.progressiveFrame) cancelAnimationFrame(this.progressiveFrame);
    this.progressiveFrame = 0;
    this.progressiveKey = "";
  }
  private beginProgressiveRender(
    key: string, document: BoardBundle["document"], objects: BoardObject[],
    transform: (context: CanvasRenderingContext2D) => void,
  ): boolean {
    if (!this.progressiveRenderEnabled || !this.staticCanvas || !this.progressCanvas || !this.bundle) return false;
    const plan = planProgressiveScene(document, objects);
    if (!plan) return false;
    const output = this.staticCanvas.getContext("2d"), preview = this.progressCanvas.getContext("2d");
    if (!output || !preview) return false;
    const generation = ++this.progressiveGeneration;
    this.progressiveKey = key;
    const started = performance.now();
    let layerIndex = 0, objectIndex = 0, steps = 0, maxStepMs = 0;
    let batchEnd = 0, preparationMs = 0, workerBatches = 0, maxGapMs = 0, lastStepEnd = started;
    let prepared: ReadonlyMap<string, Float64Array> | undefined;
    const geometry = this.outlinePreparation ??= new BoardOutlinePreparation(
      (this.contentEl.ownerDocument.defaultView ?? globalThis) as Window & typeof globalThis);
    const plain = plan.map(({layer}) => ({...layer, opacity: 1, blendMode: "normal" as const}));
    const options = {ink: this.bundle.ink, characters: this.profiles, resolveAsset: this.resolveImage,
      layers: plain, vectorAssets: document.vectorAssets, brushResources: this.brushImages,
      missingBrushResource: this.reportMissingBrushResource};
    const draft = this.draftObjects, draftRevision = this.draftRenderRevision;
    const valid = () => !this.closed && generation === this.progressiveGeneration && key === this.staticRenderKey &&
      this.history?.renderDocument === document && this.draftObjects === draft && this.draftRenderRevision === draftRevision &&
      !!this.progressCanvas?.isConnected;
    const clearPreview = () => { preview.setTransform(1, 0, 0, 1, 0, 0); preview.clearRect(0, 0, this.progressCanvas!.width, this.progressCanvas!.height); };
    clearPreview();
    const prepareBatch = async (batch: BoardObject[], end: number) => {
      const begin = performance.now();
      let outlines: ReadonlyMap<string, Float64Array> | null = null;
      try { outlines = await geometry.prepare(batch, options.ink); }
      catch { geometry.dispose(); }
      if (!valid()) return;
      preparationMs += performance.now() - begin;
      if (outlines?.size) workerBatches++;
      prepared = outlines ?? undefined; batchEnd = end;
      // A worker reply is already an event-loop yield. Keep painting responsive
      // without adding one display-frame wait for every prepared batch.
      step();
    };
    const step = () => {
      this.progressiveFrame = 0;
      if (!valid()) return;
      const stepStart = performance.now();
      maxGapMs = Math.max(maxGapMs, stepStart - lastStepEnd);
      let drawn = 0, waiting = false;
      while (layerIndex < plan.length) {
        const current = plan[layerIndex]!;
        if (objectIndex < current.objects.length) {
          if (objectIndex >= batchEnd) {
            const end = Math.min(objectIndex + 128, current.objects.length);
            const batch = current.objects.slice(objectIndex, end);
            if (geometry.available && batch.some(object => canPreparePressureOutline(object, options.ink))) {
              waiting = true; void prepareBatch(batch, end); break;
            }
            prepared = undefined; batchEnd = end;
          }
          transform(preview);
          renderBoardCanvas(preview, [current.objects[objectIndex++]!], {...options, pressureOutlines: prepared});
          drawn++;
          if (performance.now() - stepStart >= 8 && drawn > 0) break;
          continue;
        }
        output.save(); output.setTransform(1, 0, 0, 1, 0, 0);
        output.globalCompositeOperation = "source-over"; output.globalAlpha = 1;
        output.drawImage(this.progressCanvas!, 0, 0); output.restore();
        clearPreview();
        layerIndex++; objectIndex = 0; batchEnd = 0; prepared = undefined;
        if (performance.now() - stepStart >= 8 && drawn > 0) break;
      }
      lastStepEnd = performance.now();
      steps++; maxStepMs = Math.max(maxStepMs, lastStepEnd - stepStart);
      if (waiting) return;
      if (layerIndex < plan.length) this.progressiveFrame = requestAnimationFrame(step);
      else {
        this.progressiveKey = "";
        this.lastProgressiveRender = {durationMs: performance.now() - started, maxStepMs, steps, objects: objects.length,
          preparationMs, workerBatches, maxGapMs};
      }
    };
    this.progressiveFrame = requestAnimationFrame(step);
    return true;
  }
  private draft(): { object: BoardObject; inkId: string } | null {
    const gesture = this.gesture;
    if (!gesture || (gesture.mode !== "pen"&&gesture.mode!=="erase") || !gesture.points.length) return null;
    const bounds = pointBounds(gesture.points);
    const inkId = "INK-draft";
    return { inkId, object: {
      id: "OBJ-draft", kind: "ink", anchor, ...bounds, color: this.color, strokeWidth: this.width,
      brush: gesture.mode==="erase"?defaultBoardBrush("pen",gesture.seed):{ ...copy(this.brush), seed: gesture.seed }, layerId: this.activeLayerId, inkId,
      createdBy: "human", editedBy: "human", revision: 1, groupId: "GROUP-draft",
    } };
  }
  private draw(): void {
    const document = this.history?.renderDocument;
    const welcome = this.contentEl.querySelector<HTMLElement>(".atl-studio-welcome");
    if (welcome) welcome.hidden = !!(document?.objects.length || document?.paintOperations?.length);
    const started=performance.now();
    const canvas = this.canvas, staticCanvas = this.staticCanvas;
    if (!canvas || !staticCanvas || !document || !this.bundle) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = this.contentEl.ownerDocument.defaultView?.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; this.staticRenderKey = ""; }
    if (staticCanvas.width !== width || staticCanvas.height !== height) { staticCanvas.width = width; staticCanvas.height = height; this.staticRenderKey = ""; }
    const viewport = {
      x: -this.pan.x / this.zoom, y: -this.pan.y / this.zoom,
      width: rect.width / this.zoom, height: rect.height / this.zoom,
    };
    this.visiblePaintViewport=viewport;
    const sourceObjects = this.draftObjects ?? document.objects;
    const key = JSON.stringify([document.revision, width, height, ratio, this.pan.x, this.pan.y, this.zoom, this.canvasRotation, this.mirrorPreview,
      this.draftObjects ? this.gesture?.lastClient.x : null, this.draftObjects ? this.gesture?.lastClient.y : null,
      this.draftObjects ? this.draftRenderRevision : null]);
    const applyWorldTransform = (context: CanvasRenderingContext2D) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.translate(rect.width / 2, rect.height / 2);
      context.rotate(this.canvasRotation);
      context.scale(this.mirrorPreview ? -1 : 1, 1);
      context.translate(-rect.width / 2, -rect.height / 2);
      context.translate(this.pan.x, this.pan.y);
      context.scale(this.zoom, this.zoom);
    };
    const cold=key!==this.staticRenderKey;
    const rendered=this.renderedCamera;
    const activeLayer=document.layers?.find(layer=>layer.id===this.activeLayerId);
    const directPenPreview=this.gesture?.mode==="pen" &&
      canPreviewOnStaticScene(document.layers??[],this.activeLayerId) &&
      activeLayer?.kind!=="paint" && ["pen","fountain","crayon","oil"].includes(this.brush.kind);
    const cameraPreview = cold && !!this.cameraPreviewTimer && (!this.gesture || this.gesture.mode === "pan" || directPenPreview) &&
      !!rendered && rendered.key === this.staticRenderKey && rendered.revision === document.revision &&
      rendered.width === width && rendered.height === height && rendered.ratio === ratio && rendered.objects === this.draftObjects &&
      boardCameraPreviewTransform(rendered, { pan: this.pan, zoom: this.zoom, rotation: this.canvasRotation, mirrored: this.mirrorPreview, center: rendered.center });
    if (cameraPreview) {
      if (this.progressiveKey) this.cancelProgressiveRender();
      // Moving a cached viewport is a compositor operation. The expensive scene
      // redraw happens only after camera input settles, not on every pointermove.
      staticCanvas.style.transformOrigin = "0 0";
      staticCanvas.style.transform = cameraPreview;
      if (this.progressCanvas) { this.progressCanvas.style.transformOrigin = "0 0"; this.progressCanvas.style.transform = cameraPreview; }
    } else if (cold) {
      this.cancelProgressiveRender();
      staticCanvas.style.transform = "";
      if (this.progressCanvas) {
        this.progressCanvas.style.transform = "";
        if (this.progressCanvas.width !== width || this.progressCanvas.height !== height) {
          this.progressCanvas.width = width; this.progressCanvas.height = height;
        } else {
          const progress = this.progressCanvas.getContext("2d");
          progress?.setTransform(1, 0, 0, 1, 0, 0); progress?.clearRect(0, 0, width, height);
        }
      }
      void this.restorePaintTiles(viewport);
      this.staticRenderKey = key;
      const context = staticCanvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      // The Artboard is an export boundary, not the only drawable part of Studio.
      // Keep the entire viewport visibly usable while letting the boundary read as a sheet.
      context.fillStyle = "#f4f3f7"; context.fillRect(0, 0, rect.width, rect.height);
      const grid = Math.max(24, 64 * this.zoom * Math.pow(2, Math.max(0, Math.ceil(Math.log2(24 / (64 * this.zoom))))));
      context.fillStyle = "#d9d5e2";
      for (let x = ((this.pan.x % grid) + grid) % grid; x < rect.width; x += grid)
        for (let y = ((this.pan.y % grid) + grid) % grid; y < rect.height; y += grid)
          context.fillRect(Math.round(x), Math.round(y), 1, 1);
      applyWorldTransform(context);
      const artboards = document.artboards ?? [];
      if (artboards.length) {
        for (const artboard of artboards) {
          context.save();
          context.shadowColor = "#00000038"; context.shadowBlur = 18 / this.zoom; context.shadowOffsetY = 5 / this.zoom;
          context.fillStyle = artboard.background; context.fillRect(artboard.x, artboard.y, artboard.width, artboard.height);
          context.restore();
          context.save(); context.beginPath(); context.rect(artboard.x, artboard.y, artboard.width, artboard.height); context.clip();
          renderBoardBackgroundCanvas(context, document.background ?? { kind: "plain", color: artboard.background, spacing: 24, opacity: 1 }, artboard);
          context.restore();
        }
      } else renderBoardBackgroundCanvas(context, document.background ?? { kind: "plain", color: "#ffffff", spacing: 24, opacity: 1 }, viewport);
      const background=this.backgroundCanvas??(this.backgroundCanvas=this.contentEl.ownerDocument.createElement("canvas"));background.width=width;background.height=height;background.getContext("2d")!.drawImage(staticCanvas,0,0);
      this.spatial.rebuild(sourceObjects, this.draftObjects ? key : String(document.revision), this.bundle.ink);
      const objects = this.visibleObjects = this.spatial.search(anchor, viewport, 80 / this.zoom);
      if (!this.beginProgressiveRender(key, document, objects, applyWorldTransform)) this.renderLayeredScene(context,document,objects);
      this.drawMinimap(sourceObjects, viewport);
      this.renderedCamera={key,revision:document.revision,width,height,ratio,pan:{...this.pan},zoom:this.zoom,rotation:this.canvasRotation,mirrored:this.mirrorPreview,center:{x:rect.width/2,y:rect.height/2},objects:this.draftObjects};
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    applyWorldTransform(context);
    const draft = this.draft();
    if (draft && this.backgroundCanvas) {
      const layer=document.layers?.find(l=>l.id===this.activeLayerId);
      const drawDraft=(target:CanvasRenderingContext2D)=>{
        // A paint selection clips raster strokes; vector ink must preview exactly as it commits.
        if(layer?.kind === "paint" && this.paintSelection)this.clipSelection(target,this.paintSelection);
        target.globalCompositeOperation=this.gesture!.mode==="erase"?"destination-out":layer?.alphaLocked?"source-atop":"source-over";
        if(!this.livePainter.render(target,this.gesture!.points,draft.object.brush!,this.width,this.color,this.brushImages)){
          const ink = { [draft.inkId]: {id:draft.inkId,createdAt:"",points:this.gesture!.points.map(point=>({...point,x:point.x-draft.object.x,y:point.y-draft.object.y}))} };
          const stroke=this.draftCanvas??(this.draftCanvas=this.contentEl.ownerDocument.createElement("canvas"));if(stroke.width!==width||stroke.height!==height){stroke.width=width;stroke.height=height;}
          const paint=stroke.getContext("2d")!;paint.setTransform(1,0,0,1,0,0);paint.clearRect(0,0,width,height);paint.setTransform(target.getTransform());
          renderBoardCanvas(paint,[draft.object],{ink,characters:this.profiles,resolveAsset:this.resolveImage,layers:document.layers?.map(l=>({...l,opacity:1,blendMode:"normal"})),vectorAssets:document.vectorAssets,brushResources:this.brushImages,missingBrushResource:this.reportMissingBrushResource});
          target.save();target.setTransform(1,0,0,1,0,0);target.drawImage(stroke,0,0);target.restore();
        }
      };
      const direct = canPreviewOnStaticScene(document.layers??[],this.activeLayerId,this.gesture?.mode==="erase") &&
        (layer?.kind==="paint" || ["pen","fountain","crayon","oil"].includes(draft.object.brush!.kind));
      if(direct){
        // The static canvas already contains every committed stroke. For the common
        // top-layer case, only paint the live stroke; cost no longer grows with the
        // number of existing layers or objects.
        context.save();drawDraft(context);context.restore();
      }else{
        // Isolated composition is still required for erasing, alpha lock, clipping,
        // multiply brushes and strokes below other layers.
        const padding=Math.max(4,this.width*3),clip={x:draft.object.x-padding,y:draft.object.y-padding,width:draft.object.width+padding*2,height:draft.object.height+padding*2};
        context.save();context.beginPath();context.rect(clip.x,clip.y,clip.width,clip.height);context.clip();
        context.save();context.setTransform(1,0,0,1,0,0);context.drawImage(this.backgroundCanvas,0,0);context.restore();
        this.renderLayeredScene(context,document,this.visibleObjects,undefined,{layerId:this.activeLayerId,clip,draw:drawDraft});
        context.restore();
      }
    }
    const lasso=this.gesture?.mode==="lasso"?this.gesture.points:undefined,region=this.paintSelection;
    if(lasso?.length||region){context.save();context.strokeStyle="#7663bd";context.lineWidth=1/this.zoom;context.setLineDash([5/this.zoom,4/this.zoom]);context.beginPath();const points=lasso?.length?lasso:region?.kind==="polygon"?region.points:undefined;if(points?.length){context.moveTo(points[0]!.x,points[0]!.y);for(const point of points.slice(1))context.lineTo(point.x,point.y);if(!lasso)context.closePath();context.stroke();}else if(region)context.strokeRect(region.bounds.x,region.bounds.y,region.bounds.width,region.bounds.height);context.restore();}
    const box=selectionBounds(sourceObjects,this.selectedIds);
    if (box) {
      context.save();
      context.strokeStyle = "#7663bd";
      context.lineWidth = 1 / this.zoom;
      context.setLineDash([5 / this.zoom, 4 / this.zoom]);
      context.strokeRect(box.x - 4 / this.zoom, box.y - 4 / this.zoom, box.width + 8 / this.zoom, box.height + 8 / this.zoom);
      context.setLineDash([]);context.fillStyle="#ffffff";context.strokeStyle="#7663bd";
      const radius=4/this.zoom,cx=box.x+box.width/2,cy=box.y+box.height/2,right=box.x+box.width,bottom=box.y+box.height;
      for(const point of [{x:box.x,y:box.y},{x:cx,y:box.y},{x:right,y:box.y},{x:right,y:cy},{x:right,y:bottom},{x:cx,y:bottom},{x:box.x,y:bottom},{x:box.x,y:cy}]){context.beginPath();context.arc(point.x,point.y,radius,0,Math.PI*2);context.fill();context.stroke();}
      context.beginPath();context.moveTo(cx,box.y);context.lineTo(cx,box.y-radius*3);context.stroke();context.beginPath();context.arc(cx,box.y-radius*3,radius,0,Math.PI*2);context.fill();context.stroke();
      context.restore();
    }
    const zoomLabel = this.contentEl.querySelector<HTMLElement>("[data-zoom]");
    if (zoomLabel) zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.renderMetrics.record(performance.now()-started,cold&&!cameraPreview);
  }
  private async restorePaintTiles(viewport:{x:number;y:number;width:number;height:number}):Promise<void>{
    if(this.closed||this.transitions||!this.checkpointService||!this.history)return;
    const history=this.history,service=this.checkpointService,generation=this.loadGeneration;
    const document=history.renderDocument,keys=affectedBoardTiles(viewport).sort().join(","),restoreKey=`${document.tileManifest?.checkpointRevision??0}:${keys}`;
    const current=()=>!this.closed&&!this.transitions&&this.loadGeneration===generation&&this.history===history&&this.checkpointService===service&&history.renderDocument===document&&this.tileRestoreKey===restoreKey;
    if(restoreKey===this.tileRestoreKey)return;this.tileRestoreKey=restoreKey;
    const layers=new Set((document.layers??[]).filter(layer=>layer.kind==="paint"&&layer.visible).map(layer=>layer.id));
    let restored:RestoredBoardTile[];
    try { restored=await service.restoreVisible(document.tileManifest,layers,viewport); }
    catch { if(current())this.tileRestoreKey=""; return; }
    if(!current())return;
    let changed=false;
    const currentPaths=new Set(document.tileManifest?.tiles.map(tile=>tile.path)??[]);
    for(const [path,item] of this.restoredTiles)if(!currentPaths.has(path)){item.canvas.width=0;item.canvas.height=0;this.restoredTiles.delete(path);changed=true;}
    for(const tile of restored){
      if(this.restoredTiles.has(tile.ref.path))continue;
      const canvas=this.contentEl.ownerDocument.createElement("canvas");canvas.width=tile.width;canvas.height=tile.height;
      const context=canvas.getContext("2d");if(!context)continue;
      const image=context.createImageData(tile.width,tile.height);image.data.set(tile.pixels);context.putImageData(image,0,0);
      this.restoredTiles.set(tile.ref.path,{tile,canvas});changed=true;
    }
    if(changed){this.layerRenderer.clear();this.staticRenderKey="";this.schedule();}
  }
  private async maybeCheckpointPaintLayer(layerId:string,force=false):Promise<void>{
    if(this.closed||this.transitions||!this.checkpointService||!this.history||!this.bundle)return;
    const history=this.history,bundle=this.bundle,service=this.checkpointService,generation=this.loadGeneration,snapshot=history.renderDocument;
    const current=()=>!this.closed&&!this.transitions&&this.loadGeneration===generation&&this.history===history&&this.bundle===bundle&&this.checkpointService===service&&history.renderDocument===snapshot;
    const document=history.document;
    try{
      const manifest=await service.checkpoint({boardId:document.id,layerId,operations:document.paintOperations??[],manifest:document.tileManifest,force,render:({bounds,revision:limit})=>{
        if(!current())throw new Error("studio-checkpoint-stale");
        const side=512+(document.tileManifest?.gutter??2)*2,canvas=this.contentEl.ownerDocument.createElement("canvas");canvas.width=canvas.height=side;
        const context=canvas.getContext("2d",{willReadFrequently:true});if(!context)throw new Error("tile-canvas-unavailable");
        context.translate(-bounds.x,-bounds.y);context.beginPath();context.rect(bounds.x,bounds.y,bounds.width,bounds.height);context.clip();
        this.drawPaintOperations(context,document,new Set([layerId]),limit,true);
        context.setTransform(1,0,0,1,0,0);const pixels=context.getImageData(0,0,side,side).data;canvas.width=0;canvas.height=0;return pixels;
      }});
      if(!current())return;
      if(history.updateTileManifest(manifest)){bundle.document=history.document;this.tileRestoreKey="";this.commit();}
    }catch(error){if(current()&&this.statusEl)this.statusEl.textContent=`瓦片检查点待重建 · ${error instanceof Error?error.message:String(error)}`;}
  }
  private renderLayeredScene(context:CanvasRenderingContext2D,document:BoardBundle["document"],objects:BoardObject[],only?:ReadonlySet<string>,overlay?:{layerId:string;clip?:{x:number;y:number;width:number;height:number};draw:(context:CanvasRenderingContext2D)=>void}):void{
    const layers=document.layers?.length?document.layers:[{id:"layer-default",name:"Default",order:0,visible:true,locked:false,opacity:1,blendMode:"normal" as const}];
    const plain=layers.map(layer=>({...layer,opacity:1,blendMode:"normal" as const}));
    const useViewportCache=objects===this.visibleObjects;
    if(!useViewportCache||this.layerFingerprintKey!==this.staticRenderKey){
      const byLayer=new Map<string,BoardObject[]>();
      for(const object of objects){const layerId=object.layerId??layers[0]!.id,items=byLayer.get(layerId)??[];items.push(object);byLayer.set(layerId,items);}
      const operations=new Map<string,NonNullable<typeof document.paintOperations>>();
      for(const operation of document.paintOperations??[]){const items=operations.get(operation.layerId)??[];items.push(operation);operations.set(operation.layerId,items);}
      const assets=new Map(document.vectorAssets?.map(asset=>[asset.id,asset])??[]);
      const fingerprints=new Map<string,string>();
      for(const layer of layers){
        const contents=byLayer.get(layer.id)??[];
        const referencedAssets=contents.map(object=>object.vectorAssetId?assets.get(object.vectorAssetId):undefined).filter(Boolean);
        fingerprints.set(layer.id,JSON.stringify([this.sourceFile,contents,operations.get(layer.id)??[],referencedAssets]));
      }
      this.layerFingerprints=fingerprints;
      this.layerFingerprintKey=useViewportCache?this.staticRenderKey:"";
    }
    const byLayer=new Map<string,BoardObject[]>();
    for(const object of objects){const layerId=object.layerId??layers[0]!.id,items=byLayer.get(layerId)??[];items.push(object);byLayer.set(layerId,items);}
    const paintLayerIds=new Set((document.paintOperations??[]).map(operation=>operation.layerId));
    this.layerRenderer.render(context,layers,layer=>this.layerFingerprints.get(layer.id)??"",(target,layer)=>{
      this.drawPaintOperations(target,document,new Set([layer.id]));
      renderBoardCanvas(target,byLayer.get(layer.id)??[],{ink:this.bundle!.ink,characters:this.profiles,resolveAsset:this.resolveImage,requestRender:()=>{this.layerRenderer.clear();this.staticRenderKey="";this.schedule();},layers:plain,vectorAssets:document.vectorAssets,brushResources:this.brushImages,missingBrushResource:this.reportMissingBrushResource});
    },only,overlay,layer=>!paintLayerIds.has(layer.id) && (byLayer.get(layer.id)??[]).every(object=>
      !["character","sticker","vector"].includes(object.kind) &&
      object.fill?.kind !== "brush" &&
      (object.blendMode ?? (object.brush ? brushComposite(object.brush.kind) : "normal")) === "normal"));
  }
  private drawPaintOperations(context: CanvasRenderingContext2D, document: BoardBundle["document"], onlyLayers?: ReadonlySet<string>, maxRevision=Infinity, bypassCheckpoints=false): void {
    if (!this.bundle) return;
    const layers = new Map((document.layers ?? []).map(layer => [layer.id, layer]));
    const covered=new Map<string,number>();
    if(!bypassCheckpoints&&onlyLayers?.size===1){
      const layerId=[...onlyLayers][0]!,currentPaths=new Set(document.tileManifest?.tiles.map(tile=>tile.path)??[]),tiles=[...this.restoredTiles.values()].filter(item=>item.tile.ref.layerId===layerId&&currentPaths.has(item.tile.ref.path));
      if(tiles.length)for(const {tile,canvas} of tiles){const gutter=document.tileManifest?.gutter??2,key=`${tile.ref.x}:${tile.ref.y}`;covered.set(key,tile.ref.operationToRevision??tile.ref.revision);context.drawImage(canvas,tile.ref.x*512-gutter,tile.ref.y*512-gutter);}
    }
    const ordered = [...(document.paintOperations ?? [])].sort((a, b) => {
      const layerOrder = (layers.get(a.layerId)?.order ?? 0) - (layers.get(b.layerId)?.order ?? 0);
      return layerOrder || a.revision - b.revision;
    });
    for (const operation of ordered) {
      if(operation.revision>maxRevision)continue;
      const layer = layers.get(operation.layerId);
      if (!layer?.visible || (onlyLayers && !onlyLayers.has(layer.id))) continue;
      if(covered.size&&this.visiblePaintViewport){
        const view=this.visiblePaintViewport,area={x:Math.max(view.x,operation.bounds.x),y:Math.max(view.y,operation.bounds.y),width:Math.min(view.x+view.width,operation.bounds.x+operation.bounds.width)-Math.max(view.x,operation.bounds.x),height:Math.min(view.y+view.height,operation.bounds.y+operation.bounds.height)-Math.max(view.y,operation.bounds.y)};
        if(area.width>0&&area.height>0&&affectedBoardTiles(area).every(key=>(covered.get(key)??-1)>=operation.revision))continue;
      }
      context.save();
      context.globalAlpha *= operation.opacity;
      context.globalCompositeOperation = operation.type === "erase" ? "destination-out" : operation.alphaLocked ? "source-atop" : "source-over";
      if(operation.selection)this.clipSelection(context,operation.selection);
      else if(operation.clipRect){const r=operation.clipRect;context.beginPath();context.rect(r.x,r.y,r.width,r.height);context.clip();}
      if ((operation.type === "stroke" || operation.type === "erase") && operation.inkId && operation.brush) {
        const stroke = this.bundle.ink[operation.inkId];
        if (stroke) {
          context.translate(operation.bounds.x, operation.bounds.y);
          const style={...operation.brush,opacity:1};
          if(missingBrushResources(style,this.brushImages).length)missingBrushResources(style,this.brushImages).forEach(this.reportMissingBrushResource);
          else brushEngineFor(style).render(context,stroke.points,style,operation.strokeWidth??1,operation.color,this.brushImages,operation.bounds);
        }
      } else if (operation.type === "gradient" && operation.gradient) {
        const gradient = operation.gradient.kind === "linear"
          ? context.createLinearGradient(operation.gradient.from.x, operation.gradient.from.y, operation.gradient.to.x, operation.gradient.to.y)
          : context.createRadialGradient(operation.gradient.from.x, operation.gradient.from.y, 0, operation.gradient.from.x, operation.gradient.from.y, Math.hypot(operation.gradient.to.x - operation.gradient.from.x, operation.gradient.to.y - operation.gradient.from.y));
        gradient.addColorStop(0, operation.color); gradient.addColorStop(1, operation.gradient.endColor);
        context.fillStyle = gradient; context.fillRect(operation.bounds.x, operation.bounds.y, operation.bounds.width, operation.bounds.height);
      } else if (operation.type === "fill" && operation.maskAssetHash && operation.maskWidth && operation.maskHeight) {
        const compressed = this.paintAssets.get(operation.maskAssetHash);
        if (compressed) {
          const cacheKey = `${operation.maskAssetHash}:${operation.color}`;
          let maskCanvas = this.fillCanvases.get(cacheKey);
          if (!maskCanvas) {
            try {
              const mask = inflateSync(compressed);
              if (mask.byteLength !== operation.maskWidth * operation.maskHeight) throw new Error("Fill mask dimensions do not match its payload");
              maskCanvas = this.contentEl.ownerDocument.createElement("canvas");
              maskCanvas.width = operation.maskWidth; maskCanvas.height = operation.maskHeight;
              const maskContext = maskCanvas.getContext("2d");
              if (!maskContext) throw new Error("Canvas 2D is unavailable");
              const image = maskContext.createImageData(maskCanvas.width, maskCanvas.height);
              for (let index = 0; index < mask.length; index++) {
                const offset = index * 4;
                image.data[offset] = 255; image.data[offset + 1] = 255; image.data[offset + 2] = 255; image.data[offset + 3] = mask[index]!;
              }
              maskContext.putImageData(image, 0, 0);
              maskContext.globalCompositeOperation = "source-in";
              maskContext.fillStyle = operation.color;
              maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
              this.fillCanvases.set(cacheKey, maskCanvas);
            } catch {
              maskCanvas = undefined;
            }
          }
          if (maskCanvas) context.drawImage(maskCanvas, operation.bounds.x, operation.bounds.y, operation.bounds.width, operation.bounds.height);
        }
      }
      context.restore();
    }
  }
  private activeArtboard() {
    return this.history?.renderDocument.artboards?.find(item => item.id === this.activeArtboardId)
      ?? this.history?.renderDocument.artboards?.[0]
      ?? { id: "artboard-main", name: "Artwork", x: 0, y: 0, width: 1920, height: 1080, dpi: 144, background: "#ffffff", exportPreset: "screen" as const };
  }
  private fitArtboard(): void {
    const artboard = this.activeArtboard(), canvas = this.canvas;
    if (!artboard || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 160) return;
    this.zoom = Math.max(0.05, Math.min(4, Math.min((rect.width - 100) / artboard.width, (rect.height - 100) / artboard.height)));
    this.pan = { x: (rect.width - artboard.width * this.zoom) / 2 - artboard.x * this.zoom, y: (rect.height - artboard.height * this.zoom) / 2 - artboard.y * this.zoom };
    this.pendingInitialFit = false;
    this.schedule();
  }
  private renderArtboardCanvas(layerIds?: ReadonlySet<string>, includeBackground = true, artboardOverride?: ReturnType<StandaloneBoardView["activeArtboard"]>): HTMLCanvasElement {
    const artboard = artboardOverride ?? this.activeArtboard(), document = this.history!.document;
    const scale = 1;
    const canvas = this.contentEl.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.round(artboard.width * scale)); canvas.height = Math.max(1, Math.round(artboard.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    context.scale(scale, scale); context.translate(-artboard.x, -artboard.y);
    if (includeBackground) {
      context.fillStyle = artboard.background; context.fillRect(artboard.x, artboard.y, artboard.width, artboard.height);
      renderBoardBackgroundCanvas(context, document.background ?? { kind: "plain", color: artboard.background, spacing: 24, opacity: 1 }, artboard);
    }
    const objects = document.objects;
    this.renderLayeredScene(context,document,objects,layerIds);
    return canvas;
  }
  private canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode artwork")), type, quality));
  }
  private async writeArtwork(extension: string, data: string | Uint8Array): Promise<string> {
    const name = (this.sourceFile.split("/").pop() ?? "Tutor-Artwork").replace(/\.(?:tutorboard\.)?md$/i, "").replace(/[^\p{L}\p{N}._-]+/gu, "-") || "Tutor-Artwork";
    const folder = this.sourceFile.includes("/") ? this.sourceFile.slice(0, this.sourceFile.lastIndexOf("/") + 1) : "";
    const path = `${folder}${name}.${extension}`;
    const payload = typeof data === "string" ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (this.host.writeExport) await this.host.writeExport(path, payload);
    else {
      const blob = new Blob([payload]); const url = URL.createObjectURL(blob); const link = this.contentEl.ownerDocument.createElement("a");
      link.href = url; link.download = path.split("/").pop()!; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return path;
  }
  private async prepareImages(): Promise<void> {
    if (!this.history) return;
    const history=this.history,generation=this.loadGeneration,source=this.sourceFile,revision=history.revision;
    const assertCurrent=()=>{if(this.closed||generation!==this.loadGeneration||this.history!==history||source!==this.sourceFile||revision!==history.revision)throw new Error("studio-revision-conflict");};
    await this.loadBrushResources();
    assertCurrent();
    const references = new Set(history.renderDocument.objects.map(object => `${object.assetId ?? object.characterId}:${object.assetVersion ?? object.characterVersion}`));
    const profiles = this.profiles.filter(profile => references.has(`${profile.id}:${profile.version}`));
    for (const profile of profiles) {
      if (!profile.assetPath || this.embeddedImages.has(profile.assetPath)) continue;
      if (!this.host.readAsset) throw new Error("image-export-unavailable");
      const bytes = new Uint8Array(await this.host.readAsset(profile.assetPath));
      assertCurrent();
      if (bytes.length > 25 * 1024 * 1024) throw new Error("image-too-large");
      let binary = ""; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      const mime = profile.assetPath.toLowerCase().endsWith(".webp") ? "image/webp" : /\.jpe?g$/i.test(profile.assetPath) ? "image/jpeg" : "image/png";
      this.embeddedImages.set(profile.assetPath, `data:${mime};base64,${btoa(binary)}`); this.imageBytes.set(profile.assetPath, bytes);
    }
    const context = this.contentEl.ownerDocument.createElement("canvas").getContext("2d");
    if (context) await prepareBoardImages(context, profiles.flatMap(profile => profile.assetPath ? [this.resolveImage(profile.assetPath)] : []));
    assertCurrent();
  }
  private async exportArtwork(format: "png" | "jpeg" | "webp" | "svg" | "pdf" | "ora" | "tutorboard" | "gallery"): Promise<string> {
    if (!this.bundle || !this.history) throw new Error("Board is not ready");
    await this.prepareImages();
    const artboard = this.activeArtboard(), canvas = this.renderArtboardCanvas();
    let data: string | Uint8Array;
    if (format === "gallery") {
      const preview = new Uint8Array(await (await this.canvasBlob(canvas, "image/png")).arrayBuffer());
      const editable = await buildTutorBoardArchive({ document: this.history.document, ink: this.bundle.ink, previewPng: preview, paintAssets: this.paintAssets, brushAssets:this.brushBytes, profiles: this.profiles, imageAssets: this.imageBytes, includeHidden: true, includePrivateMetadata: false });
      const previewPath = await this.writeArtwork("png", preview), sourcePath = await this.writeArtwork("tutorboard", editable);
      const title = this.sourceFile.split("/").pop()?.replace(/\.(?:tutorboard\.)?md$/i, "") || "Tutor Artwork";
      const path = await this.writeArtwork("gallery.md", boardGalleryMarkdown({ title, previewPath: previewPath.split("/").pop()!, sourcePath: sourcePath.split("/").pop()! }));
      new Notice(`已生成 Obsidian 画廊笔记：${path}`);
      return path;
    } else if (format === "svg") {
      const paintLayers = new Set((this.history.document.layers ?? []).filter(layer => layer.kind === "paint" && layer.visible).map(layer => layer.id));
      const paintCanvas = this.renderArtboardCanvas(paintLayers, false);
      const paintUrl = this.history.document.paintOperations?.some(operation => paintLayers.has(operation.layerId)) ? paintCanvas.toDataURL("image/png") : undefined;
      data = renderBoardSvg(this.history.document.objects, { width: artboard.width, height: artboard.height, viewport: artboard, ink: this.bundle.ink, characters: this.profiles, resolveAsset: this.resolveImage, requestRender: () => { this.staticRenderKey = ""; this.schedule(); }, layers: this.history.document.layers, background: this.history.document.background, vectorAssets: this.history.document.vectorAssets, brushResources:this.brushImages,missingBrushResource:this.reportMissingBrushResource, ...(paintUrl ? { rasterUnderlay: { url: paintUrl, x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height } } : {}) });
    } else if (format === "pdf") {
      const pages = (this.history.document.artboards?.length ? this.history.document.artboards : [artboard]).map(item => {
        const page = this.renderArtboardCanvas(undefined, true, item);
        return { base64: page.toDataURL("image/jpeg", 0.94).split(",")[1]!, width: page.width, height: page.height };
      });
      data = jpegPagesToPdf(pages);
    } else if (format === "ora") {
      const merged = new Uint8Array(await (await this.canvasBlob(canvas, "image/png")).arrayBuffer());
      const drawableLayers = [...(this.history.document.layers ?? [])].filter(layer => layer.kind !== "group");
      const layers = await Promise.all(drawableLayers.map(async layer => ({
        name: layer.name, opacity: layer.opacity, visible: layer.visible, blendMode: layer.blendMode,
        png: new Uint8Array(await (await this.canvasBlob(this.renderArtboardCanvas(new Set([layer.id]), false), "image/png")).arrayBuffer()),
      })));
      data = buildOpenRasterArchive({ width: canvas.width, height: canvas.height, layers, mergedPng: merged });
    } else if (format === "tutorboard") {
      const previewPng = new Uint8Array(await (await this.canvasBlob(canvas, "image/png")).arrayBuffer());
      data = await buildTutorBoardArchive({ document: this.history.document, ink: this.bundle.ink, previewPng, paintAssets: this.paintAssets, brushAssets:this.brushBytes, profiles: this.profiles, imageAssets: this.imageBytes, includeHidden: true, includePrivateMetadata: false });
    } else {
      const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
      data = new Uint8Array(await (await this.canvasBlob(canvas, mime, 0.94)).arrayBuffer());
    }
    const path = await this.writeArtwork(format === "jpeg" ? "jpg" : format, data);
    new Notice(t("board.exported", { format: format.toUpperCase() }));
    return path;
  }
  private async shareArtwork(): Promise<void> {
    await this.prepareImages();
    const canvas = this.renderArtboardCanvas(), blob = await this.canvasBlob(canvas, "image/png");
    if (typeof navigator.share === "function") {
      const file = new File([blob], "Tutor-Artwork.png", { type: "image/png" });
      try { await navigator.share({ title: "Tutor Artwork", files: [file] }); return; } catch (error) {
        if ((error as Error).name === "AbortError") return;
      }
    }
    await this.exportArtwork("png");
  }
  private drawMinimap(objects: readonly BoardObject[], viewport: { x: number; y: number; width: number; height: number }): void {
    const canvas = this.minimap;
    if (!canvas) return;
    if (canvas.width !== 180) canvas.width = 180;
    if (canvas.height !== 120) canvas.height = 120;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 180, 120);
    const revision=this.history?.revision??0;
    let cache=this.minimapObjectCache;
    if (!cache || cache.objects !== objects || cache.revision !== revision) {
      const boxes: ReturnType<typeof boardObjectBounds>[]=[];
      let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      for(const object of objects){const box=boardObjectBounds(object);boxes.push(box);left=Math.min(left,box.x);top=Math.min(top,box.y);right=Math.max(right,box.x+box.width);bottom=Math.max(bottom,box.y+box.height);}
      cache={objects,revision,boxes,left,top,right,bottom};this.minimapObjectCache=cache;
    }
    const {boxes}=cache;
    const left=Math.min(cache.left,viewport.x),top=Math.min(cache.top,viewport.y);
    const right=Math.max(cache.right,viewport.x+viewport.width),bottom=Math.max(cache.bottom,viewport.y+viewport.height);
    const scale = Math.min(170 / Math.max(1, right - left), 110 / Math.max(1, bottom - top));
    context.fillStyle = "#ffffffd8"; context.fillRect(0, 0, 180, 120);
    context.fillStyle = "#55479a88";
    for (const box of boxes) context.fillRect(5 + (box.x - left) * scale, 5 + (box.y - top) * scale, Math.max(1, box.width * scale), Math.max(1, box.height * scale));
    context.strokeStyle = "#d64b6a"; context.lineWidth = 2;
    context.strokeRect(5 + (viewport.x - left) * scale, 5 + (viewport.y - top) * scale, viewport.width * scale, viewport.height * scale);
  }
  public focusContent():void {this.pendingInitialFit=false;this.contentEl.ownerDocument.defaultView?.requestAnimationFrame(()=>this.fitContent());}
  private fitContent(): void {
    const objects = this.history?.document.objects ?? [];
    const canvas = this.canvas;
    if (!canvas || !objects.length) { this.pan = { x: 80, y: 80 }; this.zoom = 1; this.schedule(); return; }
    const boxes = objects.map(boardObjectBounds);
    const left = Math.min(...boxes.map((box) => box.x)); const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width)); const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    const rect = canvas.getBoundingClientRect();
    const margin=this.contentEl.hasClass("is-compact")?40:100;
    this.zoom = Math.max(0.1, Math.min(4, Math.min((rect.width - margin) / Math.max(1, right - left), (rect.height - margin) / Math.max(1, bottom - top))));
    this.pan = { x: (rect.width - (right - left) * this.zoom) / 2 - left * this.zoom, y: (rect.height - (bottom - top) * this.zoom) / 2 - top * this.zoom };
    this.schedule();
  }
  private preview(): string {
    const document = this.history!.document;
    const artboard = this.activeArtboard();
    if (document.artboards?.length) {
      const paintLayers = new Set((document.layers ?? []).filter(layer => layer.kind === "paint" && layer.visible).map(layer => layer.id));
      const hasPaint = (document.paintOperations ?? []).some(operation => paintLayers.has(operation.layerId));
      const paintUrl = hasPaint ? this.renderArtboardCanvas(paintLayers, false, artboard).toDataURL("image/png") : undefined;
      return renderBoardSvg(document.objects, {
        width: artboard.width, height: artboard.height, viewport: artboard,
        ink: this.bundle!.ink, characters: this.profiles, resolveAsset: this.resolveImage, requestRender: () => { this.staticRenderKey = ""; this.schedule(); }, layers: document.layers, background: document.background, vectorAssets: document.vectorAssets,brushResources:this.brushImages,missingBrushResource:this.reportMissingBrushResource,
        ...(paintUrl ? { rasterUnderlay: { url: paintUrl, x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height } } : {}),
      });
    }
    const boxes = document.objects.map(boardObjectBounds);
    const width = Math.max(800, ...boxes.map((box) => box.x + box.width + 40));
    const height = Math.max(600, ...boxes.map((box) => box.y + box.height + 40));
    return renderBoardSvg(document.objects, { width, height, ink: this.bundle!.ink, characters: this.profiles, resolveAsset: this.resolveImage, requestRender: () => { this.staticRenderKey = ""; this.schedule(); }, layers: document.layers, vectorAssets: document.vectorAssets,brushResources:this.brushImages,missingBrushResource:this.reportMissingBrushResource });
  }
  private commit(): void {
    if (!this.bundle || !this.history) return;
    this.bundle.document = this.history.document;
    this.sceneDirty = true; this.saveEpoch++;
    if (this.statusEl) this.statusEl.textContent = "保存中…";
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.previewTimer);
    this.previewTimer = 0;
    if(this.closed||this.transitions){this.saveTimer=0;this.schedule();return;}
    const history=this.history,bundle=this.bundle;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      if(this.closed||this.history!==history||this.bundle!==bundle)return;
      void this.saveScene().then(() => {
        if (!this.closed && this.history===history && this.bundle===bundle && !this.sceneDirty) {
          if (this.statusEl) this.statusEl.textContent = t("board.saved");
          this.queueDerivedPreview();
        }
      }).catch((error) => {
        if(this.history===history&&this.bundle===bundle){
          if (this.statusEl) this.statusEl.textContent = "离线 · 未保存";
          new Notice(String(error));
        }
      });
    }, 250);
    this.schedule();
  }
  private queueDerivedPreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      if (this.closed || this.transitions || !this.bundle || !this.history) return;
      if (this.gesture || this.cameraPreviewTimer) { this.queueDerivedPreview(); return; }
      try {
        const svg=this.preview();
        const history=this.history,save=this.saveScene(svg);
        this.previewSave=save;
        void save.catch(() => { if (this.history===history&&this.statusEl) this.statusEl.textContent="预览待更新"; })
          .finally(() => { if (this.previewSave===save) this.previewSave=null; });
      } catch { if (this.statusEl) this.statusEl.textContent="预览待更新"; }
    }, 3000);
  }
  /** Keep the loaded scene and undo stack while its locator changes on disk. */
  public sourceMoveParticipant(source: string): BoardSourceMoveParticipant | null {
    if (this.closed || this.sourceFile !== source) return null;
    let frozen = false;
    return {
      prepare: async (requireSaved = false) => {
        await this.whenReady();
        if (this.sourceFile !== source || this.sourceMoveIdle) throw new Error("board-source-move-target-changed");
        this.sourceMoveIdle = new Promise(resolve => { this.resolveSourceMoveIdle = resolve; });
        this.beginTransition(); frozen = true;
        this.connectionChanged(); this.aiAbort?.abort(); this.loadGeneration++;
        this.surfaceInstance = undefined;
        this.cancelProgressiveRender(); this.outlinePreparation?.dispose(); this.outlinePreparation = null;
        this.checkpointService?.dispose(); this.checkpointService = undefined;
        if (this.gesture) this.finish(this.gesture.pointerId);
        if (requireSaved) { await this.flush(); await this.saveScene(); }
        else try { await this.flush(); } catch { /* repository verifies the entire recovery copy */ }
        if (!this.history || !this.bundle) throw new Error("studio-not-ready");
        return copy({ document: this.history.document, ink: this.bundle.ink });
      },
      replaceVersion: async bundle => {
        if (!frozen || this.closed || this.sourceFile !== source || bundle.document.sourceFile !== source || bundle.document.sourceType !== "standalone") throw new Error("board-source-choice-stale");
        const generation = ++this.loadGeneration;
        try { await this.loadBoardNow(generation, copy(bundle)); this.loadError = undefined; }
        catch (error) {
          // The locator is already committed and the prior work was saved.
          // A retry reads that exact selected source, never saves the old scene
          // over it or guesses a new target after an asset-loading failure.
          this.loadError = error; this.releaseScene(); this.renderLoadState(true); throw error;
        }
      },
      accept: (bundle, receipt) => {
        if (this.closed) return;
        if (!frozen || this.sourceFile !== receipt.from || receipt.to !== bundle.document.sourceFile || !this.history || !this.bundle || this.history.document.id !== receipt.boardId)
          throw new Error("board-source-move-target-changed");
        this.history.receiveSourceMove(bundle.document);
        this.sourceFile = receipt.to;
        this.bundle.document = this.history.document; this.bundle.ink = copy(bundle.ink);
        if (bundle.recovery) this.bundle.recovery = copy(bundle.recovery); else delete this.bundle.recovery;
        this.sceneDirty = receipt.durability !== "committed"; this.saveEpoch++;
        this.staticRenderKey = ""; this.layerFingerprintKey = "";
        if (this.statusEl) this.statusEl.textContent = t(receipt.durability === "committed" ? "board.saved" : receipt.durability === "recovered-conflict" ? "board.recoveredConflict" : "board.recoveredDraft");
      },
      release: () => {
        if (frozen) {
          this.endTransition(); this.sourceMoveIdle = null;
          this.resolveSourceMoveIdle?.(); this.resolveSourceMoveIdle = undefined;
          if (!this.closed && this.history && this.bundle) { this.createCheckpointService(); this.schedule(); }
        }
      },
    };
  }
  public connectionChanged(): void {
    this.closeAiPanel?.(); this.closeAiPanel = null;
  }

  /** All saves capture their target before queuing, including autosave and tools. */
  private saveScene(previewSvg?:string):Promise<void>{
    const history=this.history,bundle=this.bundle;
    if(!history||!bundle)return Promise.resolve();
    const document=history.renderDocument,epoch=this.saveEpoch;
    const snapshot=copy({document,ink:bundle.ink});
    bundle.document=copy(document);
    this.savePending++;
    const save=this.saveTail.then(()=>this.host.save(snapshot,previewSvg)).then(()=>{
      if(this.history===history&&this.bundle===bundle&&history.renderDocument===document&&this.saveEpoch===epoch){
        this.sceneDirty=false;
        if(!this.closed&&this.statusEl)this.statusEl.textContent=t("board.saved");
      }
    }).catch(error=>{
      if(this.history===history&&this.bundle===bundle)this.sceneDirty=true;
      throw error;
    }).finally(()=>{this.savePending--;});
    // A failed earlier write cannot poison the next explicitly requested retry.
    this.saveTail=save.catch(()=>{});
    return save;
  }
  public flush(): Promise<void> {
    if(this.flushWork)return this.flushWork;
    this.beginTransition();
    const work=this.flushScene().finally(()=>{if(this.flushWork===work)this.flushWork=null;this.endTransition();});
    this.flushWork=work;return work;
  }
  private async flushScene():Promise<void>{
    const history=this.history,bundle=this.bundle;
    if(this.gesture)this.finish(this.gesture.pointerId);
    this.touches.clear();this.pinch=null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = 0; }
    if (this.previewTimer) { clearTimeout(this.previewTimer); this.previewTimer = 0; }
    await this.saveTail;
    if(!history||!bundle||this.history!==history||this.bundle!==bundle)return;
    // A concurrent host edit during a slow save remains on the original scene.
    // Input is suspended, and only the latest state is released after persistence.
    do { this.sceneDirty=true; await this.saveScene(); }
    while(this.history===history&&this.bundle===bundle&&this.sceneDirty);
  }

  public override onClose(): Promise<void> {
    if(this.closeWork)return this.closeWork;
    const work=this.closeScene().finally(()=>{if(this.closeWork===work)this.closeWork=null;});
    this.closeWork=work;return work;
  }
  private async closeScene():Promise<void>{
    if (this.sourceMoveIdle) await this.sourceMoveIdle;
    this.closed = true;
    this.contentEl.inert=true;
    this.stopCameraPreview();
    this.cancelProgressiveRender();
    this.renderedCamera = null;
    this.outlinePreparation?.dispose(); this.outlinePreparation = null;
    this.stateGeneration++; this.loadGeneration++;
    this.boardLoad = null; this.brushLoad = null;
    this.connectionChanged();
    this.aiAbort?.abort();
    this.aiAgent?.dispose();
    this.checkpointService?.dispose();this.checkpointService=undefined;
    if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;
    // Failure intentionally retains authoritative history/ink for retry/reopen.
    // A clean synthetic/model preview is not a committed student drawing.
    if(this.sceneDirty||this.gesture||this.savePending||this.saveTimer||this.previewTimer)await this.flush();
    else if(this.previewSave)await this.previewSave;
    this.releaseScene();
    this.contentEl.empty();
  }
  /** Called only after the original scene's save has settled successfully. */
  private releaseScene():void{
    this.stopCameraPreview();this.cancelProgressiveRender();
    this.outlinePreparation?.dispose();this.outlinePreparation=null;
    if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;
    this.observer?.disconnect();this.observer=null;
    this.checkpointService?.dispose();this.checkpointService=undefined;
    this.layerRenderer.dispose();this.livePainter.dispose();this.spatial.clear();
    const canvases=new Set([this.canvas,this.staticCanvas,this.progressCanvas,this.backgroundCanvas,this.draftCanvas,this.minimap,
      ...this.fillCanvases.values(),...Array.from(this.restoredTiles.values(),item=>item.canvas)]);
    for(const canvas of canvases)if(canvas){canvas.width=0;canvas.height=0;}
    for(const image of this.brushImages.values())image.close();
    this.brushImages.clear();this.brushBytes.clear();this.missingBrushHashes.clear();
    this.fillCanvases.clear();this.restoredTiles.clear();this.paintAssets.clear();this.embeddedImages.clear();this.imageBytes.clear();
    this.profiles=[];this.tileRestoreKey="";this.visiblePaintViewport=null;
    this.visibleObjects=[];this.draftObjects=null;this.minimapObjectCache=null;this.renderedCamera=null;
    this.layerFingerprintKey="";this.layerFingerprints.clear();this.staticRenderKey="";
    this.gesture=null;this.touches.clear();this.pinch=null;this.selectedIds.clear();this.paintSelection=undefined;this.spaceDown=false;
    this.refreshVectorInspector=undefined;this.refreshSelectionInspector=undefined;this.sizeControl=null;this.brushCursor=null;this.statusEl=null;
    this.aiAbort=null;this.aiAgent=null;
    this.history = null; this.bundle = null; this.surfaceInstance = undefined;
    this.canvas=null;this.staticCanvas=null;this.progressCanvas=null;this.backgroundCanvas=undefined;this.draftCanvas=undefined;this.minimap=null;
    this.saveTimer=0;this.previewTimer=0;this.previewSave=null;this.sceneDirty=false;
  }
}
