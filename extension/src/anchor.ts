// Text anchoring: turn a stored W3C-style TextQuoteSelector back into a live DOM
// Range and paint it, and go the other way (build a selector from a fresh
// selection). The page's visible text is flattened into one string with a map
// back to the Text nodes that produced it, so offsets round-trip losslessly as
// long as the markup is stable between visits. No whitespace normalization —
// capture and locate share this exact map, so raw consistency is what matters.

/** Tags whose text never participates in anchoring. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"]);

/** Class marking our own injected chrome (toolbar / popover) — never anchored. */
export const UI_CLASS = "atl-hl-ui";

/** Class on every painted highlight fragment. */
export const MARK_CLASS = "atl-hl";

/** How much context selectors keep on each side of the exact text. */
export const ANCHOR_CONTEXT = 32;

/** One page Text node placed on the flattened text line. */
interface Segment {
  node: Text;
  start: number;
  end: number;
}

/** The whole page's visible text plus the map back to its Text nodes. */
export interface TextMap {
  text: string;
  segments: Segment[];
}

/** A resolved location on the flattened text line. */
export interface AnchorRange {
  start: number;
  end: number;
}

/** A resolved location plus how confidently it was re-anchored. */
export type LocatedAnchor = AnchorRange & {
  status: "exact" | "shifted";
};

/** A stored selector: the exact quote plus a little context on each side. */
export interface QuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
  /** Creation-time offset on the flattened text, used to disambiguate repeats. */
  start?: number;
}

/** Flatten every anchorable Text node under `root` into one string + segment map. */
export function buildTextMap(root: Node = document.body): TextMap {
  const segments: Segment[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`.${UI_CLASS}`)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let current = walker.nextNode();
  while (current) {
    const value = current.nodeValue ?? "";
    const start = text.length;
    text += value;
    segments.push({ node: current as Text, start, end: text.length });
    current = walker.nextNode();
  }
  return { text, segments };
}

/**
 * Every index where `needle` occurs in `text`, capped so a pathological page
 * (the same short probe repeated thousands of times) cannot stall anchoring.
 */
function indexOfAll(text: string, needle: string, cap = 50): number[] {
  const hits: number[] = [];
  let idx = text.indexOf(needle);
  while (idx >= 0 && hits.length < cap) {
    hits.push(idx);
    idx = text.indexOf(needle, idx + 1);
  }
  return hits;
}

/**
 * Pick the occurrence of `quote` closest to the recorded creation offset, so a
 * quote that appears several times re-anchors where it was made instead of to
 * the first repeat. Without a recorded offset the first occurrence wins (the
 * historical behavior, which stays correct for unique quotes). Callers only
 * arrive with a non-empty `hits` list.
 */
function pickHit(hits: number[], lead: number, start?: number): number {
  let best = hits[0] ?? 0;
  let bestDistance = Math.abs(best + lead - (start ?? 0));
  for (const hit of hits.slice(1)) {
    const distance = Math.abs(hit + lead - (start ?? 0));
    if (distance < bestDistance) {
      best = hit;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Find where `sel` sits on the flattened text, widest context first. The
 * result carries a status: `exact` when the fullest probe (prefix + exact +
 * suffix) matched, `shifted` when a fallback level had to stand in — a hint
 * that the page moved under the highlight and it re-anchored by position.
 * When every exact probe fails, a fuzzy pass (whitespace/case/punctuation
 * drift, then a bounded edit-distance window search) gets one more chance
 * before the highlight is written off as orphaned.
 */
export function locate(map: TextMap, sel: QuoteSelector): LocatedAnchor | null {
  const exact = sel.exact;
  if (!exact) return null;
  const prefix = sel.prefix ?? "";
  const suffix = sel.suffix ?? "";
  const attempts: Array<{ probe: string; lead: number; exact: boolean }> = [
    { probe: prefix + exact + suffix, lead: prefix.length, exact: true },
    { probe: prefix + exact, lead: prefix.length, exact: false },
    { probe: exact + suffix, lead: 0, exact: false },
    { probe: exact, lead: 0, exact: false }
  ];
  for (const attempt of attempts) {
    if (!attempt.probe) continue;
    const hits = indexOfAll(map.text, attempt.probe);
    if (hits.length === 0) continue;
    const idx = pickHit(hits, attempt.lead, sel.start);
    const start = idx + attempt.lead;
    return { start, end: start + exact.length, status: attempt.exact ? "exact" : "shifted" };
  }
  return fuzzyLocate(map, sel);
}

// ---------------------------------------------------------------------------
// Fuzzy re-anchoring
// ---------------------------------------------------------------------------

/** Highlights longer than this skip the fuzzy pass (bounded work per restore). */
const FUZZY_MAX_EXACT = 256;

/** Below this the quote carries too little signal for edit-distance matching. */
const FUZZY_MIN_EXACT = 8;

/** How much a fuzzy candidate may differ, as a share of the quote's length. */
const FUZZY_DISTANCE_SHARE = 0.2;

/** Padding on each side of the recorded offset for the window search. */
const FUZZY_WINDOW_PAD = 64;

/** Punctuation CMSes love to swap between forms; canonicalized before compare. */
const CANONICAL_PUNCT: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": ",",
  "\u201b": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-"
};

/** Page text re-spelled for fuzzy comparison, with the map back to raw offsets. */
interface NormalizedText {
  norm: string;
  /** `norm[i]` was copied from raw offset `rawAt[i]`. */
  rawAt: number[];
}

/** Lowercase, collapse whitespace runs to one space, canonicalize punctuation. */
function normalizeText(text: string): NormalizedText {
  const out: string[] = [];
  const rawAt: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const raw = text[i]!;
    const code = raw.charCodeAt(0);
    const isSpace =
      code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 8201;
    const ch = isSpace ? " " : (CANONICAL_PUNCT[raw] ?? raw.toLowerCase());
    if (ch === " ") {
      if (out.length === 0 || out[out.length - 1] === " ") continue;
      out.push(" ");
      rawAt.push(i);
    } else {
      out.push(ch);
      rawAt.push(i);
    }
  }
  if (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    rawAt.pop();
  }
  return { norm: out.join(""), rawAt };
}

/** Position in normalized space of a raw offset (largest norm i at or before it). */
function normOffsetOf(index: NormalizedText, rawOffset: number): number {
  let lo = 0;
  let hi = index.rawAt.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.rawAt[mid]! <= rawOffset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Best local alignment of `needle` inside `hay[from, to)`: the needle must
 * match in full, but the haystack side may start and end anywhere, so edits
 * around the quote cannot push it out of the window. Semiglobal Levenshtein —
 * free prefix/suffix on the haystack — with a backtrace to the start column.
 */
function bestLocalMatch(
  hay: string,
  needle: string,
  from: number,
  to: number
): { start: number; distance: number } | null {
  const m = needle.length;
  const n = to - from;
  if (m === 0 || n === 0) return null;
  const width = n + 1;
  const d = new Uint16Array((m + 1) * width);
  for (let j = 0; j <= n; j++) d[j] = 0;
  for (let i = 1; i <= m; i++) d[i * width] = i;
  for (let i = 1; i <= m; i++) {
    const ni = needle.charCodeAt(i - 1)!;
    for (let j = 1; j <= n; j++) {
      const cost = ni === hay.charCodeAt(from + j - 1) ? 0 : 1;
      const diag = d[(i - 1) * width + j - 1]! + cost;
      const del = d[(i - 1) * width + j]! + 1;
      const ins = d[i * width + j - 1]! + 1;
      d[i * width + j] = Math.min(diag, del, ins);
    }
  }
  let bestJ = 0;
  let best = Infinity;
  for (let j = 0; j <= n; j++) {
    const value = d[m * width + j]!;
    if (value < best) {
      best = value;
      bestJ = j;
    }
  }
  let i = m;
  let j = bestJ;
  while (i > 0 && j > 0) {
    const cur = d[i * width + j]!;
    const ni = needle.charCodeAt(i - 1)!;
    const same = ni === hay.charCodeAt(from + j - 1);
    if (cur === d[(i - 1) * width + j - 1]! + (same ? 0 : 1)) {
      i--;
      j--;
    } else if (cur === d[(i - 1) * width + j]! + 1) {
      i--;
    } else {
      j--;
    }
  }
  return { start: from + j, distance: best };
}

/**
 * Fuzzy re-anchoring for quotes the exact probes could not find. Level one is
 * cheap: the quote survived with whitespace/case/punctuation drift only, so it
 * matches exactly in normalized space. Level two needs the recorded creation
 * offset and searches a window around it with bounded edit distance, which
 * recovers highlights through small rewordings. Both grade `shifted` — the
 * page demonstrably moved under the highlight.
 */
export function fuzzyLocate(
  map: TextMap,
  sel: QuoteSelector
): LocatedAnchor | null {
  if (!sel.exact || sel.exact.length > FUZZY_MAX_EXACT) return null;
  const index = normalizeText(map.text);
  const needle = normalizeText(sel.exact).norm;
  if (!needle) return null;
  const hits = indexOfAll(index.norm, needle);
  if (hits.length === 1 || (hits.length > 1 && sel.start !== undefined)) {
    const start =
      hits.length === 1
        ? hits[0]!
        : pickHit(hits, 0, normOffsetOf(index, sel.start!));
    return {
      start: index.rawAt[start]!,
      end: index.rawAt[start + needle.length - 1]! + 1,
      status: "shifted"
    };
  }
  if (sel.start === undefined || needle.length < FUZZY_MIN_EXACT) return null;
  const anchorAt = normOffsetOf(index, sel.start);
  const from = Math.max(0, anchorAt - FUZZY_WINDOW_PAD);
  const to = Math.min(index.norm.length, anchorAt + needle.length + FUZZY_WINDOW_PAD);
  const match = bestLocalMatch(index.norm, needle, from, to);
  if (!match) return null;
  const budget = Math.max(1, Math.floor(needle.length * FUZZY_DISTANCE_SHARE));
  if (match.distance > budget) return null;
  return {
    start: index.rawAt[match.start]!,
    end: index.rawAt[Math.min(match.start + needle.length - 1, index.rawAt.length - 1)]! + 1,
    status: "shifted"
  };
}

/** Global offset of a (node, offset) DOM position on the flattened text line. */
function globalOffset(map: TextMap, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const seg = map.segments.find((s) => s.node === node);
    return seg ? seg.start + offset : null;
  }
  const child = node.childNodes[offset] ?? node.childNodes[offset - 1] ?? null;
  if (child && child.nodeType === Node.TEXT_NODE) {
    const seg = map.segments.find((s) => s.node === child);
    if (seg) return seg.start;
  }
  return null;
}

/** Build a stored selector + its exact offsets from a live selection Range. */
export function selectorFromRange(
  map: TextMap,
  range: Range,
  context: number
): { selector: QuoteSelector; anchor: AnchorRange } | null {
  const start = globalOffset(map, range.startContainer, range.startOffset);
  const end = globalOffset(map, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return {
    selector: {
      exact: map.text.slice(start, end),
      prefix: map.text.slice(Math.max(0, start - context), start),
      suffix: map.text.slice(end, end + context),
      start
    },
    anchor: { start, end }
  };
}

/** Wrap `[from, to)` of a Text node in a highlight <mark>; returns it or null. */
function wrapPortion(
  node: Text,
  from: number,
  to: number,
  id: string,
  color: string,
  hasNote: boolean
): HTMLElement | null {
  const len = node.nodeValue?.length ?? 0;
  const lo = Math.max(0, from);
  const hi = Math.min(len, to);
  if (lo >= hi) return null;
  let target = node;
  if (lo > 0) target = target.splitText(lo);
  if (hi - lo < (target.nodeValue?.length ?? 0)) target.splitText(hi - lo);
  const mark = document.createElement("mark");
  mark.className = MARK_CLASS;
  mark.dataset.atlHl = id;
  if (hasNote) mark.dataset.atlNote = "1";
  mark.style.backgroundColor = color;
  target.parentNode?.insertBefore(mark, target);
  mark.appendChild(target);
  return mark;
}

/**
 * Paint every Text node overlapping `anchor`. Mutates the DOM, so callers that
 * paint several anchors must rebuild the text map between each call.
 */
export function paintAnchor(
  map: TextMap,
  anchor: AnchorRange,
  id: string,
  color: string,
  hasNote: boolean
): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (const seg of map.segments) {
    if (seg.end <= anchor.start || seg.start >= anchor.end) continue;
    const from = Math.max(anchor.start, seg.start) - seg.start;
    const to = Math.min(anchor.end, seg.end) - seg.start;
    const mark = wrapPortion(seg.node, from, to, id, color, hasNote);
    if (mark) marks.push(mark);
  }
  return marks;
}

/** Unwrap the fragments of one highlight, restoring plain text. */
export function unpaint(id: string): void {
  const marks = document.querySelectorAll(
    `mark.${MARK_CLASS}[data-atl-hl="${CSS.escape(id)}"]`
  );
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    (parent as Element).normalize?.();
  });
}

/** Remove every painted highlight from the page (used before a full re-sync). */
export function clearMarks(): void {
  const marks = document.querySelectorAll(`mark.${MARK_CLASS}`);
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    (parent as Element).normalize?.();
  });
}
