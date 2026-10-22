// Content script: the only context with the live page DOM. It owns the on-page
// annotation experience end to end — a selection toolbar for highlighting and
// note-taking, persistence of every highlight to chrome.storage.local keyed by
// URL, re-anchoring and repainting saved highlights on each visit, and a small
// popover to manage an existing highlight. It still ships selections to Obsidian
// via the service worker, but the highlight also stays on the page for good.
// The in-page tutor overlay lives in ask-overlay.ts on the same plumbing.

import { t, initI18n } from "./i18n/index.js";
import type {
  FocusHighlightMessage,
  OpenUriMessage,
  PageMessage,
  TabMessage
} from "./messages.js";
import type { CaptureSelection } from "./protocol.js";
import {
  ANCHOR_CONTEXT,
  buildTextMap,
  clearMarks,
  locate,
  MARK_CLASS,
  paintAnchor,
  selectorFromRange,
  UI_CLASS,
  unpaint,
  type TextMap
} from "./anchor.js";
import { buildSnapshotHtml } from "./snapshot.js";
import {
  addHighlight,
  colorValue,
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  keyFor,
  loadHighlights,
  removeHighlight,
  saveHighlightStatuses,
  toSelection,
  toStoredHighlight,
  updateHighlightNote,
  type HighlightColorId,
  type HighlightStatus,
  type StoredHighlight
} from "./highlights.js";
import {
  currentSelectionRange,
  injectChromeStyles,
  mkButton,
  sendToObsidian,
  toast
} from "./ui.js";
import { handleAskProgress, openAskPanel } from "./ask-overlay.js";

/** Ids we have already painted this page load; drives the restore retry loop. */
const resolved = new Set<string>();

/** When true, ignore our own storage writes so we don't re-sync over live paint. */
let suppressSync = false;

let toolbar: HTMLDivElement | null = null;
let popover: HTMLDivElement | null = null;
let lastRange: Range | null = null;

// ---------------------------------------------------------------------------
// Selection toolbar
// ---------------------------------------------------------------------------

/** Lazily build the selection toolbar: color swatches + note + Obsidian + ask. */
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
  const askBtn = mkButton(t("content.ask"));
  askBtn.addEventListener("click", () => {
    hideToolbar();
    void openAskPanel(lastRange ?? currentSelectionRange());
  });
  bar.append(noteBtn, obsBtn, askBtn);
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
  const selector: CaptureSelection = {
    exact: described.selector.exact,
    prefix: described.selector.prefix,
    suffix: described.selector.suffix
  };
  // Ask for the note BEFORE building the stored record, or it would only ride
  // the wire payload and vanish from the page on the next visit.
  if (withNote) {
    const note = (window.prompt(t("content.notePrompt")) ?? "").trim();
    if (note) selector.note = note;
  }
  const stored = toStoredHighlight(
    { ...selector, start: described.selector.start },
    color
  );
  suppressSync = true;
  await addHighlight(location.href, stored);
  paintAnchor(map, described.anchor, stored.id, colorValue(color), Boolean(stored.note));
  resolved.add(stored.id);
  hideToolbar();
  window.getSelection()?.removeAllRanges();
  lastRange = null;
  if (alsoObsidian) await sendToObsidian([selector]);
  else toast(t("content.highlightSaved"));
  window.setTimeout(() => {
    suppressSync = false;
  }, 50);
}

// ---------------------------------------------------------------------------
// Restoring highlights on load
// ---------------------------------------------------------------------------

/**
 * Re-anchor and paint every saved highlight not yet resolved. Rebuilds the text
 * map per highlight because painting mutates the DOM. Retries a few times for
 * pages whose content streams in after document_idle; only once the retries
 * run out does an unresolved highlight get marked orphaned, so late-streaming
 * content is not misjudged. Anchoring outcomes are written back so the popup
 * can show drift instead of letting a lost highlight vanish silently.
 */
async function restore(attempt: number): Promise<void> {
  const list = await loadHighlights(location.href);
  if (list.length === 0) return;
  const statuses: Record<string, HighlightStatus> = {};
  let dirty = false;
  // The map is only stale once a paint splits Text nodes; failed locates and
  // empty paints leave the DOM untouched, so one build serves many highlights
  // (and the whole retry pass, for pages that resolve nothing yet).
  let map: TextMap | null = null;
  for (const hl of list) {
    if (resolved.has(hl.id)) continue;
    if (!map) map = buildTextMap();
    const located = locate(map, hl);
    if (located) {
      const marks = paintAnchor(map, located, hl.id, colorValue(hl.color), Boolean(hl.note));
      if (marks.length) {
        map = null;
        resolved.add(hl.id);
        if (hl.status !== located.status) {
          statuses[hl.id] = located.status;
          dirty = true;
        }
      }
      continue;
    }
    if (attempt >= 3 && hl.status !== "orphaned") {
      statuses[hl.id] = "orphaned";
      dirty = true;
    }
  }
  if (dirty) {
    suppressSync = true;
    await saveHighlightStatuses(location.href, statuses);
    window.setTimeout(() => {
      suppressSync = false;
    }, 50);
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
    void sendToObsidian([toSelection(hl)]);
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

// Service-worker / popup requests. Each branch answers the port explicitly so
// the sender's await settles cleanly (a listener that never calls sendResponse
// makes older Chrome reject with "message port closed").
chrome.runtime.onMessage.addListener((message: TabMessage, _sender, sendResponse) => {
  if (message.type === "grab-page") {
    void (async () => {
      // Ride the page archive with the learner's highlights so the Obsidian
      // note can list them; all saved highlights count, orphaned ones included —
      // the page copy here is what the learner saw, anchor drift aside.
      const stored = await loadHighlights(location.href);
      const selections = stored.map(toSelection);
      const page: PageMessage = {
        type: "page",
        html: buildSnapshotHtml(document),
        url: location.href,
        title: document.title,
        ...(selections.length > 0 ? { selections } : {})
      };
      const result = await chrome.runtime.sendMessage(page) as { ok?: boolean };
      toast(t(result?.ok ? "content.sent" : "content.captureFailed"));
    })();
    sendResponse();
    return;
  }
  if (message.type === "open-uri") {
    openDeepLink((message as OpenUriMessage).uri);
    sendResponse();
    return;
  }
  if (message.type === "focus-highlight") {
    focusHighlight((message as FocusHighlightMessage).id);
    sendResponse();
    return;
  }
  if (message.type === "sync-highlights") {
    void (async () => {
      const stored = await loadHighlights(location.href);
      if (stored.length === 0) {
        toast(t("content.noHighlights"));
        return;
      }
      // One capture carries the whole page's highlights; the plugin writes them
      // as sibling quote blocks in a single note instead of forking per item.
      await sendToObsidian(stored.map(toSelection));
    })();
    sendResponse();
    return;
  }
  if (
    message.type === "ask-delta" ||
    message.type === "ask-done" ||
    message.type === "ask-error"
  ) {
    handleAskProgress(message);
    sendResponse();
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

// Apply the saved language preference before any UI paints (fire-and-forget:
// the storage read resolves in milliseconds, well before the first toolbar).
void initI18n();
injectChromeStyles();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void restore(0));
} else {
  void restore(0);
}
