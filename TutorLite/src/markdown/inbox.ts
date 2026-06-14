// Parse / write the agent task queue, `Agent Memory/agent-inbox.md` (spec §11).
//
// The plugin appends a task when the user asks for a review; the agent reads the
// task, writes its review into the annotation file, and flips the task Status to
// `completed`. The plugin watches the inbox and reconciles annotation status.

import { caretId, type Task, type TaskStatus } from "../model.js";
import {
  endSentinel,
  extractBlocks,
  findBlock,
  getSection,
  parseMetadata,
  replaceBlock,
  splitSections,
  startSentinel,
  stripCode
} from "./blocks.js";

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed"
];

export const INBOX_HEADER = "# Agent Inbox";

export function requiredOutput(memoryFile: string): string {
  return [
    `Write the review into the **Agent Review** section of \`${memoryFile}\`. Include:`,
    "",
    "1. Correctness (correct / partially_correct / incorrect / uncertain)",
    "2. Summary",
    "3. Strengths",
    "4. Weaknesses",
    "5. Suggested revision",
    "6. One Socratic question",
    "7. Optional Memory Cell update",
    "",
    "Do not edit the User Note. Then set this task's Status to `completed`."
  ].join("\n");
}

export function serializeTask(task: Task): string {
  const meta = [
    `- Type: ${task.type}`,
    `- Status: ${task.status}`,
    `- Annotation: ${task.annotationId}`,
    `- Memory file: \`${task.memoryFile}\``,
    `- Source file: \`${task.sourceFile}\``,
    `- Anchor: \`${caretId(task.anchor)}\``,
    `- Created at: ${task.createdAt}`
  ].join("\n");

  const parts = [
    `## ${task.id}`,
    meta,
    `### User Request\n\n${task.request.trim()}`,
    `### Required Output\n\n${requiredOutput(task.memoryFile)}`
  ];

  return `${startSentinel("task", task.id)}\n\n${parts.join("\n\n")}\n\n${endSentinel(
    "task",
    task.id
  )}\n`;
}

export function appendTask(markdown: string, task: Task): string {
  const base = markdown.trim() ? markdown.replace(/\s+$/, "") : INBOX_HEADER;
  return `${base}\n\n${serializeTask(task)}`;
}

export function parseTasks(markdown: string): Task[] {
  return extractBlocks(markdown, "task").map((block) => {
    const { lead, sections } = splitSections(block.body);
    const meta = parseMetadata(lead);
    return {
      id: block.id,
      type: "review_annotation",
      status: normalizeStatus(meta.get("status")),
      annotationId: meta.get("annotation") ?? "",
      memoryFile: stripCode(meta.get("memory file") ?? ""),
      sourceFile: stripCode(meta.get("source file") ?? ""),
      anchor: stripCode(meta.get("anchor") ?? ""),
      request: getSection(sections, "User Request").trim(),
      createdAt: meta.get("created at") ?? ""
    } satisfies Task;
  });
}

/** Update one task's Status line in place, preserving the rest of the block. */
export function setTaskStatus(
  markdown: string,
  taskId: string,
  status: TaskStatus
): string {
  const block = findBlock(markdown, "task", taskId);
  if (!block) return markdown;
  const updated = block.raw.replace(
    /^(\s*-\s+Status:\s*).*$/m,
    `$1${status}`
  );
  return replaceBlock(markdown, block, updated);
}

/**
 * Tidy the inbox: drop finished (`completed`/`failed`) tasks, drop tasks whose
 * annotation no longer exists, and keep at most one open task per annotation.
 * Returns the rewritten Markdown plus how many tasks were removed.
 */
export function cleanInbox(
  markdown: string,
  knownAnnotationIds: Iterable<string>
): { markdown: string; removed: number } {
  const known = new Set(knownAnnotationIds);
  const tasks = parseTasks(markdown);
  const seenOpen = new Set<string>();
  const kept: Task[] = [];
  for (const task of tasks) {
    if (!known.has(task.annotationId)) continue;
    if (task.status !== "pending" && task.status !== "in_progress") continue;
    if (seenOpen.has(task.annotationId)) continue;
    seenOpen.add(task.annotationId);
    kept.push(task);
  }
  let out = INBOX_HEADER;
  for (const task of kept) out = appendTask(out, task);
  return { markdown: `${out}\n`, removed: tasks.length - kept.length };
}

/** Latest task status per annotation (later tasks win). */
export function latestStatusByAnnotation(
  tasks: Task[]
): Map<string, TaskStatus> {
  const map = new Map<string, TaskStatus>();
  for (const task of tasks) {
    if (task.annotationId) map.set(task.annotationId, task.status);
  }
  return map;
}

function normalizeStatus(value: string | undefined): TaskStatus {
  const normalized = value?.trim().toLowerCase();
  return TASK_STATUSES.find((status) => status === normalized) ?? "pending";
}
