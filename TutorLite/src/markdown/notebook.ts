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
import { truncate } from "./blocks.js";

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

  const pages: Page[] = [...byDoc.entries()]
    .map(([sourceFile, recs]) => {
      const sorted = [...recs].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
      const slug = slugify(sourceFile);
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
  const chapters: Chapter[] = [...conceptPages.entries()]
    .filter(([, ps]) => ps.length >= 2)
    .map(([concept, ps]) => ({ concept, slug: slugify(concept), pages: ps }))
    .sort((a, b) => a.concept.localeCompare(b.concept));

  const files: NotebookFile[] = [
    { path: `${base}/Notebook.md`, content: renderIndex(pages, chapters, base, options) }
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
    lines.push(toQuote(record.selectedText ?? ""), "");
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

function toQuote(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return ">";
  return trimmed
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
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

/** A filesystem-safe, collision-resistant slug from a Vault path or concept. */
function slugify(value: string): string {
  const slug = stripMd(value)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
