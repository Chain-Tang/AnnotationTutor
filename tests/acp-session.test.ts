import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AcpSession,
  acpSessionEnvironment,
  acpModelImageSupport,
  startAcpSession,
  BOARD_ACP_MODE,
  isReadOnlyTool,
  permissionOutcome,
  type AcpStreamEvent
} from "../src/acp-session.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type Msg = Record<string, any>;
const result = (id: number, res: unknown): Msg => ({ jsonrpc: "2.0", id, result: res });
const update = (sessionUpdate: string, text: string): Msg => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { update: { sessionUpdate, content: { type: "text", text } } }
});
// The session is request/response sequential — each next request is only sent
// after the previous response is fed in — so flush the queue between steps.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Feed the handshake responses (initialize → new → optional set model). */
async function handshake(
  sent: Msg[],
  session: AcpSession,
  hasModel = true
): Promise<void> {
  await flush();
  session.receive(result(sent[0]!.id, { protocolVersion: 1 }));
  await flush();
  session.receive(result(sent[1]!.id, { sessionId: "ses_1" }));
  await flush();
  if (hasModel) {
    session.receive(result(sent[2]!.id, {}));
    await flush();
  }
}

describe("AcpSession", () => {
  it("distinguishes model image support from runtime capability, without trusting missing metadata", () => {
    const catalog = ['provider/text', '{"capabilities":{"input":{"image":false}}}', 'provider/vision', '{"name":"Vision with a } in its name", "capabilities":{"input":{"image":true}}}', 'provider/unknown', '{}'].join("\n");
    expect(acpModelImageSupport(catalog, "provider/text")).toBe(false);
    expect(acpModelImageSupport(catalog, "provider/vision")).toBe(true);
    expect(acpModelImageSupport(catalog, "provider/unknown")).toBeNull();
    expect(acpModelImageSupport(catalog, "provider/missing")).toBeNull();
    expect(acpModelImageSupport('provider/broken\n{"x":{', "provider/broken")).toBeNull();
  });

  it("isolates board tool permissions in child-only config while preserving providers and ordinary chat", () => {
    const config = { provider: { custom: { options: { baseURL: "https://example.com" } } }, agent: { build: { permission: "allow" } } };
    const original = { PATH: "/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    const env = acpSessionEnvironment(original, true);
    const result = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(result.provider).toEqual(config.provider);
    expect(result.agent.build).toEqual(config.agent.build);
    expect(result.default_agent).toBe(BOARD_ACP_MODE);
    expect(result.agent[BOARD_ACP_MODE].permission).toEqual({ "*": "deny" });
    expect(result.agent[BOARD_ACP_MODE].prompt).toContain("Return drawing JSON");
    expect(acpSessionEnvironment(original, false)).toEqual(original);
    expect(JSON.parse(original.OPENCODE_CONFIG_CONTENT)).toEqual(config);
    expect(() => acpSessionEnvironment({ OPENCODE_CONFIG_CONTENT: "invalid" }, true)).toThrow("board-runtime-config-invalid");
  });

  it("keeps conversation output turn-specific without weakening isolated permissions", () => {
    const configured = { permission: "allow", provider: { custom: { options: { baseURL: "https://example.com" } } }, agent: { build: { prompt: "Write code", permission: "allow" } } };
    const original = { PATH: "/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify(configured) };
    const mode = "tutor-isolated-conversation";
    const config = JSON.parse(acpSessionEnvironment(original, true, mode, "conversation").OPENCODE_CONFIG_CONTENT!);
    expect(config.default_agent).toBe(mode);
    expect(config.provider).toEqual(configured.provider);
    expect(config.agent.build).toEqual(configured.agent.build);
    expect(config.agent[mode]).toMatchObject({ mode: "primary", permission: { "*": "deny" } });
    expect(config.agent[mode].prompt).toContain("Use only the supplied conversation context");
    expect(config.agent[mode].prompt).toContain("Follow the output protocol specified for each turn");
    expect(config.agent[mode].prompt).toContain("Do not use tools");
    expect(config.agent[mode].prompt).not.toMatch(/drawing|screenshot|JSON/i);
    expect(acpSessionEnvironment(original, false, mode, "conversation")).toEqual(original);
    expect(JSON.parse(original.OPENCODE_CONFIG_CONTENT)).toEqual(configured);
    expect(() => acpSessionEnvironment({ OPENCODE_CONFIG_CONTENT: "invalid" }, true, mode, "conversation")).toThrow("board-runtime-config-invalid");
  });

  it.each([undefined, "board", "conversation"] as const)("passes the %s role to the child without exposing tools, files or MCP", async role => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const sent: Msg[] = [];
    child.stdin.on("data", chunk => {
      const request = JSON.parse(chunk.toString()) as Msg;
      sent.push(request);
      if (!request.method || request.id === undefined) return;
      const response = request.method === "initialize" ? { protocolVersion: 1 }
        : request.method === "session/new" ? { sessionId: "isolated" }
        : { configOptions: [{ id: "mode", currentValue: request.params.value }] };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(result(request.id, response))}\n`));
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const readFile = vi.fn(async () => "must not read"), requestPermission = vi.fn(async () => "allow_always" as const);
    const cwd = "/isolated-tutor-session";
    const handle = await startAcpSession({ command: "opencode", model: "", cwd, denyTools: true, toolFreeRole: role,
      onUpdate: () => {}, readFile, requestPermission, mcpServers: [{ name: "forbidden", command: "unused" }], env: { PATH: "/bin" } });
    try {
      const options = vi.mocked(spawn).mock.calls.at(-1)![2]!;
      expect(options.cwd).toBe(cwd);
      const config = JSON.parse(options.env!.OPENCODE_CONFIG_CONTENT!);
      const mode = config.default_agent;
      expect(mode).toMatch(/^tutor-board-[a-f0-9-]+$/);
      expect(config.agent[mode].permission).toEqual({ "*": "deny" });
      expect(config.agent[mode].prompt.includes("Return drawing JSON")).toBe(role !== "conversation");
      expect(config.agent[mode].prompt.includes("output protocol specified for each turn")).toBe(role === "conversation");
      expect(sent[0]!.params.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false });
      expect(sent[1]!.params).toMatchObject({ cwd, mcpServers: [] });
      expect(sent[2]!.params).toMatchObject({ configId: "mode", value: mode });
      handle.session.receive({ id: 80, method: "session/request_permission", params: { toolCall: { kind: "read" }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }] } });
      handle.session.receive({ id: 81, method: "fs/read_text_file", params: { path: "/vault/private" } });
      await flush();
      expect(sent.find(message => message.id === 80)?.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
      expect(sent.find(message => message.id === 81)?.error).toBeTruthy();
      expect(readFile).not.toHaveBeenCalled();expect(requestPermission).not.toHaveBeenCalled();
    } finally { handle.dispose(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("requires confirmation of a dedicated board runtime mode", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m), {
      cwd: "/vault", model: "", onUpdate: () => {}, requiredMode: BOARD_ACP_MODE
    });
    const started = session.start();
    session.receive(result(sent[0]!.id, {})); await flush();
    session.receive(result(sent[1]!.id, { sessionId: "board" })); await flush();
    expect(sent[2]!.params).toMatchObject({ configId: "mode", value: BOARD_ACP_MODE });
    session.receive(result(sent[2]!.id, { configOptions: [{ id: "mode", currentValue: "build" }] }));
    await started;
    expect(session.error).toBe("board-mode-unconfirmed");
  });

  it("requires advertised images before opening a visual board session", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m), {
      cwd: "/vault", model: "vision", onUpdate: () => {}, requireImageSupport: true
    });
    const started = session.start();
    session.receive(result(sent[0]!.id, { agentCapabilities: { promptCapabilities: { image: false } } }));
    await started;
    expect(session.error).toBe("image-not-supported");
    expect(sent).toHaveLength(1);
  });

  it("cancels oversized streamed board output before retaining it", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m), {
      cwd: "/vault", model: "", onUpdate: () => {}, maxTurnChars: 10
    });
    void session.start(); await handshake(sent, session, false);
    const turn = session.prompt("draw"); await flush();
    session.receive(update("agent_message_chunk", "12345"));
    session.receive(update("agent_message_chunk", "678901"));
    expect(await turn).toMatchObject({ ok: false, text: "12345", error: "response-too-large" });
    expect(sent.at(-1)?.method).toBe("session/cancel");
  });

  it("sends image blocks only after confirming the exact selected board model", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m), {
      cwd: "/vault", model: "provider/vision", onUpdate: () => {},
      requireImageSupport: true, strictModelSelection: true, denyTools: true
    });
    const started = session.start();
    session.receive(result(sent[0]!.id, { agentCapabilities: { promptCapabilities: { image: true } } }));
    await flush();
    session.receive(result(sent[1]!.id, { sessionId: "board" }));
    await flush();
    session.receive(result(sent[2]!.id, { configOptions: [{ id: "model", currentValue: "provider/vision" }] }));
    await started;
    const blocks = [{ type: "text" as const, text: "Draw" }, { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" }];
    const turn = session.prompt(blocks);
    await flush();
    expect(sent[3]!.params.prompt).toEqual(blocks);
    session.receive(update("agent_message_chunk", "{}"));
    session.receive(result(sent[3]!.id, { stopReason: "end_turn" }));
    expect((await turn).text).toBe("{}");
    session.cancel();
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "board" } });
  });

  it.each([{}, { configOptions: [{ id: "model", currentValue: "wrong" }] }])("rejects an unconfirmed model rather than sending images: %j", async (selected) => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m), {
      cwd: "/vault", model: "vision", onUpdate: () => {}, strictModelSelection: true
    });
    const started = session.start();
    session.receive(result(sent[0]!.id, {}));
    await flush();
    session.receive(result(sent[1]!.id, { sessionId: "board" }));
    await flush();
    session.receive(result(sent[2]!.id, selected));
    await started;
    expect(session.error).toBe("model-selection-unconfirmed");
  });

  it("board sessions deny even read tools and expose neither files nor MCP servers", async () => {
    const sent: Msg[] = [];
    let asked = false;
    let read = false;
    const session = new AcpSession((m) => sent.push(m), {
      cwd: "/vault", model: "", onUpdate: () => {}, denyTools: true,
      readFile: async () => { read = true; return "secret"; },
      requestPermission: async () => { asked = true; return "allow_always"; },
      mcpServers: [{ name: "unused", command: "unused" }]
    });
    void session.start();
    await handshake(sent, session, false);
    expect(sent[0]!.params.clientCapabilities.fs.readTextFile).toBe(false);
    expect(sent[1]!.params.mcpServers).toEqual([]);
    session.receive({ id: 80, method: "session/request_permission", params: {
      toolCall: { kind: "read" }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }]
    } });
    session.receive({ id: 81, method: "fs/read_text_file", params: { path: "/vault/secret" } });
    await flush();
    expect(sent.find((m) => m.id === 80)?.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(sent.find((m) => m.id === 81)?.error).toBeTruthy();
    expect(asked).toBe(false);
    expect(read).toBe(false);
  });

  it("fails an active board turn if the runtime silently changes its model", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m), {
      cwd: "/vault", model: "vision", onUpdate: () => {}, strictModelSelection: true
    });
    void session.start();
    session.receive(result(sent[0]!.id, {}));
    await flush();
    session.receive(result(sent[1]!.id, { sessionId: "board" }));
    await flush();
    session.receive(result(sent[2]!.id, { configOptions: [{ id: "model", currentValue: "vision" }] }));
    const turn = session.prompt("draw");
    await flush();
    session.receive({ method: "session/update", params: { update: {
      sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "text-only" }]
    } } });
    expect((await turn).error).toBe("model-selection-unconfirmed");
  });

  it("handshakes, sets the model, and streams a prompt turn", async () => {
    const sent: Msg[] = [];
    const events: AcpStreamEvent[] = [];
    const session = new AcpSession((m) => sent.push(m as Msg), {
      cwd: "/vault",
      model: "opencode/deepseek-v4-flash-free",
      onUpdate: (e) => events.push(e)
    });
    void session.start();
    await flush();

    expect(sent[0]!.method).toBe("initialize");
    expect(sent[0]!.params.clientCapabilities.fs.readTextFile).toBe(false); // no readFile injected
    session.receive(result(sent[0]!.id, { protocolVersion: 1 }));
    await flush();
    expect(sent[1]!.method).toBe("session/new");
    session.receive(result(sent[1]!.id, { sessionId: "ses_1" }));
    await flush();
    expect(sent[2]!.method).toBe("session/set_config_option");
    expect(sent[2]!.params).toMatchObject({
      configId: "model",
      value: "opencode/deepseek-v4-flash-free"
    });
    session.receive(result(sent[2]!.id, {}));
    await flush();

    const turn = session.prompt("explain projection", { mode: "plan" });
    await flush();
    expect(sent[3]!.method).toBe("session/set_config_option");
    expect(sent[3]!.params).toMatchObject({ configId: "mode", value: "plan" });
    session.receive(result(sent[3]!.id, {}));
    await flush();
    expect(sent[4]!.method).toBe("session/prompt");

    session.receive(update("agent_thought_chunk", "thinking"));
    session.receive(update("agent_message_chunk", "Projection is "));
    session.receive(update("agent_message_chunk", "a defense."));
    session.receive(result(sent[4]!.id, { stopReason: "end_turn" }));

    const out = await turn;
    expect(out.ok).toBe(true);
    expect(out.text).toBe("Projection is a defense.");
    expect(events).toContainEqual({ type: "message", text: "Projection is " });
    expect(events).toContainEqual({ type: "thought", text: "thinking" });
    expect(events).toContainEqual({ type: "mode", mode: "plan" });
  });

  it("keeps context across turns and does not resend an unchanged mode", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m as Msg), {
      cwd: "/vault",
      model: "",
      onUpdate: () => {}
    });
    void session.start();
    await handshake(sent, session, false); // no model ⇒ no set_config_option
    expect(sent.length).toBe(2);

    const first = session.prompt("hi", { mode: "build" });
    await flush();
    expect(sent[2]!.method).toBe("session/set_config_option"); // mode build
    session.receive(result(sent[2]!.id, {}));
    await flush();
    expect(sent[3]!.method).toBe("session/prompt");
    session.receive(result(sent[3]!.id, { stopReason: "end_turn" }));
    await first;

    const second = session.prompt("again", { mode: "build" });
    await flush();
    // mode unchanged ⇒ goes straight to prompt
    expect(sent[4]!.method).toBe("session/prompt");
    session.receive(result(sent[4]!.id, { stopReason: "end_turn" }));
    await second;
  });

  it("serves an on-demand file read from the injected reader", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m as Msg), {
      cwd: "/vault",
      model: "",
      onUpdate: () => {},
      readFile: async (path) => (path === "/vault/note.md" ? "# Note" : null)
    });
    void session.start();
    await flush();
    expect(sent[0]!.params.clientCapabilities.fs.readTextFile).toBe(true);
    await handshake(sent, session, false);

    session.receive({
      jsonrpc: "2.0",
      id: 77,
      method: "fs/read_text_file",
      params: { sessionId: "ses_1", path: "/vault/note.md" }
    });
    await flush();
    expect(sent.find((m) => m.id === 77)?.result).toEqual({ content: "# Note" });

    session.receive({
      jsonrpc: "2.0",
      id: 78,
      method: "fs/read_text_file",
      params: { sessionId: "ses_1", path: "/etc/passwd" }
    });
    await flush();
    expect(sent.find((m) => m.id === 78)?.error).toBeTruthy();
  });

  it("reports an error turn when the handshake never gets a sessionId", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m as Msg), {
      cwd: "/vault",
      model: "",
      onUpdate: () => {}
    });
    void session.start();
    await flush();
    session.receive(result(sent[0]!.id, {}));
    await flush();
    session.receive(result(sent[1]!.id, {})); // no sessionId
    await flush();
    const turn = await session.prompt("hi");
    expect(turn.ok).toBe(false);
    expect(session.error).toContain("sessionId");
  });

  it("settles an in-flight prompt with ok:false when disposed mid-turn", async () => {
    const sent: Msg[] = [];
    const session = new AcpSession((m) => sent.push(m as Msg), {
      cwd: "/vault",
      model: "",
      onUpdate: () => {}
    });
    void session.start();
    await handshake(sent, session, false);
    // Start a turn but never feed its response; disposing must settle the await
    // instead of leaving prompt() pending forever (which would wedge the UI's
    // busy flag). Sending a mode first, then the prompt, mirrors a real turn.
    const turn = session.prompt("hi", { mode: "build" });
    await flush();
    session.receive(result(sent[2]!.id, {})); // mode ack
    await flush();
    session.dispose();
    const result_ = await turn;
    expect(result_.ok).toBe(false);
    expect(result_.error).toContain("disposed");
  });
});

describe("permissionOutcome", () => {
  it("auto-allows a read-only tool by selecting an allow option", () => {
    const out = permissionOutcome(
      {
        toolCall: { kind: "read", title: "Read note.md" },
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" }
        ]
      },
      true
    );
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "a" } });
  });

  it("declines a write/execute tool", () => {
    const out = permissionOutcome(
      {
        toolCall: { kind: "edit", title: "Edit note.md" },
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" }
        ]
      },
      true
    );
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "r" } });
  });

  it("cancels when there are no options to choose from", () => {
    expect(permissionOutcome({ toolCall: { kind: "read" } }, true)).toEqual({
      outcome: { outcome: "cancelled" }
    });
  });
});

describe("isReadOnlyTool", () => {
  it("recognizes read-only tools by the protocol kind", () => {
    expect(isReadOnlyTool({ kind: "read" })).toBe(true);
    expect(isReadOnlyTool({ kind: "search" })).toBe(true);
    expect(isReadOnlyTool({ kind: "fetch" })).toBe(true);
    expect(isReadOnlyTool({ kind: "list" })).toBe(true);
    expect(isReadOnlyTool({ kind: "edit", title: "Edit file" })).toBe(false);
    expect(isReadOnlyTool(undefined)).toBe(false);
  });

  it("never trusts the agent-controlled title over the kind", () => {
    // `title` is free text the agent writes; a read-ish title must not open the
    // gate for a destructive kind, and a missing kind is unknown, not safe.
    expect(isReadOnlyTool({ title: "Grep the vault" })).toBe(false);
    expect(isReadOnlyTool({ kind: "execute", title: "find . -delete" })).toBe(false);
    expect(isReadOnlyTool({ kind: "edit", title: "read then rewrite" })).toBe(false);
    expect(isReadOnlyTool({ kind: "delete", title: "list stale files" })).toBe(false);
  });
});

describe('ACP execution outcome diagnostics',()=>{
  it('preserves formal errors, detects empty end_turn with provider evidence, and scopes each turn',async()=>{
    let evidence:string|undefined;const sent:Msg[]=[];
    const session=new AcpSession(m=>sent.push(m),{cwd:'/vault',model:'',onUpdate:()=>{},beginTurn:()=>{evidence=undefined;},turnDiagnostic:async()=>evidence,endTurn:()=>{evidence=undefined;}});
    void session.start();await handshake(sent,session,false);
    const empty=session.prompt('draw');await flush();evidence='provider-access-403';session.receive(result(sent.at(-1)!.id,{stopReason:'end_turn'}));
    expect(await empty).toMatchObject({ok:false,error:'provider-access-403'});
    const unknown=session.prompt('next');await flush();session.receive(result(sent.at(-1)!.id,{stopReason:'end_turn'}));
    expect(await unknown).toMatchObject({ok:true,text:'',diagnostic:undefined});
    const recovered=session.prompt('next');await flush();evidence='provider-rate-limit-429';session.receive(update('agent_message_chunk','valid content'));session.receive(result(sent.at(-1)!.id,{stopReason:'end_turn'}));
    expect(await recovered).toMatchObject({ok:true,text:'valid content'});
    const formal=session.prompt('next');await flush();evidence='provider-access-403';session.receive({jsonrpc:'2.0',id:sent.at(-1)!.id,error:{message:'Formal upstream error'}});
    expect(await formal).toMatchObject({ok:false,error:'Formal upstream error'});session.dispose();
  });
});
