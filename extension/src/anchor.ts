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

/** A stored selector: the exact quote plus a little context on each side. */
export interface QuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
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

/** Find where `sel` sits on the flattened text, widest context first. */
export function locate(map: TextMap, sel: QuoteSelector): AnchorRange | null {
  const exact = sel.exact;
  if (!exact) return null;
  const prefix = sel.prefix ?? "";
  const suffix = sel.suffix ?? "";
  const attempts = [
    { probe: prefix + exact + suffix, lead: prefix.length },
    { probe: prefix + exact, lead: prefix.length },
    { probe: exact + suffix, lead: 0 },
    { probe: exact, lead: 0 }
  ];
  for (const attempt of attempts) {
    if (!attempt.probe) continue;
    const idx = map.text.indexOf(attempt.probe);
    if (idx >= 0) {
      const start = idx + attempt.lead;
      return { start, end: start + exact.length };
    }
  }
  return null;
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
      suffix: map.text.slice(end, end + context)
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
