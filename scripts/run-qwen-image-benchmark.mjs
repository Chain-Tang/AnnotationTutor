import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) throw new Error("Arguments use --name value pairs");
  args.set(key.slice(2), value);
}

const settingsPath = args.get("settings");
if (!settingsPath) throw new Error("Pass --settings /absolute/path/to/plugin/data.json");
const taskId = args.get("task") ?? "anime-01";
const countOverride = args.has("count") ? Number(args.get("count")) : 1;
const root = path.resolve(import.meta.dirname, "..");
const benchmark = JSON.parse(await readFile(path.join(root, "research/ai-drawing/benchmark-v1.json"), "utf8"));
const task = benchmark.tasks.find((item) => item.id === taskId);
if (!task) throw new Error(`Unknown benchmark task: ${taskId}`);
const settings = JSON.parse(await readFile(path.resolve(settingsPath), "utf8"));
const apiKey = settings.boardImageUseSharedApiKey ? settings.apiKey : settings.boardImageApiKey;
if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Configured image API key is missing");
if (settings.boardImageProvider !== "qwen-compatible") throw new Error("The configured image provider is not qwen-compatible");

const width = args.has("width") ? Number(args.get("width")) : Number(settings.boardImageWidth);
const height = args.has("height") ? Number(args.get("height")) : Number(settings.boardImageHeight);
const area = width * height;
if (!Number.isInteger(width) || !Number.isInteger(height) || area < 512 * 512 || area > 2_250_000 || width / height < 1 / 8 || width / height > 8)
  throw new Error("Requested size is outside Tutor's Qwen 1K bounds");
if (!Number.isInteger(countOverride) || countOverride < 1 || countOverride > 6) throw new Error("Count must be 1..6");

const base = new URL(String(settings.boardImageBaseUrl).trim().replace(/\/+$/, ""));
if (base.protocol !== "https:") throw new Error("Qwen endpoint must use HTTPS");
const endpoint = base.pathname.endsWith("/images/generations")
  ? base.toString()
  : `${base.toString().replace(/\/+$/, "")}/images/generations`;
const startedAt = new Date().toISOString();
const started = performance.now();
const runName = `${startedAt.replace(/[:.]/g, "-")}-${taskId}-${width}x${height}`;
const outputDir = path.resolve(args.get("out") ?? path.join(root, "research/ai-drawing/runs", runName));
await mkdir(outputDir, { recursive: true });
const promptExtend = args.has("prompt-extend") ? args.get("prompt-extend") === "true" : settings.boardImagePromptExtend !== false;
const promptExtendMode = args.get("prompt-mode") === "agent" ? "agent" : settings.boardImagePromptExtendMode === "agent" ? "agent" : "direct";
const thinking = args.has("thinking") ? args.get("thinking") === "true" : settings.boardImageThinking !== false;
const watermark = args.has("watermark") ? args.get("watermark") === "true" : settings.boardImageWatermark === true;

const record = {
  format: "tutor-ai-drawing-experiment-v1",
  taskId,
  provider: "aliyun-qwen-image-compatible",
  model: String(settings.boardImageModel || "qwen-image-3.0"),
  promptVersion: "benchmark-v1-raw",
  startedAt,
  latencyMs: 0,
  status: "failed",
  requestedWidth: width,
  requestedHeight: height,
  requestedCount: countOverride,
  promptExtend,
  promptExtendMode,
  thinking,
  watermark,
  referenceInputs: [],
  outputs: [],
  scores: {},
  authorizedForTraining: false,
};

try {
  const seedText = args.get("seed") ?? settings.boardImageSeed;
  const seed = typeof seedText === "string" && seedText.trim() ? Number(seedText) : undefined;
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647)) throw new Error("Seed is outside 0..2147483647");
  if (seed !== undefined) record.seed = seed;
  const referencePath = args.get("reference");
  let referenceImage;
  if (referencePath) {
    const resolved = path.resolve(referencePath);
    const bytes = await readFile(resolved);
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Reference image exceeds 10 MB");
    const extension = path.extname(resolved).toLowerCase();
    const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
    referenceImage = `data:${mime};base64,${bytes.toString("base64")}`;
    record.referenceInputs.push(path.basename(resolved));
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: record.model,
      prompt: task.prompt,
      size: `${width}x${height}`,
      n: countOverride,
      ...(referenceImage ? { image: referenceImage } : {}),
      ...(String(settings.boardImageNegativePrompt ?? "").trim() ? { negative_prompt: String(settings.boardImageNegativePrompt).trim() } : {}),
      ...(seed !== undefined ? { seed } : {}),
      prompt_extend: promptExtend,
      prompt_extend_mode: referenceImage ? "direct" : promptExtendMode,
      enable_thinking: promptExtend && thinking,
      watermark,
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const code = String(payload.error?.code ?? `http-${response.status}`);
    throw Object.assign(new Error(String(payload.error?.message ?? code)), { safeCode: code });
  }
  const urls = (payload.data ?? []).map((item) => item.url).filter(Boolean);
  if (!urls.length) throw Object.assign(new Error("Provider returned no image URL"), { safeCode: "empty-result" });
  for (let index = 0; index < urls.length; index++) {
    const url = new URL(urls[index]);
    if (url.protocol !== "https:") throw Object.assign(new Error("Result URL is not HTTPS"), { safeCode: "unsafe-result-url" });
    const imageResponse = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!imageResponse.ok) throw Object.assign(new Error("Could not download generated image"), { safeCode: `download-${imageResponse.status}` });
    const mime = imageResponse.headers.get("content-type")?.split(";")[0]?.toLowerCase();
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const filename = `candidate-${index + 1}.${extension}`;
    await writeFile(path.join(outputDir, filename), new Uint8Array(await imageResponse.arrayBuffer()));
    record.outputs.push(filename);
  }
  record.latencyMs = Math.round(performance.now() - started);
  record.status = "generated";
  record.providerRequestId = response.headers.get("x-request-id") ?? undefined;
  record.outputWidth = Number(payload.usage?.output_width ?? width);
  record.outputHeight = Number(payload.usage?.output_height ?? height);
  record.outputTier = String(payload.usage?.output_image_type ?? "unknown");
  await writeFile(path.join(outputDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, taskId, outputDir, outputs: record.outputs, latencyMs: record.latencyMs, outputSize: [record.outputWidth, record.outputHeight], outputTier: record.outputTier, providerRequestId: record.providerRequestId ?? null })}\n`);
} catch (error) {
  record.latencyMs = Math.round(performance.now() - started);
  const cause = typeof error === "object" && error && "cause" in error && typeof error.cause === "object" && error.cause
    ? error.cause
    : undefined;
  record.failureCode = typeof error === "object" && error && "safeCode" in error
    ? String(error.safeCode)
    : cause && "code" in cause
      ? String(cause.code)
      : "request-failed";
  const message = error instanceof Error ? error.message : "Unknown error";
  const causeMessage = cause && "message" in cause ? String(cause.message) : "";
  record.reviewerNotes = `${message}${causeMessage ? ` (${causeMessage})` : ""}`.slice(0, 500);
  await writeFile(path.join(outputDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stderr.write(`${JSON.stringify({ ok: false, taskId, outputDir, failureCode: record.failureCode, message: record.reviewerNotes })}\n`);
  process.exitCode = 1;
}
