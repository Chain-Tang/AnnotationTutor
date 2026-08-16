// Content script: the only context with the live page DOM. It owns the on-page
// annotation experience end to end — a selection toolbar for highlighting and
// note-taking, persistence of every highlight to chrome.storage.local keyed by
// URL, re-anchoring and repainting saved highlights on each visit, and a small
// popover to manage an existing highlight. It still ships selections to Obsidian
// via the service worker, but now the highlight also stays on the page for good.

import { t } from "./i18n/index.js";
import type {
  FocusHighlightMessage,
  OpenUriMessage,
  PageMessage,
  SelectionMessage,
  TabMessage
} from "./messages.js";
import type { CaptureSelection } from "./protocol.js";
import {
  buildTextMap,
  clearMarks,
  locate,
  MARK_CLASS,
  paintAnchor,
  selectorFromRange,
  UI_CLASS,
  unpaint
} from "./anchor.js";
import {
  addHighlight,
  colorValue,
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  keyFor,
  loadHighlights,
  removeHighlight,
  toStoredHighlight,
  updateHighlightNote,
  type HighlightColorId,
  type StoredHighlight
} from "./highlights.js";

/** How much context to keep on each side of the exact text for the anchor. */
const ANCHOR_CONTEXT = 32;

/** Ids we have already painted this page load; drives the restore retry loop. */
const resolved = new Set<string>();

/** When true, ignore our own storage writes so we don't re-sync over live paint. */
let suppressSync = false;

let toolbar: HTMLDivElement | null = null;
let popover: HTMLDivElement | null = null;
let lastRange: Range | null = null;
let toastTimer: number | undefined;

// ---------------------------------------------------------------------------
// Injected styles
// ---------------------------------------------------------------------------

/** Inject the highlight + chrome stylesheet once. Controls reset with all:unset. */
function injectStyles(): void {
  if (document.getElementById("atl-hl-style")) return;
  const style = document.createElement("style");
  style.id = "atl-hl-style";
  style.textContent = `
mark.${MARK_CLASS}{background-color:inherit;color:inherit;border-radius:2px;padding:0 1px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone}
mark.${MARK_CLASS}[data-atl-note]{text-decoration:underline dotted;text-underline-offset:3px}
mark.${MARK_CLASS}.atl-hl-flash{animation:atl-hl-flash 1.2s ease}
@keyframes atl-hl-flash{0%,100%{box-shadow:none}30%{box-shadow:0 0 0 3px rgba(124,58,237,.5)}}
.atl-hl-toolbar,.atl-hl-popover{position:absolute;z-index:2147483647;background:#1f2430;color:#e5e7eb;box-shadow:0 8px 24px rgba(0,0,0,.32);font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
.atl-hl-toolbar{display:none;align-items:center;gap:6px;padding:6px 8px;border-radius:12px}
.atl-hl-swatch{all:unset;width:18px;height:18px;border-radius:50%;cursor:pointer;box-sizing:border-box;border:2px solid rgba(255,255,255,.55);transition:transform .12s ease}
.atl-hl-swatch:hover{transform:scale(1.15)}
.atl-hl-sep{width:1px;align-self:stretch;margin:2px 0;background:rgba(255,255,255,.18)}
.atl-hl-btn{all:unset;display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:7px;color:#e5e7eb;background:rgba(255,255,255,.08);cursor:pointer;font:13px/1.2 system-ui,sans-serif;white-space:nowrap}
.atl-hl-btn:hover{background:rgba(255,255,255,.18)}
.atl-hl-btn-danger:hover{background:rgba(248,113,113,.28);color:#fecaca}
.atl-hl-popover{max-width:300px;padding:11px 13px;border-radius:12px}
.atl-hl-note{margin:0 0 9px;white-space:pre-wrap;word-break:break-word}
.atl-hl-note.empty{color:#94a3b8;font-style:italic}
.atl-hl-actions{display:flex;flex-wrap:wrap;gap:6px}
.atl-hl-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);z-index:2147483647;padding:8px 14px;border-radius:9px;background:#1f2430;color:#e5e7eb;box-shadow:0 8px 24px rgba(0,0,0,.32);font:13px/1.3 system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}
.atl-hl-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media (prefers-reduced-motion:reduce){.atl-hl-swatch,.atl-hl-toast{transition:none}mark.${MARK_CLASS}.atl-hl-flash{animation:none}}
`;
  (document.head ?? document.documentElement).appendChild(style);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A reset button styled as one of our chrome pills. */
function mkButton(label: string, extraClass?: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = extraClass ? `atl-hl-btn ${extraClass}` : "atl-hl-btn";
  btn.textContent = label;
  return btn;
}

/** Show a brief bottom-centered toast (the content script has no badge surface). */
function toast(message: string): void {
  let el = document.querySelector<HTMLElement>(".atl-hl-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = `${UI_CLASS} atl-hl-toast`;
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove("show"), 1600);
}

/** The active selection Range, or null when empty / inside our own chrome. */
function currentSelectionRange(): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!sel.toString().trim()) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (el?.closest(`.${UI_CLASS}`)) return null;
  return range;
}

// ---------------------------------------------------------------------------
// Selection toolbar
// ---------------------------------------------------------------------------

/** Lazily build the selection toolbar: color swatches + note + Obsidian. */
function ensureToolbar(): HTMLDivElement {
  if (toolbar) return toolbar;
  const bar = document.createElement("div");
  bar.className = `${UI_CLASS} atl-hl-toolbar`;
  // Keep the selection alive while the learner clicks a control.
  bar.addEventListener("mousedown", (event) => event.preventDefault());
  for (const color of HIGHLIGHT_COLORS) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "atl-hl-swatch";
    dot.style.backgroundColor = color.value;
    dot.title = t("content.highlight");
    dot.addEventListener("click", () => void createHighlight(color.id, false, false));
    bar.appendChild(dot);
  }
  const sep = document.createElement("span");
  sep.className = "atl-hl-sep";
  bar.appendChild(sep);
  const noteBtn = mkButton(t("content.note"));
  noteBtn.addEventListener("click", () => void createHighlight(DEFAULT_HIGHLIGHT_COLOR, true, false));
  const obsBtn = mkButton(t("content.toObsidian"));
  obsBtn.addEventListener("click", () => void createHighlight(DEFAULT_HIGHLIGHT_COLOR, false, true));
  bar.append(noteBtn, obsBtn);
  document.body.appendChild(bar);
  toolbar = bar;
  return bar;
}

/** Show the toolbar above the selection (below it when there is no room). */
function positionToolbar(range: Range): void {
  const bar = ensureToolbar();
  bar.style.display = "flex";
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideToolbar();
    return;
  }
  const barRect = bar.getBoundingClientRect();
  const viewWidth = document.documentElement.clientWidth;
  let top = window.scrollY + rect.top - barRect.height - 8;
  if (top < window.scrollY + 4) top = window.scrollY + rect.bottom + 8;
  let left = window.scrollX + rect.left;
  const maxLeft = window.scrollX + viewWidth - barRect.width - 8;
  if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
  bar.style.top = `${top}px`;
  bar.style.left = `${left}px`;
}

function hideToolbar(): void {
  if (toolbar) toolbar.style.display = "none";
}

// ---------------------------------------------------------------------------
// Creating highlights
// ---------------------------------------------------------------------------

/**
 * Persist and paint a highlight for the current selection. Always saves it on
 * the page; optionally prompts for a note and/or also ships it to Obsidian.
 */
async function createHighlight(
  color: HighlightColorId,
  withNote: boolean,
  alsoObsidian: boolean
): Promise<void> {
  const range = lastRange ?? currentSelectionRange();
  if (!range) {
    window.alert(t("content.needSelection"));
    return;
  }
  const map = buildTextMap();
  const described = selectorFromRange(map, range, ANCHOR_CONTEXT);
  if (!described) return;
  const selector: CaptureSelection = { ...described.selector };
  if (withNote) {
    const note = (window.prompt(t("content.notePrompt")) ?? "").trim();
    if (note) selector.note = note;
  }
  const stored = toStoredHighlight(selector, color);
  suppressSync = true;
  await addHighlight(location.href, stored);
  paintAnchor(map, described.anchor, stored.id, colorValue(color), Boolean(stored.note));
  resolved.add(stored.id);
  hideToolbar();
  window.getSelection()?.removeAllRanges();
  lastRange = null;
  if (alsoObsidian) await sendToObsidian(selector);
  else toast(t("content.highlightSaved"));
  window.setTimeout(() => {
    suppressSync = false;
  }, 50);
}

/** Ship a selection to the service worker for the Obsidian capture channel. */
async function sendToObsidian(selection: CaptureSelection): Promise<void> {
  const message: SelectionMessage = {
    type: "selection",
    selection,
    url: location.href,
    title: document.title
  };
  await chrome.runtime.sendMessage(message);
}

// ---------------------------------------------------------------------------
// Restoring highlights on load
// ---------------------------------------------------------------------------

/**
 * Re-anchor and paint every saved highlight not yet resolved. Rebuilds the text
 * map per highlight because painting mutates the DOM. Retries a few times for
 * pages whose content streams in after document_idle.
 */
async function restore(attempt: number): Promise<void> {
  const list = await loadHighlights(location.href);
  if (list.length === 0) return;
  for (const hl of list) {
    if (resolved.has(hl.id)) continue;
    const map = buildTextMap();
    const anchor = locate(map, hl);
    if (!anchor) continue;
    const marks = paintAnchor(map, anchor, hl.id, colorValue(hl.color), Boolean(hl.note));
    if (marks.length) resolved.add(hl.id);
  }
  const stillPending = list.some((hl) => !resolved.has(hl.id));
  if (stillPending && attempt < 3) {
    window.setTimeout(() => void restore(attempt + 1), 500 * (attempt + 1));
  }
}

/** Drop every painted mark and re-anchor from scratch (after an external change). */
async function resync(): Promise<void> {
  clearMarks();
  resolved.clear();
  hidePopover();
  await restore(0);
}

// ---------------------------------------------------------------------------
// Existing-highlight popover
// ---------------------------------------------------------------------------

/** Look up the stored highlight for a clicked mark and open its popover. */
async function openPopoverFor(mark: HTMLElement): Promise<void> {
  const id = mark.dataset.atlHl;
  if (!id) return;
  const hl = (await loadHighlights(location.href)).find((h) => h.id === id);
  if (hl) showPopover(mark, hl);
}

/** Render the manage-highlight popover: note + edit / copy / Obsidian / remove. */
function showPopover(anchorEl: HTMLElement, hl: StoredHighlight): void {
  hidePopover();
  const pop = document.createElement("div");
  pop.className = `${UI_CLASS} atl-hl-popover`;
  const note = document.createElement("p");
  note.className = hl.note ? "atl-hl-note" : "atl-hl-note empty";
  note.textContent = hl.note ?? t("content.noteEmpty");
  const actions = document.createElement("div");
  actions.className = "atl-hl-actions";
  const edit = mkButton(t("content.editNote"));
  edit.addEventListener("click", () => void editNote(hl));
  const copy = mkButton(t("content.copy"));
  copy.addEventListener("click", () => void copyText(hl, copy));
  const obs = mkButton(t("content.toObsidian"));
  obs.addEventListener("click", () => {
    void sendToObsidian(toSelection(hl));
    hidePopover();
  });
  const remove = mkButton(t("content.remove"), "atl-hl-btn-danger");
  remove.addEventListener("click", () => void removeStored(hl));
  actions.append(edit, copy, obs, remove);
  pop.append(note, actions);
  document.body.appendChild(pop);
  popover = pop;
  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const maxLeft = window.scrollX + document.documentElement.clientWidth - popRect.width - 8;
  const left = Math.min(window.scrollX + rect.left, Math.max(window.scrollX + 8, maxLeft));
  pop.style.top = `${window.scrollY + rect.bottom + 6}px`;
  pop.style.left = `${left}px`;
}

function hidePopover(): void {
  popover?.remove();
  popover = null;
}

/** A CaptureSelection view of a stored highlight (for the Obsidian channel). */
function toSelection(hl: StoredHighlight): CaptureSelection {
  return {
    exact: hl.exact,
    prefix: hl.prefix,
    suffix: hl.suffix,
    ...(hl.note ? { note: hl.note } : {})
  };
}

/** Prompt for a new note, persist it, and refresh the underline styling. */
async function editNote(hl: StoredHighlight): Promise<void> {
  const next = window.prompt(t("content.notePrompt"), hl.note ?? "");
  if (next === null) return;
  suppressSync = true;
  await updateHighlightNote(location.href, hl.id, next);
  const hasNote = next.trim().length > 0;
  document
    .querySelectorAll<HTMLElement>(`mark.${MARK_CLASS}[data-atl-hl="${CSS.escape(hl.id)}"]`)
    .forEach((mark) => {
      if (hasNote) mark.dataset.atlNote = "1";
      else delete mark.dataset.atlNote;
    });
  hidePopover();
  window.setTimeout(() => {
    suppressSync = false;
  }, 50);
}

/** Copy a highlight's exact text; briefly confirm on the button itself. */
async function copyText(hl: StoredHighlight, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(hl.exact);
    btn.textContent = t("content.copied");
  } catch {
    /* clipboard blocked — nothing to do */
  }
}

/** Remove a highlight from storage and unwrap its marks. */
async function removeStored(hl: StoredHighlight): Promise<void> {
  suppressSync = true;
  await removeHighlight(location.href, hl.id);
  unpaint(hl.id);
  resolved.delete(hl.id);
  hidePopover();
  window.setTimeout(() => {
    suppressSync = false;
  }, 50);
}

/** Scroll a highlight into view and flash it (popup → content focus request). */
function focusHighlight(id: string): void {
  const mark = document.querySelector<HTMLElement>(
    `mark.${MARK_CLASS}[data-atl-hl="${CSS.escape(id)}"]`
  );
  if (!mark) return;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.classList.add("atl-hl-flash");
  window.setTimeout(() => mark.classList.remove("atl-hl-flash"), 1300);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

// Reveal / hide the toolbar as the selection changes.
document.addEventListener("selectionchange", () => {
  const range = currentSelectionRange();
  if (range) {
    lastRange = range.cloneRange();
    positionToolbar(range);
  } else {
    lastRange = null;
    hideToolbar();
  }
});

// Click a highlight to manage it; click elsewhere to dismiss the popover.
document.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  const mark = target?.closest?.(`mark.${MARK_CLASS}`) as HTMLElement | null;
  if (mark?.dataset.atlHl) {
    event.preventDefault();
    void openPopoverFor(mark);
  } else if (!target?.closest?.(`.${UI_CLASS}`)) {
    hidePopover();
  }
});

// Re-sync when another context (the popup) edits this page's highlights.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || suppressSync) return;
  if (keyFor(location.href) in changes) void resync();
});

// Service-worker / popup requests.
chrome.runtime.onMessage.addListener((message: TabMessage) => {
  if (message.type === "grab-page") {
    const page: PageMessage = {
      type: "page",
      html: document.documentElement.outerHTML,
      url: location.href,
      title: document.title
    };
    void chrome.runtime.sendMessage(page);
    return;
  }
  if (message.type === "open-uri") {
    openDeepLink((message as OpenUriMessage).uri);
    return;
  }
  if (message.type === "focus-highlight") {
    focusHighlight((message as FocusHighlightMessage).id);
  }
});

/** Navigate to an obsidian:// URI via a transient anchor click. */
function openDeepLink(uri: string): void {
  const anchor = document.createElement("a");
  anchor.href = uri;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

injectStyles();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void restore(0));
} else {
  void restore(0);
}
