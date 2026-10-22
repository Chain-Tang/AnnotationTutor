import { z } from "zod";

/** Public collaboration state only. Text is explicitly supplied by a participant;
 * this service never reads a vault, credentials, transcripts or model reasoning. */
export const TUTOR_COMMUNICATION_LIMITS = Object.freeze({
  spaces: 32, members: 32, recipients: 16, messagesPerSpace: 256,
  contextHistory: 16, sourceRefs: 32, messageBytes: 64 * 1024, storeBytes: 8 * 1024 * 1024,
});
const identifier = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
/** Also safe as the host's per-space Markdown directory name. Human-readable
 * names belong in title, not in this stable routing identifier. */
export const communicationSpaceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const communicationIdentitySchema = z.object({
  agentId: identifier, vaultId: identifier, kind: z.enum(["tutor", "codex", "human"]),
}).strict();
export type CommunicationIdentity = z.infer<typeof communicationIdentitySchema>;
export const communicationSourceSchema = z.object({
  vaultId: identifier, path: z.string().min(1).max(1000), revision: identifier,
}).strict();
export type CommunicationSource = z.infer<typeof communicationSourceSchema>;
export const communicationContextInputSchema = z.object({
  goal: z.string().max(4000), background: z.string().max(8000), summary: z.string().max(8000),
  sources: z.array(communicationSourceSchema).max(TUTOR_COMMUNICATION_LIMITS.sourceRefs),
}).strict();
export type CommunicationContextInput = z.infer<typeof communicationContextInputSchema>;
export const communicationContextSchema = communicationContextInputSchema.extend({
  revision, updatedAt: time, updatedBy: communicationIdentitySchema,
}).strict();
export type CommunicationContext = z.infer<typeof communicationContextSchema>;
export const communicationMemberSchema = z.object({
  identity: communicationIdentitySchema, read: z.boolean(), write: z.boolean(), admin: z.boolean().optional(),
}).strict().refine(member => (!member.write || member.read) && (!member.admin || (member.read && member.write)), { message: "communication-invalid-permissions" });
export type CommunicationMember = z.infer<typeof communicationMemberSchema>;
export const communicationPayloadSchema = z.object({
  text: z.string().min(1).max(16_000), goal: z.string().max(4000).optional(),
  background: z.string().max(8000).optional(), summary: z.string().max(8000).optional(),
  sources: z.array(communicationSourceSchema).max(TUTOR_COMMUNICATION_LIMITS.sourceRefs).optional(),
}).strict();
export const communicationEnvelopeSchema = z.object({
  version: z.literal(1), spaceId: communicationSpaceIdSchema, messageId: identifier,
  sender: communicationIdentitySchema,
  recipients: z.array(communicationIdentitySchema).min(1).max(TUTOR_COMMUNICATION_LIMITS.recipients),
  kind: z.enum(["request", "result", "update"]), replyTo: identifier.optional(),
  contextRevision: revision, payload: communicationPayloadSchema, createdAt: time,
}).strict().superRefine((message, ctx) => {
  if (message.kind === "result" && !message.replyTo) ctx.addIssue({ code: "custom", message: "communication-result-needs-reply" });
  if (new Set(message.recipients.map(communicationIdentityKey)).size !== message.recipients.length) ctx.addIssue({ code: "custom", message: "communication-duplicate-recipient" });
  if (communicationBytes(message) > TUTOR_COMMUNICATION_LIMITS.messageBytes) ctx.addIssue({ code: "custom", message: "communication-message-too-large" });
});
export type CommunicationEnvelope = z.infer<typeof communicationEnvelopeSchema>;
export const communicationStatusSchema = z.enum(["accepted", "processing", "completed", "failed"]);
export type CommunicationStatus = z.infer<typeof communicationStatusSchema>;
export const communicationDeliverySchema = z.object({
  recipient: communicationIdentitySchema, status: communicationStatusSchema, updatedAt: time,
  summary: z.string().max(4000).optional(), code: identifier.optional(),
}).strict();
export type CommunicationDelivery = z.infer<typeof communicationDeliverySchema>;
export const communicationMessageSchema = z.object({
  envelope: communicationEnvelopeSchema,
  deliveries: z.array(communicationDeliverySchema).min(1).max(TUTOR_COMMUNICATION_LIMITS.recipients),
}).strict();
export type CommunicationMessage = z.infer<typeof communicationMessageSchema>;
export const communicationSpaceSchema = z.object({
  spaceId: communicationSpaceIdSchema, title: z.string().min(1).max(300), createdAt: time, updatedAt: time,
  membershipRevision: revision,
  members: z.array(communicationMemberSchema).min(1).max(TUTOR_COMMUNICATION_LIMITS.members),
  context: communicationContextSchema,
  contextHistory: z.array(communicationContextSchema).max(TUTOR_COMMUNICATION_LIMITS.contextHistory),
  messages: z.array(communicationMessageSchema).max(TUTOR_COMMUNICATION_LIMITS.messagesPerSpace),
}).strict();
export type CommunicationSpace = z.infer<typeof communicationSpaceSchema>;
export type CommunicationSpaceView = Omit<CommunicationSpace, "messages">;
export const communicationSnapshotSchema = z.object({
  format: z.literal("tutor-communication-v1"), revision,
  spaces: z.array(communicationSpaceSchema).max(TUTOR_COMMUNICATION_LIMITS.spaces),
}).strict();
export type CommunicationSnapshot = z.infer<typeof communicationSnapshotSchema>;
export const communicationCreateSpaceSchema = z.object({
  spaceId: communicationSpaceIdSchema, title: z.string().min(1).max(300),
  members: z.array(communicationMemberSchema).min(1).max(TUTOR_COMMUNICATION_LIMITS.members),
  context: communicationContextInputSchema,
}).strict();
export type CommunicationCreateSpace = z.infer<typeof communicationCreateSpaceSchema>;
export const communicationMailboxQuerySchema = z.object({
  direction: z.enum(["inbox", "outbox"]), status: communicationStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(), before: identifier.optional(),
}).strict();
export type CommunicationMailboxQuery = z.infer<typeof communicationMailboxQuerySchema>;
export type CommunicationMailboxPage = { messages: CommunicationMessage[]; nextBefore?: string };
export const communicationTranscriptQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(), before: identifier.optional(),
}).strict();
export type CommunicationTranscriptQuery = z.infer<typeof communicationTranscriptQuerySchema>;
export type CommunicationTranscriptPage = CommunicationMailboxPage;
export const communicationTransitionDetailSchema = z.object({ summary: z.string().max(4000).optional(), code: identifier.optional() }).strict();
export type CommunicationTransitionDetail = z.infer<typeof communicationTransitionDetailSchema>;

const communicationFailures = {
  "model-selection-unconfirmed": "未能确认当前模型；请检查 Tutor 的模型配置。不会自动重发请求。",
  "mode-selection-unconfirmed": "未能确认当前运行模式；请检查 Tutor 的模式配置。不会自动重发请求。",
  "provider-access-401": "模型服务认证未通过（401）；请检查提供商凭据。不会自动重发请求。",
  "provider-access-403": "模型服务拒绝访问（403）；请检查账户和模型权限。不会自动重发请求。",
  "provider-access": "模型服务访问未获授权；请检查提供商凭据和账户权限。不会自动重发请求。",
  "provider-rate-limit-429": "模型服务触发限流（429）；请稍后手动发起新请求。不会自动重发请求。",
  "provider-error": "模型服务返回错误；请检查提供商状态。不会自动重发请求。",
  "tutor-empty-output": "Tutor 未返回有效文本；不会自动重发可能已执行的模型请求。",
  "session-closed": "Tutor 运行会话已关闭；不会自动重发可能已执行的模型请求。",
  "agent-command-not-found": "未找到 Tutor 的代理程序；请检查本机命令配置。不会自动重发请求。",
  "cancelled": "请求已取消；不会自动重发可能已执行的模型请求。",
  "reply-not-confirmed": "回复未确认。已保留原消息；不会自动重发可能已执行的模型请求。",
} as const;
/** Only fixed diagnostic codes and text may enter public receipts. Never copy
 * an exception's message, provider response, configuration or command path. */
export function communicationFailureDetail(error:unknown,cancelled=false):Required<CommunicationTransitionDetail> {
  let code:keyof typeof communicationFailures="reply-not-confirmed";
  if(cancelled)code="cancelled";
  else {
    const message=error instanceof Error?error.message:typeof error==="string"?error:"";
    const known=message.match(/^(model-selection-unconfirmed|mode-selection-unconfirmed|provider-access-401|provider-access-403|provider-access|provider-rate-limit-429|provider-error|tutor-empty-output|session-closed)(?=$|[:\s])/u)?.[1];
    if(known)code=known as keyof typeof communicationFailures;
    else if((error!==null&&typeof error==="object"&&"code" in error&&error.code==="ENOENT")||/^ENOENT(?=$|[:\s])/u.test(message))code="agent-command-not-found";
  }
  return {code,summary:communicationFailures[code]};
}

export function communicationIdentityKey(identity: CommunicationIdentity): string { return JSON.stringify([identity.kind, identity.vaultId, identity.agentId]); }
export function communicationBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
/** A bounded public excerpt must not be presented as a complete model answer. */
export function boundedCommunicationReply(text:string):string {
  if(text.length<=16000)return text;
  const marker="\n\n[回复已截断至 16000 字符以内；请索取后续内容。]";
  let excerpt=text.slice(0,16000-marker.length);
  if(/[\uD800-\uDBFF]$/.test(excerpt))excerpt=excerpt.slice(0,-1);
  return excerpt+marker;
}
export function emptyCommunicationSnapshot(): CommunicationSnapshot { return { format: "tutor-communication-v1", revision: 0, spaces: [] }; }
const sameIdentity = (a: CommunicationIdentity, b: CommunicationIdentity) => communicationIdentityKey(a) === communicationIdentityKey(b);

/** Validate persisted cross references as well as JSON shape. Invalid state is
 * preserved by the store and fails closed; it is never silently reset. */
export function validateCommunicationSnapshot(value: unknown): CommunicationSnapshot {
  const snapshot = communicationSnapshotSchema.parse(value), ids = new Set<string>();
  if (new Set(snapshot.spaces.map(space => space.spaceId)).size !== snapshot.spaces.length) throw new Error("communication-duplicate-space");
  for (const space of snapshot.spaces) {
    validateMembers(space.members);
    if (space.context.revision < 1 || space.membershipRevision < 1) throw new Error("communication-invalid-revision");
    const history = [...space.contextHistory, space.context];
    if (history.some((item, index) => index > 0 && item.revision !== history[index - 1]!.revision + 1)) throw new Error("communication-context-history-invalid");
    const earlier = new Map<string, CommunicationEnvelope>();
    for (const message of space.messages) {
      const envelope = message.envelope;
      if (ids.has(envelope.messageId) || envelope.spaceId !== space.spaceId || envelope.contextRevision < 1 || envelope.contextRevision > space.context.revision) throw new Error("communication-message-reference-invalid");
      ids.add(envelope.messageId);
      const recipients = new Set(envelope.recipients.map(communicationIdentityKey));
      if (recipients.has(communicationIdentityKey(envelope.sender)) || new Set(message.deliveries.map(delivery => communicationIdentityKey(delivery.recipient))).size !== message.deliveries.length || message.deliveries.length !== recipients.size || message.deliveries.some(delivery => !recipients.has(communicationIdentityKey(delivery.recipient)))) throw new Error("communication-delivery-reference-invalid");
      if (envelope.replyTo) validateReply(envelope, earlier.get(envelope.replyTo));
      earlier.set(envelope.messageId, envelope);
    }
  }
  if (communicationBytes(snapshot) > TUTOR_COMMUNICATION_LIMITS.storeBytes) throw new Error("communication-store-too-large");
  return snapshot;
}
function validateMembers(members: CommunicationMember[]): void {
  if (new Set(members.map(member => communicationIdentityKey(member.identity))).size !== members.length || !members.some(member => member.admin)) throw new Error("communication-members-invalid");
}
function validateReply(message: CommunicationEnvelope, earlier?: CommunicationEnvelope): void {
  if (!earlier || !earlier.recipients.some(recipient => sameIdentity(recipient, message.sender)) && !sameIdentity(earlier.sender, message.sender)) throw new Error("communication-reply-not-accessible");
  if (message.kind === "result" && (!earlier.recipients.some(recipient => sameIdentity(recipient, message.sender)) || !message.recipients.some(recipient => sameIdentity(recipient, earlier.sender)) || message.contextRevision !== earlier.contextRevision)) throw new Error("communication-result-reference-invalid");
}

/** Store mutations run under serialized compare-and-write. The caller identity
 * must come from the authenticated host/grant, never from envelope.sender. */
export interface CommunicationPersistence {
  read(): Promise<CommunicationSnapshot>;
  transact<T>(change: (snapshot: CommunicationSnapshot) => T): Promise<T>;
}
export class TutorCommunication {
  constructor(private readonly store: CommunicationPersistence, private readonly options: { now?: () => number } = {}) {}
  private now(): number { return time.parse((this.options.now ?? Date.now)()); }
  private authorized(snapshot: CommunicationSnapshot, callerInput: CommunicationIdentity, spaceId: string, permission: "read" | "write" | "admin" = "read"): CommunicationSpace {
    const caller = communicationIdentitySchema.parse(callerInput), space = snapshot.spaces.find(item => item.spaceId === spaceId);
    if (!space || !space.members.some(member => sameIdentity(member.identity, caller) && member[permission])) throw new Error("communication-space-not-authorized");
    return space;
  }
  private view(space: CommunicationSpace): CommunicationSpaceView { const { messages: _messages, ...view } = space; return structuredClone(view); }
  async createSpace(callerInput: CommunicationIdentity, input: CommunicationCreateSpace): Promise<CommunicationSpaceView> {
    const caller = communicationIdentitySchema.parse(callerInput), checked = communicationCreateSpaceSchema.parse(input);
    validateMembers(checked.members);
    if (!checked.members.some(member => sameIdentity(member.identity, caller) && member.admin)) throw new Error("communication-space-owner-required");
    return this.store.transact(snapshot => {
      if (snapshot.spaces.some(space => space.spaceId === checked.spaceId)) throw new Error("communication-space-exists");
      if (snapshot.spaces.length >= TUTOR_COMMUNICATION_LIMITS.spaces) throw new Error("communication-space-capacity");
      const now = this.now(), space: CommunicationSpace = { ...structuredClone(checked), createdAt: now, updatedAt: now, membershipRevision: 1, context: { ...structuredClone(checked.context), revision: 1, updatedAt: now, updatedBy: caller }, contextHistory: [], messages: [] };
      snapshot.spaces.push(space); return this.view(space);
    });
  }
  async listSpaces(callerInput: CommunicationIdentity): Promise<CommunicationSpaceView[]> {
    const caller = communicationIdentitySchema.parse(callerInput), snapshot = await this.store.read();
    return snapshot.spaces.filter(space => space.members.some(member => sameIdentity(member.identity, caller) && member.read)).map(space => this.view(space));
  }
  async readSpace(caller: CommunicationIdentity, spaceId: string): Promise<CommunicationSpaceView> { return this.view(this.authorized(await this.store.read(), caller, spaceId)); }
  async updateContext(caller: CommunicationIdentity, spaceId: string, expectedRevision: number, input: CommunicationContextInput): Promise<CommunicationContext> {
    const checked = communicationContextInputSchema.parse(input); revision.parse(expectedRevision);
    return this.store.transact(snapshot => {
      const space = this.authorized(snapshot, caller, spaceId, "write");
      if (space.context.revision !== expectedRevision) throw new Error("communication-context-revision-conflict");
      const now = this.now(); space.contextHistory.push(space.context);
      space.contextHistory = space.contextHistory.slice(-TUTOR_COMMUNICATION_LIMITS.contextHistory);
      space.context = { ...structuredClone(checked), revision: expectedRevision + 1, updatedAt: now, updatedBy: communicationIdentitySchema.parse(caller) };
      space.updatedAt = now; return structuredClone(space.context);
    });
  }
  async updateMembers(caller: CommunicationIdentity, spaceId: string, expectedRevision: number, input: CommunicationMember[]): Promise<CommunicationSpaceView> {
    const members = z.array(communicationMemberSchema).min(1).max(TUTOR_COMMUNICATION_LIMITS.members).parse(input); validateMembers(members); revision.parse(expectedRevision);
    return this.store.transact(snapshot => {
      const space = this.authorized(snapshot, caller, spaceId, "admin");
      if (space.membershipRevision !== expectedRevision) throw new Error("communication-membership-revision-conflict");
      space.members = structuredClone(members); space.membershipRevision++; space.updatedAt = this.now(); return this.view(space);
    });
  }
  async send(caller: CommunicationIdentity, input: CommunicationEnvelope): Promise<{ message: CommunicationMessage; duplicate: boolean }> {
    const envelope = communicationEnvelopeSchema.parse(input);
    if (!sameIdentity(communicationIdentitySchema.parse(caller), envelope.sender)) throw new Error("communication-sender-mismatch");
    return this.store.transact(snapshot => {
      const space = this.authorized(snapshot, caller, envelope.spaceId, "write");
      const existing = snapshot.spaces.flatMap(item => item.messages).find(item => item.envelope.messageId === envelope.messageId);
      if (existing) {
        if (JSON.stringify(existing.envelope) !== JSON.stringify(envelope)) throw new Error("communication-message-id-reused");
        return { message: structuredClone(existing), duplicate: true };
      }
      if (space.messages.length >= TUTOR_COMMUNICATION_LIMITS.messagesPerSpace) throw new Error("communication-message-capacity");
      if (envelope.recipients.some(recipient => sameIdentity(recipient, envelope.sender) || !space.members.some(member => sameIdentity(member.identity, recipient) && member.read))) throw new Error("communication-recipient-not-authorized");
      if (envelope.replyTo) validateReply(envelope, space.messages.find(item => item.envelope.messageId === envelope.replyTo)?.envelope);
      if (envelope.kind !== "result" && envelope.contextRevision !== space.context.revision) throw new Error("communication-context-revision-conflict");
      const now = this.now(), message: CommunicationMessage = { envelope: structuredClone(envelope), deliveries: envelope.recipients.map(recipient => ({ recipient: structuredClone(recipient), status: "accepted", updatedAt: now })) };
      space.messages.push(message); space.updatedAt = now; return { message: structuredClone(message), duplicate: false };
    });
  }
  async mailbox(callerInput: CommunicationIdentity, spaceId: string, input: CommunicationMailboxQuery): Promise<CommunicationMailboxPage> {
    const caller = communicationIdentitySchema.parse(callerInput), query = communicationMailboxQuerySchema.parse(input), space = this.authorized(await this.store.read(), caller, spaceId);
    const scoped = [...space.messages].reverse().filter(message => query.direction === "outbox" ? sameIdentity(message.envelope.sender, caller) && (!query.status || message.deliveries.some(delivery => delivery.status === query.status)) : message.deliveries.some(delivery => sameIdentity(delivery.recipient, caller) && (!query.status || delivery.status === query.status)));
    return this.page(scoped, query);
  }
  /** Explicit space administrators can rebuild the public conversation record.
   * Ordinary read membership never grants access to others' envelopes. */
  async transcript(caller: CommunicationIdentity, spaceId: string, input: CommunicationTranscriptQuery = {}): Promise<CommunicationTranscriptPage> {
    const query = communicationTranscriptQuerySchema.parse(input), space = this.authorized(await this.store.read(), caller, spaceId, "admin");
    return this.page([...space.messages].reverse(), query);
  }
  private page(scoped: CommunicationMessage[], query: CommunicationTranscriptQuery): CommunicationMailboxPage {
    const beforeIndex = query.before ? scoped.findIndex(message => message.envelope.messageId === query.before) : -1;
    if (query.before && beforeIndex < 0) throw new Error("communication-cursor-not-found");
    const remaining = scoped.slice(beforeIndex + 1), messages = remaining.slice(0, query.limit ?? 40);
    return { messages: structuredClone(messages), ...(remaining.length > messages.length ? { nextBefore: messages.at(-1)!.envelope.messageId } : {}) };
  }
  async getMessage(caller: CommunicationIdentity, spaceId: string, messageId: string): Promise<CommunicationMessage> {
    const space = this.authorized(await this.store.read(), caller, spaceId), message = this.ownedMessage(space, caller, messageId); return structuredClone(message);
  }
  private ownedMessage(space: CommunicationSpace, caller: CommunicationIdentity, messageId: string): CommunicationMessage {
    const message = space.messages.find(item => item.envelope.messageId === messageId);
    if (!message || !sameIdentity(message.envelope.sender, caller) && !message.envelope.recipients.some(recipient => sameIdentity(recipient, caller))) throw new Error("communication-message-not-authorized");
    return message;
  }
  async transition(caller: CommunicationIdentity, spaceId: string, messageId: string, nextInput: CommunicationStatus, detailInput: CommunicationTransitionDetail = {}): Promise<CommunicationMessage> {
    const next = communicationStatusSchema.parse(nextInput), detail = communicationTransitionDetailSchema.parse(detailInput);
    return this.store.transact(snapshot => {
      const space = this.authorized(snapshot, caller, spaceId, "write"), message = this.ownedMessage(space, caller, messageId), delivery = message.deliveries.find(item => sameIdentity(item.recipient, caller));
      if (!delivery) throw new Error("communication-delivery-not-authorized");
      if (delivery.status === next) {
        if (delivery.summary !== detail.summary || delivery.code !== detail.code) throw new Error("communication-delivery-replay-mismatch");
        return structuredClone(message);
      }
      if (!(delivery.status === "accepted" && (next === "processing" || next === "failed") || delivery.status === "processing" && (next === "completed" || next === "failed"))) throw new Error("communication-delivery-transition-invalid");
      const now = this.now(); Object.assign(delivery, { status: next, updatedAt: now });
      delete delivery.summary; delete delivery.code;
      if (detail.summary !== undefined) delivery.summary = detail.summary;
      if (detail.code !== undefined) delivery.code = detail.code;
      space.updatedAt = now; return structuredClone(message);
    });
  }
}
