import {
  type Editor,
  type EditorPosition,
  type MarkdownFileInfo,
  type MarkdownPostProcessorContext,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
  setIcon
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import {
  type Annotation,
  type DialogueTurn,
  type IndexRecord,
  type Task,
  bareBlockId
} from "./model.js";
import { blockIdForAnnotation, makeId, nowIso } from "./ids.js";
import { resolveAnchor } from "./anchors.js";
import {
  crossesMarkdownBlocks,
  detectBlockId,
  escapeRegExp,
  findBlock,
  findBlockInLines,
  lineTextWithoutBlockId
} from "./editor.js";
import { IndexTable, recordFromAnnotation } from "./index-table.js";
import {
  emptyLibrarySnapshot,
  type LibrarySnapshot
} from "./library-index.js";
import { shouldRemoveAnnotationBlockId } from "./memory-policy.js";
import { lineDiff } from "./line-diff.js";
import { copyablePrompt, defaultReviewRequest } from "./markdown/overview.js";
import { buildReviewPrompt, listModels, type ModelListResult } from "./agent-runner.js";
import { runAcpReview } from "./acp-runner.js";
import {
  listApiModels,
  pickApiModel,
  runApiChat,
  runApiReview,
  type ApiModelsResult,
  type ChatMessage,
  type HttpJsonResponse,
  type HttpRequestJson
} from "./api-runner.js";
import { parseAgentReview } from "./markdown/review.js";
import { freeModels, pickDefaultModel } from "./agent-models.js";
import { VaultStore } from "./store.js";
import { MemoryWatcher } from "./watcher.js";
import {
  AnnotationTutorLiteSettingTab,
  DEFAULT_SETTINGS,
  migrateSettings,
  type AnnotationTutorLiteSettings,
  type HighlightStyle
} from "./settings.js";
import {
  MIN_AGENT_TIMEOUT_SECONDS,
  normalizeMemoryRoot
} from "./settings-config.js";
import {
  annotationDecorations,
  setAnnotationMarks,
  setMarkerClickHandler,
  toggleMarginCard
} from "./decorations.js";
import {
  BLOCK_ID_SUFFIX,
  styleClass,
  type AnchorMark
} from "./decorations-plan.js";
import {
  marginRailExtension,
  setMarginCardHandlers,
  setCardGeomStore,
  type DialogueReplyResult
} from "./margin-rail.js";
import { ReadingRail } from "./reading-rail.js";
import { getLocale, setLanguage, t } from "./i18n.js";
import {
  DASHBOARD_VIEW_TYPE,
  DashboardView
} from "./views/dashboard-view.js";
import { CHAT_VIEW_TYPE, ChatView, type ChatMode } from "./views/chat-view.js";
import { startAcpSession, type AcpSessionHandle, type AcpStreamEvent } from "./acp-session.js";
import { tutorSystemPrompt, type ChatContext } from "./chat-prompt.js";
import { classifyIntent, extractAnnotationId } from "./intent.js";
import { buildEditInstruction, extractEdit } from "./edit-parse.js";
import { detectLanguageName } from "./lang.js";
import {
  buildPassageGlossPrompt,
  buildWordGlossPrompt,
  classifyTranslateSelection,
  cleanGloss,
  formatWordGloss,
  nativeLanguageName,
  stripWrapper
} from "./translate.js";
import {
  applyGlossary,
  buildFileGlossary,
  buildGlossaryPrompt,
  contentHash,
  lookupGloss,
  mergeGlossaryEntry,
  parseGlossary,
  segmentDocument,
  MAX_PRETRANSLATE_BATCHES,
  type FileGlossary,
  type GlossaryEntry
} from "./pretranslate.js";
import { isAbsolute, relative as pathRelative, resolve as pathResolve } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ConfirmModal, DetailModal } from "./views/annotation-modal.js";
import { FloatingNotePanel } from "./views/note-panel.js";
import { NotePopover } from "./views/note-popover.js";

type EditorWithCm = Editor & { cm?: EditorView };
type Block = { startLine: number; endLine: number };

/** Normalized result of one review attempt, shared by both engines. */
type ReviewOutcome =
  | { kind: "ok"; reviewText: string }
  | { kind: "empty" }
  | { kind: "timeout" }
  | { kind: "failed"; detail: string }
  | { kind: "needs-key" };

/** Where a chat-proposed edit should land, captured when the turn is sent. */
export type EditTarget = {
  view: MarkdownView;
  /** True when text was selected (replace it); false = insert at the cursor. */
  hasSelection: boolean;
  /** The selected text, used to re-locate the range if it shifted before Apply. */
  original: string;
  from: EditorPosition;
  to: EditorPosition;
};

export default class AnnotationTutorLitePlugin extends Plugin {
  public override settings: AnnotationTutorLiteSettings = { ...DEFAULT_SETTINGS };
  public indexTable = new IndexTable();
  public librarySnapshot: LibrarySnapshot = emptyLibrarySnapshot();
  private store!: VaultStore;
  private watcher!: MemoryWatcher;
  private settingTab!: AnnotationTutorLiteSettingTab;
  private readonly readingRail = new ReadingRail();
  // Annotation IDs with an agent run in flight, to avoid duplicate spawns.
  private readonly runningAgents = new Set<string>();
  // Models discovered from the agent CLI (`opencode models`), for the picker.
  public availableModels: string[] = [];
  // True once a discovery attempt has completed (success or not), so the UI
  // stops auto-retrying and can offer a manual refresh instead.
  public modelsLoaded = false;
  // Models discovered from the API endpoint (`GET /models`), for the picker.
  public availableApiModels: string[] = [];
  public apiModelsLoaded = false;
  // Where the last Reading-view context menu opened, to place the note panel.
  private lastContextPos: { x: number; y: number } | null = null;
  // The most recently active Markdown note, so the chat keeps its context even
  // when the chat leaf itself is focused (which steals "active view").
  private lastMarkdownView: MarkdownView | null = null;
  // Remembers the highlight style across a "hide all marks" toggle.
  private stashedStyle: HighlightStyle = "dotted-underline";
  // Debounce handle for persisting margin-card geometry as it is dragged/resized.
  private cardGeomTimer: ReturnType<typeof setTimeout> | null = null;
  // Per-file pre-translation glossaries, keyed by Vault path, so Alt+T can gloss
  // a selection instantly. Rebuilt when the file's content hash changes.
  private readonly glossaryCache = new Map<string, FileGlossary>();
  // File paths with a pre-translation pass in flight, to avoid duplicate runs.
  private readonly pretranslating = new Set<string>();

  /**
   * HTTP transport for the direct-API engine. Routes through Obsidian's
   * `requestUrl` (which bypasses CORS, unlike a renderer `fetch`), and races a
   * timeout because `requestUrl` itself cannot be aborted.
   */
  private readonly httpRequest: HttpRequestJson = async (req) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HttpJsonResponse>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), req.timeoutMs);
    });
    try {
      return await Promise.race([
        requestUrl({
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          throw: false
        }).then((res) => ({ status: res.status, text: res.text })),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  public override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.applyLocale();
    this.stashedStyle =
      this.settings.highlightStyle === "none"
        ? DEFAULT_SETTINGS.highlightStyle
        : this.settings.highlightStyle;
    this.store = new VaultStore(this.app, this.manifest.id, () => this.settings);
    this.watcher = new MemoryWatcher(
      this.store,
      () => this.settings,
      (paths) => this.onMemoryChanged(paths)
    );

    this.settingTab = new AnnotationTutorLiteSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerEditorExtension([annotationDecorations, marginRailExtension]);
    setMarkerClickHandler((id, el) => void this.openInlineNote(id, el));
    setMarginCardHandlers({
      save: (id, note) => void this.saveNoteInline(id, note),
      ask: (id, note) => void this.askFromCard(id, note),
      discuss: (id) => void this.openChatForAnnotation(id),
      reply: (id, message) => this.replyInAnnotation(id, message),
      remove: (id) => this.confirmDeleteById(id),
      settings: () => this.openSettings()
    });
    // Each card keeps its own size/place across re-renders and reloads, persisted
    // per annotation id and written back (debounced) only on a real drag/resize.
    setCardGeomStore({
      get: (id) => this.settings.cardGeom[id],
      set: (id, geom) => {
        this.settings.cardGeom[id] = {
          dx: geom.dx,
          dy: geom.dy,
          ...(geom.w ? { w: geom.w } : {}),
          ...(geom.h ? { h: geom.h } : {})
        };
        this.scheduleCardGeomSave();
      }
    });
    this.registerMarkdownPostProcessor((el, ctx) =>
      this.decorateReadingView(el, ctx)
    );
    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new DashboardView(leaf, this)
    );
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("graduation-cap", t("ribbon.openChat"), () => {
      void this.openChat();
    });

    this.registerCommands();
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) =>
        this.addEditorMenuItems(menu, editor, info)
      )
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView && view.file) {
          this.lastMarkdownView = view;
          // `file-open` only fires for a genuinely new file, not when focusing an
          // already-loaded tab; pre-translate here too so detection is reliable.
          // The in-flight guard + content-hash skip make repeats cheap.
          if (view.file.extension === "md") void this.maybePretranslate(view.file);
        }
        void this.refreshDecorations();
      })
    );
    // Toggling between editing and reading view fires layout-change; refresh so
    // the reading-view rail attaches/detaches with the mode.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => void this.refreshDecorations())
    );
    this.registerDomEvent(document, "contextmenu", (event) =>
      this.onReadingContextMenu(event)
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.maybePretranslate(file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.watcher.notify(file.path))
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.watcher.notify(file.path))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.glossaryCache.delete(file.path);
        this.watcher.notify(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const moved = this.glossaryCache.get(oldPath);
        this.glossaryCache.delete(oldPath);
        if (moved) this.glossaryCache.set(file.path, moved);
        this.watcher.notify(file.path);
        this.watcher.notify(oldPath);
      })
    );

    this.app.workspace.onLayoutReady(() => void this.initialize());
  }

  public override onunload(): void {
    this.watcher?.dispose();
    this.readingRail.detach();
    setMarkerClickHandler(null);
    setMarginCardHandlers(null);
    setCardGeomStore(null);
    if (this.cardGeomTimer) {
      clearTimeout(this.cardGeomTimer);
      this.cardGeomTimer = null;
    }
  }

  public async persistSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Coalesce the rapid geometry writes from a drag/resize into one save. */
  private scheduleCardGeomSave(): void {
    if (this.cardGeomTimer) clearTimeout(this.cardGeomTimer);
    this.cardGeomTimer = setTimeout(() => {
      this.cardGeomTimer = null;
      void this.persistSettings();
    }, 400);
  }

  /** Resolve the active UI locale from the language setting (auto = Obsidian). */
  public applyLocale(): void {
    setLanguage(
      this.settings.language,
      window.localStorage.getItem("language")
    );
  }

  public async changeMemoryRoot(
    value: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const raw = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
    const normalized = normalizeMemoryRoot(value);
    if (raw && normalized !== raw) {
      return { ok: false, message: t("notice.invalidMemoryRoot") };
    }
    const next = normalizePath(normalized);
    const current = normalizePath(this.settings.memoryRoot);
    if (next === current) return { ok: true };
    const target = this.app.vault.getAbstractFileByPath(next);
    if (target && (!(target instanceof TFolder) || target.children.length > 0)) {
      return {
        ok: false,
        message: t("notice.memoryRootConflict", { path: next })
      };
    }
    this.settings.memoryRoot = next;
    await this.persistSettings();
    await this.store.ensureScaffold();
    this.librarySnapshot = emptyLibrarySnapshot();
    await this.rebuildIndex(false);
    return { ok: true };
  }

  public onSettingsChanged(): void {
    void this.store.ensureScaffold().then(() => this.rebuildIndex(false));
    void this.refreshDecorations();
  }

  /**
   * A passive display setting changed (highlight style, marker, margin card
   * options, write mode). Persist already happened in the setting handler;
   * just refresh the in-editor decorations. Crucially this does NOT re-render
   * the settings tab, so an open dropdown keeps its styling after selection.
   */
  public applyDisplaySettings(): void {
    void this.refreshDecorations();
  }

  // --- lifecycle -------------------------------------------------------------

  private async initialize(): Promise<void> {
    await this.store.ensureScaffold();
    const cached = await this.store.loadLibraryCache();
    if (cached) this.librarySnapshot = cached;
    await this.rebuildIndex(false);
    // When auto-run is on with the OpenCode engine, discover the CLI's models
    // in the background so the picker is ready (its free models change over
    // time). The API engine discovers models lazily from the settings panel.
    if (this.settings.autoRunAgent && this.settings.reviewEngine === "opencode") {
      void this.refreshAvailableModels();
    }
    // The file open before our file-open handler registered won't have fired it;
    // pre-translate it now so its glossary is ready for Alt+T.
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") void this.maybePretranslate(active);
  }

  /**
   * Query the agent CLI for its models and cache them for the picker. Also
   * auto-selects a default model when the configured one is empty or no longer
   * offered.
   */
  public async refreshAvailableModels(): Promise<ModelListResult> {
    const command = this.settings.agentCommand.trim() || "opencode";
    const result = await listModels(command);
    this.modelsLoaded = true;
    if (result.models.length > 0) {
      this.availableModels = result.models;
      const picked = pickDefaultModel(result.models, this.settings.agentModel);
      if (picked !== this.settings.agentModel) {
        this.settings.agentModel = picked;
        await this.persistSettings();
      }
    }
    return result;
  }

  /** Connectivity check: refresh the model list and report the outcome. */
  public async testAgentConnection(): Promise<void> {
    const command = this.settings.agentCommand.trim() || "opencode";
    const progress = new Notice(t("notice.agentTesting", { command }), 0);
    try {
      const result = await this.refreshAvailableModels();
      if (result.ok) {
        new Notice(
          t("notice.agentTestOk", {
            count: result.models.length,
            free: freeModels(result.models).length
          })
        );
      } else {
        new Notice(
          t("notice.agentTestFailed", {
            command,
            detail: result.error ?? String(result.models.length)
          })
        );
      }
      this.settingTab?.refresh();
    } finally {
      progress.hide();
    }
  }

  /**
   * Query the API endpoint for its models (`GET /models`) and cache them for the
   * picker. Also auto-selects a default model when the configured one is empty
   * or no longer offered. No tokens are spent.
   */
  public async refreshApiModels(): Promise<ApiModelsResult> {
    if (!this.settings.apiKey.trim()) {
      this.apiModelsLoaded = true;
      return { ok: false, models: [], error: "missing-api-key" };
    }
    const result = await listApiModels(
      {
        baseUrl: this.settings.apiBaseUrl,
        apiKey: this.settings.apiKey,
        timeoutMs: 20000
      },
      this.httpRequest
    );
    this.apiModelsLoaded = true;
    if (result.models.length > 0) {
      this.availableApiModels = result.models;
      const picked = pickApiModel(result.models, this.settings.apiModel);
      if (picked !== this.settings.apiModel) {
        this.settings.apiModel = picked;
        await this.persistSettings();
      }
    }
    return result;
  }

  /** Connectivity check for the direct-API engine: list the endpoint's models. */
  public async testApiConnection(): Promise<void> {
    if (!this.settings.apiKey.trim()) {
      new Notice(t("notice.apiKeyMissing"));
      return;
    }
    const progress = new Notice(
      t("notice.apiTesting", { url: this.settings.apiBaseUrl }),
      0
    );
    try {
      const result = await this.refreshApiModels();
      new Notice(
        result.ok
          ? t("notice.apiTestOk", { count: result.models.length })
          : t("notice.apiTestFailed", {
              detail: result.error ?? `HTTP ${result.status ?? "?"}`
            })
      );
      this.settingTab?.refresh();
    } finally {
      progress.hide();
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: "add-learning-annotation",
      name: t("cmd.addAnnotation"),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "l" }],
      editorCallback: (editor, info) =>
        void this.createAnnotationFromEditor(editor, info)
    });
    this.addCommand({
      id: "open-tutor-chat",
      name: t("cmd.openChat"),
      callback: () => void this.openChat()
    });
    this.addCommand({
      id: "translate-selection",
      name: t("cmd.translate"),
      hotkeys: [{ modifiers: ["Alt"], key: "t" }],
      editorCallback: (editor) => void this.translateSelection(editor)
    });
    this.addCommand({
      id: "pretranslate-document",
      name: t("cmd.pretranslate"),
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "t" }],
      callback: () => void this.pretranslateActiveFile()
    });
    this.addCommand({
      id: "open-annotation-dashboard",
      name: t("cmd.openDashboard"),
      callback: () => void this.openDashboard()
    });
    this.addCommand({
      id: "ask-agent-current-annotation",
      name: t("cmd.askCurrent"),
      callback: () => void this.askAgentForCurrent()
    });
    this.addCommand({
      id: "open-annotation-memory",
      name: t("cmd.openMemory"),
      callback: () =>
        void this.app.workspace.openLinkText(this.store.overviewPath(), "", false)
    });
    this.addCommand({
      id: "open-agent-inbox",
      name: t("cmd.openInbox"),
      callback: () =>
        void this.app.workspace.openLinkText(this.store.inboxPath(), "", false)
    });
    this.addCommand({
      id: "clean-agent-inbox",
      name: t("cmd.cleanInbox"),
      callback: () => void this.cleanInbox()
    });
    this.addCommand({
      id: "rebuild-index",
      name: t("cmd.rebuildIndex"),
      callback: () => void this.rebuildIndex(true)
    });
    this.addCommand({
      id: "toggle-annotation-marks",
      name: t("cmd.toggleMarks"),
      callback: () => void this.toggleMarks()
    });
    this.addCommand({
      id: "build-notebook",
      name: t("cmd.buildNotebook"),
      callback: () => void this.buildNotebook()
    });
    this.addCommand({
      id: "enrich-notebook",
      name: t("cmd.enrichNotebook"),
      callback: () => void this.enrichNotebook()
    });
  }

  private addEditorMenuItems(
    menu: Menu,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo
  ): void {
    menu.addItem((item) =>
      item
        .setTitle(t("menu.addAnnotation"))
        .setIcon("highlighter")
        .onClick(() => void this.createAnnotationFromEditor(editor, info))
    );
  }

  // --- create ----------------------------------------------------------------

  private async createAnnotationFromEditor(
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo
  ): Promise<void> {
    const file = info.file;
    if (!file) {
      new Notice(t("notice.openMdFirst"));
      return;
    }
    const start = editor.getCursor("from");
    const end = editor.getCursor("to");
    const selectedText = editor.getSelection();
    if (crossesMarkdownBlocks(editor, start, end)) {
      new Notice(t("notice.cannotCrossBlocks"));
      return;
    }
    const block = findBlock(editor, start.line);
    const sourceText =
      selectedText || lineTextWithoutBlockId(editor.getLine(start.line));
    if (!sourceText) {
      new Notice(t("notice.selectOrCursor"));
      return;
    }
    FloatingNotePanel.open({
      allowAsk: true,
      anchor: this.selectionAnchor(editor, start),
      onOpenSettings: () => this.openSettings(),
      onSubmit: (note, askAgent) =>
        this.saveEditorAnnotation(editor, file, block, sourceText, note, askAgent)
    });
  }

  /** Screen coordinates of a position, to open the panel near the selection. */
  private selectionAnchor(
    editor: Editor,
    pos: { line: number; ch: number }
  ): { x: number; y: number } | undefined {
    const cm = (editor as EditorWithCm).cm;
    if (!cm) return undefined;
    const coords = cm.coordsAtPos(editor.posToOffset(pos));
    return coords ? { x: coords.left, y: coords.bottom } : undefined;
  }

  public openSettings(): void {
    const setting = (
      this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      }
    ).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  private async saveEditorAnnotation(
    editor: Editor,
    file: TFile,
    block: Block,
    selectedText: string,
    note: string,
    askAgent: boolean
  ): Promise<void> {
    const createdAt = nowIso();
    const id = makeId("ANN", this.indexTable.ids());
    const existingBlockId = detectBlockId(editor.getLine(block.endLine));
    const blockId = existingBlockId ?? blockIdForAnnotation(id);
    const sharedGeneratedAnchor = this.indexTable
      .all()
      .some(
        (record) =>
          record.sourceFile === file.path &&
          bareBlockId(record.anchor) === blockId &&
          record.anchorOrigin === "generated"
      );

    if (!existingBlockId && this.settings.useBlockAnchors) {
      editor.setLine(block.endLine, `${editor.getLine(block.endLine)} ^${blockId}`);
    }

    const annotation: Annotation = {
      id,
      sourceFile: file.path,
      anchor: { blockId, selectedText },
      anchorOrigin:
        !existingBlockId || sharedGeneratedAnchor ? "generated" : "existing",
      userNote: note,
      status: askAgent ? "agent_requested" : "saved",
      concepts: [],
      relatedMemoryCells: [],
      createdAt,
      updatedAt: createdAt
    };

    await this.finishCreate(annotation, askAgent);
  }

  /**
   * Create an annotation from a Reading-view text selection. There is no Editor
   * here, so the selection is matched back to a source line by text, then the
   * usual note panel collects the explanation.
   */
  private async createAnnotationFromReading(
    view: MarkdownView,
    selectedText: string
  ): Promise<void> {
    const file = view.file;
    if (!file) return;
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    if (!lines.some((line) => line.includes(selectedText))) {
      new Notice(t("notice.couldNotLocate"));
      return;
    }
    FloatingNotePanel.open({
      allowAsk: true,
      anchor: this.lastContextPos ?? undefined,
      onOpenSettings: () => this.openSettings(),
      onSubmit: (note, askAgent) =>
        this.saveReadingAnnotation(file, selectedText, note, askAgent)
    });
  }

  private async saveReadingAnnotation(
    file: TFile,
    selectedText: string,
    note: string,
    askAgent: boolean
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const lineIndex = lines.findIndex((line) => line.includes(selectedText));
    if (lineIndex < 0) {
      new Notice(t("notice.couldNotLocate"));
      return;
    }
    const block = findBlockInLines(lines, lineIndex);
    const id = makeId("ANN", this.indexTable.ids());
    const existingBlockId = detectBlockId(lines[block.endLine] ?? "");
    const blockId = existingBlockId ?? blockIdForAnnotation(id);
    const sharedGeneratedAnchor = this.indexTable
      .all()
      .some(
        (record) =>
          record.sourceFile === file.path &&
          bareBlockId(record.anchor) === blockId &&
          record.anchorOrigin === "generated"
      );

    if (!existingBlockId && this.settings.useBlockAnchors) {
      await this.app.vault.process(file, (data) => {
        const current = data.split(/\r?\n/);
        const target = current[block.endLine];
        if (target !== undefined && !detectBlockId(target)) {
          current[block.endLine] = `${target} ^${blockId}`;
        }
        return current.join("\n");
      });
    }

    const createdAt = nowIso();
    const annotation: Annotation = {
      id,
      sourceFile: file.path,
      anchor: { blockId, selectedText },
      anchorOrigin:
        !existingBlockId || sharedGeneratedAnchor ? "generated" : "existing",
      userNote: note,
      status: askAgent ? "agent_requested" : "saved",
      concepts: [],
      relatedMemoryCells: [],
      createdAt,
      updatedAt: createdAt
    };
    await this.finishCreate(annotation, askAgent);
  }

  /** Persist a freshly built annotation, index it, and optionally ask an agent. */
  private async finishCreate(
    annotation: Annotation,
    askAgent: boolean
  ): Promise<void> {
    await this.store.createAnnotation(annotation);
    const record = recordFromAnnotation(
      annotation,
      this.store.annotationPath(annotation.id)
    );
    this.indexTable.upsert(record);
    await this.commit();
    new Notice(t("notice.created", { id: annotation.id }));
    if (askAgent) await this.askAgent(record);
  }

  /** Right-click in Reading view with a selection offers "Add annotation". */
  private onReadingContextMenu(event: MouseEvent): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || view.getMode() !== "preview") return;
    const scroller = view.contentEl.querySelector(".markdown-preview-view");
    if (!scroller || !scroller.contains(event.target as Node)) return;
    const selection = window.getSelection()?.toString().trim() ?? "";
    if (!selection) return;
    event.preventDefault();
    this.lastContextPos = { x: event.clientX, y: event.clientY };
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t("menu.addAnnotation"))
        .setIcon("highlighter")
        .onClick(() => void this.createAnnotationFromReading(view, selection))
    );
    menu.showAtMouseEvent(event);
  }

  // --- agent tasks -----------------------------------------------------------

  public async askAgent(record: IndexRecord): Promise<void> {
    const tasks = await this.store.readTasks();
    // Reuse an existing open task for this annotation instead of appending a
    // duplicate, so repeated clicks don't bloat the inbox.
    const open = tasks.find(
      (existing) =>
        existing.annotationId === record.annotationId &&
        (existing.status === "pending" || existing.status === "in_progress")
    );
    let taskId: string;
    if (open) {
      taskId = open.id;
    } else {
      const task: Task = {
        id: makeId(
          "TASK",
          tasks.map((existing) => existing.id)
        ),
        type: "review_annotation",
        status: "pending",
        annotationId: record.annotationId,
        memoryFile: record.memoryFile,
        sourceFile: record.sourceFile,
        anchor: record.anchor,
        request: defaultReviewRequest(),
        createdAt: nowIso()
      };
      await this.store.appendTask(task);
      taskId = task.id;
    }
    const updated = await this.store.updateAnnotation(record.annotationId, {
      status: "agent_requested"
    });
    if (updated) {
      this.indexTable.upsert(
        recordFromAnnotation(updated, this.store.annotationPath(record.annotationId))
      );
    }
    await this.commit();
    if (this.settings.autoRunAgent) {
      await this.runAgentForRecord(record, taskId);
    } else {
      new Notice(t("notice.asked", { id: record.annotationId }));
    }
  }

  /** Tidy the agent inbox (remove duplicates, finished, and dangling tasks). */
  public async cleanInbox(): Promise<void> {
    const removed = await this.store.cleanInbox(this.indexTable.ids());
    await this.rebuildIndex(false);
    new Notice(t("notice.inboxCleaned", { count: removed }));
  }

  /**
   * Review one annotation in a single model call: send the rubric + selected
   * text + note to the agent CLI over stdin, capture the reply, and write it
   * into the annotation file ourselves (then mark the task done). The button
   * stays useful without auto-run (it still queues the task); this removes both
   * the manual terminal step and the slow file-crawl round-trips.
   */
  private async runAgentForRecord(
    record: IndexRecord,
    taskId: string
  ): Promise<void> {
    if (this.runningAgents.has(record.annotationId)) {
      new Notice(t("notice.agentBusy", { id: record.annotationId }));
      return;
    }
    const useApi = this.settings.reviewEngine === "api";
    const engineLabel = useApi
      ? this.settings.apiModel.trim() || "API"
      : this.settings.agentCommand.trim() || "opencode";
    this.runningAgents.add(record.annotationId);
    const progress = new Notice(
      t("notice.agentRunning", { id: record.annotationId, command: engineLabel }),
      0
    );
    try {
      const prompt = buildReviewPrompt(
        record,
        this.settings.reviewLanguage,
        this.learnerProfileSummary()
      );
      const timeoutMs =
        Math.max(MIN_AGENT_TIMEOUT_SECONDS, this.settings.agentTimeoutSeconds) *
        1000;
      const outcome = useApi
        ? await this.captureApiReview(prompt, timeoutMs)
        : await this.captureOpenCodeReview(prompt, timeoutMs);
      const id = record.annotationId;
      switch (outcome.kind) {
        case "needs-key":
          new Notice(t("notice.apiKeyMissing"));
          return;
        case "timeout":
          new Notice(t("notice.agentTimeout", { id }));
          return;
        case "failed":
          console.error("[Annotation Tutor Lite] review failed", outcome.detail);
          new Notice(t("notice.agentFailed", { id, detail: outcome.detail }));
          return;
        case "empty":
          console.error("[Annotation Tutor Lite] review produced no text");
          new Notice(t("notice.agentNoReview", { id }));
          return;
        case "ok":
          await this.store.writeReview(id, outcome.reviewText);
          await this.store.setTaskStatus(taskId, "completed");
          await this.rebuildIndex(false);
          new Notice(t("notice.agentDone", { id }));
          return;
      }
    } catch (error) {
      console.error("[Annotation Tutor Lite] agent run error", error);
      new Notice(
        t("notice.agentFailed", {
          id: record.annotationId,
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      progress.hide();
      this.runningAgents.delete(record.annotationId);
    }
  }

  /** Direct-API engine: one HTTPS call to an OpenAI-compatible endpoint. */
  private async captureApiReview(
    prompt: string,
    timeoutMs: number
  ): Promise<ReviewOutcome> {
    if (!this.settings.apiKey.trim()) return { kind: "needs-key" };
    const result = await runApiReview(
      {
        baseUrl: this.settings.apiBaseUrl,
        apiKey: this.settings.apiKey,
        model: this.settings.apiModel,
        prompt,
        timeoutMs
      },
      this.httpRequest
    );
    if (result.timedOut) return { kind: "timeout" };
    if (!result.ok) {
      return {
        kind: "failed",
        detail: `${this.settings.apiModel}: ${
          result.error ?? `HTTP ${result.status ?? "?"}`
        }`
      };
    }
    if (!result.reviewText) return { kind: "empty" };
    return { kind: "ok", reviewText: result.reviewText };
  }

  /**
   * OpenCode CLI engine, over the Agent Client Protocol (`opencode acp`). This
   * is a persistent JSON-RPC connection — unlike one-shot `opencode run`, which
   * never receives its prompt when spawned inside Electron. The model comes from
   * `agentModel` (set via session/set_config_option).
   */
  private async captureOpenCodeReview(
    prompt: string,
    timeoutMs: number
  ): Promise<ReviewOutcome> {
    const command = this.settings.agentCommand.trim() || "opencode";
    const result = await runAcpReview({
      command,
      model: this.settings.agentModel,
      prompt,
      timeoutMs
    });
    if (result.timedOut) return { kind: "timeout" };
    if (!result.ok && !result.reviewText) {
      if (result.error) {
        return {
          kind: "failed",
          detail: `${this.settings.agentModel || command}: ${result.error}`
        };
      }
      return { kind: "empty" };
    }
    return { kind: "ok", reviewText: result.reviewText };
  }

  private async askAgentForCurrent(): Promise<void> {
    const record = this.getActiveRecord();
    if (!record) {
      new Notice(t("notice.placeCursor"));
      return;
    }
    await this.askAgent(record);
  }

  public async copyPrompt(record: IndexRecord): Promise<void> {
    await navigator.clipboard.writeText(
      copyablePrompt(record, this.settings.reviewLanguage)
    );
    new Notice(t("notice.promptCopied"));
  }

  // --- inline translation (Alt+T) --------------------------------------------

  /** The reader's native language name for inline glosses. */
  private dictionaryLanguageName(): string {
    return this.settings.dictionaryLanguage.trim() || nativeLanguageName(getLocale());
  }

  /**
   * Try to gloss the selection from the active file's cached pre-translation.
   * Returns true when it answered (cache hit); false to fall back to a live call.
   */
  private translateFromCache(
    editor: Editor,
    from: EditorPosition,
    to: EditorPosition,
    selection: string,
    mode: ReturnType<typeof classifyTranslateSelection>
  ): boolean {
    const file = this.app.workspace.getActiveFile();
    const glossary = file ? this.glossaryCache.get(file.path) : undefined;
    if (!glossary) return false;
    let replacement: string | null = null;
    if (mode === "word") {
      // Exact-term lookup first (clean "word (meaning)"). If the term isn't an
      // exact glossary key, fall back to the same index scan a passage uses so a
      // single word is never weaker than selecting the segment around it.
      const gloss = lookupGloss(glossary, selection);
      if (gloss) {
        replacement = formatWordGloss(selection, gloss);
      } else {
        const glossed = applyGlossary(selection, glossary);
        if (glossed !== selection) replacement = glossed;
      }
    } else {
      const glossed = applyGlossary(selection, glossary);
      if (glossed !== selection) replacement = glossed;
    }
    if (!replacement || replacement === selection) return false;
    if (!this.replaceSelection(editor, from, to, selection, replacement)) {
      return false;
    }
    new Notice(t("notice.translateDone"));
    return true;
  }

  /**
   * Add a live word gloss to the active file's cached glossary so a repeat Alt+T
   * on the same term answers from cache. No-op when the file has no glossary yet
   * (pre-translation off / not started) or the term is already cached.
   */
  private cacheWordGloss(surface: string, gloss: string): void {
    if (!surface || !gloss) return;
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const glossary = this.glossaryCache.get(file.path);
    if (!glossary) return;
    this.glossaryCache.set(
      file.path,
      mergeGlossaryEntry(glossary, { surface, gloss })
    );
  }

  /** File-open hook: pre-translate the document when the feature is enabled. */
  private async maybePretranslate(file: TFile): Promise<void> {
    if (!this.settings.pretranslateOnOpen) return;
    // Don't auto-translate the plugin's own generated memory/library notes.
    const root = this.settings.memoryRoot;
    if (root && (file.path === root || file.path.startsWith(`${root}/`))) return;
    await this.pretranslateFile(file, false);
  }

  /** Manual command: (re)build the pre-translation glossary for the active note. */
  private async pretranslateActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice(t("notice.openMdFirst"));
      return;
    }
    await this.pretranslateFile(file, true);
  }

  /**
   * Gloss a document in the background into a cached word→meaning glossary so
   * Alt+T can answer instantly. Skips work when the cache already matches the
   * file's content, and aborts quietly when the engine needs a key (unless the
   * user invoked it manually). The live Alt+T path covers anything this misses.
   */
  private async pretranslateFile(file: TFile, manual: boolean): Promise<void> {
    if (this.pretranslating.has(file.path)) {
      if (manual) new Notice(t("notice.pretranslateBusy"));
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    const hash = contentHash(content);
    const existing = this.glossaryCache.get(file.path);
    // Only skip when the cached glossary is both current and fully built; a
    // partial (interrupted) glossary must be rebuilt.
    if (existing && existing.hash === hash && existing.complete) {
      if (manual) {
        new Notice(
          t("notice.pretranslateUpToDate", { count: existing.entries.length })
        );
      }
      return;
    }
    const batches = segmentDocument(
      content,
      this.settings.pretranslateChunkChars
    ).slice(0, MAX_PRETRANSLATE_BATCHES);
    if (batches.length === 0) {
      this.glossaryCache.set(file.path, buildFileGlossary(hash, []));
      if (manual) new Notice(t("notice.pretranslateEmpty"));
      return;
    }
    this.pretranslating.add(file.path);
    const target = this.dictionaryLanguageName();
    const progress = new Notice(
      t("notice.pretranslateStart", { name: file.basename }),
      0
    );
    const entries: GlossaryEntry[] = [];
    let done = 0;
    let failed = 0;
    let needsKey = false;
    try {
      for (const batch of batches) {
        let outcome: ReviewOutcome;
        try {
          outcome = await this.captureText(
            buildGlossaryPrompt(batch, target),
            this.chatTimeoutMs()
          );
        } catch (error) {
          console.error("[Annotation Tutor Lite] pre-translate batch error", error);
          outcome = {
            kind: "failed",
            detail: error instanceof Error ? error.message : String(error)
          };
        }
        if (outcome.kind === "needs-key") {
          needsKey = true;
          break;
        }
        if (outcome.kind === "ok") {
          entries.push(...parseGlossary(outcome.reviewText));
        } else {
          failed += 1;
        }
        done += 1;
        // Publish progress so far so Alt+T can already use the terms found in the
        // batches done — the cache no longer waits for the whole document.
        this.glossaryCache.set(file.path, buildFileGlossary(hash, entries, false));
        progress.setMessage(
          t("notice.pretranslateProgress", { done, total: batches.length })
        );
      }
    } finally {
      progress.hide();
      this.pretranslating.delete(file.path);
    }
    if (needsKey) {
      // The cache holds whatever was glossed before the key gave out; mark it
      // complete so we don't loop, and tell the user why it stopped.
      this.glossaryCache.set(file.path, buildFileGlossary(hash, entries));
      new Notice(t("notice.apiKeyMissing"));
      return;
    }
    const glossary = buildFileGlossary(hash, entries);
    this.glossaryCache.set(file.path, glossary);
    const count = glossary.entries.length;
    if (count > 0) {
      new Notice(
        failed > 0
          ? t("notice.pretranslatePartial", { count, failed })
          : t("notice.pretranslateDone", { count })
      );
    } else if (failed > 0) {
      new Notice(t("notice.pretranslateFailed"));
    } else {
      new Notice(t("notice.pretranslateEmpty"));
    }
  }

  /** Run one one-shot text generation through the configured review engine. */
  private async captureText(
    prompt: string,
    timeoutMs: number
  ): Promise<ReviewOutcome> {
    return this.settings.reviewEngine === "api"
      ? this.captureApiReview(prompt, timeoutMs)
      : this.captureOpenCodeReview(prompt, timeoutMs);
  }

  /**
   * Alt+T: gloss the selection inline for immersive reading. A single word/term
   * becomes "word (meaning)"; a passage gets every foreign word glossed in place.
   * The meaning is understood from context, and the result is inserted directly
   * (undoable with Ctrl+Z).
   */
  private async translateSelection(editor: Editor): Promise<void> {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice(t("notice.translateSelect"));
      return;
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const target = this.dictionaryLanguageName();
    const mode = classifyTranslateSelection(selection);

    // Fast path: answer from the pre-translation cache when it covers the
    // selection. Otherwise fall through to a live model call so missed words
    // still translate (the original behaviour, retained as a fallback).
    if (this.translateFromCache(editor, from, to, selection, mode)) return;

    const progress = new Notice(t("notice.translating"), 0);
    try {
      const prompt =
        mode === "word"
          ? buildWordGlossPrompt(
              selection.trim(),
              lineTextWithoutBlockId(editor.getLine(from.line)),
              target
            )
          : buildPassageGlossPrompt(selection, target);
      const outcome = await this.captureText(prompt, this.chatTimeoutMs());
      if (outcome.kind !== "ok") {
        this.noticeForTranslate(outcome);
        return;
      }
      const wordGloss =
        mode === "word" ? cleanGloss(outcome.reviewText) : "";
      const replacement =
        mode === "word"
          ? formatWordGloss(selection, wordGloss)
          : stripWrapper(outcome.reviewText);
      if (!replacement.trim() || replacement === selection) {
        new Notice(
          t("notice.translateFailed", { detail: t("notice.translateEmpty") })
        );
        return;
      }
      if (!this.replaceSelection(editor, from, to, selection, replacement)) {
        new Notice(
          t("notice.translateFailed", { detail: t("chat.edit.notLocated") })
        );
        return;
      }
      // Self-healing cache: a word the pre-pass missed is glossed live once, then
      // remembered so the next Alt+T on it is instant (passage results aren't
      // reusable as entries, so only the word path feeds the cache).
      if (mode === "word" && wordGloss) {
        this.cacheWordGloss(selection.trim(), wordGloss);
      }
      new Notice(t("notice.translateDone"));
    } catch (error) {
      new Notice(
        t("notice.translateFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      progress.hide();
    }
  }

  /** Replace `original` at the captured range, re-locating it by text if it shifted. */
  private replaceSelection(
    editor: Editor,
    from: EditorPosition,
    to: EditorPosition,
    original: string,
    replacement: string
  ): boolean {
    if (editor.getRange(from, to) === original) {
      editor.replaceRange(replacement, from, to);
      return true;
    }
    const idx = editor.getValue().indexOf(original);
    if (idx === -1) return false;
    editor.replaceRange(
      replacement,
      editor.offsetToPos(idx),
      editor.offsetToPos(idx + original.length)
    );
    return true;
  }

  private noticeForTranslate(outcome: ReviewOutcome): void {
    switch (outcome.kind) {
      case "needs-key":
        new Notice(t("notice.apiKeyMissing"));
        return;
      case "timeout":
        new Notice(
          t("notice.translateFailed", { detail: t("notice.translateTimeout") })
        );
        return;
      case "failed":
        new Notice(t("notice.translateFailed", { detail: outcome.detail }));
        return;
      case "empty":
        new Notice(
          t("notice.translateFailed", { detail: t("notice.translateEmpty") })
        );
        return;
    }
  }

  // --- open / edit / delete --------------------------------------------------

  public async openDetail(record: IndexRecord): Promise<void> {
    const annotation = await this.store.readAnnotation(record.annotationId);
    if (!annotation) {
      new Notice(t("notice.fileUnavailable"));
      return;
    }
    new DetailModal(this.app, annotation, {
      jump: () => this.openAnnotation(record),
      ask: () => this.askAgent(record),
      copyPrompt: () => this.copyPrompt(record),
      openFile: () =>
        void this.app.workspace.openLinkText(record.memoryFile, "", false),
      edit: () => this.editAnnotation(record),
      remove: () => this.confirmDelete(record)
    }).open();
  }

  public async editAnnotation(record: IndexRecord): Promise<void> {
    const annotation = await this.store.readAnnotation(record.annotationId);
    if (!annotation) {
      new Notice(t("notice.fileUnavailable"));
      return;
    }
    FloatingNotePanel.open({
      initialNote: annotation.userNote,
      allowAsk: true,
      onOpenSettings: () => this.openSettings(),
      onSubmit: async (note, askAgent) => {
        const updated = await this.store.updateAnnotation(record.annotationId, {
          userNote: note
        });
        const next = updated
          ? recordFromAnnotation(
              updated,
              this.store.annotationPath(record.annotationId)
            )
          : record;
        if (updated) this.indexTable.upsert(next);
        await this.commit();
        if (askAgent) await this.askAgent(next);
      }
    });
  }

  /**
   * Marker click. With margin comments on, this toggles the annotation's margin
   * card — in the editor (CodeMirror) or in Reading view (the reading rail).
   * Otherwise it opens the inline popover anchored to the clicked marker.
   */
  public async openInlineNote(id: string, anchorEl: HTMLElement): Promise<void> {
    const record = this.indexTable.get(id);
    if (!record) {
      new Notice(t("notice.fileUnavailable"));
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.settings.marginComments && view) {
      if (view.getMode() === "preview") {
        this.readingRail.attach(view);
        this.readingRail.setMarks(
          this.marksFor(view.file?.path ?? ""),
          this.settings.marginPaper,
          this.settings.marginHideLink,
          this.settings.inlineReview
        );
        this.readingRail.toggle(id);
        return;
      }
      const cm = (view.editor as EditorWithCm).cm;
      if (cm) {
        cm.dispatch({ effects: toggleMarginCard.of(id) });
        return;
      }
    }
    const annotation = await this.store.readAnnotation(id);
    if (!annotation) {
      new Notice(t("notice.fileUnavailable"));
      return;
    }
    NotePopover.open(anchorEl, annotation, {
      jump: () => this.openAnnotation(record),
      edit: () => this.editAnnotation(record),
      ask: () => this.askAgent(record),
      remove: () => this.confirmDelete(record)
    });
  }

  /** Save an inline (margin card) note edit. */
  private async saveNoteInline(id: string, note: string): Promise<void> {
    const record = this.indexTable.get(id);
    if (!record || record.userNote === note) return;
    const updated = await this.store.updateAnnotation(id, { userNote: note });
    if (updated) {
      this.indexTable.upsert(
        recordFromAnnotation(updated, this.store.annotationPath(id))
      );
    }
    await this.commit();
  }

  /**
   * The margin card's "ask" button. If the note reads as an edit request
   * ("help me polish", "帮我润色", …), open the tutor chat in Build mode seeded
   * with this annotation and send the note, so a polish/rewrite goes straight to
   * the preview-then-apply flow. Otherwise queue the usual review.
   */
  private async askFromCard(id: string, note?: string): Promise<void> {
    const record = this.indexTable.get(id);
    if (!record) return;
    // The card's blur-save may not have landed yet, so trust the live textarea
    // value and persist it before acting on it.
    if (note !== undefined && note !== record.userNote) {
      await this.saveNoteInline(id, note);
    }
    const text = (note ?? record.userNote ?? "").trim();
    if (text && classifyIntent(text) === "write") {
      new Notice(t("notice.cardBuild", { id }));
      await this.openChatForAnnotation(id, { mode: "build", send: text });
      return;
    }
    await this.askAgent(this.indexTable.get(id) ?? record);
  }

  /**
   * One in-card dialogue turn. Builds the conversation context from the
   * annotation (selected text, note, prior review + dialogue turns), sends it to
   * the chat engine, persists both turns into the annotation file, and — when
   * the learner asked to change the original text — returns a diff + an apply
   * closure so the card can offer a preview-then-apply edit (Phase 3).
   */
  public async replyInAnnotation(
    id: string,
    message: string
  ): Promise<DialogueReplyResult> {
    const record = this.indexTable.get(id);
    if (!record) return { ok: false, error: t("card.reply.error") };
    const trimmed = message.trim();
    if (!trimmed) return { ok: false };

    const lang = this.settings.reviewLanguage.trim() || detectLanguageName(trimmed);
    // The learner wants the original rewritten → capture where the edit lands and
    // ask the engine to wrap a drop-in replacement so we can preview it.
    const wantsEdit = classifyIntent(trimmed) === "write";
    const target = wantsEdit ? this.captureEditTarget(record.selectedText) : null;
    const engineText = wantsEdit
      ? `${buildEditInstruction(target?.hasSelection ?? false)}\n\n${trimmed}`
      : trimmed;

    const system = this.dialogueSystemPrompt(record, lang);
    const history: ChatMessage[] = (record.dialogue ?? []).map((turn) => ({
      role: turn.role === "agent" ? "assistant" : "user",
      content: turn.text
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: engineText }
    ];
    const openCodePrompt = [
      system,
      "--- Conversation so far ---",
      ...(record.dialogue ?? []).map(
        (turn) => `${turn.role === "agent" ? "Tutor" : "Learner"}: ${turn.text}`
      ),
      `Learner: ${engineText}`
    ].join("\n\n");

    const turn = await this.runDialogueTurn(messages, openCodePrompt);
    if (!turn.ok || !turn.text) {
      return { ok: false, ...(turn.error ? { error: turn.error } : {}) };
    }

    let agentText = turn.text;
    let edit: DialogueReplyResult["edit"];
    if (wantsEdit) {
      const parsed = extractEdit(turn.text);
      agentText = parsed.explanation || turn.text;
      if (parsed.edit && target) {
        const before = target.hasSelection ? target.original : "";
        const diff = before
          ? lineDiff(before, parsed.edit)
          : parsed.edit.split(/\r?\n/).map((line) => `+ ${line}`).join("\n");
        const captured = target;
        const replacement = parsed.edit;
        agentText = parsed.explanation || t("chat.edit.proposed");
        edit = { diff, apply: () => this.applyNoteEdit(captured, replacement) };
      }
    }

    const turns: DialogueTurn[] = [
      { role: "user", text: trimmed, at: nowIso() },
      { role: "agent", text: agentText, at: nowIso() }
    ];
    const updated = await this.store.appendDialogueTurns(id, turns);
    if (updated) {
      // Keep the in-memory index in step so the next natural refresh shows the
      // thread, without tearing down the card the learner is using right now.
      this.indexTable.upsert(
        recordFromAnnotation(updated, this.store.annotationPath(id))
      );
    }
    return { ok: true, agentText, ...(edit ? { edit } : {}) };
  }

  /** System prompt for an in-annotation dialogue turn (persona + the annotation). */
  private dialogueSystemPrompt(record: IndexRecord, lang: string): string {
    const profile = this.learnerProfileSummary();
    const parts = [
      tutorSystemPrompt(lang),
      [
        "You are talking with the learner in the margin beside one of their annotations.",
        `Annotation ${record.annotationId} in ${record.sourceFile}.`,
        `Selected text:\n"""\n${record.selectedText ?? ""}\n"""`,
        `Learner's note:\n"""\n${record.userNote ?? record.userNoteSummary ?? ""}\n"""`,
        ...(record.reviewText
          ? [`Your earlier review:\n"""\n${record.reviewText}\n"""`]
          : []),
        ...(profile
          ? [`What you know about this learner:\n"""\n${profile}\n"""`]
          : []),
        "Answer the learner's follow-up about this passage, using the conversation so far."
      ].join("\n")
    ];
    return parts.join("\n\n");
  }

  /**
   * Run one conversational turn through the chat engine. Uses the chat engine
   * setting (OpenCode → API fallback, mirroring the sidebar) so dialogue and the
   * sidebar behave the same.
   */
  private async runDialogueTurn(
    messages: ChatMessage[],
    openCodePrompt: string
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    if (this.settings.chatEngine === "opencode") {
      const command = this.settings.agentCommand.trim() || "opencode";
      const result = await runAcpReview({
        command,
        model: this.settings.agentModel,
        prompt: openCodePrompt,
        timeoutMs: this.chatTimeoutMs()
      });
      if (!result.timedOut && (result.ok || result.reviewText)) {
        return { ok: true, text: result.reviewText };
      }
      // OpenCode could not answer — fall back to the API when a key is set.
      if (this.settings.apiKey.trim()) {
        return this.dialogueApiTurn(messages);
      }
      // No specific detail → the card shows its localized generic error.
      return { ok: false, text: "", ...(result.error ? { error: result.error } : {}) };
    }
    return this.dialogueApiTurn(messages);
  }

  private async dialogueApiTurn(
    messages: ChatMessage[]
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    if (!this.settings.apiKey.trim()) {
      return { ok: false, text: "", error: t("notice.apiKeyMissing") };
    }
    const api = await this.chatApiTurn(messages);
    return {
      ok: api.ok,
      text: api.reviewText,
      ...(api.error ? { error: api.error } : {})
    };
  }

  private confirmDeleteById(id: string): void {
    const record = this.indexTable.get(id);
    if (record) this.confirmDelete(record);
  }

  /** Render annotation marker + highlight in Reading view (post-processor). */
  private decorateReadingView(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ): void {
    const records = this.indexTable
      .all()
      .filter((record) => record.sourceFile === ctx.sourcePath);
    if (records.length === 0) return;
    const info = ctx.getSectionInfo(el);
    if (!info) return;

    const byBlock = new Map<string, IndexRecord[]>();
    for (const record of records) {
      const key = bareBlockId(record.anchor);
      const list = byBlock.get(key);
      if (list) list.push(record);
      else byBlock.set(key, [record]);
    }
    const cls = styleClass(this.settings.highlightStyle);
    const lines = info.text.split("\n").slice(info.lineStart, info.lineEnd + 1);
    for (const line of lines) {
      const match = BLOCK_ID_SUFFIX.exec(line);
      const blockRecords = match?.[1] ? byBlock.get(match[1]) : undefined;
      if (!blockRecords) continue;
      // A paragraph may carry several annotations sharing one block id; render
      // each (its own underline + clickable marker).
      for (const record of blockRecords) {
        if (el.querySelector(`.atl-marker[data-atl-id="${record.annotationId}"]`)) {
          continue;
        }
        if (cls && record.selectedText) {
          underlineFirst(el, record.selectedText, cls, record.annotationId, (id, anchor) =>
            void this.openInlineNote(id, anchor)
          );
        }
        if (this.settings.showMarker) this.appendReadingMarker(el, record.annotationId);
      }
    }
  }

  private appendReadingMarker(el: HTMLElement, id: string): void {
    const marker = el.createSpan({ cls: "atl-marker" });
    marker.dataset["atlId"] = id;
    marker.setAttribute("aria-label", t("action.edit"));
    setIcon(marker, "message-square");
    marker.onclick = (event) => {
      event.preventDefault();
      void this.openInlineNote(id, marker);
    };
  }

  public confirmDelete(record: IndexRecord): void {
    new ConfirmModal(this.app, {
      title: t("delete.title"),
      body: t("delete.body", { id: record.annotationId }),
      confirmText: t("delete.confirm"),
      warning: true,
      onConfirm: () => this.deleteAnnotation(record)
    }).open();
  }

  private async deleteAnnotation(record: IndexRecord): Promise<void> {
    const blockId = bareBlockId(record.anchor);
    const file = this.fileAt(record.sourceFile);
    if (
      file &&
      shouldRemoveAnnotationBlockId(record, this.indexTable.all())
    ) {
      await this.app.vault.process(file, (data) =>
        data.replace(new RegExp(`\\s+\\^${escapeRegExp(blockId)}\\s*$`, "m"), "")
      );
    }
    await this.store.deleteAnnotation(record.annotationId);
    this.indexTable.remove(record.annotationId);
    if (this.settings.cardGeom[record.annotationId]) {
      delete this.settings.cardGeom[record.annotationId];
      void this.persistSettings();
    }
    await this.commit();
    new Notice(t("notice.deleted", { id: record.annotationId }));
  }

  // --- jump to source + repair ----------------------------------------------

  public async openAnnotation(record: IndexRecord): Promise<void> {
    const annotation = await this.store.readAnnotation(record.annotationId);
    if (!annotation) {
      new Notice(t("notice.fileUnavailable"));
      return;
    }
    const file = this.fileAt(annotation.sourceFile);
    if (!file || file.extension !== "md") {
      await this.markSourceMissing(annotation);
      new Notice(t("notice.sourceMissing"));
      return;
    }
    const content = await this.app.vault.read(file);
    const resolution = resolveAnchor(content, annotation.anchor);
    if (resolution.strategy === "not-found" || resolution.line === undefined) {
      await this.markSourceMissing(annotation);
      new Notice(t("notice.couldNotLocate"));
      return;
    }
    if (resolution.requiresConfirmation) {
      const line = resolution.line;
      new ConfirmModal(this.app, {
        title: t("repair.title"),
        body: t("repair.body", {
          percent: Math.round(resolution.confidence * 100)
        }),
        confirmText: t("repair.confirm"),
        onConfirm: () => this.repairAnchor(file, annotation, line)
      }).open();
      return;
    }
    await this.reveal(file, resolution.line, annotation.anchor.selectedText);
  }

  private async markSourceMissing(annotation: Annotation): Promise<void> {
    const updated = await this.store.updateAnnotation(annotation.id, {
      status: "source_missing"
    });
    if (updated) {
      this.indexTable.upsert(
        recordFromAnnotation(updated, this.store.annotationPath(annotation.id))
      );
      await this.commit();
    }
  }

  private async repairAnchor(
    file: TFile,
    annotation: Annotation,
    line: number
  ): Promise<void> {
    let lineText = "";
    await this.app.vault.process(file, (data) => {
      const lines = data.split(/\r?\n/);
      lineText = lines[line] ?? "";
      if (this.settings.useBlockAnchors && !detectBlockId(lineText)) {
        lines[line] = `${lineText} ^${annotation.anchor.blockId}`;
      }
      return lines.join("\n");
    });
    const newStatus =
      annotation.status === "source_missing"
        ? annotation.reviewText
          ? annotation.review
            ? "reviewed"
            : "reviewed_unstructured"
          : "saved"
        : annotation.status;
    const updated = await this.store.updateAnnotation(annotation.id, {
      anchor: { selectedText: lineTextWithoutBlockId(lineText) },
      status: newStatus
    });
    if (updated) {
      this.indexTable.upsert(
        recordFromAnnotation(updated, this.store.annotationPath(annotation.id))
      );
    }
    await this.commit();
    await this.reveal(file, line, lineTextWithoutBlockId(lineText));
  }

  private async reveal(
    file: TFile,
    line: number,
    selectedText: string
  ): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    view.editor.setCursor({ line, ch: 0 });
    view.editor.scrollIntoView(
      { from: { line, ch: 0 }, to: { line, ch: selectedText.length } },
      true
    );
  }

  // --- index / overview ------------------------------------------------------

  public async rebuildIndex(notify: boolean): Promise<void> {
    this.librarySnapshot = await this.store.rebuildLibrary(
      this.librarySnapshot
    );
    this.indexTable.replaceAll(this.librarySnapshot.annotations);
    this.refreshDashboard();
    this.settingTab?.refresh();
    await this.refreshDecorations();
    if (notify) {
      const errors = this.librarySnapshot.diagnostics.length;
      new Notice(
        errors > 0
          ? t("notice.indexedErrors", {
              count: this.librarySnapshot.annotations.length,
              errors
            })
          : t("notice.indexed", {
              count: this.librarySnapshot.annotations.length
            })
      );
    }
  }

  private async commit(): Promise<void> {
    await this.rebuildIndex(false);
  }

  // --- watcher reconcile -----------------------------------------------------

  private async onMemoryChanged(paths: string[]): Promise<void> {
    if (!this.settings.autoRefreshOnAgentWrite) {
      this.refreshDashboard();
      return;
    }
    if (paths.some((path) => this.store.isWatchedPath(path))) {
      await this.rebuildIndex(false);
    }
  }

  public async openLibraryPath(path: string): Promise<void> {
    await this.app.workspace.openLinkText(path, "", false);
  }

  public libraryPaths(): {
    overview: string;
    annotationIndex: string;
    cellIndex: string;
    sceneIndex: string;
    learnerProfile: string;
    preferences: string;
  } {
    return {
      overview: this.store.overviewPath(),
      annotationIndex: this.store.annotationIndexPath(),
      cellIndex: this.store.cellIndexPath(),
      sceneIndex: this.store.sceneIndexPath(),
      learnerProfile: this.store.learnerProfilePath(),
      preferences: this.store.preferencesPath()
    };
  }

  public async approveProposal(id: string): Promise<void> {
    const result = await this.store.approveProposal(id);
    new Notice(result.ok ? t("notice.proposalApproved") : result.message);
    await this.rebuildIndex(false);
  }

  public async rejectProposal(id: string): Promise<void> {
    const result = await this.store.rejectProposal(id);
    new Notice(result.ok ? t("notice.proposalRejected") : result.message);
    await this.rebuildIndex(false);
  }

  public async proposalDiff(
    proposal: LibrarySnapshot["proposals"][number]
  ): Promise<string> {
    const current = await this.store.proposalTargetContent(proposal);
    return lineDiff(current ?? "", proposal.candidate);
  }

  public async migrateLegacyAnnotations(): Promise<void> {
    const result = await this.store.migrateLegacyAnnotations();
    new Notice(
      t("notice.migrated", {
        migrated: result.migrated,
        errors: result.errors.length
      })
    );
    await this.rebuildIndex(false);
  }

  // --- notebook --------------------------------------------------------------

  /**
   * Build the per-Vault study notebook (index + per-document pages + related-
   * document chapters) from the current annotations and dialogue, then open it.
   * Deterministic and instant — no model calls (see {@link enrichNotebook}).
   */
  public async buildNotebook(): Promise<void> {
    const records = this.indexTable.all();
    if (records.length === 0) {
      new Notice(t("notice.notebookEmpty"));
      return;
    }
    const progress = new Notice(t("notice.notebookBuilding"), 0);
    try {
      const result = await this.store.writeNotebook(records);
      progress.hide();
      new Notice(
        t("notice.notebookDone", { pages: result.pages, chapters: result.chapters })
      );
      await this.openLibraryPath(result.path);
    } catch (error) {
      progress.hide();
      new Notice(
        t("notice.notebookFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  /**
   * Hybrid enrichment: build the notebook, but first ask the engine to write a
   * short synthesis for each studied document (sequential, free-model safe), so
   * the pages gain prose summaries on top of the deterministic structure.
   */
  public async enrichNotebook(): Promise<void> {
    const records = this.indexTable.all();
    if (records.length === 0) {
      new Notice(t("notice.notebookEmpty"));
      return;
    }
    const byDoc = new Map<string, IndexRecord[]>();
    for (const record of records) {
      const list = byDoc.get(record.sourceFile);
      if (list) list.push(record);
      else byDoc.set(record.sourceFile, [record]);
    }
    const docs = [...byDoc.entries()];
    const progress = new Notice(
      t("notice.notebookEnriching", { done: 0, total: docs.length }),
      0
    );
    const synthesis = new Map<string, string>();
    try {
      let done = 0;
      for (const [sourceFile, recs] of docs) {
        const text = await this.synthesizeDocument(sourceFile, recs);
        if (text) synthesis.set(sourceFile, text);
        done += 1;
        progress.setMessage(
          t("notice.notebookEnriching", { done, total: docs.length })
        );
      }
      const result = await this.store.writeNotebook(records, synthesis);
      progress.hide();
      new Notice(
        t("notice.notebookDone", { pages: result.pages, chapters: result.chapters })
      );
      await this.openLibraryPath(result.path);
    } catch (error) {
      progress.hide();
      new Notice(
        t("notice.notebookFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  /** One engine call: synthesize a learner's annotations on one document. */
  private async synthesizeDocument(
    sourceFile: string,
    records: IndexRecord[]
  ): Promise<string> {
    const title = sourceFile.split("/").pop()?.replace(/\.md$/i, "") ?? sourceFile;
    const lang =
      this.settings.reviewLanguage.trim() ||
      detectLanguageName(records.map((r) => r.userNote ?? "").join(" "));
    const items = records
      .map((record, index) => {
        const excerpt = (record.selectedText ?? "").replace(/\s+/g, " ").trim();
        const note = (record.userNote ?? record.userNoteSummary ?? "").trim();
        const review = (record.reviewSummary ?? record.reviewText ?? "").trim();
        return [
          `(${index + 1}) Excerpt: ${excerpt.slice(0, 200)}`,
          note ? `    Learner's note: ${note}` : "",
          review ? `    Your review: ${review}` : ""
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");
    const system = `${tutorSystemPrompt(lang)}\n\nYou are writing a short synthesis for the learner's study notebook page about "${title}".`;
    const user = `Below are the learner's annotations on ${sourceFile}. Write 2-4 sentences synthesizing what they engaged with and what to revisit. Plain prose — no headings, no lists.\n\n${items}`;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
    const turn = await this.runDialogueTurn(messages, `${system}\n\n${user}`);
    return turn.ok ? turn.text.trim() : "";
  }

  // --- view helpers ----------------------------------------------------------

  public async openChat(): Promise<ChatView | null> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    const leaf =
      existing ??
      this.app.workspace.getRightLeaf(false) ??
      this.app.workspace.getLeaf(true);
    if (!existing) {
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    return view instanceof ChatView ? view : null;
  }

  /** Open the chat and seed it with one annotation as the conversation context. */
  public async openChatForAnnotation(
    id: string,
    opts?: { mode?: ChatMode; send?: string }
  ): Promise<void> {
    const record = this.indexTable.all().find((r) => r.annotationId === id);
    const view = await this.openChat();
    if (view && record) view.seedAnnotation(record, opts);
  }

  public async openDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    const leaf =
      existing ??
      this.app.workspace.getRightLeaf(false) ??
      this.app.workspace.getLeaf(true);
    if (!existing) {
      await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    this.refreshDashboard();
  }

  // --- tutor chat support ----------------------------------------------------

  /**
   * The current Markdown note + selection for the chat. Falls back to the last
   * active note when the chat leaf itself is focused (so the context chip and the
   * prompt context don't vanish the moment the user clicks into the dialog).
   */
  public async chatContext(): Promise<ChatContext | null> {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) this.lastMarkdownView = active;
    let view: MarkdownView | null = active ?? this.lastMarkdownView;
    if (!view?.file) {
      // Last resort (e.g. first open, before any leaf change was observed): use
      // any open Markdown note.
      const leaf = this.app.workspace
        .getLeavesOfType("markdown")
        .find((candidate) => (candidate.view as MarkdownView).file);
      view = leaf ? (leaf.view as MarkdownView) : null;
      if (view?.file) this.lastMarkdownView = view;
    }
    if (!view?.file) return null;
    let selection = "";
    try {
      selection = view.editor?.getSelection?.() ?? "";
    } catch {
      selection = "";
    }
    const profileSummary = this.learnerProfileSummary();
    return {
      notePath: view.file.path,
      noteTitle: view.file.basename,
      selection,
      content: await this.noteContent(view.file.path),
      ...(profileSummary ? { profileSummary } : {})
    };
  }

  /**
   * A short summary of the learner from their profile (`Agent Memory/profiles/
   * learner-profile.md`), already parsed into the library snapshot. Fed into chat,
   * dialogue, and review prompts so the agent tailors feedback to this learner.
   */
  public learnerProfileSummary(): string {
    const profile = this.librarySnapshot.profiles.find(
      (item) => item.kind === "learner-profile"
    );
    const summary = profile?.summary?.trim();
    if (!summary) return "";
    return summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
  }

  /** Read a note's full text by Vault path (for chat context / pinned annotation). */
  public async noteContent(path: string): Promise<string> {
    const file = this.fileAt(path);
    if (!(file instanceof TFile)) return "";
    try {
      return await this.app.vault.read(file);
    } catch {
      return "";
    }
  }

  /**
   * Snapshot where a Build-mode edit should land. A live selection wins; failing
   * that, `preferText` (e.g. a pinned annotation's selected text) is located in
   * the note so a "polish" replaces the annotated span rather than inserting at
   * the cursor. Otherwise the edit inserts at the cursor.
   */
  public captureEditTarget(preferText?: string): EditTarget | null {
    const view =
      this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.lastMarkdownView;
    if (!view?.file || !view.editor) return null;
    const editor = view.editor;
    const original = editor.getSelection();
    if (original) {
      return {
        view,
        hasSelection: true,
        original,
        from: editor.getCursor("from"),
        to: editor.getCursor("to")
      };
    }
    if (preferText) {
      const idx = editor.getValue().indexOf(preferText);
      if (idx >= 0) {
        return {
          view,
          hasSelection: true,
          original: preferText,
          from: editor.offsetToPos(idx),
          to: editor.offsetToPos(idx + preferText.length)
        };
      }
    }
    return {
      view,
      hasSelection: false,
      original: "",
      from: editor.getCursor("from"),
      to: editor.getCursor("to")
    };
  }

  /**
   * Apply a chat-proposed edit. Replaces the captured selection (re-locating it
   * by text if it shifted), or inserts at the cursor when nothing was selected.
   * Returns false (with a notice) when the original text can no longer be found.
   */
  public applyNoteEdit(target: EditTarget, newText: string): boolean {
    const editor = target.view.editor;
    if (!editor) return false;
    if (target.hasSelection && target.original) {
      const current = editor.getRange(target.from, target.to);
      if (current === target.original) {
        editor.replaceRange(newText, target.from, target.to);
      } else {
        const doc = editor.getValue();
        const idx = doc.indexOf(target.original);
        if (idx === -1) {
          new Notice(t("chat.edit.notLocated"));
          return false;
        }
        editor.replaceRange(
          newText,
          editor.offsetToPos(idx),
          editor.offsetToPos(idx + target.original.length)
        );
      }
    } else {
      editor.replaceRange(newText, target.from);
    }
    void this.app.workspace.revealLeaf(target.view.leaf);
    editor.focus();
    return true;
  }

  /** One multi-turn API chat turn (Direct API engine). */
  public async chatApiTurn(
    messages: ChatMessage[]
  ): Promise<{ ok: boolean; reviewText: string; error?: string }> {
    const result = await runApiChat(
      {
        baseUrl: this.settings.apiBaseUrl,
        apiKey: this.settings.apiKey,
        model: this.settings.apiModel,
        messages,
        timeoutMs: this.chatTimeoutMs()
      },
      this.httpRequest
    );
    return {
      ok: result.ok,
      reviewText: result.reviewText,
      ...(result.error ? { error: result.error } : {})
    };
  }

  /** Spawn a persistent OpenCode ACP session for the chat (read-only fs). */
  public async startChatSession(handlers: {
    onUpdate: (event: AcpStreamEvent) => void;
    onExit: (reason: string) => void;
  }): Promise<AcpSessionHandle> {
    return startAcpSession({
      command: this.settings.agentCommand.trim() || "opencode",
      model: this.settings.agentModel,
      cwd: this.vaultBasePath() ?? tmpdir(),
      onUpdate: handlers.onUpdate,
      onExit: handlers.onExit,
      readFile: (path) => this.readVaultFileForAgent(path),
      startTimeoutMs: Math.max(60000, this.settings.agentTimeoutSeconds * 1000)
    });
  }

  /** Find an annotation the learner is asking to locate (by id, else by text). */
  public chatLocate(text: string): IndexRecord | null {
    const id = extractAnnotationId(text);
    const all = this.indexTable.all();
    if (id) {
      const byId = all.find((record) => record.annotationId === id);
      if (byId) return byId;
    }
    const words = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 2);
    if (words.length === 0) return null;
    let best: { record: IndexRecord; score: number } | null = null;
    for (const record of all) {
      const hay = `${record.selectedText ?? ""} ${record.userNote ?? ""} ${
        record.userNoteSummary ?? ""
      } ${record.concepts.join(" ")}`.toLowerCase();
      let score = 0;
      for (const word of words) if (hay.includes(word)) score += 1;
      if (score > 0 && (!best || score > best.score)) best = { record, score };
    }
    return best?.record ?? null;
  }

  /** Jump the editor to an annotation (reuses the standard anchor resolution). */
  public chatJump(record: IndexRecord): void {
    void this.openAnnotation(record);
  }

  private chatTimeoutMs(): number {
    return Math.max(MIN_AGENT_TIMEOUT_SECONDS, this.settings.agentTimeoutSeconds) * 1000;
  }

  /** Desktop Vault root, for the ACP session cwd + read guarding. */
  private vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
  }

  /**
   * Serve a file the agent asks to read, guarded to the Vault. Resolves the
   * requested path (absolute or relative to the Vault root) and refuses anything
   * that escapes the Vault — agents never reach arbitrary disk.
   */
  private async readVaultFileForAgent(requested: string): Promise<string | null> {
    const base = this.vaultBasePath();
    if (!base || !requested) return null;
    const abs = isAbsolute(requested)
      ? pathResolve(requested)
      : pathResolve(base, requested);
    const rel = pathRelative(base, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    try {
      const text = await fsReadFile(abs, "utf8");
      // Strip a UTF-8 BOM so the agent doesn't echo a stray ﻿ (which shows
      // up as a garbled leading character, especially in generated tables).
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } catch {
      return null;
    }
  }

  private refreshDashboard(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof DashboardView) view.refresh();
    }
  }

  private async refreshDecorations(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      this.readingRail.detach();
      return;
    }
    const marks = this.marksFor(view.file.path);
    const cm = (view.editor as EditorWithCm).cm;
    if (cm) {
      cm.dispatch({
        effects: setAnnotationMarks.of({
          marks,
          style: this.settings.highlightStyle,
          showMarker: this.settings.showMarker,
          marginComments: this.settings.marginComments,
          marginPaper: this.settings.marginPaper,
          marginHideLink: this.settings.marginHideLink,
          inlineReview: this.settings.inlineReview
        })
      });
    }
    if (view.getMode() === "preview" && this.settings.marginComments) {
      this.readingRail.attach(view);
      this.readingRail.setMarks(
        marks,
        this.settings.marginPaper,
        this.settings.marginHideLink,
        this.settings.inlineReview
      );
    } else {
      this.readingRail.detach();
    }
  }

  /** The annotation marks for a source file, shared by both rails. */
  private marksFor(sourcePath: string): AnchorMark[] {
    return this.indexTable
      .all()
      .filter((record) => record.sourceFile === sourcePath)
      .map((record) => {
        const { comment, question } = this.cardReview(record);
        return {
          id: record.annotationId,
          blockId: bareBlockId(record.anchor),
          selectedText: record.selectedText ?? "",
          note: record.userNote ?? record.userNoteSummary ?? "",
          status: record.status,
          review: comment,
          reviewQuestion: question,
          ...(record.dialogue ? { dialogue: record.dialogue } : {})
        };
      });
  }

  /**
   * Reduce a stored review to what the comment card shows: a natural comment
   * paragraph plus the Socratic question — never the Correctness/labels, so the
   * card reads like a margin note rather than a form. Falls back to the raw text
   * for older, unstructured reviews.
   */
  private cardReview(record: IndexRecord): { comment: string; question?: string } {
    const text = record.reviewText;
    if (!text) return { comment: "" };
    const parsed = parseAgentReview(text, record.updatedAt);
    if (!parsed) return { comment: text };
    const question = parsed.socraticQuestion?.trim();
    const meaningful = question && !/^\(?\s*(none|n\/?a|na|-+)\s*\)?$/i.test(question);
    return {
      comment: parsed.summary.trim() || text,
      question: meaningful ? question : undefined
    };
  }

  private async toggleMarks(): Promise<void> {
    const visible =
      this.settings.showMarker || this.settings.highlightStyle !== "none";
    if (visible) {
      this.stashedStyle =
        this.settings.highlightStyle === "none"
          ? this.stashedStyle
          : this.settings.highlightStyle;
      this.settings.highlightStyle = "none";
      this.settings.showMarker = false;
    } else {
      this.settings.highlightStyle = this.stashedStyle;
      this.settings.showMarker = true;
    }
    await this.persistSettings();
    await this.refreshDecorations();
    new Notice(visible ? t("notice.marksHidden") : t("notice.marksShown"));
  }

  private getActiveRecord(): IndexRecord | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return null;
    const editor = view.editor;
    const block = findBlock(editor, editor.getCursor().line);
    const blockId = detectBlockId(editor.getLine(block.endLine));
    if (!blockId) return null;
    const sourcePath = view.file.path;
    return (
      this.indexTable
        .all()
        .find(
          (record) =>
            bareBlockId(record.anchor) === blockId &&
            record.sourceFile === sourcePath
        ) ?? null
    );
  }

  private fileAt(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }
}

/**
 * Wrap the first occurrence of `text` within `el` in a styled span, tagged with
 * the annotation id and made clickable so it toggles the margin card even when
 * the marker glyph is hidden.
 */
function underlineFirst(
  el: HTMLElement,
  text: string,
  cls: string,
  id: string,
  onClick: (id: string, anchor: HTMLElement) => void
): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue ?? "";
    const index = value.indexOf(text);
    if (index >= 0) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const span = document.createElement("span");
      span.className = cls;
      span.dataset["atlId"] = id;
      span.addEventListener("click", (event) => {
        event.preventDefault();
        onClick(id, span);
      });
      try {
        range.surroundContents(span);
      } catch {
        // Range crossed element boundaries (inline markup); leave it unstyled.
      }
      return;
    }
    node = walker.nextNode();
  }
}
