// Pre-translation: when a document opens, the plugin glosses it once in the
// background and caches a word→meaning glossary, so the Alt+T inline dictionary
// can answer instantly without a model round-trip. The meaning is still
// understood in context — each batch of the document is glossed as a passage —
// but the result is a reusable glossary instead of an inline rewrite. All prompt,
// parsing, lookup and matching logic is pure here so it is unit-tested without a
// model call; main.ts runs the engine, owns the per-file cache, and writes the
// gloss into the note on Alt+T (with the live translation kept as a fallback for
// words the pre-pass missed).

import { cleanGloss } from "./translate.js";

/** One cached term and its meaning in the reader's native language. */
export type GlossaryEntry = { surface: string; gloss: string };

/** The pre-translation result for one document. */
export type FileGlossary = {
  /** Content hash of the document this glossary was built from, for invalidation. */
  hash: string;
  /** Unique entries, longest surface first, for greedy left-to-right matching. */
  entries: GlossaryEntry[];
  /** Normalized surface -> entry, for O(1) single-word lookup. */
  byKey: Map<string, GlossaryEntry>;
  /**
   * True once every batch of the document has been glossed. The cache is written
   * incrementally (so Alt+T can use the parts done so far), so a `false` here
   * marks a still-building glossary that must not satisfy the content-hash skip.
   */
  complete: boolean;
};

/** Cap on how many batches one document is glossed in, to bound cost/time. */
export const MAX_PRETRANSLATE_BATCHES = 30;

/** Soft per-batch character budget; paragraphs are packed up to this size. */
const DEFAULT_BATCH_CHARS = 1600;

/** Hard ceiling for a single oversized paragraph, sliced at whitespace. */
const HARD_BATCH_CHARS = 6000;

// Latin-script terms (incl. accented Latin) match only on word boundaries;
// CJK/kana/hangul terms are written without spaces and match as substrings.
const ALPHA = /[A-Za-zÀ-ɏ]/;
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const ALPHANUM = /[A-Za-z0-9À-ɏ]/;

// Tolerant separators between a term and its meaning in a glossary line. `::`
// is what the prompt asks for; the rest are common drift the model may emit.
const ENTRY_SEP = /(::|：：|=>|->|→|\|\||\t)/;

function normalizeKey(surface: string): string {
  return surface.trim().toLowerCase();
}

function needsWordBoundary(surface: string): boolean {
  return ALPHA.test(surface) && !CJK.test(surface);
}

function isAlphaNum(ch: string | undefined): boolean {
  return ch !== undefined && ALPHANUM.test(ch);
}

function hasLetters(text: string): boolean {
  return ALPHA.test(text) || CJK.test(text);
}

/** Prompt asking for a context-aware glossary of the foreign terms in a passage. */
export function buildGlossaryPrompt(
  passage: string,
  nativeLanguage: string
): string {
  return [
    "You are building a study glossary for an immersive language learner.",
    `The reader's native language is ${nativeLanguage}.`,
    `From the passage below, list every word or phrase that is NOT in ${nativeLanguage} — the same words a ${nativeLanguage} reader would want glossed while reading. Be thorough: include each foreign content word, not only the rare ones.`,
    `For each, give its meaning in ${nativeLanguage} as it is used in this context.`,
    "Output one entry per line in EXACTLY this format:",
    "term :: meaning",
    "Use the term exactly as it appears in the passage (same spelling and case).",
    "List individual words as their own entries so each can be looked up alone; you may ALSO add a multi-word phrase as a separate entry when it carries its own meaning.",
    `Give only the ${nativeLanguage} meaning — no pinyin, romanisation, part of speech, quotes, or explanation.`,
    "List each distinct term once. Output nothing else: no numbering, headings, commentary, or blank lines.",
    "",
    "Passage:",
    '"""',
    passage,
    '"""'
  ].join("\n");
}

/**
 * Parse a glossary reply into entries. Forgiving: strips list markers, accepts a
 * few separators, drops malformed or empty lines, and de-noises the meaning the
 * same way the inline dictionary does.
 */
export function parseGlossary(reply: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "");
    if (!line) continue;
    const match = ENTRY_SEP.exec(line);
    if (!match || match.index === 0) continue;
    const surface = line
      .slice(0, match.index)
      .trim()
      .replace(/^["'“”‘’（(【「『\s]+/, "")
      .replace(/["'“”‘’）)】」』\s]+$/, "")
      .trim();
    const gloss = cleanGloss(line.slice(match.index + match[0].length));
    if (!surface || !gloss || surface === gloss) continue;
    out.push({ surface, gloss });
  }
  return out;
}

/**
 * Build the lookup-ready glossary, keeping the first meaning seen per term.
 * `complete` defaults to true; the incremental pre-translation loop passes false
 * for the partial glossaries it writes after each batch.
 */
export function buildFileGlossary(
  hash: string,
  entries: GlossaryEntry[],
  complete = true
): FileGlossary {
  const byKey = new Map<string, GlossaryEntry>();
  for (const entry of entries) {
    const key = normalizeKey(entry.surface);
    if (key && !byKey.has(key)) byKey.set(key, entry);
  }
  const unique = [...byKey.values()].sort(
    (a, b) => b.surface.length - a.surface.length
  );
  return { hash, entries: unique, byKey, complete };
}

/** An empty glossary, e.g. when a document has no glossable content. */
export function emptyFileGlossary(hash: string): FileGlossary {
  return { hash, entries: [], byKey: new Map(), complete: true };
}

/**
 * Return a glossary with one entry added (first-wins on its normalized surface),
 * re-sorted longest-first. Used to grow the cache from a live Alt+T lookup so a
 * word the pre-pass missed becomes instant next time. Preserves `hash`/`complete`.
 */
export function mergeGlossaryEntry(
  glossary: FileGlossary,
  entry: GlossaryEntry
): FileGlossary {
  const key = normalizeKey(entry.surface);
  if (!key || glossary.byKey.has(key)) return glossary;
  return buildFileGlossary(
    glossary.hash,
    [...glossary.entries, entry],
    glossary.complete
  );
}

/** The cached meaning for an exact single-term selection, if any. */
export function lookupGloss(
  glossary: FileGlossary,
  selection: string
): string | undefined {
  return glossary.byKey.get(normalizeKey(selection))?.gloss;
}

/**
 * Insert "(meaning)" after each cached term found in a passage, scanning left to
 * right and preferring the longest term at each position. Latin terms must sit on
 * word boundaries; CJK terms match as substrings. Returns the passage unchanged
 * when the cache covers none of it (so the caller can fall back to a live call).
 */
export function applyGlossary(passage: string, glossary: FileGlossary): string {
  if (glossary.entries.length === 0) return passage;
  const lower = passage.toLowerCase();
  let out = "";
  let i = 0;
  while (i < passage.length) {
    let matched: GlossaryEntry | undefined;
    for (const entry of glossary.entries) {
      const len = entry.surface.length;
      if (len === 0) continue;
      if (!lower.startsWith(entry.surface.toLowerCase(), i)) continue;
      if (needsWordBoundary(entry.surface)) {
        const before = i > 0 ? passage[i - 1] : undefined;
        const after = passage[i + len];
        if (isAlphaNum(before) || isAlphaNum(after)) continue;
      }
      matched = entry;
      break;
    }
    if (matched) {
      const surfaceInText = passage.slice(i, i + matched.surface.length);
      out += `${surfaceInText} (${matched.gloss})`;
      i += matched.surface.length;
    } else {
      out += passage[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Split a document into context-preserving batches to gloss: drops YAML
 * frontmatter and fenced code, then packs whole paragraphs up to a character
 * budget (an oversized paragraph is sliced at whitespace). Batches with no
 * glossable letters are excluded.
 */
export function segmentDocument(
  text: string,
  maxBatchChars: number = DEFAULT_BATCH_CHARS
): string[] {
  const body = text
    .replace(/^﻿/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ");
  const hardCap = Math.max(maxBatchChars, HARD_BATCH_CHARS);
  const paragraphs: string[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!hasLetters(trimmed)) continue;
    if (trimmed.length <= hardCap) {
      paragraphs.push(trimmed);
    } else {
      paragraphs.push(...sliceLongBlock(trimmed, hardCap));
    }
  }
  const batches: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + 2 + paragraph.length > maxBatchChars) {
      batches.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) batches.push(current);
  return batches;
}

/** Break an oversized block into <= cap pieces, cutting at the last whitespace. */
function sliceLongBlock(block: string, cap: number): string[] {
  const pieces: string[] = [];
  let rest = block;
  while (rest.length > cap) {
    const window = rest.slice(0, cap);
    const cut = window.lastIndexOf(" ");
    const at = cut > cap * 0.5 ? cut : cap;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(hasLetters);
}

/** Stable, cheap content hash (djb2) used to invalidate a cached glossary. */
export function contentHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
