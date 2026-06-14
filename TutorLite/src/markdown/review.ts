// Tolerant parser for the agent-authored "Agent Review" section.
//
// Agents (Claude Code / OpenCode / Codex / a human) write free-form Markdown.
// We try to recover the structured fields from the spec (§7.2). If we cannot
// even determine correctness + a summary, we return null and the caller marks
// the annotation `reviewed_unstructured` and shows the raw text (spec §16.3).

import type { AgentReview, Correctness, ReviewSource } from "../model.js";

const PLACEHOLDER = "_No review yet._";

const LABELS: Record<string, string> = {
  correctness: "correctness",
  summary: "summary",
  comment: "summary",
  strengths: "strengths",
  strength: "strengths",
  weaknesses: "weaknesses",
  weakness: "weaknesses",
  "missing concepts": "weaknesses",
  "suggested revision": "suggestedRevision",
  revision: "suggestedRevision",
  "socratic question": "socraticQuestion",
  question: "socraticQuestion",
  source: "source",
  reviewer: "source",
  agent: "source"
};

export function reviewPlaceholder(): string {
  return PLACEHOLDER;
}

export function isReviewPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || /^_?\s*no review yet\.?\s*_?$/i.test(trimmed);
}

export function parseAgentReview(
  sectionText: string,
  createdAt: string
): AgentReview | null {
  if (isReviewPlaceholder(sectionText)) return null;
  const { inline, lists } = scan(sectionText);

  const correctness = normalizeCorrectness(inline.get("correctness"));
  const summary = inline.get("summary") ?? firstParagraph(sectionText);
  if (!correctness || !summary) return null;

  return {
    source: normalizeSource(inline.get("source")),
    correctness,
    summary,
    strengths: listField(inline, lists, "strengths"),
    weaknesses: listField(inline, lists, "weaknesses"),
    suggestedRevision: inline.get("suggestedRevision") || undefined,
    socraticQuestion: inline.get("socraticQuestion") || undefined,
    createdAt
  };
}

function scan(text: string): {
  inline: Map<string, string>;
  lists: Map<string, string[]>;
} {
  const inline = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let current: string | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripMarkers(raw);
    const labelMatch = /^([A-Za-z][A-Za-z ]*?)\s*[:：]\s*(.*)$/.exec(stripped);
    const labelKey = labelMatch
      ? LABELS[(labelMatch[1] ?? "").trim().toLowerCase()]
      : undefined;

    if (labelMatch && labelKey) {
      current = labelKey;
      const value = (labelMatch[2] ?? "").trim();
      if (value && !inline.has(labelKey)) inline.set(labelKey, value);
      if (!lists.has(labelKey)) lists.set(labelKey, []);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.+)$/.exec(raw);
    if (bullet && current) {
      lists.get(current)?.push((bullet[1] ?? "").trim());
      continue;
    }

    if (current && raw.trim()) {
      const existing = inline.get(current);
      inline.set(
        current,
        existing ? `${existing} ${raw.trim()}` : raw.trim()
      );
    }
  }

  return { inline, lists };
}

function listField(
  inline: Map<string, string>,
  lists: Map<string, string[]>,
  key: string
): string[] {
  const items = lists.get(key);
  if (items && items.length > 0) return items;
  const value = inline.get(key);
  if (value) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function stripMarkers(line: string): string {
  return line
    .replace(/^[\s>]*/, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .trim();
}

function firstParagraph(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripMarkers(raw);
    if (!stripped) continue;
    // Skip lines that are themselves labels.
    const labelMatch = /^([A-Za-z][A-Za-z ]*?)\s*[:：]/.exec(stripped);
    if (labelMatch && LABELS[(labelMatch[1] ?? "").trim().toLowerCase()]) {
      continue;
    }
    return stripped;
  }
  return "";
}

function normalizeCorrectness(value: string | undefined): Correctness | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const candidates: Correctness[] = [
    "correct",
    "partially_correct",
    "incorrect",
    "uncertain"
  ];
  return candidates.find((candidate) => normalized.startsWith(candidate)) ?? null;
}

function normalizeSource(value: string | undefined): ReviewSource {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("claude")) return "claude-code";
  if (normalized.includes("manual")) return "manual";
  return "unknown";
}
