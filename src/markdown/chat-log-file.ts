// Serialize/parse a saved sidebar chat session (`<memoryRoot>/chats/CHAT-*.md`).
// Same shape as the other memory files: frontmatter carries the head, a Markdown
// body carries the turns. The turn format mirrors the annotation `## Dialogue`
// section (### <role label> — <ISO> + blockquote, see annotation-file.ts) so the
// files stay hand-editable and diff-friendly. Pure (no Obsidian imports) so the
// round-trip, capping, and tolerant parsing are unit-testable.

import type { ChatLog, ChatLogHead, ChatLogTurn } from "../model.js";
import { chatLogHeadSchema, chatLogSchema } from "../schemas.js";
import { fromBlockquote, toBlockquote } from "./blocks.js";
import { parseFrontmatter, renderFrontmatter, section } from "./frontmatter.js";

// File labels are fixed English so parsing is locale-independent (same policy as
// annotation-file.ts's DIALOGUE_LABEL); the chat UI shows localized labels.
const ROLE_LABEL: Record<ChatLogTurn["role"], string> = {
  user: "You",
  assistant: "Tutor"
};

/** How many turns of a restored session are rendered / resent at most. */
export const CHAT_LOG_MAX_TURNS = 50;
/** How many characters of a restored session are rendered / resent at most. */
export const CHAT_LOG_MAX_CHARS = 20_000;

export function serializeChatLog(log: ChatLog): string {
  const turns = log.turns
    .map((turn) => {
      const head = turn.at
        ? `### ${ROLE_LABEL[turn.role]} — ${turn.at}`
        : `### ${ROLE_LABEL[turn.role]}`;
      return `${head}\n\n${toBlockquote(turn.text)}`;
    })
    .join("\n\n");
  return renderFrontmatter(
    {
      schema: 2,
      kind: "chat-log",
      id: log.id,
      title: log.title,
      engine: log.engine,
      mode: log.mode,
      status: log.status,
      turns: log.turns.length,
      created_at: log.createdAt,
      updated_at: log.updatedAt
    },
    [`# ${log.title}`, "", "## Turns", "", turns].join("\n")
  );
}

/** Parse a session file back into a full ChatLog; null when it is not one of ours. */
export function parseChatLogFile(markdown: string): ChatLog | null {
  const document = parseFrontmatter(markdown);
  if (
    !document ||
    document.data.schema !== 2 ||
    document.data.kind !== "chat-log"
  ) {
    return null;
  }
  const parsed = chatLogSchema.safeParse({
    id: document.data.id,
    title: document.data.title,
    engine: document.data.engine,
    mode: document.data.mode,
    status: document.data.status,
    turns: parseChatTurns(section(document.body, "Turns")),
    createdAt: document.data.created_at,
    updatedAt: document.data.updated_at
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Parse only the frontmatter head (id/title/counts), for listing sessions
 * without paying for the body. Tolerates a truncated body (a file cut off after
 * the frontmatter still lists); null when the file is not a chat log.
 */
export function parseChatLogHead(markdown: string): ChatLogHead | null {
  const document = parseFrontmatter(markdown);
  if (
    !document ||
    document.data.schema !== 2 ||
    document.data.kind !== "chat-log"
  ) {
    return null;
  }
  const parsed = chatLogHeadSchema.safeParse({
    id: document.data.id,
    title: document.data.title,
    engine: document.data.engine,
    mode: document.data.mode,
    status: document.data.status,
    turns: typeof document.data.turns === "number" ? document.data.turns : 0,
    createdAt: document.data.created_at,
    updatedAt: document.data.updated_at
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Keep the tail of a transcript within both caps (turn count and total
 * characters), so restoring a long session stays cheap. At least one turn is
 * kept; `truncated` reports how many older turns were dropped.
 */
export function capChatLog(
  turns: ChatLogTurn[],
  maxTurns = CHAT_LOG_MAX_TURNS,
  maxChars = CHAT_LOG_MAX_CHARS
): { turns: ChatLogTurn[]; truncated: number } {
  const kept = turns.slice(-maxTurns);
  const totalChars = (): number =>
    kept.reduce((sum, turn) => sum + turn.text.length, 0);
  while (kept.length > 1 && totalChars() > maxChars) kept.shift();
  return { turns: kept, truncated: turns.length - kept.length };
}

/**
 * A short session title from the first user message. Collapses whitespace and
 * clips by characters (not words), so CJK input is handled safely.
 */
export function chatTitleFrom(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Parse the `## Turns` section body back into ordered turns (tolerant). */
function parseChatTurns(sectionBody: string): ChatLogTurn[] {
  if (!sectionBody.trim()) return [];
  const lines = sectionBody.split(/\r?\n/);
  const turns: ChatLogTurn[] = [];
  let role: ChatLogTurn["role"] | null = null;
  let at = "";
  let buffer: string[] = [];
  const flush = (): void => {
    if (role !== null) {
      const text = fromBlockquote(buffer.join("\n"));
      if (text) turns.push({ role, text, at });
    }
    buffer = [];
  };
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const title = heading[1] ?? "";
      const parts = title.split(" — ");
      const label = (parts[0] ?? "").trim().toLowerCase();
      at = parts.length > 1 ? parts.slice(1).join(" — ").trim() : "";
      role =
        label.startsWith("you") || label.startsWith("user")
          ? "user"
          : "assistant";
    } else {
      buffer.push(line);
    }
  }
  flush();
  return turns;
}
