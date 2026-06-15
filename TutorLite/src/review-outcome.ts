// Normalized result of one engine call (review / translation / feedback),
// shared by the plugin and its controllers.
export type ReviewOutcome =
  | { kind: "ok"; reviewText: string }
  | { kind: "empty" }
  | { kind: "timeout" }
  | { kind: "failed"; detail: string }
  | { kind: "needs-key" };
