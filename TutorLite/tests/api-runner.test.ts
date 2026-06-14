import { describe, expect, it } from "vitest";
import {
  buildChatBody,
  buildChatMessagesBody,
  chatCompletionsUrl,
  extractApiError,
  extractApiModels,
  extractApiReviewText,
  listApiModels,
  modelsUrl,
  pickApiModel,
  runApiChat,
  runApiReview,
  type ChatMessage,
  type HttpRequestJson
} from "../src/api-runner.js";

describe("url builders", () => {
  it("appends the endpoint, trimming trailing slashes", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
    expect(chatCompletionsUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
    expect(modelsUrl("  https://openrouter.ai/api/v1//  ")).toBe(
      "https://openrouter.ai/api/v1/models"
    );
  });
});

describe("buildChatBody", () => {
  it("sends a single non-streaming user message", () => {
    const body = JSON.parse(buildChatBody(" deepseek-chat ", "hello"));
    expect(body).toEqual({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      stream: false
    });
  });
});

describe("buildChatMessagesBody", () => {
  it("sends the full history with a slightly higher temperature", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be a tutor" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what is projection?" }
    ];
    const body = JSON.parse(buildChatMessagesBody(" deepseek-chat ", messages));
    expect(body).toEqual({
      model: "deepseek-chat",
      messages,
      temperature: 0.3,
      stream: false
    });
  });
});

describe("runApiChat", () => {
  const chatOpts = {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }] as ChatMessage[],
    timeoutMs: 1000
  };

  it("posts the message history and returns the reply", async () => {
    let sentBody = "";
    const post: HttpRequestJson = async (req) => {
      sentBody = req.body ?? "";
      return {
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: "  hello there  " } }] })
      };
    };
    const result = await runApiChat(chatOpts, post);
    expect(JSON.parse(sentBody).messages).toEqual([{ role: "user", content: "hi" }]);
    expect(result.ok).toBe(true);
    expect(result.reviewText).toBe("hello there");
  });

  it("reports needs-key when the key is blank", async () => {
    const post: HttpRequestJson = async () => {
      throw new Error("should not be called");
    };
    const result = await runApiChat({ ...chatOpts, apiKey: " " }, post);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing-api-key");
  });
});

describe("extractApiReviewText", () => {
  it("pulls choices[0].message.content and trims it", () => {
    const json = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "  Source: api\n  " } }]
    });
    expect(extractApiReviewText(json)).toBe("Source: api");
  });

  it("returns empty string on unexpected shapes or invalid JSON", () => {
    expect(extractApiReviewText("not json")).toBe("");
    expect(extractApiReviewText(JSON.stringify({ choices: [] }))).toBe("");
    expect(extractApiReviewText(JSON.stringify({ choices: [{}] }))).toBe("");
    expect(
      extractApiReviewText(JSON.stringify({ choices: [{ message: {} }] }))
    ).toBe("");
  });
});

describe("extractApiError", () => {
  it("reads the OpenAI-style error.message", () => {
    expect(
      extractApiError(
        JSON.stringify({ error: { message: "Invalid API key", code: "x" } })
      )
    ).toBe("Invalid API key");
  });
  it("falls back to a string error or the raw body", () => {
    expect(extractApiError(JSON.stringify({ error: "nope" }))).toBe("nope");
    expect(extractApiError("Bad Gateway")).toBe("Bad Gateway");
  });
});

describe("extractApiModels", () => {
  it("collects the data[].id values", () => {
    const json = JSON.stringify({
      data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, { foo: 1 }]
    });
    expect(extractApiModels(json)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });
  it("returns [] on invalid JSON or missing data", () => {
    expect(extractApiModels("x")).toEqual([]);
    expect(extractApiModels("{}")).toEqual([]);
  });
});

const opts = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  prompt: "review this",
  timeoutMs: 1000
};

describe("runApiReview", () => {
  it("returns needs-key (error) when the key is blank", async () => {
    const post: HttpRequestJson = async () => {
      throw new Error("should not be called");
    };
    const result = await runApiReview({ ...opts, apiKey: "  " }, post);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing-api-key");
  });

  it("posts to /chat/completions with a Bearer token and returns the text", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const post: HttpRequestJson = async (req) => {
      seenUrl = req.url;
      seenAuth = req.headers.Authorization ?? "";
      expect(req.method).toBe("POST");
      return {
        status: 200,
        text: JSON.stringify({
          choices: [{ message: { content: "Source: api\nCorrectness: correct" } }]
        })
      };
    };
    const result = await runApiReview(opts, post);
    expect(seenUrl).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(seenAuth).toBe("Bearer sk-test");
    expect(result.ok).toBe(true);
    expect(result.reviewText).toContain("Correctness: correct");
  });

  it("reports a non-2xx status as a failure with the API error message", async () => {
    const post: HttpRequestJson = async () => ({
      status: 401,
      text: JSON.stringify({ error: { message: "Authentication Fails" } })
    });
    const result = await runApiReview(opts, post);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("Authentication Fails");
  });

  it("marks a timeout so the caller can show the timeout notice", async () => {
    const post: HttpRequestJson = async () => {
      throw new Error("timed out");
    };
    const result = await runApiReview(opts, post);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("ok but empty text when the model returns nothing", async () => {
    const post: HttpRequestJson = async () => ({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: "" } }] })
    });
    const result = await runApiReview(opts, post);
    expect(result.ok).toBe(true);
    expect(result.reviewText).toBe("");
  });
});

describe("listApiModels", () => {
  it("lists models on success", async () => {
    const get: HttpRequestJson = async (req) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("https://api.deepseek.com/v1/models");
      return { status: 200, text: JSON.stringify({ data: [{ id: "deepseek-chat" }] }) };
    };
    const result = await listApiModels(
      { baseUrl: opts.baseUrl, apiKey: opts.apiKey, timeoutMs: 1000 },
      get
    );
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["deepseek-chat"]);
  });

  it("fails cleanly on a bad key", async () => {
    const get: HttpRequestJson = async () => ({
      status: 401,
      text: JSON.stringify({ error: { message: "bad key" } })
    });
    const result = await listApiModels(
      { baseUrl: opts.baseUrl, apiKey: opts.apiKey, timeoutMs: 1000 },
      get
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bad key");
  });
});

describe("pickApiModel", () => {
  const models = ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"];
  it("keeps the configured model when still offered", () => {
    expect(pickApiModel(models, "deepseek-reasoner")).toBe("deepseek-reasoner");
  });
  it("prefers a flash model, then a chat model, then the first", () => {
    expect(pickApiModel(models, "")).toBe("deepseek-v4-flash");
    expect(pickApiModel(["deepseek-chat", "deepseek-reasoner"], "gone")).toBe(
      "deepseek-chat"
    );
    expect(pickApiModel(["m-a", "m-b"], "")).toBe("m-a");
  });
});
