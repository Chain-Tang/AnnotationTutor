// Generator for the per-Vault "notebook": a Zettelkasten-style study notebook
// built from the learner's annotations and dialogue. Pure and deterministic
// (pass `generatedAt` for a stable timestamp) so it is unit-testable; the
// Obsidian file I/O lives in store.ts#writeNotebook. Structural strings are
// localized via `notebook-labels.ts` (the locale is passed in).
//
// Structure (literature notes = pages, structure/index notes = chapters/MOC):
//   Notebook/Notebook.md         index / map of content (the entry point)
//   Notebook/pages/<doc>.md      one "literature note" per studied document
//   Notebook/chapters/<topic>.md groups related documents that share a concept
//
// See https://en.wikipedia.org/wiki/Zettelkasten for the underlying model.

import type { Locale } from "../i18n.js";
import type { DialogueTurn, IndexRecord, MemoryCell } from "../model.js";
import { classifyCells } from "../learning.js";
import { toBlockquote, truncate } from "./blocks.js";
import { notebookLabels, type NotebookLabels } from "./notebook-labels.js";

export type NotebookFile = { path: string; content: string };

export type NotebookOptions = {
  memoryRoot: string;
  generatedAt?: string;
  /** UI language for the notebook's headings/labels. Defaults to English. */
  locale?: Locale;
  /** Folder name under the memory root. Defaults to "Notebook". */
  folder?: string;
  /** Memory cells, used for the learner summary + per-page strengths/weaknesses. */
  cells?: MemoryCell[];
  /** Optional agent-written synthesis per source document, keyed by source path. */
  synthesis?: Map<string, string>;
};

type Page = {
  sourceFile: string;
  title: string;
  slug: string;
  path: string;
  records: IndexRecord[];
  concepts: string[];
};

type Chapter = {
  concept: string;
  slug: string;
  pages: Page[];
};

/** Build every notebook file from the current annotation index. */
export function buildNotebook(
  records: IndexRecord[],
  options: NotebookOptions
): NotebookFile[] {
  const base = `${options.memoryRoot}/${options.folder ?? "Notebook"}`;
  const labels = notebookLabels(options.locale);
  const cells = options.cells ?? [];

  const byDoc = new Map<string, IndexRecord[]>();
  for (const record of records) {
    const list = byDoc.get(record.sourceFile);
    if (list) list.push(record);
    else byDoc.set(record.sourceFile, [record]);
  }

  // Assign slugs in a stable order (by source path) so two paths that slugify
  // alike get distinct, deterministic filenames instead of silently colliding.
  const usedPageSlugs = new Set<string>();
  const pages: Page[] = [...byDoc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sourceFile, recs]) => {
      const sorted = [...recs].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
      const slug = uniqueSlug(slugify(sourceFile), usedPageSlugs);
      return {
        sourceFile,
        title: basename(sourceFile),
        slug,
        path: `${base}/pages/${slug}.md`,
        records: sorted,
        concepts: unique(sorted.flatMap((record) => record.concepts))
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  // A "chapter" gathers documents that share a concept — i.e. related reading.
  const conceptPages = new Map<string, Page[]>();
  for (const page of pages) {
    for (const concept of page.concepts) {
      const list = conceptPages.get(concept);
      if (list) list.push(page);
      else conceptPages.set(concept, [page]);
    }
  }
  const usedChapterSlugs = new Set<string>();
  const chapters: Chapter[] = [...conceptPages.entries()]
    .filter(([, ps]) => ps.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([concept, ps]) => ({
      concept,
      slug: uniqueSlug(slugify(concept), usedChapterSlugs),
      pages: ps
    }))
    .sort((a, b) => a.concept.localeCompare(b.concept));

  const hasSummary = cells.length > 0;
  const files: NotebookFile[] = [
    {
      path: `${base}/Notebook.md`,
      content: renderIndex(pages, chapters, base, options, labels, hasSummary)
    },
    { path: `${base}/Declaration.md`, content: renderDeclaration(options, labels) }
  ];
  if (hasSummary) {
    files.push({
      path: `${base}/Learning summary.md`,
      content: renderLearnerSummary(cells, options, labels)
    });
  }
  for (const page of pages) {
    files.push({ path: page.path, content: renderPage(page, base, options, labels, cells) });
  }
  for (const chapter of chapters) {
    files.push({
      path: `${base}/chapters/${chapter.slug}.md`,
      content: renderChapter(chapter, base, options, labels)
    });
  }
  return files;
}

function renderIndex(
  pages: Page[],
  chapters: Chapter[],
  base: string,
  options: NotebookOptions,
  L: NotebookLabels,
  hasSummary: boolean
): string {
  const lines = header(L.notebookName, L, options.generatedAt);
  lines.push(
    `> ${L.indexIntro}`,
    `> ${L.rebuildNote}`,
    `> ${L.newHerePrefix}${link(`${base}/Declaration`, L.aboutName)}${L.newHereSuffix}`
  );
  if (hasSummary) {
    lines.push(`> ${link(`${base}/Learning summary`, L.learningSummaryName)}`);
  }
  lines.push("", `## ${L.chapters}`, "");
  if (chapters.length === 0) {
    lines.push(`- ${L.noChapters}`);
  } else {
    for (const chapter of chapters) {
      lines.push(
        `- ${link(`${base}/chapters/${chapter.slug}`, chapter.concept)} — ${fmt(L.documentsCount, { n: chapter.pages.length })}`
      );
      for (const page of chapter.pages) lines.push(`  - ${pageLink(page)}`);
    }
  }

  lines.push("", `## ${L.pages}`, "");
  if (pages.length === 0) {
    lines.push(`- ${L.noPages}`);
  } else {
    for (const page of pages) {
      lines.push(
        `- ${pageLink(page)} — \`${page.sourceFile}\` — ${fmt(L.annotationsCount, { n: page.records.length })}`
      );
    }
  }

  if (options.generatedAt) lines.push("", `${L.updated}: ${options.generatedAt}`);
  lines.push("");
  return lines.join("\n");
}

function renderPage(
  page: Page,
  base: string,
  options: NotebookOptions,
  L: NotebookLabels,
  cells: MemoryCell[]
): string {
  const lines = header(page.title, L, options.generatedAt);

  // Optional agent synthesis (hybrid "enrich" pass).
  const synthesis = options.synthesis?.get(page.sourceFile)?.trim();
  if (synthesis) lines.push(`## ${L.synthesis}`, "", synthesis, "");

  // 1. Document context.
  lines.push(`## ${L.documentContext}`, "");
  lines.push(`- ${L.source}: ${link(stripMd(page.sourceFile), page.title)}`);
  lines.push(`- ${L.concepts}: ${page.concepts.length ? page.concepts.join(", ") : L.none}`);
  lines.push(`- ${L.annotationsLabel}: ${page.records.length}`);

  // Real content (not just an index): what the cells from this document's
  // annotations show the learner grasped vs. should revisit.
  const ids = new Set(page.records.map((r) => r.annotationId));
  const pageCells = cells.filter((c) => c.sourceAnnotations.some((a) => ids.has(a)));
  if (pageCells.length > 0) {
    const { strengths, weaknesses } = classifyCells(pageCells);
    lines.push("", `## ${L.grasped} · ${L.revisit}`, "");
    lines.push(`**${L.grasped}:**`);
    pushCellBullets(lines, strengths, options.memoryRoot, L);
    lines.push(`**${L.revisit}:**`);
    pushCellBullets(lines, weaknesses, options.memoryRoot, L);
  }

  // 2. Original-text index — the anchored excerpts, each a clickable block link.
  lines.push("", `## ${L.originalTextIndex}`, "");
  for (const record of page.records) {
    const excerpt = truncate(record.selectedText ?? "", 160) || L.noExcerpt;
    lines.push(`- ${blockLink(page.sourceFile, record.anchor, excerpt)}`);
  }

  // 3. Annotation content — the learner's note and the tutor's review.
  lines.push("", `## ${L.annotationContent}`, "");
  for (const record of page.records) {
    lines.push(`### ${record.annotationId}`, "");
    lines.push(toBlockquote(record.selectedText ?? ""), "");
    const note = record.userNote ?? record.userNoteSummary;
    if (note?.trim()) lines.push(`**${L.note}:** ${oneLine(note)}`, "");
    const review = record.reviewSummary ?? record.reviewText;
    if (review?.trim()) lines.push(`**${L.review}:** ${oneLine(review)}`, "");
  }

  // 4. Dialogue context — the in-annotation conversations, if any.
  const withDialogue = page.records.filter((r) => (r.dialogue?.length ?? 0) > 0);
  if (withDialogue.length > 0) {
    lines.push(`## ${L.dialogueContext}`, "");
    for (const record of withDialogue) {
      lines.push(`### ${record.annotationId}`, "");
      for (const turn of record.dialogue ?? []) {
        lines.push(`**${turnLabel(turn, L)}:** ${oneLine(turn.text)}`, "");
      }
    }
  }

  // Backlink to the index for navigation.
  lines.push(`${L.seeAlso}: ${link(`${base}/Notebook`, L.notebookName)}`, "");
  return lines.join("\n");
}

function renderChapter(
  chapter: Chapter,
  base: string,
  options: NotebookOptions,
  L: NotebookLabels
): string {
  const lines = header(chapter.concept, L, options.generatedAt);
  lines.push(
    `> ${fmt(L.relatedThrough, { concept: chapter.concept })}`,
    "",
    `## ${L.documents}`,
    ""
  );
  for (const page of chapter.pages) {
    lines.push(
      `- ${pageLink(page)} — \`${page.sourceFile}\` — ${fmt(L.annotationsCount, { n: page.records.length })}`
    );
  }
  lines.push("", `${L.seeAlso}: ${link(`${base}/Notebook`, L.notebookName)}`, "");
  return lines.join("\n");
}

/**
 * The learner summary: strengths, weaknesses, and problem-solving methods,
 * classified from the memory cells (see learning.ts). Deterministic; the opt-in
 * "learning summary" feature can layer agent prose on top later.
 */
function renderLearnerSummary(
  cells: MemoryCell[],
  options: NotebookOptions,
  L: NotebookLabels
): string {
  const lines = header(L.learningSummaryName, L, options.generatedAt);
  const { strengths, weaknesses, methods } = classifyCells(cells);
  lines.push(`> ${L.summaryIntro}`, "");
  for (const [title, group] of [
    [L.strengths, strengths],
    [L.weaknesses, weaknesses],
    [L.methods, methods]
  ] as const) {
    lines.push(`## ${title}`, "");
    pushCellBullets(lines, group, options.memoryRoot, L);
  }
  return lines.join("\n");
}

/** Append cell links as a bullet list, or a single "none" bullet when empty. */
function pushCellBullets(
  lines: string[],
  cells: MemoryCell[],
  memoryRoot: string,
  L: NotebookLabels
): void {
  if (cells.length === 0) lines.push(`- ${L.none}`, "");
  else {
    for (const cell of cells) lines.push(`- ${cellLink(memoryRoot, cell)}`);
    lines.push("");
  }
}

function cellLink(memoryRoot: string, cell: MemoryCell): string {
  return link(`${memoryRoot}/memory-cells/${cell.id}`, cell.concept);
}

/**
 * A standing "declaration" page: what the notebook is, how to open it, its
 * format, the learning theories behind it, and why it helps. Localized so the
 * notebook is self-explanatory in the learner's language even on first open.
 */
function renderDeclaration(options: NotebookOptions, L: NotebookLabels): string {
  return [...header(L.declarationTitle, L, options.generatedAt), ...L.declaration].join("\n");
}

// --- helpers ----------------------------------------------------------------

function header(title: string, L: NotebookLabels, generatedAt?: string): string[] {
  return [
    `# ${title}`,
    "",
    `> ${L.generatedNote}`,
    ...(generatedAt ? [`> ${L.updated}: ${generatedAt}`] : []),
    ""
  ];
}

function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
}

function link(path: string, label: string): string {
  return `[[${path}|${label}]]`;
}

/** A wikilink to a page note (extension stripped, as Obsidian links want). */
function pageLink(page: Page): string {
  return link(stripMd(page.path), page.title);
}

function blockLink(sourceFile: string, anchor: string, label: string): string {
  const caret = anchor.startsWith("^") ? anchor : `^${anchor}`;
  return `[[${stripMd(sourceFile)}#${caret}|${label}]]`;
}

function turnLabel(turn: DialogueTurn, L: NotebookLabels): string {
  return turn.role === "agent" ? L.tutor : L.you;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function basename(path: string): string {
  return stripMd(path.split("/").pop() ?? path);
}

function stripMd(path: string): string {
  return path.replace(/\.md$/i, "");
}

/** A filesystem-safe slug from a Vault path or concept. */
function slugify(value: string): string {
  const slug = stripMd(value)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/** Make `base` unique within `used` by appending -2, -3, … on collision. */
function uniqueSlug(base: string, used: Set<string>): string {
  let slug = base;
  for (let n = 2; used.has(slug); n += 1) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
