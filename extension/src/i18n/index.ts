// The extension's own i18n, intentionally independent of the plugin's src/i18n.ts
// (separate build, separate release channel). Small enough to keep in-source: a
// flat dictionary per locale. The active locale follows the saved preference
// (auto / en / zh-cn, set from the popup) with navigator.language as the
// auto-detected fallback. Extend by adding locales; the English block is the
// source of truth for available keys.

type MessageKey =
  | "popup.title"
  | "popup.status.paired"
  | "popup.status.unpaired"
  | "popup.status.connecting"
  | "popup.token.label"
  | "popup.token.placeholder"
  | "popup.port.label"
  | "popup.language"
  | "popup.language.auto"
  | "popup.language.zh"
  | "popup.language.en"
  | "popup.save"
  | "popup.saved"
  | "popup.clipPage"
  | "popup.clipPageHint"
  | "popup.testPairing"
  | "popup.pairingPending"
  | "content.captureFailed"
  | "content.askStop"
  | "content.askCancelled"
  | "popup.pairingOk"
  | "popup.pairingFail"
  | "popup.highlights.title"
  | "popup.highlights.empty"
  | "popup.highlights.emptyHint"
  | "popup.highlights.clear"
  | "popup.highlights.sync"
  | "popup.highlights.count"
  | "popup.highlights.shifted"
  | "popup.highlights.orphaned"
  | "popup.pageUnsupported"
  | "popup.connection.title"
  | "popup.connection.help"
  | "popup.reconnect"
  | "content.annotate"
  | "content.notePrompt"
  | "content.sent"
  | "content.needSelection"
  | "content.noHighlights"
  | "content.highlight"
  | "content.note"
  | "content.toObsidian"
  | "content.editNote"
  | "content.copy"
  | "content.copied"
  | "content.remove"
  | "content.noteEmpty"
  | "content.highlightSaved"
  | "content.ask"
  | "content.askTitle"
  | "content.askIntro"
  | "content.askPlaceholder"
  | "content.askFailed"
  | "content.saveAnswer"
  | "content.askCollapse"
  | "content.askExpand"
  | "notice.captureFailed";

type Dictionary = Record<MessageKey, string>;

/** The persisted locale preference; "auto" follows the browser language. */
export type LocalePreference = "auto" | "en" | "zh-cn";

const LOCALE_STORAGE_KEY = "locale";

const en: Dictionary = {
  "popup.title": "Web Clipper",
  "popup.status.paired": "Paired with Obsidian",
  "popup.status.unpaired": "Not paired yet",
  "popup.status.connecting": "Connecting to Tutor…",
  "popup.token.label": "Bridge token",
  "popup.token.placeholder": "Paste the token from the plugin's Web settings",
  "popup.port.label": "Bridge port",
  "popup.language": "Language",
  "popup.language.auto": "Auto (browser)",
  "popup.language.zh": "Chinese",
  "popup.language.en": "English",
  "popup.save": "Save",
  "popup.saved": "Saved",
  "popup.clipPage": "Clip whole page",
  "popup.clipPageHint": "Sends the article body as Markdown plus raw HTML.",
  "popup.testPairing": "Test pairing",
  "popup.pairingPending": "Approve the requested capabilities in Obsidian within five minutes.",
  "content.captureFailed": "Save not confirmed. Check the connection and capture permission; no automatic retry was made.",
  "content.askStop": "Stop",
  "content.askCancelled": "Stopped. Provider work already performed may still be charged.",
  "popup.pairingOk": "Pairing OK",
  "popup.pairingFail": "Could not reach the plugin bridge",
  "popup.highlights.title": "Highlights on this page",
  "popup.highlights.empty": "No highlights on this page yet",
  "popup.highlights.emptyHint": "Select text on the page to highlight or annotate it.",
  "popup.highlights.clear": "Clear all",
  "popup.highlights.sync": "Sync all",
  "popup.highlights.count": "saved",
  "popup.highlights.shifted": "Re-anchored by position — the page shifted under this highlight",
  "popup.highlights.orphaned": "Not found on this page — the page may have changed",
  "popup.pageUnsupported": "This page can't be clipped — regular web pages only",
  "popup.connection.title": "Tutor connection",
  "popup.connection.help": "Connect explicitly, then approve capture and/or ask in Obsidian. Older pairings must be approved again.",
  "popup.reconnect": "Reconnect",
  "content.annotate": "Annotate selection",
  "content.notePrompt": "Add a note for this highlight (optional):",
  "content.sent": "Sent to Obsidian",
  "content.needSelection": "Select some text first",
  "content.noHighlights": "No highlights on this page yet",
  "content.highlight": "Highlight",
  "content.note": "Note",
  "content.toObsidian": "Send to Obsidian",
  "content.editNote": "Edit note",
  "content.copy": "Copy",
  "content.copied": "Copied",
  "content.remove": "Remove",
  "content.noteEmpty": "No note yet",
  "content.highlightSaved": "Highlight saved on this page",
  "content.ask": "Ask",
  "content.askTitle": "Ask the tutor",
  "content.askIntro": "The tutor reads this page — ask anything. Answers can be saved to Obsidian.",
  "content.askPlaceholder": "Ask a question about this page\u2026",
  "content.askFailed": "Ask failed",
  "content.saveAnswer": "Save to Obsidian",
  "content.askCollapse": "Collapse panel",
  "content.askExpand": "Expand panel",
  "notice.captureFailed": "Capture failed"
};

const zhCn: Dictionary = {
  "popup.title": "网页剪藏",
  "popup.status.paired": "已与 Obsidian 配对",
  "popup.status.unpaired": "尚未配对",
  "popup.status.connecting": "正在连接 Tutor…",
  "popup.token.label": "桥接令牌",
  "popup.token.placeholder": "粘贴插件 Web 设置里的令牌",
  "popup.port.label": "桥接端口",
  "popup.language": "语言",
  "popup.language.auto": "自动（跟随浏览器）",
  "popup.language.zh": "中文",
  "popup.language.en": "English",
  "popup.save": "保存",
  "popup.saved": "已保存",
  "popup.clipPage": "剪藏整页",
  "popup.clipPageHint": "以 Markdown 发送正文并附带原始 HTML。",
  "popup.testPairing": "测试配对",
  "popup.pairingPending": "请在五分钟内到 Obsidian 明确批准所需权限。",
  "content.captureFailed": "未确认保存成功。请检查连接和保存权限；没有自动重试。",
  "content.askStop": "停止",
  "content.askCancelled": "已停止；供应商已完成的处理仍可能计费。",
  "popup.pairingOk": "配对成功",
  "popup.pairingFail": "无法连接插件桥接服务",
  "popup.highlights.title": "本页标注",
  "popup.highlights.empty": "本页尚无标注",
  "popup.highlights.emptyHint": "在网页中选中文字即可高亮或添加批注。",
  "popup.highlights.clear": "全部清除",
  "popup.highlights.sync": "同步全部",
  "popup.highlights.count": "条",
  "popup.highlights.shifted": "已按偏移重新锚定——页面在此高亮附近发生过变动",
  "popup.highlights.orphaned": "本页未找到——页面可能已改动",
  "popup.pageUnsupported": "该页面无法剪藏——仅支持普通网页",
  "popup.connection.title": "Tutor 连接",
  "popup.connection.help": "点击连接后，在 Obsidian 选择保存或提问权限。旧配对需要重新批准。",
  "popup.reconnect": "重新连接",
  "content.annotate": "批注选区",
  "content.notePrompt": "为这段高亮添加批注（可选）：",
  "content.sent": "已发送到 Obsidian",
  "content.needSelection": "请先选中文本",
  "content.noHighlights": "本页尚无标注",
  "content.highlight": "高亮",
  "content.note": "批注",
  "content.toObsidian": "发送到 Obsidian",
  "content.editNote": "编辑批注",
  "content.copy": "复制",
  "content.copied": "已复制",
  "content.remove": "移除",
  "content.noteEmpty": "暂无批注",
  "content.highlightSaved": "高亮已保存在本页",
  "content.ask": "提问",
  "content.askTitle": "问导师",
  "content.askIntro": "导师会阅读本页内容——随时提问，回答可保存到 Obsidian。",
  "content.askPlaceholder": "就本页内容提问…",
  "content.askFailed": "提问失败",
  "content.saveAnswer": "保存到 Obsidian",
  "content.askCollapse": "收起面板",
  "content.askExpand": "展开面板",
  "notice.captureFailed": "剪藏失败"
};

const dictionaries: Record<string, Dictionary> = { en, "zh-cn": zhCn };

function dictionaryForNavigator(): Dictionary {
  const lang = (globalThis.navigator?.language ?? "en").toLowerCase();
  return lang.startsWith("zh") ? zhCn : en;
}

function dictionaryFor(preference: LocalePreference): Dictionary {
  if (preference === "en") return en;
  if (preference === "zh-cn") return zhCn;
  return dictionaryForNavigator();
}

/** Active until initI18n() applies the saved preference (which usually wins). */
let active: Dictionary = dictionaryForNavigator();

/**
 * Load the saved locale preference into the active dictionary. Safe to call in
 * any context (the content script, the popup, the worker) and in tests without
 * a chrome global; without storage the navigator lookup stands.
 */
export async function initI18n(): Promise<void> {
  try {
    const stored = await globalThis.chrome?.storage?.local?.get(LOCALE_STORAGE_KEY);
    const value = stored?.[LOCALE_STORAGE_KEY];
    if (value === "auto" || value === "en" || value === "zh-cn") {
      active = dictionaryFor(value);
    }
  } catch {
    /* storage unavailable — keep the navigator-based dictionary */
  }
}

/** The saved preference, or "auto" when nothing (readable) was stored. */
export async function getLocalePreference(): Promise<LocalePreference> {
  try {
    const stored = await globalThis.chrome?.storage?.local?.get(LOCALE_STORAGE_KEY);
    const value = stored?.[LOCALE_STORAGE_KEY];
    if (value === "en" || value === "zh-cn") return value;
  } catch {
    /* fall through to auto */
  }
  return "auto";
}

/** Switch the active dictionary immediately and persist the preference. */
export async function setLocalePreference(preference: LocalePreference): Promise<void> {
  active = dictionaryFor(preference);
  try {
    await globalThis.chrome?.storage?.local?.set({ [LOCALE_STORAGE_KEY]: preference });
  } catch {
    /* storage unavailable — the switch still applies for this session */
  }
}

/** Translate a key for the current locale, falling back to English. */
export function t(key: MessageKey): string {
  return active[key] ?? en[key] ?? key;
}

export type { MessageKey };
export { dictionaries };
