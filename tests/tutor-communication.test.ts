import { describe, expect, it } from "vitest";
import { TutorCommunication, communicationEnvelopeSchema, communicationFailureDetail, TUTOR_COMMUNICATION_LIMITS, type CommunicationCreateSpace, type CommunicationEnvelope, type CommunicationIdentity } from "../src/tutor-communication.js";
import { TutorCommunicationStore } from "../src/tutor-communication-store.js";

const tutorA: CommunicationIdentity = { kind: "tutor", vaultId: "vault-a", agentId: "tutor" };
const tutorB: CommunicationIdentity = { kind: "tutor", vaultId: "vault-b", agentId: "tutor" };
const codex: CommunicationIdentity = { kind: "codex", vaultId: "codex", agentId: "current-client" };
const observer: CommunicationIdentity = { kind: "human", vaultId: "vault-a", agentId: "observer" };
const stranger: CommunicationIdentity = { kind: "tutor", vaultId: "other-vault", agentId: "tutor" };
const context = { goal: "Teach process philosophy", background: "Beginner", summary: "Read identity introduction", sources: [{ vaultId: "vault-a", path: "course.md", revision: "sha256:one" }] };
const create = (): CommunicationCreateSpace => ({ spaceId: "philosophy", title: "Philosophy course", context, members: [
  { identity: tutorA, read: true, write: true, admin: true }, { identity: tutorB, read: true, write: true },
  { identity: codex, read: true, write: true }, { identity: observer, read: true, write: false },
] });
const envelope = (id = "message-1", from = tutorA, recipients = [tutorB, codex]): CommunicationEnvelope => ({ version: 1, spaceId: "philosophy", messageId: id, sender: from, recipients, kind: "request", contextRevision: 1, payload: { text: "Independently check this explanation", sources: context.sources }, createdAt: 100 });
function fixture() {
  const files = new Map<string, string>(); let writes = 0;
  const io = { read: async (path: string) => files.get(path) ?? null, compareWrite: async (path: string, previous: string | null, next: string) => { if ((files.get(path) ?? null) !== previous) throw Error("cas-mismatch"); files.set(path, next); writes++; } };
  const store = new TutorCommunicationStore(io, "private/communication.json"), service = new TutorCommunication(store, { now: () => 200 });
  return { files, io, store, service, writes: () => writes };
}

describe("safe communication failure diagnostics",()=>{
  it.each(["model-selection-unconfirmed","mode-selection-unconfirmed","provider-access-401","provider-access-403","provider-access","provider-rate-limit-429","provider-error","tutor-empty-output","session-closed"])("maps the fixed %s prefix without copying provider details",code=>{
    const detail=communicationFailureDetail(Error(`${code}: Bearer sk-secret https://private.example/secret model=private-model prompt=private-prompt`));
    expect(detail.code).toBe(code);expect(detail.summary).toMatch(/[\u4e00-\u9fff]/u);
    expect(JSON.stringify(detail)).not.toMatch(/sk-secret|private\.example|private-model|private-prompt/);
  });
  it("recognizes a native missing-command code without publishing the command or path",()=>{
    const error=Object.assign(Error("spawn /private/secret-command ENOENT"),{code:"ENOENT",path:"/private/secret-command"});
    expect(communicationFailureDetail(error)).toMatchObject({code:"agent-command-not-found"});
    expect(communicationFailureDetail(Error("ENOENT: private path"))).toEqual(communicationFailureDetail(error));
    expect(JSON.stringify(communicationFailureDetail(error))).not.toContain("secret-command");
  });
  it.each([Error("unknown provider failure: sk-secret"),Error("wrapped: provider-access-401"),Error("provider-access-401-spoof: sk-secret"),{message:"provider-error",code:"untrusted"},null])("keeps an unrecognized failure generic",error=>{
    expect(communicationFailureDetail(error)).toEqual(communicationFailureDetail(undefined));
    expect(communicationFailureDetail(error).code).toBe("reply-not-confirmed");
  });
  it("keeps explicit cancellation ahead of any diagnostic classification",()=>{
    expect(communicationFailureDetail(Error("provider-access-401: secret"),true)).toMatchObject({code:"cancelled"});
  });
});

describe("persistent public multi-directional communication", () => {
  it("persists two independent recipient states and restores Tutor-initiated Codex replies", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create());
    await f.service.send(tutorA, envelope());
    await f.service.transition(tutorB, "philosophy", "message-1", "processing");
    await f.service.transition(tutorB, "philosophy", "message-1", "completed", { summary: "Sources checked" });
    expect((await f.service.mailbox(codex, "philosophy", { direction: "inbox", status: "accepted" })).messages).toHaveLength(1);
    const restored = new TutorCommunication(new TutorCommunicationStore(f.io, "private/communication.json"));
    expect((await restored.getMessage(tutorA, "philosophy", "message-1")).deliveries.map(delivery => delivery.status)).toEqual(["completed", "accepted"]);
    const reply: CommunicationEnvelope = { ...envelope("reply", codex, [tutorA]), kind: "result", replyTo: "message-1", payload: { text: "Reviewed", summary: "A numerical/qualitative identity distinction is needed" } };
    await restored.send(codex, reply);
    expect((await restored.mailbox(tutorA, "philosophy", { direction: "inbox" })).messages[0]?.envelope).toEqual(reply);
    expect((await restored.mailbox(codex, "philosophy", { direction: "outbox" })).messages[0]?.deliveries[0]?.status).toBe("accepted");
  });
  it("replays exact envelopes without writes and rejects reuse across payloads or spaces", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create()); const sent = await f.service.send(tutorA, envelope()), count = f.writes();
    expect(sent.duplicate).toBe(false); expect((await f.service.send(tutorA, envelope())).duplicate).toBe(true); expect(f.writes()).toBe(count);
    await expect(f.service.send(tutorA, { ...envelope(), payload: { text: "Different action" } })).rejects.toThrow("communication-message-id-reused");
    await f.service.createSpace(tutorA, { ...create(), spaceId: "other" });
    await expect(f.service.send(tutorA, { ...envelope(), spaceId: "other" })).rejects.toThrow("communication-message-id-reused");
    expect((await f.service.getMessage(tutorB, "philosophy", "message-1")).envelope).toEqual(envelope());
  });
  it("binds sender to authenticated caller and checks explicit space, recipient and write membership", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create());
    await expect(f.service.send(codex, envelope())).rejects.toThrow("communication-sender-mismatch");
    await expect(f.service.readSpace(stranger, "philosophy")).rejects.toThrow("communication-space-not-authorized");
    expect(await f.service.listSpaces(stranger)).toEqual([]);
    await expect(f.service.send(tutorA, envelope("no", tutorA, [stranger]))).rejects.toThrow("communication-recipient-not-authorized");
    await expect(f.service.send(observer, envelope("no", observer, [tutorA]))).rejects.toThrow("communication-space-not-authorized");
    await expect(f.service.updateContext(observer, "philosophy", 1, context)).rejects.toThrow("communication-space-not-authorized");
    await f.service.send(tutorA, envelope());
    await expect(f.service.getMessage(observer, "philosophy", "message-1")).rejects.toThrow("communication-message-not-authorized");
    expect((await f.service.readSpace(observer, "philosophy"))).not.toHaveProperty("messages");
    expect((await f.service.mailbox(observer, "philosophy", { direction: "inbox" })).messages).toEqual([]);
    await expect(f.service.transition(tutorA, "philosophy", "message-1", "processing")).rejects.toThrow("communication-delivery-not-authorized");
  });
  it("uses optimistic context/membership revisions and immediately revokes a removed member", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create()); await f.service.send(tutorA, envelope());
    const revised = await f.service.updateContext(codex, "philosophy", 1, { ...context, summary: "Revised" }); expect(revised.revision).toBe(2);
    await expect(f.service.updateContext(tutorB, "philosophy", 1, context)).rejects.toThrow("communication-context-revision-conflict");
    await expect(f.service.send(tutorA, envelope("stale"))).rejects.toThrow("communication-context-revision-conflict");
    // A result is tied to the request's evidence revision even after context advances.
    await f.service.send(tutorB, { ...envelope("result", tutorB, [tutorA]), kind: "result", replyTo: "message-1" });
    const members = create().members.filter(member => member.identity !== tutorB);
    await expect(f.service.updateMembers(codex, "philosophy", 1, members)).rejects.toThrow("communication-space-not-authorized");
    await f.service.updateMembers(tutorA, "philosophy", 1, members);
    await expect(f.service.updateMembers(tutorA, "philosophy", 1, members)).rejects.toThrow("communication-membership-revision-conflict");
    await expect(f.service.mailbox(tutorB, "philosophy", { direction: "inbox" })).rejects.toThrow("communication-space-not-authorized");
    expect((await f.service.readSpace(codex, "philosophy")).contextHistory[0]?.revision).toBe(1);
  });
  it("rejects forged result references, invisible replies and impossible status transitions", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create()); await f.service.send(tutorA, envelope());
    await expect(f.service.send(codex, { ...envelope("bad", codex, [tutorB]), kind: "result", replyTo: "message-1" })).rejects.toThrow("communication-result-reference-invalid");
    await expect(f.service.send(codex, { ...envelope("bad", codex, [tutorA]), kind: "result", replyTo: "missing" })).rejects.toThrow("communication-reply-not-accessible");
    await expect(f.service.transition(tutorB, "philosophy", "message-1", "completed")).rejects.toThrow("communication-delivery-transition-invalid");
    await f.service.transition(tutorB, "philosophy", "message-1", "processing"); await f.service.transition(tutorB, "philosophy", "message-1", "failed", { code: "provider-unavailable", summary: "No paid retry performed" });
    await expect(f.service.transition(tutorB, "philosophy", "message-1", "processing")).rejects.toThrow("communication-delivery-transition-invalid");
    await f.service.transition(tutorB, "philosophy", "message-1", "failed", { code: "provider-unavailable", summary: "No paid retry performed" });
    await expect(f.service.transition(tutorB, "philosophy", "message-1", "failed", { code: "different" })).rejects.toThrow("communication-delivery-replay-mismatch");
  });
  it("keeps public payloads strict, bounded and revisioned, without accepting hidden reasoning fields", async () => {
    expect(communicationEnvelopeSchema.safeParse({ ...envelope(), privateReasoning: "not a public result" }).success).toBe(false);
    expect(communicationEnvelopeSchema.safeParse({ ...envelope(), payload: { text: "answer", credentials: "never" } }).success).toBe(false);
    expect(communicationEnvelopeSchema.safeParse({ ...envelope(), payload: { text: "x".repeat(16_001) } }).success).toBe(false);
    expect(communicationEnvelopeSchema.safeParse({ ...envelope(), recipients: [tutorB, tutorB] }).success).toBe(false);
    expect(communicationEnvelopeSchema.safeParse({ ...envelope(), spaceId: "../private" }).success).toBe(false);
    expect(communicationEnvelopeSchema.safeParse({ ...envelope(), payload: { text: "text", sources: [{ vaultId: "a", path: "a.md" }] } }).success).toBe(false);
    const f = fixture(); await expect(f.service.createSpace(codex, create())).rejects.toThrow("communication-space-owner-required"); expect(f.files.size).toBe(0);
  });
  it("preserves uncertain processing state across restart and never runs a dispatch itself", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create()); await f.service.send(tutorA, envelope()); await f.service.transition(codex, "philosophy", "message-1", "processing");
    const restored = new TutorCommunication(new TutorCommunicationStore(f.io, "private/communication.json"));
    expect((await restored.mailbox(codex, "philosophy", { direction: "inbox", status: "processing" })).messages).toHaveLength(1);
    await restored.transition(codex, "philosophy", "message-1", "failed", { code: "interrupted-outcome-unknown" });
    expect((await restored.mailbox(codex, "philosophy", { direction: "inbox", status: "accepted" })).messages).toHaveLength(0);
  });
  it("retains bounded context history and pages mailbox by stable message IDs", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create());
    for (let index = 0; index < 5; index++) await f.service.send(tutorA, envelope(`m-${index}`));
    const first = await f.service.mailbox(tutorB, "philosophy", { direction: "inbox", limit: 2 });
    const second = await f.service.mailbox(tutorB, "philosophy", { direction: "inbox", limit: 2, before: first.nextBefore });
    expect(first.messages.map(item => item.envelope.messageId)).toEqual(["m-4", "m-3"]); expect(second.messages.map(item => item.envelope.messageId)).toEqual(["m-2", "m-1"]);
    for (let index = 1; index < 20; index++) await f.service.updateContext(tutorA, "philosophy", index, { ...context, summary: String(index) });
    const space = await f.service.readSpace(tutorA, "philosophy"); expect(space.contextHistory).toHaveLength(TUTOR_COMMUNICATION_LIMITS.contextHistory); expect(space.contextHistory[0]?.revision).toBe(4);
  });
  it("exposes the complete public transcript only to an explicit administrator", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create());
    await f.service.send(tutorB, envelope("between-peers", tutorB, [codex]));
    expect((await f.service.mailbox(tutorA, "philosophy", { direction: "inbox" })).messages).toEqual([]);
    await expect(f.service.getMessage(tutorA, "philosophy", "between-peers")).rejects.toThrow("communication-message-not-authorized");
    expect((await f.service.transcript(tutorA, "philosophy")).messages[0]?.envelope.messageId).toBe("between-peers");
    await expect(f.service.transcript(codex, "philosophy")).rejects.toThrow("communication-space-not-authorized");
    await expect(f.service.transcript(observer, "philosophy")).rejects.toThrow("communication-space-not-authorized");
  });
  it("refuses silent history eviction so an old message ID cannot be executed again", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create());
    const snapshot = await f.store.read();
    snapshot.spaces[0]!.messages = Array.from({ length: TUTOR_COMMUNICATION_LIMITS.messagesPerSpace }, (_, index) => ({ envelope: envelope(`retained-${index}`), deliveries: [tutorB, codex].map(recipient => ({ recipient, status: "accepted" as const, updatedAt: 200 })) }));
    f.files.set("private/communication.json", JSON.stringify(snapshot));
    await expect(f.service.send(tutorA, envelope("over-capacity"))).rejects.toThrow("communication-message-capacity");
    expect((await f.service.send(tutorA, envelope("retained-0"))).duplicate).toBe(true);
    expect((await f.service.transcript(tutorA, "philosophy", { limit: 100 })).messages).toHaveLength(100);
  });
  it("fails closed on corrupt state and rejected compare-and-write without claiming an accepted message", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create()); const previous = f.files.get("private/communication.json")!;
    const failing = new TutorCommunication(new TutorCommunicationStore({ ...f.io, compareWrite: async () => { throw Error("private provider info"); } }, "private/communication.json"));
    await expect(failing.send(tutorA, envelope())).rejects.toThrow("communication-store-write-not-confirmed"); expect(f.files.get("private/communication.json")).toBe(previous);
    f.files.set("private/communication.json", "{broken"); await expect(new TutorCommunicationStore(f.io, "private/communication.json").read()).rejects.toThrow("communication-store-corrupt"); expect(f.files.get("private/communication.json")).toBe("{broken");
  });
  it("rejects a competing store update instead of overwriting a durable context", async () => {
    const f = fixture(); await f.service.createSpace(tutorA, create());
    const other = new TutorCommunication(new TutorCommunicationStore(f.io, "private/communication.json"));
    const results = await Promise.allSettled([f.service.updateContext(tutorA, "philosophy", 1, { ...context, summary: "first" }), other.updateContext(codex, "philosophy", 1, { ...context, summary: "second" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const restored = await new TutorCommunicationStore(f.io, "private/communication.json").read();
    expect(restored.spaces[0]?.context.revision).toBe(2);
    expect(["first", "second"]).toContain(restored.spaces[0]?.context.summary);
  });
});
