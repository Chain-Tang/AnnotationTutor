// Pure decoration planning, independent of the Obsidian and CodeMirror view
// runtimes, so source locations can be tested without an editor DOM. `decorations.ts` turns these plans into real CM6 ranges.

import type { Text } from "@codemirror/state";
import type { AnnotationBranch, AnnotationRequest, DialogueTurn } from "./model.js";
import type { HighlightStyle } from "./settings.js";
import { findTableInLines } from "./editor.js";

export type AnchorMark = {
  id: string;
  blockId: string;
  selectedText: string;
  /** Note summary, shown in margin comment cards. */
  note?: string;
  /** Annotation status, for the card's status accent. */
  status?: string;
  /** Agent review comment, shown quietly under the note. */
  review?: string;
  /** The review's Socratic question, shown as a distinct prompt under the comment. */
  reviewQuestion?: string;
  /** In-annotation dialogue turns, rendered as a thread in the margin card. */
  dialogue?: DialogueTurn[];
  /** Conversation children share their root's source anchor, without decorating it. */
  branch?: AnnotationBranch;
  request?: AnnotationRequest;
  dialogueRequest?: AnnotationRequest;
  sourceFile?: string;
};

export type DecoPlan =
  | { kind: "style"; from: number; to: number; className: string; id?: string }
  // A clickable marker placed as a point widget right after an annotation's span.
  // `side` orders it relative to neighbouring content (1 = after, -1 = before).
  | { kind: "marker"; pos: number; id: string; side: number }
  // Hide the raw ` ^block-id` token (the markers take over its clickable role).
  | { kind: "hide"; from: number; to: number };

// Tables use a standalone block-id line (`^id`) because putting the token after
// the final pipe changes the table's column structure. Ordinary blocks keep the
// trailing form (`text ^id`). Support both throughout decoration planning.
export const BLOCK_ID_SUFFIX = /(?:^|\s+)\^([A-Za-z0-9_-]+)\s*$/;

// A heading bounds a block (mirrors editor.ts), so the block search never walks
// up into a preceding heading's text.
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

// Leading block markup on a (continuation) line that the captured selection
// omits: indentation, blockquote markers (possibly nested), and a list marker.
// In Live Preview these are hidden, so `editor.getSelection()` returns the bare
// content; the source line still carries them. Stripping this prefix lets a
// multi-line selection inside a list or quote match its continuation lines.
const LINE_PREFIX = /^[ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+[.)][ \t]+)?/;

const STYLE_CLASS: Record<Exclude<HighlightStyle, "none">, string> = {
  "dotted-underline": "atl-hl-dotted",
  "wavy-underline": "atl-hl-wavy",
  background: "atl-hl-bg",
  bold: "atl-hl-bold"
};

/** The CSS class for a highlight style, or null when styling is disabled. */
export function styleClass(style: HighlightStyle): string | null {
  return style === "none" ? null : STYLE_CLASS[style];
}

export type AnnotationLocationPlan = {
  readonly spanById: ReadonlyMap<string, { readonly from: number; readonly to: number }>;
  readonly blockEndById: ReadonlyMap<string, number>;
  readonly tableIds: ReadonlySet<string>;
  readonly plans: readonly DecoPlan[];
};

// Text is immutable. Weak keys let closed or replaced editor buffers be collected;
// one marks version per buffer prevents card edits accumulating cached plans.
const locationCache = new WeakMap<Text, { key: string; plan: AnnotationLocationPlan }>();
const emptyLocationPlan: AnnotationLocationPlan = {
  spanById: new Map(), blockEndById: new Map(), tableIds: new Set(), plans: []
};

/** Shared source locations, independent of style, card expansion or viewport. */
export function annotationLocations(doc: Text, marks: readonly AnchorMark[]): AnnotationLocationPlan {
  if (marks.length === 0) return emptyLocationPlan;
  // Card note/review/dialogue changes do not affect source positions. Preserve
  // ordering because duplicate selections resolve in annotation reading order.
  const key = JSON.stringify(marks.map(mark => [mark.id, mark.blockId, mark.selectedText]));
  const cached = locationCache.get(doc);
  if (cached?.key === key) return cached.plan;
  const blockEndById = new Map<string, number>();
  const plans = buildLocationPlans(doc, marks, blockEndById);
  const spanById = new Map<string, { from: number; to: number }>();
  for (const plan of plans) if (plan.kind === "style" && plan.id && !spanById.has(plan.id)) {
    spanById.set(plan.id, { from: plan.from, to: plan.to });
  }
  const tableIds = new Set<string>();
  // Table membership is source work too. Compute it once with the locations,
  // rather than rebuilding the entire string on every scroll/selection event.
  const lines = Array.from({ length: doc.lines }, (_, index) => doc.line(index + 1).text);
  const tableByLine = new Map<number, boolean>();
  for (const [id, span] of spanById) {
    const line = doc.lineAt(span.from).number - 1;
    let table = tableByLine.get(line);
    if (table === undefined) {
      table = findTableInLines(lines, line) !== null;
      tableByLine.set(line, table);
    }
    if (table) tableIds.add(id);
  }
  const plan = { spanById, blockEndById, tableIds, plans };
  locationCache.set(doc, { key, plan });
  return plan;
}

/**
 * Decide which decorations a document needs, as plain descriptors:
 * an inline style hugging each annotated span, a "hide" descriptor that removes
 * the raw ` ^id` token, and — only when there is no highlight to click — a
 * clickable marker glyph. With a highlight on, the underline/background itself is
 * the comment toggle, so no glyph is drawn; one glyph per annotation otherwise.
 */
export function planDecorations(
  doc: Text,
  marks: readonly AnchorMark[],
  style: HighlightStyle,
  showMarker: boolean
): DecoPlan[] {
  const className = styleClass(style);
  const plans: DecoPlan[] = [];
  for (const plan of annotationLocations(doc, marks).plans) {
    if (plan.kind === "style") {
      if (className) plans.push({ ...plan, className });
    } else if (plan.kind === "hide") {
      if (showMarker) plans.push({ ...plan });
    } else if (showMarker && style === "none") plans.push({ ...plan });
  }
  return plans;
}

function buildLocationPlans(
  doc: Text,
  marks: readonly AnchorMark[],
  blockEndById: Map<string, number>
): DecoPlan[] {
  // A paragraph can carry several annotations that share one block id, so group
  // them: each annotation underlines its own selected span.
  const byBlockId = new Map<string, AnchorMark[]>();
  for (const mark of marks) {
    const list = byBlockId.get(mark.blockId);
    if (list) list.push(mark);
    else byBlockId.set(mark.blockId, [mark]);
  }
  // Cache both highlight and glyph positions; presentation chooses which to use.
  const className = STYLE_CLASS.background;
  const plans: DecoPlan[] = [];
  const anchored = new Set<string>();

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const match = BLOCK_ID_SUFFIX.exec(line.text);
    if (!match) continue;
    const blockMarks = byBlockId.get(match[1] ?? "");
    const first = blockMarks?.[0];
    if (!blockMarks || !first) continue;
    for (const mark of blockMarks) {
      anchored.add(mark.id);
      blockEndById.set(mark.id, line.to);
    }
    const suffixStart = line.from + match.index;

    // The block id sits on the last line of a (possibly multi-line) block, but a
    // selection can live on any line of it. Walk up to the block start so we
    // search every line, matching the Reading-view path which scans the whole
    // rendered block.
    let blockStart = lineNumber;
    while (
      blockStart > 1 &&
      doc.line(blockStart - 1).text.trim() !== "" &&
      !HEADING.test(doc.line(blockStart - 1).text)
    ) {
      blockStart -= 1;
    }

    // Per-text cursor (line + char) so repeated phrases and multiple selections
    // in the same block each resolve to a distinct, non-overlapping span,
    // advancing in reading order across the block's lines. Spans are located
    // even when styling is off, so a marker can still sit at the span's end.
    const cursor = new Map<string, { line: number; ch: number }>();
    let anyMatched = false;
    for (const mark of blockMarks) {
      if (!mark.selectedText) continue;
      const start = cursor.get(mark.selectedText) ?? { line: blockStart, ch: 0 };
      // The selection may span several lines (e.g. two sentences split by a soft
      // line break with no blank line between them). locateSpan resolves it to a
      // single range hugging the whole selection, not just its last line.
      const span = locateSpan(doc, start.line, start.ch, lineNumber, mark.selectedText);
      if (!span) continue;
      cursor.set(mark.selectedText, { line: span.endLine, ch: span.endCh });
      plans.push({ kind: "style", from: span.from, to: span.to, className, id: mark.id });
      {
        // Sit the marker right after the span. When it abuts the trailing ` ^id`
        // (e.g. a whole-sentence selection), clamp to the id's start and order it
        // before the hidden token (side -1).
        const pos = Math.min(span.to, suffixStart);
        plans.push({ kind: "marker", pos, id: mark.id, side: span.to >= suffixStart ? -1 : 1 });
      }
      anyMatched = true;
    }

    if (!anyMatched) {
      // No selected text located anywhere in the block (drift, inline
      // formatting): underline the block-id line up to the id and tag it with the
      // annotation id so it stays the clickable toggle; add a glyph only when
      // there is no highlight to click.
      if (suffixStart > line.from) {
        plans.push({ kind: "style", from: line.from, to: suffixStart, className, id: first.id });
      }
      plans.push({ kind: "marker", pos: suffixStart, id: first.id, side: -1 });
    }

    // Hide the raw ` ^id` token; the highlight (or glyph) takes over its role.
    plans.push({ kind: "hide", from: suffixStart, to: line.to });
  }

  // Table annotations deliberately keep their logical id out of the source.
  // Also recovers highlights if an external formatter removed a block id.
  const cursors = new Map<string, { line: number; ch: number }>();
  for (const mark of marks) {
    if (anchored.has(mark.id) || !mark.selectedText) continue;
    const start = cursors.get(mark.selectedText) ?? { line: 1, ch: 0 };
    const span = locateSpan(doc, start.line, start.ch, doc.lines, mark.selectedText);
    if (!span) continue;
    cursors.set(mark.selectedText, { line: span.endLine, ch: span.endCh });
    plans.push({ kind: "style", from: span.from, to: span.to, className, id: mark.id });
    plans.push({ kind: "marker", pos: span.to, id: mark.id, side: 1 });
  }
  plans.sort((a, b) => planStart(a) - planStart(b));
  return plans;
}

/** The document position a plan starts at, for a stable ordering. */
function planStart(plan: DecoPlan): number {
  return plan.kind === "marker" ? plan.pos : plan.from;
}

/**
 * Locate `selectedText` within the block's line range `[startLine .. lastLine]`,
 * resuming from `startCh` on `startLine`. Returns the absolute `from`/`to`
 * offsets of the whole selection plus the cursor position just past it, or null
 * if it is not found.
 *
 * A single-line selection is matched with `indexOf` (so a phrase anywhere on a
 * line is found). A multi-line selection — the learner picked text that crosses
 * one or more soft line breaks, with no blank line between (a blank line is its
 * own block and is blocked at creation) — is matched piecewise: the first part
 * is the tail of its line, any middle parts are whole lines, and the last part
 * is the head of its line (its trailing ` ^id` may follow). The resulting range
 * spans the newlines, which a CodeMirror `Decoration.mark` handles natively.
 */
function locateSpan(
  doc: Text,
  startLine: number,
  startCh: number,
  lastLine: number,
  selectedText: string
): { from: number; to: number; endLine: number; endCh: number } | null {
  const parts = selectedText.split("\n");
  if (parts.length === 1) {
    for (let ln = startLine; ln <= lastLine; ln += 1) {
      const lineObj = doc.line(ln);
      const index = lineObj.text.indexOf(selectedText, ln === startLine ? startCh : 0);
      if (index < 0) continue;
      const endCh = index + selectedText.length;
      return { from: lineObj.from + index, to: lineObj.from + endCh, endLine: ln, endCh };
    }
    return null;
  }

  const span = parts.length;
  const first = parts[0] ?? "";
  const last = parts[span - 1] ?? "";
  for (let ln = startLine; ln + span - 1 <= lastLine; ln += 1) {
    const firstLine = doc.line(ln);
    const c = firstLine.text.length - first.length;
    if (c < (ln === startLine ? startCh : 0)) continue;
    if (firstLine.text.slice(c) !== first) continue;
    let ok = true;
    for (let k = 1; k < span - 1; k += 1) {
      if (!lineMatchesWhole(doc.line(ln + k).text, parts[k] ?? "")) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const lastLineObj = doc.line(ln + span - 1);
    const lastEnd = matchLineHead(lastLineObj.text, last);
    if (lastEnd === null) continue;
    return {
      from: firstLine.from + c,
      to: lastLineObj.from + lastEnd,
      endLine: ln + span - 1,
      endCh: lastEnd
    };
  }
  return null;
}

/** Length of the leading block-markup prefix on a line (0 when there is none). */
function markupPrefixLen(lineText: string): number {
  return LINE_PREFIX.exec(lineText)?.[0].length ?? 0;
}

/**
 * Whether a continuation line's whole content equals `part`. Tolerates leading
 * block markup (blockquote/list/indent) the captured selection omits, but only
 * after an exact match fails — so a line whose real content starts with `-`/`>`
 * (and was selected with it) still matches by its literal text.
 */
function lineMatchesWhole(lineText: string, part: string): boolean {
  if (lineText === part) return true;
  const prefix = markupPrefixLen(lineText);
  return prefix > 0 && lineText.slice(prefix) === part;
}

/**
 * The offset just past `part` when it is the head of a continuation line, or null
 * when it is not. Tries a literal head match first, then one past a leading
 * block-markup prefix, so list/quote continuation lines resolve correctly.
 */
function matchLineHead(lineText: string, part: string): number | null {
  if (lineText.slice(0, part.length) === part) return part.length;
  const prefix = markupPrefixLen(lineText);
  if (prefix > 0 && lineText.slice(prefix, prefix + part.length) === part) {
    return prefix + part.length;
  }
  return null;
}
