import { tmpdir } from "node:os";
import { runAcpReview } from "./acp-runner.js";
import type { RecognitionProvider, RecognitionRequest, RecognitionResult } from "./board-types.js";

export class AcpRecognitionProvider implements RecognitionProvider {
  public readonly id = "acp-vision";
  public constructor(private readonly options: () => {
    command: string;
    model: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }) {}
  public async availability(): Promise<{ available: boolean; reason?: string }> {
    const options = this.options();
    return options.command.trim()
      ? { available: true }
      : { available: false, reason: "missing-agent-command" };
  }
  public async recognize(request: RecognitionRequest, signal?: AbortSignal): Promise<RecognitionResult> {
    if (!request.imageBase64) throw new Error("recognition-image-required");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const options = this.options();
    const response = await runAcpReview({
      command: options.command,
      model: options.model,
      cwd: tmpdir(),
      timeoutMs: options.timeoutMs,
      imageBase64: request.imageBase64,
      prompt: [
        "Recognize only the handwriting in the attached cropped ink image.",
        `Language hints: ${request.languages.join(", ")}.`,
        `Stroke IDs: ${request.strokes.map((stroke) => stroke.id).join(", ")}.`,
        request.textContext ? `Nearby text hint: ${request.textContext.slice(0, 1200)}` : "",
        "Return only strict JSON: {text, alternatives, language, confidence, segments}.",
        "Do not answer or solve the content.",
      ].filter(Boolean).join("\n"),
      env: options.env,
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!response.ok) throw new Error(response.error ?? "recognition-failed");
    const text = response.reviewText.replace(/^```(?:json)?\s*|\s*```$/gi, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("recognition-invalid-response");
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("recognition-empty-response");
    const allowed = new Set(request.strokes.map((stroke) => stroke.id));
    const segments = Array.isArray(parsed.segments) ? parsed.segments.flatMap((value) => {
      const segment = value as { text?: unknown; strokeIds?: unknown };
      const ids = Array.isArray(segment?.strokeIds)
        ? segment.strokeIds.filter((id): id is string => typeof id === "string" && allowed.has(id))
        : [];
      return typeof segment?.text === "string" && ids.length ? [{ text: segment.text, strokeIds: ids }] : [];
    }) : undefined;
    return {
      text: parsed.text.trim(),
      alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives.filter((value): value is string => typeof value === "string").slice(0, 20) : [],
      language: typeof parsed.language === "string" ? parsed.language : request.languages.join(", "),
      provider: this.id,
      model: options.model,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : undefined,
      segments,
    };
  }
}
