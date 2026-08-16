// Hand-mirrored copy of the plugin's wire format (src/web-bridge/protocol.ts).
// The extension is a separate build with no zod dependency, so the contract is
// re-expressed here as plain interfaces plus a light structural guard. Keep this
// file byte-compatible with the plugin schema: any incompatible change must bump
// CAPTURE_PROTOCOL_VERSION on BOTH sides.

/** Current wire-format version. Must match the plugin's constant. */
export const CAPTURE_PROTOCOL_VERSION = 1 as const;

/** A single highlighted range, anchored with a W3C-style TextQuoteSelector. */
export interface CaptureSelection {
  exact: string;
  prefix: string;
  suffix: string;
  note?: string;
}

/** Everything the extension sends for one capture, selection or full page. */
export interface CapturePayload {
  v: 1;
  kind: "selection" | "page";
  url: string;
  title: string;
  capturedAt: string;
  markdown: string;
  selections?: CaptureSelection[];
  renderedHtml?: string;
  sourceHtml?: string;
}

/**
 * Max bytes we let ride the obsidian:// URI channel. Mirrors the plugin's
 * budget: the OS dispatches the URI through a shell/registry path capped near
 * 32KB, and base64 inflates ~4/3, so we budget on the encoded length.
 */
export const URI_PAYLOAD_BUDGET = 28_000;

/** True when a payload is small enough to send over the obsidian:// URI channel. */
export function payloadFitsUri(payload: CapturePayload): boolean {
  const rawLength = JSON.stringify(payload).length;
  const encodedLength = Math.ceil(rawLength / 3) * 4;
  return encodedLength <= URI_PAYLOAD_BUDGET;
}

/** UTF-8 → base64url, the encoding the obsidian:// URI carrier expects. */
export function encodeCapturePayload(payload: CapturePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Assemble the obsidian:// deep link the plugin's protocol handler listens on. */
export function buildCaptureUri(payload: CapturePayload): string {
  return `obsidian://atl-web-capture?payload=${encodeCapturePayload(payload)}`;
}

/** Defensive structural guard, mirroring the plugin's parseCapturePayload invariants. */
export function isCapturePayload(value: unknown): value is CapturePayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (p.v !== CAPTURE_PROTOCOL_VERSION) return false;
  if (p.kind !== "selection" && p.kind !== "page") return false;
  if (typeof p.url !== "string" || typeof p.title !== "string") return false;
  if (typeof p.capturedAt !== "string" || typeof p.markdown !== "string") {
    return false;
  }
  if (p.kind === "selection") {
    return Array.isArray(p.selections) && p.selections.length > 0;
  }
  return true;
}
