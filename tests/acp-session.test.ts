import { describe, expect, it } from "vitest";
import {
  AcpSession,
  isReadOnlyTool,
  permissionOutcome,
  type AcpStreamEvent
} from "../src/acp-session.js";

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
