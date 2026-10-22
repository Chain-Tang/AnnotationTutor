// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TutorMcpTools, type TutorClientGrant } from "../src/tutor-mcp.js";
import { TutorTaskCoordinator } from "../src/tutor-task.js";
import { tutorPairingSchema } from "../src/tutor-grant.js";
import { communicationSendInputSchema, type TutorCommunicationGateway } from "../src/tutor-communication-mcp.js";
import { TutorCommunication, emptyCommunicationSnapshot, type CommunicationIdentity, type CommunicationSnapshot } from "../src/tutor-communication.js";
import { t } from "../src/i18n.js";

vi.mock("obsidian", () => {
  function element() {
    const content = document.createElement("div") as HTMLDivElement & { empty(): void; createEl(tag: string, options?: { text?: string }): HTMLElement };
    content.empty = () => content.replaceChildren();
    Object.defineProperty(content, "createEl", { value: (tag: string, options?: { text?: string }) => { const child = document.createElement(tag); child.textContent = options?.text ?? ""; content.append(child); return child; } });
    return content;
  }
  class Modal {
    titleEl = element(); contentEl = element();
    constructor(_app: unknown) {}
    onOpen(): void {} onClose(): void {}
    open(): void { this.onOpen(); } close(): void { this.onClose(); }
  }
  class Setting {
    row: HTMLElement;
    constructor(parent: HTMLElement) { this.row = document.createElement("div"); parent.append(this.row); }
    setName(name: string) { this.row.dataset.name = name; return this; }
    setDesc(_desc: string) { return this; }
    addToggle(callback: (toggle: unknown) => void) {
      const input = document.createElement("input"); input.type = "checkbox"; this.row.append(input);
      const toggle = { setValue(value: boolean) { input.checked = value; return toggle; }, setDisabled(value: boolean) { input.disabled = value; return toggle; }, onChange(handler: (value: boolean) => void) { input.addEventListener("change", () => handler(input.checked)); return toggle; } };
      callback(toggle); return this;
    }
    addButton(callback: (button: unknown) => void) {
      const input = document.createElement("button"); this.row.append(input);
      const button = { setButtonText(text: string) { input.textContent = text; return button; }, setCta() { return button; }, onClick(handler: () => void) { input.addEventListener("click", handler); return button; } };
      callback(button); return this;
    }
  }
  return { Modal, Setting, Notice: class {} };
});
import { TutorPairingModal } from "../src/tutor-pairing-modal.js";

const hostIdentity: CommunicationIdentity = { agentId: "tutor-host", vaultId: "vault-host", kind: "tutor" };
const caller: CommunicationIdentity = { agentId: "codex-client", vaultId: "external", kind: "codex" };
const other: CommunicationIdentity = { agentId: "tutor-other", vaultId: "vault-other", kind: "tutor" };
function clientGrant(): TutorClientGrant {
  return { clientId: "paired-client", name: "Codex", createdAt: "2026-10-16T00:00:00Z", documents: [], targets: [], humanObjectIds: [], read: false, write: false, learningMemory: false, communication: true, communicationIdentity: caller };
}
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(grant = clientGrant(), suppliedGateway?: TutorCommunicationGateway) {
  const tasks = new TutorTaskCoordinator(); cleanup.push(() => tasks.dispose());
  let snapshot: CommunicationSnapshot = emptyCommunicationSnapshot();
  const communication = new TutorCommunication({ read: async () => structuredClone(snapshot), transact: async change => { const next = structuredClone(snapshot); const value = change(next); snapshot = next; return value; } });
  const context = { goal: "Learn", background: "Shared background", summary: "Start here", sources: [] };
  await communication.createSpace(caller, { spaceId: "space-1", title: "Course", members: [{ identity: caller, read: true, write: true, admin: true }, { identity: hostIdentity, read: true, write: true }, { identity: other, read: true, write: true }], context });
  const gateway: TutorCommunicationGateway = suppliedGateway ?? {
    identity: vi.fn(async g => ({ host: hostIdentity, caller: g.communicationIdentity! })),
    invoke: vi.fn(async (g, operation, args, signal) => {
      signal.throwIfAborted(); const identity = g.communicationIdentity!;
      if (operation === "spaces") return communication.listSpaces(identity);
      if (operation === "read_space") return communication.readSpace(identity, args.spaceId as string);
      if (operation === "create_space") return communication.createSpace(identity, args as Parameters<TutorCommunication["createSpace"]>[1]);
      if (operation === "update_context") return communication.updateContext(identity, args.spaceId as string, args.expectedRevision as number, args.context as Parameters<TutorCommunication["updateContext"]>[3]);
      if (operation === "mailbox") { const { spaceId, ...query } = args; return communication.mailbox(identity, spaceId as string, query as Parameters<TutorCommunication["mailbox"]>[2]); }
      if (operation === "transition") return communication.transition(identity, args.spaceId as string, args.messageId as string, args.status as Parameters<TutorCommunication["transition"]>[3], args.detail as Parameters<TutorCommunication["transition"]>[4]);
      if (operation === "send") {
        const parsed = communicationSendInputSchema.parse(args);
        const space = await communication.readSpace(identity, parsed.spaceId);
        return communication.send(identity, { version: 1, spaceId: parsed.spaceId, messageId: parsed.messageId ?? crypto.randomUUID(), sender: identity, recipients: parsed.recipients, kind: parsed.kind, replyTo: parsed.replyTo, contextRevision: parsed.contextRevision ?? space.context.revision, payload: { text: parsed.text }, createdAt: 100 });
      }
      throw new Error("unknown-operation");
    }),
  };
  const tools = new TutorMcpTools({ communication: gateway, tasks, surfaces: async () => [], context: async () => { throw new Error("document-access-unexpected"); }, memory: async () => { throw new Error("memory-access-unexpected"); }, run: async () => [] });
  const [a, b] = InMemoryTransport.createLinkedPair(), server = tools.server(grant), client = new Client({ name: "communication-test", version: "1" });
  await server.connect(b); await client.connect(a);
  cleanup.push(() => client.close()); cleanup.push(() => server.close()); cleanup.push(() => tools.close());
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { tools, grant, gateway, communication, call, client, context };
}
const value = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.structuredContent as { value?: unknown })?.value;

describe("communication pairing and permission persistence", () => {
  it("does not upgrade existing grants and rejects truthy or unbound communication permissions", () => {
    const old = { ...clientGrant() }; delete old.communication; delete old.communicationIdentity;
    const wrapped = (grant: unknown) => ({ tokenHash: "a".repeat(64), grant });
    expect(tutorPairingSchema.parse(wrapped(old)).grant.communication).toBe(false);
    expect(tutorPairingSchema.safeParse(wrapped({ ...old, communication: "true", communicationIdentity: caller })).success).toBe(false);
    expect(tutorPairingSchema.safeParse(wrapped({ ...old, communication: true })).success).toBe(false);
    expect(tutorPairingSchema.safeParse(wrapped({ ...clientGrant(), communicationIdentity: { ...caller, threadId: "forged" } })).success).toBe(false);
    expect(tutorPairingSchema.parse(wrapped(clientGrant())).grant.communicationIdentity).toEqual(caller);
  });
  it("denies every communication operation without independent permission, regardless of document access", async () => {
    const f = await fixture({ ...clientGrant(), communication: false, documents: ["all.md"], read: true, write: true, learningMemory: true });
    for (const [name, args] of [
      ["identity", {}], ["spaces", {}], ["read_space", { spaceId: "space-1" }],
      ["send", { spaceId: "space-1", recipients: [hostIdentity], kind: "request", text: "hello" }],
      ["mailbox", { spaceId: "space-1", direction: "inbox" }],
      ["update_context", { spaceId: "space-1", expectedRevision: 1, context: { goal: "", background: "", summary: "", sources: [] } }],
      ["transition", { spaceId: "space-1", messageId: "message", status: "processing" }],
      ["create_space", { spaceId: "new-space", title: "New", members: [{ identity: caller, read: true, write: true, admin: true }], context: f.context }],
    ] as const) expect((await f.call(`tutor_communication_${name}`, args)).isError).toBe(true);
    expect(f.gateway.identity).not.toHaveBeenCalled(); expect(f.gateway.invoke).not.toHaveBeenCalled();
  });
  it("requires a valid grant-bound communication identity even if the boolean is true", async () => {
    const f = await fixture({ ...clientGrant(), communicationIdentity: undefined });
    expect((await f.call("tutor_communication_identity")).isError).toBe(true);
    expect(f.gateway.identity).not.toHaveBeenCalled();
  });
  it("supports communication-only pairing and keeps document and memory permissions off", async () => {
    let grant: TutorClientGrant | null | undefined;
    const modal = new TutorPairingModal({} as never, "Other Tutor", [], [], false, result => { grant = result; }, other);
    modal.onOpen();
    expect(modal.contentEl.textContent).toContain("vault-other");
    const toggle = [...modal.contentEl.querySelectorAll("input")].find(input => input.parentElement?.dataset.name === t("upgrade.pairCommunication"))!;
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
    [...modal.contentEl.querySelectorAll("button")].find(button => button.textContent === t("board.pairAllow"))!.click();
    expect(grant).toMatchObject({ documents: [], targets: [], read: false, write: false, learningMemory: false, learningEvidence: false, communication: true, communicationIdentity: other });
    modal.onClose();
  });
  it("assigns a new, displayed external Codex identity when none was requested, without auto-authorizing it", () => {
    let grant: TutorClientGrant | null | undefined;
    const modal = new TutorPairingModal({} as never, "Codex", [], ["a.md"], false, result => { grant = result; });
    modal.onOpen();
    const allow = [...modal.contentEl.querySelectorAll("button")].find(button => button.textContent === t("board.pairAllow"))!;
    allow.click(); expect(grant).toBeUndefined();
    const communicationToggle = [...modal.contentEl.querySelectorAll("input")].find(input => input.parentElement?.dataset.name === t("upgrade.pairCommunication"))!;
    expect(communicationToggle.checked).toBe(false);
    communicationToggle.checked = true; communicationToggle.dispatchEvent(new Event("change")); allow.click();
    expect(grant).toMatchObject({ communicationIdentity: { vaultId: "external", kind: "codex" } });
    const saved = grant as unknown as TutorClientGrant;
    expect(saved.communicationIdentity?.agentId).toBe(saved.clientId); modal.onClose();
  });
});

describe("typed communication tools over the actual MCP SDK", () => {
  it("advertises all eight operations with bounded, typed send and mailbox inputs", async () => {
    const f = await fixture(); const list = await f.client.listTools();
    const tools = list.tools.filter(tool => tool.name.startsWith("tutor_communication_"));
    expect(tools).toHaveLength(8);
    const send = tools.find(tool => tool.name.endsWith("_send"))!;
    expect(JSON.stringify(send.inputSchema)).toContain("16000");
    expect(Object.keys(send.inputSchema.properties ?? {})).not.toContain("sender");
    expect(tools.find(tool => tool.name.endsWith("_spaces"))?.annotations?.readOnlyHint).toBe(true);
    expect(send.annotations?.readOnlyHint).toBe(false);
  });
  it("returns identity directly, forwards the exact authenticated grant, and wraps other results in value", async () => {
    const f = await fixture(); const identity = await f.call("tutor_communication_identity");
    expect(identity.isError).toBeFalsy(); expect(identity.structuredContent).toEqual({ host: hostIdentity, caller });
    expect(f.gateway.identity).toHaveBeenCalledWith(f.grant);
    const result = await f.call("tutor_communication_spaces");
    expect(value(result)).toMatchObject([{ spaceId: "space-1", context: { revision: 1 } }]);
    expect(f.gateway.invoke).toHaveBeenCalledWith(f.grant, "spaces", {}, expect.any(AbortSignal));
    expect((await f.call("tutor_get_context", { source: "all.md" })).isError).toBe(true);
    expect((await f.call("tutor_read_learning")).isError).toBe(true);
  });
  it("rejects a gateway that attempts to substitute another caller identity", async () => {
    const f = await fixture(clientGrant(), { identity: async () => ({ host: hostIdentity, caller: other }), invoke: async () => undefined });
    expect((await f.call("tutor_communication_identity")).isError).toBe(true);
  });
  it("derives sender from pairing, persists request/result references, and isolates inboxes", async () => {
    const f = await fixture();
    const sent = await f.call("tutor_communication_send", { spaceId: "space-1", messageId: "request-1", sender: other, recipients: [hostIdentity], kind: "request", text: "Explain the next chapter" });
    expect(sent.isError).toBeFalsy(); expect(value(sent)).toMatchObject({ message: { envelope: { sender: caller, recipients: [hostIdentity], payload: { text: "Explain the next chapter" } }, deliveries: [{ status: "accepted" }] } });
    expect(value(await f.call("tutor_communication_mailbox", { spaceId: "space-1", direction: "inbox" }))).toEqual({ messages: [] });
    const source = await f.communication.getMessage(hostIdentity, "space-1", "request-1");
    await f.communication.send(hostIdentity, { version: 1, spaceId: "space-1", messageId: "reply-1", sender: hostIdentity, recipients: [caller], kind: "result", replyTo: "request-1", contextRevision: source.envelope.contextRevision, payload: { text: "Here is the explanation" }, createdAt: 101 });
    const inbox = await f.call("tutor_communication_mailbox", { spaceId: "space-1", direction: "inbox", limit: 1 });
    expect(value(inbox)).toMatchObject({ messages: [{ envelope: { messageId: "reply-1", replyTo: "request-1" } }] });
    expect((await f.call("tutor_communication_transition", { spaceId: "space-1", messageId: "request-1", status: "processing" })).isError).toBe(true);
    expect((await f.call("tutor_communication_transition", { spaceId: "space-1", messageId: "reply-1", status: "processing" })).isError).toBeFalsy();
    expect((await f.call("tutor_communication_transition", { spaceId: "space-1", messageId: "reply-1", status: "completed", detail: { summary: "Read and integrated" } })).isError).toBeFalsy();
  });
  it("does not expose unrelated spaces and rejects stale context updates", async () => {
    const f = await fixture();
    await f.communication.createSpace(other, { spaceId: "private", title: "Private", members: [{ identity: other, read: true, write: true, admin: true }], context: f.context });
    expect(value(await f.call("tutor_communication_spaces"))).toHaveLength(1);
    expect((await f.call("tutor_communication_read_space", { spaceId: "private" })).isError).toBe(true);
    expect((await f.call("tutor_communication_update_context", { spaceId: "space-1", expectedRevision: 1, context: { ...f.context, summary: "Revised" } })).isError).toBeFalsy();
    expect((await f.call("tutor_communication_update_context", { spaceId: "space-1", expectedRevision: 1, context: f.context })).isError).toBe(true);
  });
  it("creates explicit membership without joining other authorized identities to all spaces", async () => {
    const f = await fixture();
    const created = await f.call("tutor_communication_create_space", { spaceId: "new-space", title: "New", members: [{ identity: caller, read: true, write: true, admin: true }], context: f.context });
    expect(created.isError).toBeFalsy(); expect(value(created)).toMatchObject({ spaceId: "new-space", members: [{ identity: caller }] });
    await expect(f.communication.readSpace(hostIdentity, "new-space")).rejects.toThrow("not-authorized");
  });
  it("validates recipient identity, limits, replies and status before passing to the host", async () => {
    const f = await fixture();
    for (const args of [
      { spaceId: "space-1", recipients: [{ ...hostIdentity, role: "admin" }], kind: "request", text: "hello" },
      { spaceId: "space-1", recipients: [], kind: "request", text: "hello" },
      { spaceId: "space-1", recipients: [hostIdentity, hostIdentity], kind: "request", text: "hello" },
      { spaceId: "space-1", recipients: [hostIdentity], kind: "request", text: "x".repeat(16001) },
      { spaceId: "space-1", recipients: [hostIdentity], kind: "result", text: "no reference" },
    ]) expect((await f.call("tutor_communication_send", args)).isError).toBe(true);
    expect((await f.call("tutor_communication_mailbox", { spaceId: "space-1", direction: "inbox", limit: 1000 })).isError).toBe(true);
    expect((await f.call("tutor_communication_transition", { spaceId: "space-1", messageId: "m", status: "sent" })).isError).toBe(true);
    expect(f.gateway.invoke).not.toHaveBeenCalled();
  });
  it("revokes existing sessions and aborts an in-flight gateway operation without claiming success", async () => {
    let observedSignal: AbortSignal | undefined;
    const gateway: TutorCommunicationGateway = { identity: async () => ({ host: hostIdentity, caller }), invoke: async (_g, _op, _args, signal) => {
      observedSignal = signal; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { accepted: true };
    } };
    const f = await fixture(clientGrant(), gateway);
    const pending = f.call("tutor_communication_spaces"); await vi.waitFor(() => expect(observedSignal).toBeDefined());
    f.tools.revoke(f.grant.clientId);
    expect(observedSignal!.aborted).toBe(true); expect((await pending).isError).toBe(true);
    expect((await f.call("tutor_communication_identity")).isError).toBe(true);
  });
  it("service closure aborts gateway work and refuses more work", async () => {
    let observedSignal: AbortSignal | undefined;
    const gateway: TutorCommunicationGateway = { identity: async () => ({ host: hostIdentity, caller }), invoke: async (_g, _op, _args, signal) => {
      observedSignal = signal; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return {};
    } };
    const f = await fixture(clientGrant(), gateway);
    const pending = f.call("tutor_communication_spaces"); await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await f.tools.close(); expect((await pending).isError).toBe(true); expect(observedSignal!.aborted).toBe(true);
    expect((await f.call("tutor_communication_spaces")).isError).toBe(true);
  });
});
