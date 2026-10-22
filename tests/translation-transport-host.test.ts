import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { ReviewOutcome } from "../src/review-outcome.js";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const from = source.indexOf("  private async captureText("), to = source.indexOf("\n  // --- open / edit / delete", from);
if (from < 0 || to < 0) throw new Error("Translation transport host boundaries changed");
const code = transformSync(`class Host { ${source.slice(from, to)} }; module.exports = Host;`, { loader: "ts", format: "cjs" }).code;
type Host = { captureText(prompt: string, timeout: number, signal?: AbortSignal): Promise<ReviewOutcome> };
function fixture() {
  const stream = vi.fn(async (_options: unknown, _transport: unknown) => ({ ok: true, text: "translated", error: undefined as string | undefined }));
  const transport = vi.fn(), module = { exports: {} };
  new Function("module", "streamChatCompletion", "nodeHttpStream", code)(module, stream, transport);
  const Host = module.exports as new () => Host, host = new Host();
  const settings = { reviewEngine: "api", apiBaseUrl: "https://example.invalid", apiKey: "key", apiModel: "model" };
  const api = vi.fn(async () => ({ kind: "ok", reviewText: "legacy" })), acp = vi.fn(async () => ({ kind: "ok", reviewText: "ACP" }));
  Object.assign(host, { settings, captureApiReview: api, captureOpenCodeReview: acp });
  return { host, stream, transport, settings, api, acp };
}

describe("production translation transport cancellation", () => {
  it("forwards the caller's signal to the cancellable direct API route", async () => {
    const f = fixture(), controller = new AbortController();
    await expect(f.host.captureText("prompt", 1234, controller.signal)).resolves.toEqual({ kind: "ok", reviewText: "translated" });
    expect(f.stream).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, timeoutMs: 1234, model: "model" }), f.transport);
    expect(f.api).not.toHaveBeenCalled();
  });

  it("uses the existing direct API path without a signal, and forwards signals to ACP", async () => {
    const f = fixture(), controller = new AbortController();
    await expect(f.host.captureText("prompt", 1234)).resolves.toMatchObject({ reviewText: "legacy" });
    expect(f.api).toHaveBeenCalledWith("prompt", 1234);
    f.settings.reviewEngine = "opencode";
    await expect(f.host.captureText("prompt", 1234, controller.signal)).resolves.toMatchObject({ reviewText: "ACP" });
    expect(f.acp).toHaveBeenCalledWith("prompt", 1234, controller.signal); expect(f.stream).not.toHaveBeenCalled();
  });

  it("rejects pre-cancelled or late-cancelled requests before exposing an outcome", async () => {
    const f = fixture(), before = new AbortController(); before.abort();
    await expect(f.host.captureText("prompt", 1234, before.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.stream).not.toHaveBeenCalled();
    let finish!: (result: { ok: boolean; text: string; error: undefined }) => void;
    f.stream.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const during = new AbortController(), pending = f.host.captureText("prompt", 1234, during.signal);
    during.abort(); finish({ ok: true, text: "late", error: undefined });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("preserves missing-key, empty and timeout outcomes on the cancellable API route", async () => {
    const f = fixture(), signal = new AbortController().signal;
    f.settings.apiKey = "";
    await expect(f.host.captureText("prompt", 1234, signal)).resolves.toEqual({ kind: "needs-key" });
    expect(f.stream).not.toHaveBeenCalled();
    f.settings.apiKey = "key";
    f.stream.mockResolvedValueOnce({ ok: true, text: " ", error: undefined });
    await expect(f.host.captureText("prompt", 1234, signal)).resolves.toEqual({ kind: "empty" });
    f.stream.mockResolvedValueOnce({ ok: false, text: "", error: "api-request-timeout" });
    await expect(f.host.captureText("prompt", 1234, signal)).resolves.toEqual({ kind: "timeout" });
  });
});
