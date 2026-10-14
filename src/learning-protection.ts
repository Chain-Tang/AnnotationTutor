import { createHash } from "node:crypto";
import { z } from "zod";
import { instantiateQuestion } from "./learning-question-bank-v2-2.js";
import type { ConceptId } from "./learning-episode.js";
import type { EpisodeV3, QuestionRefV3 } from "./learning-v3.js";
import type { LearningIO } from "./learning-record-read.js";

export const LEARNING_PROTECTION_MAX_BYTES = 128 * 1024;
export const protectionReasons = ["help-prepared", "record-recovered", "protection-rebuilt", "legacy-continued", "external-uncertainty"] as const;
export type ProtectionReason = typeof protectionReasons[number];
const uuid = z.string().uuid(), sequence = z.number().int().min(1).max(10000);
const questionProtectionSchema = z.object({
  questionId: uuid, questionDigest: z.string().regex(/^[a-f0-9]{64}$/), contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  blockedFromSequence: sequence.nullable(), reasons: z.array(z.enum(protectionReasons)).max(protectionReasons.length),
}).strict().refine(q => new Set(q.reasons).size === q.reasons.length && q.reasons.join() === [...q.reasons].sort().join() && (q.blockedFromSequence === null ? q.reasons.length === 0 : q.reasons.length > 0));
export const episodeProtectionSchema = z.object({
  format: z.literal("learning-protection"), version: z.literal(1), episodeId: uuid,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), questions: z.array(questionProtectionSchema).max(256),
}).strict().refine(p => new Set(p.questions.map(q => q.questionId)).size === p.questions.length);
export type QuestionProtection = z.infer<typeof questionProtectionSchema>;
export type EpisodeProtectionV1 = z.infer<typeof episodeProtectionSchema>;
export type ProtectionSnapshot = {
  episodeId: string;
  status: "valid" | "missing" | "corrupt" | "unsupported" | "identity-mismatch" | "read-failed";
  revision: string;
  questions: ReadonlyMap<string, QuestionProtection>;
};
export const protectionDigest = (value: string) => createHash("sha256").update(value).digest("hex");
/** Hash only canonical references, never question text or user answers. */
export function questionProtectionDigest(ref: QuestionRefV3): string {
  return protectionDigest(JSON.stringify([ref.id, ref.packVersion, ref.templateId, ref.concept, ref.pool, ref.seed]));
}
/** Retain only a digest of fixed authored content, so equivalent seeds/new UUIDs
 * cannot disguise an orphaned pre-recovery question as a new one. */
export const questionContentDigest = (ref: QuestionRefV3) => protectionDigest(instantiateQuestion(ref.concept, ref.pool, ref.seed).prompt);

// Tokens are identities, not serializable grants. Explicit-ID constructors and
// copies from disk cannot manufacture a token, even if they copy its properties.
declare const newQuestionBrand: unique symbol;
export type HostNewQuestionToken = { readonly [newQuestionBrand]: true };
type TokenState = { digest: string; questionId: string; attemptedEpisode?: string; registrationConfirmed?: boolean; retryAllowed?: boolean };
const questionTokens = new WeakMap<QuestionRefV3, HostNewQuestionToken>();
const tokens = new WeakMap<HostNewQuestionToken, TokenState>();
export function allocateFreshQuestionRef(concept: ConceptId, pool: QuestionRefV3["pool"], seed: number): QuestionRefV3 {
  const q = instantiateQuestion(concept, pool, seed);
  const ref: QuestionRefV3 = { id: crypto.randomUUID(), packVersion: "limits-v3-1", templateId: q.templateId, concept, pool, seed };
  const token = Object.freeze({}) as HostNewQuestionToken;
  tokens.set(token, { digest: questionProtectionDigest(ref), questionId: ref.id }); questionTokens.set(ref, token);
  return ref;
}
export function freshQuestionToken(ref: QuestionRefV3): HostNewQuestionToken | undefined {
  const token = questionTokens.get(ref), state = token && tokens.get(token);
  return state?.digest === questionProtectionDigest(ref) ? token : undefined;
}
/** Preserve a capability through a host's validating clone, only for the identical reference. */
export function carryFreshQuestionCapability(from: QuestionRefV3, to: QuestionRefV3): void {
  const token = freshQuestionToken(from);
  if (token && questionProtectionDigest(from) === questionProtectionDigest(to)) questionTokens.set(to, token);
}

function snapshot(episodeId: string, raw: string | null): ProtectionSnapshot {
  const revision = protectionDigest(raw === null ? "missing" : raw), empty = (status: ProtectionSnapshot["status"]): ProtectionSnapshot => ({ episodeId, status, revision, questions: new Map() });
  if (raw === null) return empty("missing");
  if (raw.length > LEARNING_PROTECTION_MAX_BYTES || Buffer.byteLength(raw) > LEARNING_PROTECTION_MAX_BYTES) return empty("corrupt");
  let input: unknown; try { input = JSON.parse(raw); } catch { return empty("corrupt"); }
  if (input && typeof input === "object" && (("format" in input && input.format !== "learning-protection") || ("version" in input && input.version !== 1))) return empty("unsupported");
  const parsed = episodeProtectionSchema.safeParse(input); if (!parsed.success) return empty("corrupt");
  if (parsed.data.episodeId !== episodeId) return empty("identity-mismatch");
  return { episodeId, status: "valid", revision, questions: new Map(parsed.data.questions.map(q => [q.questionId, q])) };
}
export function questionIndependence(episode: EpisodeV3, questionId: string, eventSequence: number, protection?: ProtectionSnapshot): "no-plugin-help" | "helped" | "unknown" {
  const question = episode.questions.find(q => q.id === questionId);
  if (!question || !Number.isInteger(eventSequence) || eventSequence < 1 || eventSequence > 10000) return "unknown";
  const help = episode.help.filter(h => h.questionId === questionId && h.sequence < eventSequence);
  if (help.some(h => h.state === "presented" && h.kind !== "related-discussion")) return "helped";
  const guard = protection?.questions.get(questionId);
  if (help.length || protection?.status !== "valid" || protection.episodeId !== episode.id || !guard || guard.questionDigest !== questionProtectionDigest(question) || guard.contentDigest !== questionContentDigest(question) || guard.blockedFromSequence !== null && eventSequence >= guard.blockedFromSequence) return "unknown";
  if (episode.evidence.some(e => e.type === "answer" && e.questionId === questionId && e.sequence === eventSequence && e.independence === "unknown")) return "unknown";
  return "no-plugin-help";
}

export type RecoveryProtectionReceipt = { episodeId: string; backupDigest: string; protectionRevision: string; blockedFromSequence: number };
/** Monotonic sidecars have no .previous fallback. Bad/unknown files stay intact. */
export class LearningProtectionStore {
  readonly root: string;
  constructor(readonly io: LearningIO, readonly episodeRoot: string, private validateEpisode: (raw: string, id: string) => EpisodeV3, root?: string) {
    this.root = root ?? (episodeRoot.endsWith("/episodes") ? episodeRoot.slice(0, -9) + "/protection" : episodeRoot + "/protection");
  }
  path(episodeId: string) { uuid.parse(episodeId); return `${this.root}/${episodeId}.json`; }
  episodeIdForPath(path: string): string | undefined {
    if (!path.startsWith(this.root + "/") || !path.endsWith(".json")) return;
    const id = path.slice(this.root.length + 1, -5); return uuid.safeParse(id).success ? id : undefined;
  }
  async read(episodeId: string): Promise<ProtectionSnapshot> {
    const path = this.path(episodeId);
    try { return snapshot(episodeId, await this.io.read(path)); }
    catch { return { episodeId, status: "read-failed", revision: protectionDigest("read-failed"), questions: new Map() }; }
  }
  private async live(episodeId: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Learning context changed", "AbortError");
    if (await this.io.read(`${this.episodeRoot}/${episodeId}.json.deleted`) !== null) throw new Error("learning-v3-deleted");
    if (signal?.aborted) throw new DOMException("Learning context changed", "AbortError");
  }
  private async merge(episodeId: string, update: (questions: Map<string, QuestionProtection>, missing: boolean) => void, signal?: AbortSignal,
    registration?: { confirmed(): void; unchangedFailure(): void }): Promise<ProtectionSnapshot> {
    const path = this.path(episodeId);
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.live(episodeId, signal);
      const raw = await this.io.read(path), old = snapshot(episodeId, raw);
      if (old.status !== "valid" && old.status !== "missing") throw new Error(`learning-protection-${old.status}`);
      const questions = new Map([...old.questions].map(([id, q]) => [id, { ...q, reasons: [...q.reasons] }]));
      update(questions, old.status === "missing");
      const oldRevision = raw === null ? 0 : (JSON.parse(raw) as EpisodeProtectionV1).revision;
      const record = episodeProtectionSchema.parse({ format: "learning-protection", version: 1, episodeId, revision: oldRevision + 1, questions: [...questions.values()].sort((a,b) => a.questionId.localeCompare(b.questionId)) });
      if (raw !== null && JSON.stringify([...old.questions.values()].sort((a,b) => a.questionId.localeCompare(b.questionId))) === JSON.stringify(record.questions)) { await this.live(episodeId, signal); return old; }
      const next = JSON.stringify(record);
      if (Buffer.byteLength(next) > LEARNING_PROTECTION_MAX_BYTES) throw new Error("learning-protection-too-large");
      await this.live(episodeId, signal);
      try { await this.io.compareWrite(path, raw, next); registration?.confirmed(); }
      catch (error) { if (await this.io.read(path) === raw) { registration?.unchangedFailure(); throw error; } continue; }
      await this.live(episodeId, signal); return snapshot(episodeId, next);
    }
    throw new Error("learning-protection-conflict");
  }
  async registerFreshQuestion(input: { episodeId: string; question: QuestionRefV3; token: HostNewQuestionToken }, signal?: AbortSignal): Promise<ProtectionSnapshot> {
    const { episodeId, question, token } = input, state = tokens.get(token), digest = questionProtectionDigest(question), contentDigest = questionContentDigest(question);
    if (!state || state.digest !== digest || state.questionId !== question.id || state.attemptedEpisode && state.attemptedEpisode !== episodeId) throw new Error("learning-protection-fresh-capability-required");
    // Bind before the first await, so concurrent registration cannot move the
    // same host capability to a second episode.
    const retry = state.attemptedEpisode !== undefined; state.attemptedEpisode = episodeId;
    const initial = await this.read(episodeId), existing = initial.questions.get(question.id);
    if (existing) {
      if (existing.questionDigest !== digest || existing.contentDigest !== contentDigest) throw new Error("learning-protection-question-mismatch");
      state.registrationConfirmed = true; state.retryAllowed = false;
      await this.live(episodeId, signal); return initial;
    }
    if (retry && (state.registrationConfirmed || !state.retryAllowed)) throw new Error("learning-protection-fresh-capability-consumed");
    // A surviving in-memory token cannot clean an existing primary/backup ID or
    // rename a previously used authored question into another fresh UUID.
    for (const suffix of ["", ".previous"]) {
      const raw = await this.io.read(`${this.episodeRoot}/${episodeId}.json${suffix}`);
      if (raw === null) continue;
      if (retry) throw new Error("learning-protection-question-is-not-new");
      const known = this.validateEpisode(raw, episodeId);
      if (known.questions.some(q => q.id === question.id || questionContentDigest(q) === questionContentDigest(question))) throw new Error("learning-protection-question-is-not-new");
    }
    state.retryAllowed = false;
    const result = await this.merge(episodeId, questions => {
      const old = questions.get(question.id);
      if (old) { if (old.questionDigest !== digest || old.contentDigest !== contentDigest) throw new Error("learning-protection-question-mismatch"); state.registrationConfirmed = true; return; }
      if ([...questions.values()].some(q => q.contentDigest === contentDigest)) throw new Error("learning-protection-question-is-not-new");
      questions.set(question.id, { questionId: question.id, questionDigest: digest, contentDigest, blockedFromSequence: null, reasons: [] });
    }, signal, { confirmed: () => { state.registrationConfirmed = true; }, unchangedFailure: () => { if (!state.registrationConfirmed) state.retryAllowed = true; } });
    state.registrationConfirmed = true; state.retryAllowed = false; return result;
  }
  async block(input: { episodeId: string; questions: readonly { ref: QuestionRefV3; fromSequence: number }[]; reason: ProtectionReason }, signal?: AbortSignal): Promise<ProtectionSnapshot> {
    z.enum(protectionReasons).parse(input.reason);
    if (input.questions.length > 256) throw new Error("learning-protection-too-many-questions");
    for (const q of input.questions) sequence.parse(q.fromSequence);
    return this.merge(input.episodeId, questions => {
      for (const { ref, fromSequence } of input.questions) {
        const old = questions.get(ref.id), digest = questionProtectionDigest(ref), contentDigest = questionContentDigest(ref);
        if (old && (old.questionDigest !== digest || old.contentDigest !== contentDigest)) throw new Error("learning-protection-question-mismatch");
        questions.set(ref.id, { questionId: ref.id, questionDigest: digest, contentDigest, blockedFromSequence: Math.min(old?.blockedFromSequence ?? Infinity, old ? fromSequence : 1), reasons: [...new Set([...(old?.reasons ?? []), input.reason])].sort() });
      }
    }, signal);
  }
  async beforeEpisodeRecovery(input: { episodeId: string; backup: EpisodeV3 }): Promise<RecoveryProtectionReceipt> {
    const { episodeId, backup } = input;
    if (episodeId !== backup.id) throw new Error("learning-protection-identity-mismatch");
    const resumedSequence = Math.min(10000, Math.max(0, ...backup.evidence.map(e => e.sequence), ...backup.help.map(h => h.sequence)) + 1);
    const result = await this.merge(episodeId, questions => {
      for (const ref of backup.questions) {
        const old = questions.get(ref.id), digest = questionProtectionDigest(ref), contentDigest = questionContentDigest(ref);
        if (old && (old.questionDigest !== digest || old.contentDigest !== contentDigest)) throw new Error("learning-protection-question-mismatch");
        if (!old) questions.set(ref.id, { questionId: ref.id, questionDigest: digest, contentDigest, blockedFromSequence: 1, reasons: ["protection-rebuilt"] });
      }
      for (const [id, old] of questions) questions.set(id, { ...old, blockedFromSequence: Math.min(old.blockedFromSequence ?? Infinity, resumedSequence), reasons: [...new Set([...old.reasons, "record-recovered" as const])].sort() });
    });
    return { episodeId, backupDigest: protectionDigest(JSON.stringify(backup)), protectionRevision: result.revision, blockedFromSequence: resumedSequence };
  }
}
