// Inline dictionary glosses for immersive reading (the Alt+T action). Selecting a
// single word or term inserts its meaning in the reader's native language right
// after it — "word (译文)" — understood in context. Selecting a passage glosses
// every word that is foreign to the reader the same way, inline. All prompt and
// parse logic is pure so it is unit-tested without a model call; main.ts runs the
// engine and writes the result back into the note.

import type { Locale } from "./i18n.js";

export type TranslateMode = "word" | "passage";

/** The reader's native language, named in English for the model prompt. */
export function nativeLanguageName(locale: Locale): string {
  switch (locale) {
    case "zh-cn":
      return "Chinese (Simplified)";
    case "zh-tw":
      return "Chinese (Traditional)";
    case "ja":
      return "Japanese";
    default:
      return "English";
  }
}

// Sentence-level punctuation (Latin + CJK) marks a passage rather than a term.
const SENTENCE_PUNCT = /[.!?…。！？，、；;：:]/;

/**
 * A short, single-token selection (no internal whitespace, no sentence
 * punctuation, not too long) is treated as one word/term to gloss in place;
 * anything longer is a passage whose foreign words are each glossed inline.
 */
export function classifyTranslateSelection(selection: string): TranslateMode {
  const trimmed = selection.trim();
  if (
    trimmed.length > 0 &&
    !/\s/.test(trimmed) &&
    !SENTENCE_PUNCT.test(trimmed) &&
    [...trimmed].length <= 24
  ) {
    return "word";
  }
  return "passage";
}

/** Prompt for the meaning of a single word/term, understood in its context. */
export function buildWordGlossPrompt(
  word: string,
  context: string,
  nativeLanguage: string
): string {
  return [
    "You are a bilingual dictionary for an immersive language learner.",
    `Give the meaning of the marked word or phrase in ${nativeLanguage}, as it is used in the context below.`,
    `Reply with ONLY the ${nativeLanguage} meaning itself — a single word or a short phrase.`,
    "Do not repeat the original word; add no quotes, parentheses, punctuation, pinyin, romanisation, or explanation.",
    "",
    `Word or phrase: ${word}`,
    "",
    "Context:",
    '"""',
    context || word,
    '"""'
  ].join("\n");
}

/** Prompt to return a passage with every foreign word glossed inline. */
export function buildPassageGlossPrompt(
  passage: string,
  nativeLanguage: string
): string {
  return [
    "You are an immersive-reading assistant that adds short inline glosses.",
    `The reader's native language is ${nativeLanguage}.`,
    `Return the passage EXACTLY as given, but immediately after each word or phrase that is NOT in ${nativeLanguage}, insert its ${nativeLanguage} meaning in parentheses, like: word (译文).`,
    `Gloss only words foreign to a ${nativeLanguage} reader; leave words already in ${nativeLanguage} untouched.`,
    "Preserve every original character, space, line break, punctuation mark, and Markdown token. Add nothing except the parenthetical glosses.",
    "Output only the resulting passage — no commentary, headings, code fences, or surrounding quotation marks.",
    "",
    "Passage:",
    '"""',
    passage,
    '"""'
  ].join("\n");
}

/**
 * Clean a single-word gloss the model returned: take the first non-empty line and
 * strip surrounding quotes/brackets and trailing punctuation, so it slots cleanly
 * into "word (gloss)".
 */
export function cleanGloss(reply: string): string {
  const firstLine =
    reply.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine
    .replace(/^["'“”‘’（(【「『\s]+/, "")
    .replace(/["'“”‘’）)】」』\s]+$/, "")
    .replace(/[。.，,；;：:]+$/, "")
    .trim();
}

/** Strip an accidental wrapper (a code fence or triple quotes) from a passage reply. */
export function stripWrapper(reply: string): string {
  let text = reply.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  if (text.startsWith('"""') && text.endsWith('"""') && text.length >= 6) {
    text = text.slice(3, -3).trim();
  }
  return text;
}

/** Compose the inline gloss "word (meaning)", or just the word when there is none. */
export function formatWordGloss(word: string, gloss: string): string {
  const clean = gloss.trim();
  if (!clean || clean === word.trim()) return word;
  return `${word} (${clean})`;
}
