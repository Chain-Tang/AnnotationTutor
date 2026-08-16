// Settings data + migration, free of any runtime imports so it can be unit
// tested without an Obsidian runtime. The SettingTab UI lives in settings.ts.

import { normalizeHighlightColor } from "./highlight-color.js";

/** How annotated source text is styled in the editor. */
export type HighlightStyle =
  | "dotted-underline"
  | "wavy-underline"
  | "background"
  | "bold"
  | "none";

export type MemoryWriteMode = "direct" | "confirmation";

/**
 * Persisted per-margin-card geometry: drag offset, any user-resized size, and `s`
 * — the CTRL+scroll text zoom scale (1 = default), so a card keeps its zoom too.
 */
export type CardGeom = { dx: number; dy: number; w?: number; h?: number; s?: number };

/** Which engine produces reviews: a direct HTTPS API, or the OpenCode CLI. */
export type ReviewEngine = "api" | "opencode";

export const reviewEngines: readonly ReviewEngine[] = ["api", "opencode"];

/**
 * How the chat answers agent write/execute permission prompts (OpenCode only).
 * readonly = decline everything but reads (the old behavior); ask = show a
 * confirmation dialog per prompt; auto = allow without asking.
 */
export type AgentPermissionPolicy = "readonly" | "ask" | "auto";

export const agentPermissionPolicies: readonly AgentPermissionPolicy[] = [
  "readonly",
  "ask",
  "auto"
];

export type PluginLanguage = "auto" | "en" | "zh-cn" | "zh-tw" | "ja";

export const pluginLanguages: readonly PluginLanguage[] = [
  "auto",
  "en",
  "zh-cn",
  "zh-tw",
  "ja"
];

export const highlightStyles: readonly HighlightStyle[] = [
  "dotted-underline",
  "wavy-underline",
  "background",
  "bold",
  "none"
];

export const HIGHLIGHT_LABELS: Record<HighlightStyle, string> = {
  "dotted-underline": "Dotted underline",
  "wavy-underline": "Wavy underline",
  background: "Background tint",
  bold: "Bold",
  none: "None"
};

export type AnnotationTutorLiteSettings = {
  language: PluginLanguage;
  memoryRoot: string;
  useBlockAnchors: boolean;
  highlightStyle: HighlightStyle;
  /**
   * Color for the annotation highlight (underline/bold tint, and a translucent
   * background-tint fill). Empty follows the theme accent (`var(--text-accent)`);
   * a hex string (e.g. `#7c3aed`) is a custom color the learner picked.
   */
  highlightColor: string;
  showMarker: boolean;
  marginComments: boolean;
  /**
   * Which card skin the margin cards wear: a built-in id ("flat" | "paper" |
   * "sticky" | "leaf") or a user skin id discovered from the plugin's skins
   * folder. "flat" is the classic bordered card. Replaces the old `marginPaper`
   * boolean (paper migrated to "paper").
   */
  cardSkin: string;
  marginHideLink: boolean;
  inlineReview: boolean;
  watchMemoryFiles: boolean;
  autoRefreshOnAgentWrite: boolean;
  createAgentInstructions: boolean;
  memoryWriteMode: MemoryWriteMode;
  allowPreferenceWrites: boolean;
  /** Inject a summary of the learner's active study scenes into review/chat/dialogue prompts. */
  injectSceneContext: boolean;
  autoRunAgent: boolean;
  /** Which engine generates reviews: a direct HTTPS API call or the OpenCode CLI. */
  reviewEngine: ReviewEngine;
  /** OpenAI-compatible base URL (before /chat/completions), e.g. https://api.deepseek.com/v1. */
  apiBaseUrl: string;
  /** API key for the review endpoint. Stored in this Vault's plugin data. */
  apiKey: string;
  /** Model id for the API engine, e.g. deepseek-chat. */
  apiModel: string;
  agentCommand: string;
  /**
   * Full PATH captured from the user's login shell by "Set up OpenCode", reused
   * for every CLI spawn so a GUI-launched Obsidian (esp. macOS from Finder/Dock)
   * resolves OpenCode and its runtime the same way a terminal would. Empty = none.
   */
  agentShellPath: string;
  agentModel: string;
  /** Which engine the tutor chat prefers. OpenCode can read the Vault directly. */
  chatEngine: ReviewEngine;
  /** Persist the tutor chat as one Markdown file per session under `<memoryRoot>/chats/`. */
  persistChatLog: boolean;
  /** How many saved chat sessions to keep (the oldest is pruned on each save). */
  chatLogKeepSessions: number;
  /** Optional second model tried once if the primary returns an empty review. */
  agentFallbackModel: string;
  agentTimeoutSeconds: number;
  /** Language for agent review content. Empty = match the learner's note. */
  reviewLanguage: string;
  /**
   * Native language for the Alt+T inline dictionary. Words foreign to it are
   * glossed after the text. Empty = follow the plugin display language.
   */
  dictionaryLanguage: string;
  /**
   * Pre-translate a document into a cached glossary when it opens, so Alt+T can
   * gloss a selection instantly. The live translation stays as a fallback for
   * words the pre-pass missed.
   */
  pretranslateOnOpen: boolean;
  /**
   * Max characters of source text sent per pre-translation model call. Larger =
   * fewer calls and more context per call (a short document becomes a single
   * call); too large risks the model truncating its glossary OUTPUT (the limit is
   * output length, not input context). Oversized paragraphs are still sliced.
   */
  pretranslateChunkChars: number;
  /**
   * Opt-in learning-feedback mechanisms, all OFF by default (the learner activates
   * them). `enableSpacedReview` surfaces the SM-2 due queue + review command;
   * the rest gate agent-assisted feedback commands.
   */
  enableSpacedReview: boolean;
  enableWeaknessTraining: boolean;
  enableLearningSummary: boolean;
  enableStrengthReinforcement: boolean;
  /** Write a deterministic self-regulated study plan (goals + due reviews) to a doc. */
  enableStudyPlan: boolean;
  /**
   * Stdio MCP servers for the OpenCode chat session, as canonical JSON
   * (`{mcpServers: {...}}`). Empty = none. Parsed/normalized by mcp-config.ts.
   */
  mcpServersJson: string;
  /** How write/execute permission prompts are answered in the tutor chat. */
  agentPermissionPolicy: AgentPermissionPolicy;
  /** Tool titles the learner chose "always allow" for; auto-allowed in ask mode. */
  alwaysAllowTools: string[];
  /** Master switch for the external Web Clipper bridge (localhost server + URI intake). */
  webEnabled: boolean;
  /** Loopback port the page-archive bridge listens on (127.0.0.1). */
  webBridgePort: number;
  /** Shared secret the browser extension sends as a Bearer token; empty until generated. */
  webBridgeToken: string;
  /** Capture-folder override; empty follows `${memoryRoot}/captures`. */
  webCaptureDir: string;
  /** Convert captured pages to Markdown (off = archive HTML only, empty note body). */
  webAutoConvertMarkdown: boolean;
  /** Store the rendered-DOM HTML sibling for archived pages. */
  webSaveRenderedHtml: boolean;
  /** Store the server-source HTML sibling for archived pages. */
  webSaveSourceHtml: boolean;
  /** The learner dismissed the "install the Web Clipper" prompt. */
  webInstallPromptDismissed: boolean;
  /** Offer to repair + open agent-generated Excalidraw notes as drawings. */
  excalidrawAssist: boolean;
  /** Per-annotation margin-card geometry, so each card keeps its own size/place. */
  cardGeom: Record<string, CardGeom>;
};

/** Lower bound for the agent run timeout, in seconds. */
export const MIN_AGENT_TIMEOUT_SECONDS = 30;

/** Lower bound for the pre-translation chunk size, in characters. */
export const MIN_PRETRANSLATE_CHUNK_CHARS = 800;

/** Lower bound for how many saved chat sessions are kept before pruning. */
export const MIN_CHAT_LOG_KEEP_SESSIONS = 1;

export const DEFAULT_SETTINGS: AnnotationTutorLiteSettings = {
  language: "auto",
  memoryRoot: "Agent Memory",
  useBlockAnchors: true,
  highlightStyle: "dotted-underline",
  highlightColor: "",
  showMarker: true,
  marginComments: true,
  cardSkin: "flat",
  marginHideLink: false,
  inlineReview: true,
  watchMemoryFiles: true,
  autoRefreshOnAgentWrite: true,
  createAgentInstructions: true,
  memoryWriteMode: "direct",
  allowPreferenceWrites: false,
  injectSceneContext: false,
  autoRunAgent: false,
  reviewEngine: "api",
  apiBaseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  apiModel: "deepseek-chat",
  agentCommand: "opencode",
  agentShellPath: "",
  agentModel: "opencode/mimo-v2.5-free",
  chatEngine: "opencode",
  persistChatLog: true,
  chatLogKeepSessions: 30,
  agentFallbackModel: "",
  agentTimeoutSeconds: 240,
  reviewLanguage: "",
  dictionaryLanguage: "",
  pretranslateOnOpen: true,
  pretranslateChunkChars: 3000,
  enableSpacedReview: false,
  enableWeaknessTraining: false,
  enableLearningSummary: false,
  enableStrengthReinforcement: false,
  enableStudyPlan: false,
  mcpServersJson: "",
  agentPermissionPolicy: "ask",
  alwaysAllowTools: [],
  webEnabled: false,
  webBridgePort: 51256,
  webBridgeToken: "",
  webCaptureDir: "",
  webAutoConvertMarkdown: true,
  webSaveRenderedHtml: true,
  webSaveSourceHtml: true,
  webInstallPromptDismissed: false,
  excalidrawAssist: true,
  cardGeom: {}
};

export function normalizeMemoryRoot(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === ".") ||
    normalized.toLowerCase() === ".obsidian" ||
    normalized.toLowerCase().startsWith(".obsidian/")
  ) {
    return DEFAULT_SETTINGS.memoryRoot;
  }
  return normalized.replace(/\/$/, "");
}

/**
 * Merge persisted data over the defaults, migrating the old boolean
 * `highlightAnnotations` toggle to the new `highlightStyle` enum. Pure, so it is
 * unit-testable without an Obsidian runtime.
 */
export function migrateSettings(loaded: unknown): AnnotationTutorLiteSettings {
  const data =
    loaded && typeof loaded === "object"
      ? (loaded as Record<string, unknown>)
      : {};
  const settings: AnnotationTutorLiteSettings = {
    ...DEFAULT_SETTINGS,
    ...(data as Partial<AnnotationTutorLiteSettings>)
  };
  if (!("highlightStyle" in data) && "highlightAnnotations" in data) {
    settings.highlightStyle = data.highlightAnnotations
      ? "dotted-underline"
      : "none";
  }
  if (!highlightStyles.includes(settings.highlightStyle)) {
    settings.highlightStyle = DEFAULT_SETTINGS.highlightStyle;
  }
  // Fold the retired `marginPaper` boolean into the new `cardSkin` picker: an
  // explicit `cardSkin` wins; otherwise paper-on migrates to the "paper" skin.
  if (!("cardSkin" in data) || typeof settings.cardSkin !== "string") {
    settings.cardSkin = (data as { marginPaper?: unknown }).marginPaper === true
      ? "paper"
      : DEFAULT_SETTINGS.cardSkin;
  }
  if (!settings.cardSkin.trim()) settings.cardSkin = DEFAULT_SETTINGS.cardSkin;
  // Drop the legacy key so it is not re-persisted.
  delete (settings as Record<string, unknown>).marginPaper;
  // A valid hex stays (canonicalized); anything else falls back to "" = follow
  // the theme accent.
  settings.highlightColor = normalizeHighlightColor(settings.highlightColor);
  if (
    settings.memoryWriteMode !== "direct" &&
    settings.memoryWriteMode !== "confirmation"
  ) {
    settings.memoryWriteMode = DEFAULT_SETTINGS.memoryWriteMode;
  }
  if (!pluginLanguages.includes(settings.language)) {
    settings.language = DEFAULT_SETTINGS.language;
  }
  if (typeof settings.autoRunAgent !== "boolean") {
    settings.autoRunAgent = DEFAULT_SETTINGS.autoRunAgent;
  }
  if (typeof settings.injectSceneContext !== "boolean") {
    settings.injectSceneContext = DEFAULT_SETTINGS.injectSceneContext;
  }
  if (!reviewEngines.includes(settings.reviewEngine)) {
    settings.reviewEngine = DEFAULT_SETTINGS.reviewEngine;
  }
  if (!reviewEngines.includes(settings.chatEngine)) {
    settings.chatEngine = DEFAULT_SETTINGS.chatEngine;
  }
  if (typeof settings.persistChatLog !== "boolean") {
    settings.persistChatLog = DEFAULT_SETTINGS.persistChatLog;
  }
  if (
    typeof settings.chatLogKeepSessions !== "number" ||
    !Number.isInteger(settings.chatLogKeepSessions) ||
    settings.chatLogKeepSessions < MIN_CHAT_LOG_KEEP_SESSIONS
  ) {
    settings.chatLogKeepSessions = DEFAULT_SETTINGS.chatLogKeepSessions;
  }
  if (typeof settings.apiBaseUrl !== "string" || !settings.apiBaseUrl.trim()) {
    settings.apiBaseUrl = DEFAULT_SETTINGS.apiBaseUrl;
  }
  if (typeof settings.apiKey !== "string") {
    settings.apiKey = DEFAULT_SETTINGS.apiKey;
  }
  if (typeof settings.apiModel !== "string" || !settings.apiModel.trim()) {
    settings.apiModel = DEFAULT_SETTINGS.apiModel;
  }
  if (typeof settings.agentCommand !== "string" || !settings.agentCommand.trim()) {
    settings.agentCommand = DEFAULT_SETTINGS.agentCommand;
  }
  if (typeof settings.agentShellPath !== "string") {
    settings.agentShellPath = DEFAULT_SETTINGS.agentShellPath;
  }
  if (typeof settings.agentModel !== "string") {
    settings.agentModel = DEFAULT_SETTINGS.agentModel;
  }
  if (typeof settings.agentFallbackModel !== "string") {
    settings.agentFallbackModel = DEFAULT_SETTINGS.agentFallbackModel;
  }
  if (typeof settings.reviewLanguage !== "string") {
    settings.reviewLanguage = DEFAULT_SETTINGS.reviewLanguage;
  }
  if (typeof settings.dictionaryLanguage !== "string") {
    settings.dictionaryLanguage = DEFAULT_SETTINGS.dictionaryLanguage;
  }
  if (typeof settings.pretranslateOnOpen !== "boolean") {
    settings.pretranslateOnOpen = DEFAULT_SETTINGS.pretranslateOnOpen;
  }
  for (const flag of [
    "enableSpacedReview",
    "enableWeaknessTraining",
    "enableLearningSummary",
    "enableStrengthReinforcement",
    "enableStudyPlan"
  ] as const) {
    if (typeof settings[flag] !== "boolean") settings[flag] = DEFAULT_SETTINGS[flag];
  }
  if (
    typeof settings.pretranslateChunkChars !== "number" ||
    !Number.isFinite(settings.pretranslateChunkChars) ||
    settings.pretranslateChunkChars < MIN_PRETRANSLATE_CHUNK_CHARS
  ) {
    settings.pretranslateChunkChars = DEFAULT_SETTINGS.pretranslateChunkChars;
  } else {
    settings.pretranslateChunkChars = Math.floor(settings.pretranslateChunkChars);
  }
  if (typeof settings.mcpServersJson !== "string") {
    settings.mcpServersJson = DEFAULT_SETTINGS.mcpServersJson;
  }
  if (!agentPermissionPolicies.includes(settings.agentPermissionPolicy)) {
    settings.agentPermissionPolicy = DEFAULT_SETTINGS.agentPermissionPolicy;
  }
  settings.alwaysAllowTools = Array.isArray(settings.alwaysAllowTools)
    ? settings.alwaysAllowTools.filter((item): item is string => typeof item === "string")
    : [];
  if (typeof settings.webBridgeToken !== "string") {
    settings.webBridgeToken = DEFAULT_SETTINGS.webBridgeToken;
  }
  if (typeof settings.webCaptureDir !== "string") {
    settings.webCaptureDir = DEFAULT_SETTINGS.webCaptureDir;
  }
  for (const flag of [
    "webEnabled",
    "webAutoConvertMarkdown",
    "webSaveRenderedHtml",
    "webSaveSourceHtml",
    "webInstallPromptDismissed"
  ] as const) {
    if (typeof settings[flag] !== "boolean") settings[flag] = DEFAULT_SETTINGS[flag];
  }
  if (
    typeof settings.webBridgePort !== "number" ||
    !Number.isInteger(settings.webBridgePort) ||
    settings.webBridgePort < 1024 ||
    settings.webBridgePort > 65535
  ) {
    settings.webBridgePort = DEFAULT_SETTINGS.webBridgePort;
  }
  if (typeof settings.excalidrawAssist !== "boolean") {
    settings.excalidrawAssist = DEFAULT_SETTINGS.excalidrawAssist;
  }
  // Always clone into a fresh object so we never alias DEFAULT_SETTINGS.cardGeom.
  settings.cardGeom =
    settings.cardGeom &&
    typeof settings.cardGeom === "object" &&
    !Array.isArray(settings.cardGeom)
      ? { ...settings.cardGeom }
      : {};
  if (
    typeof settings.agentTimeoutSeconds !== "number" ||
    !Number.isFinite(settings.agentTimeoutSeconds) ||
    settings.agentTimeoutSeconds < MIN_AGENT_TIMEOUT_SECONDS
  ) {
    settings.agentTimeoutSeconds = DEFAULT_SETTINGS.agentTimeoutSeconds;
  }
  settings.memoryRoot = normalizeMemoryRoot(settings.memoryRoot);
  // Drop the legacy key so it is not re-persisted.
  delete (settings as Record<string, unknown>).highlightAnnotations;
  return settings;
}
