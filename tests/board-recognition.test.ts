import { describe, expect, it, vi } from "vitest";
import { CloudRecognitionProvider } from "../src/board-recognition.js";

describe("selected-ink cloud recognition", () => {
  it("sends one cropped data image and returns structured candidates", async () => {
    const request = vi.fn(async (input: { body?: string }) => ({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        text: "你好 Tutor", alternatives: ["你好，Tutor"], language: "zh-CN", confidence: 0.92,
        segments: [{ text: "你好", strokeIds: ["INK-1"] }],
      }) } }] }),
    }));
    const provider = new CloudRecognitionProvider(() => ({
      baseUrl: "https://example.test/v1", apiKey: "secret", model: "vision", timeoutMs: 1000, request,
    }));
    const result = await provider.recognize({
      strokes: [{ id: "INK-1", createdAt: "2026-09-14T00:00:00.000Z", points: [{ x: 0, y: 0 }] }],
      languages: ["zh-CN", "en"], writingArea: { width: 80, height: 30 }, imageBase64: "AAAA",
    });
    expect(result).toMatchObject({ text: "你好 Tutor", provider: "direct-vision", confidence: 0.92 });
    const body = JSON.parse(request.mock.calls[0]![0].body!);
    expect(body.messages[0].content[1].image_url.url).toBe("data:image/png;base64,AAAA");
    expect(JSON.stringify(body)).not.toContain("whole page");
  });
});
