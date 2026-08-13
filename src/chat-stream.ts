// Pure streaming helpers for the tutor chat. The view layer feeds raw ACP
// events in; these helpers fold them into renderable segments and coalesce
// high-frequency updates into one DOM write per animation frame (the same
// rAF-batching idea Qoderian's stream-controller uses). No obsidian imports,
// so everything here is unit-testable.

import type { AcpStreamEvent } from "./acp-session.js";

/** One visual block above the streaming reply text: a thought or a tool run. */
export type ChatSegment =
  | { kind: "thought"; text: string }
  | { kind: "tool"; title: string; status: string };

/**
 * Fold an ordered event stream into renderable segments. Consecutive thought
 * chunks merge into one thought block; a tool update for the segment currently
 * on top updates it in place (started → completed), and a new tool title opens
 * a fresh card. Message chunks are ignored here (they form the reply body).
 */
export function foldStreamSegments(events: AcpStreamEvent[]): ChatSegment[] {
  const segments: ChatSegment[] = [];
  for (const event of events) {
    if (event.type === "thought") {
      const last = segments.at(-1);
      if (last && last.kind === "thought") last.text += event.text;
      else segments.push({ kind: "thought", text: event.text });
    } else if (event.type === "tool") {
      const last = segments.at(-1);
      const status = event.status ?? "";
      if (last && last.kind === "tool" && last.title === event.title) {
        if (status) last.status = status;
      } else {
        segments.push({ kind: "tool", title: event.title, status });
      }
    }
  }
  return segments;
}

/** A frame scheduler: returns a handle and fires the callback once later. */
export type FrameScheduler = (callback: () => void) => unknown;

/**
 * Coalesce many `dirty()` marks within one frame into a single `flush()` call,
 * so a burst of stream chunks costs one DOM update. `schedule` is injected so
 * tests can drive frames synchronously; the view passes requestAnimationFrame.
 */
export function createFrameBatcher(
  flush: () => void,
  schedule: FrameScheduler = (callback) => requestAnimationFrame(callback)
): { dirty: () => void } {
  let pending = false;
  return {
    dirty(): void {
      if (pending) return;
      pending = true;
      schedule(() => {
        pending = false;
        flush();
      });
    }
  };
}
