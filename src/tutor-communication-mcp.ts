import { z } from "zod";
import type { TutorClientGrant } from "./tutor-mcp.js";
import {
  communicationContextInputSchema, communicationContextSchema, communicationCreateSpaceSchema,
  communicationEnvelopeSchema, communicationIdentityKey, communicationIdentitySchema,
  communicationMailboxQuerySchema, communicationStatusSchema, communicationTransitionDetailSchema,
  type CommunicationIdentity,
} from "./tutor-communication.js";

/** The host resolves the authenticated grant. Arguments never supply a sender. */
export interface TutorCommunicationGateway {
  identity(grant: TutorClientGrant): Promise<{ host: CommunicationIdentity; caller: CommunicationIdentity }>;
  invoke(grant: TutorClientGrant, operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export type CommunicationToolRegistrar = <I extends z.ZodRawShape, O extends z.ZodRawShape>(
  name: string, description: string, input: I, output: O, readOnly: boolean,
  run: (input: z.infer<z.ZodObject<I>>, signal: AbortSignal) => Promise<z.infer<z.ZodObject<O>>>,
) => void;

const spaceId = communicationCreateSpaceSchema.shape.spaceId;
const messageId = communicationEnvelopeSchema.shape.messageId;
export const communicationSendInputSchema = z.object({
  spaceId, messageId: messageId.optional(), recipients: communicationEnvelopeSchema.shape.recipients,
  kind: communicationEnvelopeSchema.shape.kind, replyTo: messageId.optional(),
  text: communicationEnvelopeSchema.shape.payload.shape.text,
  contextRevision: communicationContextSchema.shape.revision.optional(),
}).strict().superRefine((input, context) => {
  if (input.kind === "result" && !input.replyTo) context.addIssue({ code: "custom", message: "communication-result-needs-reply" });
  if (new Set(input.recipients.map(communicationIdentityKey)).size !== input.recipients.length) context.addIssue({ code: "custom", message: "communication-duplicate-recipient" });
});
const readInputSchema = z.object({ spaceId }).strict();
const updateInputSchema = z.object({ spaceId, expectedRevision: communicationContextSchema.shape.revision, context: communicationContextInputSchema }).strict();
const mailboxInputSchema = communicationMailboxQuerySchema.extend({ spaceId }).strict();
const transitionInputSchema = z.object({ spaceId, messageId, status: communicationStatusSchema, detail: communicationTransitionDetailSchema.optional() }).strict();

function requireCommunication(grant: TutorClientGrant, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (grant.communication !== true || !communicationIdentitySchema.safeParse(grant.communicationIdentity).success) throw new Error("communication-not-granted");
}

/** Uses the parent service's revocation, cancellation and output-size envelope. */
export function registerTutorCommunicationTools(register: CommunicationToolRegistrar, grant: TutorClientGrant, gateway: TutorCommunicationGateway): void {
  register("tutor_communication_identity", "Read this host and the communication identity bound to your pairing. An agent message does not grant new human authorization.", {}, { host: communicationIdentitySchema, caller: communicationIdentitySchema }, true, async (_input, signal) => {
    requireCommunication(grant, signal);
    const identities = z.object({ host: communicationIdentitySchema, caller: communicationIdentitySchema }).strict().parse(await gateway.identity(grant));
    requireCommunication(grant, signal);
    if (communicationIdentityKey(identities.caller) !== communicationIdentityKey(grant.communicationIdentity!)) throw new Error("communication-identity-mismatch");
    return identities;
  });
  const operation = <I extends z.ZodRawShape>(name: string, description: string, schema: z.ZodObject<I>, readOnly: boolean, method: string) => {
    register(name, description, schema.shape, { value: z.unknown() }, readOnly, async (input, signal) => {
      requireCommunication(grant, signal);
      const args = schema.parse(input) as Record<string, unknown>;
      const value = await gateway.invoke(grant, method, args, signal);
      requireCommunication(grant, signal);
      return { value };
    });
  };
  operation("tutor_communication_spaces", "List only collaboration spaces this paired identity can read. Pairing does not join spaces automatically.", z.object({}).strict(), true, "spaces");
  operation("tutor_communication_create_space", "Create an explicit collaboration space with named members and publicly shared context. Existing vault permissions are unchanged.", communicationCreateSpaceSchema, false, "create_space");
  operation("tutor_communication_read_space", "Read the goal, shared background, source versions and revision of one authorized space.", readInputSchema, true, "read_space");
  operation("tutor_communication_update_context", "Replace explicit shared context using its expected revision; stale updates fail without overwriting newer context.", updateInputSchema, false, "update_context");
  operation("tutor_communication_send", "Persist an agent-authored request, result or update to explicit recipients. Sender comes from pairing; accepted delivery does not mean the recipient has completed it. Reuse messageId only for the identical message.", communicationSendInputSchema, false, "send");
  operation("tutor_communication_mailbox", "Read a bounded inbox or outbox page for the paired identity in one authorized space.", mailboxInputSchema, true, "mailbox");
  operation("tutor_communication_transition", "Acknowledge your own delivery as processing, completed or failed. Only the recipient can advance its delivery status.", transitionInputSchema, false, "transition");
}
