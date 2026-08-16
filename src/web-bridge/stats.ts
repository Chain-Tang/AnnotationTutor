// Derived usage statistics for the Web Clipper. Nothing is tracked separately:
// the vault's capture notes are the source of truth, so this just aggregates
// their frontmatter and anchor markers. Pure and unit-tested — `parseCaptureMeta`
// reads one note's body (tests, and any content-first caller), while the plugin
// UI builds the same `WebCaptureMeta` from Obsidian's metadata cache (sync) and
// feeds `aggregateWebStats`.

import { parseCaptureFrontmatter } from "../web-capture.js";

/** One capture note reduced to the fields the usage panel needs. */
export type WebCaptureMeta = {
  path: string;
  title?: string;
  url?: string;
  capturedAt?: string;
  /** How many anchored selection blocks (`^cap-…`) the note holds. */
  selections: number;
};

export type WebStats = {
  totalPages: number;
  /** Distinct source URLs, in first-seen order. */
  uniqueUrls: string[];
  pages: WebCaptureMeta[];
  /** Capture frequency bucketed by calendar day, ascending. */
  byDay: Array<{ day: string; count: number }>;
};

const SELECTION_MARKER = /\^cap-[a-z0-9]+/gi;

/** Build a capture-note summary from its raw Markdown content. */
export function parseCaptureMeta(path: string, content: string): WebCaptureMeta {
  const fm = parseCaptureFrontmatter(content);
  const matches = content.match(SELECTION_MARKER);
  const meta: WebCaptureMeta = { path, selections: matches ? matches.length : 0 };
  if (fm.title) meta.title = fm.title;
  if (fm.url) meta.url = fm.url;
  if (fm.capturedAt) meta.capturedAt = fm.capturedAt;
  return meta;
}

/** Roll a list of capture-note summaries into the usage overview. */
export function aggregateWebStats(items: WebCaptureMeta[]): WebStats {
  const urls = new Set<string>();
  const dayCounts = new Map<string, number>();
  for (const item of items) {
    if (item.url) urls.add(item.url);
    const day = item.capturedAt?.slice(0, 10);
    if (day) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }
  const byDay = Array.from(dayCounts, ([day, count]) => ({ day, count })).sort(
    (a, b) => a.day.localeCompare(b.day)
  );
  return {
    totalPages: items.length,
    uniqueUrls: Array.from(urls),
    pages: items,
    byDay
  };
}
