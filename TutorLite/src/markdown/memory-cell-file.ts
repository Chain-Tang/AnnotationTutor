import type { MemoryCell, MemoryCellStatus, MemoryCellType } from "../model.js";
import { memoryCellSchema } from "../schemas.js";
import {
  parseFrontmatter,
  renderFrontmatter,
  section,
  stringArray,
  wikiLink,
  wikiLinkIds
} from "./frontmatter.js";
import {
  extractBlocks,
  getSection,
  parseList,
  parseMetadata,
  splitSections
} from "./blocks.js";

export function serializeMemoryCell(
  cell: MemoryCell,
  memoryRoot = "Agent Memory"
): string {
  const data: Record<string, unknown> = {
    schema: 2,
    kind: "memory-cell",
    id: cell.id,
    type: cell.type,
    status: cell.status,
    concept: cell.concept,
    ...(cell.domain ? { domain: cell.domain } : {}),
    confidence: cell.confidence,
    tags: cell.tags,
    source_annotations: cell.sourceAnnotations.map((id) =>
      wikiLink(`${memoryRoot}/annotations/${id}`, id)
    ),
    ...(cell.validFrom ? { valid_from: cell.validFrom } : {}),
    ...(cell.validUntil ? { valid_until: cell.validUntil } : {}),
    ...(cell.supersedes ? { supersedes: cell.supersedes } : {}),
    created_at: cell.createdAt,
    updated_at: cell.updatedAt
  };
  const body = [
    `# ${cell.concept}`,
    "",
    "## Summary",
    "",
    cell.summary,
    "",
    "## Agent Guidance",
    "",
    cell.agentGuidance ?? ""
  ].join("\n");
  return renderFrontmatter(data, body);
}

export function parseMemoryCellFile(markdown: string): MemoryCell | null {
  const document = parseFrontmatter(markdown);
  if (!document) return parseLegacyMemoryCell(markdown);
  if (document.data.kind !== "memory-cell" || document.data.schema !== 2) {
    return null;
  }
  const candidate = {
    id: document.data.id,
    type: document.data.type,
    concept: document.data.concept,
    status: document.data.status,
    summary: section(document.body, "Summary"),
    sourceAnnotations: wikiLinkIds(document.data.source_annotations),
    tags: stringArray(document.data.tags),
    confidence: document.data.confidence,
    createdAt: document.data.created_at,
    updatedAt: document.data.updated_at,
    ...(typeof document.data.domain === "string"
      ? { domain: document.data.domain }
      : {}),
    ...(typeof document.data.valid_from === "string"
      ? { validFrom: document.data.valid_from }
      : {}),
    ...(typeof document.data.valid_until === "string"
      ? { validUntil: document.data.valid_until }
      : {}),
    ...(Array.isArray(document.data.supersedes)
      ? { supersedes: stringArray(document.data.supersedes) }
      : {}),
    ...(section(document.body, "Agent Guidance")
      ? { agentGuidance: section(document.body, "Agent Guidance") }
      : {})
  };
  const parsed = memoryCellSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseLegacyMemoryCell(markdown: string): MemoryCell | null {
  const block = extractBlocks(markdown, "memory-cell")[0];
  if (!block) return null;
  const { lead, sections } = splitSections(block.body);
  const meta = parseMetadata(lead);
  const id = block.id;
  const lastUpdated = meta.get("last updated") ?? "";
  const candidate: MemoryCell = {
    id,
    type: "understanding" as MemoryCellType,
    concept: meta.get("concept") ?? "",
    domain: meta.get("domain") || undefined,
    status: normalizeLegacyStatus(meta.get("status")),
    summary: getSection(sections, "Summary").trim(),
    sourceAnnotations: parseList(meta.get("source annotations") ?? ""),
    tags: [],
    confidence: 0.5,
    agentGuidance:
      getSection(sections, "Agent Guidance").trim() || undefined,
    createdAt: normalizeLegacyDate(lastUpdated),
    updatedAt: normalizeLegacyDate(lastUpdated)
  };
  return memoryCellSchema.safeParse(candidate).success ? candidate : null;
}

function normalizeLegacyStatus(value: string | undefined): MemoryCellStatus {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const statuses: MemoryCellStatus[] = [
    "new",
    "partially_understood",
    "stable",
    "needs_review",
    "draft",
    "active",
    "superseded",
    "archived"
  ];
  return statuses.find((status) => status === normalized) ?? "new";
}

function normalizeLegacyDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : "1970-01-01T00:00:00.000Z";
}
