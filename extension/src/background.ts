// Service worker: the orchestrator. It holds the bridge config (token + port),
// decides each capture's channel, and owns the offscreen document lifecycle.
// Selections ride the obsidian:// URI when they fit; full pages are converted in
// the offscreen doc, paired with their raw source HTML, and POSTed to the
// plugin's localhost bridge. No DOM here — page conversion is delegated.

import { t } from "./i18n/index.js";
import {
  DEFAULT_CONFIG,
  type BridgeConfig,
  type ConvertMessage,
  type ConvertResult,
  type OpenUriMessage,
  type PageMessage,
  type RuntimeMessage,
  type SelectionMessage
} from "./messages.js";
import {
  buildCaptureUri,
  payloadFitsUri,
  type CapturePayload
} from "./protocol.js";

/** Read the persisted bridge config, filling defaults for a fresh install. */
async function loadConfig(): Promise<BridgeConfig> {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return {
    token: typeof stored.token === "string" ? stored.token : DEFAULT_CONFIG.token,
    port:
      typeof stored.port === "number" && Number.isInteger(stored.port)
        ? stored.port
        : DEFAULT_CONFIG.port
  };
}

function bridgeUrl(config: BridgeConfig, path: string): string {
  return `http://127.0.0.1:${config.port}${path}`;
}

/** POST a payload to the localhost bridge; resolves false on any non-2xx / error. */
async function postToBridge(payload: CapturePayload): Promise<boolean> {
  const config = await loadConfig();
  if (!config.token) return false;
  try {
    const res = await fetch(bridgeUrl(config, "/capture"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ensure the singleton offscreen document exists before we message it. */
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: "Parse page HTML with Readability and convert it to Markdown."
  });
}

/** Round-trip rendered HTML through the offscreen doc to get Markdown. */
async function htmlToMarkdown(html: string, baseUrl: string): Promise<string> {
  await ensureOffscreen();
  const message: ConvertMessage = { type: "convert", html, baseUrl };
  const result = (await chrome.runtime.sendMessage(message)) as ConvertResult;
  return result?.markdown ?? "";
}

/** Best-effort fetch of the server's original source HTML (host_permissions). */
async function fetchSource(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { credentials: "omit" });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/** Selection capture: prefer the URI channel, fall back to localhost when large. */
async function handleSelection(
  message: SelectionMessage,
  tabId: number | undefined
): Promise<void> {
  const payload: CapturePayload = {
    v: 1,
    kind: "selection",
    url: message.url,
    title: message.title,
    capturedAt: new Date().toISOString(),
    markdown: message.selection.exact,
    selections: [message.selection]
  };
  if (payloadFitsUri(payload) && tabId !== undefined) {
    const open: OpenUriMessage = { type: "open-uri", uri: buildCaptureUri(payload) };
    await chrome.tabs.sendMessage(tabId, open);
    return;
  }
  const ok = await postToBridge(payload);
  notify(ok ? t("content.sent") : t("notice.captureFailed"));
}

/** Full-page capture: convert body to Markdown, attach both HTML copies, POST. */
async function handlePage(message: PageMessage): Promise<void> {
  const markdown = await htmlToMarkdown(message.html, message.url);
  const source = await fetchSource(message.url);
  const payload: CapturePayload = {
    v: 1,
    kind: "page",
    url: message.url,
    title: message.title,
    capturedAt: new Date().toISOString(),
    markdown,
    renderedHtml: message.html,
    ...(source ? { sourceHtml: source } : {})
  };
  const ok = await postToBridge(payload);
  notify(ok ? t("content.sent") : t("notice.captureFailed"));
}

/** Surface a transient badge; the extension has no toast surface of its own. */
function notify(text: string): void {
  chrome.action.setBadgeText({ text: text ? "✓" : "!" });
  setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 2000);
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "selection") {
    void handleSelection(message, sender.tab?.id);
    return undefined;
  }
  if (message.type === "page") {
    void handlePage(message);
    return undefined;
  }
  if (message.type === "test-pairing") {
    void (async () => {
      const config = await loadConfig();
      try {
        const res = await fetch(bridgeUrl(config, "/ping"), {
          headers: { Authorization: `Bearer ${config.token}` }
        });
        sendResponse({ ok: res.ok });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true; // async sendResponse
  }
  return undefined;
});
