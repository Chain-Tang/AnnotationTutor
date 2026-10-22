// The wire format shared by the browser extension (Web Clipper) and this plugin.
// Defined once here with a zod schema so both the obsidian:// URI intake and the
// localhost page-archive server validate identical shapes; the extension keeps a
// hand-mirrored copy of these types (extension/src/protocol.ts). Pure module — no
// Obsidian, no Node sockets — so the contract and its guards stay unit-testable.

import { z } from "zod";

/** Current wire-format version. Bump when the shape changes incompatibly. */
export const CAPTURE_PROTOCOL_VERSION = 1;

/** Fixed discovery range shared conceptually with Tutor Advanced Clipper. */
export const WEB_BRIDGE_DISCOVERY_PORTS = Array.from(
  { length: 9 },
  (_, index) => 51256 + index
);

/**
 * A single highlighted range, anchored with a W3C-style TextQuoteSelector
 * (exact text plus short prefix/suffix) so a capture can be relocated on a
 * later visit even after the page's DOM shifts.
 */
export const captureSelectionSchema = z.object({
  exact: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
  note: z.string().optional()
});

export type CaptureSelection = z.infer<typeof captureSelectionSchema>;

/** Everything the extension sends for one capture, selection or full page. */
export const capturePayloadSchema = z.object({
  v: z.literal(CAPTURE_PROTOCOL_VERSION),
  kind: z.enum(["selection", "page"]),
  url: z.string(),
  title: z.string(),
  capturedAt: z.string().datetime({ offset: true }),
  markdown: z.string(),
  selections: z.array(captureSelectionSchema).optional(),
  renderedHtml: z.string().optional(),
  sourceHtml: z.string().optional(),
  requestId:z.string().uuid().optional()
});

export type CapturePayload = z.infer<typeof capturePayloadSchema>;

/**
 * An ask request from the extension: the learner's question about the page they
 * are reading, plus the page body and highlights as context. Separate from
 * {@link capturePayloadSchema} so the ask channel can evolve without touching
 * the capture contract (no version bump for existing capture flows).
 */
export const askPayloadSchema = z.object({
  v: z.literal(CAPTURE_PROTOCOL_VERSION),
  kind: z.literal("ask"),
  url: z.string(),
  title: z.string(),
  question: z.string().min(1),
  /** The page body as converted Markdown — the tutor's reading context. */
  markdown: z.string(),
  selections: z.array(captureSelectionSchema).optional(),
  requestId:z.string().uuid().optional()
});

export type AskPayload = z.infer<typeof askPayloadSchema>;

/** Validate an untrusted ask request; null on any mismatch. */
export function parseAskPayload(raw: unknown): AskPayload | null {
  const result = askPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * The events the /ask endpoint streams back over SSE. `delta` carries each
 * generated chunk as it arrives; `done` closes a successful answer with the
 * full text; `error` carries a machine-readable reason instead of a 500 with
 * the stream already open.
 */
export type AskStreamEvent =
  | {type:"accepted";requestId:string;state:"queued"|"running"}
  | { type: "delta"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; error: string };

/**
 * Validate an untrusted value against the wire schema; null on any mismatch.
 * A `selection` capture must carry at least one selection to be meaningful, so
 * that extra invariant is enforced here rather than in the schema (which the
 * `page` kind shares).
 */
export function parseCapturePayload(raw: unknown): CapturePayload | null {
  const result = capturePayloadSchema.safeParse(raw);
  if (!result.success) return null;
  if (result.data.kind === "selection" && !result.data.selections?.length) {
    return null;
  }
  return result.data;
}

/** Decode a base64url-encoded JSON payload (the obsidian:// URI carrier). */
export function decodeCapturePayload(encoded: string): CapturePayload | null {
  const json = base64UrlToString(encoded);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return parseCapturePayload(parsed);
}

/** base64url → UTF-8 string; null if the input is not valid base64url. */
function base64UrlToString(input: string): string | null {
  try {
    const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
    return Buffer.from(base64 + padding, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Max bytes we let ride the obsidian:// URI channel. The OS dispatches the URI
 * through a shell/registry path capped near 32KB, so anything larger must fall
 * back to the localhost server. base64 inflates ~4/3, so we budget on the
 * encoded length, not the raw JSON.
 */
export const URI_PAYLOAD_BUDGET = 28_000;

/** True when a payload is small enough to send over the obsidian:// URI channel. */
export function payloadFitsUri(payload: CapturePayload): boolean {
  const rawLength = JSON.stringify(payload).length;
  const encodedLength = Math.ceil(rawLength / 3) * 4;
  return encodedLength <= URI_PAYLOAD_BUDGET;
}

/**
 * Response headers for the localhost bridge. Chrome's Private Network Access
 * gate requires echoing the requesting origin and explicitly allowing the
 * private-network access, or the preflight fails before the POST ever arrives.
 */
export function bridgeCorsHeaders(origin: string): Record<string, string> {
  if(!isTrustedBridgeOrigin(origin))return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary":"Origin",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Tutor-Bridge-Client",
    "Access-Control-Allow-Private-Network": "true"
  };
}

/** Browser-extension origins pass a transport check only; they confer no authority. */
export function isTrustedBridgeOrigin(origin: string): boolean {
  return /^(?:chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

/** Deprecated discovery hint. Host approval and a one-use proof are still required. */
export function isBridgePairingRequest(
  origin: string,
  clientHeader: string | undefined
): boolean {
  return isTrustedBridgeOrigin(origin) && clientHeader === "tutor-advanced-clipper-v1";
}

/** Bearer check for the localhost bridge; an empty configured token never authorizes. */
export function isBridgeAuthorized(
  authHeader: string | undefined,
  token: string
): boolean {
  if (!token) return false;
  return authHeader === `Bearer ${token}`;
}
