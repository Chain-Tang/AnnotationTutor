import { describe, expect, it } from "vitest";
import { AcpReviewConversation, exeFromCmdShim } from "../src/acp-runner.js";

type Msg = Record<string, any>;
const result = (id: number, res: unknown): Msg => ({ jsonrpc: "2.0", id, result: res });
const update = (sessionUpdate: string, text: string): Msg => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { update: { sessionUpdate, content: { type: "text", text } } }
});

describe("AcpReviewConversation", () => {
  it("drives initialize → new → set model → prompt and keeps only message chunks", async () => {
    const sent: Msg[] = [];
    const conv = new AcpReviewConversation((m) => sent.push(m as Msg), {
      cwd: "/tmp",
      model: "opencode/deepseek-v4-flash-free",
      prompt: "review"
    });
    conv.start();

    expect(sent[0]!.method).toBe("initialize");
    expect(sent[0]!.params.protocolVersion).toBe(1);
    conv.receive(result(sent[0]!.id, { protocolVersion: 1 }));

    expect(sent[1]!.method).toBe("session/new");
    expect(sent[1]!.params).toEqual({ cwd: "/tmp", mcpServers: [] });
    conv.receive(result(sent[1]!.id, { sessionId: "ses_1" }));

    expect(sent[2]!.method).toBe("session/set_config_option");
    expect(sent[2]!.params).toEqual({
      sessionId: "ses_1",
      configId: "model",
      value: "opencode/deepseek-v4-flash-free"
    });
    conv.receive(result(sent[2]!.id, { configOptions: [] }));

    expect(sent[3]!.method).toBe("session/prompt");
    expect(sent[3]!.params.prompt).toEqual([{ type: "text", text: "review" }]);

    // Reasoning chunks are ignored; only message chunks form the review.
    conv.receive(update("agent_thought_chunk", "let me think"));
    conv.receive(update("agent_message_chunk", "Correctness: correct\n"));
    conv.receive(update("agent_message_chunk", "Comment: good."));
    conv.receive(result(sent[3]!.id, { stopReason: "end_turn" }));

    const outcome = await conv.done;
    expect(outcome.ok).toBe(true);
    expect(outcome.reviewText).toBe("Correctness: correct\nComment: good.");
    expect(outcome.stopReason).toBe("end_turn");
  });

  it("skips the model switch when no model is configured", async () => {
    const sent: Msg[] = [];
    const conv = new AcpReviewConversation((m) => sent.push(m as Msg), {
      cwd: "/tmp",
      model: "",
      prompt: "x"
    });
    conv.start();
    conv.receive(result(sent[0]!.id, {}));
    conv.receive(result(sent[1]!.id, { sessionId: "s" }));
    expect(sent[2]!.method).toBe("session/prompt");
  });

  it("proceeds with the prompt even if the model switch errors", async () => {
    const sent: Msg[] = [];
    const conv = new AcpReviewConversation((m) => sent.push(m as Msg), {
      cwd: "/tmp",
      model: "bad",
      prompt: "x"
    });
    conv.start();
    conv.receive(result(sent[0]!.id, {}));
    conv.receive(result(sent[1]!.id, { sessionId: "s" }));
    conv.receive({ jsonrpc: "2.0", id: sent[2]!.id, error: { code: -32602, message: "Invalid params" } });
    expect(sent[3]!.method).toBe("session/prompt");
  });

  it("declines agent permission requests so the turn is not blocked", async () => {
    const sent: Msg[] = [];
    const conv = new AcpReviewConversation((m) => sent.push(m as Msg), {
      cwd: "/tmp",
      model: "",
      prompt: "x"
    });
    conv.start();
    conv.receive(result(sent[0]!.id, {}));
    conv.receive(result(sent[1]!.id, { sessionId: "s" }));
    conv.receive({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { options: [] } });
    const reply = sent.find((m) => m.id === 99);
    expect(reply?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("fails when session/new returns no sessionId", async () => {
    const sent: Msg[] = [];
    const conv = new AcpReviewConversation((m) => sent.push(m as Msg), {
      cwd: "/tmp",
      model: "",
      prompt: "x"
    });
    conv.start();
    conv.receive(result(sent[0]!.id, {}));
    conv.receive(result(sent[1]!.id, {}));
    const outcome = await conv.done;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("sessionId");
  });
});

describe("exeFromCmdShim", () => {
  it("resolves %dp0% to the shim's own directory", () => {
    const cmdPath = "C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd";
    const content = '@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
    expect(exeFromCmdShim(cmdPath, content)).toBe(
      "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"
    );
  });

  it("returns null when the shim has no .exe reference", () => {
    expect(exeFromCmdShim("C:\\x\\foo.cmd", "echo hi")).toBe(null);
  });
});
