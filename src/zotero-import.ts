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

/**
 * Detect the pasted format and route to the right parser. CSL-JSON starts
 * with `[` or `{`; BibTeX entries start with `@type{`. Anything else is
 * handed to the CSL parser so its error messages surface unchanged.
 */
export function parseImport(text: string): CslParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "no-entries" };
  if (trimmed.startsWith("@")) return parseBibTeX(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return parseCslJson(trimmed);
  // A leading comment before the first entry is common in .bib exports.
  if (/@\w+\s*\{/.test(trimmed)) return parseBibTeX(trimmed);
  return parseCslJson(trimmed);
}

/**
 * Parse a BibTeX export (one or more `@type{key, field = value}` entries)
 * into the same ZoteroEntry shape CSL-JSON produces. Values may be wrapped in
 * `{...}` (possibly nested) or `"..."`, or bare (years, numbers).
 */
export function parseBibTeX(text: string): CslParseResult {
  const entries: ZoteroEntry[] = [];
  let index = 0;
  while (index < text.length) {
    const head = /@(\w+)\s*\{\s*([^,\s{}]*)\s*,/.exec(text.slice(index));
    if (!head) break;
    const bodyStart = index + head.index + head[0].length;
    const bodyEnd = matchClosingBrace(text, bodyStart);
    if (bodyEnd < 0) break;
    const type = head[1]!.toLowerCase();
    if (type !== "string" && type !== "comment" && type !== "preamble") {
      const fields = parseBibFields(text.slice(bodyStart, bodyEnd));
      const entry = bibtexToEntry(fields);
      if (entry) entries.push(entry);
    }
    index = bodyEnd + 1;
  }
  if (entries.length === 0) return { ok: false, error: "no-entries" };
  return { ok: true, entries };
}

/** Index of the `}` closing the entry whose body starts at `start` (depth 1). */
function matchClosingBrace(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Read `name = value` pairs out of one entry body. */
function parseBibFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const name = /^\s*([\w-]+)\s*=\s*/.exec(body.slice(i));
    if (!name) {
      i += 1;
      continue;
    }
    i += name[0].length;
    const { value, end } = readBibValue(body, i);
    fields[name[1]!.toLowerCase()] = value;
    i = end;
    const comma = body.indexOf(",", i);
    if (comma < 0) break;
    i = comma + 1;
  }
  return fields;
}

/** One field value: balanced braces, a quoted string, or a bare token. */
function readBibValue(body: string, start: number): { value: string; end: number } {
  const ch = body[start];
  if (ch === "{") {
    let depth = 1;
    for (let i = start + 1; i < body.length; i++) {
      if (body[i] === "{") depth += 1;
      else if (body[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          return { value: body.slice(start + 1, i).trim(), end: i + 1 };
        }
      }
    }
    return { value: body.slice(start + 1).trim(), end: body.length };
  }
  if (ch === '"') {
    const close = body.indexOf('"', start + 1);
    const stop = close < 0 ? body.length : close;
    return {
      value: body.slice(start + 1, stop).trim(),
      end: close < 0 ? body.length : close + 1
    };
  }
  const bare = /^[^,\s]+/.exec(body.slice(start));
  const value = bare ? bare[0] : "";
  return { value, end: start + value.length };
}

/** Map one parsed field bag onto the shared ZoteroEntry shape. */
function bibtexToEntry(fields: Record<string, string>): ZoteroEntry | null {
  const title = cleanBibValue(fields.title ?? "");
  if (!title) return null;
  const authors: string[] = [];
  const authorField = fields.author ?? "";
  if (authorField) {
    for (const part of authorField.split(/\s+and\s+/i)) {
      const name = cleanBibValue(part);
      if (name) authors.push(name);
    }
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = cleanBibValue(fields[key] ?? "");
      if (value) return value;
    }
    return undefined;
  };
  const year = pick("year", "date");
  const url = pick("url");
  const doi = pick("doi");
  const venue = pick("journal", "booktitle");
  const abstract = pick("abstract");
  return {
    title,
    authors,
    ...(year ? { year } : {}),
    ...(url ? { url } : {}),
    ...(doi ? { doi } : {}),
    ...(venue ? { venue } : {}),
    ...(abstract ? { abstract } : {})
  };
}

/** Strip LaTeX grouping braces and collapse whitespace for display. */
function cleanBibValue(value: string): string {
  return value.replace(/[{}]+/g, "").replace(/\s+/g, " ").trim();
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
