// Settings data + migration, free of any runtime imports so it can be unit
// tested without an Obsidian runtime. The SettingTab UI lives in settings.ts.

/** How annotated source text is styled in the editor. */
export type HighlightStyle =
  | "dotted-underline"
  | "wavy-underline"
  | "background"
  | "bold"
  | "none";

export type MemoryWriteMode = "direct" | "confirmation";

/** Persisted per-margin-card geometry: drag offset plus any user-resized size. */
export type CardGeom = { dx: number; dy: number; w?: number; h?: number };

/** Which engine produces reviews: a direct HTTPS API, or the OpenCode CLI. */
export type ReviewEngine = "api" | "opencode";

export const reviewEngines: readonly ReviewEngine[] = ["api", "opencode"];

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
  showMarker: boolean;
  marginComments: boolean;
  marginPaper: boolean;
  marginHideLink: boolean;
  inlineReview: boolean;
  watchMemoryFiles: boolean;
  autoRefreshOnAgentWrite: boolean;
  createAgentInstructions: boolean;
  memoryWriteMode: MemoryWriteMode;
  allowPreferenceWrites: boolean;
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
  agentModel: string;
  /** Which engine the tutor chat prefers. OpenCode can read the Vault directly. */
  chatEngine: ReviewEngine;
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
  /** Per-annotation margin-card geometry, so each card keeps its own size/place. */
  cardGeom: Record<string, CardGeom>;
};

/** Lower bound for the agent run timeout, in seconds. */
export const MIN_AGENT_TIMEOUT_SECONDS = 30;

/** Lower bound for the pre-translation chunk size, in characters. */
export const MIN_PRETRANSLATE_CHUNK_CHARS = 800;

export const DEFAULT_SETTINGS: AnnotationTutorLiteSettings = {
  language: "auto",
  memoryRoot: "Agent Memory",
  useBlockAnchors: true,
  highlightStyle: "dotted-underline",
  showMarker: true,
  marginComments: true,
  marginPaper: false,
  marginHideLink: false,
  inlineReview: true,
  watchMemoryFiles: true,
  autoRefreshOnAgentWrite: true,
  createAgentInstructions: true,
  memoryWriteMode: "direct",
  allowPreferenceWrites: false,
  autoRunAgent: false,
  reviewEngine: "api",
  apiBaseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  apiModel: "deepseek-chat",
  agentCommand: "opencode",
  agentModel: "opencode/mimo-v2.5-free",
  chatEngine: "opencode",
  agentFallbackModel: "",
  agentTimeoutSeconds: 240,
  reviewLanguage: "",
  dictionaryLanguage: "",
  pretranslateOnOpen: true,
  pretranslateChunkChars: 3000,
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
  if (!reviewEngines.includes(settings.reviewEngine)) {
    settings.reviewEngine = DEFAULT_SETTINGS.reviewEngine;
  }
  if (!reviewEngines.includes(settings.chatEngine)) {
    settings.chatEngine = DEFAULT_SETTINGS.chatEngine;
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
  if (
    typeof settings.pretranslateChunkChars !== "number" ||
    !Number.isFinite(settings.pretranslateChunkChars) ||
    settings.pretranslateChunkChars < MIN_PRETRANSLATE_CHUNK_CHARS
  ) {
    settings.pretranslateChunkChars = DEFAULT_SETTINGS.pretranslateChunkChars;
  } else {
    settings.pretranslateChunkChars = Math.floor(settings.pretranslateChunkChars);
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
