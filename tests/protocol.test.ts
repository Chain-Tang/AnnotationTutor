import { describe, expect, it } from "vitest";
import {
  CAPTURE_PROTOCOL_VERSION,
  URI_PAYLOAD_BUDGET,
  bridgeCorsHeaders,
  decodeCapturePayload,
  isBridgeAuthorized,
  isBridgePairingRequest,
  isTrustedBridgeOrigin,
  parseAskPayload,
  parseCapturePayload,
  payloadFitsUri,
  type CapturePayload
} from "../src/web-bridge/protocol.js";

const selection: CapturePayload = {
  v: 1,
  kind: "selection",
  url: "https://example.com/a",
  title: "A",
  capturedAt: "2026-08-13T09:00:00.000Z",
  markdown: "",
  selections: [{ exact: "core idea", prefix: "the ", suffix: " here", note: "mine" }]
};

const page: CapturePayload = {
  v: 1,
  kind: "page",
  url: "https://example.com/b",
  title: "B",
  capturedAt: "2026-08-13T09:00:00.000Z",
  markdown: "# B\n\nbody",
  renderedHtml: "<html>rendered</html>",
  sourceHtml: "<html>source</html>"
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("parseCapturePayload", () => {
  it("accepts a well-formed selection payload", () => {
    expect(parseCapturePayload(selection)).not.toBeNull();
  });

  it("accepts a well-formed page payload", () => {
    expect(parseCapturePayload(page)).not.toBeNull();
  });

  it("rejects a selection payload carrying no selections", () => {
    expect(parseCapturePayload({ ...selection, selections: [] })).toBeNull();
    const noSelections: Record<string, unknown> = { ...selection };
    delete noSelections.selections;
    expect(parseCapturePayload(noSelections)).toBeNull();
  });

  it("rejects a mismatched protocol version", () => {
    expect(parseCapturePayload({ ...page, v: 2 })).toBeNull();
  });

  it("rejects an unknown kind, missing fields, and non-objects", () => {
    expect(parseCapturePayload({ ...page, kind: "video" })).toBeNull();
    expect(parseCapturePayload({ v: 1, kind: "page" })).toBeNull();
    expect(parseCapturePayload(null)).toBeNull();
    expect(parseCapturePayload("nope")).toBeNull();
  });

  it("rejects timestamps that could escape the approved capture directory", () => {
    for (const capturedAt of ["/../../x", "../../evil", "2026-10-09T../../../../", "2026-10-09", "not-a-date"]) {
      expect(parseCapturePayload({ ...page, capturedAt })).toBeNull();
    }
    expect(parseCapturePayload({ ...page, capturedAt: "2026-10-09T12:00:00+08:00" })).not.toBeNull();
  });

  it("exposes the current protocol version", () => {
    expect(CAPTURE_PROTOCOL_VERSION).toBe(1);
  });
});

describe("decodeCapturePayload", () => {
  it("round-trips a base64url-encoded payload", () => {
    const decoded = decodeCapturePayload(encode(selection));
    expect(decoded?.kind).toBe("selection");
    expect(decoded?.selections?.[0]?.exact).toBe("core idea");
  });

  it("returns null for malformed base64 / JSON / schema", () => {
    expect(
      decodeCapturePayload(Buffer.from("{bad json", "utf8").toString("base64url"))
    ).toBeNull();
    expect(decodeCapturePayload(encode({ v: 1 }))).toBeNull();
    expect(decodeCapturePayload("")).toBeNull();
  });
});

describe("payloadFitsUri", () => {
  it("accepts a small selection payload", () => {
    expect(payloadFitsUri(selection)).toBe(true);
  });

  it("rejects a payload that would overflow the URI budget", () => {
    const big: CapturePayload = {
      ...selection,
      selections: [
        { exact: "x".repeat(URI_PAYLOAD_BUDGET), prefix: "", suffix: "" }
      ]
    };
    expect(payloadFitsUri(big)).toBe(false);
  });
});

describe("parseAskPayload", () => {
  const ask = {
    v: 1,
    kind: "ask",
    url: "https://example.com/a",
    title: "A",
    question: "What does the author mean by extraction practice?",
    markdown: "# A\n\nbody",
    selections: [{ exact: "core idea", prefix: "the ", suffix: " here", note: "mine" }]
  };

  it("accepts a well-formed ask with page highlights", () => {
    const parsed = parseAskPayload(ask);
    expect(parsed?.question).toBe(ask.question);
    expect(parsed?.markdown).toBe("# A\n\nbody");
    expect(parsed?.selections?.[0]?.exact).toBe("core idea");
  });

  it("accepts an ask without selections", () => {
    const bare: Record<string, unknown> = { ...ask };
    delete bare.selections;
    const parsed = parseAskPayload(bare);
    expect(parsed?.selections).toBeUndefined();
  });

  it("rejects an empty question", () => {
    expect(parseAskPayload({ ...ask, question: "" })).toBeNull();
  });

  it("rejects a wrong version, non-ask kinds, and capture payloads", () => {
    expect(parseAskPayload({ ...ask, v: 2 })).toBeNull();
    expect(parseAskPayload({ ...ask, kind: "selection" })).toBeNull();
    expect(parseAskPayload(selection)).toBeNull();
    expect(parseAskPayload(page)).toBeNull();
    expect(parseAskPayload(null)).toBeNull();
  });
});

describe("bridgeCorsHeaders", () => {
  it("echoes the origin and opens the private-network gate", () => {
    const headers = bridgeCorsHeaders("chrome-extension://abc");
    expect(headers["Access-Control-Allow-Origin"]).toBe("chrome-extension://abc");
    expect(headers["Access-Control-Allow-Private-Network"]).toBe("true");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Headers"]).toContain("X-Tutor-Bridge-Client");
  });

  it("does not allow missing or ordinary web origins", () => {
    expect(bridgeCorsHeaders("")).toEqual({});
    expect(bridgeCorsHeaders("https://example.com")).toEqual({});
  });
});

describe("legacy pairing hint (not authentication)", () => {
  it("accepts Tutor's marker only from browser-extension origins", () => {
    expect(isTrustedBridgeOrigin("chrome-extension://abcdefghijklmnop")).toBe(true);
    expect(isTrustedBridgeOrigin("moz-extension://8ca2d2ea-2b54-4ab2")).toBe(true);
    expect(isBridgePairingRequest(
      "chrome-extension://abcdefghijklmnop",
      "tutor-advanced-clipper-v1"
    )).toBe(true);
  });

  it("rejects ordinary web pages, missing markers, and lookalike schemes", () => {
    expect(isTrustedBridgeOrigin("https://example.com")).toBe(false);
    expect(isTrustedBridgeOrigin("chrome-extension.example://abc")).toBe(false);
    expect(isBridgePairingRequest(
      "https://example.com",
      "tutor-advanced-clipper-v1"
    )).toBe(false);
    expect(isBridgePairingRequest(
      "chrome-extension://abcdefghijklmnop",
      undefined
    )).toBe(false);
  });
});

describe("isBridgeAuthorized", () => {
  it("accepts a matching Bearer token", () => {
    expect(isBridgeAuthorized("Bearer secret", "secret")).toBe(true);
  });

  it("rejects a wrong or missing token", () => {
    expect(isBridgeAuthorized("Bearer nope", "secret")).toBe(false);
    expect(isBridgeAuthorized(undefined, "secret")).toBe(false);
  });

  it("never authorizes when no token is configured", () => {
    expect(isBridgeAuthorized("Bearer ", "")).toBe(false);
    expect(isBridgeAuthorized(undefined, "")).toBe(false);
  });
});
