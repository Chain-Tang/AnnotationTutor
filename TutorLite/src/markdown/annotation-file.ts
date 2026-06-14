// Parse / serialize a single per-annotation Markdown file.
//
// The file is the source of truth for one annotation. The plugin owns the
// metadata, Selected Text, and User Note; the AGENT owns Agent Review and
// Review History. `updateAnnotationMarkdown` is the protected-section
// guarantee: it rewrites only plugin-owned regions and splices the agent's
// content back verbatim (spec §8.2).

import {
  type Anchor,
  type Annotation,
  type AnnotationStatus,
  annotationStatuses,
  bareBlockId,
  caretId
} from "../model.js";
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
  fromBlockquote,
  getSection,
  parseList,
  parseMetadata,
  splitSections,
  stripCode,
  toBlockquote
} from "./blocks.js";
import { isReviewPlaceholder, parseAgentReview, reviewPlaceholder } from "./review.js";

export type AnnotationPatch = {
  userNote?: string;
  status?: AnnotationStatus;
  concepts?: string[];
  relatedMemoryCells?: string[];
  anchor?: Partial<Anchor>;
  updatedAt?: string;
};

export function serializeAnnotation(
  annotation: Annotation,
  memoryRoot = "Agent Memory"
): string {
  const reviewBody =
    annotation.reviewText && annotation.reviewText.trim()
      ? annotation.reviewText.trim()
      : reviewPlaceholder();
  const historyBody = annotation.reviewHistory?.trim() ?? "";

  const body = [
    `# ${annotation.id}`,
    `## Selected Text\n\n${toBlockquote(annotation.anchor.selectedText)}`,
    `## User Note\n\n${toBlockquote(annotation.userNote)}`,
    `## Agent Review\n\n${reviewBody}`,
    historyBody
      ? `## Review History\n\n${historyBody}`
      : "## Review History"
  ].join("\n\n");

  return renderFrontmatter(
    {
      schema: 2,
      kind: "annotation",
      id: annotation.id,
      source_file: annotation.sourceFile,
      block_id: caretId(annotation.anchor.blockId),
      anchor_origin: annotation.anchorOrigin ?? "generated",
      status: annotation.status,
      concepts: annotation.concepts,
      related_cells: annotation.relatedMemoryCells.map((id) =>
        wikiLink(`${memoryRoot}/memory-cells/${id}`, id)
      ),
      created_at: annotation.createdAt,
      updated_at: annotation.updatedAt
    },
    body
  );
}

export function parseAnnotationFile(markdown: string): Annotation | null {
  const document = parseFrontmatter(markdown);
  if (document) return parseV2Annotation(document);
  return parseLegacyAnnotation(markdown);
}

function parseV2Annotation(
  document: NonNullable<ReturnType<typeof parseFrontmatter>>
): Annotation | null {
  if (document.data.schema !== 2 || document.data.kind !== "annotation") {
    return null;
  }
  const id = typeof document.data.id === "string" ? document.data.id : "";
  const sourceFile =
    typeof document.data.source_file === "string"
      ? document.data.source_file
      : "";
  const blockId =
    typeof document.data.block_id === "string"
      ? bareBlockId(document.data.block_id)
      : "";
  const createdAt =
    typeof document.data.created_at === "string"
      ? document.data.created_at
      : "";
  const updatedAt =
    typeof document.data.updated_at === "string"
      ? document.data.updated_at
      : createdAt;
  if (!id || !sourceFile || !blockId || !createdAt) return null;

  const reviewSection = section(document.body, "Agent Review");
  const reviewText = isReviewPlaceholder(reviewSection)
    ? undefined
    : reviewSection.trim();
  const reviewHistory =
    section(document.body, "Review History").trim() || undefined;
  const review = reviewText
    ? (parseAgentReview(reviewText, updatedAt) ?? undefined)
    : undefined;
  const origin = document.data.anchor_origin;

  return {
    id,
    sourceFile,
    anchor: {
      blockId,
      selectedText: fromBlockquote(section(document.body, "Selected Text"))
    },
    anchorOrigin:
      origin === "generated" || origin === "existing" || origin === "legacy"
        ? origin
        : "legacy",
    userNote: fromBlockquote(section(document.body, "User Note")),
    status: deriveStatus(
      normalizeStatus(
        typeof document.data.status === "string"
          ? document.data.status
          : undefined
      ),
      reviewText !== undefined,
      review !== undefined
    ),
    concepts: stringArray(document.data.concepts),
    relatedMemoryCells: wikiLinkIds(document.data.related_cells),
    review,
    reviewText,
    reviewHistory,
    createdAt,
    updatedAt
  };
}

function parseLegacyAnnotation(markdown: string): Annotation | null {
  const block = extractBlocks(markdown, "annotation")[0];
  if (!block) return null;

  const { lead, sections } = splitSections(block.body);
  const meta = parseMetadata(lead);

  const anchorValue = stripCode(meta.get("anchor") ?? "");
  const createdAt = meta.get("created at") ?? "";
  const updatedAt = meta.get("updated at") ?? createdAt;

  const selectedText = fromBlockquote(getSection(sections, "Selected Text"));
  const reviewSection = getSection(sections, "Agent Review");
  const historySection = getSection(sections, "Review History");

  const reviewText = isReviewPlaceholder(reviewSection)
    ? undefined
    : reviewSection.trim();
  const reviewHistory = historySection.trim() ? historySection.trim() : undefined;
  const review = reviewText
    ? (parseAgentReview(reviewText, updatedAt) ?? undefined)
    : undefined;

  const storedStatus = normalizeStatus(meta.get("status"));

  return {
    id: block.id,
    sourceFile: stripCode(meta.get("source file") ?? ""),
    anchor: {
      blockId: bareBlockId(anchorValue),
      selectedText
    },
    anchorOrigin: "legacy",
    userNote: fromBlockquote(getSection(sections, "User Note")),
    status: deriveStatus(storedStatus, reviewText !== undefined, review !== undefined),
    concepts: parseList(meta.get("concepts") ?? ""),
    relatedMemoryCells: parseList(meta.get("related memory cells") ?? ""),
    review,
    reviewText,
    reviewHistory,
    createdAt,
    updatedAt
  };
}

/**
 * Apply a plugin-owned patch to existing annotation Markdown, preserving the
 * agent-owned Agent Review / Review History sections verbatim. Returns null if
 * the current text has no parseable annotation block (caller decides what to do
 * rather than silently destroying data — spec §16.2).
 */
export function updateAnnotationMarkdown(
  currentMarkdown: string,
  patch: AnnotationPatch,
  memoryRoot = "Agent Memory"
): string | null {
  const existing = parseAnnotationFile(currentMarkdown);
  if (!existing) return null;
  const updated: Annotation = {
    ...existing,
    userNote: patch.userNote ?? existing.userNote,
    status: patch.status ?? existing.status,
    concepts: patch.concepts ?? existing.concepts,
    relatedMemoryCells: patch.relatedMemoryCells ?? existing.relatedMemoryCells,
    anchor: patch.anchor
      ? { ...existing.anchor, ...patch.anchor }
      : existing.anchor,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  };
  return serializeAnnotation(updated, memoryRoot);
}

function normalizeStatus(value: string | undefined): AnnotationStatus {
  const normalized = value?.trim().toLowerCase();
  return (
    annotationStatuses.find((status) => status === normalized) ?? "saved"
  );
}

/**
 * Resolve the effective status from the stored status plus the presence of an
 * agent review. An agent writing a review does not edit the plugin-owned Status
 * line, so we upgrade `saved`/`agent_requested`/`draft` to a reviewed state.
 */
function deriveStatus(
  stored: AnnotationStatus,
  hasReviewText: boolean,
  hasStructuredReview: boolean
): AnnotationStatus {
  if (stored === "archived" || stored === "source_missing") return stored;
  if (hasReviewText) {
    return hasStructuredReview ? "reviewed" : "reviewed_unstructured";
  }
  return stored;
}
