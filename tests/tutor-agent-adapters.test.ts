import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpTutorAdapter } from "../src/tutor-agent-adapters.js";
import type { AgentAdapter } from "../src/tutor-task.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type Message = { id?: number; method?: string; params?: Record<string, any>; result?: unknown };
const model = "provider/teaching";
const answer = "过程哲学把持续生成的事件看作基本单位。";

function fixture(confirmation: "matching" | "missing" | "different" = "matching") {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  });
  const messages: Message[] = [];
  child.stdin.on("data", chunk => {
    const request = JSON.parse(chunk.toString()) as Message;
    messages.push(request);
    if (!request.method || request.id === undefined) return;
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: 1 };
    else if (request.method === "session/new") result = { sessionId: "tutor-teaching" };
    else if (request.method === "session/set_config_option") {
      const configId = request.params!.configId;
      result = configId === "model" && confirmation === "missing" ? {}
        : { configOptions: [{ id: configId, currentValue: configId === "model" && confirmation === "different" ? "provider/other" : request.params!.value }] };
    } else if (request.method === "session/prompt") result = { stopReason: "end_turn" };
    queueMicrotask(() => {
      if (request.method === "session/prompt") child.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0", method: "session/update", params: { update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer }
        } }
      })}\n`);
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
  const adapter = new AcpTutorAdapter({ command: "opencode", model, cwd: "/isolated-teaching", env: { PATH: "/bin" } });
  const input: Parameters<AgentAdapter["run"]>[0] = {
    task: { id: "task", clientId: "communication-local", lead: "tutor", agent: "tutor", state: "working", phase: "reasoning", createdAt: 0, updatedAt: 0, artifacts: [], children: [], metrics: { modelCalls: 1, toolCalls: 0 } },
    prompt: "用一句话解释过程哲学。", context: "仅使用提供的公开学习材料。", signal: new AbortController().signal, emit: vi.fn()
  };
  return { adapter, input, messages, child, cleanup() { adapter.dispose(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } };
}

describe("independent ACP Tutor teaching boundary", () => {
  it("uses a conversation role for teaching while keeping tools and file access denied", async () => {
    const f = fixture();
    try {
      const artifacts = await f.adapter.run(f.input);
      const options = vi.mocked(spawn).mock.calls.at(-1)![2]!;
      const config = JSON.parse(options.env!.OPENCODE_CONFIG_CONTENT!);
      const agent = config.agent[config.default_agent];
      expect(agent.prompt).toContain("Use only the supplied conversation context");
      expect(agent.prompt).toContain("output protocol specified for each turn");
      expect(agent.prompt).not.toMatch(/drawing|screenshot|JSON/i);
      expect(agent.permission).toEqual({ "*": "deny" });
      expect(f.messages.find(message => message.method === "initialize")!.params!.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false });
      expect(f.messages.find(message => message.method === "session/new")!.params!.mcpServers).toEqual([]);
      const prompts = f.messages.filter(message => message.method === "session/prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.params!.prompt[0].text).toContain(f.input.context);
      expect(prompts[0]!.params!.prompt[0].text).toContain(f.input.prompt);
      expect(artifacts).toEqual([{ id: expect.any(String), type: "text", data: { text: answer } }]);
      expect(f.input.emit).toHaveBeenCalledWith({ type: "text", data: { text: answer } });
      expect(f.child.kill).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });

  it.each(["missing", "different"] as const)("sends no learning material when the chosen model confirmation is %s", async confirmation => {
    const f = fixture(confirmation);
    try {
      await expect(f.adapter.run(f.input)).rejects.toThrow("model-selection-unconfirmed");
      expect(f.messages.filter(message => message.method === "session/prompt")).toEqual([]);
      expect(f.input.emit).not.toHaveBeenCalled();
      expect(f.child.kill).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });
});
