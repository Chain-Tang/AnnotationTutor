// Popup UI: a task-first capture surface. Tutor and the extension negotiate the
// loopback port + per-client token after explicit approval in Obsidian.
// "Clip whole page" tells the active tab's content script to hand its DOM to the
// service worker, while this surface manages the current page's highlights.

import { initI18n, t } from "../i18n/index.js";
import {
  type FocusHighlightMessage,
  type GrabPageMessage,
  type SyncHighlightsMessage
} from "../messages.js";
import { clearHighlights, colorValue, loadHighlights } from "../highlights.js";

let currentTab: chrome.tabs.Tab | undefined;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/** Collapse whitespace and clip to `max` characters for a compact preview. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

/** Paint the static labels from the extension's own i18n. */
function applyLabels(): void {
  byId("title").textContent = t("popup.title");
  byId<HTMLButtonElement>("clip-page").textContent = t("popup.clipPage");
  byId("clip-hint").textContent = t("popup.clipPageHint");
  byId("connection-title").textContent = t("popup.connection.title");
  byId("connection-help").textContent = t("popup.connection.help");
  byId<HTMLButtonElement>("connect").textContent = t("popup.reconnect");
  byId("hl-title").textContent = t("popup.highlights.title");
  byId<HTMLButtonElement>("hl-sync").textContent = t("popup.highlights.sync");
  byId<HTMLButtonElement>("hl-clear").textContent = t("popup.highlights.clear");
  byId("hl-empty-title").textContent = t("popup.highlights.empty");
  byId("hl-empty-hint").textContent = t("popup.highlights.emptyHint");
}

function setStatus(state: "connecting" | "paired" | "unpaired"): void {
  const status = byId("status");
  status.classList.toggle("connecting", state === "connecting");
  status.classList.toggle("ok", state === "paired");
  byId("status-text").textContent = t(
    state === "connecting"
      ? "popup.status.connecting"
      : state === "paired"
        ? "popup.status.paired"
        : "popup.status.unpaired"
  );
}

async function clipPage(): Promise<void> {
  if (!(await messageActiveTab({ type: "grab-page" }))) {
    byId("feedback").textContent = t("popup.pageUnsupported");
    return;
  }
  window.close();
}

/**
 * Send a message to the active tab's content script; false when the page can't
 * host one (chrome:// pages, the Web Store, PDFs) — sendMessage rejects there,
 * and without the guard the popup would just close with nothing happening.
 */
async function messageActiveTab(
  message: GrabPageMessage | FocusHighlightMessage | SyncHighlightsMessage
): Promise<boolean> {
  if (currentTab?.id === undefined) return false;
  try {
    await chrome.tabs.sendMessage(currentTab.id, message);
    return true;
  } catch {
    return false;
  }
}

let pendingPoll: ReturnType<typeof setTimeout> | undefined;
async function connectBridge(showFeedback = true): Promise<void> {
  if (pendingPoll) clearTimeout(pendingPoll);
  const button = byId<HTMLButtonElement>("connect");
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    setStatus("unpaired");
    if (showFeedback) byId("feedback").textContent = t("popup.pairingFail");
    return;
  }
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setStatus("connecting");
  try {
    const response = (await chrome.runtime.sendMessage({ type: showFeedback ? "connect-bridge" : "test-pairing" })) as {
      ok: boolean; pending?: boolean; error?: string;
    } | undefined;
    const ok = response?.ok === true;
    setStatus(ok ? "paired" : "unpaired");
    if (response?.pending) {
      setStatus("connecting");
      byId("feedback").textContent = t("popup.pairingPending");
      pendingPoll = setTimeout(() => void connectBridge(false), 2000);
    } else if (showFeedback || ok || response?.error) {
      byId("feedback").textContent = ok ? t("popup.pairingOk") : t("popup.pairingFail");
    }
  } catch {
    setStatus("unpaired");
    if (showFeedback) byId("feedback").textContent = t("popup.pairingFail");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

/** List every highlight saved for the active tab's URL, newest first. */
async function renderHighlights(): Promise<void> {
  const list = currentTab?.url ? await loadHighlights(currentTab.url) : [];
  const listEl = byId<HTMLUListElement>("hl-list");
  const emptyEl = byId("hl-empty");
  const clearBtn = byId<HTMLButtonElement>("hl-clear");
  const syncBtn = byId<HTMLButtonElement>("hl-sync");
  const titleEl = byId("hl-title");
  listEl.textContent = "";
  if (list.length === 0) {
    emptyEl.style.display = "block";
    clearBtn.style.display = "none";
    syncBtn.style.display = "none";
    titleEl.textContent = t("popup.highlights.title");
    return;
  }
  emptyEl.style.display = "none";
  clearBtn.style.display = "inline";
  syncBtn.style.display = "inline";
  titleEl.textContent = `${t("popup.highlights.title")} \u00b7 ${list.length} ${t("popup.highlights.count")}`;
  // Storage keeps insertion order (oldest first); the list shows the freshest
  // annotations at the top where they are easiest to reach.
  for (const hl of [...list].reverse()) {
    const li = document.createElement("li");
    li.className = hl.status === "orphaned" ? "hl-item hl-item-orphaned" : "hl-item";
    const dot = document.createElement("span");
    dot.className = "hl-dot";
    dot.style.backgroundColor = colorValue(hl.color);
    const text = document.createElement("span");
    text.className = "hl-text";
    text.textContent = clip(hl.exact, 64);
    li.append(dot, text);
    if (hl.status === "shifted" || hl.status === "orphaned") {
      const status = document.createElement("span");
      status.className = `hl-status hl-status-${hl.status}`;
      status.textContent = hl.status === "orphaned" ? "\u26a0" : "\u2248";
      status.title = t(
        hl.status === "orphaned"
          ? "popup.highlights.orphaned"
          : "popup.highlights.shifted"
      );
      li.appendChild(status);
    }
    if (hl.note) {
      const badge = document.createElement("span");
      badge.className = "hl-note-badge";
      badge.textContent = "\u270e";
      badge.title = hl.note;
      li.appendChild(badge);
    }
    li.addEventListener("click", () => void focusHighlight(hl.id));
    listEl.appendChild(li);
  }
}

/** Ask the active tab's content script to scroll to and flash a highlight. */
async function focusHighlight(id: string): Promise<void> {
  if (!(await messageActiveTab({ type: "focus-highlight", id }))) {
    byId("feedback").textContent = t("popup.pageUnsupported");
    return;
  }
  window.close();
}

async function clearAll(): Promise<void> {
  if (!currentTab?.url) return;
  await clearHighlights(currentTab.url);
  await renderHighlights();
}

/**
 * Ship every highlight on this page to Obsidian in one capture. Routed through
 * the content script so the capture keeps the URI channel (it holds the page
 * context and user gesture the deep link needs).
 */
async function syncHighlights(): Promise<void> {
  if (!(await messageActiveTab({ type: "sync-highlights" }))) {
    byId("feedback").textContent = t("popup.pageUnsupported");
    return;
  }
  window.close();
}

applyLabels();
void (async () => {
  await initI18n();
  applyLabels();
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    setStatus("unpaired");
    await renderHighlights();
    return;
  }
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await Promise.all([connectBridge(false), renderHighlights()]);
})();
byId<HTMLButtonElement>("connect").addEventListener("click", () => void connectBridge());
byId<HTMLButtonElement>("clip-page").addEventListener("click", () => void clipPage());
byId<HTMLButtonElement>("hl-clear").addEventListener("click", () => void clearAll());
byId<HTMLButtonElement>("hl-sync").addEventListener("click", () => void syncHighlights());
