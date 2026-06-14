// Pure decoration planning, deliberately free of any runtime imports (only
// erased `import type`s), so it can be unit-tested without an Obsidian or
// CodeMirror runtime. `decorations.ts` turns these plans into real CM6 ranges.

import type { Text } from "@codemirror/state";
import type { HighlightStyle } from "./settings.js";

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
};

export type DecoPlan =
  | { kind: "style"; from: number; to: number; className: string; id?: string }
  // A clickable marker placed as a point widget right after an annotation's span.
  // `side` orders it relative to neighbouring content (1 = after, -1 = before).
  | { kind: "marker"; pos: number; id: string; side: number }
  // Hide the raw ` ^block-id` token (the markers take over its clickable role).
  | { kind: "hide"; from: number; to: number };

export const BLOCK_ID_SUFFIX = /\s+\^([A-Za-z0-9_-]+)\s*$/;

// A heading bounds a block (mirrors editor.ts), so the block search never walks
// up into a preceding heading's text.
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

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

/**
 * Decide which decorations a document needs, as plain descriptors:
 * an inline style hugging each annotated span, a clickable marker placed at the
 * end of each annotation's span, and a "hide" descriptor that removes the raw
 * ` ^id` token. One marker per annotation, so several comments in one paragraph
 * each get their own marker (not a single shared one at the line end).
 */
export function planDecorations(
  doc: Text,
  marks: AnchorMark[],
  style: HighlightStyle,
  showMarker: boolean
): DecoPlan[] {
  // A paragraph can carry several annotations that share one block id, so group
  // them: each annotation underlines its own selected span.
  const byBlockId = new Map<string, AnchorMark[]>();
  for (const mark of marks) {
    const list = byBlockId.get(mark.blockId);
    if (list) list.push(mark);
    else byBlockId.set(mark.blockId, [mark]);
  }
  const className = styleClass(style);
  const plans: DecoPlan[] = [];

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const match = BLOCK_ID_SUFFIX.exec(line.text);
    if (!match) continue;
    const blockMarks = byBlockId.get(match[1] ?? "");
    const first = blockMarks?.[0];
    if (!blockMarks || !first) continue;
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
      for (let ln = start.line; ln <= lineNumber; ln += 1) {
        const lineObj = doc.line(ln);
        const index = lineObj.text.indexOf(
          mark.selectedText,
          ln === start.line ? start.ch : 0
        );
        if (index < 0) continue;
        cursor.set(mark.selectedText, {
          line: ln,
          ch: index + mark.selectedText.length
        });
        const from = lineObj.from + index;
        const to = from + mark.selectedText.length;
        if (className) {
          plans.push({ kind: "style", from, to, className, id: mark.id });
        }
        if (showMarker) {
          // Sit the marker right after the underlined span. When the span abuts
          // the trailing ` ^id` (e.g. a whole-sentence selection), clamp to the
          // id's start and order it before the hidden token (side -1).
          const pos = Math.min(to, suffixStart);
          plans.push({ kind: "marker", pos, id: mark.id, side: to >= suffixStart ? -1 : 1 });
        }
        anyMatched = true;
        break;
      }
    }

    if (!anyMatched) {
      // No selected text located anywhere in the block (drift, inline
      // formatting): keep the block-id line visible up to the id, and place a
      // single paragraph marker at the end of that visible text.
      if (className && suffixStart > line.from) {
        plans.push({ kind: "style", from: line.from, to: suffixStart, className });
      }
      if (showMarker) {
        plans.push({ kind: "marker", pos: suffixStart, id: first.id, side: -1 });
      }
    }

    if (showMarker) {
      // Hide the raw ` ^id` token; the per-span markers replace its role.
      plans.push({ kind: "hide", from: suffixStart, to: line.to });
    }
  }

  plans.sort((a, b) => planStart(a) - planStart(b));
  return plans;
}

/** The document position a plan starts at, for a stable ordering. */
function planStart(plan: DecoPlan): number {
  return plan.kind === "marker" ? plan.pos : plan.from;
}
