// Editor-side helpers for turning an Obsidian selection into a block-anchored
// annotation. Ported from the full plugin (apps/obsidian-plugin/src/main.tsx).
// Only type-level Obsidian imports, so the block math stays simple to reason
// about.

import type { Editor, EditorPosition } from "obsidian";

// A block id may trail ordinary Markdown (`paragraph ^id`) or occupy its own
// line. Obsidian requires the latter form for tables, otherwise appending the
// token after the final `|` creates an extra cell and can corrupt the table.
const BLOCK_ID_SUFFIX = /(?:^|\s+)\^([A-Za-z0-9_-]+)\s*$/;

// An ATX heading ("## Title") is its own Markdown block even with no blank line
// around it, so it must bound a block — otherwise an annotation's block id gets
// appended to a neighbouring heading and the underline/marker land on it.
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

/** True if a line starts a new block by itself (currently: ATX headings). */
function isBlockBoundary(line: string): boolean {
  return HEADING.test(line);
}

/** A contiguous Markdown table containing `line`, or null. */
export function findTableInLines(
  lines: readonly string[],
  line: number
): { startLine: number; endLine: number } | null {
  if (line < 0 || line >= lines.length || !looksLikeTableRow(lines[line] ?? "")) {
    return null;
  }
  let startLine = line;
  let endLine = line;
  while (startLine > 0 && looksLikeTableRow(lines[startLine - 1] ?? "")) {
    startLine -= 1;
  }
  while (
    endLine < lines.length - 1 &&
    looksLikeTableRow(lines[endLine + 1] ?? "")
  ) {
    endLine += 1;
  }
  // GFM/Obsidian tables are identified by the delimiter row immediately after
  // the header. Requiring it avoids treating an ordinary sentence containing a
  // pipe as a table.
  return startLine + 1 <= endLine && isTableDelimiter(lines[startLine + 1] ?? "")
    ? { startLine, endLine }
    : null;
}

/** Editor-backed form of findTableInLines. */
export function findTable(
  editor: Editor,
  line: number
): { startLine: number; endLine: number } | null {
  const lines = Array.from({ length: editor.lineCount() }, (_, index) =>
    editor.getLine(index)
  );
  return findTableInLines(lines, line);
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^```|^~~~/.test(trimmed)) return false;
  // An escaped pipe is cell content, not a separator. One real separator is
  // enough because leading/trailing pipes are optional in Markdown tables.
  return /(^|[^\\])\|/.test(trimmed);
}

function isTableDelimiter(line: string): boolean {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells = value.split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** True if the selection spans a blank line (i.e. crosses Markdown blocks). */
export function crossesMarkdownBlocks(
  editor: Editor,
  start: EditorPosition,
  end: EditorPosition
): boolean {
  for (let line = start.line; line <= end.line; line += 1) {
    if (line > start.line && line < end.line && editor.getLine(line).trim() === "") {
      return true;
    }
  }
  return false;
}

/**
 * Expand a line to the contiguous non-blank block that contains it. Blank lines
 * and headings bound the block; a heading line is a block on its own.
 */
export function findBlock(
  editor: Editor,
  line: number
): { startLine: number; endLine: number } {
  if (isBlockBoundary(editor.getLine(line))) {
    return { startLine: line, endLine: line };
  }
  let startLine = line;
  let endLine = line;
  while (
    startLine > 0 &&
    editor.getLine(startLine - 1).trim() !== "" &&
    !isBlockBoundary(editor.getLine(startLine - 1))
  ) {
    startLine -= 1;
  }
  while (
    endLine < editor.lineCount() - 1 &&
    editor.getLine(endLine + 1).trim() !== "" &&
    !isBlockBoundary(editor.getLine(endLine + 1))
  ) {
    endLine += 1;
  }
  return { startLine, endLine };
}

/**
 * Expand a line index to its contiguous non-blank block, against a raw array of
 * lines (the file's source). The Reading-view path has no Editor, so it works
 * on the text directly; mirrors findBlock's logic (blank lines + headings bound).
 */
export function findBlockInLines(
  lines: string[],
  line: number
): { startLine: number; endLine: number } {
  if (isBlockBoundary(lines[line] ?? "")) {
    return { startLine: line, endLine: line };
  }
  let startLine = line;
  let endLine = line;
  while (
    startLine > 0 &&
    (lines[startLine - 1] ?? "").trim() !== "" &&
    !isBlockBoundary(lines[startLine - 1] ?? "")
  ) {
    startLine -= 1;
  }
  while (
    endLine < lines.length - 1 &&
    (lines[endLine + 1] ?? "").trim() !== "" &&
    !isBlockBoundary(lines[endLine + 1] ?? "")
  ) {
    endLine += 1;
  }
  return { startLine, endLine };
}

/** Existing trailing block id on a line, without the caret, or null. */
export function detectBlockId(line: string): string | null {
  return BLOCK_ID_SUFFIX.exec(line)?.[1] ?? null;
}

/** Text of a line with any trailing block id stripped. */
export function lineTextWithoutBlockId(line: string): string {
  return line.replace(BLOCK_ID_SUFFIX, "").trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
