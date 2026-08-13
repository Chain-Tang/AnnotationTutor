// Zotero interop without a Zotero connector: import a CSL-JSON export (the
// format Zotero's "Export Library" produces) and turn each entry into a
// capture note the learning loop can annotate — the same shape web-capture
// produces, so both entry points share the review/memory-cell flow. A BibTeX
// snippet is embedded in each note for lightweight citation output. Pure and
// unit-tested; the file picker + vault writes live on the plugin side.

import { buildCaptureNote, type WebCaptureInput } from "./web-capture.js";

export type ZoteroEntry = {
  title: string;
  authors: string[];
  year?: string;
  url?: string;
  doi?: string;
  venue?: string;
  abstract?: string;
};

export type CslParseResult =
  | { ok: true; entries: ZoteroEntry[] }
  | { ok: false; error: string };

/** Parse a CSL-JSON export (an array of items, or a single item object). */
export function parseCslJson(text: string): CslParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const entries: ZoteroEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = normalizeCslItem(item as Record<string, unknown>);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return { ok: false, error: "no-entries" };
  return { ok: true, entries };
}

function normalizeCslItem(obj: Record<string, unknown>): ZoteroEntry | null {
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;
  const authors: string[] = [];
  if (Array.isArray(obj.author)) {
    for (const author of obj.author) {
      if (!author || typeof author !== "object") continue;
      const person = author as Record<string, unknown>;
      const name =
        [person.family, person.given]
          .filter((part): part is string => typeof part === "string" && part.trim() !== "")
          .join(", ") || (typeof person.literal === "string" ? person.literal : "");
      if (name.trim()) authors.push(name.trim());
    }
  }
  const issued = obj.issued as { "date-parts"?: unknown } | undefined;
  const firstPart = Array.isArray(issued?.["date-parts"]) ? issued?.["date-parts"][0] : undefined;
  const year =
    Array.isArray(firstPart) && typeof firstPart[0] === "number"
      ? String(firstPart[0])
      : undefined;
  const pick = (key: string): string | undefined =>
    typeof obj[key] === "string" && (obj[key] as string).trim()
      ? (obj[key] as string).trim()
      : undefined;
  return {
    title,
    authors,
    ...(year ? { year } : {}),
    ...(pick("URL") ? { url: pick("URL") } : {}),
    ...(pick("DOI") ? { doi: pick("DOI") } : {}),
    ...(pick("container-title") ? { venue: pick("container-title") } : {}),
    ...(pick("abstract") ? { abstract: pick("abstract") } : {})
  };
}

/** A BibTeX snippet for one entry (the lightweight citation output). */
export function toBibTeX(entry: ZoteroEntry): string {
  const key = bibtexKey(entry);
  const lines = [`@article{${key},`];
  lines.push(`  title = {${entry.title}},`);
  if (entry.authors.length > 0) {
    lines.push(`  author = {${entry.authors.join(" and ")}},`);
  }
  if (entry.year) lines.push(`  year = {${entry.year}},`);
  if (entry.venue) lines.push(`  journal = {${entry.venue}},`);
  if (entry.doi) lines.push(`  doi = {${entry.doi}},`);
  if (entry.url) lines.push(`  url = {${entry.url}},`);
  lines.push("}");
  return lines.join("\n");
}

function bibtexKey(entry: ZoteroEntry): string {
  const first = entry.authors[0]?.split(",")[0]?.trim() ?? "unknown";
  const latin = first.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase() || "unknown";
  return `${latin}${entry.year ?? ""}${entry.title ? entry.title.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 4).toLowerCase() : ""}`;
}

/**
 * The capture note for one imported entry: the abstract (or a placeholder) is
 * the anchored selection, metadata sits in frontmatter, and a BibTeX block is
 * embedded for copy-paste citations.
 */
export function zoteroCaptureNote(
  entry: ZoteroEntry,
  capturedAt: string,
  blockId: string
): string {
  const input: WebCaptureInput = {
    selection: entry.abstract ?? entry.title,
    title: entry.title,
    capturedAt,
    ...(entry.url ?? (entry.doi ? `https://doi.org/${entry.doi}` : "")
      ? { url: entry.url ?? `https://doi.org/${entry.doi}` }
      : {})
  };
  const note = buildCaptureNote(input, blockId);
  const meta: string[] = ["## Reference", ""];
  if (entry.authors.length > 0) meta.push(`- Authors: ${entry.authors.join("; ")}`);
  if (entry.year) meta.push(`- Year: ${entry.year}`);
  if (entry.venue) meta.push(`- Venue: ${entry.venue}`);
  if (entry.doi) meta.push(`- DOI: ${entry.doi}`);
  meta.push("", "```bibtex", toBibTeX(entry), "```", "");
  return `${note}\n${meta.join("\n")}`;
}
