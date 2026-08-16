// Typed envelopes for chrome.runtime / chrome.tabs messaging between the four
// execution contexts (content script, popup, service worker, offscreen doc).
// One discriminated union keeps every listener exhaustive and the payloads honest.

import type { CaptureSelection, CapturePayload } from "./protocol.js";

/** Extension configuration persisted in chrome.storage.local. */
export interface BridgeConfig {
  token: string;
  port: number;
}

export const DEFAULT_CONFIG: BridgeConfig = { token: "", port: 51256 };

/** content → background: a highlighted range the learner chose to annotate. */
export interface SelectionMessage {
  type: "selection";
  selection: CaptureSelection;
  url: string;
  title: string;
}

/** content → background: the full rendered DOM of the active tab. */
export interface PageMessage {
  type: "page";
  html: string;
  url: string;
  title: string;
}

/** popup → content: ask the active tab to grab its rendered DOM. */
export interface GrabPageMessage {
  type: "grab-page";
}

/** background → content: open a built obsidian:// deep link (keeps a user gesture). */
export interface OpenUriMessage {
  type: "open-uri";
  uri: string;
}

/** popup → content: scroll to a saved highlight and flash it. */
export interface FocusHighlightMessage {
  type: "focus-highlight";
  id: string;
}

/** background → offscreen: convert rendered HTML into Readability+Turndown Markdown. */
export interface ConvertMessage {
  type: "convert";
  html: string;
  baseUrl: string;
}

/** offscreen → background: the converted Markdown (or an error string). */
export interface ConvertResult {
  markdown: string;
  error?: string;
}

/** popup → background: probe the plugin's localhost bridge with the saved token. */
export interface TestPairingMessage {
  type: "test-pairing";
}

export type RuntimeMessage =
  | SelectionMessage
  | PageMessage
  | OpenUriMessage
  | TestPairingMessage;

export type TabMessage = GrabPageMessage | OpenUriMessage | FocusHighlightMessage;

export type { CapturePayload };
