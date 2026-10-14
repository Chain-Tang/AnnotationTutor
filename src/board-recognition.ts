import {
  chatCompletionsUrl,
  extractApiError,
  extractApiReviewText,
  type HttpRequestJson,
} from "./api-runner.js";
import type {
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult,
} from "./board-types.js";

export type CloudRecognitionOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  request: HttpRequestJson;
};

function jsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("recognition-invalid-response");
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

/** OpenAI-compatible vision provider. It never receives a document or full-board image. */
export class CloudRecognitionProvider implements RecognitionProvider {
  public readonly id = "direct-vision";
  public constructor(private readonly options: () => CloudRecognitionOptions) {}

  public async availability(): Promise<{ available: boolean; reason?: string }> {
    const options = this.options();
    if (!options.apiKey.trim()) return { available: false, reason: "missing-api-key" };
    if (!options.model.trim()) return { available: false, reason: "missing-model" };
    return { available: true };
  }

  public async recognize(
    request: RecognitionRequest,
    signal?: AbortSignal,
  ): Promise<RecognitionResult> {
    const options = this.options();
    const available = await this.availability();
    if (!available.available) throw new Error(available.reason ?? "recognition-unavailable");
    if (!request.imageBase64) throw new Error("recognition-image-required");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const language = request.languages.join(", ") || "zh-CN, en";
    const prompt = [
      `Recognize only the handwriting in this cropped ink selection. Language hints: ${language}.`,
      "Return strict JSON: {text, alternatives, language, confidence, segments}.",
      "segments is an array of {text, strokeIds}; use only the supplied stroke IDs.",
      `Stroke IDs: ${request.strokes.map((stroke) => stroke.id).join(", ")}`,
      request.textContext ? `Nearby lesson context (hint only): ${request.textContext.slice(0, 1200)}` : "",
      "Do not answer, explain, or solve the handwritten content.",
    ].filter(Boolean).join("\n");
    const body = JSON.stringify({
      model: options.model.trim(),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${request.imageBase64}`, detail: "high" } },
        ],
      }],
      temperature: 0,
      stream: false,
    });
    const response = await options.request({
      url: chatCompletionsUrl(options.baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${options.apiKey.trim()}`,
      },
      body,
      timeoutMs: options.timeoutMs,
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (response.status < 200 || response.status >= 300)
      throw new Error(extractApiError(response.text) || `HTTP ${response.status}`);
    const parsed = jsonObject(extractApiReviewText(response.text));
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) throw new Error("recognition-empty-response");
    const alternatives = Array.isArray(parsed.alternatives)
      ? parsed.alternatives.filter((value): value is string => typeof value === "string").slice(0, 20)
      : [];
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
    const strokeIds = new Set(request.strokes.map((stroke) => stroke.id));
    const segments = Array.isArray(parsed.segments)
      ? parsed.segments.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const segment = value as { text?: unknown; strokeIds?: unknown };
          if (typeof segment.text !== "string" || !Array.isArray(segment.strokeIds)) return [];
          const ids = segment.strokeIds.filter((id): id is string => typeof id === "string" && strokeIds.has(id));
          return ids.length ? [{ text: segment.text, strokeIds: ids }] : [];
        }).slice(0, 5000)
      : undefined;
    return {
      text,
      alternatives,
      language: typeof parsed.language === "string" ? parsed.language : language,
      provider: this.id,
      model: options.model.trim(),
      confidence,
      segments,
    };
  }
}
