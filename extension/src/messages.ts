// Typed envelopes for chrome.runtime / chrome.tabs messaging between the four
// execution contexts (content script, popup, service worker, offscreen doc).
// One discriminated union keeps every listener exhaustive and the payloads honest.

import type { CaptureSelection, CapturePayload } from "./protocol.js";

/** Extension configuration persisted in chrome.storage.local. */
export interface BridgeConfig {
  v: 2;
  clientId: string;
  vaultId: string;
  token: string;
  port: number;
  capabilities: ("capture" | "ask")[];
  targetDirectory: string;
}

export const DEFAULT_CONFIG = { port: 51256 };

/** Tutor chooses the first free port in this small, deterministic range. */
export const BRIDGE_DISCOVERY_PORTS = Array.from({ length: 9 }, (_, index) => 51256 + index);

/** content → background: one capture of highlighted ranges the learner annotated. */
export interface SelectionMessage {
  type: "selection";
  selections: CaptureSelection[];
  url: string;
  title: string;
}

/** content → background: the full rendered DOM of the active tab. */
export interface PageMessage {
  type: "page";
  html: string;
  url: string;
  title: string;
  /** The learner's on-page highlights, riding along so the archived note can list them. */
  selections?: CaptureSelection[];
}

/** popup → content: ask the active tab to grab its rendered DOM. */
export interface GrabPageMessage {
  type: "grab-page";
}

/** content → background: ask the tutor about this page (page body + highlights as context). */
export interface AskMessage {
  type: "ask";
  /** Client-generated id; echoed on every progress event for this ask so a
   * superseded stream (panel closed and reopened mid-answer) can be ignored. */
  reqId: string;
  question: string;
  /** The rendered DOM; the service worker converts it to Markdown offscreen. */
  html: string;
  url: string;
  title: string;
  /** The learner's on-page highlights, given to the tutor as reading context. */
  selections?: CaptureSelection[];
}

/** background → content: one streamed progress event for a running ask. */
export type AskProgress =
  | { type: "ask-delta"; reqId: string; text: string }
  | { type: "ask-done"; reqId: string; text: string }
  | { type: "ask-error"; reqId: string; error: string };

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

/** popup → content: ship every highlight on this page to Obsidian in one capture. */
export interface SyncHighlightsMessage {
  type: "sync-highlights";
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

/** popup → background: explicitly request approval in the Obsidian host. */
export interface ConnectBridgeMessage {
  type: "connect-bridge";
}

export type RuntimeMessage =
  | SelectionMessage
  | PageMessage
  | OpenUriMessage
  | TestPairingMessage
  | ConnectBridgeMessage
  | AskMessage
  | { type: "cancel-ask"; reqId: string };

export type TabMessage =
  | GrabPageMessage
  | OpenUriMessage
  | FocusHighlightMessage
  | SyncHighlightsMessage
  | AskProgress;

export type { CapturePayload };
