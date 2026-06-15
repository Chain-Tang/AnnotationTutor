// Generator for the per-Vault "notebook": a Zettelkasten-style study notebook
// built from the learner's annotations and dialogue. Pure and deterministic
// (pass `generatedAt` for a stable timestamp) so it is unit-testable; the
// Obsidian file I/O lives in store.ts#writeNotebook.
//
// Structure (literature notes = pages, structure/index notes = chapters/MOC):
//   Notebook/Notebook.md         index / map of content (the entry point)
//   Notebook/pages/<doc>.md      one "literature note" per studied document:
//                                document context + original-text index +
//                                annotation content + dialogue context
//   Notebook/chapters/<topic>.md groups related documents that share a concept
//
// See https://en.wikipedia.org/wiki/Zettelkasten and
// https://www.goodnotes.com/blog/zettelkasten-method for the underlying model.

import type { DialogueTurn, IndexRecord } from "../model.js";
import { toBlockquote, truncate } from "./blocks.js";

export type NotebookFile = { path: string; content: string };

export type NotebookOptions = {
  memoryRoot: string;
  generatedAt?: string;
  /** Folder name under the memory root. Defaults to "Notebook". */
  folder?: string;
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

  const files: NotebookFile[] = [
    { path: `${base}/Notebook.md`, content: renderIndex(pages, chapters, base, options) },
    { path: `${base}/Declaration.md`, content: renderDeclaration(base, options) }
  ];
  for (const page of pages) {
    files.push({ path: page.path, content: renderPage(page, base, options) });
  }
  for (const chapter of chapters) {
    files.push({
      path: `${base}/chapters/${chapter.slug}.md`,
      content: renderChapter(chapter, base, options)
    });
  }
  return files;
}

function renderIndex(
  pages: Page[],
  chapters: Chapter[],
  base: string,
  options: NotebookOptions
): string {
  const lines = header("Notebook", options.generatedAt);
  lines.push(
    "> Your study notebook, built from annotations and tutor dialogue.",
    "> Rebuildable from the **Build notebook** command — edits here are overwritten.",
    `> New here? Open ${link(`${base}/Declaration`, "About this notebook")} for the format and the ideas behind it.`,
    "",
    "## Chapters",
    ""
  );
  if (chapters.length === 0) {
    lines.push("- No related-document chapters yet.");
  } else {
    for (const chapter of chapters) {
      lines.push(
        `- ${link(`${base}/chapters/${chapter.slug}`, chapter.concept)} — ${chapter.pages.length} documents`
      );
      for (const page of chapter.pages) {
        lines.push(`  - ${pageLink(page)}`);
      }
    }
  }

  lines.push("", "## Pages", "");
  if (pages.length === 0) {
    lines.push("- No studied documents yet. Annotate a note to begin.");
  } else {
    for (const page of pages) {
      lines.push(
        `- ${pageLink(page)} — \`${page.sourceFile}\` — ${page.records.length} annotations`
      );
    }
  }

  if (options.generatedAt) lines.push("", `Updated: ${options.generatedAt}`);
  lines.push("");
  return lines.join("\n");
}

function renderPage(page: Page, base: string, options: NotebookOptions): string {
  const lines = header(page.title, options.generatedAt);

  // Optional agent synthesis (hybrid "enrich" pass).
  const synthesis = options.synthesis?.get(page.sourceFile)?.trim();
  if (synthesis) lines.push("## Synthesis", "", synthesis, "");

  // 1. Document context.
  lines.push("## Document context", "");
  lines.push(`- Source: ${link(stripMd(page.sourceFile), page.title)}`);
  lines.push(`- Concepts: ${page.concepts.length ? page.concepts.join(", ") : "None"}`);
  lines.push(`- Annotations: ${page.records.length}`);

  // 2. Original-text index — the anchored excerpts, each a clickable block link.
  lines.push("", "## Original text index", "");
  for (const record of page.records) {
    const excerpt = truncate(record.selectedText ?? "", 160) || "(no excerpt)";
    lines.push(`- ${blockLink(page.sourceFile, record.anchor, excerpt)}`);
  }

  // 3. Annotation content — the learner's note and the tutor's review.
  lines.push("", "## Annotation content", "");
  for (const record of page.records) {
    lines.push(`### ${record.annotationId}`, "");
    lines.push(toBlockquote(record.selectedText ?? ""), "");
    const note = record.userNote ?? record.userNoteSummary;
    if (note?.trim()) lines.push(`**Note:** ${oneLine(note)}`, "");
    const review = record.reviewSummary ?? record.reviewText;
    if (review?.trim()) lines.push(`**Review:** ${oneLine(review)}`, "");
  }

  // 4. Dialogue context — the in-annotation conversations, if any.
  const withDialogue = page.records.filter((r) => (r.dialogue?.length ?? 0) > 0);
  if (withDialogue.length > 0) {
    lines.push("## Dialogue context", "");
    for (const record of withDialogue) {
      lines.push(`### ${record.annotationId}`, "");
      for (const turn of record.dialogue ?? []) {
        lines.push(`**${turnLabel(turn)}:** ${oneLine(turn.text)}`, "");
      }
    }
  }

  // Backlink to the index for navigation.
  lines.push(`See also: ${link(`${base}/Notebook`, "Notebook")}`, "");
  return lines.join("\n");
}

function renderChapter(
  chapter: Chapter,
  base: string,
  options: NotebookOptions
): string {
  const lines = header(chapter.concept, options.generatedAt);
  lines.push(
    `> Documents related through the concept **${chapter.concept}**.`,
    "",
    "## Documents",
    ""
  );
  for (const page of chapter.pages) {
    lines.push(
      `- ${pageLink(page)} — \`${page.sourceFile}\` — ${page.records.length} annotations`
    );
  }
  lines.push("", `See also: ${link(`${base}/Notebook`, "Notebook")}`, "");
  return lines.join("\n");
}

/**
 * A standing "declaration" page: what the notebook is, how to open it, its
 * format, the learning theories behind it, and why it helps. Static content, so
 * the notebook is self-explanatory even on first open.
 */
function renderDeclaration(base: string, options: NotebookOptions): string {
  const lines = header("About This Notebook", options.generatedAt);
  lines.push(
    "> What this notebook is, the ideas behind it, and how to use it.",
    "",
    "## What it is",
    "",
    "A study companion built automatically from the notes you make while reading.",
    "Nothing here is written by hand: it is assembled from your annotations, the",
    "tutor's reviews, your in-margin dialogues, and the memory cells distilled from",
    "them. Your source notes remain the source of truth — rebuild the notebook any",
    "time and it reflects them.",
    "",
    "## How to open it",
    "",
    "- Click the **notebook icon** in the left ribbon (*Open study notebook*), or",
    "- Open the command palette and run **Open study notebook**.",
    "",
    "The first time, it is built on the spot. Run **Build notebook** to refresh it,",
    "or **Enrich notebook with agent** to add AI-written summaries.",
    "",
    "## Format",
    "",
    `- ${link(`${base}/Notebook`, "Notebook")} — the index / map of content; your entry point.`,
    "- **pages/** — one page per document you have studied, in four parts: document",
    "  context, an *original-text index* (links back to each highlighted passage),",
    "  your annotations with the tutor's reviews, and the dialogue you had.",
    "- **chapters/** — pages that group documents sharing a concept, so related",
    "  reading sits together.",
    "",
    "## The ideas behind it",
    "",
    "- **Zettelkasten (slip-box).** Each studied document is a *literature note*;",
    "  the chapters and index are *structure notes* that connect ideas across",
    "  sources, turning scattered notes into a network of knowledge.",
    "- **Active recall & the Feynman technique.** You write what a passage means in",
    "  your own words; explaining it plainly exposes — and then closes — the gaps.",
    "- **Socratic questioning.** The tutor often ends with a question rather than a",
    "  verdict, nudging you one step further.",
    "- **Spaced reinforcement.** Memory cells carry a status and a confidence, so",
    "  what you have and haven't consolidated stays visible and ready for review.",
    "",
    "## Why it helps",
    "",
    "- One place to see everything you've engaged with, in your own words.",
    "- Connections between sources surface on their own, prompting synthesis.",
    "- Your learning memory is plain Markdown you own — searchable and portable.",
    ""
  );
  return lines.join("\n");
}

// --- helpers ----------------------------------------------------------------

function header(title: string, generatedAt?: string): string[] {
  return [
    `# ${title}`,
    "",
    "> Generated by Annotation Tutor Lite. Rebuildable; do not maintain manually.",
    ...(generatedAt ? [`> Updated: ${generatedAt}`] : []),
    ""
  ];
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

function turnLabel(turn: DialogueTurn): string {
  return turn.role === "agent" ? "Tutor" : "You";
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
