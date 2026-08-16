// Popup UI: the extension's settings + full-page trigger. Pairing is paste-based
// — the learner copies the token from the plugin's Web settings and drops it here
// (matching the plugin's regenerate-token affordance). "Clip whole page" tells the
// active tab's content script to hand its DOM to the service worker.

import { t } from "../i18n/index.js";
import { DEFAULT_CONFIG, type FocusHighlightMessage, type GrabPageMessage } from "../messages.js";
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
  byId("token-label").textContent = t("popup.token.label");
  byId<HTMLInputElement>("token").placeholder = t("popup.token.placeholder");
  byId("port-label").textContent = t("popup.port.label");
  byId<HTMLButtonElement>("save").textContent = t("popup.save");
  byId<HTMLButtonElement>("test").textContent = t("popup.testPairing");
  byId("hl-title").textContent = t("popup.highlights.title");
  byId<HTMLButtonElement>("hl-clear").textContent = t("popup.highlights.clear");
  byId("hl-empty").textContent = t("popup.highlights.empty");
}

function setStatus(paired: boolean): void {
  const status = byId("status");
  status.textContent = paired ? t("popup.status.paired") : t("popup.status.unpaired");
  status.classList.toggle("ok", paired);
}

async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  byId<HTMLInputElement>("token").value =
    typeof stored.token === "string" ? stored.token : "";
  byId<HTMLInputElement>("port").value = String(
    typeof stored.port === "number" ? stored.port : DEFAULT_CONFIG.port
  );
  setStatus(Boolean(stored.token));
}

async function save(): Promise<void> {
  const token = byId<HTMLInputElement>("token").value.trim();
  const parsedPort = Number.parseInt(byId<HTMLInputElement>("port").value, 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_CONFIG.port;
  await chrome.storage.local.set({ token, port });
  byId("feedback").textContent = t("popup.saved");
  setStatus(Boolean(token));
}

async function clipPage(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const message: GrabPageMessage = { type: "grab-page" };
  await chrome.tabs.sendMessage(tab.id, message);
  window.close();
}

async function testPairing(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type: "test-pairing" })) as {
    ok: boolean;
  } | undefined;
  byId("feedback").textContent = response?.ok
    ? t("popup.pairingOk")
    : t("popup.pairingFail");
}

/** List every highlight saved for the active tab's URL, newest first. */
async function renderHighlights(): Promise<void> {
  const list = currentTab?.url ? await loadHighlights(currentTab.url) : [];
  const listEl = byId<HTMLUListElement>("hl-list");
  const emptyEl = byId("hl-empty");
  const clearBtn = byId<HTMLButtonElement>("hl-clear");
  const titleEl = byId("hl-title");
  listEl.textContent = "";
  if (list.length === 0) {
    emptyEl.style.display = "block";
    clearBtn.style.display = "none";
    titleEl.textContent = t("popup.highlights.title");
    return;
  }
  emptyEl.style.display = "none";
  clearBtn.style.display = "inline";
  titleEl.textContent = `${t("popup.highlights.title")} \u00b7 ${list.length} ${t("popup.highlights.count")}`;
  for (const hl of list) {
    const li = document.createElement("li");
    li.className = "hl-item";
    const dot = document.createElement("span");
    dot.className = "hl-dot";
    dot.style.backgroundColor = colorValue(hl.color);
    const text = document.createElement("span");
    text.className = "hl-text";
    text.textContent = clip(hl.exact, 64);
    li.append(dot, text);
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
  if (currentTab?.id === undefined) return;
  const message: FocusHighlightMessage = { type: "focus-highlight", id };
  await chrome.tabs.sendMessage(currentTab.id, message);
  window.close();
}

async function clearAll(): Promise<void> {
  if (!currentTab?.url) return;
  await clearHighlights(currentTab.url);
  await renderHighlights();
}

applyLabels();
void (async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await loadConfig();
  await renderHighlights();
})();
byId<HTMLButtonElement>("save").addEventListener("click", () => void save());
byId<HTMLButtonElement>("test").addEventListener("click", () => void testPairing());
byId<HTMLButtonElement>("clip-page").addEventListener("click", () => void clipPage());
byId<HTMLButtonElement>("hl-clear").addEventListener("click", () => void clearAll());
