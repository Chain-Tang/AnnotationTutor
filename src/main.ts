import {
  type Editor,
  type EditorPosition,
  FileSystemAdapter,
  type MarkdownFileInfo,
  type MarkdownPostProcessorContext,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
  setIcon,
  type View
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import {
  type Annotation,
  type DialogueTurn,
  type IndexRecord,
  type ProfileKind,
  type Scene,
  type SceneType,
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
import {
  mergeShellPath,
  probeOpenCodeEnv,
  type ShellProbe
} from "./opencode-setup.js";
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
import { highlightColorVars } from "./highlight-color.js";
import {
  marginRailExtension,
  setMarginCardHandlers,
  setCardGeomStore,
  type DialogueReplyResult
} from "./margin-rail.js";
import { ReadingRail } from "./reading-rail.js";
import {
  BUILTIN_SKINS,
  mergeSkins,
  resolveRailSkin,
  type RailSkin,
  type SkinDef
} from "./skins.js";
import { SkinLoader } from "./skin-loader.js";
import { PAPER_TEXTURE, LEAF_TEXTURE } from "./textures.js";
import { highlightFirst } from "./reading-highlight.js";
import { setLanguage, t } from "./i18n.js";
import {
  DASHBOARD_VIEW_TYPE,
  DashboardView
} from "./views/dashboard-view.js";
import { CHAT_VIEW_TYPE, ChatView, type ChatMode } from "./views/chat-view.js";
import {
  startAcpSession,
  type AcpSessionHandle,
  type AcpStreamEvent,
  type PermissionChoice
} from "./acp-session.js";
import { parseMcpConfig, type McpParseResult } from "./mcp-config.js";
import { openPermissionModal } from "./views/permission-modal.js";
import {
  buildPageCaptureNote,
  buildSelectionCaptureNote,
  captureNoteStem
} from "./web-capture.js";
import {
  decodeCapturePayload,
  type CapturePayload
} from "./web-bridge/protocol.js";
import { WebBridgeServer } from "./web-bridge/server.js";
import {
  aggregateWebStats,
  type WebCaptureMeta,
  type WebStats
} from "./web-bridge/stats.js";
import {
  parseImport,
  zoteroCaptureNote,
  type ZoteroEntry
} from "./zotero-import.js";
import {
  BUILTIN_COMMAND_DIR,
  BUILTIN_COMMANDS,
  builtinCommandFile
} from "./builtin-commands.js";
import { isExcalidrawDoc, sanitizeExcalidrawDoc } from "./excalidraw-guard.js";
import { tutorSystemPrompt, type ChatContext } from "./chat-prompt.js";
import { classifyIntent, extractAnnotationId } from "./intent.js";
import { buildEditInstruction, padBlockInsertion, resolveEdit } from "./edit-parse.js";
import { defaultHotkeys } from "./hotkeys.js";
import { detectLanguageName } from "./lang.js";
import { TranslationController } from "./translation-controller.js";
import { NotebookController } from "./notebook-controller.js";
import { ReviewController } from "./review-controller.js";
import {
  deriveMasterySnapshot,
  deriveProfileSummary,
  summarizeMastery
} from "./learning.js";
import { sceneIdFromTitle } from "./memory-derive.js";
import type { ReviewOutcome } from "./review-outcome.js";
import {
  basename,
  isAbsolute,
  relative as pathRelative,
  resolve as pathResolve
} from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ConfirmModal, DetailModal } from "./views/annotation-modal.js";
import { FloatingNotePanel } from "./views/note-panel.js";
import { NotePopover } from "./views/note-popover.js";

type EditorWithCm = Editor & { cm?: EditorView };
type Block = { startLine: number; endLine: number };

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
  /** Public for the chat view (session persistence talks to the vault directly). */
  public store!: VaultStore;
  private watcher!: MemoryWatcher;
  private settingTab!: AnnotationTutorLiteSettingTab;
  private readonly readingRail = new ReadingRail();
  // User-authored card skins discovered in the plugin's skins/ folder, plus the
  // loader that injects the active one's CSS. Built-ins live in skins.ts/styles.css.
  private skinLoader!: SkinLoader;
  public customSkins: SkinDef[] = [];
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
  // Localhost half of the Web Clipper bridge; null while disabled/stopped.
  private webBridge: WebBridgeServer | null = null;
  // Guards against re-opening the "install the Web Clipper" prompt each time the
  // sidebar re-renders in one session.
  private webPromptShown = false;
  // Inline translation + background pre-translation (Alt+T), wired in onload.
  private translation!: TranslationController;
  // Study-notebook commands (build / enrich / open), wired in onload.
  private notebook!: NotebookController;
  // Memory cells, SM-2 spaced review, and opt-in feedback, wired in onload.
  public review!: ReviewController;
  /** Per-path serialization of the Excalidraw repair queue (see sanitize). */
  private readonly excalidrawQueue = new Map<string, Promise<void>>();

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
    this.applyAgentShellPath();
    this.applyLocale();
    this.stashedStyle =
      this.settings.highlightStyle === "none"
        ? DEFAULT_SETTINGS.highlightStyle
        : this.settings.highlightStyle;
    this.applyHighlightColor();
    this.store = new VaultStore(this.app, this.manifest.id, () => this.settings);
    this.watcher = new MemoryWatcher(
      this.store,
      () => this.settings,
      (paths) => this.onMemoryChanged(paths)
    );

    this.applyTextureVars();
    this.skinLoader = new SkinLoader(this.app, this.manifest.dir ?? "");
    this.customSkins = await this.skinLoader.loadCustomSkins();
    this.applySkinCss();
    this.settingTab = new AnnotationTutorLiteSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerEditorExtension([annotationDecorations, marginRailExtension]);
    setMarkerClickHandler((id, el) => void this.openInlineNote(id, el));
    setMarginCardHandlers({
      save: (id, note) => void this.saveNoteInline(id, note),
      ask: (id, note) => void this.askFromCard(id, note),
      discuss: (id) => void this.openChatForAnnotation(id),
      reply: (id, message) => this.replyInAnnotation(id, message),
      render: (el, markdown, annotationId) =>
        MarkdownRenderer.render(
          this.app,
          markdown,
          el,
          // Resolve the reply's relative links and embeds against the annotated
          // note, not the Vault root.
          (annotationId ? this.indexTable.get(annotationId)?.sourceFile : "") ?? "",
          this
        ),
      saveCell: (id) => void this.review.createCellFromAnnotation(id),
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
          ...(geom.h ? { h: geom.h } : {}),
          ...(geom.s ? { s: geom.s } : {})
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
    // Web Clipper: small selection captures arrive as base64url JSON on an
    // obsidian:// URI (the extension can't reach the vault directly); large
    // full-page archives come over the localhost bridge instead.
    this.registerObsidianProtocolHandler("atl-web-capture", (params) => {
      void this.receiveWebCapture(params.payload ?? "");
    });
    void this.applyWebBridge();
    this.addRibbonIcon("graduation-cap", t("ribbon.openChat"), () => {
      void this.openChat();
    });
    this.addRibbonIcon("notebook", t("ribbon.openNotebook"), () => {
      void this.notebook.openNotebook();
    });
    const pretranslateStatus = this.addStatusBarItem();
    pretranslateStatus.addClass("atl-pretranslate-status");
    this.translation = new TranslationController({
      app: this.app,
      statusBar: pretranslateStatus,
      settings: () => this.settings,
      chatTimeoutMs: () => this.chatTimeoutMs(),
      captureText: (prompt, timeoutMs) => this.captureText(prompt, timeoutMs)
    });
    this.notebook = new NotebookController({
      app: this.app,
      store: this.store,
      records: () => this.indexTable.all(),
      cells: () => this.librarySnapshot.cells,
      reviewLanguage: () => this.settings.reviewLanguage,
      openPath: (path) => this.openLibraryPath(path),
      runTurn: (messages, openCodePrompt) => this.runDialogueTurn(messages, openCodePrompt)
    });
    const dueStatus = this.addStatusBarItem();
    dueStatus.addClass("atl-due-status");
    this.review = new ReviewController({
      app: this.app,
      store: this.store,
      statusBar: dueStatus,
      record: (id) => this.indexTable.get(id),
      cells: () => this.librarySnapshot.cells,
      settings: () => this.settings,
      rebuild: () => this.rebuildIndex(false),
      openPath: (path) => this.openLibraryPath(path),
      runTurn: (messages, openCodePrompt) => this.runDialogueTurn(messages, openCodePrompt)
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
          if (view.file.extension === "md") void this.translation.maybePretranslate(view.file);
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
          void this.translation.maybePretranslate(file);
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
        this.translation.onFileDeleted(file.path);
        this.watcher.notify(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.translation.onFileRenamed(oldPath, file.path);
        this.watcher.notify(file.path);
        this.watcher.notify(oldPath);
      })
    );
    // Repair agent-generated Excalidraw JSON the moment the file first appears.
    // Only on `create`: a learner editing an existing drawing fires `modify`, and
    // the normalization rules (updated:1, handwritten font) are right for fresh
    // LLM output only — never for a diagram someone drew by hand.
    this.registerEvent(
      this.app.vault.on("create", (file) => void this.sanitizeExcalidrawFile(file))
    );

    this.app.workspace.onLayoutReady(() => void this.initialize());
  }

  public override onunload(): void {
    this.watcher?.dispose();
    void this.webBridge?.stop();
    this.webBridge = null;
    this.readingRail.detach();
    this.skinLoader?.unload();
    document.body.style.removeProperty("--atl-hl-color");
    document.body.style.removeProperty("--atl-hl-bg-color");
    document.body.style.removeProperty("--atl-tex-paper");
    document.body.style.removeProperty("--atl-tex-leaf");
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

  /**
   * Resolve the active UI locale from the language setting (auto = Obsidian).
   * Detection chain: older Obsidian wrote the UI language to localStorage; the
   * current build follows the OS UI language without persisting it, which the
   * renderer surfaces via navigator.languages — and when Obsidian follows the
   * OS it also syncs moment, so moment's locale is a last resort. The system
   * *region* may disagree with the UI language (en-US region + zh UI), so
   * navigator.languages beats a bare moment.locale().
   */
  public applyLocale(): void {
    const detected =
      window.localStorage.getItem("language") ??
      [...(navigator.languages ?? []), navigator.language].find((code) =>
        /^(zh|ja)/i.test(code)
      ) ??
      navigator.language ??
      window.moment?.locale?.();
    setLanguage(this.settings.language, detected);
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
    this.applyHighlightColor();
    void this.refreshDecorations();
    this.review.refreshBadge();
  }

  /** Built-in skins followed by any user skins from the skins/ folder. */
  public allSkins(): SkinDef[] {
    return mergeSkins(BUILTIN_SKINS, this.customSkins);
  }

  /** The skin (id + quiet flag) the rails should render right now. */
  public activeRailSkin(): RailSkin {
    return resolveRailSkin(this.settings.cardSkin, this.allSkins());
  }

  /**
   * Publish the real CC0 paper/leaf textures as CSS custom properties on <body>,
   * so the Sticky note / Leaf skin rules in styles.css can reference them without
   * inlining ~150KB of base64 into the stylesheet. Removed on unload.
   */
  private applyTextureVars(): void {
    const { style } = document.body;
    style.setProperty("--atl-tex-paper", `url("${PAPER_TEXTURE}")`);
    style.setProperty("--atl-tex-leaf", `url("${LEAF_TEXTURE}")`);
  }

  /** Push the active skin's custom CSS into the document (no-op for built-ins). */
  public applySkinCss(): void {
    const active = this.allSkins().find((skin) => skin.id === this.settings.cardSkin);
    this.skinLoader.applyCss(active);
  }

  /** Re-scan the skins folder, then re-apply CSS and re-render the cards. */
  public async reloadSkins(): Promise<void> {
    this.customSkins = await this.skinLoader.loadCustomSkins();
    this.applySkinCss();
    this.applyDisplaySettings();
  }

  /** Open the user skins folder in the OS file manager. */
  public async openSkinsFolder(): Promise<void> {
    await this.skinLoader.openFolder();
  }

  /** Create a starter skin file, refresh the registry, and return its id. */
  public async createSkinFromTemplate(): Promise<string> {
    const id = await this.skinLoader.createFromTemplate();
    this.customSkins = await this.skinLoader.loadCustomSkins();
    return id;
  }

  /**
   * Push the annotation highlight color into the DOM as CSS custom properties on
   * <body>, which the `.atl-hl-*` rules read. An empty/invalid color removes the
   * properties so the highlight falls back to the theme accent
   * (`var(--text-accent)`); a hex color tints the underline/bold and supplies a
   * translucent fill for the background-tint style.
   */
  public applyHighlightColor(): void {
    const { style } = document.body;
    const vars = highlightColorVars(this.settings.highlightColor);
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        style.setProperty(name, value);
      }
    } else {
      style.removeProperty("--atl-hl-color");
      style.removeProperty("--atl-hl-bg-color");
    }
  }

  // --- lifecycle -------------------------------------------------------------

  private async initialize(): Promise<void> {
    await this.store.ensureScaffold();
    const cached = await this.store.loadLibraryCache();
    if (cached) this.librarySnapshot = cached;
    await this.rebuildIndex(false);
    // Warm up the OpenCode connection on open whenever an engine uses it (review
    // or chat), not just when auto-run is enabled: this both readies the model
    // picker (its free models change over time) and establishes connectivity so
    // the CLI is reachable without first running a command. The API engine
    // discovers models lazily from the settings panel.
    if (
      this.settings.reviewEngine === "opencode" ||
      this.settings.chatEngine === "opencode"
    ) {
      void this.refreshAvailableModels();
    }
    // The file open before our file-open handler registered won't have fired it;
    // pre-translate it now so its glossary is ready for Alt+T.
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") void this.translation.maybePretranslate(active);
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

  /**
   * Prepend the login-shell PATH captured by "Set up OpenCode" onto this
   * process's PATH, so every CLI spawn (review, model list, ACP chat, Alt+T)
   * resolves OpenCode and its runtime the way a terminal would. Idempotent.
   */
  public applyAgentShellPath(): void {
    const shellPath = this.settings.agentShellPath.trim();
    if (!shellPath) return;
    const sep = process.platform === "win32" ? ";" : ":";
    process.env.PATH = mergeShellPath(process.env.PATH ?? "", shellPath, sep);
  }

  /**
   * One-tap OpenCode setup, aimed at GUI launches (especially macOS from
   * Finder/Dock) where Obsidian's minimal PATH can't find OpenCode or its
   * runtime. Asks the login shell for the resolved binary path and full PATH,
   * saves both, then verifies connectivity — guiding the user until it works.
   */
  public async setupOpenCode(): Promise<void> {
    const binName = basename(this.settings.agentCommand.trim() || "opencode");
    const probing = new Notice(t("notice.opencodeSetupProbing"), 0);
    let probe: ShellProbe | null = null;
    try {
      probe = await probeOpenCodeEnv({ binName });
    } finally {
      probing.hide();
    }
    if (probe?.path) {
      this.settings.agentShellPath = probe.path;
      this.applyAgentShellPath();
    }
    if (probe?.opencode) this.settings.agentCommand = probe.opencode;
    if (probe?.path || probe?.opencode) await this.persistSettings();
    // On macOS/Linux, neither a PATH nor a binary means OpenCode is not installed
    // or not on the login shell's PATH — there is nothing to connect to.
    if (process.platform !== "win32" && !probe?.path && !probe?.opencode) {
      new Notice(t("notice.opencodeSetupNotFound"), 12000);
      this.settingTab?.refresh();
      return;
    }
    const command = this.settings.agentCommand.trim() || "opencode";
    const testing = new Notice(t("notice.agentTesting", { command }), 0);
    try {
      const result = await this.refreshAvailableModels();
      if (result.ok) {
        new Notice(
          t("notice.opencodeSetupOk", {
            command,
            count: result.models.length,
            free: freeModels(result.models).length
          })
        );
      } else {
        new Notice(
          t("notice.opencodeSetupFailed", {
            command,
            detail: result.error ?? ""
          }),
          12000
        );
      }
    } finally {
      testing.hide();
      this.settingTab?.refresh();
    }
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
      hotkeys: defaultHotkeys("add-learning-annotation"),
      editorCallback: (editor, info) =>
        void this.createAnnotationFromEditor(editor, info)
    });
    this.addCommand({
      id: "open-tutor-chat",
      name: t("cmd.openChat"),
      callback: () => void this.openChat()
    });
    this.addCommand({
      id: "setup-opencode",
      name: t("cmd.setupOpenCode"),
      callback: () => void this.setupOpenCode()
    });
    this.addCommand({
      id: "translate-selection",
      name: t("cmd.translate"),
      hotkeys: defaultHotkeys("translate-selection"),
      // A checkCallback (not editorCallback) so the hotkey also fires in Reading
      // view, where there is no editor — that is where immersive reading happens.
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (checking) return true;
        if (view.getMode() === "preview") {
          const selection =
            view.contentEl.ownerDocument.getSelection()?.toString() ?? "";
          void this.translation.translateReadingSelection(view.file, selection);
        } else {
          void this.translation.translateSelection(view.editor);
        }
        return true;
      }
    });
    this.addCommand({
      id: "pretranslate-document",
      name: t("cmd.pretranslate"),
      hotkeys: defaultHotkeys("pretranslate-document"),
      callback: () => void this.translation.pretranslateActiveFile()
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
      id: "open-notebook",
      name: t("cmd.openNotebook"),
      callback: () => void this.notebook.openNotebook()
    });
    this.addCommand({
      id: "build-notebook",
      name: t("cmd.buildNotebook"),
      callback: () => void this.notebook.buildNotebook()
    });
    this.addCommand({
      id: "enrich-notebook",
      name: t("cmd.enrichNotebook"),
      callback: () => void this.notebook.enrichNotebook()
    });
    this.addCommand({
      id: "create-memory-cell",
      name: t("cmd.createCell"),
      callback: () => {
        const record = this.getActiveRecord();
        if (record) void this.review.createCellFromAnnotation(record.annotationId);
        else new Notice(t("notice.placeCursor"));
      }
    });
    this.addCommand({
      id: "review-due-cells",
      name: t("cmd.reviewDue"),
      callback: () => void this.review.reviewDueCells()
    });
    this.addCommand({
      id: "weakness-training",
      name: t("cmd.weaknessTraining"),
      callback: () => void this.review.generateWeaknessTraining()
    });
    this.addCommand({
      id: "refresh-learning-summary",
      name: t("cmd.learningSummary"),
      callback: () => void this.review.refreshLearningSummary()
    });
    this.addCommand({
      id: "strength-reinforcement",
      name: t("cmd.strengthReinforcement"),
      callback: () => void this.review.generateStrengthReinforcement()
    });
    this.addCommand({
      id: "refresh-study-plan",
      name: t("cmd.studyPlan"),
      callback: () => void this.review.refreshStudyPlan()
    });
    this.addCommand({
      id: "install-builtin-commands",
      name: t("cmd.installBuiltin"),
      callback: () => void this.installBuiltinCommands()
    });
    this.addCommand({
      id: "import-zotero-csl",
      name: t("cmd.importZotero"),
      callback: () => this.openZoteroImportModal()
    });
    this.addCommand({
      id: "find-paper-pdf",
      name: t("cmd.findPaper"),
      callback: () => this.openFindPaperModal()
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
    const file = view.file;
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
    menu.addItem((item) =>
      item
        .setTitle(t("menu.translate"))
        .setIcon("languages")
        .onClick(() =>
          void this.translation.translateReadingSelection(file, selection)
        )
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
        this.learnerProfileSummary(),
        this.activeSceneSummary()
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
          // Capture a memory cell automatically (no extra model call), then a
          // single rebuild picks up the review, the cell, and any new scene.
          await this.review.autoSaveCellFromReview(record, outcome.reviewText);
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

  /** Run one one-shot text generation through the configured review engine. */
  private async captureText(
    prompt: string,
    timeoutMs: number
  ): Promise<ReviewOutcome> {
    return this.settings.reviewEngine === "api"
      ? this.captureApiReview(prompt, timeoutMs)
      : this.captureOpenCodeReview(prompt, timeoutMs);
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
          this.activeRailSkin(),
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
      const parsed = resolveEdit(turn.text);
      agentText = parsed.explanation || turn.text;
      if (parsed.edit && target) {
        // A fallback block (no edit markers) is always an insert, so a generated
        // table/diagram is added rather than overwriting the annotated span.
        const captured = parsed.isInsert
          ? { ...target, hasSelection: false, original: "" }
          : target;
        const before = captured.hasSelection ? captured.original : "";
        const replacement = parsed.edit;
        const diff = before
          ? lineDiff(before, replacement)
          : replacement.split(/\r?\n/).map((line) => `+ ${line}`).join("\n");
        agentText = parsed.isInsert ? turn.text : parsed.explanation || t("chat.edit.proposed");
        edit = { diff, text: replacement, apply: () => this.applyNoteEdit(captured, replacement) };
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
    const scenes = this.activeSceneSummary();
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
        ...(scenes
          ? [`The learner's active study scenes:\n"""\n${scenes}\n"""`]
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
      // each. The highlighted span itself is the comment toggle; a glyph is added
      // only when there is no highlight to click (or it could not be applied).
      for (const record of blockRecords) {
        if (el.querySelector(`[data-atl-id="${record.annotationId}"]`)) continue;
        const underlined =
          cls && record.selectedText
            ? highlightFirst(el, record.selectedText, cls, record.annotationId, (id, anchor) =>
                void this.openInlineNote(id, anchor)
              )
            : false;
        if (!underlined && (this.settings.showMarker || cls !== null)) {
          this.appendReadingMarker(el, record.annotationId);
        }
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
    this.review.refreshBadge();
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

  public async archiveScene(sceneId: string): Promise<void> {
    const result = await this.store.archiveScene(sceneId);
    new Notice(result ? t("notice.sceneArchived") : t("notice.sceneArchiveFailed"));
    await this.rebuildIndex(false);
  }

  public async deleteProfileClaim(
    kind: ProfileKind,
    claimIndex: number
  ): Promise<void> {
    const result = await this.store.deleteProfileClaim(kind, claimIndex);
    new Notice(result ? t("notice.claimDeleted") : t("notice.claimDeleteFailed"));
    await this.rebuildIndex(false);
  }

  /**
   * Create a hand-authored scene from the settings form. Returns the new scene
   * id on success, or null when the title has no id-safe characters or a scene
   * with that id already exists (so the caller can surface a validation error
   * instead of silently overwriting).
   */
  public async createScene(input: {
    title: string;
    type: SceneType;
    summary: string;
    cells: string[];
  }): Promise<string | null> {
    const title = input.title.trim();
    const summary = input.summary.trim();
    if (!title || !summary) return null;
    const id = sceneIdFromTitle(title);
    if (this.librarySnapshot.scenes.some((scene) => scene.id === id)) {
      return null;
    }
    const now = nowIso();
    const scene: Scene = {
      id,
      type: input.type,
      title,
      status: "active",
      summary,
      cells: input.cells,
      tags: [],
      createdAt: now,
      updatedAt: now
    };
    await this.store.createScene(scene);
    new Notice(t("notice.sceneCreated"));
    await this.rebuildIndex(false);
    return id;
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
    const sceneSummary = this.activeSceneSummary();
    return {
      notePath: view.file.path,
      noteTitle: view.file.basename,
      selection,
      content: await this.noteContent(view.file.path),
      ...(profileSummary ? { profileSummary } : {}),
      ...(sceneSummary ? { sceneSummary } : {})
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
    // Once the agent has written claims, trust its summary; until then the stored
    // summary is just the init placeholder, so derive one from the learner's cells
    // instead — useful context, and never the meaningless default.
    const base =
      profile && profile.claims.length > 0
        ? (profile.summary?.trim() ?? "")
        : deriveProfileSummary(this.librarySnapshot.cells);
    // Ground that prose in measured mastery (SM-2): what the learner has actually
    // retained vs. what still needs work, misconceptions first — regardless of
    // whether the agent has written any claims yet (P3 closed-loop calibration).
    const mastery = summarizeMastery(
      deriveMasterySnapshot(this.librarySnapshot.cells)
    );
    const summary = [base, mastery].filter((part) => part.trim()).join(" ");
    if (!summary) return "";
    return summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
  }

  /**
   * A short, deterministic summary of the learner's active study scenes (drawn
   * from the library snapshot). Names each active scene with its type and cell
   * count. Gated behind `injectSceneContext`; returns "" when the toggle is off or
   * there are no active scenes, so callers can omit the block. Capped at 600 chars.
   */
  public activeSceneSummary(): string {
    if (!this.settings.injectSceneContext) return "";
    const active = this.librarySnapshot.scenes
      .filter((scene) => scene.status === "active")
      .sort(
        (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
      );
    if (active.length === 0) return "";
    const summary = active
      .slice(0, 8)
      .map((scene) => `${scene.title} (${scene.type}, ${scene.cells.length} cells)`)
      .join("; ");
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
      // Insert at the cursor. Pad block content (tables, Mermaid, code fences)
      // with surrounding blank lines so it isn't glued to the adjacent text and
      // actually renders.
      const doc = editor.getValue();
      const offset = editor.posToOffset(target.from);
      const padded = padBlockInsertion(doc.slice(0, offset), doc.slice(offset), newText);
      editor.replaceRange(padded, target.from);
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

  /** Spawn a persistent OpenCode ACP session for the chat. */
  public async startChatSession(handlers: {
    onUpdate: (event: AcpStreamEvent) => void;
    onExit: (reason: string) => void;
  }): Promise<AcpSessionHandle> {
    // Learners paste MCP server configs straight from docs/other tools; parse
    // failures must not block the session, just warn.
    const rawMcp = this.settings.mcpServersJson.trim();
    const parsed: McpParseResult = rawMcp
      ? parseMcpConfig(rawMcp)
      : { ok: true, servers: [] };
    if (!parsed.ok) new Notice(t("notice.mcpConfigError", { detail: parsed.error }));
    else if (parsed.dropped?.length) {
      // Parsed, but some named entries were unusable (HTTP-only, missing or
      // unsafe command); name them so the drop isn't silent.
      new Notice(t("notice.mcpConfigError", { detail: parsed.dropped.join(", ") }));
    }
    return startAcpSession({
      command: this.settings.agentCommand.trim() || "opencode",
      model: this.settings.agentModel,
      cwd: this.vaultBasePath() ?? tmpdir(),
      mcpServers: parsed.ok ? parsed.servers : [],
      requestPermission: (tool) => this.askAgentPermission(tool),
      onUpdate: handlers.onUpdate,
      onExit: handlers.onExit,
      readFile: (path) => this.readVaultFileForAgent(path),
      startTimeoutMs: Math.max(60000, this.settings.agentTimeoutSeconds * 1000)
    });
  }

  /**
   * Resolve an agent write/execute permission request per the configured
   * policy. Read-only kinds never reach this callback (auto-allowed upstream).
   */
  private askAgentPermission(tool: {
    kind?: string;
    title?: string;
  }): Promise<PermissionChoice> {
    const policy = this.settings.agentPermissionPolicy;
    if (policy === "auto") return Promise.resolve("allow_once");
    if (policy === "readonly") return Promise.resolve("reject_once");
    const name = (tool.title ?? tool.kind ?? "").trim().toLowerCase();
    const always = this.settings.alwaysAllowTools.some((allowed) => {
      const item = allowed.trim().toLowerCase();
      if (item === "") return false;
      // Exact entries always count; substring matching needs a reasonably
      // specific entry so a stray "e" can't whitelist every tool.
      return name === item || (item.length >= 4 && name.includes(item));
    });
    if (always) return Promise.resolve("allow_once");
    return new Promise((resolve) => openPermissionModal(this.app, tool, resolve));
  }

  // --- P2/P3 entry points -----------------------------------------------------

  /** Capture notes (web selection, Zotero import) live beside the agent inbox. */
  private captureDir(): string {
    return `${this.store.memoryRoot()}/captures`;
  }

  /** Recursive folder creation; Obsidian only creates one level per call. */
  private async ensureVaultFolder(folder: string): Promise<void> {
    const path = normalizePath(folder);
    if (!path || path === "." || path === "/") return;
    // Ask the adapter, not the file index: dot-folders such as `.opencode` are
    // excluded from the index, so getAbstractFileByPath() reports them missing
    // forever and createFolder() then throws "already exists" on every call.
    if (await this.app.vault.adapter.exists(path)) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent) await this.ensureVaultFolder(parent);
    try {
      await this.app.vault.createFolder(path);
    } catch {
      // A concurrent writer may have created it already; safe to continue.
    }
  }

  /** Create a note under `folder`, bumping the stem when the name is taken. */
  private async createVaultNote(
    folder: string,
    stem: string,
    content: string
  ): Promise<TFile> {
    await this.ensureVaultFolder(folder);
    // Check-then-create can race (agent writes, two quick captures); on a
    // collision retry with a bumped counter instead of surfacing the error.
    let path = normalizePath(`${folder}/${stem}.md`);
    let counter = 1;
    for (;;) {
      try {
        return await this.app.vault.create(path, content);
      } catch (error) {
        if (counter >= 25 || !String(error).toLowerCase().includes("exists")) {
          throw error;
        }
        path = normalizePath(`${folder}/${stem} ${counter}.md`);
        counter += 1;
      }
    }
  }

  /** Install bundled OpenCode slash commands (excalidraw-diagram) into the Vault. */
  private async installBuiltinCommands(): Promise<void> {
    let installed = 0;
    let skipped = 0;
    let failed = 0;
    for (const command of BUILTIN_COMMANDS) {
      const path = normalizePath(`${BUILTIN_COMMAND_DIR}/${command.name}.md`);
      // `.opencode` never enters the file index (see ensureVaultFolder), so the
      // index-based check always said "missing" and every install retried a
      // create that could only fail.
      if (await this.app.vault.adapter.exists(path)) {
        skipped += 1;
        continue;
      }
      try {
        await this.ensureVaultFolder(BUILTIN_COMMAND_DIR);
        await this.app.vault.create(path, builtinCommandFile(command));
        installed += 1;
      } catch {
        // One unwritable command must not hide the others: keep going and report
        // the tally once, so a partial install is visible instead of silent.
        failed += 1;
      }
    }
    new Notice(t("notice.builtinInstalled", { installed, skipped }));
    if (failed > 0) new Notice(t("notice.writeFailed"));
  }

  /** A block id the capture note's quote can anchor to. */
  private captureBlockId(): string {
    return `cap-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Where web captures are written: the configured override, else the default. */
  private webCaptureDir(): string {
    const override = this.settings.webCaptureDir.trim();
    return override ? normalizePath(override) : this.captureDir();
  }

  /** The default capture folder, shown as the settings placeholder. */
  public defaultCaptureDir(): string {
    return this.captureDir();
  }

  /**
   * Handle an obsidian:// selection capture: decode + validate the base64url
   * payload, write the note, then open it. Invalid payloads are ignored beyond
   * a notice — the URI is attacker-reachable, so a bad decode must never throw.
   */
  private async receiveWebCapture(encoded: string): Promise<void> {
    const payload = decodeCapturePayload(encoded);
    if (!payload) {
      new Notice(t("notice.webCaptureInvalid"));
      return;
    }
    try {
      const file =
        payload.kind === "selection"
          ? await this.createWebSelectionCapture(payload)
          : await this.createWebPageCapture(payload);
      new Notice(t("notice.captureSaved", { path: file.path }));
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch {
      new Notice(t("notice.writeFailed"));
    }
  }

  /** Write a selection capture note (reuses the shared capture folder + stem). */
  private async createWebSelectionCapture(payload: CapturePayload): Promise<TFile> {
    const stem = captureNoteStem({
      selection: payload.selections?.[0]?.exact ?? payload.title,
      title: payload.title,
      url: payload.url,
      capturedAt: payload.capturedAt
    });
    return this.createVaultNote(
      this.webCaptureDir(),
      stem,
      buildSelectionCaptureNote(payload, this.captureBlockId())
    );
  }

  /**
   * Archive a full page: one Markdown note plus up to two raw-HTML siblings
   * (rendered DOM, server source) under `_raw/`. The note is reserved first so
   * the siblings can share its final stem even if a same-day capture bumped it.
   */
  private async createWebPageCapture(payload: CapturePayload): Promise<TFile> {
    const dir = this.webCaptureDir();
    const stem = captureNoteStem({
      selection: payload.title || payload.url,
      title: payload.title,
      url: payload.url,
      capturedAt: payload.capturedAt
    });
    const file = await this.createVaultNote(dir, stem, "");
    const finalStem = file.basename;
    const rawDir = normalizePath(`${dir}/_raw`);
    const raw: { rendered?: string; source?: string } = {};
    if (this.settings.webSaveRenderedHtml && payload.renderedHtml) {
      await this.writeRawHtml(rawDir, `${finalStem}.rendered.html`, payload.renderedHtml);
      raw.rendered = `_raw/${finalStem}.rendered.html`;
    }
    if (this.settings.webSaveSourceHtml && payload.sourceHtml) {
      await this.writeRawHtml(rawDir, `${finalStem}.source.html`, payload.sourceHtml);
      raw.source = `_raw/${finalStem}.source.html`;
    }
    // Drop the Markdown body when auto-convert is off (archive HTML only), but
    // keep frontmatter + raw links so the page still appears in usage stats.
    const forNote = this.settings.webAutoConvertMarkdown
      ? payload
      : { ...payload, markdown: "" };
    await this.app.vault.modify(file, buildPageCaptureNote(forNote, raw));
    return file;
  }

  /** Write a raw-HTML sibling via the adapter (not indexed as a note). */
  private async writeRawHtml(dir: string, name: string, html: string): Promise<void> {
    await this.ensureVaultFolder(dir);
    await this.app.vault.adapter.write(normalizePath(`${dir}/${name}`), html);
  }

  private newToken(): string {
    try {
      return crypto.randomUUID();
    } catch {
      // Runtimes without randomUUID: two random base-36 segments. The token
      // only gates a localhost port on the same machine, not a secret store.
      return `${Math.random().toString(36).slice(2)}${Math.random()
        .toString(36)
        .slice(2)}`;
    }
  }

  private ensureWebBridgeToken(): string {
    if (!this.settings.webBridgeToken) this.settings.webBridgeToken = this.newToken();
    return this.settings.webBridgeToken;
  }

  /** Rotate the bridge token; the caller persists + restarts the server. */
  public regenerateWebToken(): void {
    this.settings.webBridgeToken = this.newToken();
  }

  /**
   * (Re)build the localhost bridge from current settings — stop any running
   * server first so an enable/port/token change takes effect cleanly. A bind
   * failure (port in use) surfaces a notice and leaves the bridge off.
   */
  public async applyWebBridge(): Promise<void> {
    if (this.webBridge) {
      await this.webBridge.stop();
      this.webBridge = null;
    }
    if (!this.settings.webEnabled) return;
    const token = this.ensureWebBridgeToken();
    await this.persistSettings();
    const server = new WebBridgeServer({
      port: this.settings.webBridgePort,
      token,
      onCapture: (payload) => this.onBridgeCapture(payload),
      onError: (error) => console.error("[atl web-bridge]", error)
    });
    try {
      await server.start();
      this.webBridge = server;
    } catch {
      new Notice(
        t("notice.webBridgeFailed", { port: String(this.settings.webBridgePort) })
      );
    }
  }

  private async onBridgeCapture(payload: CapturePayload): Promise<void> {
    const file =
      payload.kind === "selection"
        ? await this.createWebSelectionCapture(payload)
        : await this.createWebPageCapture(payload);
    new Notice(t("notice.captureSaved", { path: file.path }));
  }

  /**
   * The bundled Web Clipper extension folder, shipped inside the plugin at
   * `<plugin>/web-clipper` so it can be loaded unpacked until a store listing
   * exists. Null on mobile (no real filesystem) or when the plugin dir is
   * unknown — callers then fall back to a "not bundled" hint.
   */
  public webClipperExtensionDir(): string | null {
    const adapter = this.app.vault.adapter;
    const dir = this.manifest.dir;
    if (!(adapter instanceof FileSystemAdapter) || !dir) return null;
    return adapter.getFullPath(normalizePath(`${dir}/web-clipper`));
  }

  /**
   * Open the bundled extension folder in the OS file manager (desktop only) so
   * the user can point "Load unpacked" at it. Returns false when the folder
   * can't be resolved or the shell refused to open it.
   */
  public async openWebClipperExtensionDir(): Promise<boolean> {
    const full = this.webClipperExtensionDir();
    if (!full) return false;
    const electron = require("electron") as {
      shell?: { openPath?: (target: string) => Promise<string> };
    };
    const openPath = electron.shell?.openPath;
    if (!openPath) return false;
    // openPath resolves to "" on success, or an error message string.
    return (await openPath(full)) === "";
  }

  /** Aggregate the Web Clipper usage overview from capture notes in the vault. */
  public webUsageStats(): WebStats {
    const dir = normalizePath(this.webCaptureDir());
    const metas: WebCaptureMeta[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.parent?.path !== dir) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm || fm["type"] !== "web-capture") continue;
      let selections = 0;
      for (const id of Object.keys(cache?.blocks ?? {})) {
        if (id.startsWith("cap-")) selections += 1;
      }
      const meta: WebCaptureMeta = { path: file.path, selections };
      if (typeof fm["title"] === "string") meta.title = fm["title"];
      if (typeof fm["source-url"] === "string") meta.url = fm["source-url"];
      if (typeof fm["captured-at"] === "string") meta.capturedAt = fm["captured-at"];
      metas.push(meta);
    }
    return aggregateWebStats(metas);
  }

  /** On first sidebar open, offer to install the Web Clipper unless dismissed. */
  public maybeShowWebInstallPrompt(): void {
    if (this.webPromptShown) return;
    if (this.settings.webEnabled || this.settings.webInstallPromptDismissed) return;
    this.webPromptShown = true;
    const plugin = this;
    new (class extends Modal {
      public override onOpen(): void {
        this.titleEl.setText(t("web.prompt.title"));
        this.contentEl.createEl("p", { text: t("web.prompt.body") });
        const row = this.contentEl.createDiv({ cls: "atl-actions" });
        const install = row.createEl("button", {
          text: t("web.prompt.install"),
          cls: "mod-cta"
        });
        install.onclick = () => {
          plugin.openSettings();
          this.close();
        };
        const dismiss = row.createEl("button", { text: t("web.prompt.dismiss") });
        dismiss.onclick = () => {
          plugin.settings.webInstallPromptDismissed = true;
          void plugin.persistSettings();
          this.close();
        };
      }
      public override onClose(): void {
        this.contentEl.empty();
      }
    })(this.app).open();
  }

  /** Paste-a-CSL-JSON modal feeding importZoteroEntries. */
  private openZoteroImportModal(): void {
    const plugin = this;
    const modal = new (class extends Modal {
      public override onOpen(): void {
        this.contentEl.empty();
        this.titleEl.setText(t("zotero.title"));
        this.contentEl.createEl("p", { text: t("zotero.hint") });
        const area = this.contentEl.createEl("textarea", {
          cls: "atl-zotero-input"
        });
        area.placeholder =
          '[{ "title": "...", "author": [{ "family": "...", "given": "..." }] }]';
        const actions = this.contentEl.createDiv({ cls: "atl-zotero-actions" });
        const button = actions.createEl("button", {
          cls: "mod-cta",
          text: t("zotero.import")
        });
        button.onclick = async () => {
          const result = parseImport(area.value);
          if (!result.ok) {
            new Notice(t("zotero.parseError"));
            return;
          }
          try {
            await plugin.importZoteroEntries(result.entries);
          } catch {
            // Keep the modal open so the pasted export isn't lost.
            new Notice(t("notice.writeFailed"));
            return;
          }
          this.close();
        };
      }
    })(this.app);
    modal.open();
  }

  /** One capture note per imported entry, then open the first one. */
  public async importZoteroEntries(entries: ZoteroEntry[]): Promise<void> {
    const capturedAt = nowIso();
    let first: TFile | null = null;
    for (const entry of entries) {
      const stem = captureNoteStem({
        selection: entry.title,
        title: entry.title,
        capturedAt
      });
      const file = await this.createVaultNote(
        this.captureDir(),
        stem,
        zoteroCaptureNote(entry, capturedAt, this.captureBlockId())
      );
      first ??= file;
    }
    new Notice(t("zotero.done", { count: entries.length }));
    if (first) await this.app.workspace.getLeaf(false).openFile(first);
  }

  /**
   * Keyword search over the Vault's PDFs and capture notes — the local half of
   * paper discovery. Matches are ranked by keyword overlap; clicking one opens
   * it (Obsidian renders PDFs natively; the Excalidraw/reader plugins take
   * over when installed).
   */
  public findPapers(query: string): Array<{
    path: string;
    label: string;
    icon: string;
  }> {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 2);
    if (words.length === 0) return [];
    const captureRoot = normalizePath(this.captureDir());
    const scored: Array<{
      path: string;
      label: string;
      icon: string;
      score: number;
    }> = [];
    for (const file of this.app.vault.getFiles()) {
      const isPdf = file.extension === "pdf";
      const isCapture =
        file.extension === "md" && file.parent?.path === captureRoot;
      if (!isPdf && !isCapture) continue;
      const hay = file.path.toLowerCase();
      let score = 0;
      for (const word of words) if (hay.includes(word)) score += 1;
      if (score > 0) {
        scored.push({
          path: file.path,
          label: file.name,
          icon: isPdf ? "file-text" : "sticky-note",
          score
        });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    return scored.slice(0, 10);
  }

  public async openPaper(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  /** Live-filtering search modal feeding findPapers/openPaper. */
  private openFindPaperModal(): void {
    const plugin = this;
    const modal = new (class extends Modal {
      // Held on the instance so onClose can cancel a scan still pending after the
      // learner closes the modal (otherwise it fires into a detached results el).
      private timer: number | undefined;
      public override onOpen(): void {
        this.contentEl.empty();
        this.titleEl.setText(t("findPaper.title"));
        const input = this.contentEl.createEl("input", {
          cls: "atl-findpaper-input"
        });
        input.placeholder = t("findPaper.placeholder");
        const results = this.contentEl.createDiv({
          cls: "atl-findpaper-results"
        });
        // Debounce: large vaults scan thousands of files per keystroke.
        const search = (): void => {
          window.clearTimeout(this.timer);
          this.timer = window.setTimeout(() => {
            results.empty();
            const matches = plugin.findPapers(input.value);
            if (input.value.trim() === "") return;
            if (matches.length === 0) {
              results.createEl("p", {
                cls: "atl-muted",
                text: t("findPaper.noResults")
              });
              return;
            }
            for (const match of matches) {
              const row = results.createDiv({ cls: "atl-findpaper-item" });
              setIcon(row.createSpan({ cls: "atl-findpaper-icon" }), match.icon);
              row.createSpan({ cls: "atl-findpaper-name", text: match.label });
              row.onclick = () => {
                this.close();
                void plugin.openPaper(match.path);
              };
            }
          }, 120);
        };
        input.addEventListener("input", search);
        input.focus();
      }
      public override onClose(): void {
        window.clearTimeout(this.timer);
        this.contentEl.empty();
      }
    })(this.app);
    modal.open();
  }

  /**
   * Excalidraw guard: repair LLM-generated drawing JSON in place. Work is
   * serialized per path so back-to-back writes can't race (read stale content
   * → overwrite newer content), and reads go through vault.read because
   * OpenCode's write tools bypass the Obsidian API and the cache may lag
   * behind disk. Repair failures are swallowed — a guardrail must never break
   * the save flow.
   */
  private async sanitizeExcalidrawFile(file: unknown): Promise<void> {
    if (!this.settings.excalidrawAssist) return;
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const path = file.path;
    const run = (this.excalidrawQueue.get(path) ?? Promise.resolve()).then(
      async () => {
        const content = await this.app.vault.read(file);
        if (!isExcalidrawDoc(content)) return;
        const repaired = sanitizeExcalidrawDoc(content);
        if (repaired === null || !repaired.repaired) return;
        await this.app.vault.modify(file, repaired.content);
      }
    );
    const chained = run.catch(() => undefined);
    this.excalidrawQueue.set(path, chained);
    void chained.then(() => {
      if (this.excalidrawQueue.get(path) === chained) {
        this.excalidrawQueue.delete(path);
      }
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
    // The Vault root holds `.obsidian`, and its data.json carries the plugin's
    // API key. The path is inside the Vault, so the escape guard above lets it
    // through; refuse the config dir explicitly so a prompt-injected read can't
    // exfiltrate secrets.
    if (rel.split(/[\\/]/)[0] === ".obsidian") return null;
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
          skin: this.activeRailSkin(),
          marginHideLink: this.settings.marginHideLink,
          inlineReview: this.settings.inlineReview
        })
      });
    }
    if (view.getMode() === "preview" && this.settings.marginComments) {
      this.readingRail.attach(view);
      this.readingRail.setMarks(
        marks,
        this.activeRailSkin(),
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

