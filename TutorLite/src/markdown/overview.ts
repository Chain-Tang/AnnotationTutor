// Generators for the agent-facing files in `Agent Memory/`:
//   - annotation-memory.md  (overview / index — the agent's entry point)
//   - recent-learning.md    (short learning summary)
//   - AGENTS.md             (instructions, spec §14)
// plus the copyable per-annotation review prompt.
//
// All outputs are deterministic given their inputs (pass `generatedAt` for a
// stable timestamp), which keeps them unit-testable.

import type { IndexRecord, MemoryCell, Scene } from "../model.js";
import { requiredOutput } from "./inbox.js";

export type OverviewOptions = {
  memoryRoot: string;
  generatedAt?: string;
  memoryWriteMode?: "direct" | "confirmation";
  allowPreferenceWrites?: boolean;
  /** Language for review content. Empty/undefined = match the learner's note. */
  reviewLanguage?: string;
};

/**
 * One sentence telling the agent which language to write the review *content* in,
 * while keeping the structured labels and the Correctness value in English so the
 * review parser still recognizes them. Shared by the auto-run prompt, the copyable
 * manual prompt, and AGENTS.md.
 */
export function reviewLanguageInstruction(reviewLanguage?: string): string {
  const target = reviewLanguage?.trim();
  const base = target
    ? `Write the review content in ${target}.`
    : "Write the review content in the same language as the learner's note.";
  return `${base} Keep the field labels and the Correctness value in English.`;
}

const SUGGESTED_BEHAVIOR = [
  "Read the learner profile and recent learning first; tailor depth, examples, and tone to this learner.",
  "Ask the learner to explain their understanding before correcting it.",
  "Correct misunderstandings gently and cite the annotation ID and source file.",
  "Separate evidence from the source document from general background knowledge.",
  "Never overwrite a User Note. Prefer appending over rewriting."
];

export function defaultReviewRequest(): string {
  return "Please review my understanding of this annotation. If needed, inspect the source Markdown file.";
}

export function copyablePrompt(record: IndexRecord, reviewLanguage?: string): string {
  return [
    `Review my learning annotation ${record.annotationId}.`,
    "",
    `- Annotation memory file: \`${record.memoryFile}\``,
    `- Source file: \`${record.sourceFile}\``,
    `- Anchor: \`${record.anchor}\``,
    "",
    "Read the Selected Text and User Note from the memory file, inspect the source",
    "file around the anchor if helpful, then:",
    "",
    requiredOutput(record.memoryFile),
    "",
    reviewLanguageInstruction(reviewLanguage)
  ].join("\n");
}

export function renderAgentInstructions(options: OverviewOptions): string {
  const root = options.memoryRoot;
  const writeInstructions =
    options.memoryWriteMode === "confirmation"
      ? [
          `11. Write proposed Cell, Scene, or Profile changes under \`${root}/proposals/pending/\`.`,
          "12. Do not write those proposed changes directly into the formal memory folders."
        ]
      : [
          `11. You may write valid Cells, Scenes, and Learner Profile updates directly under \`${root}/\`.`,
          "12. Never delete formal memory files; use archived or superseded status."
        ];
  const preferenceInstruction = options.allowPreferenceWrites
    ? `13. Preference memory is enabled; evidence-backed preferences may be updated in \`${root}/profiles/preferences.md\`.`
    : "13. Do not read or update `profiles/preferences.md`; preference memory is disabled.";
  const languageInstruction = `14. ${reviewLanguageInstruction(options.reviewLanguage)}`;
  return [
    "# Annotation Tutor Agent Instructions",
    "",
    "When working with this Vault:",
    "",
    `1. Read \`${root}/annotation-memory.md\` for an overview of the learner's state, then \`${root}/profiles/learner-profile.md\` and \`${root}/recent-learning.md\` to tailor your feedback to this learner.`,
    `2. Read \`${root}/agent-inbox.md\` for pending review tasks.`,
    `3. Each annotation lives in its own file under \`${root}/annotations/\`.`,
    `4. Memory cells live under \`${root}/memory-cells/\`.`,
    "5. Open source Markdown files only when you need the original context.",
    "6. Never overwrite the **User Note** section of an annotation.",
    "7. Write your review into the **Agent Review** section of that annotation file.",
    "8. Prefer appending over rewriting; move older reviews to **Review History**.",
    "9. For durable insights, create or update a memory cell.",
    "10. When you finish a task, set its Status to `completed` in `agent-inbox.md`.",
    ...writeInstructions,
    preferenceInstruction,
    languageInstruction,
    ""
  ].join("\n");
}

export function renderAnnotationIndex(
  records: IndexRecord[],
  options: OverviewOptions
): string {
  const lines = generatedHeader("Annotation Index", options.generatedAt);
  for (const record of [...records].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )) {
    lines.push(
      `- [[${options.memoryRoot}/annotations/${record.annotationId}|${record.annotationId}]] — ${record.status} — [[${stripMd(record.sourceFile)}|source]]`
    );
  }
  if (records.length === 0) lines.push("- No annotations yet.");
  return `${lines.join("\n")}\n`;
}

export function renderCellIndex(
  cells: MemoryCell[],
  options: OverviewOptions
): string {
  const lines = generatedHeader("Cell Index", options.generatedAt);
  for (const cell of [...cells].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )) {
    lines.push(
      `- [[${options.memoryRoot}/memory-cells/${cell.id}|${cell.concept}]] — ${cell.type} — ${cell.status}`
    );
  }
  if (cells.length === 0) lines.push("- No memory cells yet.");
  return `${lines.join("\n")}\n`;
}

export function renderSceneIndex(
  scenes: Scene[],
  options: OverviewOptions
): string {
  const lines = generatedHeader("Scene Index", options.generatedAt);
  for (const scene of [...scenes].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )) {
    lines.push(
      `- [[${options.memoryRoot}/scenes/${scene.id}|${scene.title}]] — ${scene.type} — ${scene.status}`
    );
  }
  if (scenes.length === 0) lines.push("- No scenes yet.");
  return `${lines.join("\n")}\n`;
}

export function renderOverview(
  records: IndexRecord[],
  memoryCells: MemoryCell[],
  options: OverviewOptions
): string {
  const sorted = [...records].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  const concepts = unique(sorted.flatMap((record) => record.concepts));
  const confusions = sorted
    .filter(
      (record) =>
        record.status === "agent_requested" ||
        record.status === "reviewed_unstructured"
    )
    .map((record) => `${record.annotationId} (${record.status})`);

  const lines: string[] = [
    "# Annotation Memory",
    "",
    "> This file is generated by Annotation Tutor Lite.",
    "> Each annotation has its own file under `annotations/`; write reviews there.",
    "",
    "## Agent Instructions",
    "",
    "See `AGENTS.md` in this folder. In short: never overwrite a User Note, write",
    "reviews into the annotation's Agent Review section, prefer appending.",
    "",
    "## Recent Learning Summary",
    "",
    "- Recently studied:",
    ...bullets(concepts, 2),
    "- Active confusions:",
    ...bullets(confusions, 2),
    "- Suggested agent behavior:",
    ...SUGGESTED_BEHAVIOR.map((item) => `  - ${item}`),
    "",
    "## Memory Cells",
    ""
  ];

  if (memoryCells.length === 0) {
    lines.push("- None yet.");
  } else {
    for (const cell of memoryCells) {
      lines.push(
        `- ${cell.id} — ${cell.concept || "(untitled)"} — ${cell.status} — \`${rel(
          options.memoryRoot,
          memoryCellPath(options.memoryRoot, cell.id)
        )}\``
      );
    }
  }

  lines.push("", "## Annotation Index", "");
  if (sorted.length === 0) {
    lines.push("- No annotations yet.");
  } else {
    for (const record of sorted) {
      lines.push(
        `- ${record.annotationId} — ${record.status} — \`${record.sourceFile}\` — \`${rel(
          options.memoryRoot,
          record.memoryFile
        )}\``
      );
      if (record.userNoteSummary) {
        lines.push(`  - Note: ${record.userNoteSummary}`);
      }
      if (record.reviewSummary) {
        lines.push(`  - Review: ${record.reviewSummary}`);
      }
    }
  }

  if (options.generatedAt) {
    lines.push("", `Updated: ${options.generatedAt}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderRecentLearning(
  records: IndexRecord[],
  options: OverviewOptions
): string {
  const sorted = [...records].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  const concepts = unique(sorted.flatMap((record) => record.concepts));
  const reviewed = sorted.filter((record) => record.status === "reviewed");
  const needsAttention = sorted.filter(
    (record) =>
      record.status === "agent_requested" ||
      record.status === "reviewed_unstructured" ||
      record.status === "source_missing"
  );

  const lines: string[] = [
    "# Recent Learning",
    "",
    "## Recently Studied",
    "",
    ...bullets(concepts, 0),
    "",
    "## Needs Attention",
    "",
    ...bullets(
      needsAttention.map((record) => `${record.annotationId} (${record.status})`),
      0
    ),
    "",
    "## Reviewed",
    "",
    ...bullets(
      reviewed.map((record) => `${record.annotationId} — \`${record.sourceFile}\``),
      0
    )
  ];

  if (options.generatedAt) {
    lines.push("", `Updated: ${options.generatedAt}`);
  }
  lines.push("");
  return lines.join("\n");
}

function memoryCellPath(memoryRoot: string, id: string): string {
  return `${memoryRoot}/memory-cells/${id}.md`;
}

function rel(memoryRoot: string, fullPath: string): string {
  const prefix = memoryRoot.endsWith("/") ? memoryRoot : `${memoryRoot}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

function bullets(items: string[], indent: number): string[] {
  const pad = " ".repeat(indent);
  return items.length > 0
    ? items.map((item) => `${pad}- ${item}`)
    : [`${pad}- None`];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function generatedHeader(title: string, generatedAt?: string): string[] {
  return [
    `# ${title}`,
    "",
    "> Generated by Annotation Tutor Lite. Rebuildable; do not maintain manually.",
    ...(generatedAt ? [`> Updated: ${generatedAt}`] : []),
    ""
  ];
}

function stripMd(path: string): string {
  return path.replace(/\.md$/i, "");
}
