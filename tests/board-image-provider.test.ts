import { describe, expect, it, vi } from "vitest";
import { createLoopbackImageProvider, createOpenAIImageProvider, createQwenImageProvider } from "../src/board-image-provider.js";
import { ImageContentRefusal } from "../src/board-image-error.js";

describe("image generation providers", () => {
  it.each(["openai", "qwen"])("classifies %s IP and content refusals without treating transport errors as content", async kind => {
    for (const [code,message,reason] of [
      ["IPInfringementSuspect","Output data is suspected of being involved in IP infringement","ip"],
      ["","Output data is suspected of being involved in IP infringement","ip"],
      ["DataInspectionFailed","Rejected","content"],
      ["content_policy_violation","Rejected","content"],
    ]) {
      const fetch=vi.fn(async()=>new Response(JSON.stringify({error:{code,message}}),{status:400}));
      const options={baseUrl:"https://example.com/v1",apiKey:"test",model:"test",fetch};
      const provider=kind==="openai"?createOpenAIImageProvider(options):createQwenImageProvider(options);
      const pending=provider.generate({requestId:"rejected",prompt:"character",width:1024,height:1024,quality:"standard",transparent:false});
      await expect(pending).rejects.toMatchObject({name:"ImageContentRefusal",reason,retryable:false,providerCode:code});
      expect(fetch).toHaveBeenCalledOnce();
    }
    const options={baseUrl:"https://example.com/v1",apiKey:"test",model:"test",fetch:async()=>new Response(JSON.stringify({error:{message:"busy"}}),{status:503})};
    const provider=kind==="openai"?createOpenAIImageProvider(options):createQwenImageProvider(options);
    await expect(provider.generate({requestId:"busy",prompt:"character",width:1024,height:1024,quality:"standard",transparent:false})).rejects.not.toBeInstanceOf(ImageContentRefusal);
  });
  it.each(["openai", "qwen"])("does not send cancelled %s requests and times out a stalled provider", async kind => {
    vi.useFakeTimers();
    try {
      const fetch=vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_,reject)=>{
        if(init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true});
      }));
      const options={baseUrl:"https://example.com/v1",apiKey:"test",model:"test",fetch,timeoutMs:100};
      const provider=kind==="openai"?createOpenAIImageProvider(options):createQwenImageProvider(options);
      const input={requestId:"timeout-test",prompt:"character",width:1024,height:1024,quality:"standard" as const,transparent:false};
      const cancelled=new AbortController();cancelled.abort();
      await expect(provider.generate(input,cancelled.signal)).rejects.toThrow("cancelled");
      expect(fetch).not.toHaveBeenCalled();
      const pending=expect(provider.generate(input)).rejects.toThrow("image-provider-timeout");
      await vi.advanceTimersByTimeAsync(100);await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
  it("normalizes OpenAI image bytes and provenance", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }, { b64_json: "d29ybGQ=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = createOpenAIImageProvider({ apiKey: "test-key", model: "gpt-image-test", fetch });
    const candidates = await provider.generate({ requestId: "r", prompt: "two candidates", width: 1024, height: 1024, quality: "preview", transparent: true });
    expect(candidates).toHaveLength(2);
    expect(new TextDecoder().decode(candidates[0]!.bytes)).toBe("hello");
    expect(candidates[0]).toMatchObject({ mimeType: "image/png", model: "gpt-image-test", provenance: { provider: "openai-image" } });
    expect(String(calls[0]?.init?.body)).toContain("two candidates");
  });

  it("cancels active loopback jobs by request id", async () => {
    const cancel = vi.fn();
    let release!: () => void;
    const waiting = new Promise<never>((_resolve) => { release = () => {}; });
    const provider = createLoopbackImageProvider({
      async available() { return { available: true }; },
      async submit() { return { id: "job", wait: () => waiting, cancel }; },
    });
    void provider.generate({ requestId: "job-1", prompt: "x", width: 512, height: 512, quality: "preview", transparent: false });
    await Promise.resolve();
    provider.cancel("job-1");
    expect(cancel).toHaveBeenCalledOnce();
    release();
  });

  it("sends exact 1K-tier Qwen parameters and downloads expiring result URLs", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          data: [{ url: "https://result.example.test/generated.png?expires=soon" }],
          usage: { output_width: 1200, output_height: 900, output_image_type: "qima_output_1k" },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-safe" } });
      }
      return new Response(new TextEncoder().encode("png-bytes"), { status: 200, headers: { "content-type": "image/png" } });
    });
    const provider = createQwenImageProvider({
      baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-key",
      model: "qwen-image-3.0",
      fetch,
    });
    const candidates = await provider.generate({
      requestId: "qwen-1", prompt: "anime character", width: 1200, height: 900,
      quality: "preview", transparent: false, count: 3, negativePrompt: "blur",
      seed: 42, promptExtend: true, promptExtendMode: "agent", thinking: true, watermark: false,
    });
    expect(candidates).toHaveLength(1);
    expect(new TextDecoder().decode(candidates[0]!.bytes)).toBe("png-bytes");
    expect(candidates[0]).toMatchObject({
      width: 1200, height: 900, model: "qwen-image-3.0",
      provenance: { provider: "qwen-image-compatible", providerRequestId: "req-safe", outputTier: "qima_output_1k" },
    });
    expect(String(calls[0]!.input)).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations");
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "qwen-image-3.0", size: "1200x900", n: 3, negative_prompt: "blur",
      seed: 42, prompt_extend: true, prompt_extend_mode: "agent", enable_thinking: true, watermark: false,
    });
  });

  it("uses Qwen generations for image editing and downgrades agent prompt extension to direct", async () => {
    let posted: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: [{ url: "https://result.example.test/edit.png" }] }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    });
    const provider = createQwenImageProvider({ baseUrl: "https://example.test/v1", apiKey: "key", fetch });
    await provider.edit({
      requestId: "edit", prompt: "change clothes", width: 1024, height: 1024,
      quality: "standard", transparent: false, promptExtendMode: "agent",
      source: { id: "source", bytes: new Uint8Array([1]), mimeType: "image/png", width: 1, height: 1, model: "user", latencyMs: 0, provenance: { provider: "user", generatedAt: "now" } },
    });
    expect(typeof posted?.image).toBe("string");
    expect(String(posted?.image)).toMatch(/^data:image\/png;base64,/);
    expect(posted?.prompt_extend_mode).toBe("direct");
  });

  it("compacts large Qwen reference PNGs before sending the inline image", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1024, height: 1024, close: vi.fn() })));
    class FakeOffscreenCanvas {
      public constructor(public width: number, public height: number) {}
      public getContext() { return { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }; }
      public async convertToBlob() { return new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }); }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    let posted: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: [{ url: "https://result.example.test/edit.png" }] }), { status: 200 });
      }
      return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } });
    });
    try {
      const provider = createQwenImageProvider({ baseUrl: "https://example.test/v1", apiKey: "key", fetch });
      await provider.edit({
        requestId: "compact", prompt: "edit", width: 1024, height: 1024,
        quality: "standard", transparent: false,
        source: { id: "large", bytes: new Uint8Array(600 * 1024), mimeType: "image/png", width: 1024, height: 1024, model: "user", latencyMs: 0, provenance: { provider: "user", generatedAt: "now" } },
      });
      expect(String(posted?.image)).toBe("data:image/jpeg;base64,AQID");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects Qwen requests outside the 1K tier and compatible-mode masks", async () => {
    const provider = createQwenImageProvider({ baseUrl: "https://example.test/v1", apiKey: "key", fetch: vi.fn() });
    await expect(provider.generate({ requestId: "large", prompt: "x", width: 2048, height: 2048, quality: "high", transparent: false }))
      .rejects.toThrow("image-size-exceeds-1k-tier");
    await expect(provider.generate({
      requestId: "mask", prompt: "x", width: 1024, height: 1024, quality: "standard", transparent: false,
      mask: { bytes: new Uint8Array([1]), mimeType: "image/png", x: 0, y: 0, width: 1, height: 1 },
    })).rejects.toThrow("qwen-compatible-mask-unsupported");
  });
});
