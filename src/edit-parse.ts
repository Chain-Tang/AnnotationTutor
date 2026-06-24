// Preview-then-apply edit protocol for the tutor chat (Phase 3).
//
// In Build mode the agent may propose a change to the note. Rather than give the
// agent write tools (which would differ per engine and bypass review), we ask it
// to wrap the COMPLETE replacement text in two sentinel lines and parse that out.
// The plugin then shows a diff and only writes on the user's click. Sentinels
// (not fenced code blocks) are used so the edit body can itself contain ``` code
// fences, tables, or Mermaid without breaking the parse.

export const EDIT_START = "===ATL-EDIT-START===";
export const EDIT_END = "===ATL-EDIT-END===";

export type ParsedEdit = {
  /** The agent's prose around the markers (shown as the chat message). */
  explanation: string;
  /** The replacement text, or null when the reply proposes no edit. */
  edit: string | null;
};

/** Split an agent reply into its explanation and the proposed edit (if any). */
export function extractEdit(reply: string): ParsedEdit {
  const start = reply.indexOf(EDIT_START);
  if (start === -1) return { explanation: reply.trim(), edit: null };
  const afterStart = start + EDIT_START.length;
  const end = reply.indexOf(EDIT_END, afterStart);
  if (end === -1) return { explanation: reply.trim(), edit: null };

  // Drop exactly one newline after START and one before END (the markers sit on
  // their own lines), but preserve the body's own leading/trailing formatting.
  const body = reply
    .slice(afterStart, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n[ \t]*$/, "");
  const explanation = `${reply.slice(0, start)}${reply.slice(end + EDIT_END.length)}`.trim();
  if (!body.trim()) return { explanation, edit: null };
  return { explanation, edit: body };
}

/** A fenced code/Mermaid block, if the reply contains one. */
function firstFencedBlock(reply: string): string | null {
  const match = /```[\s\S]*?```/.exec(reply);
  return match ? match[0].trim() : null;
}

/** A GitHub-style Markdown table (header + separator + rows), if present. */
function firstTable(reply: string): string | null {
  const lines = reply.split(/\r?\n/);
  const isRow = (line: string | undefined): boolean =>
    !!line && line.includes("|") && line.trim().length > 0;
  const isSeparator = (line: string | undefined): boolean =>
    !!line && line.includes("|") && line.includes("-") && /^[\s|:-]+$/.test(line.trim());
  for (let i = 0; i < lines.length; i++) {
    if (isRow(lines[i]) && isSeparator(lines[i + 1])) {
      let end = i;
      while (end < lines.length && isRow(lines[end])) end++;
      return lines.slice(i, end).join("\n").trim();
    }
  }
  return null;
}

/**
 * When the agent answers a write/insert request as plain Markdown (no edit
 * markers — common with smaller models), pull out the block it clearly meant to
 * add: a fenced code/Mermaid block, else a Markdown table. Returns null when the
 * reply is just prose.
 */
export function extractInsertableBlock(reply: string): string | null {
  return firstFencedBlock(reply) ?? firstTable(reply);
}

export type ResolvedEdit = {
  /** Prose to show as the chat message. */
  explanation: string;
  /** The text to apply, or null when the reply proposes nothing applicable. */
  edit: string | null;
  /** True when `edit` should be inserted, not used to replace a selection. */
  isInsert: boolean;
};

/**
 * Resolve what (if anything) a write-intent reply wants to apply: first the
 * explicit edit markers (a drop-in replacement), then a fallback insertable
 * block when the model skipped the markers. The fallback is always an insert, so
 * a generated table/diagram is added rather than overwriting a selection.
 */
export function resolveEdit(reply: string): ResolvedEdit {
  const { explanation, edit } = extractEdit(reply);
  if (edit) return { explanation, edit, isInsert: false };
  const block = extractInsertableBlock(reply);
  if (block) return { explanation: reply.trim(), edit: block, isInsert: true };
  return { explanation: reply.trim(), edit: null, isInsert: false };
}

/** Block-level content needs its own lines (a blank line around it) to render. */
export function isBlockContent(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.includes("\n") ||
    trimmed.startsWith("```") ||
    trimmed.startsWith("|") ||
    trimmed.startsWith(">") ||
    trimmed.startsWith("#")
  );
}

/**
 * Pad block content so it renders when inserted at a cursor: ensure a blank line
 * separates it from the text before and after. `before`/`after` are the note
 * text on each side of the insertion point. Inline (single-line) inserts are
 * returned unchanged.
 */
export function padBlockInsertion(
  before: string,
  after: string,
  block: string
): string {
  if (!isBlockContent(block)) return block;
  let result = block;
  if (before.length > 0) {
    const trailing = (/\n*$/.exec(before)?.[0] ?? "").length;
    result = "\n".repeat(Math.max(0, 2 - trailing)) + result;
  }
  if (after.length > 0) {
    const leading = (/^\n*/.exec(after)?.[0] ?? "").length;
    result = result + "\n".repeat(Math.max(0, 2 - leading));
  }
  return result;
}

/** The instruction appended to a Build-mode turn so the agent can propose edits. */
export function buildEditInstruction(hasSelection: boolean): string {
  const target = hasSelection
    ? "rewrite the selected text shown above (keep it a drop-in replacement)"
    : "write new Markdown to insert at the cursor";
  return [
    `If you propose a change to the note, ${target}.`,
    `Put the COMPLETE replacement text between a line "${EDIT_START}" and a line "${EDIT_END}", with nothing else inside those markers.`,
    "Preserve the note's language, voice, and Markdown formatting (tables, code blocks, and Mermaid are fine).",
    "Explain the change briefly outside the markers. If no edit is needed, answer normally without the markers."
  ].join(" ");
}
