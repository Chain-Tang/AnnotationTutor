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
