// On-page annotation store. Every highlight the learner makes is saved to
// chrome.storage.local keyed by the (fragment-stripped) page URL, so it survives
// reloads: on the next visit the content script re-anchors each saved selector
// and repaints it. This is independent of the Obsidian capture channel —
// annotating still ships the selection to the vault, and now also persists the
// highlight here on the page so it is never lost.

import type { CaptureSelection } from "./protocol.js";

/** Preset highlight colors offered in the selection toolbar. */
export const HIGHLIGHT_COLORS = [
  { id: "yellow", value: "#fde68a" },
  { id: "green", value: "#bbf7d0" },
  { id: "blue", value: "#bfdbfe" },
  { id: "pink", value: "#fbcfe8" }
] as const;

export type HighlightColorId = (typeof HIGHLIGHT_COLORS)[number]["id"];

/** The color a note-annotation defaults to (the note flow doesn't pick one). */
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColorId = "yellow";

/** One persisted on-page highlight: a TextQuoteSelector plus presentation. */
export interface StoredHighlight {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  note?: string;
  color: HighlightColorId;
  createdAt: string;
}

const KEY_PREFIX = "atl-hl::";

/** Resolve a color id to its CSS value, defaulting to the first swatch. */
export function colorValue(id: HighlightColorId): string {
  return HIGHLIGHT_COLORS.find((c) => c.id === id)?.value ?? HIGHLIGHT_COLORS[0].value;
}

/** Strip the fragment so in-page anchors (#section) share one URL bucket. */
export function normalizeUrl(href: string): string {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href;
  } catch {
    return href;
  }
}

/** The chrome.storage.local key that holds every highlight for `url`. */
export function keyFor(url: string): string {
  return `${KEY_PREFIX}${normalizeUrl(url)}`;
}

/** All highlights saved for `url` (empty on none / any read error). */
export async function loadHighlights(url: string): Promise<StoredHighlight[]> {
  try {
    const key = keyFor(url);
    const stored = await chrome.storage.local.get(key);
    const list = stored[key];
    return Array.isArray(list) ? (list as StoredHighlight[]) : [];
  } catch {
    return [];
  }
}

async function writeHighlights(url: string, list: StoredHighlight[]): Promise<void> {
  const key = keyFor(url);
  if (list.length === 0) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({ [key]: list });
}

/** Append a highlight for `url`; returns the updated list. */
export async function addHighlight(
  url: string,
  hl: StoredHighlight
): Promise<StoredHighlight[]> {
  const list = await loadHighlights(url);
  list.push(hl);
  await writeHighlights(url, list);
  return list;
}

/** Remove one highlight by id; returns the updated list. */
export async function removeHighlight(
  url: string,
  id: string
): Promise<StoredHighlight[]> {
  const list = (await loadHighlights(url)).filter((h) => h.id !== id);
  await writeHighlights(url, list);
  return list;
}

/** Replace one highlight's note (empty clears it); returns the updated list. */
export async function updateHighlightNote(
  url: string,
  id: string,
  note: string
): Promise<StoredHighlight[]> {
  const list = await loadHighlights(url);
  const target = list.find((h) => h.id === id);
  if (target) {
    const trimmed = note.trim();
    if (trimmed) target.note = trimmed;
    else delete target.note;
  }
  await writeHighlights(url, list);
  return list;
}

/** Clear every highlight saved for `url`. */
export async function clearHighlights(url: string): Promise<void> {
  await chrome.storage.local.remove(keyFor(url));
}

/** A short random id; local-only, so no crypto strength is needed. */
export function newHighlightId(): string {
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a StoredHighlight from a capture selector plus a chosen color. */
export function toStoredHighlight(
  selector: CaptureSelection,
  color: HighlightColorId
): StoredHighlight {
  return {
    id: newHighlightId(),
    exact: selector.exact,
    prefix: selector.prefix,
    suffix: selector.suffix,
    ...(selector.note ? { note: selector.note } : {}),
    color,
    createdAt: new Date().toISOString()
  };
}
