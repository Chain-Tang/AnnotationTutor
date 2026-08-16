// The extension's own i18n, intentionally independent of the plugin's src/i18n.ts
// (separate build, separate release channel). Small enough to keep in-source: a
// flat dictionary per locale plus a navigator-language lookup. Extend by adding
// locales; the English block is the source of truth for available keys.

type MessageKey =
  | "popup.title"
  | "popup.status.paired"
  | "popup.status.unpaired"
  | "popup.token.label"
  | "popup.token.placeholder"
  | "popup.port.label"
  | "popup.save"
  | "popup.saved"
  | "popup.clipPage"
  | "popup.clipPageHint"
  | "popup.testPairing"
  | "popup.pairingOk"
  | "popup.pairingFail"
  | "popup.highlights.title"
  | "popup.highlights.empty"
  | "popup.highlights.clear"
  | "popup.highlights.count"
  | "content.annotate"
  | "content.notePrompt"
  | "content.sent"
  | "content.needSelection"
  | "content.highlight"
  | "content.note"
  | "content.toObsidian"
  | "content.editNote"
  | "content.copy"
  | "content.copied"
  | "content.remove"
  | "content.noteEmpty"
  | "content.highlightSaved"
  | "notice.captureFailed";

type Dictionary = Record<MessageKey, string>;

const en: Dictionary = {
  "popup.title": "Web Clipper",
  "popup.status.paired": "Paired with Obsidian",
  "popup.status.unpaired": "Not paired yet",
  "popup.token.label": "Bridge token",
  "popup.token.placeholder": "Paste the token from the plugin's Web settings",
  "popup.port.label": "Bridge port",
  "popup.save": "Save",
  "popup.saved": "Saved",
  "popup.clipPage": "Clip whole page",
  "popup.clipPageHint": "Sends the article body as Markdown plus raw HTML.",
  "popup.testPairing": "Test pairing",
  "popup.pairingOk": "Pairing OK",
  "popup.pairingFail": "Could not reach the plugin bridge",
  "popup.highlights.title": "Highlights on this page",
  "popup.highlights.empty": "No highlights on this page yet",
  "popup.highlights.clear": "Clear all",
  "popup.highlights.count": "saved",
  "content.annotate": "Annotate selection",
  "content.notePrompt": "Add a note for this highlight (optional):",
  "content.sent": "Sent to Obsidian",
  "content.needSelection": "Select some text first",
  "content.highlight": "Highlight",
  "content.note": "Note",
  "content.toObsidian": "Send to Obsidian",
  "content.editNote": "Edit note",
  "content.copy": "Copy",
  "content.copied": "Copied",
  "content.remove": "Remove",
  "content.noteEmpty": "No note yet",
  "content.highlightSaved": "Highlight saved on this page",
  "notice.captureFailed": "Capture failed"
};

const zhCn: Dictionary = {
  "popup.title": "网页剪藏",
  "popup.status.paired": "已与 Obsidian 配对",
  "popup.status.unpaired": "尚未配对",
  "popup.token.label": "桥接令牌",
  "popup.token.placeholder": "粘贴插件 Web 设置里的令牌",
  "popup.port.label": "桥接端口",
  "popup.save": "保存",
  "popup.saved": "已保存",
  "popup.clipPage": "剪藏整页",
  "popup.clipPageHint": "以 Markdown 发送正文并附带原始 HTML。",
  "popup.testPairing": "测试配对",
  "popup.pairingOk": "配对成功",
  "popup.pairingFail": "无法连接插件桥接服务",
  "popup.highlights.title": "本页标注",
  "popup.highlights.empty": "本页尚无标注",
  "popup.highlights.clear": "全部清除",
  "popup.highlights.count": "条",
  "content.annotate": "批注选区",
  "content.notePrompt": "为这段高亮添加批注（可选）：",
  "content.sent": "已发送到 Obsidian",
  "content.needSelection": "请先选中文本",
  "content.highlight": "高亮",
  "content.note": "批注",
  "content.toObsidian": "发送到 Obsidian",
  "content.editNote": "编辑批注",
  "content.copy": "复制",
  "content.copied": "已复制",
  "content.remove": "移除",
  "content.noteEmpty": "暂无批注",
  "content.highlightSaved": "高亮已保存在本页",
  "notice.captureFailed": "剪藏失败"
};

const dictionaries: Record<string, Dictionary> = { en, "zh-cn": zhCn };

function resolveLocale(): Dictionary {
  const lang = (globalThis.navigator?.language ?? "en").toLowerCase();
  if (lang.startsWith("zh")) return zhCn;
  return en;
}

const active = resolveLocale();

/** Translate a key for the current locale, falling back to English. */
export function t(key: MessageKey): string {
  return active[key] ?? en[key] ?? key;
}

export type { MessageKey };
export { dictionaries };
