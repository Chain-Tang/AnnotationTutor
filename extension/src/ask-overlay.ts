// In-page tutor overlay: the learner asks about the page (or the passage they
// selected), the question travels through the service worker to the plugin's
// /ask SSE endpoint, and the answer streams back into this panel. The panel is
// a floating card in the Obsidian editor's margin-card tradition: drag it by
// its header (the placed position survives re-opens within the tab), and click
// the header — or its chevron — to collapse it to a compact chip; click again
// to expand. Streaming keeps flowing while collapsed. One panel per page; each
// ask carries a reqId, so events from a superseded stream (panel closed and
// reopened mid-answer) cannot bleed into the panel that replaced it.

import { t } from "./i18n/index.js";
import type { AskMessage, AskProgress } from "./messages.js";
import type { CaptureSelection } from "./protocol.js";
import {
  ANCHOR_CONTEXT,
  buildTextMap,
  selectorFromRange,
  UI_CLASS
} from "./anchor.js";
import { buildSnapshotHtml } from "./snapshot.js";
import { loadHighlights, toSelection } from "./highlights.js";
import { mkButton, sendToObsidian } from "./ui.js";

/** The open ask panel, if any. One panel per page; re-opening replaces it. */
interface AskSession {
  panel: HTMLDivElement;
  answer: HTMLDivElement;
  input: HTMLTextAreaElement;
  askBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  /** The header chevron; its glyph tracks the collapse state. */
  collapseBtn: HTMLButtonElement;
  /** Which ask this panel is streaming; progress events for any other id are stale. */
  reqId: string;
  /** The passage the question is about, if the ask started from a selection. */
  quote: CaptureSelection | null;
  question: string;
  answerText: string;
  busy: boolean;
}

let askSession: AskSession | null = null;

/** Pointer travel (px) that separates a header click from a header drag. */
const DRAG_THRESHOLD = 4;

/** Where the learner parked the panel (viewport coords), per tab session. */
const GEOM_KEY = "atl-ask-geom";

/** Inject the ask-panel stylesheet once (shared chrome CSS lives in ui.ts). */
function injectAskStyles(): void {
  if (document.getElementById("atl-ask-style")) return;
  const style = document.createElement("style");
  style.id = "atl-ask-style";
  style.textContent = `
.atl-ask-panel{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:min(420px,calc(100vw - 40px));max-height:min(64vh,560px);display:flex;flex-direction:column;background:#1f2430;color:#e5e7eb;box-shadow:0 12px 32px rgba(0,0,0,.4);border-radius:14px;font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
.atl-ask-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
.atl-ask-head.atl-ask-dragging{cursor:grabbing}
.atl-ask-title{flex:1;font-weight:600;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.atl-ask-quote{margin:0;padding:8px 14px;color:#94a3b8;font-style:italic;border-left:2px solid rgba(148,163,184,.4);white-space:pre-wrap;word-break:break-word;max-height:64px;overflow:hidden}
.atl-ask-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;min-height:0}
.atl-ask-answer{white-space:pre-wrap;word-break:break-word;min-height:0}
.atl-ask-answer.empty{color:#94a3b8;font-style:italic}
.atl-ask-input{resize:vertical;min-height:56px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;font:inherit;padding:8px 10px;box-sizing:border-box}
.atl-ask-input:focus{outline:1px solid rgba(124,58,237,.6)}
.atl-ask-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
/* Collapsed: the card folds down to its header — click it to bring the answer back. */
.atl-ask-panel.atl-ask-collapsed{width:auto;max-height:none}
.atl-ask-panel.atl-ask-collapsed .atl-ask-quote,.atl-ask-panel.atl-ask-collapsed .atl-ask-body{display:none}
.atl-ask-panel.atl-ask-collapsed .atl-ask-head{border-bottom:none}
@media (prefers-reduced-motion:reduce){.atl-ask-panel{transition:none}}
`;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Stable one-shot request identity, also used for status and cancellation. */
function newAskId(): string {
  return crypto.randomUUID();
}

/** Close the panel on Escape — the dismissal every floating surface should have. */
function onAskKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeAskPanel();
}

/** The remembered panel placement for this tab, if the learner parked one. */
function loadPanelGeom(): { left: number; top: number } | null {
  try {
    const raw = sessionStorage.getItem(GEOM_KEY);
    if (!raw) return null;
    const geom = JSON.parse(raw) as { left?: unknown; top?: unknown };
    if (typeof geom.left !== "number" || typeof geom.top !== "number") return null;
    return { left: geom.left, top: geom.top };
  } catch {
    return null;
  }
}

function savePanelGeom(left: number, top: number): void {
  try {
    sessionStorage.setItem(GEOM_KEY, JSON.stringify({ left, top }));
  } catch {
    /* storage disabled — placement just won't persist */
  }
}

/** Apply a remembered placement, clamped back into the viewport. */
function applyPanelGeom(panel: HTMLDivElement): void {
  const geom = loadPanelGeom();
  if (!geom) return;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = Math.min(Math.max(8, geom.left), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, geom.top), Math.max(8, window.innerHeight - Math.min(height, 48) - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

/**
 * Header behaviors in one gesture, the way the Obsidian margin cards work:
 * press-and-move drags the card anywhere on screen (viewport-clamped); a
 * press-and-release without travel reads as a click and toggles the collapse.
 * Buttons inside the header opt out of both.
 */
function enableHeadGestures(panel: HTMLDivElement, head: HTMLElement): void {
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button, textarea, input, a")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let baseLeft = 0;
    let baseTop = 0;
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== event.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        // First past the threshold: anchor to explicit coordinates so the
        // right/bottom CSS defaults stop fighting the drag.
        moved = true;
        head.classList.add("atl-ask-dragging");
        const rect = panel.getBoundingClientRect();
        baseLeft = rect.left;
        baseTop = rect.top;
        panel.style.left = `${baseLeft}px`;
        panel.style.top = `${baseTop}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.min(
        Math.max(8, baseLeft + dx),
        Math.max(8, window.innerWidth - width - 8)
      );
      const top = Math.min(
        Math.max(8, baseTop + dy),
        Math.max(8, window.innerHeight - height - 8)
      );
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const finish = (e: PointerEvent): void => {
      if (e.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      if (moved) {
        head.classList.remove("atl-ask-dragging");
        savePanelGeom(parseFloat(panel.style.left), parseFloat(panel.style.top));
      } else {
        toggleCollapse();
      }
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
  });
}

/** Fold the panel to its header, or bring the full card back. */
function toggleCollapse(): void {
  const session = askSession;
  if (!session) return;
  const collapsed = session.panel.classList.toggle("atl-ask-collapsed");
  session.collapseBtn.textContent = collapsed ? "\u25b8" : "\u25be";
  session.collapseBtn.title = collapsed ? t("content.askExpand") : t("content.askCollapse");
  if (!collapsed) {
    applyPanelGeom(session.panel);
    // Re-clamp after the size change a collapse/expand round-trip causes.
    const left = parseFloat(session.panel.style.left);
    const top = parseFloat(session.panel.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      const width = session.panel.offsetWidth;
      const height = session.panel.offsetHeight;
      session.panel.style.left = `${Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8))}px`;
      session.panel.style.top = `${Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8))}px`;
    }
  }
}

/**
 * Open the tutor overlay. If a selection is live, it becomes the quoted
 * context both for the tutor's answer and for a later "save to Obsidian".
 */
export function openAskPanel(range: Range | null): void {
  injectAskStyles();
  // Replace any open panel (and its Escape listener) instead of stacking.
  closeAskPanel();
  document.addEventListener("keydown", onAskKeydown);
  let quote: CaptureSelection | null = null;
  if (range) {
    const map = buildTextMap();
    const described = selectorFromRange(map, range, ANCHOR_CONTEXT);
    if (described) {
      quote = {
        exact: described.selector.exact,
        prefix: described.selector.prefix,
        suffix: described.selector.suffix
      };
    }
  }
  const panel = document.createElement("div");
  panel.className = `${UI_CLASS} atl-ask-panel`;
  const head = document.createElement("div");
  head.className = "atl-ask-head";
  const title = document.createElement("span");
  title.className = "atl-ask-title";
  title.textContent = t("content.askTitle");
  const collapse = mkButton("\u25be");
  collapse.className = "atl-hl-btn atl-ask-collapse";
  collapse.title = t("content.askCollapse");
  collapse.addEventListener("click", () => toggleCollapse());
  const close = mkButton("\u2715");
  close.addEventListener("click", closeAskPanel);
  head.append(title, collapse, close);
  panel.appendChild(head);
  if (quote) {
    const quoteEl = document.createElement("blockquote");
    quoteEl.className = "atl-ask-quote";
    quoteEl.textContent = quote.exact.replace(/\s+/g, " ").trim().slice(0, 160);
    panel.appendChild(quoteEl);
  }
  const body = document.createElement("div");
  body.className = "atl-ask-body";
  const answer = document.createElement("div");
  answer.className = "atl-ask-answer empty";
  answer.textContent = t("content.askIntro");
  const input = document.createElement("textarea");
  input.className = "atl-ask-input";
  input.placeholder = t("content.askPlaceholder");
  input.rows = 2;
  const row = document.createElement("div");
  row.className = "atl-ask-row";
  const askBtn = mkButton(t("content.ask"));
  askBtn.disabled = true;
  askBtn.addEventListener("click", () => askSession?.busy ? stopAsk() : void submitAsk());
  const saveBtn = mkButton(t("content.saveAnswer"));
  saveBtn.style.display = "none";
  saveBtn.addEventListener("click", () => void saveAskToObsidian());
  row.append(saveBtn, askBtn);
  body.append(answer, input, row);
  panel.appendChild(body);
  document.body.appendChild(panel);
  askSession = {
    panel,
    answer,
    input,
    askBtn,
    saveBtn,
    collapseBtn: collapse,
    reqId: "",
    quote,
    question: "",
    answerText: "",
    busy: false
  };
  enableHeadGestures(panel, head);
  // Parked placement from earlier in this tab, if any.
  applyPanelGeom(panel);
  input.addEventListener("input", () => {
    if (askSession) askSession.askBtn.disabled = !askSession.busy && !input.value.trim();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submitAsk();
  });
  input.focus();
}

function stopAsk(): void {
  const session = askSession;
  if (!session?.busy) return;
  void chrome.runtime.sendMessage({ type: "cancel-ask", reqId: session.reqId }).catch(() => {});
  session.busy = false;
  session.reqId = ""; // Late output cannot resurrect a stopped request.
  session.input.disabled = false;
  session.askBtn.textContent = t("content.ask");
  session.askBtn.disabled = !session.input.value.trim();
  session.answer.textContent = t("content.askCancelled");
}
window.addEventListener("pagehide", () => stopAsk());

function closeAskPanel(): void {
  stopAsk();
  document.removeEventListener("keydown", onAskKeydown);
  askSession?.panel.remove();
  askSession = null;
}

/** Send the question to the service worker; deltas stream back as events. */
async function submitAsk(): Promise<void> {
  const session = askSession;
  if (!session || session.busy) return;
  const question = session.input.value.trim();
  if (!question) return;
  session.busy = true;
  session.reqId = newAskId();
  session.question = question;
  session.answerText = "";
  // An ellipsis until the first delta arrives — the first token can take
  // seconds, and a blank panel reads as broken rather than thinking.
  session.answer.textContent = "\u2026";
  session.answer.classList.remove("empty");
  session.askBtn.disabled = false;
  session.askBtn.textContent = t("content.askStop");
  session.saveBtn.style.display = "none";
  session.input.disabled = true;
  // The tutor reads the page highlights too, so share them like a page capture.
  const activeRequest = session.reqId;
  const stored = await loadHighlights(location.href);
  if (askSession !== session || !session.busy || session.reqId !== activeRequest) return;
  const message: AskMessage = {
    type: "ask",
    reqId: session.reqId,
    question,
    html: buildSnapshotHtml(document),
    url: location.href,
    title: document.title,
    ...(stored.length > 0 ? { selections: stored.map(toSelection) } : {})
  };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The worker never got the ask (context invalidated, startup race) — no
    // progress events will ever arrive, so release the panel locally.
    session.busy = false;
    session.input.disabled = false;
    session.askBtn.textContent = t("content.ask");
    session.askBtn.disabled = !session.input.value.trim();
    session.answer.classList.add("empty");
    session.answer.textContent = t("content.askFailed");
  }
}

/** Apply one streamed progress event to the open panel (background → content). */
export function handleAskProgress(event: AskProgress): void {
  const session = askSession;
  // Events for an earlier ask are stale — the panel was closed or replaced.
  if (!session || !session.reqId || event.reqId !== session.reqId) return;
  if (event.type === "ask-delta") {
    session.answerText += event.text;
    session.answer.textContent = session.answerText;
    session.answer.classList.remove("empty");
    return;
  }
  session.busy = false;
  session.askBtn.textContent = t("content.ask");
  session.input.disabled = false;
  session.askBtn.disabled = !session.input.value.trim();
  // Re-focus for the follow-up question — unless the learner has already
  // clicked into something else on the page; yanking focus back would eat
  // their keystrokes. A collapsed panel never steals focus either.
  const active = document.activeElement;
  if (
    !session.panel.classList.contains("atl-ask-collapsed") &&
    (!active || active === document.body || session.panel.contains(active))
  ) {
    session.input.focus();
  }
  if (event.type === "ask-done") {
    session.answerText = event.text;
    session.answer.textContent = event.text;
    if (event.text.trim()) session.saveBtn.style.display = "";
    return;
  }
  session.answer.classList.add("empty");
  session.answer.textContent = `${t("content.askFailed")} (${event.error})`;
}

/**
 * Save the finished Q&A into Obsidian over the selection channel: the quoted
 * passage anchors the note, and the Q&A rides along as its "My understanding"
 * note. Without a quote, the question itself stands in as the quoted text.
 */
async function saveAskToObsidian(): Promise<void> {
  const session = askSession;
  if (!session || !session.answerText.trim()) return;
  const note = `Q: ${session.question}\n\nA: ${session.answerText.trim()}`;
  const selection: CaptureSelection = session.quote
    ? { ...session.quote, note }
    : { exact: session.question, prefix: "", suffix: "", note };
  await sendToObsidian([selection]);
}
