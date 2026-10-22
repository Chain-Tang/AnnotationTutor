import { BoardLayoutState, layoutObjectDigest, type BoardSlotSpec } from "./board-layout.js";
import { BoardSlotViews, projectBoardSlot, captureBoardSurface, projectCapturedBoardSlot, freezeBoardProjection, type BoardProjection } from "./board-projection.js";
import { createBoardSnapIndex, snapBoardObject, type BoardSnapIndex } from "./board-snap.js";
import {boardObjectBounds} from "./board-spatial.js";
import {findDrawingRect, mapRect, objectClientBounds, placeDrawingGroup, rectUnion, safeDrawingRect, overlaps, type DrawingSpace} from "./board-placement.js";
import {invertBoardMatrix, multiplyBoardMatrices} from "./board-surfaces.js";
import {boardCaptureClientRect} from "./board-capture.js";
import { beginTutorActivity } from "./interaction-activity.js";
import { LiveBrushPainter } from "./board-live-paint.js";
import { inkSelectionFingerprint, isCurrentInkSelection } from "./ink-transcript.js";
import { TutorBoardSurface, MAX_PREPARED_DRAWING_CHANGES } from "./tutor-board-surface.js";
import { SurfaceCommitError } from "./tutor-surface.js";
import type { SurfaceTransactionJournal } from "./surface-transaction-journal.js";
import { TutorTaskCoordinator } from "./tutor-task.js";
import { resolveBoardConnection } from "./board-connection.js";
import { AIExecutionError } from "./ai-execution.js";
import { requestsReferencePainting, requestsDrawing, requestsBoardTextDrawing } from "./board-drawing-intent.js";
import { reconstructReference, playReferenceStrokes } from "./board-reference-paint.js";
import { referencePaintPresets, type ReferencePaintStyle } from "./board-reference-style.js";
import type { ImageGenerationProvider } from "./board-types.js";
import { Modal, Notice, TFile, setIcon, type App, type View } from "obsidian";
import { t } from "./i18n.js";
import type { AnnotationTutorLiteSettings } from "./settings-config.js";
import type {
  BoardAgent,
  BoardAnchor,
  BoardBundle,
  BoardDocument,
  BoardExpression,
  BoardBrushKind,
  BoardBrushStyle,
  BoardFillStyle,
  BoardInk,
  BoardObject,
  BoardOperation,
  BoardPoint,
  BoardRect,
  BoardTextStyle,
  RecognitionProvider,
  TutorCharacterProfile,
} from "./board-types.js";
import type { ChatMessage } from "./api-runner.js";
import type { ChatContext } from "./chat-prompt.js";
import { contextVersion } from "./teaching-policy.js";
import { pdfLearningContext } from "./learning-pdf-context.js";
import type { TutorConversation, TutorSubmitOptions } from "./tutor-conversation.js";
import { localLearnerAuthority } from "./learning-control-v3.js";
import { BoardReplyOverlay } from "./board-reply.js";
import { BoardHistory } from "./board-model.js";
import { BoardRepository, BoardConflictError, BoardSourceBranchesError, type BoardSourceMoveParticipant, type BoardSourceChoices } from "./board-store.js";
import {
  BoardRequestScheduler,
  BoardRequestCoordination,
  requestBoardWithRepair,
} from "./board-agent.js";
import { boardStickerExpressions, boardStickerKey, builtInBoardAssets } from "./board-characters.js";
import { decorateBoardButton } from "./board-ui.js";
import { BoardAnchorRegistry } from "./board-anchors.js";
import { cloneBoardValue as copy } from "./board-clone.js";
import { portableBoardObjects } from "./board-portable-layout.js";
import {
  BoardEditorBridge,
  type BoardEditorEvent,
  type BoardEditorStatus,
} from "./board-editor.js";
import {
  ensureBoardFonts,
  boardFontSvgCss,
  boardHandwrittenText,
  boardTextMeasurer,
  layoutBoardText,
  resolvedBoardTextStyle,
  boardFontCss,
} from "./board-fonts.js";
import { discoverBoardSurfaces, type BoardSurface } from "./board-surfaces.js";
import {
  captureBoardSnapshot,
  boardSurfaceLayoutRevision,
} from "./board-capture.js";
import { normalizedBoardPoints, prepareBoardCanvas, renderBoardCanvas, renderBoardSvg } from "./board-renderer.js";
import { BoardSpatialIndex } from "./board-spatial.js";
import { BOARD_BRUSHES, defaultBoardBrush } from "./board-brushes.js";
import { classifyBoardStroke, shouldMergeSemanticStrokes } from "./board-semantics.js";
import { jpegBase64ToPdf } from "./board-export.js";
import { BoardComputeService } from "./board-compute.js";
import { BOARD_BRUSH_DEFAULT_WIDTHS, BrushSizeControl, paintBoardBrushPreview, positionBoardBrushCursor } from "./board-brush-ui.js";

type SourceView = View & {
  file?: TFile | null;
  getMode?: () => string;
  getViewData?: () => string;
  viewer?: unknown;
  addAction?: (
    icon: string,
    title: string,
    callback: () => void,
  ) => HTMLElement;
};
type Tool =
  "read" | "pen" | "erase" | "partialErase" | "select" | "text" | "line" | "arrow" | "rect" | "ellipse" | "diamond" | "connector" | "fill";
type Host = {
  drafts?: import("./board-draft.js").BoardDraftStore;
  app: App;
  settings: () => AnnotationTutorLiteSettings;
  saveSettings: () => Promise<void>;
  createAgent: () => BoardAgent;
  createImageProvider?: () => ImageGenerationProvider | null;
  createRecognitionProvider?: () => RecognitionProvider;
  dismissPdfSelection: () => void;
  openStudioLibrary?: () => void;
  conversation?: TutorConversation;
  captureConversationContext?: (view: SourceView) => Promise<ChatContext>;
  transactions?: SurfaceTransactionJournal;
  sourceMoveParticipants?: (source: string) => BoardSourceMoveParticipant[];
};
type DrawingCommitContext={id:string;taskId:string;targetId:string;baseRevision:string;before:BoardObject[];humanObjectIds:string[];tasks:TutorTaskCoordinator;standalone:boolean};
const uid = (prefix: string): string =>
  `${prefix}-${globalThis.crypto.randomUUID()}`;
const anchorKey = (a: BoardAnchor): string =>
  a.kind === "pdf" ? `pdf:${a.page}` : a.kind === "canvas" ? `canvas:${a.pageId}` : `md:${a.key}`;
const now = (): string => new Date().toISOString();
const rectContains = (r: BoardRect, p: BoardPoint): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const surfaceRect = (surface: BoardSurface) => {
  const { x, y, width, height } = surface.getClientRect();
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
  };
};
function sameAnchor(a: BoardAnchor, b: BoardAnchor): boolean {
  if (a.kind === "pdf") return b.kind === "pdf" && a.page === b.page;
  if (a.kind === "canvas") return b.kind === "canvas" && a.pageId === b.pageId;
  return b.kind === "markdown" && a.key === b.key && a.quote === b.quote && a.sourceLine === b.sourceLine;
}
function samePlacement(a: BoardObject, b: BoardObject): boolean {
  if (!sameAnchor(a.anchor, b.anchor) || a.strokeWidth !== b.strokeWidth) return false;
  const before = boardObjectBounds(a), after = boardObjectBounds(b);
  return before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
}
function bounds(points: BoardPoint[]): BoardRect {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
  };
}
function clientBounds(object: BoardObject, surface: BoardSurface): BoardRect {
  const angle = object.rotation ?? 0,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return bounds(
    [
      [0, 0],
      [object.width, 0],
      [0, object.height],
      [object.width, object.height],
    ].map(([x = 0, y = 0]) =>
      surface.project({
        x: object.x + x * c - y * s,
        y: object.y + x * s + y * c,
      }),
    ),
  );
}
function supported(view: SourceView): boolean {
  return (
    !!view.file &&
    (view.file.extension === "pdf" || view.file.extension === "md")
  );
}

/** Per-view lifecycle; repositories remain bound to the root they were opened in. */
export class InspirationBoards {
  private repository: BoardRepository;
  private readonly layers = new Map<SourceView, BoardLayer>();
  private readonly layouts = new Map<string,BoardLayoutState>();
  private readonly actions = new Map<SourceView, HTMLElement>();
  private readonly hidden = new WeakMap<SourceView, string>();
  private readonly opening = new Set<SourceView>();
  private readonly registries = new Map<string, BoardAnchorRegistry>();
  private readonly observers = new Map<string, BoardLayer>();
  private readonly observationQueues = new Map<
    string,
    BoardRequestCoordination
  >();
  private readonly editors: BoardEditorBridge;
  private syncPromise: Promise<void> | null = null;
  private syncRequested = false;
  private sourceMoveTail: Promise<void> = Promise.resolve();
  private sourceMoves = 0;
  private readonly failedSourceMoves = new Map<string, string>();
  private sourceMoveIdle: Promise<void> | null = null;
  private resolveSourceMoveIdle?: () => void;
  private generation = 0;
  private disposed = false;
  public constructor(private readonly host: Host) {
    this.repository = this.makeRepository();
    this.editors = new BoardEditorBridge({
      getRegistry: (path) => this.registries.get(path),
      onChange: (event) => {
        for (const [view, layer] of this.layers)
          if (
            layer.sourceFile === event.state.sourcePath &&
            view.containerEl.contains(event.state.view.dom)
          )
            layer.editorChanged(event);
      },
    });
  }
  public get editorExtension() {
    return this.editors.extension;
  }
  public async createStandalone(preset?:{width:number;height:number;title:string}): Promise<BoardBundle> {
    const source = `${this.repository.memoryRoot}/standalone/Canvas-${Date.now()}.md`;
    const bundle = await this.repository.open(source, "standalone");
    // The repository writes this human-visible entry alongside board.json.
    // Point the board at that real Vault file so the work can be reopened.
    bundle.document.sourceFile = `${this.repository.memoryRoot}/boards/${bundle.document.id}.md`;
    if(preset){
      if(!Number.isFinite(preset.width)||!Number.isFinite(preset.height)||preset.width<320||preset.height<320||preset.width>4096||preset.height>4096)throw new Error("invalid-studio-preset");
      bundle.document.title=preset.title;
      bundle.document.artboards=[{id:"artboard-main",name:preset.title,x:0,y:0,width:preset.width,height:preset.height,dpi:144,background:"#ffffff",exportPreset:"custom"}];
    }
    await this.repository.save(bundle.document, bundle.ink,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${preset?.width??1920}" height="${preset?.height??1080}" viewBox="0 0 ${preset?.width??1920} ${preset?.height??1080}"><rect width="100%" height="100%" fill="#ffffff"/></svg>`);
    return bundle;
  }
  public async openStandalone(sourceFile: string): Promise<BoardBundle> {
    const bundle = await this.readOrChooseSource(sourceFile, "standalone", true);
    if (!bundle) throw new Error("board-source-choice-cancelled");
    return bundle;
  }
  public openSavedStandalone(source: string, expectedId: string): Promise<void> {
    const repository = this.repository, generation = this.generation;
    return this.sourceTransition(async () => {
      const participants = this.host.sourceMoveParticipants?.(source) ?? [];
      if (!participants.length || participants.some(participant => !participant.replaceVersion)) throw new Error("board-source-choice-stale");
      try {
        const prepared = await Promise.allSettled(participants.map(participant => participant.prepare(true)));
        const failed = prepared.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (prepared.some(result => result.status === "fulfilled" && (result.value.document.id !== expectedId || result.value.document.sourceFile !== source))) throw new Error("board-source-choice-stale");
        const current = () => !this.disposed && this.repository === repository && this.generation === generation;
        const choice = await repository.sourceBranchChoices(source, "standalone");
        if (!current()) throw new Error("board-source-choice-stale");
        if (!choice) { await this.host.app.workspace.openLinkText(`${repository.memoryRoot}/boards/${expectedId}.md`, "", true); return; }
        const chosen = await this.pickSourceBranch(choice, repository, undefined, current);
        if (chosen && chosen.document.id !== expectedId) {
          const applied = await Promise.allSettled(participants.map(participant => participant.replaceVersion!(chosen)));
          const failure = applied.find(result => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      } finally { for (const participant of participants) participant.release(); }
    });
  }
  public saveStandalone(bundle: BoardBundle, previewSvg?: string): Promise<void> {
    return this.repository.save(bundle.document, bundle.ink, previewSvg);
  }
  public writePaintTile(boardId:string,layerId:string,key:string,revision:number,data:ArrayBuffer):Promise<string>{
    return this.repository.writeTile(boardId,layerId,key,revision,data);
  }
  public readPaintTile(path:string):Promise<ArrayBuffer|null>{ return this.repository.readTile(path); }
  public toolSurfaces(): TutorBoardSurface[] { return [...this.layers.values()].map(layer => layer.toolSurface()); }
  public studioAssets(): Promise<TutorCharacterProfile[]> { return this.repository.characters(); }
  public saveStudioAsset(profile: TutorCharacterProfile): Promise<void> { return this.repository.saveCharacter(profile); }
  private claimObserver(layer: BoardLayer): void {
    this.host.conversation?.activateBoard(layer.conversationId);
    const previous = this.observers.get(layer.sourceFile);
    if (previous === layer) return;
    previous?.invalidateObservation();
    this.observers.set(layer.sourceFile, layer);
  }
  public quickInput(): void {
    const view = this.host.app.workspace.activeLeaf?.view as SourceView | undefined;
    const layer = view ? this.layers.get(view) : undefined;
    if (layer) layer.showQuickInput();
    else new Notice(t("board.unsupported"));
  }
  private lastSourceFile:string|undefined;
  public sourceForChat():string|undefined {
    const view=this.host.app.workspace.activeLeaf?.view as SourceView|undefined;
    return view&&supported(view)?view.file?.path:this.lastSourceFile;
  }
  public activeViewChanged(): void {
    const conversation = this.host.conversation;
    if (!conversation) return;
    const view = this.host.app.workspace.activeLeaf?.view as SourceView | undefined;
    if (view?.getViewType() === "annotation-tutor-lite-chat") return;
    this.lastSourceFile=view&&supported(view)?view.file?.path:undefined;
    const layer = view ? this.layers.get(view) : undefined;
    const previous = conversation.state.activeBoardId;
    if (previous && previous !== layer?.conversationId) conversation.cancelForBoard(previous);
    if (layer) conversation.activateBoard(layer.conversationId);
    else conversation.deactivateBoard();
  }
  private async openRegistry(
    view: SourceView,
    bundle: BoardBundle,
  ): Promise<BoardAnchorRegistry | undefined> {
    if (bundle.document.sourceType !== "markdown") return;
    const path = bundle.document.sourceFile,
      existing = this.registries.get(path);
    if (existing) return existing;
    const editor = this.editors.get(view.containerEl, path);
    let text = editor?.view.state.doc.toString();
    if (
      text === undefined &&
      view.file &&
      typeof this.host.app.vault.cachedRead === "function"
    )
      text = await this.host.app.vault.cachedRead(view.file);
    if (text === undefined) return;
    // Another split may have completed its disk read while this one waited.
    if (this.registries.has(path)) return this.registries.get(path);
    const registry = new BoardAnchorRegistry(
      text,
      bundle.document.markdownAnchors,
      bundle.document.objects.map((o) => o.anchor),
    );
    this.registries.set(path, registry);
    this.editors.refresh();
    return registry;
  }
  private makeRepository(): BoardRepository {
    return new BoardRepository(
      this.host.app.vault.adapter,
      this.host.settings().memoryRoot,
      this.host.drafts,
    );
  }
  public sync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.syncRequested = true;
    if (this.sourceMoveIdle) return this.sourceMoveIdle.then(() => this.sync());
    if (!this.syncPromise) {
      // File-open and layout events often arrive together. Finish one view
      // transition before applying the latest layout, including events received
      // while its save or character assets are still loading.
      this.syncPromise = Promise.resolve()
        .then(async () => {
          while (this.syncRequested && !this.disposed && !this.sourceMoves) {
            this.syncRequested = false;
            await this.syncViews();
          }
        })
        .finally(() => {
          this.syncPromise = null;
          // A layout event can arrive after the loop exits but before this
          // promise settles. Include that last request in the same completion.
          if (this.syncRequested && !this.disposed && !this.sourceMoves) return this.sync();
        });
    }
    return this.syncPromise;
  }
  private async syncViews(): Promise<void> {
    if (this.sourceMoves) return;
    const generation = this.generation;
    const views = new Set<SourceView>();
    this.host.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as SourceView;
      if (view.file && ["md", "pdf"].includes(view.file.extension))
        views.add(view);
    });
    for (const [view, layer] of this.layers)
      if (
        !views.has(view) ||
        !supported(view) ||
        !layer.sourceIsCurrent() ||
        view.file?.path !== layer.sourceFile ||
        view.containerEl.ownerDocument !== layer.ownerDocument
      ) {
        if (this.sourceMoves) return;
        if (this.failedSourceMoves.has(layer.sourceFile)) continue;
        await layer.dispose();
        if (this.layers.get(view) === layer) this.layers.delete(view);
        if (this.disposed || generation !== this.generation) return;
      }
    for (const [view, action] of this.actions)
      if (!views.has(view)) {
        action.remove();
        this.actions.delete(view);
      }
    for (const view of views) {
      if (this.sourceMoves) return;
      if (!this.actions.has(view) && view.addAction) {
        const action = view.addAction(
          "pencil",
          t("board.title"),
          () =>
            void this.toggle(view).catch(
              (error) =>
                new Notice(t("board.error", { detail: String(error) })),
            ),
        );
        action.dataset.atlBoardAction = "true";
        this.actions.set(view, action);
      }
      if (
        !supported(view) ||
        this.layers.has(view) ||
        this.opening.has(view) ||
        this.hidden.get(view) === view.file?.path
      )
        continue;
      await this.open(view, false);
      if (this.disposed || generation !== this.generation) return;
    }
  }
  public async toggle(view?: SourceView): Promise<void> {
    const actual =
      view ??
      (this.host.app.workspace.activeLeaf?.view as SourceView | undefined);
    if (!actual || !supported(actual)) {
      new Notice(t("board.unsupported"));
      return;
    }
    const layer = this.layers.get(actual);
    if (layer) {
      await layer.dispose();
      this.hidden.set(actual, layer.sourceFile);
      if (this.layers.get(actual) === layer) this.layers.delete(actual);
      return;
    }
    this.hidden.delete(actual);
    await this.open(actual, true);
  }
  /** Called only after semantic intent resolution; opening is idempotent. */
  public async ensureOpen(sourceFile:string,signal:AbortSignal,sourceView?:SourceView):Promise<string> {
    if(signal.aborted)throw new DOMException("Cancelled","AbortError");
    await this.sync();
    let target:SourceView|undefined;
    const active=this.host.app.workspace.activeLeaf?.view as SourceView|undefined;
    this.host.app.workspace.iterateAllLeaves(leaf=>{
      const view=leaf.view as SourceView;
      if(supported(view)&&view.file?.path===sourceFile&&view.containerEl.isConnected&&
        (sourceView ? view===sourceView : !target||view===active))target=view;
    });
    if(signal.aborted)throw new DOMException("Cancelled","AbortError");
    if(!target)throw new Error(t("board.unsupported"));
    const view=target as SourceView;
    if(!this.layers.has(view)){this.hidden.delete(view);await this.open(view,true,signal);}
    let stillOpen=false;
    this.host.app.workspace.iterateAllLeaves(leaf=>{if(leaf.view===view)stillOpen=true;});
    if(signal.aborted||view.file?.path!==sourceFile||!view.containerEl.isConnected||!stillOpen)
      throw new DOMException("Cancelled","AbortError");
    const layer=this.layers.get(view);if(!layer)throw new Error(t("board.unavailable"));
    this.claimObserver(layer);return layer.conversationId;
  }
  public async hasDrawingSpace(boardId:string,signal:AbortSignal):Promise<boolean> {
    const layer=[...this.layers.values()].find(layer=>layer.conversationId===boardId);
    for(let i=0;layer && i<20;i++){
      if(signal.aborted)throw new DOMException("Cancelled","AbortError");
      const result=layer.availableDrawingArea();
      if(result!==undefined)return !!result;
      await new Promise(resolve=>setTimeout(resolve,32));
    }
    return false;
  }
  public async revealInk(sourceFile:string,ids:readonly string[]):Promise<void>{
    await this.ensureOpen(sourceFile,new AbortController().signal);
    for(const layer of this.layers.values())if(layer.sourceFile===sourceFile){layer.revealInk(ids);break;}
  }
  private async readOrChooseSource(source: string, type: BoardBundle["document"]["sourceType"], create: boolean, signal?: AbortSignal, current = () => !this.disposed): Promise<BoardBundle | null> {
    const repository = this.repository;
    try { return create ? await repository.open(source, type) : await repository.read(source, type); }
    catch (error) {
      if (!(error instanceof BoardSourceBranchesError)) throw error;
      if (!create) throw new Error(t("board.sourceBranchesNotice"));
      return this.pickSourceBranch(error, repository, signal, current);
    }
  }
  private async pickSourceBranch(choice: BoardSourceChoices, repository: BoardRepository, signal?: AbortSignal, current = () => !this.disposed): Promise<BoardBundle | null> {
    const {source, sourceType: type} = choice;
    if (signal?.aborted || !current()) return null;
      return new Promise<BoardBundle | null>(resolve => {
        const modal = new Modal(this.host.app); modal.titleEl.textContent = t("board.sourceBranchesTitle");
        modal.contentEl.createEl("p", { text: t("board.sourceBranchesExplanation", { source }) });
        const status = modal.contentEl.createDiv(); status.setAttribute("role", "status");
        let settled = false, committing = false, cancelRequested = false;
        const readyChoices = new Set<HTMLButtonElement>();
        const ready = (button: HTMLButtonElement) => { readyChoices.add(button); button.disabled = committing; };
        const finish = (bundle: BoardBundle | null) => { if (!settled) { settled = true; signal?.removeEventListener("abort", cancel); resolve(bundle); } };
        const cancel = () => { cancelRequested = true; if (!committing) finish(null); modal.close(); };
        modal.onClose = () => { cancelRequested = true; if (!committing) finish(null); }; signal?.addEventListener("abort", cancel, { once: true });
        for (const branch of choice.branches) {
          const row = modal.contentEl.createDiv();
          row.createEl("p", { text: `${branch.title || branch.id} · ${t("board.sourceBranchDetails", { objects: String(branch.objects), revision: String(branch.revision) })}` });
          row.createEl("small", { text: branch.id });
          const preview = row.createEl("img"); preview.alt = t("board.sourceBranchPreview"); preview.width = 280; preview.height = 160;
          const choose = row.createEl("button", { text: t("board.sourceBranchOpen") }); choose.disabled = true;
          void Promise.all([repository.inspectSourceBranch(source, type, branch), repository.characters()]).then(([bundle, profiles]) => {
            if (settled || !current() || this.repository !== repository) return;
            if (bundle.document.objects.length > 1000 || Object.values(bundle.ink).reduce((count, stroke) => count + stroke.points.length, 0) > 50_000) {
              preview.hidden = true; row.createEl("p", {text: t("board.sourceBranchPreviewLarge")}); ready(choose); return;
            }
            const layout = portableBoardObjects(bundle.document.objects);
            const svg = renderBoardSvg(layout.objects, { width: layout.width, height: layout.height, characters: [...builtInBoardAssets(), ...profiles], ink: bundle.ink, layers: bundle.document.layers, vectorAssets: bundle.document.vectorAssets,
              resolveAsset: path => path.startsWith(repository.memoryRoot + "/characters/") ? this.host.app.vault.adapter.getResourcePath?.(path) : undefined });
            preview.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; ready(choose);
          }).catch(() => { if (!settled) row.createEl("p", { text: t("board.sourceBranchUnavailable") }); });
          choose.onclick = () => {
            if (committing || !readyChoices.has(choose)) return;
            if (settled || signal?.aborted || !current() || this.repository !== repository) { status.textContent = t("board.sourceBranchStale"); return; }
            committing = true;
            for (const button of modal.contentEl.querySelectorAll<HTMLButtonElement>("button")) if (button !== close) button.disabled = true;
            void repository.selectSourceBranch(source, type, branch.id, choice.branches, choice.identityRevision, () => !settled && !cancelRequested && !signal?.aborted && current() && this.repository === repository).then(bundle => {
              committing = false;
              // A completed locator commit remains a commit if close/cancel
              // arrived afterward. Report it and reconcile the bound views.
              if (cancelRequested || signal?.aborted) new Notice(t("board.sourceBranchSelected"));
              finish(bundle); modal.close();
            }).catch(() => { committing = false; if (cancelRequested || signal?.aborted) { finish(null); modal.close(); } else if (!settled) { status.textContent = t("board.sourceBranchStale"); for (const button of readyChoices) button.disabled = false; } });
          };
        }
        const close = modal.contentEl.createEl("button", { text: t("board.cancel") }); close.onclick = cancel;
        modal.open();
      });
  }
  private openSavedDrawing(view: SourceView, origin: BoardLayer): Promise<void> {
    const source = origin.sourceFile, repository = this.repository, generation = this.generation;
    return this.sourceTransition(async () => {
      if (this.disposed || this.layers.get(view) !== origin || this.repository !== repository || view.file?.path !== source) throw new Error("board-source-choice-stale");
      const bound = [...this.layers].filter(([, layer]) => layer.sourceFile === source);
      const participants = bound.map(([, layer]) => layer.sourceMoveParticipant(true));
      const current = () => !this.disposed && generation === this.generation && this.repository === repository && this.layers.get(view) === origin && view.file?.path === source && view.containerEl.isConnected;
      try {
        const prepared = await Promise.allSettled(participants.map(participant => participant.prepare()));
        const failed = prepared.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (!current()) throw new Error("board-source-choice-stale");
        const type = origin.bundle().document.sourceType, choice = await repository.sourceBranchChoices(source, type);
        if (!choice) {
          await this.host.app.workspace.openLinkText(`${repository.memoryRoot}/boards/${origin.bundle().document.id}.md`, "", true);
          return;
        }
        const chosen = await this.pickSourceBranch(choice, repository, undefined, current);
        if (!chosen || chosen.document.id === origin.bundle().document.id) return;
        // All input and generators are frozen, and every current scene was
        // saved before the locator commit. Detach cannot start a stale save.
        for (const [target, layer] of bound) {
          layer.detach(); if (this.layers.get(target) === layer) this.layers.delete(target);
        }
        this.observers.delete(source); this.observationQueues.delete(source);
        for (const [target] of bound) if (target.file?.path === source && target.containerEl.isConnected) await this.open(target, false);
      } finally { for (const participant of participants) participant.release(); }
    });
  }
  private async open(view: SourceView, create: boolean, signal?: AbortSignal): Promise<void> {
    if (this.opening.has(view) || !view.file) return;
    const generation = this.generation,
      source = view.file.path,
      ownerDocument = view.containerEl.ownerDocument,
      repo = this.repository;
    this.opening.add(view);
    let openingLayer: BoardLayer | undefined;
    try {
      const type = view.file.extension === "pdf" ? "pdf" : "markdown";
      const bundle = await this.readOrChooseSource(source, type, create, signal,
        () => !this.disposed && generation === this.generation && this.repository === repo && view.file?.path === source && view.containerEl.ownerDocument === ownerDocument);
      if (
        !bundle || signal?.aborted ||
        generation !== this.generation ||
        this.disposed ||
        view.file?.path !== source ||
        !supported(view)
      )
        return;
      const existing = [...this.layers.values()].find(
        (layer) => layer.sourceFile === source,
      );
      const registry = await this.openRegistry(view, bundle);
      if (
        signal?.aborted ||
        generation !== this.generation ||
        this.disposed ||
        view.file?.path !== source
      )
        return;
      let layout=this.layouts.get(bundle.document.id);
      if(!layout){layout=new BoardLayoutState(bundle.document.id,bundle.layout??await repo.layouts.load(bundle.document.id,bundle.document));this.layouts.set(bundle.document.id,layout);}
      const layer = new BoardLayer(
        this.host,
        view,
        repo,
        existing?.bundle() ?? bundle,
        () =>
          void this.toggle(view).catch(
            (error) => new Notice(t("board.error", { detail: String(error) })),
          ),
        (updated, origin) => {
          for (const other of this.layers.values())
            if (other !== origin && other.sourceFile === origin.sourceFile)
              other.receive(updated);
        },
        {
          registry, layout,
          openSaved: layer => this.openSavedDrawing(view, layer),
          coordination:
            this.observationQueues.get(source) ??
            (() => {
              const queue = new BoardRequestCoordination();
              this.observationQueues.set(source, queue);
              return queue;
            })(),
          editors: this.editors,
          claim: (layer) => this.claimObserver(layer),
          canObserve: (layer) => this.observers.get(layer.sourceFile) === layer,
        },
      );
      openingLayer = layer;
      this.layers.set(view, layer);
      await layer.initialize();
      if (
        signal?.aborted ||
        generation !== this.generation ||
        this.disposed ||
        view.file?.path !== source ||
        view.containerEl.ownerDocument !== layer.ownerDocument ||
        !supported(view)
      ) {
        layer.detach();
        if (this.layers.get(view) === layer) this.layers.delete(view);
      }
    } catch (error) {
      openingLayer?.detach();
      if (this.layers.get(view) === openingLayer) this.layers.delete(view);
      new Notice(t("board.error", { detail: String(error) }));
    } finally {
      this.opening.delete(view);
      // A toggle can be loading outside sync(). If another event skipped the
      // opening view, ensure the final source/window still receives its board.
      if (
        !this.disposed &&
        generation === this.generation &&
        (view.file?.path !== source ||
          view.containerEl.ownerDocument !== ownerDocument)
      )
        void this.sync().catch(
          (error) => new Notice(t("board.error", { detail: String(error) })),
        );
    }
  }
  public settingsChanged(): void {
    for (const layer of this.layers.values()) layer.modelChanged();
  }
  public async changed(
    path: string,
    kind: "modify" | "create" | "delete" | "rename" = "modify",
    oldPath?: string,
  ): Promise<void> {
    if (this.disposed) return;
    if (kind === "rename" && oldPath) {
      // Suspend layout before queuing: TFile.path has already changed.
      return this.sourceTransition(() => this.moveSource(oldPath, path));
    }
    if (this.sourceMoveIdle) await this.sourceMoveIdle;
    if (this.disposed) return;
    const registry = this.registries.get(path);
    if (registry && kind === "modify") {
      const file = this.host.app.vault.getAbstractFileByPath?.(path);
      const editing = [...this.layers.keys()].some(
        (view) =>
          view.file?.path === path &&
          view.getMode?.() !== "preview" &&
          this.editors.get(view.containerEl, path),
      );
      if (!editing && file instanceof TFile) {
        registry.reconcile(await this.host.app.vault.cachedRead(file));
        this.editors.refresh();
      }
    }
    for (const layer of this.layers.values())
      if (layer.sourceFile === path || layer.sourceFile === oldPath)
        layer.invalidateSource();
    const change = await this.repository.onExternalChange(path);
    if (change)
      for (const layer of this.layers.values())
        if ((change.affectedBoardIds ?? [change.boardId]).includes(layer.bundle().document.id))
          layer.externalChanged();
    if (kind === "rename" || kind === "delete") await this.sync();
  }
  private sourceTransition(operation: () => Promise<void>): Promise<void> {
    if (!this.sourceMoves++) this.sourceMoveIdle = new Promise(resolve => { this.resolveSourceMoveIdle = resolve; });
    const work = this.sourceMoveTail.catch(() => undefined).then(async () => {
      await this.syncPromise?.catch(() => undefined);
      if (!this.disposed) await operation();
    });
    this.sourceMoveTail = work.catch(() => undefined);
    const settled = async (success: boolean) => {
      if (!--this.sourceMoves) {
        this.sourceMoveIdle = null; this.resolveSourceMoveIdle?.(); this.resolveSourceMoveIdle = undefined;
        if (success && !this.disposed) await this.sync();
      }
    };
    return work.then(async () => { await settled(true); }, async error => { await settled(false); throw error; });
  }
  private async moveSource(before: string, after: string): Promise<void> {
    // If an earlier file event failed, complete that exact handoff first. The
    // next event must never treat its intermediate path as a new empty work.
    for (const [original, destination] of this.failedSourceMoves)
      if (destination === before && original !== before) await this.moveSource(original, before);
    const layers = [...this.layers.values()].filter(layer => layer.sourceFile === before);
    const participants = [...layers.map(layer => layer.sourceMoveParticipant()), ...this.host.sourceMoveParticipants?.(before) ?? []];
    try {
      // Wait for all preparations, including failures, before releasing inputs.
      const prepared = await Promise.allSettled(participants.map(participant => participant.prepare()));
      const failure = prepared.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const bundles = prepared.map(result => (result as PromiseFulfilledResult<BoardBundle>).value);
      const receipts = await this.repository.renameSource(before, after, bundles);
      const recovered = new Map<string, BoardBundle>();
      for (const bundle of bundles) {
        if (!receipts.some(receipt => receipt.boardId === bundle.document.id)) throw new Error("board-source-move-uncommitted");
        if (!recovered.has(bundle.document.id)) {
          const next = await this.repository.open(after, bundle.document.sourceType);
          if (next.document.id !== bundle.document.id) throw new Error("board-source-move-target-changed");
          recovered.set(bundle.document.id, next);
        }
      }
      const registry = this.registries.get(before);
      if (registry) { this.registries.delete(before); this.registries.set(after, registry); }
      const observer = this.observers.get(before);
      if (observer) { this.observers.delete(before); this.observers.set(after, observer); }
      const queue = this.observationQueues.get(before);
      if (queue) { this.observationQueues.delete(before); this.observationQueues.set(after, queue); }
      if (this.lastSourceFile === before) this.lastSourceFile = after;
      this.host.app.workspace.iterateAllLeaves(leaf => {
        const view = leaf.view as SourceView;
        if (this.hidden.get(view) === before) this.hidden.set(view, after);
      });
      for (let index = 0; index < participants.length; index++) {
        const bundle = bundles[index]!;
        await participants[index]!.accept(recovered.get(bundle.document.id)!, receipts.find(receipt => receipt.boardId === bundle.document.id)!);
      }
      this.failedSourceMoves.delete(before);
      this.editors.refresh();
    } catch (error) {
      this.failedSourceMoves.set(before, after);
      for (const layer of layers) layer.sourceMoveFailed(error);
      throw error;
    } finally { for (const participant of participants) participant.release(); }
  }
  public async changeRoot(): Promise<void> {
    if (this.sourceMoveIdle) await this.sourceMoveIdle;
    this.generation++;
    // A failed split must not stop the remaining splits from flushing their
    // inputs. Wait for every attempt before any controller can be released.
    const flushed = await Promise.allSettled([...this.layers.values()].map(layer => layer.flush()));
    const failure = flushed.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // Layer flushes can enqueue repository work, so this barrier follows them.
    await this.repository.flush();
    for (const layer of this.layers.values()) await layer.dispose();
    this.layers.clear();
    this.layouts.clear();
    this.registries.clear();
    this.observers.clear();
    this.observationQueues.clear();
  }
  public rootChanged(): void {
    this.repository = this.makeRepository();
    void this.sync();
  }
  public async dispose(): Promise<void> {
    this.disposed = true;
    this.editors.dispose();
    try {
      await this.changeRoot();
    } finally {
      for (const layer of this.layers.values()) layer.detach();
      this.layers.clear();
      for (const action of this.actions.values()) action.remove();
      this.actions.clear();
    }
  }
}

type Gesture = {
  pointerId: number;
  surface: BoardSurface;
  start: BoardPoint;
  last: BoardPoint;
  points: BoardPoint[];
  before: BoardObject[];
  resize: boolean;
  box: boolean;
  groupBounds?: BoardRect;
  snapIndex?: BoardSnapIndex;
  seed: number;
};
type ObjectSurfaces = ((object: BoardObject) => BoardSurface | undefined) & { capture(surface: BoardSurface): BoardSurface };
type SourceSurfaces = { exact: ReadonlyMap<string, BoardSurface>; compatible: ReadonlyMap<string, BoardSurface>; quotes: ReadonlyMap<string, BoardSurface | undefined> };
class BoardLayer {
  public readonly conversationId = uid("BOARDVIEW");
  public sourceFile: string;
  private readonly sourceFileObject: TFile;
  public readonly ownerDocument: Document;
  /** Timers and window listeners belong to the window that created this layer. */
  private readonly win: Window & typeof globalThis;
  private readonly history: BoardHistory;
  private ink: BoardInk;
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly toolbar: HTMLElement;
  private readonly selectionBar: HTMLElement;
  private readonly selectionLabel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly layoutNotice: HTMLButtonElement;
  private hiddenLayoutObjects = new Set<string>();
  private layoutGuardKey = "";
  private readonly prompt: HTMLInputElement;
  private quickInputPreparing = false;
  private layerInputPreparing = false;
  private readonly replyOverlay: BoardReplyOverlay;
  private readonly propertyPanel: HTMLDetailsElement;
  private tutorPreview: BoardOperation[] = [];
  private annotationTurn=false;
  private activeTurn = 0;
  private preparingTurn = 0;
  private turnSequence = 0;
  private activeObservationMode = "";
  /** Metadata only, retained for local troubleshooting; never store the source,
   * screenshot or raw model response as an error log. */
  public lastDrawingFailure: { at: string; code?: string; reason: string } | null = null;
  private sidebarTransitionUntil = 0;
  private sharedSidebarVisible: boolean | undefined;
  private layoutSize = "";
  private saveSequence = 0;
  private readonly togetherButton: HTMLButtonElement;
  private readonly selection = new Set<string>();
  private clipboard: BoardObject[] = [];
  private guides: { x?: number; y?: number } = {};
  private readonly spatial = new BoardSpatialIndex();
  private hitMappingKey="";
  private hitMappings=new Map<string,BoardObject>();
  private hitObjectMappings=new Map<string,string>();
  private hitObjectOrder=new Map<string,number>();
  private readonly compute = new BoardComputeService();
  private profiles: TutorCharacterProfile[] = builtInBoardAssets();
  private readonly assets = new Map<string, string>();
  private surfaces: BoardSurface[] = [];
  private slotViews!:BoardSlotViews;
  private slotSpecs:BoardSlotSpec[]=[];
  private slotSpecKey="";
  private projections=new Map<string,BoardProjection>();
  private pendingSlot?:{spec:BoardSlotSpec;anchor:BoardAnchor};
  private pendingBindings=new Map<string,{slotId:string;matrix:import("./board-types.js").BoardMatrix}>();
  private resizeObserver: ResizeObserver | null = null;
  private readonly resizeTargets = new Map<Element, string>();
  private active: BoardSurface | null = null;
  private tool: Tool = "read";
  private color = "#7062b5";
  private width = 3;
  private readonly brushWidths = new Map<BoardBrushKind, number>(
    BOARD_BRUSHES.map(kind => [kind, BOARD_BRUSH_DEFAULT_WIDTHS[kind]]),
  );
  private brush: BoardBrushStyle = defaultBoardBrush("pen");
  private fill: BoardFillStyle = {
    kind: "none",
    color: "#f1c75b",
    opacity: 0.35,
    seed: 1,
  };
  private activeLayerId = "layer-default";
  private textStyle: BoardTextStyle = {
    font: "handwritten",
    size: 24,
    align: "left",
  };
  private drawingStyle: "clean" | "sketch" = "sketch";
  private renderSnapshot: BoardBundle["document"] | null = null;
  private renderObjects = new Map<string, BoardObject>();
  private renderLayers = new Map<string, NonNullable<BoardDocument["layers"]>[number]>();
  private penPreviewDirty = false;
  private paintScene: HTMLCanvasElement | null = null;
  private paintSceneKey = "";
  private textEditor: {
    element: HTMLTextAreaElement;
    object: BoardObject;
    existing: boolean;
  } | null = null;
  private readonly textProperties: HTMLElement;
  private readonly shapeProperties: HTMLElement;
  private readonly fontSelect: HTMLSelectElement;
  private readonly fontSizeInput: HTMLInputElement;
  private readonly styleSelect: HTMLSelectElement;
  private readonly colorInput: HTMLInputElement;
  private readonly sizeControl: BrushSizeControl;
  private readonly brushPalette: HTMLDivElement;
  private readonly brushPreviewCanvases = new Map<BoardBrushKind, HTMLCanvasElement>();
  private readonly penButton: HTMLButtonElement;
  private readonly brushCursor: HTMLDivElement;
  private readonly brushSelect: HTMLSelectElement;
  private readonly opacityInput: HTMLInputElement;
  private readonly opacityOutput: HTMLOutputElement;
  private readonly smoothingInput: HTMLInputElement;
  private readonly smoothingOutput: HTMLOutputElement;
  private readonly pressureInput: HTMLInputElement;
  private readonly fillSelect: HTMLSelectElement;
  private readonly fillColorInput: HTMLInputElement;
  private gesture: Gesture | null = null;
  private draft: BoardObject[] | null = null;
  private readonly livePainter=new LiveBrushPainter();
  private draftObject: BoardObject | null = null;
  private recognitionAbort?:AbortController;
  private draftInk: BoardInk = {};
  private agent: BoardAgent | null = null;
  private readonly scheduler: BoardRequestScheduler;
  private together = false;
  private generation = 0;
  private sessionId = uid("SESSION");
  private raf = 0;
  private disposed = false;
  private sourceMoving = false;
  private readonly cleanup: Array<() => void> = [];
  private readonly originalPosition: string;
  private savePromise: Promise<void> = Promise.resolve();
  private conflict = false;
  private recoveredDraft = false;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  public constructor(
    private readonly host: Host,
    private readonly view: SourceView,
    private readonly repository: BoardRepository,
    bundle: BoardBundle,
    private readonly onClose: () => void,
    private readonly onChange: (
      bundle: BoardBundle,
      origin: BoardLayer,
    ) => void,
    private readonly integration: {
      registry?: BoardAnchorRegistry;
      layout: BoardLayoutState;
      openSaved?: (layer: BoardLayer) => Promise<void>;
      coordination: BoardRequestCoordination;
      editors: BoardEditorBridge;
      claim: (layer: BoardLayer) => void;
      canObserve: (layer: BoardLayer) => boolean;
    },
  ) {
    this.scheduler = new BoardRequestScheduler({
      coordination: integration.coordination,
      canRun: () => {
        const editor = this.editorState();
        return (
          !this.host.conversation?.state.busy &&
          !this.textEditor &&
          !this.gesture &&
          (!editor || (!editor.composing && editor.ready))
        );
      },
      onError: (error) => {
        this.pause();
        this.status.textContent = t("board.error", { detail: String(error) });
      },
    });
    this.sourceFile = bundle.document.sourceFile;
    this.sourceFileObject = view.file!;
    this.history = new BoardHistory(bundle.document, 100, bundle.recovery?.baseline);
    if(bundle.document.sourceType==="markdown")this.history.attachCompanion({capture:()=>this.integration.layout.snapshot(),restore:snapshot=>this.integration.layout.restore(snapshot)});
    this.recoveredDraft = !!bundle.recovery;
    this.conflict = !!bundle.recovery?.conflicted;
    this.ink = bundle.ink;
    this.activeLayerId = bundle.document.layers?.[0]?.id ?? "layer-default";
    this.root =
      view.containerEl.querySelector<HTMLElement>(".view-content") ??
      view.containerEl;
    this.root.classList.add("atl-board-active-vertical");
    this.ownerDocument = this.root.ownerDocument;
    this.win = this.ownerDocument.defaultView as Window & typeof globalThis;
    this.originalPosition = this.root.style.position;
    if (this.win.getComputedStyle(this.root).position === "static")
      this.root.style.position = "relative";
    this.canvas = this.root.ownerDocument.createElement("canvas");
    this.canvas.className = "atl-board-layer";
    this.canvas.setAttribute("aria-label", t("board.title"));
    this.canvas.tabIndex = 0;
    this.brushCursor = this.root.ownerDocument.createElement("div");
    this.brushCursor.className = "atl-board-brush-cursor";
    this.brushCursor.hidden = true;
    this.toolbar = this.root.ownerDocument.createElement("div");
    this.toolbar.className = "atl-board-toolbar atl-board-toolbar--vertical";
    this.toolbar.setAttribute("role", "toolbar");
    this.toolbar.setAttribute("aria-orientation", "vertical");
    this.toolbar.setAttribute("aria-label", t("board.title"));
    this.selectionBar = this.root.ownerDocument.createElement("div");
    this.selectionBar.className = "atl-board-selection-bar";
    this.selectionBar.hidden = true;
    this.selectionBar.setAttribute("role", "toolbar");
    this.selectionBar.setAttribute("aria-label", t("board.selectionActions"));
    this.selectionLabel = this.root.ownerDocument.createElement("span");
    this.selectionLabel.className = "atl-board-selection-label";
    const selectionDelete = this.root.ownerDocument.createElement("button");
    selectionDelete.type = "button";
    selectionDelete.textContent = t("board.remove");
    decorateBoardButton(selectionDelete, "remove");
    selectionDelete.onclick = () => this.remove();
    this.selectionBar.append(this.selectionLabel, selectionDelete);
    const tools = this.row(this.toolbar);
    tools.classList.add("atl-board-main-tools");
    for (const mode of [
      "read",
      "select",
      "pen",
      "erase",
      "partialErase",
      "text",
      "line",
      "arrow",
      "rect",
      "ellipse",
      "diamond",
      "connector",
      "fill",
    ] as Tool[])
      this.toolButtons.set(
        mode,
        this.button(tools, mode, () => this.setTool(mode)),
      );
    const brushPalette = (this.brushPalette = this.root.ownerDocument.createElement("div"));
    brushPalette.className = "atl-board-brush-palette";
    brushPalette.hidden = true;
    brushPalette.setAttribute("role", "menu");
    brushPalette.setAttribute("aria-label", t("board.brush"));
    for (const kind of BOARD_BRUSHES) {
      const option = this.root.ownerDocument.createElement("button");
      option.type = "button";
      option.dataset.brush = kind;
      option.setAttribute("role", "menuitemradio");
      const preview = this.root.ownerDocument.createElement("canvas");
      preview.className = "atl-board-brush-stroke";
      const label = this.root.ownerDocument.createElement("span");
      label.textContent = t(`board.${kind}`);
      option.append(preview, label);
      option.onclick = () => {
        this.brushWidths.set(this.brush.kind, this.width);
        this.brush = defaultBoardBrush(kind, this.nextSeed());
        this.width = this.brushWidths.get(kind) ?? BOARD_BRUSH_DEFAULT_WIDTHS[kind];
        this.sizeControl.setKind(kind, this.width);
        this.brushSelect.value = kind;
        this.opacityInput.value = String(this.brush.opacity);
        this.opacityOutput.value = `${Math.round(this.brush.opacity * 100)}%`;
        this.smoothingInput.value = String(this.brush.smoothing);
        this.smoothingOutput.value = `${Math.round(this.brush.smoothing * 100)}%`;
        this.pressureInput.checked = this.brush.pressure;
        this.closeBrushPalette();
        this.setTool("pen");
        this.updateBrushButton();
      };
      brushPalette.append(option);
      this.brushPreviewCanvases.set(kind, preview);
      paintBoardBrushPreview(preview, kind, Math.min(BOARD_BRUSH_DEFAULT_WIDTHS[kind], 26), this.color);
    }
    tools.append(brushPalette);
    const penButton = (this.penButton = this.toolButtons.get("pen")!);
    let brushHold = 0;
    penButton.onclick = () => {
      this.setTool("pen");
      brushPalette.hidden ? this.openBrushPalette() : this.closeBrushPalette();
      this.updateBrushButton();
    };
    penButton.onpointerdown = () => {
      brushHold = this.win.setTimeout(() => this.openBrushPalette(), 420);
    };
    penButton.onpointerup = penButton.onpointercancel = () => this.win.clearTimeout(brushHold);
    this.listen(this.ownerDocument, "pointerdown", event => {
      if (this.brushPalette.hidden) return;
      const target = event.target as Node;
      if (!this.brushPalette.contains(target) && !this.penButton.contains(target)) this.closeBrushPalette();
    }, true);
    this.listen(this.ownerDocument, "keydown", event => this.brushPaletteKey(event as KeyboardEvent), true);
    this.button(tools, "sticker", () => void this.stickerModal());
    const historyTools = this.row(tools);
    historyTools.classList.add("atl-board-history-tools");
    this.button(historyTools, "undo", () => this.undo());
    this.button(historyTools, "redo", () => this.redo());
    const more = this.root.ownerDocument.createElement("details");
    more.className = "atl-board-more";
    const summary = this.root.ownerDocument.createElement("summary");
    summary.textContent = "···";
    summary.title = t("board.more");
    summary.setAttribute("aria-label", t("board.more"));
    more.append(summary);
    const menu = this.root.ownerDocument.createElement("div");
    menu.className = "atl-board-more-menu";
    for (const [key, callback] of [
      ["remove", () => this.remove()],
      ["group", () => this.groupSelection(false)],
      ["ungroup", () => this.groupSelection(true)],
      ["duplicate", () => this.copySelection(true)],
      ["bringForward", () => this.reorderSelection(1)],
      ["sendBackward", () => this.reorderSelection(-1)],
      ["character", () => void this.characterModal()],
      ["saveSticker", () => this.saveSelectionCharacter("sticker")],
      ["layers", () => this.layerModal()],
      ["recognize", () => void this.recognizeSelection()],
      ["transcripts", () => this.showTranscripts()],
      ["drawSelection", () => this.drawSelectedText()],
      ["reuseReference", () => void this.reuseReference()],
      ["characterParts", () => this.characterParts()],
      ["settings", () => void this.options()],
      ["close", () => this.onClose()],
    ] as Array<[string, () => void]>)
      this.button(menu, key, () => {
        more.open = false;
        callback();
      });
    if (this.host.openStudioLibrary) {
      const openStudio = this.root.ownerDocument.createElement("button");
      openStudio.type = "button";
      openStudio.className = "atl-board-open-studio";
      openStudio.textContent = "Tutor 无限画布 · 新建或打开";
      openStudio.onclick = () => { more.open = false; this.host.openStudioLibrary?.(); };
      menu.prepend(openStudio);
    }
    more.append(menu);
    tools.append(more);
    this.propertyPanel = this.root.ownerDocument.createElement("details");
    this.propertyPanel.className = "atl-board-property-panel";
    this.toolbar.style.setProperty("--atl-board-stroke-color", this.color);
    const propertyToggle = this.root.ownerDocument.createElement("summary");
    propertyToggle.title = t("board.toolProperties");
    propertyToggle.setAttribute("aria-label", propertyToggle.title);
    propertyToggle.className = "atl-board-property-toggle";
    this.propertyPanel.append(propertyToggle);
    this.toolbar.append(this.propertyPanel);
    const properties = this.row(this.propertyPanel);
    properties.classList.add("atl-board-properties");
    const strokeSection = this.root.ownerDocument.createElement("section");
    strokeSection.className = "atl-board-property-section atl-board-stroke-section";
    const strokeHeading = this.root.ownerDocument.createElement("div");
    strokeHeading.className = "atl-board-property-heading";
    strokeHeading.textContent = t("board.strokeSettings");
    strokeSection.append(strokeHeading);
    properties.append(strokeSection);
    const colorRow = this.root.ownerDocument.createElement("label");
    colorRow.className = "atl-board-property-control atl-board-color-control";
    const colorLabel = this.root.ownerDocument.createElement("span");
    colorLabel.textContent = t("board.strokeColor");
    const color = (this.colorInput =
      this.root.ownerDocument.createElement("input"));
    color.type = "color";
    color.value = this.color;
    color.title = t("board.color");
    color.setAttribute("aria-label", color.title);
    color.oninput = () => {
      this.color = color.value;
      this.toolbar.style.setProperty("--atl-board-stroke-color", this.color);
      this.sizeControl.setColor(this.color);
      this.refreshBrushPreviews();
    };
    color.onchange = () => this.applySelectionStyle("color");
    colorRow.append(colorLabel, color);
    strokeSection.append(colorRow);
    this.sizeControl = new BrushSizeControl(strokeSection, {
      kind: this.brush.kind, color: this.color, value: this.width, min: 1, max: 64, compact: true, label: t("board.width"),
      onInput: value => { this.width = value; this.brushWidths.set(this.brush.kind, value); this.schedule(); },
      onCommit: value => { this.width = value; this.brushWidths.set(this.brush.kind, value); this.applySelectionStyle("width"); },
    });
    const brushRow = this.root.ownerDocument.createElement("label");
    brushRow.className = "atl-board-property-control";
    const brushLabel = this.root.ownerDocument.createElement("span");
    brushLabel.textContent = t("board.brushMaterial");
    brushRow.append(brushLabel);
    strokeSection.append(brushRow);
    this.brushSelect = this.makeSelect(brushRow, "brush", [...BOARD_BRUSHES]);
    this.brushSelect.value = this.brush.kind;
    this.brushSelect.onchange = () => {
      this.brushWidths.set(this.brush.kind, this.width);
      this.brush = defaultBoardBrush(
        this.brushSelect.value as BoardBrushKind,
        this.nextSeed(),
      );
      this.width = this.brushWidths.get(this.brush.kind) ?? BOARD_BRUSH_DEFAULT_WIDTHS[this.brush.kind];
      this.sizeControl.setKind(this.brush.kind, this.width);
      this.opacityInput.value = String(this.brush.opacity);
      this.opacityOutput.value = `${Math.round(this.brush.opacity * 100)}%`;
      this.smoothingInput.value = String(this.brush.smoothing);
      this.smoothingOutput.value = `${Math.round(this.brush.smoothing * 100)}%`;
      this.pressureInput.checked = this.brush.pressure;
      this.applySelectionStyle("brush");
      this.updateBrushButton();
    };
    this.opacityInput = this.root.ownerDocument.createElement("input");
    this.opacityInput.type = "range";
    this.opacityInput.min = "0.05";
    this.opacityInput.max = "1";
    this.opacityInput.step = "0.05";
    this.opacityInput.value = String(this.brush.opacity);
    this.opacityInput.title = t("board.opacity");
    this.opacityInput.setAttribute("aria-label", this.opacityInput.title);
    this.opacityOutput = this.root.ownerDocument.createElement("output");
    this.opacityOutput.value = `${Math.round(this.brush.opacity * 100)}%`;
    const opacityRow = this.root.ownerDocument.createElement("label");
    opacityRow.className = "atl-board-property-control atl-board-range-control";
    const opacityLabel = this.root.ownerDocument.createElement("span");
    opacityLabel.textContent = t("board.opacity");
    opacityRow.title = t("board.opacityHint");
    this.opacityInput.oninput = () => {
      this.brush.opacity = Number(this.opacityInput.value);
      this.opacityOutput.value = `${Math.round(this.brush.opacity * 100)}%`;
    };
    this.opacityInput.onchange = () => this.applySelectionStyle("brush");
    opacityRow.append(opacityLabel, this.opacityInput, this.opacityOutput);
    strokeSection.append(opacityRow);
    this.smoothingInput = this.root.ownerDocument.createElement("input");
    this.smoothingInput.type = "range";
    this.smoothingInput.min = "0";
    this.smoothingInput.max = "1";
    this.smoothingInput.step = "0.05";
    this.smoothingInput.value = String(this.brush.smoothing);
    this.smoothingInput.title = t("board.smoothing");
    this.smoothingInput.setAttribute("aria-label", this.smoothingInput.title);
    this.smoothingOutput = this.root.ownerDocument.createElement("output");
    this.smoothingOutput.value = `${Math.round(this.brush.smoothing * 100)}%`;
    const smoothingRow = this.root.ownerDocument.createElement("label");
    smoothingRow.className = "atl-board-property-control atl-board-range-control";
    const smoothingLabel = this.root.ownerDocument.createElement("span");
    smoothingLabel.textContent = t("board.smoothing");
    smoothingRow.title = t("board.smoothingHint");
    this.smoothingInput.oninput = () => {
      this.brush.smoothing = Number(this.smoothingInput.value);
      this.smoothingOutput.value = `${Math.round(this.brush.smoothing * 100)}%`;
    };
    this.smoothingInput.onchange = () => this.applySelectionStyle("brush");
    smoothingRow.append(smoothingLabel, this.smoothingInput, this.smoothingOutput);
    strokeSection.append(smoothingRow);
    const pressureWrap = this.root.ownerDocument.createElement("label");
    pressureWrap.className = "atl-board-checkbox";
    this.pressureInput = this.root.ownerDocument.createElement("input");
    this.pressureInput.type = "checkbox";
    this.pressureInput.checked = this.brush.pressure;
    this.pressureInput.onchange = () => {
      this.brush.pressure = this.pressureInput.checked;
      this.applySelectionStyle("brush");
    };
    pressureWrap.append(this.pressureInput, this.root.ownerDocument.createTextNode(t("board.pressure")));
    strokeSection.append(pressureWrap);
    const fillSection = this.root.ownerDocument.createElement("section");
    fillSection.className = "atl-board-property-section atl-board-fill-section";
    const fillHeading = this.root.ownerDocument.createElement("div");
    fillHeading.className = "atl-board-property-heading";
    fillHeading.textContent = t("board.fillSettings");
    const fillHint = this.root.ownerDocument.createElement("p");
    fillHint.className = "atl-board-property-hint";
    fillHint.textContent = t("board.fillHint");
    const fillRow = this.root.ownerDocument.createElement("div");
    fillRow.className = "atl-board-property-control atl-board-fill-control";
    fillSection.append(fillHeading, fillHint, fillRow);
    properties.append(fillSection);
    this.fillSelect = this.makeSelect(fillRow, "fill", ["none", "solid", "hachure", "dots", "paper", "brush"]);
    this.fillSelect.onchange = () => {
      const { brush: _previousBrush, ...fill } = this.fill;
      this.fill = { ...fill, kind: this.fillSelect.value as BoardFillStyle["kind"], seed: this.nextSeed(),
        ...(this.fillSelect.value === "brush" ? { brush: copy(this.brush) } : {}) };
      this.updateFillControl();
      this.applySelectionStyle("fill");
    };
    this.fillColorInput = this.root.ownerDocument.createElement("input");
    this.fillColorInput.type = "color";
    this.fillColorInput.value = this.fill.color;
    this.fillColorInput.title = t("board.fillColor");
    this.fillColorInput.setAttribute("aria-label", this.fillColorInput.title);
    this.fillColorInput.oninput = () => (this.fill.color = this.fillColorInput.value);
    this.fillColorInput.onchange = () => this.applySelectionStyle("fill");
    fillRow.append(this.fillColorInput);
    this.updateFillControl();
    this.shapeProperties = this.row(properties);
    this.styleSelect = this.makeSelect(this.shapeProperties, "drawingStyle", [
      "sketch",
      "clean",
    ]);
    this.styleSelect.onchange = () => {
      this.drawingStyle = this.styleSelect.value as "clean" | "sketch";
      this.applySelectionStyle("drawing");
    };
    this.textProperties = this.row(properties);
    this.fontSelect = this.makeSelect(this.textProperties, "font", [
      "handwritten",
      "sans",
    ]);
    this.fontSelect.onchange = () => {
      this.textStyle.font = this.fontSelect.value as BoardTextStyle["font"];
      this.applySelectionStyle("text");
    };
    this.fontSizeInput = this.root.ownerDocument.createElement("input");
    this.fontSizeInput.type = "number";
    this.fontSizeInput.min = "8";
    this.fontSizeInput.max = "96";
    this.fontSizeInput.value = String(this.textStyle.size);
    this.fontSizeInput.setAttribute("aria-label", t("board.fontSize"));
    this.fontSizeInput.title = t("board.fontSize");
    this.fontSizeInput.onchange = () => {
      this.textStyle.size = Math.min(
        96,
        Math.max(8, Number(this.fontSizeInput.value) || 24),
      );
      this.fontSizeInput.value = String(this.textStyle.size);
      this.applySelectionStyle("text");
    };
    this.textProperties.append(this.fontSizeInput);
    this.replyOverlay = new BoardReplyOverlay(this.root, {
      submit: () => this.requestNow(),
      pin: (text) => void this.pinReply(text),
      stop: () => this.host.conversation?.cancel(),
      retry: () => { void this.host.conversation?.retry(); },
      connection: () => this.host.conversation?.openConnectionSettings(),
      follow: () => {void this.host.conversation?.useChatConnectionAndRetry();},
    });
    this.prompt = this.replyOverlay.input;
    const ask = this.row(this.toolbar);
    ask.classList.add("atl-board-session-tools");
    this.togetherButton = this.button(ask, "together", () =>
      this.setTogether(!this.together),
    );
    this.status = this.root.ownerDocument.createElement("div");
    this.status.className = "atl-board-status";
    this.status.setAttribute("role", "status");
    this.status.textContent = t(this.conflict ? "board.recoveredConflict" : this.recoveredDraft ? "board.recoveredDraft" : "board.idle");
    this.status.title = this.status.textContent;
    this.toolbar.append(this.status);
    // 0.4.5 left this control behind on detach. Remove stale notices in this
    // concrete view when upgrading so they cannot reopen a disposed controller.
    for(const stale of this.root.querySelectorAll(":scope > .atl-board-layout-notice"))stale.remove();
    this.layoutNotice=this.ownerDocument.createElement("button");
    this.layoutNotice.className="atl-board-layout-notice";
    this.layoutNotice.hidden=true;
    this.layoutNotice.textContent=t("upgrade.drawingHidden");
    this.layoutNotice.onclick=()=>this.inspectHiddenDrawing();
    this.root.append(this.layoutNotice);
    this.root.append(
      this.canvas,
      this.brushCursor,
      this.selectionBar,
      this.toolbar,
    );
    this.slotViews=new BoardSlotViews(this.view.containerEl,()=>{this.finishGesture();this.layoutChanged();this.schedule();});
    this.setTool("read");
  }
  public bundle(): BoardBundle {
    return { document: copy(this.history.renderDocument), ink: copy(this.ink), layout:this.integration.layout.snapshot() };
  }
  /** A view can change files before async layout disposal has reached us. */
  public sourceIsCurrent(): boolean {
    return !this.disposed && !this.sourceMoving && this.root.isConnected && this.root.ownerDocument===this.ownerDocument &&
      this.view.containerEl.contains(this.root) && this.view.file===this.sourceFileObject &&
      this.sourceFileObject.path===this.sourceFile;
  }
  private surfaceInstance?: TutorBoardSurface;
  private localDrawingTasks?:TutorTaskCoordinator;
  public toolSurface(): TutorBoardSurface {
    if (this.surfaceInstance) return this.surfaceInstance;
    const source = this.sourceFile;
    return this.surfaceInstance = new TutorBoardSurface(this.history.renderDocument.id, "document", {
      version:()=>this.sourceRevision(),assets:()=>this.profiles,history: () => this.history, ink: () => this.ink, alive: () => this.sourceIsCurrent() && this.sourceFile === source,
      selection: () => [...this.selection],
      validateDraft: (objects) => {
        const current = this.history.renderDocument.objects;
        const previous = new Map(current.map(object => [object.id, object]));
        const changed = objects.filter(object => {
          const old = previous.get(object.id);
          return !old || !samePlacement(object, old);
        });
        if (!changed.length) return;
        // Refresh current source/slot geometry without repainting an unvalidated
        // preview. One batch can span multiple Markdown blocks or PDF pages.
        this.refreshSurfaces();
        const nextIds = new Set(objects.map(object => object.id));
        const exclude = new Set(current.filter(object => !nextIds.has(object.id)).map(object => object.id));
        for (const object of changed) exclude.add(object.id);
        const spaces = new Map<string, DrawingSpace>();
        const surfaces = this.objectSurfaces();
        for (const object of changed) {
          const surface = surfaces(object);
          if (!surface) throw new Error(t("upgrade.drawingSpaceChanged"));
          let space = spaces.get(surface.id);
          if (!space) { space = this.drawingSpace(surface, exclude, false, "placement", surfaces); spaces.set(surface.id, space); }
          if (!safeDrawingRect(space, objectClientBounds(object, surface.toClient()))) throw new Error(t("upgrade.drawingSpaceChanged"));
        }
        for (const object of changed) if (!previous.has(object.id)) object.groupId = `LAYOUT-${object.groupId}`;
        this.schedule();
      },
      capture: async () => {
        if (this.gesture || this.textEditor || this.editorState()?.composing) throw new Error("board-input-in-progress");
        const surface = this.currentVisibleSurface(); if (!surface) throw new Error("board-not-visible");
        const revision = this.history.revision, sourceRevision = this.sourceRevision();
        const selected = [...this.selection]; this.selection.clear(); this.draw();
        try {
          const rect = this.root.getBoundingClientRect();
          const snapshot = await captureBoardSnapshot(surface, [this.toolbar, this.selectionBar, this.replyOverlay.element], {x:rect.x,y:rect.y,width:rect.width,height:rect.height});
          if (!this.sourceIsCurrent() || revision !== this.history.revision || sourceRevision !== this.sourceRevision()) throw new Error("capture-source-changed");
          return snapshot;
        } finally { for (const id of selected) this.selection.add(id); this.schedule(); }
      },
      preview: async (objects,assets) => this.preview(objects ? {...this.bundle(), document: {...this.history.document, objects, vectorAssets:assets??this.history.renderDocument.vectorAssets}} : this.bundle()),
      changed: () => this.changed("tutor",false), save: async () => {
        let pending=this.save();
        // A human edit may coalesce this save into a newer queued snapshot.
        // Wait for that snapshot's durable write, not the skipped predecessor.
        for(;;){await pending;if(pending===this.savePromise)break;pending=this.savePromise;}
      },
    },this.host.transactions);
  }
  private drawingCommitContext(selected:readonly string[],signal?:AbortSignal):DrawingCommitContext {
    if(signal?.aborted||!this.sourceIsCurrent())throw new DOMException("Cancelled","AbortError");
    const surface=this.toolSurface(),document=this.history.document,baseRevision=`${document.revision}@${this.sourceRevision()}`;
    const active=this.host.conversation?.activeTask;
    if(this.host.conversation&&!active)throw new Error("drawing-task-unavailable");
    const tasks=this.host.conversation?.tasks??(this.localDrawingTasks??=new TutorTaskCoordinator());
    const task=active??tasks.start({clientId:"obsidian",target:{id:surface.id,source:this.sourceFile,revision:baseRevision,surface:"document"}});
    return {id:crypto.randomUUID(),taskId:task.id,targetId:surface.id,baseRevision,before:document.objects,humanObjectIds:[...selected],tasks,standalone:!active};
  }
  private async commitDrawing(context:DrawingCommitContext,after:readonly BoardObject[],signal?:AbortSignal):Promise<void>{
    try{
      if(this.pendingSlot){const prior=new Set(context.before.map(o=>o.id));for(const o of after)if(!prior.has(o.id))this.pendingBindings.set(o.id,{slotId:this.pendingSlot.spec.id,matrix:[1,0,0,1,0,0]});}
      await this.toolSurface().commitPreparedDrawing({...context,after,dependencies:[]},{clientId:"obsidian",targets:[context.targetId],read:true,write:true,humanObjectIds:context.humanObjectIds,learningMemory:false,onSurfaceCommit:receipt=>context.tasks.recordSurfaceCommit(receipt)},signal??context.tasks.signal(context.taskId,"obsidian"));
      if(context.standalone)context.tasks.complete(context.taskId,"obsidian");
    }catch(error){
      if(error instanceof SurfaceCommitError)context.tasks.recordSurfaceCommit(error.result.receipt,true);
      else context.tasks.fail(context.taskId,"obsidian","drawing-commit-failed","Drawing was not confirmed saved.");
      throw error;
    }
  }
  private connectConversation(): void {
    const conversation = this.host.conversation;
    if (!conversation) return;
    this.cleanup.push(conversation.registerBoard({
      id: this.conversationId,
      sourcePath: this.sourceFile,
      target: () => ({id:this.history.renderDocument.id,source:this.sourceFile,revision:String(this.history.revision),surface:"document"}),
      connection: () => resolveBoardConnection(this.host.settings()),
      canAuto: () => this.together && !this.conflict,
      isAvailable: () => this.sourceIsCurrent(),
      run: async (instruction, history, onReply, signal, referencePath, requiresDrawing, drawingPlan) => {
        const selected=[...this.selection];
        const turnId = ++this.turnSequence;
        this.activeTurn = turnId;
        this.preparingTurn = turnId;
        this.activeObservationMode = `${this.view.getMode?.()}:${this.editorState()?.mode}`;
        const cancel = () => {
          if (this.activeTurn !== turnId) return;
          this.agent?.cancel(); this.tutorPreview = [];
          this.status.textContent = t(this.together ? "board.idle" : "board.paused");
          this.schedule();
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          this.integration.claim(this);
          this.finishText(true);
          this.finishGesture();
          // Fonts can refine the just-committed text height. Complete those
          // derived revisions before sampling, without cancelling this intent.
          let pendingSave: Promise<void>;
          do {
            pendingSave = this.savePromise;
            await pendingSave;
            if (signal.aborted || this.disposed) throw new DOMException("Cancelled", "AbortError");
          } while (pendingSave !== this.savePromise);
          const started = Date.now();
          // Typing and IME transactions settle before their visual snapshot.
          while (this.editorState()?.composing || this.editorState()?.ready === false) {
            if (signal.aborted || this.disposed) throw new DOMException("Cancelled", "AbortError");
            if (Date.now() - started > 10_000) throw new Error(t("board.composing"));
            await new Promise<void>((resolve) => this.win.setTimeout(resolve, 32));
          }
          if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
          this.preparingTurn = 0;
          const independent=(requiresDrawing===true||!!drawingPlan)&&!(drawingPlan?.mode==="native"&&drawingPlan.placement==="annotation")&&!selected.length;
          if(independent)await this.prepareDrawingSlot(signal);
          const commit=this.drawingCommitContext(selected,signal);
          const reference = drawingPlan ? drawingPlan.mode === "reference" : requiresDrawing !== false && requestsReferencePainting(instruction);
          if (referencePath || reference) return await this.paintFromReference(
            instruction, onReply, signal, referencePath,
            drawingPlan?.mode === "reference" ? drawingPlan.prompt : instruction,
            drawingPlan?.mode === "reference" ? drawingPlan.style : undefined,
            commit,
          );
          this.annotationTurn=drawingPlan?.mode === "native" && drawingPlan.placement === "annotation";
          return await this.performAgent({ instruction, history, onReply, signal, requiresDrawing, math:drawingPlan?.mode === "math", annotation:drawingPlan?.mode === "native" && drawingPlan.placement === "annotation",commit });
        } finally {
          this.pendingSlot=undefined;this.pendingBindings.clear();this.slotSpecKey="";
          signal.removeEventListener("abort", cancel);
          if (this.preparingTurn === turnId) this.preparingTurn = 0;
          if (this.activeTurn === turnId) {
            this.activeTurn = 0;
            this.tutorPreview = [];
            this.schedule();
          }
        }
      },
    }));
    this.cleanup.push(conversation.subscribe((state) => {
      if (!state.busy) this.scheduler.wake();
      const sidebarVisible = conversation.isSidebarVisible(this.ownerDocument);
      if (this.sharedSidebarVisible !== undefined && this.sharedSidebarVisible !== sidebarVisible)
        this.sidebarTransitionUntil = this.win.performance.now() + 1000;
      this.sharedSidebarVisible = sidebarVisible;
      const belongsHere = state.latestBoardId === this.conversationId;
      this.replyOverlay.update({ text: state.latestReply, busy: state.busy, error: state.error,
        canRetry: state.canRetry, taskStatus: state.taskStatus, requestToEdit: state.requestToEdit, connectionFailure: state.failure?.recovery === "connection", execution:state.execution ? t("board.executionModel",{model:state.execution.model,engine:state.execution.engine}) : undefined, customConnection:state.execution?.mode === "custom",
        visible: belongsHere && !sidebarVisible });
    }));
  }
  public showQuickInput(): void {
    this.host.conversation?.activateBoard(this.conversationId);
    this.finishText(true);
    this.finishGesture();
    this.replyOverlay.showInput();
  }
  private drawSelectedText(): void {
    const text = this.history.renderDocument.objects.filter(o => this.selection.has(o.id) && o.kind === "text")
      .map(o => o.text ?? "").join("\n").trim() || this.sourceSelectionText();
    if (!text) { new Notice(t("board.selectDrawingText")); return; }
    void this.submitLayerTurn(requestsDrawing(text) ? text : `${t("board.drawSelection")}: ${text}`);
  }
  /** A selection from a different split is not this board's drawing prompt. */
  private sourceSelectionText(): string {
    const selection=this.ownerDocument.getSelection();
    return selection?.anchorNode && selection.focusNode && this.view.containerEl.contains(selection.anchorNode) &&
      this.view.containerEl.contains(selection.focusNode) ? selection.toString().trim() : "";
  }
  private async submitLayerTurn(text:string,options:Pick<TutorSubmitOptions,"route"|"referencePath"|"resolveIntent">={},kind:"drawing"|"conversation"="drawing"):Promise<void> {
    const conversation=this.host.conversation;
    if(!conversation||!text.trim()||this.layerInputPreparing||!this.sourceIsCurrent())return;
    this.finishText(true);this.finishGesture();
    const generation=this.generation,version=this.requestVersion();
    this.layerInputPreparing=true;
    try {
      const chat=await this.conversationContext();
      if(!this.sourceIsCurrent()||
        this.host.conversation!==conversation||this.generation!==generation||this.requestVersion()!==version)return;
      conversation.activateBoard(this.conversationId);
      // Release preparation before execution; the conversation owns cancellation
      // and any subsequent explicit request from this point onward.
      this.layerInputPreparing=false;
      void conversation.submit(text,{source:"board",boardId:this.conversationId,route:"board",...options,context:{chat},
        learningTurn:{entry:"board",kind,authority:localLearnerAuthority()}});
    }catch(error){
      if(!this.disposed)this.status.textContent=t("board.error",{detail:String(error)});
    }finally{this.layerInputPreparing=false;}
  }
  private async reuseReference():Promise<void> {
    try {
      const generation=this.generation;
      const references=await this.repository.references();
      if(!this.sourceIsCurrent()||this.generation!==generation)return;
      if(!references.length){new Notice(t("board.referenceEmpty"));return;}
      const modal=new Modal(this.host.app);modal.titleEl.textContent=t("board.reuseReference");
      for(const reference of references){
        const button=modal.contentEl.createEl("button",{text:reference.prompt||reference.path.split("/").pop()!});
        button.style.display="block";button.title=reference.path;
        button.onclick=()=>{modal.close();void this.submitLayerTurn(reference.prompt||t("board.reuseReference"),{referencePath:reference.path});};
      }
      modal.open();
    }catch(error){new Notice(t("board.error",{detail:String(error)}));}
  }
  private async paintFromReference(instruction: string, onReply: (delta: string) => void, signal: AbortSignal, savedReference?:string, imageBrief = instruction, paintStyle: ReferencePaintStyle = referencePaintPresets.illustration, commit=this.drawingCommitContext([...this.selection],signal)): Promise<{text:string}> {
    // Reject before paying for image generation, not after downloading pixels.
    const strokeBudget = Math.min(MAX_PREPARED_DRAWING_CHANGES, 20000 - this.history.renderDocument.objects.length);
    if (strokeBudget < 32) throw new Error(t("board.referenceCapacity"));
    const provider = savedReference ? null : this.host.createImageProvider?.();
    if (!savedReference) {
      if (!provider) throw new Error(t("board.imageProviderRequired"));
      const available = await provider.availability();
      if (!available.available) throw new Error(available.reason || t("board.imageProviderRequired"));
    }
    const surface = this.pendingSlot ? this.projections.get(this.pendingSlot.spec.id) : this.currentVisibleSurface();
    if (!surface) throw new Error(t("board.unavailable"));
    const space=this.drawingSpace(surface);
    const free=findDrawingRect(space,{width:420,height:420},{width:280,height:280});
    if(!free)throw new Error(t("upgrade.drawingSpaceChanged"));
    const revision = this.history.revision, sourceRevision = this.sourceRevision();
    let locallyCancelled = false;
    // Opening/selecting controls in the modal makes CM temporarily clear its
    // measured surfaces. The reference uses canonical anchor coordinates and
    // does not depend on a screenshot; retain it while that anchor is located.
    const anchorLocated = () => surface.anchor.kind === "markdown" && this.integration.registry
      ? this.integration.registry.resolve(surface.anchor)?.status === "located"
      : !!this.surfaceFor(surface.anchor);
    const valid = () => !locallyCancelled && !signal.aborted && this.sourceIsCurrent() && !this.conflict &&
      this.history.revision === revision && this.sourceRevision() === sourceRevision &&
      anchorLocated();
    const check = () => { if (!valid()) throw new Error(t("board.referenceCancelled")); };
    const requestId = uid("REFERENCE"), referencePath = `${this.repository.memoryRoot}/references/${requestId}.png`;
    const commitAbort=new AbortController();
    const cancel = () => {commitAbort.abort();provider?.cancel(requestId);};
    signal.addEventListener("abort", cancel, {once:true});
    onReply(t(savedReference ? "board.referencePreparing" : "board.referenceGenerating"));
    this.status.textContent = t(savedReference ? "board.referencePreparing" : "board.referenceGenerating");
    let objectUrl: string | undefined;
    try {
      check();
      const candidates = savedReference ? [{...(await this.repository.readReference(savedReference)),model:"saved-reference",latencyMs:0,
        provenance:{provider:"local-reference",generatedAt:now()}}] : await provider!.generate({requestId,
        prompt: `${imageBrief}\nCreate one finished reference image of the requested subject and composition, suitable for reconstruction with editable colored strokes. Preserve the requested subject, style and colors; use clear forms and readable color regions. Do not turn scenes, gardens or diagrams into characters. Do not add text, panels or an unrelated background unless requested.`,
        width:1024,height:1024,count:1,quality:"standard",transparent:false,thinking:false,watermark:false,
      },signal);
      check();
      const candidate = candidates[0];
      if (!candidate || candidate.bytes.byteLength > 20*1024*1024) throw new Error(t("board.referenceInvalid"));
      const extension = candidate.mimeType === "image/jpeg" ? "jpg" : candidate.mimeType === "image/webp" ? "webp" : "png";
      const path = savedReference ?? referencePath.replace(/png$/,extension);
      const bytes = candidate.bytes.slice().buffer as ArrayBuffer;
      objectUrl = this.win.URL.createObjectURL(new Blob([bytes],{type:candidate.mimeType}));
      const image = new this.win.Image(); image.src = objectUrl; await image.decode(); check();
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth*image.naturalHeight>25_000_000)
        throw new Error(t("board.referenceInvalid"));
      if(!savedReference) await this.repository.writeBinaryAsset(path, bytes);
      this.host.conversation?.rememberBoardReference(this.conversationId,path,signal);
      check();
      const canvas=this.ownerDocument.createElement("canvas"), scale=Math.min(1,384/Math.max(image.naturalWidth,image.naturalHeight));
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale)); canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const ctx=canvas.getContext("2d"); if(!ctx) throw new Error(t("board.referenceInvalid"));
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const clientTarget={x:free.x+12,y:free.y+12,width:Math.min(free.width-24,(free.height-24)*canvas.width/canvas.height),height:0};
      clientTarget.height=clientTarget.width*canvas.height/canvas.width;
      const target=mapRect(clientTarget,invertBoardMatrix(surface.toClient()));
      const group=uid("LAYOUT-REPAINT");
      const referencePixels={width:canvas.width,height:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data};
      let selectedStyle:ReferencePaintStyle={...paintStyle};
      let reconstruction=reconstructReference(referencePixels,target,surface.anchor,group,strokeBudget,selectedStyle);
      if(!reconstruction.objects.length) throw new Error(t("board.referenceInvalid"));
      check();
      const saveRecipe=()=>this.repository.writeBinaryAsset(path+(savedReference?'.'+requestId:'')+'.json',new TextEncoder().encode(JSON.stringify({
        format:"reference-repaint-v2",prompt:instruction,imageBrief,model:candidate.model,provenance:candidate.provenance,
        referencePath:path,groupId:group,generationLatencyMs:candidate.latencyMs,algorithm:"region-brush-v2",style:selectedStyle,
        samplingWidth:reconstruction.samplingWidth,samplingHeight:reconstruction.samplingHeight,
        regionCount:reconstruction.regionCount,strokeCount:reconstruction.objects.length,
      },null,2)).buffer as ArrayBuffer);
      await saveRecipe();
      check();
      let instant=false;
      const modal=new Modal(this.host.app);
      modal.titleEl.textContent=t("board.referenceTitle");
      modal.contentEl.classList.add("atl-reference-preview");
      const settings=modal.contentEl.createDiv({cls:"atl-reference-style"});
      const select=(labelKey:Parameters<typeof t>[0],name:string,values:readonly string[],labels:(value:string)=>string):HTMLSelectElement=>{
        const label=settings.createEl("label");label.createEl("span",{text:t(labelKey)});
        const input=label.createEl("select");input.dataset.referenceSetting=name;input.setAttribute("aria-label",t(labelKey));
        for(const value of values)input.createEl("option",{text:labels(value),value});
        return input;
      };
      const preset=select("board.referenceStyle","preset",["illustration","oil","crayon","watercolor","custom"],value=>t(`board.referencePreset_${value}`));
      const outline=select("board.referenceOutline","outline",BOARD_BRUSHES,value=>t(`board.${value}`));
      const colorMode=select("board.referenceColorMode","colorMode",["solid","brush"],value=>t(value==="solid"?"board.referenceSolid":"board.referenceBrushColor"));
      const colorBrush=select("board.referenceColorBrush","colorBrush",BOARD_BRUSHES,value=>t(`board.${value}`));
      const summary=modal.contentEl.createEl("p",{cls:"atl-reference-style-summary",attr:{"aria-live":"polite"}});
      const comparison=modal.contentEl.createDiv({cls:"atl-reference-comparison"});
      const original=comparison.createDiv(); original.createEl("strong",{text:t("board.referenceOriginal")});
      original.createEl("img",{attr:{src:objectUrl,alt:t("board.referenceOriginal")}});
      const rebuilt=comparison.createDiv(); rebuilt.createEl("strong",{text:t("board.referenceRebuilt")});
      const preview=rebuilt.createEl("canvas"); preview.width=420; preview.height=Math.round(target.height*420/target.width);
      const updateControls=()=>{
        outline.value=selectedStyle.outlineBrush;colorMode.value=selectedStyle.colorMode;colorBrush.value=selectedStyle.colorBrush;
        colorBrush.disabled=selectedStyle.colorMode!=="brush";
        preset.value=Object.entries(referencePaintPresets).find(([,style])=>style.outlineBrush===selectedStyle.outlineBrush&&style.colorMode===selectedStyle.colorMode&&style.colorBrush===selectedStyle.colorBrush)?.[0]??"custom";
      };
      let previewVersion=0,painting=false;
      const drawPreview=async()=>{
        const version=++previewVersion,objects=reconstruction.objects;
        play.disabled=finish.disabled=true;summary.textContent=t("board.referencePreviewPreparing");
        const previewCtx=preview.getContext("2d");
        if(previewCtx){
          previewCtx.clearRect(0,0,preview.width,preview.height);let deadline=this.win.performance.now()+12;
          for(let i=0;i<objects.length;i+=8){
            if(version!==previewVersion||painting)return;
            if(!valid()){locallyCancelled=true;modal.close();return;}
            previewCtx.save();
            try{previewCtx.scale(420/target.width,420/target.width);previewCtx.translate(-target.x,-target.y);
              renderBoardCanvas(previewCtx,objects.slice(i,i+8),{ink:{},characters:[]});}finally{previewCtx.restore();}
            if(this.win.performance.now()>deadline){await new Promise<void>(resolve=>{if(this.win.MessageChannel){const channel=new this.win.MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);}else this.win.setTimeout(resolve,0);});deadline=this.win.performance.now()+12;}
          }
        }
        if(version!==previewVersion||!valid()||painting)return;
        play.disabled=finish.disabled=false;
        summary.textContent=t("board.referenceRegions",{regions:reconstruction.regionCount,count:reconstruction.objects.length});
      };
      const refreshPreview=()=>{void drawPreview().catch(error=>{summary.textContent=t("board.error",{detail:String(error)});});};
      const changeStyle=()=>{
        if(!valid()||painting)return;
        reconstruction=reconstructReference(referencePixels,target,surface.anchor,group,strokeBudget,selectedStyle);
        this.host.conversation?.rememberBoardReference(this.conversationId,path,signal,selectedStyle);
        updateControls();refreshPreview();
      };
      preset.onchange=()=>{const style=referencePaintPresets[preset.value as keyof typeof referencePaintPresets];if(style){selectedStyle={...style};changeStyle();}};
      outline.onchange=()=>{selectedStyle={...selectedStyle,outlineBrush:outline.value as BoardBrushKind};changeStyle();};
      colorMode.onchange=()=>{selectedStyle={...selectedStyle,colorMode:colorMode.value as ReferencePaintStyle["colorMode"]};changeStyle();};
      colorBrush.onchange=()=>{selectedStyle={...selectedStyle,colorBrush:colorBrush.value as BoardBrushKind};changeStyle();};
      updateControls();
      modal.contentEl.createEl("p",{text:t("board.referenceExplanation")});
      modal.contentEl.createEl("p",{text:t("board.referenceSaved",{path})});
      const play=modal.contentEl.createEl("button",{text:t("board.referencePlay")});
      const finish=modal.contentEl.createEl("button",{text:t("board.referenceInstant")});
      const stop=modal.contentEl.createEl("button",{text:t("board.cancel")});
      let completed=false,committing=false;
      const controls=this.root.ownerDocument.createElement("div"); controls.className="atl-reference-play-controls";controls.hidden=true;
      const instantButton=controls.ownerDocument.createElement("button");instantButton.textContent=t("board.referenceInstant");instantButton.onclick=()=>{instant=true;};
      const cancelButton=controls.ownerDocument.createElement("button");cancelButton.textContent=t("board.cancel");cancelButton.onclick=()=>{locallyCancelled=true;modal.close();};
      controls.append(instantButton,cancelButton);this.root.append(controls);
      try {
        await new Promise<void>((resolve,reject)=>{
          const abort=()=>{modal.close();};
          modal.onClose=()=>{previewVersion++;signal.removeEventListener("abort",abort);if(!completed){locallyCancelled=true;commitAbort.abort();if(!committing)reject(new DOMException(t("board.referenceCancelled"),"AbortError"));}};
          signal.addEventListener("abort",abort,{once:true});
          const start=async()=>{
            if(play.disabled)return; painting=true;play.disabled=finish.disabled=true;
            modal.containerEl.style.display="none";controls.hidden=false;
            cancelButton.focus({preventScroll:true});
            try {
              check();
              const currentSurface=this.surfaceFor(surface.anchor)??surface;
              if(!safeDrawingRect(this.drawingSpace(currentSurface),rectUnion(reconstruction.objects.map(o=>objectClientBounds(o,currentSurface.toClient())))))throw new Error(t("upgrade.drawingSpaceChanged"));
              await saveRecipe();check();
              await playReferenceStrokes(reconstruction.objects,{signal,valid,instant:()=>instant||this.ownerDocument.hidden,
                preview:objects=>{this.tutorPreview=objects.map(object=>({type:"add" as const,object}));this.schedule();},
                wait:()=>new Promise<void>(resolve=>{
                  // Electron throttles timers in hidden windows. Finish an
                  // invisible animation rather than taking minutes per frame.
                  if(this.ownerDocument.hidden){resolve();return;}
                  const done=()=>{this.win.clearTimeout(timer);this.ownerDocument.removeEventListener("visibilitychange",done);signal.removeEventListener("abort",done);resolve();};
                  const timer=this.win.setTimeout(done,24);
                  this.ownerDocument.addEventListener("visibilitychange",done,{once:true});
                  signal.addEventListener("abort",done,{once:true});
                }),});
              check();
              const finalSurface=this.surfaceFor(surface.anchor)??surface;
              if(!safeDrawingRect(this.drawingSpace(finalSurface),rectUnion(reconstruction.objects.map(o=>objectClientBounds(o,finalSurface.toClient())))))throw new Error(t("upgrade.drawingSpaceChanged"));
              committing=true;
              await this.commitDrawing(commit,[...commit.before,...reconstruction.objects],commitAbort.signal);
              completed=true;this.tutorPreview=[];
              if(!signal.aborted&&!locallyCancelled&&!this.disposed){this.selection.clear();for(const o of reconstruction.objects)this.selection.add(o.id);this.setTool("select");}
              modal.close();resolve();
            } catch(error){completed=true;modal.close();reject(error);}
          };
          play.onclick=()=>{void start();};
          finish.onclick=()=>{instant=true;void start();};
          stop.onclick=()=>{modal.close();};
          if(signal.aborted){abort();return;}modal.open();refreshPreview();
        });
      } finally { modal.close();controls.remove();this.tutorPreview=[];this.schedule(); }
      if(!signal.aborted&&!this.disposed)this.status.textContent=t("board.saved");
      return {text:t("board.referenceDone",{count:reconstruction.objects.length,path})};
    } catch (error) {
      if (!this.disposed&&!signal.aborted) this.status.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      signal.removeEventListener("abort",cancel);
      if(objectUrl)this.win.URL.revokeObjectURL(objectUrl);
    }
  }
  private async pinReply(text: string): Promise<void> {
    if (!text.trim() || !this.sourceIsCurrent()) return;
    const sourceRevision = this.sourceRevision();
    await ensureBoardFonts(this.ownerDocument, text);
    if (!this.sourceIsCurrent() || sourceRevision !== this.sourceRevision()) return;
    const surface = this.currentVisibleSurface();
    if (!surface) return;
    this.invalidate();
    const viewport = this.root.getBoundingClientRect(), rect = surfaceRect(surface);
    const position = surface.unproject({ x: Math.max(rect.left, viewport.left) + 80,
      y: Math.max(rect.top, viewport.top) + 30 });
    const chars = [...text], group = uid("GROUP"), objects: BoardObject[] = [];
    let y = position.y;
    for (let offset = 0; offset < chars.length; offset += 480) {
      const part = chars.slice(offset, offset + 480).join("");
      const style: BoardTextStyle = { font: "handwritten", size: 22, align: "left" };
      const height = layoutBoardText(part, style, 300, boardTextMeasurer(this.ownerDocument)).height;
      objects.push({ id: uid("OBJ"), kind: "text", anchor: copy(surface.anchor),
        x: position.x, y, width: 300, height, text: part, textStyle: style,
        color: this.color, strokeWidth: 2, createdBy: "tutor", editedBy: "human",
        revision: 1, groupId: group, selectionGroupId: group });
      y += height + 10;
    }
    this.history.transact((doc) => doc.objects.push(...objects), "human");
    this.selection.clear();
    for (const object of objects) this.selection.add(object.id);
    this.setTool("select");
    this.changed();
  }
  private editorState(): BoardEditorStatus | undefined {
    return this.view.getMode?.() === "preview"
      ? undefined
      : this.integration.editors.getStatus(this.view.containerEl, this.sourceFile);
  }
  private syncAnchors(): boolean {
    const state = this.integration.registry?.snapshot();
    return state ? this.history.updateMarkdownAnchors(state) : false;
  }
  private pendingEditorChange = false;
  public editorChanged(event: BoardEditorEvent): void {
    if (this.disposed || this.view.getMode?.() === "preview") return;
    if (event.destroyed) {
      this.invalidate();
      this.schedule();
      return;
    }
    if (event.docChanged) {
      this.pendingEditorChange = true;
      this.finishGesture();
      this.invalidate(false, true);
    } else this.layoutChanged();
    if (event.state.composing) {
      this.schedule();
      return;
    }
    if (event.state.ready) {
      if (this.pendingEditorChange) {
        this.pendingEditorChange = false;
        const head = event.state.view.state.selection.main.head;
        const entry = this.integration.registry?.entries.find(
          (item) =>
            item.status === "located" && item.from <= head && item.to >= head,
        );
        if (entry)
          this.active =
            event.state.surfaces.find(
              (surface) =>
                surface.anchor.kind === "markdown" &&
                surface.anchor.key === entry.id,
            ) ?? this.active;
        if (this.syncAnchors()) {
          this.history.updateSourceRevision(this.sourceRevision());
          this.onChange(this.bundle(), this);
          void this.save().catch(() => undefined);
        }
        if (this.together && event.state.view.hasFocus) {
          this.integration.claim(this);
          this.scheduler.changed(this.requestVersion(), () => this.runAgent());
        }
      }
      this.scheduler.wake();
    }
    this.schedule();
  }
  public invalidateObservation(): void {
    this.invalidate();
  }
  private requestVersion(): string {
    return `${this.history.revision}:${this.sourceRevision()}:${this.integration.layout.revision}`;
  }
  private contentViewport(): HTMLElement | null {
    return (
      this.editorState()?.view.scrollDOM ??
      this.root.querySelector<HTMLElement>(
        this.view.file?.extension === "pdf"
          ? ".pdf-viewer-container"
          : ".markdown-preview-view",
      )
    );
  }
  public async initialize(): Promise<void> {
    await this.loadProfiles();
    this.syncAnchors();
    // Only load fonts used by this board. An empty board is immediately drawable.
    await ensureBoardFonts(this.ownerDocument, boardHandwrittenText(this.history.renderDocument.objects, this.profiles));
    if (this.disposed) return;
    this.listen(this.canvas, "pointerdown", (event) =>
      this.down(event as PointerEvent),
    );
    this.listen(this.canvas, "pointermove", (event) => {
      const pointer = event as PointerEvent;
      if (this.tool === "pen") positionBoardBrushCursor(this.brushCursor, pointer, this.brush.kind, this.width, this.root.getBoundingClientRect());
      else this.brushCursor.hidden = true;
      this.move(pointer);
    });
    this.listen(this.canvas, "pointerleave", () => { this.brushCursor.hidden = true; });
    this.listen(this.canvas, "pointerup", (event) =>
      this.up(event as PointerEvent),
    );
    this.listen(this.canvas, "dblclick", (event) => {
      const mouse = event as MouseEvent;
      const object = this.hit({ x: mouse.clientX, y: mouse.clientY });
      if (
        object?.kind === "text" &&
        (this.tool === "select" || this.tool === "text")
      ) {
        this.finishGesture();
        this.beginText(object, true);
        event.preventDefault();
        event.stopPropagation();
      } else if (object?.kind === "ink") {
        this.finishGesture();
        if (!this.selection.has(object.id)) {
          this.selection.clear();
          this.selectObject(object, true);
        }
        void this.recognizeSelection();
        event.preventDefault();
        event.stopPropagation();
      }
    });
    this.listen(this.canvas, "pointercancel", () => this.finishGesture());
    this.listen(this.canvas, "lostpointercapture", () => this.finishGesture());
    this.listen(this.canvas, "contextmenu", (event) => event.preventDefault());
    this.listen(this.canvas, "wheel", (event) => {
      const wheel = event as WheelEvent;
      if (wheel.ctrlKey || wheel.metaKey) return;
      const surface =
        this.surfaceAt({ x: wheel.clientX, y: wheel.clientY }) ??
        this.active ??
        this.surfaces[0];
      if (!surface) return;
      const slot="projectionId" in surface?this.slotViews.get((surface as BoardProjection).projectionId):undefined;
      const scroller = surface.viewportElement;
      const unit =
        wheel.deltaMode === 1
          ? 16
          : wheel.deltaMode === 2
            ? scroller.clientHeight
            : 1;
      wheel.preventDefault();
      this.finishGesture();
      this.invalidate();
      if(slot&&(wheel.deltaX||wheel.shiftKey))slot.scrollLeft+=(wheel.deltaX||wheel.deltaY)*unit;
      if(!wheel.shiftKey)scroller.scrollBy({left:slot?0:wheel.deltaX*unit,top:wheel.deltaY*unit});
      this.schedule();
    });
    this.layoutSize = this.resizeSize(this.root);
    this.connectConversation();
    this.listen(this.root, "pointerdown", (event) => {
      if (!this.replyOverlay.element.contains(event.target as Node))
        this.host.conversation?.activateBoard(this.conversationId);
    }, true);
    this.listen(this.root, "wheel", (event) => {
      if (!this.toolbar.contains(event.target as Node) && !this.replyOverlay.element.contains(event.target as Node))
        this.sidebarTransitionUntil = 0;
    }, true);
    // CM handles and can stop bubbling key events. Only this explicit board
    // shortcut runs in capture; ordinary text-editing keys retain native order.
    this.listen(this.root, "keydown", (event) => {
      const key = event as KeyboardEvent;
      if (this.isQuickInputShortcut(key)) this.key(key);
    }, true);
    this.listen(this.root, "keydown", (event) =>
      this.key(event as KeyboardEvent),
    );
    this.listen(
      this.root,
      "scroll",
      (event) => {
        // The command input can scroll horizontally when the caret moves.
        // That changes neither the source viewport nor its visual context.
        if (
          event.target instanceof this.win.Node &&
          (this.toolbar.contains(event.target) || this.replyOverlay.element.contains(event.target))
        )
          return;
        this.finishGesture();
        if (!(this.activeTurn && this.win.performance.now() < this.sidebarTransitionUntil)) this.invalidate();
        this.schedule();
      },
      true,
    );
    this.listen(this.win, "blur", () => {
      this.finishGesture();
      this.closeBrushPalette();
      this.pause();
    });
    this.listen(this.win, "resize", () => {
      this.layoutChanged();
      this.schedule();
    });
    this.listen(
      this.root,
      "transitionend",
      (event) => {
        if (this.toolbar.contains(event.target as Node) || this.replyOverlay.element.contains(event.target as Node)) return;
        this.layoutChanged();
        this.schedule();
      },
      true,
    );
    const observer = new this.win.MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !this.toolbar.contains(record.target) &&
            record.target !== this.toolbar &&
            !this.selectionBar.contains(record.target) &&
            record.target !== this.selectionBar &&
            record.target !== this.canvas &&
            !this.replyOverlay.element.contains(record.target) &&
            !this.textEditor?.element.contains(record.target) &&
            !this.editorState()?.view.dom.contains(record.target),
        )
      ) {
        this.layoutChanged();
        this.schedule();
      }
    });
    observer.observe(this.root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.cleanup.push(() => observer.disconnect());
    this.resizeObserver = new this.win.ResizeObserver((entries) => {
      let changed = false;
      for (const { target } of entries) {
        const before = this.resizeTargets.get(target);
        if (before === undefined) continue;
        const current = this.resizeSize(target);
        this.resizeTargets.set(target, current);
        if (before !== current) changed = true;
      }
      if (!changed || this.disposed) return;
      this.layoutChanged();
      this.schedule();
    });
    this.cleanup.push(() => {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.resizeTargets.clear();
    });
    this.schedule();
  }
  private layoutChanged(): void {
    const size = this.resizeSize(this.root), resized = size !== this.layoutSize;
    this.layoutSize = size;
    if (this.activeTurn && this.host.conversation) {
      if (this.activeObservationMode !== `${this.view.getMode?.()}:${this.editorState()?.mode}`) {
        this.invalidate();
        return;
      }
      if (resized) this.sidebarTransitionUntil = this.win.performance.now() + 1000;
      // A measurement changes the projection, not the captured lesson. The
      // capture checks its own layout; completed objects keep canonical anchors.
      // Text transactions, explicit scrolling, page changes and closure still cancel.
      return;
    }
    this.invalidate(true);
  }
  private resizeSize(element: Element): string {
    const rect = element.getBoundingClientRect();
    return `${rect.width}:${rect.height}`;
  }
  private updateResizeTargets(): void {
    if (!this.resizeObserver) return;
    const viewport = this.contentViewport();
    const targets = new Set<Element>([this.root]);
    if (viewport) {
      targets.add(viewport);
      // Images and fonts can reflow Markdown without changing the fixed
      // viewport or adding DOM nodes. One content section observer covers its
      // paragraphs without registering an observer for every drawing object.
      const section =
        this.view.file?.extension === "md"
          ? viewport.querySelector(".markdown-preview-section, .cm-content")
          : null;
      if (section) targets.add(section);
    }
    for (const target of this.resizeTargets.keys())
      if (!targets.has(target)) {
        this.resizeObserver.unobserve(target);
        this.resizeTargets.delete(target);
      }
    for (const target of targets)
      if (!this.resizeTargets.has(target)) {
        this.resizeTargets.set(target, this.resizeSize(target));
        this.resizeObserver.observe(target);
      }
  }
  private listen(
    target: EventTarget,
    type: string,
    handler: EventListener,
    capture = false,
  ): void {
    target.addEventListener(type, handler, capture);
    this.cleanup.push(() => target.removeEventListener(type, handler, capture));
  }
  private row(parent: HTMLElement): HTMLElement {
    const row = parent.ownerDocument.createElement("div");
    row.className = "atl-board-tools";
    parent.append(row);
    return row;
  }
  private button(
    parent: HTMLElement,
    key: string,
    click: () => void,
  ): HTMLButtonElement {
    const button = parent.ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = t(`board.${key}`);
    button.title = button.textContent;
    button.onclick = click;
    if (
      parent.closest(".atl-board-toolbar") &&
      !parent.closest(".atl-board-more-menu")
    )
      decorateBoardButton(button, key);
    parent.append(button);
    return button;
  }
  private makeSelect(
    parent: HTMLElement,
    key: string,
    values: string[],
  ): HTMLSelectElement {
    const select = parent.ownerDocument.createElement("select");
    select.setAttribute("aria-label", t(`board.${key}`));
    select.title = t(`board.${key}`);
    for (const value of values) {
      const option = parent.ownerDocument.createElement("option");
      option.value = value;
      option.textContent = t(`board.${value}`);
      select.append(option);
    }
    parent.append(select);
    return select;
  }
  private updateProperties(): void {
    const selected = this.history.renderDocument.objects.filter((o) =>
      this.selection.has(o.id),
    );
    const text = selected.find((o) => o.kind === "text");
    this.textProperties.hidden = this.tool !== "text" && !text;
    this.shapeProperties.hidden = !(
      ["line", "arrow", "rect", "ellipse", "diamond", "connector"].includes(this.tool) ||
      (this.tool === "select" &&
        selected.some((o) =>
          ["path", "arrow", "rect", "ellipse"].includes(o.kind),
        ))
    );
    if (text) {
      this.textStyle = { ...resolvedBoardTextStyle(text) };
      this.fontSelect.value = this.textStyle.font;
      this.fontSizeInput.value = String(this.textStyle.size);
    }
    const first = selected[0];
    if (first) {
      this.color = /^#[\da-f]{6}00$/i.test(first.color) && first.fill ? first.fill.color : first.color;
      this.width = first.strokeWidth;
      this.colorInput.value = /^#[0-9a-f]{6}$/i.test(this.color)
        ? this.color
        : "#7062b5";
      this.toolbar.style.setProperty("--atl-board-stroke-color", this.colorInput.value);
      this.sizeControl.setColor(this.colorInput.value);
      this.refreshBrushPreviews();
      this.sizeControl.setValue(this.width);
      if (first.brush) {
        this.brush = copy(first.brush);
        this.brushWidths.set(this.brush.kind, this.width);
        this.sizeControl.setKind(this.brush.kind, this.width);
        this.brushSelect.value = this.brush.kind;
        this.opacityInput.value = String(this.brush.opacity);
        this.opacityOutput.value = `${Math.round(this.brush.opacity * 100)}%`;
        this.smoothingInput.value = String(this.brush.smoothing);
        this.smoothingOutput.value = `${Math.round(this.brush.smoothing * 100)}%`;
        this.pressureInput.checked = this.brush.pressure;
      }
      if (first.fill) {
        this.fill = copy(first.fill);
        this.fillSelect.value = this.fill.kind;
        this.fillColorInput.value = /^#[0-9a-f]{6}$/i.test(this.fill.color)
          ? this.fill.color
          : "#f1c75b";
        this.updateFillControl();
      }
      if (first.layerId) this.activeLayerId = first.layerId;
    }
  }
  private applySelectionStyle(
    which: "color" | "width" | "text" | "drawing" | "brush" | "fill",
  ): void {
    if (!this.selection.size) return;
    this.invalidate();
    const measure = boardTextMeasurer(this.ownerDocument);
    this.history.transact((doc) => {
      for (const object of doc.objects) {
        if (!this.selection.has(object.id)) continue;
        if (which === "color") object.color = this.color;
        if (which === "width") object.strokeWidth = this.width;
        if (which === "brush" && object.kind === "ink")
          object.brush = { ...copy(this.brush), seed: object.brush?.seed ?? this.nextSeed() };
        if (which === "fill" && ["path", "rect", "ellipse"].includes(object.kind))
          object.fill = { ...copy(this.fill), seed: object.fill?.seed ?? this.nextSeed() };
        if (which === "text" && object.kind === "text") {
          object.textStyle = copy(this.textStyle);
          const layout = layoutBoardText(
            object.text ?? "",
            object.textStyle,
            object.width,
            measure,
          );
          object.height = layout.height;
      const attachment=this.pendingBindings.get(object.id);if(attachment&&this.integration.layout.snapshot().slots.some(s=>s.id===attachment.slotId))this.integration.layout.attach(object,attachment.slotId,attachment.matrix);
        }
        if (
          which === "drawing" &&
          ["path", "arrow", "rect", "ellipse"].includes(object.kind)
        )
          object.drawingStyle = {
            kind: this.drawingStyle,
            seed: object.drawingStyle?.seed ?? this.nextSeed(),
          };
      }
    }, "human");
    this.changed();
  }
  private nextSeed(): number {
    return this.win.crypto.getRandomValues(new Uint32Array(1))[0]!;
  }
  private layerModal(): void {
    this.finishGesture();
    const modal = new Modal(this.host.app);
    modal.titleEl.textContent = t("board.layers");
    modal.contentEl.addClass("atl-board-layers-modal");
    const list = modal.contentEl.createDiv({ cls: "atl-board-layer-list" });
    const render = () => {
      list.replaceChildren();
      const layers = [...(this.history.renderDocument.layers ?? [])].sort(
        (a, b) => a.order - b.order,
      );
      for (const [index, layer] of layers.entries()) {
        const row = list.createDiv({ cls: "atl-board-layer-row" });
        const active = row.createEl("input", { type: "radio" });
        active.name = `atl-board-layer-${this.conversationId}`;
        active.checked = layer.id === this.activeLayerId;
        active.setAttribute("aria-label", t("board.activeLayer"));
        active.onchange = () => {
          this.activeLayerId = layer.id;
        };
        const name = row.createEl("input", { type: "text" });
        name.value = layer.name;
        name.setAttribute("aria-label", t("board.layerName"));
        name.onchange = () => {
          const value = name.value.trim();
          if (!value) return;
          this.history.transact((doc) => {
            const target = doc.layers?.find((candidate) => candidate.id === layer.id);
            if (target) target.name = value;
          }, "human");
          this.changed();
        };
        const visible = row.createEl("input", { type: "checkbox" });
        visible.checked = layer.visible;
        visible.title = t("board.visible");
        visible.onchange = () => {
          this.history.transact((doc) => {
            const target = doc.layers?.find((candidate) => candidate.id === layer.id);
            if (target) target.visible = visible.checked;
          }, "human");
          this.changed();
        };
        const locked = row.createEl("input", { type: "checkbox" });
        locked.checked = layer.locked;
        locked.title = t("board.locked");
        locked.onchange = () => {
          this.history.transact((doc) => {
            const target = doc.layers?.find((candidate) => candidate.id === layer.id);
            if (target) target.locked = locked.checked;
          }, "human");
          this.changed();
        };
        const opacity = row.createEl("input", { type: "range" });
        opacity.min = "0.05";
        opacity.max = "1";
        opacity.step = "0.05";
        opacity.value = String(layer.opacity);
        opacity.title = t("board.opacity");
        opacity.onchange = () => {
          this.history.transact((doc) => {
            const target = doc.layers?.find((candidate) => candidate.id === layer.id);
            if (target) target.opacity = Number(opacity.value);
          }, "human");
          this.changed();
        };
        const blend = this.makeSelect(row, "blendMode", ["normal", "multiply", "screen"]);
        blend.value = layer.blendMode;
        blend.onchange = () => {
          this.history.transact((doc) => {
            const target = doc.layers?.find((candidate) => candidate.id === layer.id);
            if (target) target.blendMode = blend.value as "normal" | "multiply" | "screen";
          }, "human");
          this.changed();
        };
        const up = this.button(row, "moveUp", () => reorder(index, -1));
        const down = this.button(row, "moveDown", () => reorder(index, 1));
        up.disabled = index === 0;
        down.disabled = index === layers.length - 1;
        const remove = this.button(row, "removeLayer", () => {
          if (layers.length <= 1) return;
          const fallback = layers.find((candidate) => candidate.id !== layer.id)!;
          this.history.transact((doc) => {
            for (const object of doc.objects)
              if (object.layerId === layer.id) object.layerId = fallback.id;
            doc.layers = doc.layers
              ?.filter((candidate) => candidate.id !== layer.id)
              .map((candidate, order) => ({ ...candidate, order }));
          }, "human");
          if (this.activeLayerId === layer.id) this.activeLayerId = fallback.id;
          this.changed();
          render();
        });
        remove.disabled = layers.length <= 1;
      }
    };
    const reorder = (index: number, offset: number) => {
      this.history.transact((doc) => {
        const ordered = [...(doc.layers ?? [])].sort((a, b) => a.order - b.order);
        const other = ordered[index + offset];
        const current = ordered[index];
        if (!current || !other) return;
        [current.order, other.order] = [other.order, current.order];
      }, "human");
      this.changed();
      render();
    };
    const background = modal.contentEl.createDiv({ cls: "atl-board-background-row" });
    background.createEl("span", { text: t("board.background") });
    const backgroundSelect = this.makeSelect(background, "background", [
      "plain",
      "dark",
      "lined",
      "grid",
      "dots",
      "paper",
    ]);
    backgroundSelect.value = this.history.renderDocument.background?.kind ?? "plain";
    backgroundSelect.onchange = () => {
      this.history.transact((doc) => {
        const kind = backgroundSelect.value as NonNullable<BoardDocument["background"]>["kind"];
        doc.background = {
          kind,
          color: kind === "dark" ? "#202124" : "#fffdf7",
          spacing: doc.background?.spacing ?? 24,
          opacity: doc.background?.opacity ?? 1,
        };
      }, "human");
      this.changed();
    };
    const actions = modal.contentEl.createDiv({ cls: "atl-board-layer-actions" });
    this.button(actions, "addLayer", () => {
      const id = uid("LAYER");
      this.history.transact((doc) => {
        doc.layers ??= [];
        doc.layers.push({
          id,
          name: `${t("board.layerName")} ${doc.layers.length + 1}`,
          order: doc.layers.length,
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: "normal",
        });
      }, "human");
      this.activeLayerId = id;
      this.changed();
      render();
    });
    this.button(actions, "close", () => modal.close());
    render();
    modal.open();
  }
  private async confirmCloudRecognition(): Promise<boolean> {
    if (this.host.settings().boardCloudRecognitionConsent) return true;
    return await new Promise<boolean>((resolve) => {
      const modal = new Modal(this.host.app);
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
        modal.close();
      };
      modal.titleEl.textContent = t("board.recognitionConsentTitle");
      modal.contentEl.createEl("p", { text: t("board.recognitionConsent") });
      const actions = modal.contentEl.createDiv({ cls: "atl-board-layer-actions" });
      this.button(actions, "allow", () => {
        this.host.settings().boardCloudRecognitionConsent = true;
        void this.host.saveSettings();
        finish(true);
      });
      this.button(actions, "cancel", () => finish(false));
      modal.onClose = () => {
        if (!settled) resolve(false);
      };
      modal.open();
    });
  }
  private recognitionImage(objects: readonly BoardObject[]): {
    imageBase64: string;
    width: number;
    height: number;
  } | null {
    if (!objects.length) return null;
    const left = Math.min(...objects.map((object) => object.x));
    const top = Math.min(...objects.map((object) => object.y));
    const right = Math.max(...objects.map((object) => object.x + object.width));
    const bottom = Math.max(...objects.map((object) => object.y + object.height));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const margin = 24;
    const scale = Math.min(3, 1600 / Math.max(width, height));
    const canvas = this.ownerDocument.createElement("canvas");
    canvas.width = Math.max(64, Math.ceil((width + margin * 2) * scale));
    canvas.height = Math.max(64, Math.ceil((height + margin * 2) * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale);
    context.translate(margin - left, margin - top);
    renderBoardCanvas(
      context,
      objects.map((object) => ({
        ...object,
        color: "#101010",
        opacity: 1,
        blendMode: "normal",
        brush: object.brush ? { ...object.brush, opacity: 1 } : undefined,
      })),
      { ink: this.ink, characters: [], layers: this.history.renderDocument.layers, vectorAssets: this.history.renderDocument.vectorAssets },
    );
    const url = canvas.toDataURL("image/png");
    return { imageBase64: url.slice(url.indexOf(",") + 1), width, height };
  }
  private async recognizeSelection(): Promise<void> {
    const selected = this.history.renderDocument.objects.filter(
      (object) => this.selection.has(object.id) && object.kind === "ink" && object.inkId,
    );
    if (!selected.length) {
      new Notice(t("board.recognitionEmpty"));
      return;
    }
    const anchor = anchorKey(selected[0]!.anchor);
    const objects = selected.filter((object) => anchorKey(object.anchor) === anchor);
    const ids=objects.map(object=>object.id),fingerprint=inkSelectionFingerprint(objects,this.ink);
    const current=()=>this.sourceIsCurrent()&&isCurrentInkSelection(ids,fingerprint,this.history.renderDocument.objects,this.ink);
    const crop = this.recognitionImage(objects);
    if (!crop || !(await this.confirmCloudRecognition())) return;
    const provider = this.host.createRecognitionProvider?.();
    if (!provider) {
      new Notice(t("board.recognitionUnavailable", { detail: "no-provider" }));
      return;
    }
    const availability = await provider.availability();
    if (!availability.available) {
      new Notice(t("board.recognitionUnavailable", { detail: availability.reason ?? "" }));
      return;
    }
    this.status.textContent = t("board.recognizing");
    this.recognitionAbort?.abort();
    const controller = this.recognitionAbort = new AbortController();
    try {
      if(!current())throw new Error(t("board.recognitionStale"));
      const result = await provider.recognize({
        strokes: objects.flatMap((object) => {
          const stroke = object.inkId ? this.ink[object.inkId] : undefined;
          return stroke ? [stroke] : [];
        }),
        languages: ["zh-CN", "en"],
        textContext: this.active?.text.slice(0, 1200),
        writingArea: { width: crop.width, height: crop.height },
        imageBase64: crop.imageBase64,
      }, controller.signal);
      if(controller.signal.aborted)return;
      if(!current())throw new Error(t("board.recognitionStale"));
      const modal = new Modal(this.host.app);
      modal.titleEl.textContent = t("board.recognitionResult");
      const editor = modal.contentEl.createEl("textarea");
      editor.value = result.text;
      editor.rows = 5;
      editor.setAttribute("aria-label", t("board.recognitionResult"));
      if (result.alternatives.length) {
        const alternatives = modal.contentEl.createDiv({ cls: "atl-board-recognition-alternatives" });
        for (const alternative of result.alternatives) {
          const button = alternatives.createEl("button", { text: alternative });
          button.type = "button";
          button.onclick = () => (editor.value = alternative);
        }
      }
      const actions = modal.contentEl.createDiv({ cls: "atl-board-layer-actions" });
      let saved=false;const transcriptId=uid("SEMANTIC");
      const save=async(send:boolean)=>{
        const text=editor.value.trim();if(!text||saved)return;
        if(!current()){new Notice(t("board.recognitionStale"));return;}
        saved=true;const timestamp=now(),group={id:transcriptId,objectIds:ids,kind:"handwriting" as const,confidence:result.confidence??0.5,recognition:{...result,text,recognizedAt:timestamp,userCorrected:text!==result.text},createdAt:timestamp,updatedAt:timestamp};
        try{
          this.history.transact(doc=>{doc.semanticGroups??=[];doc.semanticGroups=doc.semanticGroups.filter(item=>item.id!==transcriptId);doc.semanticGroups.push(group);},"human");
          this.changed();await this.save();
          if(!current())throw new Error(t("board.recognitionStale"));
          await this.repository.saveTranscript(this.history.document,group,this.host.app.vault.getName());
          modal.close();
          if(send)void this.submitLayerTurn(text,{route:"chat",resolveIntent:false},"conversation");
        }catch(error){saved=false;new Notice(t("board.recognitionFailed",{detail:String(error)}));}
      };
      this.button(actions,"save",()=>void save(false));
      this.button(actions,"saveAndAsk",()=>void save(true));
      this.button(actions, "cancel", () => modal.close());
      modal.open();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        new Notice(t("board.recognitionFailed", { detail: String(error) }));
    } finally {
      this.status.textContent = t("board.idle");
    }
  }
  public revealInk(ids:readonly string[]):void{
    this.selection.clear();for(const object of this.history.renderDocument.objects)if(ids.includes(object.id))this.selection.add(object.id);
    this.setTool("select");this.updateProperties();this.schedule();
    const object=this.history.renderDocument.objects.find(object=>this.selection.has(object.id)),surface=object?this.objectSurface(object):undefined;
    surface?.element?.scrollIntoView?.({block:"center"});
  }
  private showTranscripts():void{
    const modal=new Modal(this.host.app);modal.titleEl.textContent=t("board.transcripts");
    for(const group of this.history.renderDocument.semanticGroups??[]){if(!group.recognition)continue;
      const row=modal.contentEl.createDiv();row.createEl("p",{text:group.recognition.text});
      this.button(row,"locateInk",()=>{this.revealInk(group.objectIds);modal.close();});
      this.button(row,"send",()=>{void this.submitLayerTurn(group.recognition!.text,{route:"chat",resolveIntent:false},"conversation");modal.close();});
    }modal.open();
  }
  private characterParts():void {
    const modal=new Modal(this.host.app);modal.titleEl.textContent=t("board.characterParts");
    modal.contentEl.createEl("p",{text:t("board.partHelp")});
    const parts=new Map<string,{name:string;ids:string[]}>();
    for(const object of this.history.renderDocument.objects){
      const part=object.characterPart;if(!part)continue;
      const entry=parts.get(part.id)??{name:part.name,ids:[]};entry.ids.push(object.id);parts.set(part.id,entry);
    }
    for(const part of parts.values()){
      const button=modal.contentEl.createEl("button",{text:part.name});
      button.onclick=()=>{this.selection.clear();for(const id of part.ids)this.selection.add(id);this.setTool("select");this.updateProperties();this.schedule();modal.close();};
    }
    const selected=new Set(this.selection);
    if(selected.size){
      const name=modal.contentEl.createEl("input",{type:"text",placeholder:t("board.partName")});name.maxLength=80;name.setAttribute("aria-label",t("board.partName"));
      this.button(modal.contentEl,"save",()=>{
        if(!name.value.trim()){name.focus();return;}
        const part={id:uid("PART"),name:name.value.trim().slice(0,80)};
        this.invalidate();
        this.history.transact(doc=>{for(const object of doc.objects)if(selected.has(object.id)){
          object.characterPart=part;object.selectionGroupId=part.id;
        }},"human");
        this.changed();modal.close();
      });
    }
    this.button(modal.contentEl,"cancel",()=>modal.close());modal.open();
  }
  private groupSelection(ungroup: boolean): void {
    if (this.selection.size < (ungroup ? 1 : 2)) return;
    const id = uid("SELECTION");
    this.invalidate();
    this.history.transact((doc) => {
      for (const object of doc.objects)
        if (this.selection.has(object.id)) {
          if (ungroup) delete object.selectionGroupId;
          else object.selectionGroupId = id;
        }
    }, "human");
    this.changed();
  }
  private selectObject(object: BoardObject, individual = false): void {
    this.selection.add(object.id);
    if (object.selectionGroupId && !individual)
      for (const other of this.history.renderDocument.objects)
        if (other.selectionGroupId === object.selectionGroupId)
          this.selection.add(other.id);
    this.updateProperties();
  }
  private selectionBounds(
    objects: readonly BoardObject[],
    surfaces = this.objectSurfaces(),
  ): BoardRect | undefined {
    const corners = objects
      .filter((o) => this.selection.has(o.id))
      .flatMap((o) => {
        const surface = surfaces(o);
        if (!surface) return [];
        const box = clientBounds(o, surface);
        return [
          { x: box.x, y: box.y },
          { x: box.x + box.width, y: box.y + box.height },
        ];
      });
    return corners.length ? bounds(corners) : undefined;
  }
  private updateSelectionBar(
    objects: readonly BoardObject[],
    rootRect: DOMRect,
    surfaces = this.objectSurfaces(),
  ): void {
    const box = this.tool === "select" ? this.selectionBounds(objects, surfaces) : undefined;
    if (!box || !this.selection.size) {
      this.selectionBar.hidden = true;
      return;
    }
    const label = `${t("board.selected", {
      count: this.selection.size,
    })} · ${t("board.dragSelection")}`;
    if (this.selectionLabel.textContent !== label)
      this.selectionLabel.textContent = label;
    this.selectionBar.hidden = false;
    const barRect = this.selectionBar.getBoundingClientRect();
    const width = Math.max(156, barRect.width);
    const height = Math.max(44, barRect.height);
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(
        rootRect.width - width - margin,
        box.x - rootRect.left + box.width / 2 - width / 2,
      ),
    );
    const above = box.y - rootRect.top - height - 12;
    const top = above >= margin
      ? above
      : Math.min(rootRect.height - height - margin, box.y - rootRect.top + box.height + 12);
    this.selectionBar.style.left = `${left}px`;
    this.selectionBar.style.top = `${Math.max(margin, top)}px`;
  }
  private beginText(object: BoardObject, existing: boolean): void {
    this.finishText(true);
    this.invalidate();
    const surface = this.objectSurface(object);
    if (!surface) return;
    const textarea = this.ownerDocument.createElement("textarea");
    textarea.className = "atl-board-text-editor";
    textarea.placeholder = t("board.textPlaceholder");
    textarea.title = t("board.textHint");
    textarea.setAttribute("aria-label", t("board.text"));
    textarea.value = object.text ?? "";
    textarea.spellcheck = false;
    const style = resolvedBoardTextStyle(object);
    textarea.style.font = boardFontCss(style);
    textarea.style.textAlign = style.align;
    textarea.style.color = object.color;
    textarea.style.width = `${object.width}px`;
    const angle = object.rotation ?? 0,
      c = Math.cos(angle),
      s = Math.sin(angle),
      [a, b, d, e] = surface.toClient();
    const origin = surface.project({ x: object.x, y: object.y }),
      root = this.root.getBoundingClientRect();
    textarea.style.left = `${origin.x - root.left}px`;
    textarea.style.top = `${origin.y - root.top}px`;
    textarea.style.transform = `matrix(${a * c + d * s},${b * c + e * s},${-a * s + d * c},${-b * s + e * c},0,0)`;
    const resize = () => {
      const layout = layoutBoardText(
        textarea.value || " ",
        style,
        object.width,
        boardTextMeasurer(this.ownerDocument),
      );
      textarea.style.height = `${Math.max(style.size * 1.5, layout.height)}px`;
    };
    textarea.oninput = () => {
      resize();
      void ensureBoardFonts(this.ownerDocument, textarea.value)
        .then(resize)
        .catch(() => undefined);
    };
    textarea.onkeydown = (event) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.finishText(false);
        this.canvas.focus({ preventScroll: true });
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.finishText(true);
        this.canvas.focus({ preventScroll: true });
      }
    };
    textarea.onblur = () => this.finishText(true);
    this.textEditor = { element: textarea, object: copy(object), existing };
    this.root.append(textarea);
    resize();
    textarea.focus();
    if (existing) textarea.select();
    void ensureBoardFonts(this.ownerDocument, textarea.value)
      .then(() => {
        resize();
        this.schedule();
      })
      .catch(() => undefined);
    this.schedule();
  }
  private finishText(commit: boolean): void {
    const edit = this.textEditor;
    if (!edit) return;
    this.textEditor = null;
    edit.element.onblur = null;
    const value = edit.element.value;
    edit.element.remove();
    if (commit && value.trim()) {
      const object = {
        ...edit.object,
        text: value,
        textStyle: resolvedBoardTextStyle(edit.object),
      };
      const layout = layoutBoardText(
        value,
        object.textStyle,
        object.width,
        boardTextMeasurer(this.ownerDocument),
      );
      object.height = layout.height;
      this.history.transact((doc) => {
        const index = doc.objects.findIndex((o) => o.id === object.id);
        if (edit.existing) {
          if (index >= 0) doc.objects[index] = object;
        } else doc.objects.push(object);
      }, "human");
      this.selection.clear();
      this.selectObject(object, true);
      if (!edit.existing || edit.object.text !== value)
        this.integration.coordination.textCommitted(object.id);
      this.changed();
    }
    this.schedule();
  }
  private setTool(tool: Tool): void {
    if (tool !== "read" && this.editorState()?.composing) {
      this.status.textContent = t("board.composing");
      return;
    }
    this.finishText(true);
    this.finishGesture();
    if (tool !== "pen") this.closeBrushPalette();
    this.tool = tool;
    if (tool !== "read" && this.editorState())
      this.canvas.focus({ preventScroll: true });
    this.canvas.style.pointerEvents = tool === "read" ? "none" : "auto";
    this.canvas.style.cursor =
      tool === "pen" ? "crosshair" : ["erase", "partialErase"].includes(tool) ? "cell" : "default";
    this.canvas.dataset.atlBoardInput = tool === "read" ? "false" : "true";
    for (const [mode, button] of this.toolButtons)
      button.setAttribute("aria-pressed", String(mode === tool));
    this.host.dismissPdfSelection();
    this.updateProperties();
    if (tool === "read" || tool === "erase" || tool === "partialErase") this.propertyPanel.open = false;
    this.schedule();
  }
  private updateBrushButton(): void {
    const button = this.toolButtons.get("pen");
    if (!button) return;
    const name = t(`board.${this.brush.kind}`);
    button.dataset.brushName = name;
    button.title = `${t("board.pen")} · ${name}`;
    button.setAttribute("aria-label", button.title);
    for (const option of this.toolbar.querySelectorAll<HTMLButtonElement>(".atl-board-brush-palette [data-brush]"))
      option.setAttribute("aria-checked", String(option.dataset.brush === this.brush.kind));
  }
  private refreshBrushPreviews(): void {
    for (const [kind, canvas] of this.brushPreviewCanvases)
      paintBoardBrushPreview(canvas, kind, Math.min(BOARD_BRUSH_DEFAULT_WIDTHS[kind], 26), this.color);
  }
  private updateFillControl(): void {
    const disabled = this.fill.kind === "none";
    this.fillColorInput.disabled = disabled;
    this.fillColorInput.closest(".atl-board-fill-control")?.classList.toggle("is-fill-disabled", disabled);
  }
  private openBrushPalette(): void {
    this.brushPalette.hidden = false;
    this.updateBrushButton();
  }
  private closeBrushPalette(restoreFocus = false): void {
    if (this.brushPalette.hidden) return;
    this.brushPalette.hidden = true;
    if (restoreFocus) this.penButton.focus({ preventScroll: true });
  }
  private brushPaletteKey(event: KeyboardEvent): void {
    if (this.brushPalette.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeBrushPalette(true);
      return;
    }
    const options = [...this.brushPalette.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")];
    const current = options.indexOf(this.ownerDocument.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (Math.max(0, current) + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current <= 0 ? options.length : current) - 1;
    else if ((event.key === "Enter" || event.key === " ") && current >= 0) {
      event.preventDefault(); options[current]!.click(); return;
    } else return;
    event.preventDefault();
    options[next]?.focus();
  }
  private surfaceFor(anchor: BoardAnchor): BoardSurface | undefined {
    if(this.pendingSlot&&anchorKey(this.pendingSlot.anchor)===anchorKey(anchor))return this.projections.get(this.pendingSlot.spec.id)??this.sourceSurfaceFor(anchor);
    if(this.active&&"projectionId" in this.active&&anchorKey(this.active.anchor)===anchorKey(anchor))return this.projections.get((this.active as BoardProjection).projectionId)??this.sourceSurfaceFor(anchor);
    return this.sourceSurfaceFor(anchor);
  }
  private objectSurface(object:BoardObject):BoardSurface|undefined {
    const binding=this.integration.layout.binding(object.id)??this.pendingBindings.get(object.id);
    if(binding){const slotId="slot" in binding?binding.slot.id:binding.slotId,p=this.projections.get(slotId);if(!p)return;
      const base=this.sourceSurfaceFor(p.anchor),el=this.slotViews.get(slotId);if(!base||!el?.isConnected)return;
      return projectBoardSlot(base,el,binding.matrix,this.integration.layout.revision);}
    if(object.id==="OBJ-draft"&&this.gesture&&"projectionId" in this.gesture.surface)return this.gesture.surface;
    return this.sourceSurfaceFor(object.anchor);
  }
  /** Resolve each source/slot geometry once for this synchronous paint or hit. */
  private objectSurfaces(): ObjectSurfaces {
    const sourceIndex = this.sourceSurfaceIndex();
    const slotElements = this.slotViews.captureElements();
    const sources = new Map<string, BoardSurface | undefined>();
    const slots = new Map<string, BoardProjection | undefined>();
    const bindings = new Map<string, BoardProjection>();
    const captured = new Map<BoardSurface, BoardSurface>();
    const capture = (surface: BoardSurface): BoardSurface => {
      let geometry = captured.get(surface);
      if (!geometry) { geometry = captureBoardSurface(surface); captured.set(surface, geometry); }
      return geometry;
    };
    const source = (anchor: BoardAnchor): BoardSurface | undefined => {
      const key = anchorKey(anchor);
      if (!sources.has(key)) { const surface = this.sourceSurfaceFor(anchor, sourceIndex); sources.set(key, surface && capture(surface)); }
      return sources.get(key);
    };
    const resolve = (object: BoardObject): BoardSurface | undefined => {
      const binding = this.integration.layout.binding(object.id) ?? this.pendingBindings.get(object.id);
      if (!binding) return object.id === "OBJ-draft" && this.gesture && "projectionId" in this.gesture.surface
        ? this.gesture.surface : source(object.anchor);
      const slotId = "slot" in binding ? binding.slot.id : binding.slotId;
      if (!slots.has(slotId)) {
        const projection = this.projections.get(slotId), element = slotElements.get(slotId);
        slots.set(slotId, projection && element?.isConnected && source(projection.anchor)
          ? capture(projection) as BoardProjection : undefined);
      }
      const slot = slots.get(slotId);
      if (!slot) return;
      const key = `${slotId}:${binding.matrix.join(",")}`;
      let projected = bindings.get(key);
      if (!projected) { projected = projectCapturedBoardSlot(slot, binding.matrix); bindings.set(key, projected); }
      return projected;
    };
    return Object.assign(resolve, { capture });
  }
  private readDocument(): Readonly<BoardDocument> {
    const document = this.history.renderDocument;
    if (!this.renderSnapshot || this.renderSnapshot.revision !== document.revision) {
      this.renderSnapshot = document;
      this.renderObjects = new Map(document.objects.map(object => [object.id, object]));
      this.renderLayers = new Map(document.layers?.map(layer => [layer.id, layer]) ?? []);
    }
    return this.renderSnapshot;
  }
  private syncSlots(editing:boolean,document=this.readDocument()):void {
    if(document.sourceType!=="markdown")return;
    const state=this.integration.layout;state.reconcile(document,false,new Set(this.integration.registry?.entries.filter(e=>e.status==="located").map(e=>e.id)??[]));
    if(state.needsLegacyNotice(document.objects)){state.markNotice();this.status.textContent=t("board.layoutLegacyNotice");}
    const key=`${this.history.revision}:${state.revision}`;
    if(key!==this.slotSpecKey&&!this.gesture){this.slotSpecs=state.specs(document.objects);this.slotSpecKey=key;}
    const specs=[...this.slotSpecs,...(this.pendingSlot&&!this.slotSpecs.some(s=>s.id===this.pendingSlot!.spec.id)?[this.pendingSlot.spec]:[])];
    this.slotViews.sync(this.surfaces,specs,editing);
    this.integration.editors.setSlots(this.view.containerEl,editing?specs:[]);
    this.projections.clear();
    const sources=new Map<string,BoardSurface>();
    for(const surface of this.surfaces)if(surface.anchor.kind==="markdown"&&!sources.has(surface.anchor.key))sources.set(surface.anchor.key,surface);
    const elements=this.slotViews.captureElements();
    for(const spec of specs){const base=sources.get(spec.anchorKey),el=elements.get(spec.id);if(base&&el?.isConnected)this.projections.set(spec.id,projectBoardSlot(base,el,[1,0,0,1,0,0],state.revision));}
  }
  private async prepareDrawingSlot(signal?:AbortSignal):Promise<void>{
    if(this.history.renderDocument.sourceType!=="markdown")return;
    this.draw();let base=this.currentVisibleSurface();
    if(base&&"projectionId" in base)base=this.sourceSurfaceFor(base.anchor);
    if(!base||base.anchor.kind!=="markdown")return;
    if(!this.selection.size){const visible=this.contentViewport()?.getBoundingClientRect();base=this.surfaces.filter(s=>s.kind==="markdown"&&(!visible||overlaps(s.getClientRect(),{x:visible.x,y:visible.y,width:visible.width,height:visible.height}))).sort((a,b)=>b.getClientRect().y-a.getClientRect().y)[0]??base;}
    const spec={id:uid("SLOT"),anchorKey:(base.anchor as Extract<BoardAnchor,{kind:"markdown"}>).key,width:640,height:480};this.pendingSlot={spec,anchor:base.anchor};
    for(let i=0;i<100;i++){if(signal?.aborted||!this.sourceIsCurrent())throw new DOMException("Cancelled","AbortError");this.draw();const projected=this.projections.get(spec.id);if(projected&&this.editorState()?.ready!==false){this.active=projected;return;}await new Promise<void>(resolve=>this.win.setTimeout(resolve,32));}
    throw Error(t("board.unavailable"));
  }
  private sourceSurfaceIndex(): SourceSurfaces {
    const exact = new Map<string, BoardSurface>(), compatible = new Map<string, BoardSurface>(), quotes = new Map<string, BoardSurface | undefined>();
    for (const surface of this.surfaces) {
      const key = anchorKey(surface.anchor);
      if (!exact.has(key)) exact.set(key, surface);
      if (!compatible.has(key)) compatible.set(key, surface);
      if (surface.kind === "markdown") for (const alias of surface.anchorAliases ?? [])
        if (!compatible.has(`md:${alias}`)) compatible.set(`md:${alias}`, surface);
      if (surface.anchor.kind === "markdown") {
        const quote = surface.anchor.quote;
        quotes.set(quote, quotes.has(quote) ? undefined : surface);
      }
    }
    return { exact, compatible, quotes };
  }
  private sourceSurfaceFor(anchor: BoardAnchor, surfaces = this.sourceSurfaceIndex()): BoardSurface | undefined {
    if (anchor.kind === "markdown" && this.integration.registry) {
      const resolved = this.integration.registry.resolve(anchor);
      if (!resolved || resolved.status !== "located") return;
      return surfaces.exact.get(`md:${resolved.id}`);
    }
    const exact = surfaces.compatible.get(anchorKey(anchor));
    if (exact) return exact;
    if (anchor.kind === "markdown") {
      return surfaces.quotes.get(anchor.quote);
    }
    return undefined;
  }
  private surfaceAt(point: BoardPoint): BoardSurface | null {
    const hits = [...this.projections.values(),...this.surfaces].filter((s) => {
      const r = surfaceRect(s);
      return (
        r.width > 0 &&
        r.height > 0 &&
        point.x >= r.left &&
        point.x <= r.right &&
        point.y >= r.top &&
        point.y <= r.bottom
      );
    });
    if (hits.length) return hits.find(s=>"projectionId" in s)??hits.sort((a, b) => a.height - b.height)[0]??null;
    return (
      this.surfaces
        .filter((s) => s.kind === "markdown")
        .sort(
          (a, b) =>
            Math.abs(surfaceRect(a).top - point.y) -
            Math.abs(surfaceRect(b).top - point.y),
        )[0] ?? null
    );
  }
  /** Keep explicit requests and placements on the page the student can see. */
  private currentVisibleSurface(): BoardSurface | undefined {
    this.draw();
    const root = this.root.getBoundingClientRect();
    const visibleArea = (surface: BoardSurface): number => {
      const page = surfaceRect(surface),
        viewport = surface.viewportElement.getBoundingClientRect();
      const left = Math.max(page.left, viewport.left, root.left, 0),
        top = Math.max(page.top, viewport.top, root.top, 0),
        right = Math.min(
          page.right,
          viewport.right,
          root.right,
          this.win.innerWidth,
        ),
        bottom = Math.min(
          page.bottom,
          viewport.bottom,
          root.bottom,
          this.win.innerHeight,
        );
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    };
    if (this.active && visibleArea(this.active) > 0) return this.active;
    return this.surfaces
      .map((surface) => ({ surface, area: visibleArea(surface) }))
      .filter(({ area }) => area > 0)
      .sort((a, b) => b.area - a.area)[0]?.surface;
  }
  private schedule(): void {
    if (this.disposed || this.raf) return;
    this.raf = this.win.requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }
  private refreshSurfaces(): void {
    try {
      const editing =
        this.view.file?.extension === "md" &&
        this.view.getMode?.() !== "preview";
      this.surfaces = editing
        ? (this.editorState()?.surfaces ?? [])
        : discoverBoardSurfaces(
            this.view,
            this.sourceFile,
            this.integration.registry,
          );
      const button = this.toolButtons.get("read")!,
        key = editing ? "edit" : "read";
      if (button.dataset.boardAction !== key) {
        button.textContent = t(`board.${key}`);
        button.title = button.textContent;
        decorateBoardButton(button, key);
      }
    } catch {
      this.surfaces = [];
      this.status.textContent = t("board.unavailable");
    }
    this.syncSlots(this.view.getMode?.()!=="preview");
    if (this.active) this.active = this.surfaceFor(this.active.anchor) ?? null;
  }
  private draw(): void {
    if (this.disposed) return;
    this.updateResizeTargets();
    this.refreshSurfaces();
    const surfaces = this.objectSurfaces();
    const rootRect = this.root.getBoundingClientRect(),
      ratio = this.win.devicePixelRatio || 1,
      w = Math.max(1, Math.round(rootRect.width * ratio)),
      h = Math.max(1, Math.round(rootRect.height * ratio));
    // Toolbar padding changes percentage sizing's containing box. Keep CSS
    // pixels identical to the root coordinates used for drawing and hit tests.
    this.canvas.style.width = `${rootRect.width}px`;
    this.canvas.style.height = `${rootRect.height}px`;
    // Clip the canvas element itself, not only its pixels: CSS clipping also
    // removes the native PDF toolbar/sidebar from its pointer hit area. Keep
    // the canvas coordinate origin at view-content for existing geometry.
    const viewport = this.contentViewport();
    const visible = viewport?.getBoundingClientRect();
    if (!visible || visible.width <= 0 || visible.height <= 0) {
      this.canvas.style.clipPath = "inset(100% 0 0 0)";
    } else {
      const inset = [
        Math.max(0, Math.min(rootRect.height, visible.top - rootRect.top)),
        Math.max(0, Math.min(rootRect.width, rootRect.right - visible.right)),
        Math.max(
          0,
          Math.min(rootRect.height, rootRect.bottom - visible.bottom),
        ),
        Math.max(0, Math.min(rootRect.width, visible.left - rootRect.left)),
      ];
      this.canvas.style.clipPath = `inset(${inset.map((value) => `${value}px`).join(" ")})`;
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rootRect.width, rootRect.height);
    if(this.penPreviewDirty){this.penPreviewDirty=false;if(this.gesture&&this.tool==="pen")this.penPreview();}
    const document = this.readDocument();
    this.guardReflow(document.objects, surfaces);
    if(this.tutorPreview.length){
      const additions=this.tutorPreview.flatMap(op=>op.type==="add"?[op.object]:[]);
      const surface=additions[0]&&surfaces(additions[0]);
      if(surface&&!safeDrawingRect(this.drawingSpace(surface,new Set(),this.annotationTurn),rectUnion(additions.map(o=>objectClientBounds(o,surface.toClient())))))this.tutorPreview=[];
    }
    let objects = this.draft ?? document.objects;
    if (!this.draft && !this.tutorPreview.length) {
      this.spatial.rebuild(document.objects, String(document.revision), this.ink);
      const visible = new Set<string>();
      for (const raw of [...this.surfaces,...this.projections.values()]) {
        const surface = surfaces.capture(raw);
        // Objects are allowed to extend beyond their Markdown paragraph or PDF
        // page anchor. Cull against the board canvas itself, not the anchor or
        // document column, or margin objects disappear between active strokes.
        // CSS clip-path already keeps native PDF/Obsidian chrome out of view.
        const left = rootRect.left;
        const top = rootRect.top;
        const right = rootRect.right;
        const bottom = rootRect.bottom;
        if (right <= left || bottom <= top) continue;
        const local = bounds([
          surface.unproject({ x: left, y: top }),
          surface.unproject({ x: right, y: top }),
          surface.unproject({ x: left, y: bottom }),
          surface.unproject({ x: right, y: bottom }),
        ]);
        for (const object of this.spatial.search(surface.anchor, local, 40)) visible.add(object.id);
      }
      // Document order remains the single z-order source after spatial culling.
      objects = document.objects.filter((object) => visible.has(object.id));
    }
    if (this.tutorPreview.length) {
      const preview = new Map(objects.map((object) => [object.id, object]));
      for (const operation of this.tutorPreview) {
        if (operation.type === "remove") preview.delete(operation.objectId);
        else preview.set(operation.object.id, operation.object);
      }
      objects = [...preview.values()];
    }
    const ink = { ...this.ink, ...this.draftInk };
    objects=objects.filter(object=>!this.hiddenLayoutObjects.has(object.id));
    // During a pen gesture the committed scene is unchanged. Reuse its pixels
    // instead of repainting every translucent dab for every pointer frame.
    const cacheScene=!!this.gesture&&this.tool==="pen"&&!this.draft&&!this.tutorPreview.length&&!this.textEditor;
    const sceneKey=cacheScene?JSON.stringify([document.revision,this.gesture!.seed,w,h,rootRect.left,rootRect.top,
      this.layoutGuardKey,this.surfaces.map(surface=>[surface.anchor,surfaces.capture(surface).toClient()])]):"";
    const cachedScene=cacheScene&&this.paintSceneKey===sceneKey&&!!this.paintScene;
    if(cachedScene){ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(this.paintScene!,0,0);ctx.restore();}
    if(!cacheScene){this.paintScene=null;this.paintSceneKey="";}
    const baseObjects=cachedScene?[]:objects;
    const rendered: Iterable<BoardObject> = this.draftObject
      ? (function* (base: readonly BoardObject[], draft: BoardObject) {
          yield* base;
          yield draft;
        })(baseObjects, this.draftObject)
      : baseObjects;
    const render = prepareBoardCanvas(ctx, { ink, characters: this.profiles, layers: document.layers,
      vectorAssets: document.vectorAssets, resolveAsset: path => this.assets.get(path),
      requestRender: () => { this.paintSceneKey = ""; this.schedule(); } });
    for (const object of rendered) {
      if(cacheScene&&!cachedScene&&object===this.draftObject){
        this.paintScene??=this.ownerDocument.createElement("canvas");
        this.paintScene.width=w;this.paintScene.height=h;
        const backing=this.paintScene.getContext("2d");
        if(backing){backing.drawImage(this.canvas,0,0);this.paintSceneKey=sceneKey;}
      }
      if (this.textEditor?.object.id === object.id) continue;
      const surface = surfaces(object);
      if (!surface) continue;
      const m = surface.toClient();
      ctx.save();
      if("clipRect" in surface){const clip=(surface as BoardProjection).clipRect();ctx.beginPath();ctx.rect(clip.x-rootRect.x,clip.y-rootRect.y,clip.width,clip.height);ctx.clip();}
      ctx.translate(-rootRect.left, -rootRect.top);
      ctx.transform(...m);
      if(!(object===this.draftObject&&this.gesture&&object.brush&&this.livePainter.render(ctx,this.gesture.points,object.brush,object.strokeWidth,object.color)))render([object]);
      ctx.restore();
      if (this.selection.has(object.id) && this.selection.size === 1) {
        const box = clientBounds(object, surface);
        ctx.save();
        ctx.strokeStyle = "#7663bd";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(
          box.x - rootRect.left - 4,
          box.y - rootRect.top - 4,
          box.width + 8,
          box.height + 8,
        );
        ctx.fillStyle = "#7663bd";
        ctx.fillRect(
          box.x + box.width - rootRect.left,
          box.y + box.height - rootRect.top,
          7,
          7,
        );
        ctx.restore();
      }
    }
    if (this.selection.size > 1) {
      const box = this.selectionBounds(objects, surfaces);
      if (box) {
        ctx.save();
        ctx.strokeStyle = "#7663bd";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(
          box.x - rootRect.left - 4,
          box.y - rootRect.top - 4,
          box.width + 8,
          box.height + 8,
        );
        ctx.fillStyle = "#7663bd";
        ctx.fillRect(
          box.x + box.width - rootRect.left,
          box.y + box.height - rootRect.top,
          7,
          7,
        );
        ctx.restore();
      }
    }
    this.updateSelectionBar(this.draft ?? document.objects, rootRect, surfaces);
    if (this.gesture?.box) {
      const r = bounds([this.gesture.start, this.gesture.last]);
      ctx.strokeStyle = "#7663bd";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        r.x - rootRect.left,
        r.y - rootRect.top,
        r.width,
        r.height,
      );
      ctx.setLineDash([]);
    }
    if ((this.guides.x !== undefined || this.guides.y !== undefined) && this.active) {
      const area = surfaceRect(this.active);
      ctx.save();
      ctx.strokeStyle = "#e14883";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      if (this.guides.x !== undefined) {
        const x = this.active.project({ x: this.guides.x, y: 0 }).x - rootRect.left;
        ctx.beginPath(); ctx.moveTo(x, area.top - rootRect.top); ctx.lineTo(x, area.bottom - rootRect.top); ctx.stroke();
      }
      if (this.guides.y !== undefined) {
        const y = this.active.project({ x: 0, y: this.guides.y }).y - rootRect.top;
        ctx.beginPath(); ctx.moveTo(area.left - rootRect.left, y); ctx.lineTo(area.right - rootRect.left, y); ctx.stroke();
      }
      ctx.restore();
    }
  }
  private hit(point: BoardPoint, includeLocked = false, document = this.readDocument(), surfaces = this.objectSurfaces()): BoardObject | undefined {
    const key=`${document.revision}:${this.integration.layout.revision}`;
    if(key!==this.hitMappingKey){
      this.spatial.rebuild(document.objects,key,this.ink);
      this.hitMappings.clear();this.hitObjectMappings.clear();this.hitObjectOrder.clear();
      document.objects.forEach((object,order)=>{
        const binding=this.integration.layout.binding(object.id)??this.pendingBindings.get(object.id);
        const mapping=anchorKey(object.anchor)+(binding?`/${"slot" in binding?binding.slot.id:binding.slotId}/${binding.matrix.join(",")}`:"");
        this.hitMappings.set(mapping,object);this.hitObjectMappings.set(object.id,mapping);this.hitObjectOrder.set(object.id,order);
      });
      this.hitMappingKey=key;
    }
    // Query each distinct inverse transform, then only inspect spatial candidates.
    // Geometry/scroll changes resolve the current surface without rebuilding ink.
    const hits = new Map<string,BoardObject>();
    for (const [mapping,object] of this.hitMappings) {
      const surface=surfaces(object);if(!surface)continue;
      if("projectionId" in surface&&!rectContains((surface as BoardProjection).clipRect(),point))continue;
      for(const candidate of this.spatial.hit(object.anchor,surface.unproject(point),6))
        if(this.hitObjectMappings.get(candidate.id)===mapping)hits.set(candidate.id,candidate);
    }
    const candidates=[...hits.values()].sort((a,b)=>this.hitObjectOrder.get(b.id)!-this.hitObjectOrder.get(a.id)!);
    for (const object of candidates) {
      const actual=surfaces(object);
      if (!actual) continue;
      if("projectionId" in actual&&!rectContains((actual as BoardProjection).clipRect(),point))continue;
      const layer = object.layerId
        ? this.renderLayers.get(object.layerId)
        : undefined;
      if (!this.hiddenLayoutObjects.has(object.id) &&
        (!layer || (layer.visible && layer.opacity > 0 && (includeLocked || !layer.locked)))) return object;
    }
    return undefined;
  }
  private annotationSurfaceAt(point: BoardPoint, document = this.readDocument(), surfaces = this.objectSurfaces()): BoardSurface | undefined {
    // A locked reference still accepts annotations on another unlocked layer;
    // adopting its anchor does not edit or group the reference itself.
    const area=[...this.projections.values()].find(p=>rectContains(surfaces.capture(p).getClientRect(),point));
    if(area)return area;
    const target = this.hit(point, true, document, surfaces);
    if (target) return surfaces(target);
    const groups = new Map<string, { surface: BoardSurface; bounds: BoardRect; count: number; order: number }>();
    document.objects.forEach((object, order) => {
      const layer = object.layerId ? this.renderLayers.get(object.layerId) : undefined;
      if (this.hiddenLayoutObjects.has(object.id) || layer?.visible === false || layer?.opacity === 0) return;
      const surface = surfaces(object);
      if (!surface) return;
      // Include blank space inside a composed diagram, but do not bridge
      // unrelated source anchors just because objects share a selection group.
      const key = `${object.selectionGroupId ?? object.groupId}:${anchorKey(surface.anchor)}`;
      const bounds = objectClientBounds(object, surface.toClient()), previous = groups.get(key);
      groups.set(key, { surface, bounds: previous ? rectUnion([previous.bounds, bounds]) : bounds,
        count: (previous?.count ?? 0) + 1, order });
    });
    return [...groups.values()].filter(group => group.count > 1 && rectContains(group.bounds, point))
      .sort((a, b) => b.order - a.order)[0]?.surface;
  }
  private down(event: PointerEvent): void {
    if (!this.sourceIsCurrent()) return;
    if (this.tool === "read") return;
    const editor = this.editorState();
    if (editor && (editor.composing || !editor.ready)) {
      this.status.textContent = t(
        editor.composing ? "board.composing" : "board.unavailable",
      );
      return;
    }
    if (event.button !== 0 || event.pointerType === "touch" || this.gesture)
      return;
    this.draw();
    const document = this.readDocument(), surfaces = this.objectSurfaces();
    const point = { x: event.clientX, y: event.clientY }, hit = this.hit(point, false, document, surfaces),
      sourceSurface = (["pen", "text", "line", "arrow", "rect", "ellipse", "diamond", "connector"].includes(this.tool)
        ? this.annotationSurfaceAt(point, document, surfaces)
        : this.tool === "partialErase" && hit?.kind === "ink" ? surfaces(hit) : undefined)
        ?? this.surfaceAt(point);
    const surface=sourceSurface&&freezeBoardProjection(sourceSurface);
    if (!surface) {
      this.status.textContent = t("board.unavailable");
      return;
    }
    const activeLayer = this.renderLayers.get(this.activeLayerId);
    if (activeLayer?.locked && !["select", "erase", "partialErase"].includes(this.tool)) {
      new Notice(t("board.layerLocked"));
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.canvas.focus({ preventScroll: true });
    this.active = surface;
    if (this.together) this.integration.claim(this);
    this.invalidate();
    const selectedBounds = this.selectionBounds(document.objects, surfaces);
    const onGroupHandle =
      this.tool === "select" &&
      selectedBounds &&
      Math.hypot(
        point.x - selectedBounds.x - selectedBounds.width,
        point.y - selectedBounds.y - selectedBounds.height,
      ) < 14;
    const inSelectedBounds =
      this.tool === "select" &&
      selectedBounds &&
      point.x >= selectedBounds.x - 4 &&
      point.x <= selectedBounds.x + selectedBounds.width + 4 &&
      point.y >= selectedBounds.y - 4 &&
      point.y <= selectedBounds.y + selectedBounds.height + 4;
    const selectedTarget =
      onGroupHandle || inSelectedBounds
        ? document.objects.find(object => this.selection.has(object.id))
        : undefined;
    const target =
        hit ?? selectedTarget,
      before = ["select", "partialErase", "line", "arrow", "rect", "ellipse", "diamond", "connector"].includes(this.tool)
        ? copy(document.objects)
        : [];
    if (this.tool === "text") {
      if (target?.kind === "text") {
        this.beginText(target, true);
        return;
      }
      const location = surface.unproject(point);
      const textId=uid("OBJ");if("projectionId" in surface)this.pendingBindings.set(textId,{slotId:(surface as BoardProjection).projectionId,matrix:(surface as BoardProjection).modelToSlot});
      this.beginText(
        {
          id: textId,
          kind: "text",
          anchor: copy(surface.anchor),
          ...location,
          width: Math.max(100, Math.min(320, surface.width - location.x)),
          height: this.textStyle.size * 1.25,
          color: this.color,
          strokeWidth: 1,
          text: "",
          textStyle: copy(this.textStyle),
          createdBy: "human",
          editedBy: "human",
          revision: 1,
          groupId: uid("GROUP"),
        },
        false,
      );
      return;
    }
    if (this.tool === "fill") {
      if (target && ["path", "rect", "ellipse"].includes(target.kind)) {
        this.history.transact((document) => {
          const object = document.objects.find((candidate) => candidate.id === target.id);
          if (object) object.fill = { ...copy(this.fill), seed: this.nextSeed() };
        }, "human");
        this.changed();
      }
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    if (this.tool === "erase") {
      if (target) {
        this.selection.clear();
        this.selection.add(target.id);
        this.remove();
      }
      return;
    }
    let resize = false,
      box = false;
    if (this.tool === "select") {
      if (target) {
        if (!this.selection.has(target.id)) {
          if (!event.shiftKey) this.selection.clear();
          this.selectObject(target, event.altKey);
        }
        this.canvas.style.cursor = "grabbing";
        this.status.textContent = `${t("board.selected", {
          count: this.selection.size,
        })} · ${t("board.dragSelection")}`;
        const s = surfaces(target)!;
        const b = this.selectionBounds(before, surfaces) ?? clientBounds(target, s);
        resize =
          Math.hypot(point.x - b.x - b.width, point.y - b.y - b.height) < 14;
      } else {
        if (!event.shiftKey) this.selection.clear();
        box = true;
      }
    } else this.selection.clear();
    this.gesture = {
      pointerId: event.pointerId,
      surface,
      start: point,
      last: point,
      points: [
        {
          ...surface.unproject(point),
          pressure: event.pressure,
          t: event.timeStamp,
          tiltX: event.tiltX,
          tiltY: event.tiltY,
          twist: event.twist,
        },
      ],
      before,
      resize,
      box,
      groupBounds: this.selectionBounds(before, surfaces),
      snapIndex: this.tool === "select" && !box ? createBoardSnapIndex(before, this.selection, object => surfaces(object)?.id) : undefined,
      seed: this.nextSeed(),
    };
    if (this.tool === "partialErase") this.partialErasePreview(point);
    this.schedule();
  }
  private move(event: PointerEvent): void {
    if (this.tool === "erase" && event.buttons === 1) {
      const hit = this.hit({ x: event.clientX, y: event.clientY });
      if (hit) {
        this.selection.clear();
        this.selection.add(hit.id);
        this.remove();
      }
      return;
    }
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    gesture.last = { x: event.clientX, y: event.clientY };
    if (this.tool === "partialErase") {
      this.partialErasePreview(gesture.last);
    } else if (this.tool === "pen") {
      const events = event.getCoalescedEvents?.() ?? [event];
      for (const part of events.length ? events : [event])
        gesture.points.push({
          ...gesture.surface.unproject({ x: part.clientX, y: part.clientY }),
          pressure: part.pressure,
          t: part.timeStamp,
          tiltX: part.tiltX,
          tiltY: part.tiltY,
          twist: part.twist,
        });
      if (gesture.points.length > 12000) this.finishGesture();
      else this.penPreviewDirty=true;
    } else if (["line", "arrow", "rect", "ellipse", "diamond", "connector"].includes(this.tool)) {
      this.shapePreview();
    } else if (!gesture.box) {
      const surfaces = this.objectSurfaces();
      gesture.snapIndex ??= createBoardSnapIndex(gesture.before, this.selection, object => surfaces(object)?.id);
      // Selection-wide limits are invariant for this pointer event, rather than
      // being re-filtered for each of its selected objects.
      let scaleLimit = 10;
      if (gesture.resize) for (const object of gesture.before)
        if (this.selection.has(object.id) && object.textStyle) scaleLimit = Math.min(scaleLimit, 512 / object.textStyle.size);
      const box = gesture.groupBounds;
      const diagonalX = Math.max(20, box?.width ?? 20), diagonalY = Math.max(20, box?.height ?? 20);
      const dx = gesture.last.x - gesture.start.x, dy = gesture.last.y - gesture.start.y;
      const groupFactor = Math.max(0.1, Math.min(scaleLimit, 1 + (dx * diagonalX + dy * diagonalY) /
        (diagonalX * diagonalX + diagonalY * diagonalY)));
      this.draft = gesture.before.map((object) => {
        if (!this.selection.has(object.id)) return object;
        const surface = surfaces(object);
        if (!surface) return object;
        const start = surface.unproject(gesture.start),
          last = surface.unproject(gesture.last);
        if (gesture.resize) {
          // The handle is the screen-space lower-right corner, even when the
          // PDF viewport or the object itself is rotated. Project the drag onto
          // that diagonal and keep the opposite screen-space corner fixed.
          const box = gesture.groupBounds ?? clientBounds(object, surface);
          const factor = gesture.groupBounds ? groupFactor : Math.max(0.1, Math.min(scaleLimit,
            1 + (dx * Math.max(20, box.width) + dy * Math.max(20, box.height)) /
              (Math.max(20, box.width) ** 2 + Math.max(20, box.height) ** 2)));
          const origin = surface.project({ x: object.x, y: object.y });
          const fixedOrigin = surface.unproject({
            x: box.x + (origin.x - box.x) * factor,
            y: box.y + (origin.y - box.y) * factor,
          });
          return {
            ...object,
            ...fixedOrigin,
            width: Math.max(1, object.width * factor),
            height: Math.max(1, object.height * factor),
            ...(object.textStyle
              ? {
                  textStyle: {
                    ...object.textStyle,
                    size: object.textStyle.size * factor,
                  },
                }
              : {}),
          };
        }
        const moved = {
          ...object,
          x: object.x + last.x - start.x,
          y: object.y + last.y - start.y,
        };
        const snapped = snapBoardObject(moved, gesture.snapIndex!, surface.id);
        this.guides = snapped.guides;
        return snapped.object;
      });
    }
    this.schedule();
  }
  private partialErasePreview(client: BoardPoint): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const local = gesture.surface.unproject(client);
    const matrix = gesture.surface.toClient();
    const scale = Math.max(0.001, Math.hypot(matrix[0], matrix[1]));
    const radius = 10 / scale;
    this.spatial.rebuild(gesture.before, `erase:${gesture.seed}`, this.ink);
    const candidates = this.spatial.search(
      gesture.surface.anchor,
      { x: local.x - radius, y: local.y - radius, width: radius * 2, height: radius * 2 },
    );
    this.draft ??= copy(gesture.before);
    this.readDocument();
    const surfaces = this.objectSurfaces();
    for (const candidate of candidates) {
      if (candidate.kind !== "ink" || !candidate.inkId || surfaces(candidate)?.id!==gesture.surface.id) continue;
      const layer = candidate.layerId
        ? this.renderLayers.get(candidate.layerId)
        : undefined;
      if (layer?.locked || layer?.visible === false) continue;
      const stroke = this.ink[candidate.inkId];
      if (!stroke) continue;
      const angle = -(candidate.rotation ?? 0);
      const dx = local.x - candidate.x, dy = local.y - candidate.y;
      const target = {
        x: dx * Math.cos(angle) - dy * Math.sin(angle),
        y: dx * Math.sin(angle) + dy * Math.cos(angle),
      };
      const points = normalizedBoardPoints(stroke.points, candidate.width, candidate.height);
      const hit = points.flatMap((point, index) =>
        Math.hypot(point.x - target.x, point.y - target.y) <= radius ? [index] : [],
      );
      if (!hit.length) continue;
      const draft = this.draft.find((item) => item.id === candidate.id);
      if (!draft) continue;
      const ranges = [...(draft.erasedRanges ?? []), ...hit.map((index) => [index, index] as [number, number])]
        .sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
      }
      draft.erasedRanges = merged;
      draft.revision++;
    }
  }
  private shapeObject(g: Gesture, id: string): BoardObject {
    const start = g.surface.unproject(g.start),
      end = g.surface.unproject(g.last),
      rect = bounds([start, end]);
    const kind = ["line", "diamond", "connector"].includes(this.tool)
      ? "path"
      : this.tool as "arrow" | "rect" | "ellipse";
    const shapePoints = this.tool === "diamond"
      ? [
          { x: rect.width / 2, y: 0 },
          { x: rect.width, y: rect.height / 2 },
          { x: rect.width / 2, y: rect.height },
          { x: 0, y: rect.height / 2 },
          { x: rect.width / 2, y: 0 },
        ]
      : ["line", "connector", "arrow"].includes(this.tool)
        ? [
            { x: start.x - rect.x, y: start.y - rect.y },
            { x: end.x - rect.x, y: end.y - rect.y },
          ]
        : undefined;
    return {
      id,
      kind,
      anchor: copy(g.surface.anchor),
      ...rect,
      color: this.color,
      strokeWidth: this.width,
      layerId: this.activeLayerId,
      opacity: 1,
      fill: ["arrow", "line", "connector"].includes(this.tool) ? undefined : copy(this.fill),
      ...(shapePoints ? { points: shapePoints } : {}),
      drawingStyle: { kind: this.drawingStyle, seed: g.seed },
      createdBy: "human",
      editedBy: "human",
      revision: 1,
      groupId: uid("GROUP"),
    };
  }
  private shapePreview(): void {
    if (this.gesture)
      this.draft = [
        ...this.gesture.before,
        this.shapeObject(this.gesture, "OBJ-draft"),
      ];
  }
  private penPreview(): void {
    const g = this.gesture;
    if (!g) return;
    const rect = bounds(g.points),
      id = "INK-draft";
    this.draftInk = {
      [id]: {
        id,
        createdAt: now(),
        // The active array is append-only. The renderer derives local geometry
        // without cloning every historical sample on each pointer event.
        points: g.points,
      },
    };
    this.draftObject = {
        id: "OBJ-draft",
        kind: "ink",
        anchor: g.surface.anchor,
        ...rect,
        color: this.color,
        strokeWidth: this.width,
        layerId: this.activeLayerId,
        brush: { ...copy(this.brush), seed: g.seed },
        inkId: id,
        createdBy: "human",
        editedBy: "human",
        revision: 1,
        groupId: "GROUP-draft",
      };
  }
  private up(event: PointerEvent): void {
    if (this.gesture?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const gesture = this.gesture;
    gesture.last = { x: event.clientX, y: event.clientY };
    if (this.tool === "pen") {
      const point = {
        ...gesture.surface.unproject(gesture.last),
        pressure: event.pressure,
        t: event.timeStamp,
        tiltX: event.tiltX,
        tiltY: event.tiltY,
        twist: event.twist,
      };
      const previous = gesture.points.at(-1);
      if (!previous || previous.x !== point.x || previous.y !== point.y)
        gesture.points.push(point);
    }
    this.finishGesture();
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }
  private finishGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (this.tool === "select") this.canvas.style.cursor = "default";
    if (this.tool === "pen") {
      const rect = bounds(g.points),
        id = uid("INK");
      this.ink[id] = {
        id,
        createdAt: now(),
        points: g.points.map((p) => ({
          ...p,
          x: p.x - rect.x,
          y: p.y - rect.y,
        })),
      };
      if (this.ink[id]!.points.length === 1)
        this.ink[id]!.points.push({
          ...this.ink[id]!.points[0]!,
          x: 0.1,
          y: 0.1,
        });
      const object: BoardObject = {
        id: uid("OBJ"),
        kind: "ink",
        anchor: copy(g.surface.anchor),
        ...rect,
        color: this.color,
        strokeWidth: this.width,
        layerId: this.activeLayerId,
        brush: { ...copy(this.brush), seed: g.seed },
        inkId: id,
        createdBy: "human",
        editedBy: "human",
        revision: 1,
        groupId: uid("GROUP"),
      };
      if("projectionId" in g.surface)this.integration.layout.attach(object,(g.surface as BoardProjection).projectionId,(g.surface as BoardProjection).modelToSlot);
      const classification = classifyBoardStroke(object, this.ink[id]!);
      this.history.transact((doc) => {
        const priorObject = [...doc.objects].reverse().find((candidate) => candidate.kind === "ink" && candidate.inkId);
        const priorStroke = priorObject?.inkId ? this.ink[priorObject.inkId] : undefined;
        doc.objects.push(object);
        doc.semanticGroups ??= [];
        const priorGroup = priorObject
          ? [...doc.semanticGroups].reverse().find((group) => group.objectIds.includes(priorObject.id) && group.kind === "handwriting")
          : undefined;
        if (
          classification.kind === "handwriting" &&
          priorGroup && priorObject && priorStroke &&
          shouldMergeSemanticStrokes({ object: priorObject, stroke: priorStroke }, { object, stroke: this.ink[id]! })
        ) {
          priorGroup.objectIds.push(object.id);
          priorGroup.updatedAt = now();
          priorGroup.confidence = Math.min(priorGroup.confidence, classification.confidence);
        } else {
          const timestamp = now();
          doc.semanticGroups.push({
            id: uid("SEMANTIC"),
            objectIds: [object.id],
            kind: classification.kind,
            confidence: classification.confidence,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
      }, "human");
      this.changed();
      void this.compute.derive({
        id: object.id,
        points: this.ink[id]!.points,
        width: object.width,
        height: object.height,
        brushKind: object.brush?.kind,
      }).then((derived) => {
        if (this.disposed) return;
        const group = this.history.renderDocument.semanticGroups?.find((candidate) => candidate.objectIds.includes(object.id));
        if (!group || derived.confidence <= group.confidence + 0.04) return;
        this.history.transact((doc) => {
          const target = doc.semanticGroups?.find((candidate) => candidate.id === group.id);
          if (target) {
            target.kind = derived.kind;
            target.confidence = derived.confidence;
            target.updatedAt = now();
          }
        }, "human");
        this.changed("tutor");
      }).catch(() => undefined);
    } else if (["line", "arrow", "rect", "ellipse", "diamond", "connector"].includes(this.tool)) {
      if (Math.hypot(g.last.x - g.start.x, g.last.y - g.start.y) >= 3) {
        const object = this.shapeObject(g, uid("OBJ"));
        if("projectionId" in g.surface)this.integration.layout.attach(object,(g.surface as BoardProjection).projectionId,(g.surface as BoardProjection).modelToSlot);
        this.history.transact((doc) => doc.objects.push(object), "human");
        this.selection.clear();
        this.selectObject(object, true);
        this.changed();
      }
    } else if (g.box) {
      const r = bounds([g.start, g.last]);
      for (const o of this.history.renderDocument.objects) {
        const s = this.objectSurface(o);
        if (s) {
          const b = clientBounds(o, s);
          if (
            b.x >= r.x &&
            b.y >= r.y &&
            b.x + b.width <= r.x + r.width &&
            b.y + b.height <= r.y + r.height
          )
            this.selection.add(o.id);
        }
      }
      this.status.textContent = t("board.selected", {
        count: this.selection.size,
      });
      this.updateProperties();
    } else if (this.draft) {
      const objects = this.draft;
      this.history.transact((doc) => {
        doc.objects = copy(objects);
      }, "human");
      this.changed();
    }
    this.draft = null;
    this.draftObject = null;
    this.livePainter.clear();
    this.draftInk = {};
    this.guides = {};
    this.schedule();
  }
  private undo(): void {
    this.finishText(true);
    this.finishGesture();
    this.invalidate();
    const before=this.artworkSignature();
    if (this.history.undo()) this.changed("human",true,before!==this.artworkSignature());
  }
  private redo(): void {
    this.finishText(true);
    this.finishGesture();
    this.invalidate();
    const before=this.artworkSignature();
    if (this.history.redo()) this.changed("human",true,before!==this.artworkSignature());
  }
  private artworkSignature():string {
    const {revision,updatedAt,sourceRevision,markdownAnchors,...artwork}=this.history.renderDocument;
    return JSON.stringify(artwork);
  }
  private remove(): void {
    if (!this.selection.size) return;
    this.invalidate();
    this.history.transact((doc) => {
      doc.objects = doc.objects.filter((o) => !this.selection.has(o.id));
    }, "human");
    this.selection.clear();
    this.updateProperties();
    this.changed();
  }
  private copySelection(paste = false): void {
    const selected = this.history.renderDocument.objects.filter((object) => this.selection.has(object.id));
    if (selected.length) this.clipboard = selected.map((object) => copy(object));
    if (paste) this.pasteSelection();
  }
  private pasteSelection(): void {
    if (!this.clipboard.length) return;
    const groups=new Map<string,string>();
    const remap=(id:string)=>{let value=groups.get(id);if(!value){value=uid("GROUP");groups.set(id,value);}return value;};
    const created = this.clipboard.map((object) => ({
      ...copy(object),
      id: uid("OBJ"),
      x: object.x + 16,
      y: object.y + 16,
      revision: 1,
      groupId: remap(object.groupId),
      ...(object.selectionGroupId?{selectionGroupId:remap(object.selectionGroupId)}:{}),
      ...(object.characterPart?{characterPart:{...object.characterPart,id:remap(object.characterPart.id)}}:{}),
      editedBy: "human" as const,
    }));
    this.history.transact((document) => document.objects.push(...created), "human");
    this.selection.clear();
    for (const object of created) this.selection.add(object.id);
    this.changed();
  }
  private reorderSelection(direction: -1 | 1): void {
    if (!this.selection.size) return;
    this.history.transact((document) => {
      const indexes = document.objects.flatMap((object, index) =>
        this.selection.has(object.id) ? [index] : [],
      );
      for (const index of direction > 0 ? indexes.reverse() : indexes) {
        const target = index + direction;
        if (target < 0 || target >= document.objects.length || this.selection.has(document.objects[target]!.id)) continue;
        [document.objects[index], document.objects[target]] = [document.objects[target]!, document.objects[index]!];
      }
    }, "human");
    this.changed();
  }
  private isQuickInputShortcut(event: KeyboardEvent): boolean {
    return (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey &&
      !event.getModifierState("AltGraph") &&
      (event.code === "KeyL" || event.key.toLowerCase() === "l");
  }
  private key(event: KeyboardEvent): void {
    if (!this.sourceIsCurrent()) return;
    const target = event.target as Element;
    if (event.isComposing) return;
    if (this.isQuickInputShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.showQuickInput();
      return;
    }
    if (target.closest("input,textarea,select,[contenteditable=true]")) return;
    if (target !== this.canvas) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      event.shiftKey ? this.redo() : this.undo();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      this.copySelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      this.pasteSelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      this.copySelection(true);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.remove();
    } else if (event.key === "Escape") {
      if (!this.brushPalette.hidden) this.closeBrushPalette(true);
      else this.setTool("read");
      this.selection.clear();
      this.schedule();
    } else if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      this.width = this.sizeControl.step(event.key === "[" ? -1 : 1);
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      const tools: Record<string, Tool> = {
        v: "select",
        p: "pen",
        e: "erase",
        x: "partialErase",
        t: "text",
        a: "arrow",
        l: "line",
        r: "rect",
        o: "ellipse",
        d: "diamond",
        c: "connector",
        f: "fill",
      };
      const tool = tools[event.key.toLowerCase()];
      if (tool) {
        event.preventDefault();
        this.setTool(tool);
      }
    }
  }
  private changed(actor: "human" | "tutor" = "human",persist=true,notifyAgent=true): void {
    const attachments=this.history.renderDocument.objects.filter(o=>this.pendingBindings.has(o.id));
    if(this.pendingSlot&&attachments.length)this.integration.layout.ensureSlot(this.pendingSlot.spec,attachments[0]!.groupId);
    const knownSlots=new Set(this.integration.layout.snapshot().slots.map(s=>s.id));
    for(const object of attachments){const binding=this.pendingBindings.get(object.id)!;
      if(knownSlots.has(binding.slotId)&&!this.integration.layout.binding(object.id))this.integration.layout.attach(object,binding.slotId,binding.matrix);
    }
    this.integration.layout.reconcile(this.history.renderDocument,true,new Set(this.integration.registry?.entries.filter(e=>e.status==="located").map(e=>e.id)??[]));
    this.syncAnchors();
    this.history.updateSourceRevision(this.sourceRevision());
    this.onChange(this.bundle(), this);
    if(persist)void this.save().catch(() => undefined);
    this.schedule();
    void ensureBoardFonts(
      this.ownerDocument,
      boardHandwrittenText(this.history.renderDocument.objects, this.profiles),
    )
      .then(() => this.schedule())
      .catch((error) => {
        this.status.textContent = t("board.error", { detail: String(error) });
      });
    if (actor === "human" && this.together && notifyAgent) {
      this.integration.claim(this);
      this.scheduler.changed(this.requestVersion(), () => this.runAgent());
    }
  }
  private portableLayout(bundle = this.bundle(), selectedOnly = false): {
    objects: BoardObject[]; width: number; height: number;
    objectMatrices?:ReadonlyMap<string,import("./board-types.js").BoardMatrix>;
  } {
    const objects=bundle.document.objects.filter(o=>!selectedOnly||this.selection.has(o.id));
    if(!bundle.layout?.slots.length)return portableBoardObjects(objects);
    // Slotted previews transform through matrices and only read object data.
    const bindings=new Map(bundle.layout.slots.flatMap(s=>s.bindings.map(b=>[b.objectId,{slot:s.id,...b}] as const)));
    const groups=new Map<string,BoardObject[]>(),matrices=new Map<string,import("./board-types.js").BoardMatrix>();
    for(const o of objects){const b=bindings.get(o.id),valid=b?.digests.includes(layoutObjectDigest(o));
      const key=valid?b!.slot:anchorKey(o.anchor),list=groups.get(key)??[];list.push(o);groups.set(key,list);
      matrices.set(o.id,valid?b!.matrix:[1,0,0,1,0,0]);}
    let y=20,width=600;
    for(const group of groups.values()){
      const box=rectUnion(group.map(o=>objectClientBounds(o,matrices.get(o.id)!))),padding=Math.max(20,...group.map(o=>o.strokeWidth*2));
      for(const o of group)matrices.set(o.id,multiplyBoardMatrices([1,0,0,1,padding-box.x,y+padding-box.y],matrices.get(o.id)!));
      y+=box.height+padding*2;width=Math.max(width,box.width+padding*2);
    }
    return {objects,objectMatrices:matrices,width,height:Math.max(100,y)};
  }
  private preview(bundle = this.bundle(), fontCss = ""): string {
    const layout = this.portableLayout(bundle);
    return renderBoardSvg(layout.objects, {
      width: layout.width,
      height: layout.height,
      ink: bundle.ink,
      objectMatrices:layout.objectMatrices,
      characters: this.profiles,
      layers: bundle.document.layers,
      vectorAssets: bundle.document.vectorAssets,
      background: bundle.document.sourceType === "standalone" ? bundle.document.background : undefined,
      resolveAsset: (p) => this.assets.get(p),
      fontCss,
      measureText: boardTextMeasurer(this.ownerDocument),
    });
  }
  private async exportBoard(format: "png" | "svg" | "pdf", selectedOnly = false): Promise<void> {
    await this.save();
    const bundle = this.bundle();
    const layout = this.portableLayout(bundle, selectedOnly);
    if (!layout.objects.length) {
      new Notice(t("board.exportEmpty"));
      return;
    }
    const base = this.repository.boardPath(bundle.document.id).replace(/\.board\.json$/, selectedOnly ? ".selection" : "");
    if (format === "svg") {
      const svg = renderBoardSvg(layout.objects, {
        width: layout.width, height: layout.height, ink: bundle.ink, objectMatrices:layout.objectMatrices,
        fontCss:await boardFontSvgCss(boardHandwrittenText(bundle.document.objects,this.profiles)),
        characters: this.profiles, layers: bundle.document.layers, vectorAssets: bundle.document.vectorAssets,
        resolveAsset: (path) => this.assets.get(path),
        measureText: boardTextMeasurer(this.ownerDocument),
      });
      await this.host.app.vault.adapter.write(`${base}.svg`, svg);
    } else {
      const scale = Math.min(2, 8192 / Math.max(layout.width, layout.height));
      const canvas = this.ownerDocument.createElement("canvas");
      canvas.width = Math.ceil(layout.width * scale);
      canvas.height = Math.ceil(layout.height * scale);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-unavailable");
      context.fillStyle = bundle.document.background?.color ?? "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(scale, scale);
      renderBoardCanvas(context, layout.objects, {
        ink: bundle.ink, objectMatrices:layout.objectMatrices, characters: this.profiles, layers: bundle.document.layers, vectorAssets: bundle.document.vectorAssets,
        resolveAsset: (path) => this.assets.get(path),
      });
      if (format === "png") {
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("png-export-failed")), "image/png"));
        await this.host.app.vault.adapter.writeBinary(`${base}.png`, await blob.arrayBuffer());
      } else {
        const jpeg = canvas.toDataURL("image/jpeg", 0.94).split(",")[1]!;
        const pdf = jpegBase64ToPdf(jpeg, canvas.width, canvas.height);
        await this.host.app.vault.adapter.writeBinary(`${base}.pdf`, pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer);
      }
    }
    new Notice(t("board.exported", { format: format.toUpperCase() }));
  }
  private save(): Promise<void> {
    const anchorsChanged = this.syncAnchors();
    const done=beginTutorActivity();
    const sourceChanged = this.history.updateSourceRevision(this.sourceRevision());
    if (anchorsChanged || sourceChanged) {
      this.invalidate();
      this.onChange(this.bundle(), this);
    }
    const snapshot = this.bundle(), sequence = ++this.saveSequence;
    this.savePromise = this.savePromise
      .catch(() => undefined)
      .then(async () => {
        if (sequence !== this.saveSequence) return;
        // Fonts/SVG are derived: persist the original scene before their asynchronous work.
        await this.repository.save(snapshot.document, snapshot.ink,undefined,snapshot.layout);
        if (this.recoveredDraft) {
          this.recoveredDraft = false;
          this.status.textContent = t("board.saved");
        }
        const text = boardHandwrittenText(snapshot.document.objects, this.profiles);
        await ensureBoardFonts(this.ownerDocument, text);
        const measure = boardTextMeasurer(this.ownerDocument);
        const geometry = snapshot.document.objects.flatMap(object => {
          if (object.kind !== "text" || !object.textStyle || object.text === undefined) return [];
          return [{ id: object.id, text: object.text, width: object.width, textStyle: object.textStyle,
            height: layoutBoardText(object.text, object.textStyle, object.width, measure).height }];
        });
        if (this.history.refreshTextGeometry(geometry)) {
          this.integration.layout.reconcile(this.history.renderDocument,true,new Set(this.integration.registry?.entries.filter(e=>e.status==="located").map(e=>e.id)??[]));
          // A shared turn waiting for this save has not sampled the board yet.
          // Real edits still use normal invalidation and cancel its intent.
          this.invalidate(true, true, this.preparingTurn === 0);
          this.onChange(this.bundle(), this);
          this.schedule();
        }
        // Keep the latest requested state; do not regenerate an SVG for every
        // intermediate drag or typing transaction already superseded in queue.
        if (sequence !== this.saveSequence) return;
        const bundle = this.bundle();
        const fontCss = await boardFontSvgCss(boardHandwrittenText(bundle.document.objects, this.profiles));
        if (sequence !== this.saveSequence) return;
        await this.repository.save(bundle.document, bundle.ink, this.preview(bundle, fontCss),bundle.layout);
      })
      .catch((error) => {
        this.pause();
        this.conflict = error instanceof BoardConflictError;
        this.status.textContent = this.conflict
          ? t("board.conflict")
          : t("board.error", { detail: String(error) });
        throw error;
      }).finally(done);
    // callers that do not await still retain rejection for flush/dispose.
    void this.savePromise.catch(() => undefined);
    return this.savePromise;
  }
  public receive(bundle: BoardBundle): void {
    this.invalidate();
    if (!this.history.receiveMetadata(bundle.document)) {
      this.renderSnapshot = null;
      this.history.replace(copy(bundle.document));
      this.hitMappingKey="";this.spatial.clear();
    }
    this.ink = { ...this.ink, ...copy(bundle.ink) };
    if (this.gesture && this.tool === "pen") {
      this.gesture.before = copy(bundle.document.objects);
      this.penPreview();
    } else {
      this.gesture = null;
      this.draft = null;
      this.draftInk = {};
    }
    this.schedule();
    // Font faces belong to each window; a remote split's successful load does
    // not install them here. Repaint received text without saving or observing.
    void ensureBoardFonts(
      this.ownerDocument,
      boardHandwrittenText(bundle.document.objects, this.profiles),
    ).then(() => this.schedule()).catch((error: unknown) => {
      if (!this.disposed)
        this.status.textContent = t("board.error", { detail: String(error) });
    });
  }
  public invalidateSource(): void {
    this.finishGesture();
    this.invalidate();
    this.schedule();
    if (this.syncAnchors()) {
      this.history.updateSourceRevision(this.sourceRevision());
      this.onChange(this.bundle(), this);
      void this.save().catch(() => undefined);
    }
    if (
      this.together &&
      !this.editorState() &&
      this.integration.canObserve(this)
    )
      this.scheduler.changed(this.requestVersion(), () => this.runAgent());
  }
  public externalChanged(): void {
    this.pause();
    this.status.textContent = t("board.conflict");
    this.conflict = true;
    void this.save().catch(() => undefined);
  }
  private invalidate(preserveQueued = false, preserveManual = false, cancelConversation = true): void {
    this.generation++;
    this.scheduler.invalidate({ preserveQueued, preserveManual });
    if (cancelConversation) this.host.conversation?.cancelForBoard(this.conversationId);
    this.agent?.cancel();
    this.tutorPreview = [];
    this.schedule();
  }
  private setTogether(enabled: boolean, invalidate = true): void {
    this.together = enabled;
    this.scheduler.setEnabled(enabled);
    this.togetherButton.textContent = t(
      enabled ? "board.pause" : "board.together",
    );
    decorateBoardButton(this.togetherButton, "together");
    this.togetherButton.setAttribute("aria-pressed", String(enabled));
    if (!enabled) {
      if (invalidate) this.invalidate();
      this.status.textContent = t("board.paused");
    } else {
      this.integration.claim(this);
      this.sessionId = uid("SESSION");
      this.status.textContent = t("board.idle");
      // A learner may write the request first, then enable co-drawing.
      if (this.boardTextRequest())
        this.scheduler.changed(this.requestVersion(), () => this.runAgent());
    }
  }
  private pause(): void {
    this.setTogether(false);
  }
  /** Capture this layer's source before semantic dispatch. Focusing the input
   * or another split must not replace its file or unsaved editor buffer. */
  private async conversationContext(): Promise<ChatContext> {
    const started = Date.now();
    const current = () => {
      if (!this.sourceIsCurrent())
        throw new DOMException("Board source changed", "AbortError");
    };
    current();
    while (this.editorState()?.composing || this.editorState()?.ready === false) {
      this.status.textContent = t("board.composing");
      if (Date.now() - started > 10_000) throw new Error(t("board.composing"));
      await new Promise<void>(resolve => this.win.setTimeout(resolve, 32));
      current();
    }
    if (this.host.captureConversationContext) {
      const context = await this.host.captureConversationContext(this.view);
      current();
      if (context.notePath !== this.sourceFile || context.observation?.source !== this.sourceFile)
        throw new DOMException("Board source changed", "AbortError");
      return context;
    }
    const file = this.view.file!, mode = this.view.getMode?.(), editor = this.editorState();
    const diskVersion = `${file.stat.mtime}:${file.stat.size}`;
    if (file.extension === "pdf") return pdfLearningContext(this.view.containerEl, file);
    const text = editor ? editor.view.state.doc.toString()
      : this.view.getViewData ? this.view.getViewData()
        : await this.host.app.vault.cachedRead(file);
    current();
    if (this.view.file !== file || this.view.getMode?.() !== mode ||
      (editor ? this.editorState()?.view !== editor.view || editor.view.state.doc.toString() !== text
        : this.view.getViewData ? this.view.getViewData() !== text : `${file.stat.mtime}:${file.stat.size}` !== diskVersion))
      throw new DOMException("Board source changed", "AbortError");
    const viewport = this.root.getBoundingClientRect();
    const visibleText = this.surfaces.filter(surface => {
      const rect = surfaceRect(surface);
      return rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    }).map(surface => surface.text).filter(Boolean).join("\n").slice(0, 6000);
    return {notePath:this.sourceFile,noteTitle:file.basename,content:visibleText||text.slice(0,6000),visibleText,
      observation:{source:this.sourceFile,version:contextVersion(text),scope:visibleText?"visible-text":"document-excerpt",hasImage:false}};
  }
  private requestNow(): void {
    this.finishText(true);
    this.finishGesture();
    if (this.editorState()?.composing) {
      this.status.textContent = t("board.composing");
    }
    if (this.host.conversation) {
      const text = this.prompt.value.trim(), conversation = this.host.conversation;
      if (!text || this.quickInputPreparing) return;
      this.quickInputPreparing = true;
      void (async () => {
        try {
          const chat = await this.conversationContext();
          // A replacement draft or detached/rebound layer cancels preparation;
          // it never sends the old text to whatever window is now active.
          if (!this.sourceIsCurrent() || this.host.conversation !== conversation || this.prompt.value.trim() !== text) return;
          this.quickInputPreparing = false;
          this.prompt.value = "";
          this.replyOverlay.hideInput();
          void conversation.submit(text, { source: "board", boardId: this.conversationId, route: "board",context:{chat},
            learningTurn:{entry:"board",kind:"conversation",authority:localLearnerAuthority()} });
        } catch (error) {
          if (!this.disposed) this.status.textContent = t("board.error", { detail:String(error) });
        } finally { this.quickInputPreparing = false; }
      })();
      return;
    }
    if (!this.together) this.setTogether(true);
    this.integration.claim(this);
    this.scheduler.requestNow(this.requestVersion(), () => this.runAgent());
  }
  public modelChanged(): void {
    this.pause();
    this.agent?.dispose();
    this.agent = null;
    this.status.textContent = t("board.modelChanged");
  }
  private boardTextRequest(): BoardObject | undefined {
    const viewport = this.root.getBoundingClientRect();
    return [...this.history.renderDocument.objects].reverse().sort((a,b) =>
      this.integration.coordination.textPriority(b.id) - this.integration.coordination.textPriority(a.id)).find(object => {
      if (object.kind !== "text" || object.createdBy !== "human" || object.editedBy !== "human" ||
        !requestsBoardTextDrawing(object.text ?? "")) return false;
      const surface = this.objectSurface(object);
      if (!surface) return false;
      const rect = surfaceRect(surface);
      return rect.bottom > viewport.top && rect.top < viewport.bottom &&
        rect.right > viewport.left && rect.left < viewport.right;
    });
  }
  private async runAgent(): Promise<void> {
    const conversation = this.host.conversation;
    let chat: ChatContext | undefined;
    if (conversation) {
      if (!this.together || !this.sourceIsCurrent() || !this.integration.canObserve(this)) return;
      const generation = this.generation, version = this.requestVersion();
      chat = await this.conversationContext();
      if (!this.together || !this.sourceIsCurrent() || !this.integration.canObserve(this) ||
        this.host.conversation !== conversation || generation !== this.generation || version !== this.requestVersion()) return;
    }
    const candidate = this.together ? this.boardTextRequest() : undefined;
    const instruction = candidate && this.integration.coordination.claimTextRequest(candidate.id, candidate.text!)
      ? candidate.text!.trim() : "";
    if (conversation) {
      await conversation.submit(instruction, { source: "board", boardId: this.conversationId,
        route: "board", key: `${this.sourceFile}:${this.requestVersion()}`, context:{chat},
        // Enabling co-drawing permits help exposure tracking, never invitation
        // acceptance, answer grading or other conversational learning actions.
        learningTurn:{entry:"board",kind:"drawing",authority:localLearnerAuthority()} });
      return;
    }
    await this.performAgent({ instruction: instruction || this.prompt.value.trim(), history: [], onReply: () => {} });
  }
  private guardReflow(objects:readonly BoardObject[],surfaces=this.objectSurfaces()):void {
    const groups=new Map<string,BoardObject[]>();
    for(const o of objects)if(o.groupId.startsWith("LAYOUT-")){const list=groups.get(o.groupId)??[];list.push(o);groups.set(o.groupId,list);}
    if(!groups.size){this.hiddenLayoutObjects.clear();this.layoutNotice.hidden=true;return;}
    const key=JSON.stringify([this.history.revision,this.root.getBoundingClientRect().toJSON(),this.surfaces.map(s=>{const captured=surfaces.capture(s);return [s.anchor,captured.toClient(),captured.getClientRect()];})]);
    if(key===this.layoutGuardKey)return;
    this.layoutGuardKey=key;this.hiddenLayoutObjects.clear();
    for(const group of groups.values()){
      // A student deliberately moving a drawing takes ownership of its layout.
      if(group.some(o=>o.editedBy==="human"))continue;
      if(group.every(o=>this.integration.layout.binding(o.id)))continue;
      const raw=this.surfaceFor(group[0]!.anchor);if(!raw)continue;const surface=surfaces.capture(raw);
      const bounds=rectUnion(group.map(o=>objectClientBounds(o,surface.toClient())));
      // Once placed, a drawing is a surface the learner can annotate. Later
      // ink/text/shapes must not evict it; only document reflow protects prose.
      const space=this.drawingSpace(surface,new Set(group.map(o=>o.id)),false,"reflow",surfaces);
      // Scrolling out of view is not a collision and never changes saved geometry.
      if(overlaps(bounds,space.viewport)&&space.protected.some(r=>overlaps(r,bounds)))for(const o of group)this.hiddenLayoutObjects.add(o.id);
    }
    this.layoutNotice.hidden=!this.hiddenLayoutObjects.size;
  }
  private inspectHiddenDrawing():void {
    const modal=new Modal(this.host.app);modal.titleEl.textContent=t("upgrade.drawingHiddenTitle");
    modal.contentEl.createEl("p",{text:t("upgrade.drawingHiddenBody")});
    const bundle=this.bundle();bundle.document.objects=bundle.document.objects.filter(o=>this.hiddenLayoutObjects.has(o.id));
    const image=modal.contentEl.createEl("img");image.alt=t("upgrade.drawingHiddenTitle");image.style.cssText="width:100%;max-height:60vh;object-fit:contain";
    image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.preview(bundle))}`;
    void boardFontSvgCss(boardHandwrittenText(bundle.document.objects,this.profiles)).then(css=>{
      if(image.isConnected)image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.preview(bundle,css))}`;
    }).catch(()=>undefined);
    const move=modal.contentEl.createEl("button",{text:t("upgrade.drawingRearrange"),cls:"mod-cta"});
    move.onclick=()=>{
      const groups=new Map<string,BoardObject[]>();
      for(const o of bundle.document.objects){const list=groups.get(o.groupId)??[];list.push(o);groups.set(o.groupId,list);}
      const placements:BoardObject[]=[];
      for(const group of groups.values()){
        const surface=this.surfaceFor(group[0]!.anchor);if(!surface){new Notice(t("upgrade.drawingSpaceChanged"));return;}
        const space=this.drawingSpace(surface,new Set(group.map(o=>o.id)));
        space.protected.push(...placements.map(o=>objectClientBounds(o,this.objectSurface(o)!.toClient())));
        const placed=placeDrawingGroup(group,surface.toClient(),space);
        if(!placed){new Notice(t("upgrade.drawingSpaceChanged"));return;}
        placements.push(...placed);
      }
      // The modal is a preview only: editing meanwhile invalidates its draft.
      if(this.history.revision!==bundle.document.revision){new Notice(t("board.conflict"));return;}
      this.history.transact(doc=>{for(const o of placements){const i=doc.objects.findIndex(x=>x.id===o.id);doc.objects[i]={...o,revision:o.revision+1};}},"human");
      this.changed("human");modal.close();
    };
    modal.open();
  }
  /** CSS viewport geometry is the common currency for text, rotated pages and every object anchor. */
  private drawingSpace(surface:BoardSurface,exclude=new Set<string>(),allowText=false,purpose:"placement"|"reflow"="placement",surfaces=this.objectSurfaces()):DrawingSpace {
    if("projectionId" in surface){const p=surface as BoardProjection,inner=this.slotViews.get(p.projectionId)?.firstElementChild?.getBoundingClientRect();if(inner)return {viewport:{x:inner.x+12,y:inner.y+12,width:Math.max(0,inner.width-24),height:Math.max(0,inner.height-24)},protected:[]};}
    const r=this.root.getBoundingClientRect();
    const captured=boardCaptureClientRect(surface,{x:r.x,y:r.y,width:r.width,height:r.height});
    const viewport={x:captured.x+12,y:captured.y+12,width:Math.max(0,captured.width-24),height:Math.max(0,captured.height-24)};
    const protectedRects:BoardRect[]=[];
    const protect=(rect:BoardRect,padding=12)=>{if(rect.width>0&&rect.height>0)protectedRects.push({x:rect.x-padding,y:rect.y-padding,width:rect.width+padding*2,height:rect.height+padding*2});};
    // Reserve breathing room when placing new work. A settled drawing only
    // needs hiding when prose actually intersects its painted bounds: different
    // Markdown modes can consume that reserve without covering any text.
    const prosePadding=purpose==="reflow"?0:12;
    if(!allowText){
      // PDF pixels can contain scanned text and figures absent from the text layer.
      // Without reliable content geometry, never mistake that page for empty space.
      if(surface.kind==="pdf")protect(surface.getClientRect(),prosePadding);
      else {
        for(const item of this.surfaces)protect(surfaces.capture(item).getClientRect(),prosePadding);
        const content=this.view.containerEl;
        // Supplement CM's measured logical blocks with widgets and document chrome.
        for(const el of content.querySelectorAll<HTMLElement>(".cm-line,.cm-content .cm-embed-block,.cm-content img,.cm-content table,.cm-content .math,.markdown-preview-section > div,.inline-title,.metadata-container")){
          if(el.closest(".atl-board-root,.atl-board-toolbar,.atl-board-slot")||el.querySelector(".atl-board-slot"))continue;
          // CM gives even its final empty line a full-width box. That is
          // writable whitespace, not prose. Keep protecting rendered widgets
          // and controls even when their containing line has no text.
          if(el.matches(".cm-line") && !(el.textContent??"").replace(/[\u200b-\u200d\ufeff]/g,"").trim() &&
            !el.querySelector("img,table,.math,.cm-embed-block,canvas,svg,video,audio,iframe,input,button"))continue;
          const box=el.getBoundingClientRect();protect(box,prosePadding);
        }
      }
    }
    for(const el of [this.toolbar,...this.replyOverlay.element.querySelectorAll<HTMLElement>(".atl-board-reply,.atl-board-quick-input")]){
      if(!el.hidden && this.win.getComputedStyle(el).visibility!=="hidden")protect(el.getBoundingClientRect());
    }
    // New Tutor diagrams avoid every existing work. Reflow checks only document
    // content and chrome: overlap between already placed artwork is intentional
    // editing, not a reason to hide the picture underneath an annotation.
    if(purpose==="reflow")return {viewport,protected:protectedRects};
    const groups=new Map<string,BoardRect[]>();
    for(const object of this.history.renderDocument.objects){
      if(exclude.has(object.id))continue;
      const origin=surfaces(object);if(!origin)continue;
      const key=object.selectionGroupId??object.groupId??object.id;
      const list=groups.get(key)??[];list.push(objectClientBounds(object,origin.toClient()));groups.set(key,list);
    }
    for(const rects of groups.values())protect(rectUnion(rects));
    return {viewport,protected:protectedRects};
  }
  public availableDrawingArea():BoardRect|null|undefined {
    if(this.disposed||this.editorState()?.ready===false)return undefined;
    if(this.history.renderDocument.sourceType==="markdown")return {x:12,y:12,width:616,height:456};
    const surface=this.currentVisibleSurface();if(!surface)return undefined;
    try{return findDrawingRect(this.drawingSpace(surface));}catch{return undefined;}
  }
  private placeOperations(operations:BoardOperation[],surface:BoardSurface,annotation=false):BoardOperation[]{
    this.readDocument();
    const additions=operations.filter((op):op is Extract<BoardOperation,{type:"add"}>=>op.type==="add");
    // Updates never silently move or shrink someone else's existing composition.
    for(const op of operations){
      if(op.type!=="update")continue;
      const old=this.renderObjects.get(op.objectId);if(!old)continue;
      const matrix=this.objectSurface(old)?.toClient();if(!matrix)throw new Error(t("upgrade.drawingSpaceChanged"));
      const before=objectClientBounds(old,matrix),after=objectClientBounds(op.object,matrix);
      if(JSON.stringify(before)!==JSON.stringify(after) && !safeDrawingRect(this.drawingSpace(surface,new Set([old.id]),annotation),after))
        throw new Error(t("upgrade.drawingSpaceChanged"));
    }
    if(!additions.length)return operations;
    const space=this.drawingSpace(surface,new Set(),annotation);
    for(const op of operations)if(op.type==="update"){
      const matrix=this.objectSurface(op.object)?.toClient();if(!matrix)throw new Error(t("upgrade.drawingSpaceChanged"));
      space.protected.push(objectClientBounds(op.object,matrix));
    }
    const placed=placeDrawingGroup(additions.map(op=>op.object),surface.toClient(),space);
    if(!placed)throw new Error(t("upgrade.drawingSpaceChanged"));
    let index=0;
    return operations.map(op=>{if(op.type!=="add")return op;const object={...placed[index++]!,...(!annotation?{groupId:`LAYOUT-${additions[0]!.object.groupId}`}:{})};
      if("projectionId" in surface)this.pendingBindings.set(object.id,{slotId:(surface as BoardProjection).projectionId,matrix:(surface as BoardProjection).modelToSlot});return {...op,object};});
  }

  private async performAgent(turn: {
    instruction: string; history: ChatMessage[]; onReply: (delta: string) => void; signal?: AbortSignal; requiresDrawing?: boolean; math?: boolean; annotation?:boolean;commit?:DrawingCommitContext;
  }, captureAttempt = 0): Promise<{ text: string }> {
    const unavailable = (key: "board.unavailable" | "board.composing" | "board.conflict" = "board.unavailable", stale = false): {text:string} => {
      if (this.host.conversation) {
        if (stale || turn.signal?.aborted || !this.sourceIsCurrent()) throw new DOMException("Drawing context changed", "AbortError");
        throw new Error(t(key));
      }
      return {text:""};
    };
    if (this.textEditor) return unavailable("board.composing");
    if (!this.integration.canObserve(this)) return unavailable("board.unavailable",true);
    let editor = this.editorState();
    if (editor && (editor.composing || !editor.ready)) return unavailable("board.composing");
    if (this.conflict) return unavailable("board.conflict");
    if (!this.sourceIsCurrent() || (!this.host.conversation && !this.together) || this.gesture)
      return unavailable("board.unavailable",true);
    let surface = this.pendingSlot ? this.projections.get(this.pendingSlot.spec.id) : this.currentVisibleSurface();
    // Auto-opening a Markdown board can precede its first layout. Give the
    // concrete view a bounded chance to measure before sampling any pixels.
    for (let attempt=0; !surface && this.host.conversation && attempt<30; attempt++) {
      if (turn.signal?.aborted || !this.sourceIsCurrent()) return unavailable("board.unavailable",true);
      await new Promise<void>(resolve=>this.win.setTimeout(resolve,32));
      this.draw(); surface=this.currentVisibleSurface();
    }
    if (!surface) {
      this.status.textContent = t("board.unavailable");
      return unavailable();
    }
    this.active = surface;
    const generation = this.generation,
      revision = this.history.revision,
      sourceRevision = this.sourceRevision();
    let layout = boardSurfaceLayoutRevision(surface);
    this.status.textContent = t("board.thinking");
    let snapshot;
    const selected = [...this.selection];
    try {
      this.selection.clear();
      this.draw();
      await ensureBoardFonts(
        this.ownerDocument,
        boardHandwrittenText(this.history.renderDocument.objects, this.profiles),
      );
      if (!this.sourceIsCurrent() || turn.signal?.aborted || generation !== this.generation) return unavailable("board.unavailable",true);
      const readyAt = Date.now();
      while (this.host.conversation && this.editorState()?.ready === false) {
        if (turn.signal?.aborted || !this.sourceIsCurrent()) return unavailable("board.unavailable",true);
        if (Date.now() - readyAt > 10_000) throw new Error(t("board.unavailable"));
        await new Promise<void>(resolve => this.win.setTimeout(resolve, 32));
      }
      this.draw();
      // CM measurements replace surfaces. A prior surface has stale rect/matrix
      // even though its layout token reads the latest editor epoch.
      surface = this.surfaceFor(surface.anchor) ?? this.currentVisibleSurface();
      if (!surface) throw new Error(t("board.unavailable"));
      if(turn.math && !selected.length && surface.kind==="markdown"&&!("projectionId" in surface)){
        // New math diagrams placed below prose should follow that nearby
        // paragraph, not the first/largest heading. The accumulated gaps above
        // it differ across Markdown modes. Choose before capture so snapshot,
        // model coordinates and committed objects share the same origin.
        const space=this.drawingSpace(surface),area=findDrawingRect(space);
        if(area)surface=this.surfaces.filter(candidate=>{
          if(candidate.kind!=="markdown")return false;
          const rect=candidate.getClientRect();
          return rect.width>0 && rect.height>0 && overlaps(rect,space.viewport) &&
            rect.y+rect.height<=area.y && rect.x<area.x+area.width && rect.x+rect.width>area.x;
        }).sort((a,b)=>{const x=a.getClientRect(),y=b.getClientRect();return y.y+y.height-x.y-x.height;})[0]??surface;
      }
      this.active = surface;
      editor = this.editorState();
      const r = this.root.getBoundingClientRect();
      layout = boardSurfaceLayoutRevision(surface);
      snapshot = await captureBoardSnapshot(
        surface,
        [this.toolbar, this.selectionBar, this.replyOverlay.element],
        {
        x: r.x, y: r.y, width: r.width, height: r.height,
        },
      );
      layout = snapshot.layoutRevision;
    } catch (error) {
      // Clicking a toolbar button can finish a Live Preview widget edit. Its
      // ensuing CM measure invalidates the first surface without being a
      // screenshot failure. Retry the same intent after layout settles.
      if (
        error instanceof Error &&
        error.message === "capture-layout-changed" &&
        captureAttempt < 2 &&
        (this.together || !!this.host.conversation) &&
        this.sourceIsCurrent() &&
        sourceRevision === this.sourceRevision() &&
        this.integration.canObserve(this)
      ) {
        await new Promise<void>((resolve) =>
          this.win.requestAnimationFrame(() =>
            this.win.requestAnimationFrame(() => resolve()),
          ),
        );
        return await this.performAgent(turn, captureAttempt + 1);
      }
      this.setTogether(false, !this.host.conversation);
      this.status.textContent = `${t("board.captureError")} ${String(error)}`;
      if (this.host.conversation) throw error;
      return unavailable("board.unavailable",true);
    } finally {
      for (const id of selected) this.selection.add(id);
      this.schedule();
    }
    if (
      !this.sourceIsCurrent() || turn.signal?.aborted ||
      (!this.host.conversation && !this.together) ||
      generation !== this.generation ||
      revision !== this.history.revision ||
      sourceRevision !== this.sourceRevision() ||
      layout !== boardSurfaceLayoutRevision(surface)
    )
      return unavailable("board.unavailable",true);
    const clientSpace=this.drawingSpace(surface,new Set(),turn.annotation);
    const area=findDrawingRect(clientSpace);
    if(turn.math && !area)throw new Error(t("upgrade.drawingSpaceChanged"));
    const imageFromClient=invertBoardMatrix(multiplyBoardMatrices(surface.toClient(),snapshot.imageToBoard));
    const drawingArea=area?mapRect(area,imageFromClient):undefined;
    const commit=turn.commit??this.drawingCommitContext(selected,turn.signal);
    this.agent ??= this.host.createAgent();
    const instruction = turn.instruction;
    const requestId = uid("REQUEST");
    const capturedLayoutRevision=this.integration.layout.revision;
    const projectionCurrent=()=>!("projectionId" in surface!) || (capturedLayoutRevision===this.integration.layout.revision&&layout===boardSurfaceLayoutRevision(this.projections.get((surface as BoardProjection).projectionId)??surface!));
    const requestSurfaces = this.objectSurfaces();
    const requestObjects = this.history.renderDocument.objects.filter(o => requestSurfaces(o)?.id === surface.id);
    const objectToImage = Object.fromEntries(requestObjects.map(object => {
      const origin = requestSurfaces(object);
      if (!origin) throw new Error(t("upgrade.drawingSpaceChanged"));
      return [object.id, multiplyBoardMatrices(imageFromClient, origin.toClient())];
    }));
    const result = await requestBoardWithRepair(this.agent, {
      boardId: this.history.renderDocument.id,
      sessionId: this.sessionId,
      requestId,
      baseRevision: revision,
      sourceRevision,
      bufferRevision: editor?.bufferRevision,
      layoutRevision:this.integration.layout.revision,
      projectionId:"projectionId" in surface?(surface as BoardProjection).projectionId:undefined,
      sourceFile: this.sourceFile,
      anchor: surface.anchor,
      snapshot,
      objects: copy(requestObjects),
      objectToImage,
      instruction,
      requiresDrawing: turn.requiresDrawing,
      math: turn.math,
      drawingArea,
      drawingPixelRatio:Math.hypot(imageFromClient[0],imageFromClient[1]),
      history: turn.history.filter((message): message is { role: "user" | "assistant"; content: string } => message.role !== "system"),
      context: surface.text.slice(0, 8000),
      character: this.currentCharacter(),
      availableAssets: this.profiles,
    }, (event) => {
      if (!this.sourceIsCurrent() || turn.signal?.aborted || generation !== this.generation ||
        revision !== this.history.revision || sourceRevision !== this.sourceRevision() || !projectionCurrent()) return;
      if (event.type === "reset") {this.tutorPreview=[];this.host.conversation?.resetBoardReply();this.schedule();}
      else if (event.type === "reply") turn.onReply(event.text);
      else {
        try{this.tutorPreview=this.placeOperations(event.operations,this.surfaceFor(surface!.anchor)??surface!,turn.annotation);}catch{this.tutorPreview=[];}
        this.schedule();
        const text = boardHandwrittenText(event.operations.flatMap(op => op.type === "remove" ? [] : [op.object]), this.profiles);
        void ensureBoardFonts(this.ownerDocument, text).then(() => this.schedule()).catch(() => undefined);
      }
    }, () => this.sourceIsCurrent() && !turn.signal?.aborted && generation === this.generation &&
      revision === this.history.revision && sourceRevision === this.sourceRevision() && projectionCurrent());
    if (
      !this.sourceIsCurrent() || turn.signal?.aborted ||
      (!this.host.conversation && !this.together) ||
      generation !== this.generation ||
      revision !== this.history.revision ||
      sourceRevision !== this.sourceRevision() ||
      !projectionCurrent() ||
      (!this.host.conversation && layout !== boardSurfaceLayoutRevision(surface))
    )
      return unavailable("board.unavailable",true);
    if (!result.ok) {
      this.lastDrawingFailure = {at:now(),code:result.code,reason:result.error.slice(0,2500)};
      this.tutorPreview = [];
      this.schedule();
      this.setTogether(false, !this.host.conversation);
      const detail = result.error.startsWith("math-") ? t("board.mathInvalid") : result.failure && ["access","rate-limit","provider","no-output"].includes(result.failure.category)
        ? t(`board.failure.${result.failure.category}`,{model:result.failure.model}) : result.error === "provider-no-output" ? t("board.failure.no-output",{model:resolveBoardConnection(this.host.settings()).model}) : result.error === "empty-drawing-response" ? t("board.emptyDrawingReply") :
        ["incomplete-drawing-json", "unfinished-drawing-path"].includes(result.error) ? t("board.unfinishedDrawingReply") :
        /incomplete-response: (?:length|max_tokens)/.test(result.error) ? t("board.drawingOutputLimit") :
        result.error === "incomplete-api-response" ? t("board.drawingConnectionEnded") :
        result.error === "drawing-request-produced-no-objects" ? t("board.noDrawing") :
        result.code === "incomplete-response" || /incomplete-(?:stream-|api-)?response|unfinished-path/.test(result.error)
          ? t("board.incompleteReply") : result.code === "invalid-response" ? t("board.invalidDrawing") : result.error;
      this.status.textContent = t("board.error", { detail });
      if (this.host.conversation) throw result.failure ? new AIExecutionError(detail,result.failure) : new Error(detail);
      return unavailable("board.unavailable",true);
    }
    if (result.requestId !== requestId || result.baseRevision !== revision)
      return unavailable("board.unavailable",true);
    try {
      await ensureBoardFonts(this.ownerDocument, boardHandwrittenText(result.operations.flatMap(op => op.type === "remove" ? [] : [op.object]), this.profiles));
      if (!this.sourceIsCurrent() || turn.signal?.aborted || generation !== this.generation ||
        revision !== this.history.revision || sourceRevision !== this.sourceRevision() || !projectionCurrent()) return unavailable("board.unavailable",true);
      for (const op of result.operations) {
          if (op.type !== "remove" && op.object.kind === "text") {
            const style = resolvedBoardTextStyle(op.object);
            op.object.height = layoutBoardText(
              op.object.text ?? "",
              style,
              op.object.width,
              boardTextMeasurer(this.ownerDocument),
            ).height;
          }
      }
      this.draw();
      const currentSurface=this.surfaceFor(surface.anchor);if(!currentSurface)throw new Error(t("upgrade.drawingSpaceChanged"));
      const placed=this.placeOperations(result.operations,currentSurface,turn.annotation);
      if (placed.length) {
        const doc={objects:copy(commit.before)};
        for (const op of placed) {
          if (op.type === "add") {
            if (doc.objects.some((o) => o.id === op.object.id))
              throw new Error("duplicate object");
            doc.objects.push({
              ...op.object,
              createdBy: "tutor",
              editedBy: "tutor",
            });
          } else {
            const index = doc.objects.findIndex((o) => o.id === op.objectId),
              old = doc.objects[index];
            if (
              !old ||
              old.createdBy !== "tutor" ||
              old.editedBy === "human" ||
              old.revision !== op.expectedRevision
            )
              throw new Error("object changed");
            if (op.type === "remove") doc.objects.splice(index, 1);
            else
              doc.objects[index] = {
                ...op.object,
                id: old.id,
                createdBy: old.createdBy,
                editedBy: "tutor",
              };
          }
        }
        await this.commitDrawing(commit,doc.objects,turn.signal);
      }
      if(turn.signal?.aborted||!this.sourceIsCurrent())return {text:result.description.trim()||t("chat.boardUpdated")};
      if (instruction === this.prompt.value.trim()) this.prompt.value = "";
      this.status.textContent = t("board.saved");
      this.tutorPreview = [];
      this.schedule();
      const description = result.description.trim();
      if (result.operations.length) return { text: description || t("chat.boardUpdated") };
      if(commit.standalone)commit.tasks.complete(commit.taskId,"obsidian");
      if (turn.requiresDrawing ?? requestsDrawing(instruction)) throw new Error(t("board.noDrawing"));
      if (instruction.trim() && !description) throw new Error(t("chat.empty"));
      return { text: description };
    } catch (error) {
      if(this.host.conversation&&this.host.conversation.activeTask?.id!==commit.taskId)throw error;
      this.tutorPreview=[];this.schedule();
      this.setTogether(false, !this.host.conversation);
      this.status.textContent = t("board.error", { detail: String(error) });
      if (this.host.conversation) throw error;
      return unavailable("board.unavailable",true);
    }
  }
  private sourceRevision(): string {
    if (this.integration.registry) return this.integration.registry.version;
    const file = this.view.file;
    return file?.path === this.sourceFile
      ? `${file.stat.mtime}:${file.stat.size}`
      : this.history.renderDocument.sourceRevision;
  }
  private currentCharacter(): TutorCharacterProfile | null {
    return (
      this.profiles.find(
        (p) =>
          p.id === this.history.renderDocument.characterId &&
          p.version === this.history.renderDocument.characterVersion,
      ) ??
      this.profiles[0] ??
      null
    );
  }
  private stickerObject(
    profile: TutorCharacterProfile,
    anchor: BoardAnchor,
    position: BoardPoint,
    size: number,
    expression: BoardExpression = "quiet",
  ): BoardObject {
    const {
      characterId: _id,
      characterVersion: _version,
      ...base
    } = this.characterObject(profile, anchor, position, size, expression);
    return {
      ...base,
      kind: "sticker",
      assetId: profile.id,
      assetVersion: profile.version,
    };
  }
  private async stickerModal(): Promise<void> {
    this.finishText(true);
    await this.loadProfiles();
    if (this.disposed) return;
    const library = await this.repository.characterLibraryState();
    const hidden = new Set(library.hiddenProfileIds);
    const hiddenStickers = new Set(library.hiddenStickerKeys);
    const modal = new Modal(this.host.app);
    modal.titleEl.textContent = t("board.sticker");
    modal.contentEl.classList.add("atl-board-sticker-modal");
    const header = modal.contentEl.createDiv({ cls: "atl-board-sticker-header" });
    const searchWrap = header.createDiv({ cls: "atl-board-sticker-search" });
    setIcon(searchWrap, "search");
    const search = searchWrap.createEl("input", {
      type: "search",
      placeholder: t("board.searchAssets"),
    });
    search.setAttribute("aria-label", t("board.searchAssets"));
    const filters = header.createDiv({ cls: "atl-board-sticker-filters", attr: { role: "group", "aria-label": t("board.sticker") } });
    let filter: "all" | "builtin" | "mine" | "removed" = "all";
    const filterButtons = ([
      ["all", "assetAll"], ["builtin", "assetBuiltIn"], ["mine", "assetMine"], ["removed", "assetRemovedFilter"],
    ] as const).map(([value, key]) => {
      const control = filters.createEl("button", { text: t(`board.${key}`) });
      control.type = "button";
      control.setAttribute("aria-pressed", String(value === filter));
      control.onclick = () => {
        filter = value;
        for (const button of filterButtons) button.setAttribute("aria-pressed", String(button === control));
        render();
      };
      return control;
    });
    const undo = modal.contentEl.createDiv({ cls: "atl-board-sticker-undo" });
    undo.hidden = true;
    const undoText = undo.createEl("span", { text: t("board.assetRemoved") });
    const undoButton = undo.createEl("button");
    undoButton.type = "button";
    setIcon(undoButton, "undo-2");
    undoButton.createEl("span", { text: t("board.undoRemove") });
    let removed: { profile: TutorCharacterProfile; expression: BoardExpression } | null = null;
    const setHidden = async (profile: TutorCharacterProfile, expression: BoardExpression, value: boolean) => {
      if (profile.origin === "builtin") {
        await this.repository.setBuiltInStickerHidden(profile.id, expression, value);
        const key = boardStickerKey(profile, expression);
        if (value) hiddenStickers.add(key); else hiddenStickers.delete(key);
      } else {
        await this.repository.setCharacterHidden(profile.id, value);
        if (value) hidden.add(profile.id); else hidden.delete(profile.id);
      }
      render();
    };
    undoButton.onclick = () => {
      if (!removed) return;
      const target = removed;
      undoButton.disabled = true;
      void setHidden(target.profile, target.expression, false).then(() => {
        removed = null;
        undo.hidden = true;
      }).catch(error => new Notice(t("board.error", { detail: String(error) })))
        .finally(() => { undoButton.disabled = false; });
    };
    const list = modal.contentEl.createDiv({ cls: "atl-board-sticker-grid" });
    const items = this.profiles.flatMap(profile => boardStickerExpressions(profile).map(expression => ({ profile, expression })));
    const render = () => {
      list.replaceChildren();
      for (const { profile, expression } of items) {
        const isRemoved = hidden.has(profile.id) || hiddenStickers.has(boardStickerKey(profile, expression));
        if (filter === "removed" ? !isRemoved : isRemoved) continue;
        if (filter === "builtin" && profile.origin !== "builtin") continue;
        if (filter === "mine" && profile.origin === "builtin") continue;
        const name =
          profile.id === "tutor-round"
            ? t("board.round")
            : profile.id === "tutor-book"
              ? t("board.book")
              : profile.origin === "builtin" &&
                  profile.id.startsWith("tutor-kaomoji-")
                ? t(
                    `board.${profile.id.slice(14) === "thinking" ? "thinkingFace" : profile.id.slice(14)}`,
                  )
                : profile.name;
        const label = `${name}${profile.style === "round" || profile.style === "book" ? ` · ${t(`board.${expression === "thinking" ? "thinkingFace" : expression}`)}` : ""}${profile.origin !== "builtin" ? ` · ${t("board.characterVersion", { version: profile.version })}` : ""}`;
        if (
          !`${label} ${profile.name} ${(profile.tags ?? []).join(" ")}`
            .toLowerCase()
            .includes(search.value.trim().toLowerCase())
        )
          continue;
        const card = list.createDiv({ cls: "atl-board-sticker-card" });
        card.classList.toggle("is-custom", profile.origin !== "builtin");
        card.classList.toggle("is-removed", isRemoved);
        const button = card.createEl("button", { cls: "atl-board-sticker-tile" });
        button.type = "button";
        button.disabled = isRemoved;
        button.title = label;
        button.setAttribute("aria-label", label);
        const canvas = button.createEl("canvas");
        canvas.width = 160;
        canvas.height = 112;
        const object = this.stickerObject(
          profile,
          { kind: "markdown", key: "preview", quote: "" },
          { x: 10, y: 8 },
          Math.min(140, (96 * profile.width) / profile.height),
          expression,
        );
        const draw = () => {
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, 160, 112);
          renderBoardCanvas(ctx, [object], {
            ink: {},
            characters: this.profiles,
            resolveAsset: (p) => this.assets.get(p),
            requestRender: () => {
              if (button.isConnected) draw();
            },
          });
        };
        draw();
        void ensureBoardFonts(
          canvas.ownerDocument,
          boardHandwrittenText([object], this.profiles),
        )
          .then(() => {
            if (button.isConnected) draw();
          })
          .catch(() => undefined);
        const copy = button.createDiv({ cls: "atl-board-sticker-copy" });
        copy.createEl("strong", { text: name });
        copy.createEl("span", {
          cls: "atl-board-sticker-source",
          text: isRemoved ? t("board.assetRemovedFilter") : profile.origin === "builtin"
            ? t("board.assetSourceBuiltIn")
            : `${t("board.assetSourceCustom")} · ${t("board.characterVersion", { version: profile.version })}`,
        });
        button.onclick = () => {
          const surface = this.currentVisibleSurface();
          if (!surface) {
            new Notice(t("board.unavailable"));
            return;
          }
          const r = surfaceRect(surface),
            v = surface.viewportElement.getBoundingClientRect();
          const position = surface.unproject({
            x: Math.max(r.left, v.left) + 24,
            y: Math.max(r.top, v.top) + 32,
          });
          const placed = this.stickerObject(
            profile,
            surface.anchor,
            position,
            Math.min(128, (96 * profile.width) / profile.height),
            expression,
          );
          this.history.transact((doc) => doc.objects.push(placed), "human");
          this.active = surface;
          this.selection.clear();
          this.selectObject(placed, true);
          this.setTool("select");
          this.changed();
          modal.close();
        };
        const remove = card.createEl("button", { cls: "atl-board-sticker-remove" });
        remove.type = "button";
        remove.title = t(isRemoved ? "board.restoreToLibrary" : "board.removeFromLibrary");
        remove.setAttribute("aria-label", `${remove.title} · ${label}`);
        setIcon(remove, isRemoved ? "rotate-ccw" : "trash-2");
        remove.onclick = event => {
          event.preventDefault();
          event.stopPropagation();
          remove.disabled = true;
          void setHidden(profile, expression, !isRemoved).then(() => {
            if (!isRemoved) {
              removed = { profile, expression };
              undoText.textContent = t("board.assetRemoved");
              undo.hidden = false;
            } else if (removed?.profile.id === profile.id && removed.expression === expression) {
              removed = null;
              undo.hidden = true;
            }
          }).catch(error => {
            remove.disabled = false;
            new Notice(t("board.error", { detail: String(error) }));
          });
        };
      }
      if (!list.childElementCount)
        list.createEl("p", { text: t("board.noAssets") });
    };
    search.oninput = render;
    const actions = modal.contentEl.createDiv({
      cls: "atl-board-sticker-actions",
    });
    const actionButton = (label: string, icon: string, callback: () => void) => {
      const button = actions.createEl("button");
      button.type = "button";
      setIcon(button, icon);
      button.createEl("span", { text: label });
      button.onclick = callback;
      return button;
    };
    const upload = actions.createEl("input", { type: "file" });
    upload.hidden = true;
    upload.accept = "image/png,image/jpeg,image/webp";
    upload.setAttribute("aria-label", t("board.uploadSticker"));
    upload.title = t("board.uploadSticker");
    upload.onchange = () => {
      const file = upload.files?.[0];
      if (!file) return;
      void this.uploadCharacter(file, "sticker")
        .then(() => {
          modal.close();
          return this.stickerModal();
        })
        .catch(
          (error) => new Notice(t("board.error", { detail: String(error) })),
        );
    };
    actionButton(t("board.uploadSticker"), "upload", () => upload.click());
    actionButton(t("board.saveSticker"), "bookmark-plus", () => {
      modal.close();
      this.saveSelectionCharacter("sticker");
    });
    actionButton(t("board.cancel"), "x", () => modal.close());
    render();
    modal.open();
  }
  private async loadProfiles(): Promise<void> {
    this.profiles = [
      ...builtInBoardAssets(),
      ...(await this.repository.characters()),
    ];
    const paths = new Set(
      this.profiles.flatMap((p) => (p.assetPath ? [p.assetPath] : [])),
    );
    for (const path of paths) {
      if (
        !path.startsWith(`${this.repository.memoryRoot}/characters/`) ||
        this.assets.has(path)
      )
        continue;
      try {
        const data = await this.host.app.vault.adapter.readBinary(path);
        const mime = path.endsWith(".webp")
          ? "image/webp"
          : /\.jpe?g$/i.test(path)
            ? "image/jpeg"
            : "image/png";
        this.assets.set(
          path,
          `data:${mime};base64,${Buffer.from(data).toString("base64")}`,
        );
      } catch {
        /* missing asset will show a placeholder */
      }
    }
  }
  private async options(): Promise<void> {
    const missing = new Set<string>();
    if (this.integration.registry) {
      for (const object of this.history.renderDocument.objects) {
        if (
          object.anchor.kind === "markdown" &&
          this.integration.registry.resolve(object.anchor)?.status !== "located"
        )
          missing.add(object.id);
      }
    } else if (this.view.file?.extension === "md") {
      try {
        const source = (await this.host.app.vault.cachedRead(this.view.file))
          .replace(/\s+/g, " ")
          .trim();
        for (const object of this.history.renderDocument.objects) {
          const anchor = object.anchor;
          if (anchor.kind !== "markdown" || this.surfaceFor(anchor)) continue;
          const block = anchor.key.startsWith("block:")
            ? anchor.key.slice(6)
            : null;
          const exists = block
            ? source.split(/\s+/).includes(`^${block}`)
            : source.includes(anchor.quote.replace(/\s+/g, " ").trim());
          if (!exists) missing.add(object.id);
        }
      } catch {
        /* Without the full source, unmounted paragraphs cannot safely be reattached. */
      }
    }
    if (this.disposed) return;
    const modal = new Modal(this.host.app);
    modal.titleEl.textContent = t("board.settings");
    modal.contentEl.createEl("p", { text: t(resolveBoardConnection(this.host.settings()).mode === "inherit" ? "board.sharedConnection" : "board.customConnection",{model:resolveBoardConnection(this.host.settings()).model}) });
    const selected=this.history.renderDocument.objects.filter(o=>this.selection.has(o.id));
    const slotIds=new Set(selected.flatMap(o=>{const b=this.integration.layout.binding(o.id);return b?[b.slot.id]:[];}));
    const notes=selected.filter(o=>o.createdBy==="human"&&!this.integration.layout.binding(o.id));
    if(slotIds.size===1&&notes.length)this.button(modal.contentEl,"attachAnnotations",()=>{
      this.draw();const slotId=[...slotIds][0]!,projection=this.projections.get(slotId);if(!projection)return;
      const matrices=new Map<string,import("./board-types.js").BoardMatrix>();
      // Legacy notes on the same source share raw coordinates with the diagram.
      const reference=selected.find(o=>this.integration.layout.binding(o.id)?.slot.id===slotId)!;
      const ref=this.integration.layout.binding(reference.id)!;
      for(const note of notes){const base=this.sourceSurfaceFor(note.anchor),referenceBase=this.sourceSurfaceFor(reference.anchor);if(!base||!referenceBase){new Notice(t("board.unavailable"));return;}
        matrices.set(note.id,multiplyBoardMatrices(ref.matrix,multiplyBoardMatrices(invertBoardMatrix(referenceBase.toClient()),base.toClient())));}
      this.history.checkpoint();this.integration.layout.confirm(notes,slotId,matrices);this.changed("human",true,false);modal.close();
    });
    if (missing.size)
      modal.contentEl.createEl("p", { text: t("board.missing") });
    const reattach = this.button(modal.contentEl, "reattach", () => {
      const target = this.currentVisibleSurface();
      if (target) {
        this.history.transact((doc) => {
          for (const o of doc.objects)
            if (missing.has(o.id)) o.anchor = copy(target.anchor);
        }, "human");
        this.changed();
        modal.close();
      }
    });
    reattach.disabled = missing.size === 0;
    this.button(modal.contentEl, "export", () => {
      modal.close();
      void (this.integration.openSaved ? this.integration.openSaved(this) : this.save().then(() => this.host.app.workspace.openLinkText(`${this.repository.memoryRoot}/boards/${this.history.renderDocument.id}.md`, "", true)))
        .catch(error => new Notice(t("board.error", { detail: String(error) })));
    });
    this.button(modal.contentEl, "exportPng", () => { modal.close(); void this.exportBoard("png"); });
    this.button(modal.contentEl, "exportSvg", () => { modal.close(); void this.exportBoard("svg"); });
    this.button(modal.contentEl, "exportPdf", () => { modal.close(); void this.exportBoard("pdf"); });
    this.button(modal.contentEl, "exportSelection", () => { modal.close(); void this.exportBoard("png", true); });
    this.button(modal.contentEl, "save", () => {
      modal.close();
    });
    modal.contentEl.addClass("atl-board-options");
    modal.open();
  }
  private async characterModal(): Promise<void> {
    await this.loadProfiles();
    const modal = new Modal(this.host.app);
    modal.titleEl.textContent = t("board.character");
    const list = modal.contentEl.createDiv({ cls: "atl-board-character-list" });
    const select = modal.contentEl.createEl("select");
    select.setAttribute("aria-label", t("board.expression"));
    for (const value of [
      "thinking",
      "curious",
      "discovery",
      "encouraging",
      "celebrating",
      "quiet",
    ] as BoardExpression[])
      select.add(
        new Option(
          t(`board.${value === "thinking" ? "thinkingFace" : value}`),
          value,
        ),
      );
    for (const profile of this.profiles.filter(
      (profile) => profile.usage !== "sticker",
    )) {
      const row = list.createDiv({ cls: "atl-board-character-option" });
      const name =
        profile.id === "tutor-round"
          ? t("board.round")
          : profile.id === "tutor-book"
            ? t("board.book")
            : profile.name;
      const preview = row.createEl("canvas");
      preview.width = 100;
      preview.height = 100;
      const ctx = preview.getContext("2d");
      if (ctx)
        renderBoardCanvas(
          ctx,
          [
            this.characterObject(
              profile,
              { kind: "markdown", key: "preview", quote: "" },
              { x: 5, y: 5 },
              90,
            ),
          ],
          {
            ink: {},
            characters: this.profiles,
            resolveAsset: (p) => this.assets.get(p),
            requestRender: () => {
              if (modal.contentEl.isConnected && ctx)
                renderBoardCanvas(
                  ctx,
                  [
                    this.characterObject(
                      profile,
                      { kind: "markdown", key: "preview", quote: "" },
                      { x: 5, y: 5 },
                      90,
                    ),
                  ],
                  {
                    ink: {},
                    characters: this.profiles,
                    resolveAsset: (p) => this.assets.get(p),
                  },
                );
            },
          },
        );
      const button = row.createEl("button", {
        text:
          profile.origin === "builtin"
            ? name
            : `${name} — ${t("board.characterVersion", { version: profile.version })}`,
      });
      button.onclick = () => {
        const surface = this.currentVisibleSurface();
        if (!surface) {
          new Notice(t("board.unavailable"));
          return;
        }
        const r = surfaceRect(surface),
          v = this.root.getBoundingClientRect();
        const position = surface.unproject({
          x: Math.max(v.left + 30, Math.min(r.right - 100, v.right - 150)),
          y: Math.max(v.top + 120, r.top + 10),
        });
        const object = this.characterObject(
          profile,
          surface.anchor,
          position,
          96,
          select.value as BoardExpression,
        );
        this.history.transact((doc) => {
          doc.characterId = profile.id;
          doc.characterVersion = profile.version;
          doc.objects.push(object);
        }, "human");
        this.active = surface;
        this.selection.clear();
        this.selection.add(object.id);
        this.setTool("select");
        this.changed();
        modal.close();
      };
    }
    const upload = modal.contentEl.createEl("input", { type: "file" });
    upload.accept = "image/png,image/jpeg,image/webp";
    upload.setAttribute("aria-label", t("board.upload"));
    upload.onchange = () => {
      const file = upload.files?.[0];
      if (file)
        void this.uploadCharacter(file)
          .then(() => {
            modal.close();
            void this.characterModal();
          })
          .catch(
            (error) => new Notice(t("board.error", { detail: String(error) })),
          );
    };
    this.button(modal.contentEl, "saveCharacter", () => {
      if (!this.selection.size) {
        new Notice(t("board.characterEmpty"));
        return;
      }
      modal.close();
      this.saveSelectionCharacter();
    });
    modal.open();
  }
  private characterObject(
    profile: TutorCharacterProfile,
    anchor: BoardAnchor,
    position: BoardPoint,
    size: number,
    expression: BoardExpression = "quiet",
  ): BoardObject {
    return {
      id: uid("OBJ"),
      kind: "character",
      anchor: copy(anchor),
      x: position.x,
      y: position.y,
      width: size,
      height: (size * profile.height) / profile.width,
      color: this.color,
      strokeWidth: 2,
      characterId: profile.id,
      characterVersion: profile.version,
      expression,
      createdBy: "human",
      editedBy: "human",
      revision: 1,
      groupId: uid("GROUP"),
    };
  }
  private async uploadCharacter(
    file: File,
    usage: "character" | "sticker" = "character",
  ): Promise<void> {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 8 * 1024 * 1024
    )
      throw new Error(t("board.uploadInvalid"));
    const bytes = await file.arrayBuffer(),
      url = this.win.URL.createObjectURL(
        new Blob([bytes], { type: file.type }),
      );
    const image = new this.win.Image();
    try {
      image.src = url;
      await image.decode();
      if (
        !image.naturalWidth ||
        !image.naturalHeight ||
        image.naturalWidth * image.naturalHeight > 25000000
      )
        throw new Error(t("board.uploadInvalid"));
      const id = uid("CHAR"),
        root = `${this.repository.memoryRoot}/characters`,
        path = `${root}/${id}.${file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png"}`;
      let folder = "";
      for (const segment of root.split("/")) {
        folder = folder ? `${folder}/${segment}` : segment;
        if (!(await this.host.app.vault.adapter.exists(folder)))
          await this.host.app.vault.adapter.mkdir(folder);
      }
      await this.host.app.vault.adapter.writeBinary(path, bytes);
      await this.repository.saveCharacter({
        id,
        version: 1,
        name: file.name.replace(/\.[^.]+$/, ""),
        origin: "uploaded",
        style: "custom",
        width: image.naturalWidth,
        height: image.naturalHeight,
        createdAt: now(),
        assetPath: path,
        usage,
        tags: [],
      });
    } finally {
      this.win.URL.revokeObjectURL(url);
    }
  }
  private saveSelectionCharacter(
    usage: "character" | "sticker" = "character",
  ): void {
    const objects = copy(
      this.history.renderDocument.objects.filter((o) => this.selection.has(o.id)),
    );
    if (!objects.length) return;
    const modal = new Modal(this.host.app);
    modal.titleEl.textContent = t(
      usage === "sticker" ? "board.saveSticker" : "board.saveCharacter",
    );
    const name = modal.contentEl.createEl("input", {
      type: "text",
      placeholder: t("board.name"),
    });
    name.setAttribute("aria-label", t("board.name"));
    this.button(modal.contentEl, "save", () => {
      if (!name.value.trim()) {
        name.focus();
        return;
      }
      // Freeze the displayed arrangement, even when objects have different paragraph anchors.
      const projected = objects.map((o) => {
        const surface = this.objectSurface(o);
        if (!surface) return o;
        const [a, b, c, d] = surface.toClient(),
          angle = o.rotation ?? 0,
          co = Math.cos(angle),
          si = Math.sin(angle),
          sx = Math.hypot(a * co + c * si, b * co + d * si),
          sy = Math.hypot(-a * si + c * co, -b * si + d * co);
        return {
          ...o,
          ...surface.project({ x: o.x, y: o.y }),
          width: o.width * sx,
          height: o.height * sy,
          strokeWidth: o.strokeWidth * Math.sqrt(sx * sy),
          rotation: Math.atan2(b * co + d * si, a * co + c * si),
        };
      });
      const box = bounds(
        projected.flatMap((o) => {
          const c = Math.cos(o.rotation ?? 0),
            s = Math.sin(o.rotation ?? 0);
          return [
            [0, 0],
            [o.width, 0],
            [0, o.height],
            [o.width, o.height],
          ].map(([x = 0, y = 0]) => ({
            x: o.x + x * c - y * s,
            y: o.y + x * s + y * c,
          }));
        }),
      );
      for (const object of projected) {
        object.x -= box.x;
        object.y -= box.y;
      }
      const ink: BoardInk = {};
      for (const object of projected)
        if (object.inkId && this.ink[object.inkId])
          ink[object.inkId] = copy(this.ink[object.inkId]!);
      const existing = this.profiles
        .filter(
          (p) =>
            p.origin === "co_created" &&
            p.name === name.value.trim() &&
            (p.usage ?? "character") === usage,
        )
        .sort((a, b) => b.version - a.version)[0];
      void this.repository
        .saveCharacter(
          {
            id: existing?.id ?? uid("CHAR"),
            version: (existing?.version ?? 0) + 1,
            name: name.value.trim(),
            origin: "co_created",
            style: "custom",
            width: box.width,
            height: box.height,
            objects: projected,
            ink,
            usage,
            tags: [],
            createdAt: now(),
          },
          this.profiles,
        )
        .then(() => {
          new Notice(
            t(usage === "sticker" ? "board.stickerSaved" : "board.renamed"),
          );
          void this.loadProfiles();
          modal.close();
        })
        .catch(
          (error) => new Notice(t("board.error", { detail: String(error) })),
        );
    });
    this.button(modal.contentEl, "cancel", () => modal.close());
    modal.open();
    name.focus();
  }
  public sourceMoveFailed(error: unknown): void {
    this.status.textContent = t("board.error", { detail: String(error) });
  }
  public sourceMoveParticipant(requireSaved = false): BoardSourceMoveParticipant {
    let frozen = false, inert = false;
    return {
      prepare: async (forceSaved = requireSaved) => {
        if (this.disposed || this.sourceMoving) throw new Error("board-source-move-view-unavailable");
        frozen = true; inert = this.root.inert; this.root.inert = true; this.sourceMoving = true;
        this.invalidate(); this.recognitionAbort?.abort();
        this.finishText(true); this.finishGesture(); this.pause();
        // A failed primary save is exactly why the verified recovery handoff is
        // needed. Retain live text and ink; the repository must back them up.
        if (forceSaved) { await this.flush(); await this.save(); }
        else try { await this.flush(); } catch { /* keep the scene for relocation */ }
        return this.bundle();
      },
      accept: (bundle, receipt) => {
        if (this.disposed) return;
        if (!frozen || receipt.from !== this.sourceFile || receipt.to !== bundle.document.sourceFile || receipt.boardId !== this.history.renderDocument.id)
          throw new Error("board-source-move-target-changed");
        this.history.receiveSourceMove(bundle.document);
        this.sourceFile = receipt.to; this.ink = copy(bundle.ink); this.surfaceInstance = undefined;
        this.recoveredDraft = receipt.durability !== "committed"; this.conflict = receipt.durability === "recovered-conflict";
        this.savePromise = Promise.resolve(); this.renderSnapshot = null; this.paintSceneKey = "";
        this.status.textContent = t(this.conflict ? "board.recoveredConflict" : this.recoveredDraft ? "board.recoveredDraft" : "board.saved");
        this.schedule();
      },
      release: () => { if (frozen) { this.sourceMoving = false; this.root.inert = inert; this.schedule(); } },
    };
  }
  public async flush(): Promise<void> {
    if (this.disposed) return;
    this.finishText(true);
    this.finishGesture();
    this.pause();
    try {
      await this.savePromise;
    } catch (error) {
      if (error instanceof BoardConflictError) return;
      try {
        await this.save();
      } catch (retry) {
        if (!(retry instanceof BoardConflictError)) throw retry;
      }
    }
  }
  public detach(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.recognitionAbort?.abort();
    this.finishText(false);
    this.scheduler.dispose();
    this.compute.dispose();
    this.agent?.dispose();
    this.localDrawingTasks?.dispose();
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    for (const fn of this.cleanup) fn();
    this.slotViews.clear();this.integration.editors.setSlots(this.view.containerEl,[]);
    this.canvas.remove();
    this.brushCursor.remove();
    this.selectionBar.remove();
    this.toolbar.remove();
    this.layoutNotice.remove();
    this.replyOverlay.dispose();
    this.root.classList.remove("atl-board-active-vertical");
    this.root.style.position = this.originalPosition;
  }
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.flush();
    this.detach();
  }
}
