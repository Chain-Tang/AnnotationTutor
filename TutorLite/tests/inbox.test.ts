import { describe, expect, it } from "vitest";
import {
  appendTask,
  cleanInbox,
  latestStatusByAnnotation,
  parseTasks,
  setTaskStatus
} from "../src/markdown/inbox.js";
import type { Task } from "../src/model.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "TASK-20260606-001",
    type: "review_annotation",
    status: "pending",
    annotationId: "ANN-20260606-001",
    memoryFile: "Agent Memory/annotations/ANN-20260606-001.md",
    sourceFile: "Papers/Attention.md",
    anchor: "^ann-20260606-001",
    request: "Please review my understanding.",
    createdAt: "2026-06-06T10:15:00.000Z",
    ...overrides
  };
}

describe("agent inbox", () => {
  it("appends a task under a header", () => {
    const inbox = appendTask("", task());
    expect(inbox).toContain("# Agent Inbox");
    expect(inbox).toContain("annotation-tutor:task:start TASK-20260606-001");
    const tasks = parseTasks(inbox);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.annotationId).toBe("ANN-20260606-001");
    expect(tasks[0]?.status).toBe("pending");
    expect(tasks[0]?.anchor).toBe("^ann-20260606-001");
  });

  it("updates a task status in place", () => {
    const inbox = appendTask("", task());
    const updated = setTaskStatus(inbox, "TASK-20260606-001", "completed");
    expect(parseTasks(updated)[0]?.status).toBe("completed");
  });

  it("reports the latest status per annotation", () => {
    let inbox = appendTask("", task());
    inbox = appendTask(
      inbox,
      task({ id: "TASK-20260606-002", status: "completed" })
    );
    const latest = latestStatusByAnnotation(parseTasks(inbox));
    expect(latest.get("ANN-20260606-001")).toBe("completed");
  });

  it("cleans duplicate, finished, and dangling tasks", () => {
    let inbox = appendTask("", task({ id: "TASK-1", annotationId: "ANN-1" }));
    // Duplicate pending for the same annotation.
    inbox = appendTask(inbox, task({ id: "TASK-2", annotationId: "ANN-1" }));
    // Completed task for another annotation.
    inbox = appendTask(
      inbox,
      task({ id: "TASK-3", annotationId: "ANN-2", status: "completed" })
    );
    // Pending task whose annotation no longer exists (dangling).
    inbox = appendTask(inbox, task({ id: "TASK-4", annotationId: "ANN-GONE" }));
    // Still-open task for a known annotation.
    inbox = appendTask(inbox, task({ id: "TASK-5", annotationId: "ANN-2" }));

    const { markdown, removed } = cleanInbox(inbox, ["ANN-1", "ANN-2"]);
    const kept = parseTasks(markdown);
    expect(kept.map((t) => t.id)).toEqual(["TASK-1", "TASK-5"]);
    expect(removed).toBe(3);
  });

  it("returns just the header when nothing remains", () => {
    const inbox = appendTask("", task({ annotationId: "ANN-GONE" }));
    const { markdown, removed } = cleanInbox(inbox, []);
    expect(parseTasks(markdown)).toHaveLength(0);
    expect(markdown).toContain("# Agent Inbox");
    expect(removed).toBe(1);
  });
});
