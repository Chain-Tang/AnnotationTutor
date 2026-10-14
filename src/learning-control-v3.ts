import { z } from "zod";
import { TeachingControlSchemaError } from "./learning-stream-v3.js";
import { conceptIds } from "./learning-episode.js";
import { conceptCriterion, criterionIds, type EpisodeV3 } from "./learning-v3.js";
import { immediateSupportActionSchema, supportBoundaryActionSchema, memoryClarificationActionSchema, capabilityInfoActionSchema, supportPresentationSchema } from "./support-response.js";

const uuid = z.string().uuid();
const question = { questionId: uuid };
/** A model can propose a bounded action. It cannot supply a learner identity,
 * source, timestamp, answer value, or arbitrary text to the evidence writer. */
export const learningActionV3Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  immediateSupportActionSchema,supportBoundaryActionSchema,memoryClarificationActionSchema,capabilityInfoActionSchema,
  z.object({ type: z.literal("invite"), concept: z.enum(conceptIds) }).strict(),
  // Conceptual prose may precede an invitation, but is never a saved attempt.
  z.object({ type: z.literal("explain-and-invite"), concept: z.enum(conceptIds) }).strict(),
  z.object({ type: z.literal("accept"), invitationId: uuid }).strict(),
  z.object({ type: z.literal("decline"), invitationId: uuid }).strict(),
  z.object({ type: z.literal("resume-legacy"), episodeId: uuid }).strict(),
  z.object({ type: z.literal("invite-from-legacy"), episodeId: uuid }).strict(),
  z.object({ type: z.enum(["hint", "solution", "pause", "resume", "next", "forget"]), ...question }).strict(),
  z.object({ type: z.literal("answer"), ...question,
    span: z.object({ from: z.number().int().min(0).max(24000), to: z.number().int().min(1).max(24000) }).strict().optional() }).strict(),
  z.object({ type: z.literal("explain"), ...question,
    criteria: z.array(z.object({ id: z.enum(criterionIds), state: z.enum(["supported", "needs-review", "uncertain"]) }).strict()).min(1).max(6) }).strict(),
  z.object({ type: z.literal("correct"), ...question, evidenceId: uuid }).strict(),
  z.object({ type: z.literal("expert"), ...question, kind: z.enum(["explanation", "diagram", "research"]) }).strict(),
  z.object({ type: z.literal("schedule"), ...question, days: z.union([z.literal(1), z.literal(3), z.literal(7)]) }).strict(),
]);
export const learningControlV3Schema = z.object({
  action: learningActionV3Schema,
  replyRelation: z.enum(["unrelated", "current-question", "uncertain"]),
  support: supportPresentationSchema.optional(),
}).strict().superRefine((control,ctx)=>{
  // Support cannot replace grading/help/consent or conceal another operation.
  // The existing pause action still owns the exact target and commit guards.
  if(control.support&&control.action.type!=="none"&&control.action.type!=="pause")
    ctx.addIssue({code:"custom",path:["support"],message:"support-operation-conflict"});
});
/** Reduce validator issues to a finite code; no model values, raw issue
 * messages, arbitrary property names or learner text enter diagnostics. */
export function parseLearningControlV3(value:unknown,state?:{canInvite:boolean}):LearningControlV3 {
  const result=learningControlV3Schema.safeParse(value);
  if(result.success){
    // This pure check cannot authorize or transform an action. It only rejects
    // an invitation that the captured host state explicitly disallows, before
    // prose is displayed or consent state is changed.
    if((result.data.action.type==='invite'||result.data.action.type==='explain-and-invite')&&state?.canInvite===false)throw new TeachingControlSchemaError('invitation-unavailable');
    return result.data;
  }
  const paths=result.error.issues.map(issue=>issue.path.join("."));
  const reason=paths.includes("action.questionId")?"question-id":paths.includes("action.invitationId")?"invitation-id":
    paths.includes("action.evidenceId")?"evidence-id":paths.includes("replyRelation")?"reply-relation":
    paths.includes("action.type")?"action":"shape";
  throw new TeachingControlSchemaError(reason);
}
export type LearningControlV3 = z.infer<typeof learningControlV3Schema>;
export type LearningActionV3 = LearningControlV3["action"];

declare const localLearner: unique symbol;
export type LocalLearnerAuthority = { readonly [localLearner]: true };
const authorities = new WeakSet<object>();
/** Called only by local UI adapters; an external JSON request cannot recreate
 * this in-memory capability by claiming clientId=obsidian. */
export function localLearnerAuthority(): LocalLearnerAuthority {
  const authority = Object.freeze({}) as LocalLearnerAuthority;
  authorities.add(authority);
  return authority;
}
export function hasLocalLearnerAuthority(value: unknown): value is LocalLearnerAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}
export type LearningTurnIdentity = {
  entry: "sidebar" | "annotation" | "board" | "legacy-card" | "external";
  kind: "conversation" | "document-edit" | "drawing" | "expert";
  authority?: LocalLearnerAuthority;
};
export function permitsLearningControl(input: LearningTurnIdentity): boolean {
  return input.entry !== "external" && input.kind === "conversation" && hasLocalLearnerAuthority(input.authority);
}

/** Current-question actions have one exact host binding. A correction instead
 * binds the original evidence's question, which need not still be current. */
export function validateLearningBinding(control: LearningControlV3, episode?: EpisodeV3): void {
  const action = control.action;
  if (!("questionId" in action)) return;
  if (!episode || episode.status === "deleted") throw new Error("learning-action-target-unavailable");
  if (action.type === "correct") {
    const evidence = episode.evidence.find(item => item.id === action.evidenceId);
    if (!evidence || evidence.questionId !== action.questionId) throw new Error("learning-action-evidence-mismatch");
    if(evidence.type==="correction"||episode.evidence.some(item=>item.type==="correction"&&item.corrects===evidence.id))throw new Error("learning-action-evidence-unavailable");
  } else if (action.questionId !== episode.currentQuestionId) throw new Error("learning-action-question-mismatch");
  if (action.type === "explain" && (new Set(action.criteria.map(item => item.id)).size !== action.criteria.length ||
    action.criteria.some(item => item.id !== conceptCriterion[episode.concept]))) throw new Error("learning-action-criterion-mismatch");
  if (action.type === "answer" && action.span && action.span.to <= action.span.from) throw new Error("learning-action-span-invalid");
}
