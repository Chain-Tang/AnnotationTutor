// Pure prompt assembly for the tutor chat, kept out of the Obsidian view so it
// can be unit-tested. Two engines consume it: the Direct API (which has no
// server memory, so the whole note context + history is resent each turn) and
// OpenCode ACP (which remembers the conversation, so we only send a context
// preamble once and let the agent read the note on demand).

import { reviewLanguageInstruction } from "./markdown/overview.js";
import type { ChatMessage } from "./api-runner.js";

export type ChatContext = {
  notePath?: string;
  noteTitle?: string;
  selection?: string;
  content?: string;
  /** A short summary of the learner (from their profile), to personalize replies. */
  profileSummary?: string;
};

/** How many characters of the note body to inline for the API engine. */
export const NOTE_CONTENT_BUDGET = 6000;

export function tutorSystemPrompt(languageTarget: string): string {
  return [
    "You are a warm, knowledgeable learning assistant embedded in the reader's Obsidian vault.",
    "You help the learner understand what they are reading, answer their questions directly and completely, and discuss their margin annotations.",
    "When you know things about this learner (their profile, recent learning, or earlier turns), tailor your depth, examples, and tone to them.",
    "Be concise and conversational. Never refuse to answer or tell the learner to work it out alone; if a Socratic nudge helps, add it after a real answer.",
    reviewLanguageInstruction(languageTarget)
  ].join(" ");
}

/** A block describing what the learner is currently reading. */
export function contextBlock(ctx: ChatContext, includeContent: boolean): string {
  const lines: string[] = [];
  if (ctx.profileSummary && ctx.profileSummary.trim()) {
    lines.push(`What you know about this learner:\n"""\n${ctx.profileSummary.trim()}\n"""`);
  }
  if (ctx.notePath) lines.push(`Current note: ${ctx.notePath}`);
  if (ctx.selection && ctx.selection.trim()) {
    lines.push(`Selected text:\n"""\n${ctx.selection.trim()}\n"""`);
  }
  if (includeContent && ctx.content && ctx.content.trim()) {
    const body =
      ctx.content.length > NOTE_CONTENT_BUDGET
        ? `${ctx.content.slice(0, NOTE_CONTENT_BUDGET)}\n…(truncated)`
        : ctx.content;
    lines.push(`Note content:\n"""\n${body}\n"""`);
  }
  return lines.join("\n");
}

/**
 * The one-time preamble for an OpenCode session: persona + a pointer to the
 * current note so the agent can read the whole article with its own tools
 * (auto + on-demand), rather than us pasting it all in.
 */
export function opencodePreamble(ctx: ChatContext, languageTarget: string): string {
  const parts = [tutorSystemPrompt(languageTarget)];
  const ctxText = contextBlock(ctx, false);
  if (ctxText) {
    parts.push(ctxText);
    if (ctx.notePath) {
      parts.push(
        `You may read the full note with your file tools if you need more context (path: ${ctx.notePath}).`
      );
    }
  }
  return parts.join("\n\n");
}

/** Assemble the OpenAI-style message array for one API chat turn. */
export function buildApiMessages(
  history: ChatMessage[],
  ctx: ChatContext,
  userText: string,
  languageTarget: string
): ChatMessage[] {
  const system = [tutorSystemPrompt(languageTarget), contextBlock(ctx, true)]
    .filter((part) => part.trim())
    .join("\n\n");
  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: userText }
  ];
}
