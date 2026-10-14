import { parse as parseYaml } from "yaml";

export const OFFICIAL_WEB_CLIPPER_TEMPLATE_VERSION = "official-v1";
export const OFFICIAL_WEB_CLIPPER_STORE_URL =
  "https://chromewebstore.google.com/detail/obsidian-web-clipper/cnjifjpddelmedmihgijeibhnjfabmlf";
export const TUTOR_ANALYSIS_MARKER = "<!-- tutor-analysis:official-v1 -->";

export type OfficialClipperAnalysisStatus = "pending" | "complete" | "failed";

export interface OfficialClipperMetadata {
  marker: string;
  source: string;
  title: string;
  url: string;
  author: string;
  published: string;
  capturedAt: string;
  analysis: OfficialClipperAnalysisStatus;
}

/** Engine-neutral input used by both the official and Tutor advanced clippers. */
export interface WebCaptureDocument {
  title: string;
  url: string;
  capturedAt: string;
  markdown: string;
  source: "obsidian-web-clipper" | "tutor-advanced-clipper";
}

export type OfficialWebClipperTemplate = {
  schemaVersion: "0.1.0";
  name: string;
  behavior: "create";
  noteNameFormat: string;
  path: string;
  context: string;
  properties: Array<{ name: string; value: string; type: string }>;
  triggers: string[];
  noteContentFormat: string;
};

/** Generate the importable official Web Clipper template for the current vault path. */
export function officialWebClipperTemplate(path: string): OfficialWebClipperTemplate {
  return {
    schemaVersion: "0.1.0",
    name: "Tutor Web Capture",
    behavior: "create",
    noteNameFormat: '{{title|safe_name}} {{date|date:"YYYY-MM-DD"}}',
    path: path.trim().replace(/^\/+|\/+$/g, ""),
    context: "{{content}}",
    properties: [
      { name: "type", value: "web-capture", type: "text" },
      { name: "tutor_capture", value: OFFICIAL_WEB_CLIPPER_TEMPLATE_VERSION, type: "text" },
      { name: "capture_source", value: "obsidian-web-clipper", type: "text" },
      { name: "tutor_analysis", value: "pending", type: "text" },
      { name: "title", value: "{{title}}", type: "text" },
      { name: "source-url", value: "{{url}}", type: "text" },
      { name: "author", value: "{{author}}", type: "multitext" },
      { name: "published", value: "{{published}}", type: "datetime" },
      { name: "captured-at", value: "{{date}}", type: "datetime" },
      { name: "tags", value: "web-capture", type: "multitext" }
    ],
    triggers: [],
    noteContentFormat: [
      "> [!source]",
      "> [{{title}}]({{url}})",
      "",
      "{{description}}",
      "",
      "## Captured content",
      "",
      "{{content}}",
      "",
      "## Highlights",
      "",
      "{{highlights}}"
    ].join("\n")
  };
}

export function officialWebClipperTemplateJson(path: string): string {
  return `${JSON.stringify(officialWebClipperTemplate(path), null, 2)}\n`;
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  return value === undefined || value === null ? "" : String(value);
}

/** Parse only explicitly marked official-clipping notes; ordinary clips are ignored. */
export function parseOfficialClipperNote(content: string): {
  metadata: OfficialClipperMetadata;
  document: WebCaptureDocument;
} | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return null;
  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseYaml(match[1] ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    frontmatter = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const marker = scalar(frontmatter.tutor_capture);
  const source = scalar(frontmatter.capture_source);
  if (marker !== OFFICIAL_WEB_CLIPPER_TEMPLATE_VERSION || source !== "obsidian-web-clipper") {
    return null;
  }
  const status = scalar(frontmatter.tutor_analysis);
  const analysis: OfficialClipperAnalysisStatus =
    status === "complete" || status === "failed" ? status : "pending";
  const metadata: OfficialClipperMetadata = {
    marker,
    source,
    title: scalar(frontmatter.title),
    url: scalar(frontmatter["source-url"] ?? frontmatter.url),
    author: scalar(frontmatter.author),
    published: scalar(frontmatter.published),
    capturedAt: scalar(frontmatter["captured-at"]),
    analysis
  };
  const markdown = content.slice(match[0].length).split(TUTOR_ANALYSIS_MARKER, 1)[0]!.trim();
  return {
    metadata,
    document: {
      title: metadata.title,
      url: metadata.url,
      capturedAt: metadata.capturedAt,
      markdown,
      source: "obsidian-web-clipper"
    }
  };
}

export function appendTutorAnalysis(content: string, analysis: string): string {
  if (content.includes(TUTOR_ANALYSIS_MARKER)) return content;
  return `${content.trimEnd()}\n\n${TUTOR_ANALYSIS_MARKER}\n## Tutor analysis\n\n${analysis.trim()}\n`;
}
