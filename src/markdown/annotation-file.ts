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
  type DialogueTurn,
  type AnnotationBranch,
  type AnnotationRequest,
  annotationStatuses,
  bareBlockId,
  caretId
} from "../model.js";
import {
  parseFrontmatter,
  renderFrontmatter,
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
  tracking?: Annotation["tracking"];
  userNote?: string;
  status?: AnnotationStatus;
  concepts?: string[];
  relatedMemoryCells?: string[];
  anchor?: Partial<Anchor>;
  dialogue?: DialogueTurn[];
  branch?: AnnotationBranch;
  request?: AnnotationRequest;
  dialogueRequest?: AnnotationRequest;
  updatedAt?: string;
};

// File labels are fixed English so parsing is locale-independent; the card UI
// shows localized labels separately.
const DIALOGUE_LABEL: Record<DialogueTurn["role"], string> = {
  user: "You",
  agent: "Tutor"
};

/** Render dialogue turns as `### You — <ts>` / `### Tutor — <ts>` blockquotes. */
export function serializeDialogue(turns: DialogueTurn[]): string {
  return turns
    .map((turn) => {
      const label = DIALOGUE_LABEL[turn.role];
      const head = turn.at ? `### ${label} — ${turn.at}` : `### ${label}`;
      return `${head}${turn.id ? ` <!-- turn:${turn.id} -->` : ""}\n\n${toBlockquote(turn.text)}`;
    })
    .join("\n\n");
}

/** Parse the `## Dialogue` section body back into ordered turns (tolerant). */
export function parseDialogue(sectionBody: string): DialogueTurn[] {
  if (!sectionBody.trim()) return [];
  const lines = sectionBody.split(/\r?\n/);
  const turns: DialogueTurn[] = [];
  let role: DialogueTurn["role"] | null = null;
  let at = "";
  let id: string | undefined;
  let buffer: string[] = [];
  const flush = (): void => {
    if (role !== null) {
      const text = fromBlockquote(buffer.join("\n"));
      if (text) turns.push({ role, text, at, ...(id ? { id } : {}) });
    }
    buffer = [];
  };
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const rawTitle = heading[1] ?? "";
      id = /\s*<!-- turn:([\w-]+) -->\s*$/.exec(rawTitle)?.[1];
      const title = rawTitle.replace(/\s*<!-- turn:[\w-]+ -->\s*$/, "");
      const parts = title.split(" — ");
      const label = (parts[0] ?? "").trim().toLowerCase();
      at = parts.length > 1 ? parts.slice(1).join(" — ").trim() : "";
      role = label.startsWith("you") || label.startsWith("user") ? "user" : "agent";
    } else {
      buffer.push(line);
    }
  }
  flush();
  return turns;
}

export function serializeAnnotation(
  annotation: Annotation,
  memoryRoot = "Agent Memory"
): string {
  const schema = annotation.branch || annotation.request || annotation.dialogueRequest || annotation.tracking || annotation.dialogue?.some(turn => turn.id) ? 3 : 2;
  const reviewBody =
    annotation.reviewText && annotation.reviewText.trim()
      ? annotation.reviewText.trim()
      : reviewPlaceholder();
  const historyBody = annotation.reviewHistory?.trim() ?? "";
  const dialogueBody =
    annotation.dialogue && annotation.dialogue.length > 0
      ? serializeDialogue(annotation.dialogue)
      : "";

  // A clickable block-link back to the source, so opening an annotation is one
  // hop from its original text. It lives in the lead (above the first `##`), so
  // it is regenerated on serialize and never parsed back into a field.
  const sourceLink = wikiLink(sourceLinkTarget(annotation), "Open in source");

  const body = [
    `# ${annotation.id}\n\n${sourceLink}`,
    `## Selected Text\n\n${toBlockquote(annotation.anchor.selectedText)}`,
    `## User Note\n\n${toBlockquote(annotation.userNote)}`,
    schema === 3 ? encodedSection("Agent Review", "agent-review", reviewBody) : `## Agent Review\n\n${reviewBody}`,
    historyBody
      ? schema === 3 ? encodedSection("Review History", "review-history", historyBody) : `## Review History\n\n${historyBody}`
      : "## Review History",
    ...(dialogueBody ? [`## Dialogue\n\n${dialogueBody}`] : [])
  ].join("\n\n");

  return renderFrontmatter(
    {
      schema,
      ...(schema === 3 ? { section_lengths: { "agent-review": reviewBody.length, ...(historyBody ? { "review-history": historyBody.length } : {}) } } : {}),
      kind: "annotation",
      id: annotation.id,
      ...(annotation.tracking ? { tracking: annotation.tracking } : {}),
      source_file: annotation.sourceFile,
      block_id: caretId(annotation.anchor.blockId),
      ...(annotation.anchor.sourceType === "pdf" ? { source_type: "pdf" } : {}),
      ...(annotation.anchor.sourceType === "pdf" && annotation.anchor.page
        ? { source_page: annotation.anchor.page }
        : {}),
      anchor_origin: annotation.anchorOrigin ?? "generated",
      status: annotation.status,
      concepts: annotation.concepts,
      related_cells: annotation.relatedMemoryCells.map((id) =>
        wikiLink(`${memoryRoot}/memory-cells/${id}`, id)
      ),
      ...(annotation.branch ? { branch: annotation.branch } : {}),
      ...(annotation.request ? { request: annotation.request } : {}),
      ...(annotation.dialogueRequest ? { dialogue_request: annotation.dialogueRequest } : {}),
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
  if (![2, 3].includes(Number(document.data.schema)) || document.data.kind !== "annotation") {
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

  const unpacked = unpackAnnotationSections(document);
  const reviewSection = unpacked.sections.get("agent-review") ?? annotationSection(unpacked.body, "Agent Review");
  const reviewText = isReviewPlaceholder(reviewSection)
    ? undefined
    : reviewSection.trim();
  const reviewHistory =
    (unpacked.sections.get("review-history") ?? annotationSection(unpacked.body, "Review History")).trim() || undefined;
  const review = reviewText
    ? (parseAgentReview(reviewText, updatedAt) ?? undefined)
    : undefined;
  const dialogue = parseDialogue(annotationSection(unpacked.body, "Dialogue"));
  const origin = document.data.anchor_origin;
  const sourceType =
    document.data.source_type === "pdf" || /\.pdf$/i.test(sourceFile)
      ? "pdf"
      : undefined;
  const rawPage = document.data.source_page;
  const page =
    typeof rawPage === "number" && Number.isInteger(rawPage) && rawPage > 0
      ? rawPage
      : undefined;
  const branch = parseBranch(document.data.branch);
  const request = parseRequest(document.data.request);
  const dialogueRequest = parseRequest(document.data.dialogue_request);
  const tracking = ["ordinary", "private", "excluded"].includes(String(document.data.tracking))
    ? document.data.tracking as Annotation["tracking"] : undefined;
  // Never silently erase malformed lineage or request metadata on a later save.
  if (document.data.branch !== undefined && !branch || document.data.request !== undefined && !request
    || document.data.dialogue_request !== undefined && !dialogueRequest) return null;

  return {
    id,
    ...(tracking ? { tracking } : {}),
    sourceFile,
    anchor: {
      blockId,
      selectedText: fromBlockquote(annotationSection(unpacked.body, "Selected Text")),
      ...(sourceType ? { sourceType } : {}),
      ...(page ? { page } : {})
    },
    anchorOrigin:
      origin === "generated" || origin === "existing" || origin === "legacy"
        ? origin
        : "legacy",
    userNote: fromBlockquote(annotationSection(unpacked.body, "User Note")),
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
    ...(dialogue.length > 0 ? { dialogue } : {}),
    ...(branch ? { branch } : {}),
    ...(request ? { request } : {}),
    ...(dialogueRequest ? { dialogueRequest } : {}),
    createdAt,
    updatedAt
  };
}

function encodedSection(title: string, key: string, text: string): string {
  return `## ${title}\n\n<!-- tutor-section:${key}:start -->\n${text}\n<!-- tutor-section:${key}:end -->`;
}

/** Length-delimited schema-3 regions keep arbitrary reply headings/markers inert. */
function unpackAnnotationSections(document: NonNullable<ReturnType<typeof parseFrontmatter>>): { body: string; sections: Map<string, string> } {
  let body = document.body;
  const sections = new Map<string, string>();
  const lengths = object(document.data.section_lengths);
  for (const [key, title] of [["agent-review", "Agent Review"], ["review-history", "Review History"]] as const) {
    const size = lengths?.[key];
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) continue;
    const marker = `<!-- tutor-section:${key}:start -->\n`, endMarker = `\n<!-- tutor-section:${key}:end -->`;
    const heading = `## ${title}\n\n${marker}`;
    const start = body.indexOf(heading);
    if (start < 0) continue;
    const contentStart = start + heading.length, contentEnd = contentStart + size;
    if (body.slice(contentEnd, contentEnd + endMarker.length) !== endMarker) continue;
    sections.set(key, body.slice(contentStart, contentEnd));
    // Hide reply/history headings from every other annotation-section parser.
    body = body.slice(0, start) + `## ${title}\n` + body.slice(contentEnd + endMarker.length);
  }
  return { body, sections };
}

/** Tutor replies may contain ordinary level-two headings and fenced examples. */
function annotationSection(body: string, title: string): string {
  const lines = body.split(/\r?\n/), wanted = title.toLowerCase();
  const known = new Set(["selected text", "user note", "agent review", "review history", "dialogue"]);
  let start = -1, fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!, fenced = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenced) { if (!fence) fence = fenced[0]; else if (fenced[0] === fence) fence = undefined; continue; }
    if (fence) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.toLowerCase();
    if (!heading || !known.has(heading)) continue;
    if (start >= 0) return lines.slice(start, index).join("\n").trim();
    if (heading === wanted) start = index + 1;
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : "";
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
    tracking: patch.tracking ?? existing.tracking,
    userNote: patch.userNote ?? existing.userNote,
    status: patch.status ?? existing.status,
    concepts: patch.concepts ?? existing.concepts,
    relatedMemoryCells: patch.relatedMemoryCells ?? existing.relatedMemoryCells,
    anchor: patch.anchor
      ? { ...existing.anchor, ...patch.anchor }
      : existing.anchor,
    dialogue: patch.dialogue ?? existing.dialogue,
    branch: patch.branch ?? existing.branch,
    request: patch.request ?? existing.request,
    dialogueRequest: patch.dialogueRequest ?? existing.dialogueRequest,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  };
  return serializeAnnotation(updated, memoryRoot);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseBranch(value: unknown): AnnotationBranch | undefined {
  const data = object(value), reply = object(data?.parentReply);
  if (!data || !reply || !["parentAnnotationId", "rootAnnotationId", "sourceVersion"].every(key => typeof data[key] === "string" && data[key])
    || !["id", "version", "text"].every(key => typeof reply[key] === "string" && reply[key])
    || !["review", "dialogue"].includes(String(reply.kind))) return undefined;
  if (reply.history !== undefined && (!Array.isArray(reply.history) || !reply.history.every(entry => {
    const item = object(entry); return !!item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string";
  }))) return undefined;
  return { parentAnnotationId: data.parentAnnotationId as string, rootAnnotationId: data.rootAnnotationId as string,
    sourceVersion: data.sourceVersion as string, parentReply: { id: reply.id as string, kind: reply.kind as "review" | "dialogue", version: reply.version as string, text: reply.text as string,
      ...(typeof reply.question === "string" ? { question: reply.question } : {}), ...(typeof reply.contextVersion === "string" ? { contextVersion: reply.contextVersion } : {}),
      ...(Array.isArray(reply.history) ? { history: reply.history as Array<{ role: "user" | "assistant"; content: string }> } : {}) } };
}

function parseRequest(value: unknown): AnnotationRequest | undefined {
  const data = object(value);
  if (!data || typeof data.id !== "string" || !data.id || typeof data.question !== "string" || typeof data.updatedAt !== "string"
    || !["draft", "generating", "completed", "failed", "cancelled", "interrupted"].includes(String(data.status))) return undefined;
  return { id: data.id, question: data.question, updatedAt: data.updatedAt, status: data.status as AnnotationRequest["status"],
    ...(typeof data.startedAt === "string" ? { startedAt: data.startedAt } : {}),
    ...(typeof data.contextVersion === "string" ? { contextVersion: data.contextVersion } : {}),
    ...(typeof data.sourceVersion === "string" ? { sourceVersion: data.sourceVersion } : {}),
    ...(typeof data.errorCode === "string" ? { errorCode: data.errorCode } : {}) };
}

function stripExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function sourceLinkTarget(annotation: Annotation): string {
  if (annotation.anchor.sourceType === "pdf" || /\.pdf$/i.test(annotation.sourceFile)) {
    return annotation.anchor.page
      ? `${annotation.sourceFile}#page=${annotation.anchor.page}`
      : annotation.sourceFile;
  }
  return `${stripExtension(annotation.sourceFile)}#${caretId(annotation.anchor.blockId)}`;
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
