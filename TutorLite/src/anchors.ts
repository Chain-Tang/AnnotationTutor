// Anchor resolution cascade, ported and simplified from the full Annotation
// Tutor (packages/core/src/anchors.ts) for the Lite anchor shape.
//
// Pure: takes raw Markdown plus a stored anchor and reports where the
// annotation currently lives, with a confidence and whether a repair needs
// user confirmation. Used for jump-to-source and anchor repair (spec §16.1).

import type { Anchor } from "./model.js";

export type AnchorStrategy =
  | "block-id"
  | "exact-text"
  | "fuzzy"
  | "not-found";

export type AnchorResolution = {
  strategy: AnchorStrategy;
  line?: number;
  startOffset?: number;
  endOffset?: number;
  confidence: number;
  requiresConfirmation: boolean;
};

const FUZZY_THRESHOLD = 0.45;

export function resolveAnchor(markdown: string, anchor: Anchor): AnchorResolution {
  const lines = markdown.split(/\r?\n/);

  // 1. Exact block id — the most reliable anchor.
  if (anchor.blockId) {
    const blockPattern = new RegExp(
      `(?:^|\\s)\\^${escapeRegExp(anchor.blockId)}\\s*$`
    );
    const blockLine = lines.findIndex((line) => blockPattern.test(line));
    if (blockLine >= 0) {
      const lineStart = offsetOfLine(lines, blockLine);
      const selectedStart = anchor.selectedText
        ? (lines[blockLine]?.indexOf(anchor.selectedText) ?? -1)
        : -1;
      return {
        strategy: "block-id",
        line: blockLine,
        startOffset:
          selectedStart >= 0 ? lineStart + selectedStart : lineStart,
        endOffset:
          selectedStart >= 0
            ? lineStart + selectedStart + anchor.selectedText.length
            : lineStart + (lines[blockLine]?.length ?? 0),
        confidence: 1,
        requiresConfirmation: false
      };
    }
  }

  // 2. Exact selected-text match.
  const exactOffset = anchor.selectedText
    ? markdown.indexOf(anchor.selectedText)
    : -1;
  if (exactOffset >= 0) {
    return {
      strategy: "exact-text",
      line: lineOfOffset(markdown, exactOffset),
      startOffset: exactOffset,
      endOffset: exactOffset + anchor.selectedText.length,
      confidence: 0.95,
      requiresConfirmation: false
    };
  }

  // 3. Fuzzy line match — requires user confirmation before moving.
  let bestLine = -1;
  let bestScore = 0;
  if (anchor.selectedText) {
    for (const [index, line] of lines.entries()) {
      const score = similarity(
        anchor.selectedText,
        line.replace(/\s+\^[\w-]+\s*$/, "")
      );
      if (score > bestScore) {
        bestScore = score;
        bestLine = index;
      }
    }
  }
  if (bestLine >= 0 && bestScore >= FUZZY_THRESHOLD) {
    return {
      strategy: "fuzzy",
      line: bestLine,
      confidence: bestScore,
      requiresConfirmation: true
    };
  }

  return { strategy: "not-found", confidence: 0, requiresConfirmation: false };
}

function offsetOfLine(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset;
}

function lineOfOffset(markdown: string, offset: number): number {
  return markdown.slice(0, offset).split(/\r?\n/).length - 1;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function similarity(left: string, right: string): number {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  if (length === 0) return 1;
  return 1 - levenshtein(normalizedLeft, normalizedRight) / length;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
