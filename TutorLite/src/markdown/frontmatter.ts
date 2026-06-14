import { parse, stringify } from "yaml";

export type FrontmatterDocument = {
  data: Record<string, unknown>;
  body: string;
};

export function parseFrontmatter(markdown: string): FrontmatterDocument | null {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    normalized
  );
  if (!match) return null;
  try {
    const data = parse(match[1] ?? "");
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return {
      data: data as Record<string, unknown>,
      body: match[2] ?? ""
    };
  } catch {
    return null;
  }
}

export function renderFrontmatter(
  data: Record<string, unknown>,
  body: string
): string {
  return `---\n${stringify(data, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN"
  }).trimEnd()}\n---\n${body.trimStart().trimEnd()}\n`;
}

export function wikiLink(path: string, label: string): string {
  return `[[${path}|${label}]]`;
}

export function wikiLinkId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/.exec(value.trim());
  if (!match) return value.trim() || null;
  const label = match[2]?.trim();
  if (label) return label;
  const path = match[1] ?? "";
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/i, "");
}

export function wikiLinkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(wikiLinkId)
    .filter((item): item is string => item !== null);
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function section(body: string, title: string): string {
  const lines = body.split(/\r?\n/);
  const wanted = title.trim().toLowerCase();
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if ((heading?.[1] ?? "").trim().toLowerCase() === wanted) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}
