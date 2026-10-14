import { tutorPairingSchema } from "./tutor-grant.js";
import type { TutorPairing } from "./tutor-access.js";
import { normalizeCredentialReferences, type CredentialReferences } from "./credential-types.js";
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

/** Image generation is deliberately independent from review/chat routing. */
export type BoardImageProviderKind = "disabled" | "qwen-compatible" | "openai";
export type BoardImagePromptExtendMode = "direct" | "agent";

export const boardImageProviders: readonly BoardImageProviderKind[] = [
  "disabled",
  "qwen-compatible",
  "openai"
];

/** Qwen's 1K billing tier includes outputs up to 2.25 megapixels. */
export const BOARD_IMAGE_1K_MAX_PIXELS = 2_250_000;
export const BOARD_IMAGE_MIN_PIXELS = 512 * 512;

export function isBoardImage1KSize(width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
  const area = width * height;
  const ratio = width / height;
  return area >= BOARD_IMAGE_MIN_PIXELS && area <= BOARD_IMAGE_1K_MAX_PIXELS && ratio >= 1 / 8 && ratio <= 8;
}

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
  /** Public settings contain these references; resolved credentials are session-only properties. */
  credentialRefs: CredentialReferences;
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
  /** Legacy engine/model values remain available as an independent preset. */
  boardConnectionMode: "inherit" | "custom";
  boardEngine: ReviewEngine;
  boardApiModel: string;
  boardAgentModel: string;
  boardAnimate: boolean;
  /** Optional desktop-only local MCP bridge for the typed BoardToolRuntime. */
  boardMcpEnabled: boolean;
  tutorCodexCommand: string;
  tutorRemoteName:string;
  tutorRemoteUrl:string;
  tutorRemoteToken:string;
  tutorPairings: TutorPairing[];
  tutorSurfaceIds: Record<string,string>;
  /** Expected journal UUID, kept outside state/ so directory loss cannot reset replay protection. Empty only before first binding. */
  surfaceTransactionJournalId:string;
  /** Restricts MCP clients to inspection and rollback; commit/write tools are hidden. */
  boardMcpReadOnly: boolean;
  /** Granted only after the learner accepts the selected-ink upload notice. */
  boardCloudRecognitionConsent: boolean;
  /** Image generation has its own endpoint/key so chat providers need not match it. */
  boardImageProvider: BoardImageProviderKind;
  boardImageBaseUrl: string;
  boardImageApiKey: string;
  /** Explicit opt-in to use the general Direct API key instead of a second stored key. */
  boardImageUseSharedApiKey: boolean;
  boardImageModel: string;
  /** Exact requested output dimensions; Qwen requests remain inside the 1K tier. */
  boardImageWidth: number;
  boardImageHeight: number;
  boardImageCount: number;
  boardImageNegativePrompt: string;
  /** Empty means random. Stored as text so an empty numeric input remains representable. */
  boardImageSeed: string;
  boardImagePromptExtend: boolean;
  boardImagePromptExtendMode: BoardImagePromptExtendMode;
  boardImageThinking: boolean;
  boardImageWatermark: boolean;
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
  learningFlowEnabled: boolean;
  supportCheckinEnabled: boolean;
  learningExpertsEnabled: boolean;
  learningDailyMinutes: number;
  supportRetentionDays: number;
  teachingMode: "auto" | "answer" | "hint" | "coach" | "check";
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
  /** Watch notes created by the official Obsidian Web Clipper Tutor template. */
  webOfficialIntegrationEnabled: boolean;
  /** Last official template version the learner copied/downloaded from Tutor. */
  webOfficialTemplateVersion: string;
  /** AI route used for optional post-capture analysis from the Web Clipper. */
  webEngine: ReviewEngine;
  /** Analyze a saved capture with Tutor after it is safely written to the Vault. */
  webAutoAnalyze: boolean;
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
  /** Custom body template for page-capture notes; empty = the default layout. */
  webPageTemplate: string;
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
  surfaceTransactionJournalId:"",
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
  credentialRefs: [],
  apiModel: "deepseek-chat",
  agentCommand: "opencode",
  agentShellPath: "",
  agentModel: "opencode/mimo-v2.5-free",
  chatEngine: "opencode",
  boardConnectionMode: "inherit",
  boardEngine: "opencode",
  boardApiModel: "",
  boardAgentModel: "",
  boardAnimate: true,
  boardMcpEnabled: false,
  tutorCodexCommand: "codex",
  tutorRemoteName:"expert",tutorRemoteUrl:"",tutorRemoteToken:"",
  tutorPairings: [],
  tutorSurfaceIds: {},
  boardMcpReadOnly: true,
  boardCloudRecognitionConsent: false,
  boardImageProvider: "qwen-compatible",
  boardImageBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  boardImageApiKey: "",
  boardImageUseSharedApiKey: false,
  boardImageModel: "qwen-image-3.0",
  boardImageWidth: 1024,
  boardImageHeight: 1024,
  boardImageCount: 2,
  boardImageNegativePrompt: "低清晰度，模糊，解剖错误，多余肢体，文字乱码",
  boardImageSeed: "",
  boardImagePromptExtend: true,
  boardImagePromptExtendMode: "direct",
  boardImageThinking: true,
  boardImageWatermark: false,
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
  learningFlowEnabled: false,
  supportCheckinEnabled: false,
  learningExpertsEnabled: false,
  learningDailyMinutes: 20,
  supportRetentionDays: 7,
  teachingMode: "auto",
  mcpServersJson: "",
  agentPermissionPolicy: "ask",
  alwaysAllowTools: [],
  webEnabled: false,
  webOfficialIntegrationEnabled: true,
  webOfficialTemplateVersion: "",
  webEngine: "api",
  webAutoAnalyze: false,
  webBridgePort: 51256,
  webBridgeToken: "",
  webCaptureDir: "",
  webAutoConvertMarkdown: true,
  webSaveRenderedHtml: true,
  webSaveSourceHtml: true,
  webPageTemplate: "",
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
  settings.credentialRefs=normalizeCredentialReferences(settings.credentialRefs);
  // A malformed stored binding is evidence of an existing identity, not a new
  // installation. Preserve nonempty strings; mark other values invalid so the
  // journal fails closed rather than silently adopting an empty replacement.
  if("surfaceTransactionJournalId" in data&&typeof data.surfaceTransactionJournalId!=="string")settings.surfaceTransactionJournalId="invalid-surface-journal-identity";
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
  for (const flag of ["learningFlowEnabled","supportCheckinEnabled","learningExpertsEnabled"] as const)
    settings[flag] = settings[flag] === true;
  if (!["auto","answer","hint","coach","check"].includes(settings.teachingMode)) settings.teachingMode="auto";
  settings.learningDailyMinutes=Number.isFinite(settings.learningDailyMinutes)?Math.max(5,Math.min(180,Math.round(settings.learningDailyMinutes))):20;
  settings.supportRetentionDays=Number.isFinite(settings.supportRetentionDays)?Math.max(1,Math.min(30,Math.round(settings.supportRetentionDays))):7;
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
  // Missing mode upgrades to following chat. Preserve the previous independent
  // preset; a saved explicit mode makes this migration idempotent.
  if (settings.boardConnectionMode !== "custom" && settings.boardConnectionMode !== "inherit")
    settings.boardConnectionMode = "inherit";
  if ((settings.boardEngine as unknown) === "inherit") {
    settings.boardEngine = settings.chatEngine;
  } else if (!reviewEngines.includes(settings.boardEngine)) {
    settings.boardEngine = DEFAULT_SETTINGS.boardEngine;
  }
  if (!reviewEngines.includes(settings.webEngine)) {
    settings.webEngine = DEFAULT_SETTINGS.webEngine;
  }
  if (typeof settings.boardApiModel !== "string") settings.boardApiModel = "";
  if (typeof settings.boardAgentModel !== "string") settings.boardAgentModel = "";
  if (typeof settings.boardAnimate !== "boolean") settings.boardAnimate = true;
  if (!Array.isArray(settings.tutorPairings)) settings.tutorPairings = [];
  else settings.tutorPairings = settings.tutorPairings.slice(0,100).flatMap(record => {const parsed=tutorPairingSchema.safeParse(record);return parsed.success?[parsed.data]:[];});
  if (!settings.tutorSurfaceIds || typeof settings.tutorSurfaceIds !== "object" || Array.isArray(settings.tutorSurfaceIds)) settings.tutorSurfaceIds = {};
  for(const key of ["tutorRemoteName","tutorRemoteUrl","tutorRemoteToken"] as const)if(typeof settings[key]!=="string")settings[key]=DEFAULT_SETTINGS[key];
  if(typeof settings.tutorCodexCommand!=="string"||!settings.tutorCodexCommand.trim())settings.tutorCodexCommand="codex";
  if (typeof settings.boardMcpEnabled !== "boolean") settings.boardMcpEnabled = false;
  if (typeof settings.boardMcpReadOnly !== "boolean") settings.boardMcpReadOnly = true;
  if (!boardImageProviders.includes(settings.boardImageProvider)) {
    settings.boardImageProvider = DEFAULT_SETTINGS.boardImageProvider;
  }
  for (const key of ["boardImageBaseUrl", "boardImageApiKey", "boardImageModel", "boardImageNegativePrompt", "boardImageSeed"] as const) {
    if (typeof settings[key] !== "string") settings[key] = DEFAULT_SETTINGS[key];
  }
  if (!settings.boardImageBaseUrl.trim()) settings.boardImageBaseUrl = DEFAULT_SETTINGS.boardImageBaseUrl;
  if (!settings.boardImageModel.trim()) settings.boardImageModel = DEFAULT_SETTINGS.boardImageModel;
  const imageWidth = Number(settings.boardImageWidth);
  const imageHeight = Number(settings.boardImageHeight);
  if (!isBoardImage1KSize(imageWidth, imageHeight)) {
    settings.boardImageWidth = DEFAULT_SETTINGS.boardImageWidth;
    settings.boardImageHeight = DEFAULT_SETTINGS.boardImageHeight;
  } else {
    settings.boardImageWidth = imageWidth;
    settings.boardImageHeight = imageHeight;
  }
  const imageCount = Number(settings.boardImageCount);
  settings.boardImageCount = Number.isInteger(imageCount) && imageCount >= 1 && imageCount <= 6
    ? imageCount
    : DEFAULT_SETTINGS.boardImageCount;
  if (!/^$|^\d+$/.test(settings.boardImageSeed.trim())) settings.boardImageSeed = "";
  else if (settings.boardImageSeed) {
    const seed = Number(settings.boardImageSeed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) settings.boardImageSeed = "";
  }
  if (settings.boardImagePromptExtendMode !== "direct" && settings.boardImagePromptExtendMode !== "agent") {
    settings.boardImagePromptExtendMode = DEFAULT_SETTINGS.boardImagePromptExtendMode;
  }
  for (const flag of ["boardImageUseSharedApiKey", "boardImagePromptExtend", "boardImageThinking", "boardImageWatermark"] as const) {
    if (typeof settings[flag] !== "boolean") settings[flag] = DEFAULT_SETTINGS[flag];
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
  if (typeof settings.webOfficialTemplateVersion !== "string") {
    settings.webOfficialTemplateVersion = DEFAULT_SETTINGS.webOfficialTemplateVersion;
  }
  for (const flag of [
    "webEnabled",
    "webOfficialIntegrationEnabled",
    "webAutoAnalyze",
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
