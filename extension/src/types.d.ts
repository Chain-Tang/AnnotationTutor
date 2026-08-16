// Ambient types for turndown-plugin-gfm, which ships no declarations. Each helper
// takes the TurndownService instance and registers rules on it; gfm bundles the
// table/strikethrough/task-list rules we use for full-page archival.

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
  export function highlightedCodeBlock(service: TurndownService): void;
}
