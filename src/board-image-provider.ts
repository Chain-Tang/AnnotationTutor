import type {
  ImageGenerationCandidate,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "./board-types.js";
import { imageProviderError } from "./board-image-error.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function bytesFromBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return globalThis.btoa(binary);
}

function imageDataUrl(image: { bytes: Uint8Array; mimeType: string }): string {
  if (!/^image\/(?:png|jpeg|webp|bmp|tiff|gif)$/i.test(image.mimeType))
    throw new Error("unsupported-reference-image-type");
  if (image.bytes.byteLength > 10 * 1024 * 1024) throw new Error("reference-image-too-large");
  return `data:${image.mimeType};base64,${base64FromBytes(image.bytes)}`;
}

/**
 * Qwen's synchronous compatible route proved less reliable with large inline
 * PNG references. Re-encode only the transmitted copy; the user's source image
 * and accepted candidate bytes remain untouched.
 */
async function compactQwenReference(image: { bytes: Uint8Array; mimeType: string }): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (image.bytes.byteLength <= 512 * 1024) return image;
  if (typeof globalThis.createImageBitmap !== "function" || typeof globalThis.OffscreenCanvas !== "function") return image;
  try {
    const source = new Blob([ownedBuffer(image.bytes)], { type: image.mimeType });
    const bitmap = await globalThis.createImageBitmap(source);
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return image;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
    const compact = new Uint8Array(await blob.arrayBuffer());
    return compact.byteLength < image.bytes.byteLength
      ? { bytes: compact, mimeType: "image/jpeg" }
      : image;
  } catch {
    return image;
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function safeBaseUrl(value: string): string {
  const url = new URL(value.trim().replace(/\/$/, ""));
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("Image provider must use HTTPS or a loopback HTTP address");
  return url.toString().replace(/\/$/, "");
}

export type OpenAIImageProviderOptions = {
  baseUrl?: string;
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  /** Includes image download; defaults to three minutes. */
  timeoutMs?: number;
};

/** GPT Image adapter kept outside the board schema; generated pixels are research artifacts until accepted. */
export function createOpenAIImageProvider(options: OpenAIImageProviderOptions): ImageGenerationProvider {
  const base = safeBaseUrl(options.baseUrl || "https://api.openai.com/v1");
  const runFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const active = new Map<string, AbortController>();
  const request = async (
    input: ImageGenerationRequest & { source?: ImageGenerationCandidate },
    edit: boolean,
    signal?: AbortSignal,
  ): Promise<ImageGenerationCandidate[]> => {
    if (signal?.aborted) throw new Error("cancelled");
    if (!options.apiKey.trim()) throw new Error("image-provider-api-key-missing");
    const started = performance.now();
    const controller = new AbortController();
    active.set(input.requestId, controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("image-provider-timeout")), options.timeoutMs ?? 180_000);
    try {
      let body: BodyInit, headers: HeadersInit = { Authorization: `Bearer ${options.apiKey.trim()}` };
      const landscape = input.width / input.height > 1.2;
      const portrait = input.height / input.width > 1.2;
      const outputWidth = landscape ? 1536 : 1024;
      const outputHeight = portrait ? 1536 : 1024;
      const outputSize = `${outputWidth}x${outputHeight}`;
      if (edit) {
        if (!input.source) throw new Error("image-edit-source-missing");
        const form = new FormData();
        form.set("model", options.model.trim());
        form.set("prompt", input.prompt);
        form.set("size", outputSize);
        form.set("quality", input.quality === "preview" ? "low" : input.quality === "standard" ? "medium" : "high");
        form.set("output_format", input.transparent ? "png" : "webp");
        form.set("image", new Blob([ownedBuffer(input.source.bytes)], { type: input.source.mimeType }), "source.png");
        if (input.mask) form.set("mask", new Blob([ownedBuffer(input.mask.bytes)], { type: input.mask.mimeType }), "mask.png");
        body = form;
      } else {
        headers = { ...headers, "Content-Type": "application/json" };
        body = JSON.stringify({
          model: options.model.trim(),
          prompt: input.prompt,
          size: outputSize,
          quality: input.quality === "preview" ? "low" : input.quality === "standard" ? "medium" : "high",
          background: input.transparent ? "transparent" : "opaque",
          output_format: input.transparent ? "png" : "webp",
          n: input.quality === "preview" ? 2 : 1,
        });
      }
      const response = await runFetch(`${base}/images/${edit ? "edits" : "generations"}`, {
        method: "POST", headers, body, signal: controller.signal,
      });
      const payload = await response.json() as { data?: Array<{ b64_json?: string; revised_prompt?: string }>; error?: { code?: string; message?: string } };
      if (!response.ok || payload.error) throw imageProviderError(response.status, payload.error);
      const data = payload.data ?? [];
      if (!data.length || data.some((item) => !item.b64_json)) throw new Error("image-provider-empty-result");
      const latencyMs = performance.now() - started;
      return data.map((item, index) => ({
        id: `${input.requestId}-${index + 1}`,
        bytes: bytesFromBase64(item.b64_json!),
        mimeType: input.transparent ? "image/png" : "image/webp",
        width: outputWidth,
        height: outputHeight,
        model: options.model.trim(),
        latencyMs,
        provenance: {
          provider: "openai-image",
          generatedAt: new Date().toISOString(),
          ...(item.revised_prompt ? { revisedFrom: item.revised_prompt } : {}),
        },
      }));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      active.delete(input.requestId);
    }
  };
  return {
    id: "openai-image",
    async capabilities() { return { generation: true, editing: true, mask: true, references: true, transparency: true, partialPreviews: false, seed: false }; },
    async availability() {
      try { safeBaseUrl(base); return options.apiKey.trim() && options.model.trim() ? { available: true } : { available: false, reason: "需要 API key 和图像模型" }; }
      catch (error) { return { available: false, reason: String(error) }; }
    },
    generate(input, signal) {
      const reference = input.referenceImages?.[0];
      if (reference && !["image/png", "image/jpeg", "image/webp"].includes(reference.mimeType))
        return Promise.reject(new Error("unsupported-reference-image-type"));
      return reference
        ? request({ ...input, source: { id: `${input.requestId}-reference`, bytes: reference.bytes, mimeType: reference.mimeType as ImageGenerationCandidate["mimeType"], width: input.width, height: input.height, model: "reference", latencyMs: 0, provenance: { provider: "user-reference", generatedAt: new Date().toISOString() } } }, true, signal)
        : request(input, false, signal);
    },
    edit(input, signal) { return request(input, true, signal); },
    cancel(requestId) { active.get(requestId)?.abort("cancelled"); },
  };
}

export type QwenImageProviderOptions = {
  baseUrl: string;
  apiKey: string;
  model?: string;
  /** Tutor intentionally stays in Qwen's 1K billing tier by default. */
  maxPixelArea?: number;
  fetch?: FetchLike;
  /** Includes image download; defaults to three minutes. */
  timeoutMs?: number;
};

type QwenImagePayload = {
  data?: Array<{ url?: string }>;
  usage?: {
    output_width?: number;
    output_height?: number;
    output_image_type?: string;
  };
  error?: { message?: string; code?: string };
};

const QWEN_MIN_PIXEL_AREA = 512 * 512;
const QWEN_1K_MAX_PIXEL_AREA = 2_250_000;

function validateQwenSize(width: number, height: number, maxPixelArea: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new Error("image-size-must-be-positive-integers");
  const area = width * height;
  if (area < QWEN_MIN_PIXEL_AREA) throw new Error("image-size-below-qwen-minimum");
  if (area > maxPixelArea) throw new Error("image-size-exceeds-1k-tier");
  const ratio = width / height;
  if (ratio < 1 / 8 || ratio > 8) throw new Error("image-aspect-ratio-out-of-range");
}

function qwenEndpoint(baseUrl: string): string {
  const base = safeBaseUrl(baseUrl);
  return base.endsWith("/images/generations") ? base : `${base}/images/generations`;
}

/** Alibaba Model Studio Qwen Image 3 adapter for its OpenAI-compatible endpoint. */
export function createQwenImageProvider(options: QwenImageProviderOptions): ImageGenerationProvider {
  const endpoint = qwenEndpoint(options.baseUrl);
  const model = options.model?.trim() || "qwen-image-3.0";
  const maxPixelArea = options.maxPixelArea ?? QWEN_1K_MAX_PIXEL_AREA;
  const runFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const active = new Map<string, AbortController>();

  const request = async (
    input: ImageGenerationRequest & { source?: ImageGenerationCandidate },
    signal?: AbortSignal,
  ): Promise<ImageGenerationCandidate[]> => {
    if (signal?.aborted) throw new Error("cancelled");
    if (!options.apiKey.trim()) throw new Error("image-provider-api-key-missing");
    if (!input.prompt.trim()) throw new Error("image-prompt-missing");
    if (input.mask) throw new Error("qwen-compatible-mask-unsupported");
    validateQwenSize(input.width, input.height, maxPixelArea);
    const count = input.count ?? (input.quality === "preview" ? 2 : 1);
    if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error("image-count-out-of-range");
    if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2_147_483_647))
      throw new Error("image-seed-out-of-range");

    const references = [
      ...(input.source ? [input.source] : []),
      ...(input.referenceImages ?? []),
    ];
    if (references.length > 3) throw new Error("qwen-reference-limit-exceeded");
    const images = await Promise.all(references.map(async image => imageDataUrl(await compactQwenReference(image))));
    const promptExtend = input.promptExtend ?? true;
    const requestedMode = input.promptExtendMode ?? "direct";
    // Qwen's agent prompt extension is T2I-only. Direct mode preserves I2I compatibility.
    const promptExtendMode = images.length && requestedMode === "agent" ? "direct" : requestedMode;
    const body = {
      model,
      prompt: input.prompt.trim(),
      size: `${input.width}x${input.height}`,
      n: count,
      ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
      ...(input.negativePrompt?.trim() ? { negative_prompt: input.negativePrompt.trim() } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      prompt_extend: promptExtend,
      prompt_extend_mode: promptExtendMode,
      enable_thinking: promptExtend && (input.thinking ?? true),
      watermark: input.watermark ?? false,
    };

    const started = performance.now();
    const controller = new AbortController();
    active.set(input.requestId, controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("image-provider-timeout")), options.timeoutMs ?? 180_000);
    try {
      const response = await runFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey.trim()}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json() as QwenImagePayload;
      if (!response.ok || payload.error) {
        throw imageProviderError(response.status, payload.error);
      }
      const urls = (payload.data ?? []).map(item => item.url).filter((url): url is string => Boolean(url));
      if (!urls.length) throw new Error("image-provider-empty-result");
      const providerRequestId = response.headers.get("x-request-id") ?? undefined;
      const downloaded = await Promise.all(urls.map(async (value, index) => {
        const url = new URL(value);
        if (url.protocol !== "https:") throw new Error("image-result-url-must-use-https");
        const imageResponse = await runFetch(url, { signal: controller.signal });
        if (!imageResponse.ok) throw new Error(`image-result-download-${imageResponse.status}`);
        const mime = imageResponse.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        const mimeType = mime === "image/jpeg" || mime === "image/webp" ? mime : "image/png";
        return {
          id: `${input.requestId}-${index + 1}`,
          bytes: new Uint8Array(await imageResponse.arrayBuffer()),
          mimeType,
          width: payload.usage?.output_width ?? input.width,
          height: payload.usage?.output_height ?? input.height,
          model,
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          latencyMs: performance.now() - started,
          provenance: {
            provider: "qwen-image-compatible",
            generatedAt: new Date().toISOString(),
            ...(providerRequestId ? { providerRequestId } : {}),
            ...(payload.usage?.output_image_type ? { outputTier: payload.usage.output_image_type } : {}),
          },
        } satisfies ImageGenerationCandidate;
      }));
      return downloaded;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      active.delete(input.requestId);
    }
  };

  return {
    id: "qwen-image-compatible",
    async capabilities() {
      return { generation: true, editing: true, mask: false, references: true, transparency: false, partialPreviews: false, seed: true };
    },
    async availability() {
      try {
        qwenEndpoint(endpoint);
        return options.apiKey.trim() && model ? { available: true } : { available: false, reason: "需要 Qwen Image API key 和模型" };
      } catch (error) {
        return { available: false, reason: String(error) };
      }
    },
    generate(input, signal) { return request(input, signal); },
    edit(input, signal) { return request(input, signal); },
    cancel(requestId) { active.get(requestId)?.abort("cancelled"); },
  };
}

export type LoopbackImageJob = {
  id: string;
  wait(signal?: AbortSignal, onPreview?: (candidate: ImageGenerationCandidate) => void): Promise<ImageGenerationCandidate[]>;
  cancel(): void;
};

/** Adapter boundary for ComfyUI/Diffusers companions; no workflow or model weights enter the plugin. */
export function createLoopbackImageProvider(options: {
  id?: string;
  available(): Promise<{ available: boolean; reason?: string }>;
  submit(request: ImageGenerationRequest & { source?: ImageGenerationCandidate }): Promise<LoopbackImageJob>;
}): ImageGenerationProvider {
  const jobs = new Map<string, LoopbackImageJob>();
  const run = async (request: ImageGenerationRequest & { source?: ImageGenerationCandidate }, signal?: AbortSignal, onPreview?: (candidate: ImageGenerationCandidate) => void) => {
    const job = await options.submit(request);
    jobs.set(request.requestId, job);
    const abort = () => job.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await job.wait(signal, onPreview); }
    finally { signal?.removeEventListener("abort", abort); jobs.delete(request.requestId); }
  };
  return {
    id: options.id ?? "loopback-image",
    async capabilities() { return { generation: true, editing: true, mask: true, references: true, transparency: true, partialPreviews: true, seed: true }; },
    availability: options.available,
    generate(request, signal, onPreview) { return run(request, signal, onPreview); },
    edit(request, signal, onPreview) { return run(request, signal, onPreview); },
    cancel(requestId) { jobs.get(requestId)?.cancel(); },
  };
}
