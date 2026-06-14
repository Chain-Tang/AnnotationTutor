// Direct review engine: call an OpenAI-compatible Chat Completions endpoint over
// HTTPS to produce a review in ONE request. Unlike the OpenCode CLI bridge this
// spawns no subprocess, so it is immune to the Windows stdin / agent-loop issues
// that make a child-process CLI unreliable inside Electron on Windows (the
// prompt never reaches a Node-spawned `opencode` over a pipe, and passing it as
// an argument runs the `build` agent which exits the loop with no text).
//
// The HTTP call is INJECTED (HttpRequestJson) so this module has no Obsidian
// import and stays unit-testable; main.ts passes an adapter around Obsidian's
// `requestUrl` (which bypasses CORS). All request/response shaping is pure.

export type ApiReviewOptions = {
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1. */
  baseUrl: string;
  apiKey: string;
  /** Model id, e.g. deepseek-chat. */
  model: string;
  /** The full review instruction (a single user message). */
  prompt: string;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
};

export type ApiReviewResult = {
  /** True on a 2xx response (whether or not it contained text). */
  ok: boolean;
  /** Assistant text, extracted from choices[0].message.content. */
  reviewText: string;
  status?: number;
  timedOut?: boolean;
  /** Set on a network error, timeout, missing key, or non-2xx status. */
  error?: string;
};

export type ApiModelsResult = {
  ok: boolean;
  models: string[];
  status?: number;
  error?: string;
};

export type HttpJsonResponse = { status: number; text: string };

/** Injected HTTP transport (so this module needs no Obsidian/network import). */
export type HttpRequestJson = (request: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<HttpJsonResponse>;

/** Build the chat-completions URL from an OpenAI-compatible base URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
}

/** Build the models-list URL (used for the connectivity check). */
export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/models`;
}

/** Build the request body for a single-shot, non-streaming review. */
export function buildChatBody(model: string, prompt: string): string {
  return JSON.stringify({
    model: model.trim(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    stream: false
  });
}

/** One turn in a chat conversation, in OpenAI message shape. */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Build the body for a multi-turn chat. The Direct API endpoint keeps no
 * server-side memory, so the caller resends the running history each turn.
 */
export function buildChatMessagesBody(model: string, messages: ChatMessage[]): string {
  return JSON.stringify({
    model: model.trim(),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: 0.3,
    stream: false
  });
}

/**
 * Pull the assistant text out of an OpenAI-compatible response body.
 * Returns "" when the shape is unexpected, so callers report "no review"
 * rather than writing garbage.
 */
export function extractApiReviewText(responseText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return "";
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  return typeof content === "string" ? content.trim() : "";
}

/** Pull a human-readable error message out of an error response body. */
export function extractApiError(responseText: string): string {
  try {
    const parsed = JSON.parse(responseText) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const err = parsed.error;
    if (typeof err === "string" && err) return err;
    if (err && typeof err === "object" && typeof err.message === "string") {
      return err.message;
    }
    if (typeof parsed.message === "string" && parsed.message) {
      return parsed.message;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  const trimmed = responseText.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
}

/** Extract the `id`s from an OpenAI-compatible `GET /models` response. */
export function extractApiModels(responseText: string): string[] {
  try {
    const parsed = JSON.parse(responseText) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(parsed.data)) return [];
    return parsed.data
      .map((item) => (typeof item.id === "string" ? item.id : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Run one review via an OpenAI-compatible endpoint. */
export async function runApiReview(
  opts: ApiReviewOptions,
  request: HttpRequestJson
): Promise<ApiReviewResult> {
  if (!opts.apiKey.trim()) {
    return { ok: false, reviewText: "", error: "missing-api-key" };
  }
  let response: HttpJsonResponse;
  try {
    response = await request({
      url: chatCompletionsUrl(opts.baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${opts.apiKey.trim()}`
      },
      body: buildChatBody(opts.model, opts.prompt),
      timeoutMs: opts.timeoutMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reviewText: "",
      timedOut: /tim(?:e|ed)?\s?-?\s?out/i.test(message),
      error: message
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      reviewText: "",
      status: response.status,
      error: extractApiError(response.text)
    };
  }
  return {
    ok: true,
    reviewText: extractApiReviewText(response.text),
    status: response.status
  };
}

export type ApiChatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The running conversation, including any leading system message. */
  messages: ChatMessage[];
  timeoutMs: number;
};

/**
 * Run one multi-turn chat completion. Reuses the review extractor/parsers; the
 * `reviewText` field carries the assistant's reply.
 */
export async function runApiChat(
  opts: ApiChatOptions,
  request: HttpRequestJson
): Promise<ApiReviewResult> {
  if (!opts.apiKey.trim()) {
    return { ok: false, reviewText: "", error: "missing-api-key" };
  }
  let response: HttpJsonResponse;
  try {
    response = await request({
      url: chatCompletionsUrl(opts.baseUrl),
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${opts.apiKey.trim()}`
      },
      body: buildChatMessagesBody(opts.model, opts.messages),
      timeoutMs: opts.timeoutMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reviewText: "",
      timedOut: /tim(?:e|ed)?\s?-?\s?out/i.test(message),
      error: message
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      reviewText: "",
      status: response.status,
      error: extractApiError(response.text)
    };
  }
  return {
    ok: true,
    reviewText: extractApiReviewText(response.text),
    status: response.status
  };
}

/** Pick a sensible default API model: keep the current if still offered, else
 * prefer a "flash"-class (fast) model, then a "chat" model, then the first. */
export function pickApiModel(models: string[], current: string): string {
  if (current && models.includes(current)) return current;
  return (
    models.find((id) => /flash/i.test(id)) ??
    models.find((id) => /chat/i.test(id)) ??
    models[0] ??
    current
  );
}

/**
 * Connectivity/auth check that doubles as model discovery: list the endpoint's
 * models. No tokens are spent, and a non-2xx (e.g. 401) cleanly reports a bad
 * key or unreachable endpoint.
 */
export async function listApiModels(
  opts: { baseUrl: string; apiKey: string; timeoutMs: number },
  request: HttpRequestJson
): Promise<ApiModelsResult> {
  if (!opts.apiKey.trim()) {
    return { ok: false, models: [], error: "missing-api-key" };
  }
  let response: HttpJsonResponse;
  try {
    response = await request({
      url: modelsUrl(opts.baseUrl),
      method: "GET",
      headers: { Authorization: `Bearer ${opts.apiKey.trim()}` },
      timeoutMs: opts.timeoutMs
    });
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      models: [],
      status: response.status,
      error: extractApiError(response.text)
    };
  }
  return { ok: true, models: extractApiModels(response.text), status: response.status };
}
