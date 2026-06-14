// Structural Markdown helpers shared by the annotation / memory-cell / inbox
// parsers. Pure and tolerant: malformed input degrades gracefully rather than
// throwing, so a hand-edited file never crashes the plugin (spec §16.2).

export type SentinelBlock = {
  kind: string;
  id: string;
  /** Text strictly between the start and end sentinel lines. */
  body: string;
  /** Full block text including the sentinel lines. */
  raw: string;
  /** Character offset of the block start within the source. */
  startIndex: number;
  /** Character offset just past the block end within the source. */
  endIndex: number;
};

const SENTINEL_RE =
  /<!--\s*annotation-tutor:([a-z][a-z-]*):(start|end)\s+([A-Za-z0-9_-]+)\s*-->/g;

export function startSentinel(kind: string, id: string): string {
  return `<!-- annotation-tutor:${kind}:start ${id} -->`;
}

export function endSentinel(kind: string, id: string): string {
  return `<!-- annotation-tutor:${kind}:end ${id} -->`;
}

/** Extract every well-formed sentinel block, optionally filtered by kind. */
export function extractBlocks(markdown: string, kind?: string): SentinelBlock[] {
  const matches = [...markdown.matchAll(SENTINEL_RE)];
  const blocks: SentinelBlock[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const open = matches[i];
    if (!open || open[2] !== "start") continue;
    const openKind = open[1];
    const id = open[3];
    if (kind && openKind !== kind) continue;
    for (let j = i + 1; j < matches.length; j += 1) {
      const close = matches[j];
      if (!close) break;
      if (close[2] === "end" && close[1] === openKind && close[3] === id) {
        const startIndex = open.index;
        const endIndex = close.index + close[0].length;
        blocks.push({
          kind: openKind ?? "",
          id: id ?? "",
          body: markdown.slice(open.index + open[0].length, close.index),
          raw: markdown.slice(startIndex, endIndex),
          startIndex,
          endIndex
        });
        break;
      }
    }
  }
  return blocks;
}

export function findBlock(
  markdown: string,
  kind: string,
  id: string
): SentinelBlock | null {
  return (
    extractBlocks(markdown, kind).find((block) => block.id === id) ?? null
  );
}

/** Replace a block's full span (sentinels included) with new text. */
export function replaceBlock(
  markdown: string,
  block: SentinelBlock,
  replacement: string
): string {
  return (
    markdown.slice(0, block.startIndex) +
    replacement +
    markdown.slice(block.endIndex)
  );
}

// --- field / section helpers -------------------------------------------------

/**
 * Split a block body into the lead text (before the first `### Heading`) and a
 * map of `### Heading` -> trimmed section body. Heading lookup is
 * case-insensitive on read via {@link getSection}.
 */
export function splitSections(body: string): {
  lead: string;
  sections: Map<string, string>;
} {
  const lines = body.split(/\r?\n/);
  const lead: string[] = [];
  const sections = new Map<string, string>();
  let title: string | null = null;
  let current: string[] = [];
  const flush = () => {
    if (title !== null) sections.set(title, current.join("\n").trim());
  };
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1] ?? "";
      current = [];
    } else if (title === null) {
      lead.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return { lead: lead.join("\n").trim(), sections };
}

export function getSection(
  sections: Map<string, string>,
  title: string
): string {
  const wanted = title.toLowerCase();
  for (const [key, value] of sections) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

/** Parse `- Key: value` metadata bullets into a lowercased-key map. */
export function parseMetadata(lead: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lead.split(/\r?\n/)) {
    const match = /^\s*-\s+([^:]+):\s*(.*)$/.exec(line);
    if (match) {
      const key = (match[1] ?? "").trim().toLowerCase();
      if (!map.has(key)) map.set(key, (match[2] ?? "").trim());
    }
  }
  return map;
}

/** Strip surrounding backticks/whitespace from an inline-code metadata value. */
export function stripCode(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

/** Parse a comma-separated list value; "None"/empty -> []. */
export function parseList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "None";
}

/** Render text as a Markdown blockquote (blank lines become `>`). */
export function toBlockquote(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return ">";
  return trimmed
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/** Inverse of {@link toBlockquote}; also tolerates non-quoted text. */
export function fromBlockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n")
    .trim();
}

/** Collapse to a single line and clip to `max` characters for summaries. */
export function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
