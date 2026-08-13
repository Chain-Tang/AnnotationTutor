import { describe, expect, it } from "vitest";
import type { AcpStreamEvent } from "../src/acp-session.js";
import {
  createFrameBatcher,
  foldStreamSegments
} from "../src/chat-stream.js";

describe("foldStreamSegments", () => {
  it("merges consecutive thought chunks into one segment", () => {
    const events: AcpStreamEvent[] = [
      { type: "thought", text: "Reading " },
      { type: "thought", text: "the note…" }
    ];
    expect(foldStreamSegments(events)).toEqual([
      { kind: "thought", text: "Reading the note…" }
    ]);
  });

  it("folds tool status updates into the matching tool card", () => {
    const events: AcpStreamEvent[] = [
      { type: "tool", title: "write", status: "pending" },
      { type: "tool", title: "write", status: "completed" }
    ];
    expect(foldStreamSegments(events)).toEqual([
      { kind: "tool", title: "write", status: "completed" }
    ]);
  });

  it("does not overwrite a finished status with a later empty one", () => {
    const events: AcpStreamEvent[] = [
      { type: "tool", title: "write", status: "completed" },
      { type: "tool", title: "write" }
    ];
    expect(foldStreamSegments(events)).toEqual([
      { kind: "tool", title: "write", status: "completed" }
    ]);
  });

  it("keeps distinct tools and interleaved thoughts separate", () => {
    const events: AcpStreamEvent[] = [
      { type: "thought", text: "plan" },
      { type: "tool", title: "read", status: "completed" },
      { type: "tool", title: "write", status: "pending" },
      { type: "thought", text: "done" }
    ];
    const segments = foldStreamSegments(events);
    expect(segments).toHaveLength(4);
    expect(segments[0]).toEqual({ kind: "thought", text: "plan" });
    expect(segments[3]).toEqual({ kind: "thought", text: "done" });
  });

  it("ignores message, mode, and command events", () => {
    const events: AcpStreamEvent[] = [
      { type: "message", text: "reply" },
      { type: "mode", mode: "build" },
      { type: "commands", commands: [{ name: "fix" }] }
    ];
    expect(foldStreamSegments(events)).toEqual([]);
  });
});

describe("createFrameBatcher", () => {
  it("coalesces multiple dirty calls into a single flush per frame", () => {
    let flushes = 0;
    const queue: Array<() => void> = [];
    const batcher = createFrameBatcher(
      () => {
        flushes += 1;
      },
      (callback) => {
        queue.push(callback);
        return queue.length;
      }
    );
    batcher.dirty();
    batcher.dirty();
    batcher.dirty();
    expect(flushes).toBe(0);
    expect(queue).toHaveLength(1);
    queue[0]!();
    expect(flushes).toBe(1);
    // A new dirty after the flush schedules exactly one more frame.
    batcher.dirty();
    expect(queue).toHaveLength(2);
    queue[1]!();
    expect(flushes).toBe(2);
  });
});
