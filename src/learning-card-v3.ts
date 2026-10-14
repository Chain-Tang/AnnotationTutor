import { LearningCommandsV3, type LearningCommandResult, type LearningInvitationV3 } from "./learning-commands-v3.js";
import { hasLocalLearnerAuthority, type LearningActionV3, type LocalLearnerAuthority } from "./learning-control-v3.js";
import { LearningDialogueV3, type DialogueTurnV3 } from "./learning-dialogue-v3.js";
import { effectiveLearningV3, projectedEvidenceV3, type EffectiveLearningV3 } from "./learning-effective-v3.js";
import type { ConceptId } from "./learning-episode.js";
import type { RecordCompleteness, RecordReadResult } from "./learning-record-read.js";
import { runLearningTurnV3, type LearningRunResultV3 } from "./learning-runner-v3.js";
import type { LegacyLearningRecord } from "./learning-safe-projection.js";
import { renderQuestionV3, type EffectiveV3ReadResult, type EpisodeV3 } from "./learning-v3.js";

/** Created by the local card adapter for one explicit click. The live source
 * and foreign-write lease remain host responsibilities, just as in chat. */
export type LearningCardActionScope = {
  authority: LocalLearnerAuthority; requestId: string; conversationId: string;
  source: EpisodeV3["source"]; signal: AbortSignal;
  ensureCurrent(): Promise<void>;
  /** Return true only after putting this fragment in the visible card. */
  present(delta: string): boolean | void;
  ownCommit?(result: LearningCommandResult): Promise<void> | void;
};
export type LearningCardEntry = {
  key: string; id: string; format: 1 | 2 | 3; concept: ConceptId;
  source: EpisodeV3["source"]; status: string; updatedAt: string;
};
export type LearningCardSelection = {
  kind: "v3"; key: string; episode: EpisodeV3;
  /** Deliberately excludes answer, hint, explanation and diagram. */
  question: { id: string; prompt: string; goal: string; choices?: string[]; pool: EpisodeV3["questions"][number]["pool"] };
  effective: EffectiveLearningV3; evidence: ReturnType<typeof projectedEvidenceV3>;
  protectionRevision?: string;
} | {
  kind: "legacy-readonly"; key: string;
  /** Local history display only. Never feed this raw record to a model. */
  record: LegacyLearningRecord;
};
export type LearningCardSnapshot = {
  entries: LearningCardEntry[]; selected?: LearningCardSelection;
  completeness: RecordCompleteness; busy: boolean;
};
type Options = { readLegacy?(): Promise<RecordReadResult<LegacyLearningRecord>>; minutes?(): number };
type Action = { type: "start"; concept: ConceptId } | { type: "answer"; text: string } |
  { type: "hint" | "solution" | "explanation" | "undo" | "pause" | "resume" | "next" | "forget" } |
  { type: "correct"; evidenceId: string } | { type: "schedule"; days: 1 | 3 | 7 };
type Pending = {
  requestId: string; fingerprint: string; generation: number; controller: AbortController;
  conversationId: string; authority: LocalLearnerAuthority; selected?: LearningCardSelection;
  invitation?: LearningInvitationV3; turn?: DialogueTurnV3; action?: LearningActionV3;
  promise?: Promise<LearningRunResultV3>;
};
const abort = () => new DOMException("Learning card changed", "AbortError");
const keyOf = (record: { format: number; id: string }) => `v${record.format}:${record.id}`;

/** A local-card adapter over the same commands, parser, reducer and presentation
 * gate as natural dialogue. It owns no store and cannot mutate legacy history. */
export class LearningCardV3 {
  readonly dialogue: LearningDialogueV3;
  private read?: EffectiveV3ReadResult;
  private legacy?: RecordReadResult<LegacyLearningRecord>;
  private selectedKey?: string;
  private listeners = new Set<() => void>();
  private generation = 0;
  private loadGeneration = 0;
  private pending?: Pending;
  private disposed = false;
  constructor(readonly commands: LearningCommandsV3, private options: Options = {}) {
    this.dialogue = new LearningDialogueV3(commands, { minutes: options.minutes });
  }
  get snapshot(): LearningCardSnapshot {
    const records = [...(this.read?.records ?? []), ...(this.legacy?.records ?? [])].filter(record => record.status !== "deleted");
    const entries = records.map(record => ({ key: keyOf(record), id: record.id, format: record.format, concept: record.concept,
      source: { ...record.source }, status: record.status, updatedAt: record.updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
    const record = records.find(record => keyOf(record) === this.selectedKey);
    let selected: LearningCardSelection | undefined;
    if (record?.format === 3) {
      const ref = record.questions.find(question => question.id === record.currentQuestionId)!, question = renderQuestionV3(ref);
      const protection = this.read?.protectionByEpisode.get(record.id);
      selected = { kind: "v3", key: keyOf(record), episode: record,
        question: { id: question.id, prompt: question.prompt, goal: question.rubric[0] ?? "", pool: ref.pool, ...(question.choices ? { choices: question.choices } : {}) },
        effective: effectiveLearningV3(record, protection), evidence: projectedEvidenceV3(record, protection), protectionRevision: protection?.revision };
    } else if (record) selected = { kind: "legacy-readonly", key: keyOf(record), record };
    const states = [this.read?.completeness ?? "unavailable", ...(this.options.readLegacy ? [this.legacy?.completeness ?? "unavailable"] : [])];
    const completeness = states.includes("unavailable") ? "unavailable" : states.includes("partial") ? "partial" : "complete";
    return structuredClone({ entries, selected, completeness, busy: !!this.pending?.promise });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot change durable command outcomes. */ } } }
  async load(): Promise<LearningCardSnapshot> {
    const generation = ++this.loadGeneration;
    const [current, legacy] = await Promise.allSettled([
      Promise.resolve().then(() => this.commands.store.readEffectiveResult()),
      Promise.resolve().then(() => this.options.readLegacy?.()),
    ]);
    if (generation !== this.loadGeneration || this.disposed) return this.snapshot;
    this.read = current.status === "fulfilled" ? current.value : undefined;
    this.legacy = legacy.status === "fulfilled" ? legacy.value : undefined;
    // Loading never starts/resumes a record or silently chooses a different one.
    this.emit(); return this.snapshot;
  }
  select(key: string | undefined): void {
    if (key !== undefined && !this.snapshot.entries.some(entry => entry.key === key)) throw new Error("learning-card-selection-unavailable");
    if (key === this.selectedKey) return;
    this.cancel(); this.selectedKey = key; this.emit();
  }
  cancel(): void {
    this.generation++;
    if (this.pending) {
      this.pending.controller.abort();
      if (this.pending.invitation) this.commands.expire(this.pending.invitation);
      this.dialogue.expireConversation(this.pending.conversationId);
    }
    this.pending = undefined;
    this.emit();
  }
  dispose(): void { this.cancel(); this.disposed = true; this.loadGeneration++; this.dialogue.reset(); this.listeners.clear(); }

  start(scope: LearningCardActionScope, concept: ConceptId) { return this.run(scope, { type: "start", concept }); }
  answer(scope: LearningCardActionScope, text: string) { return this.run(scope, { type: "answer", text }); }
  hint(scope: LearningCardActionScope) { return this.run(scope, { type: "hint" }); }
  solution(scope: LearningCardActionScope) { return this.run(scope, { type: "solution" }); }
  explanation(scope: LearningCardActionScope) { return this.run(scope, { type: "explanation" }); }
  undo(scope: LearningCardActionScope) { return this.run(scope, { type: "undo" }); }
  correct(scope: LearningCardActionScope, evidenceId: string) { return this.run(scope, { type: "correct", evidenceId }); }
  pause(scope: LearningCardActionScope) { return this.run(scope, { type: "pause" }); }
  resume(scope: LearningCardActionScope) { return this.run(scope, { type: "resume" }); }
  next(scope: LearningCardActionScope) { return this.run(scope, { type: "next" }); }
  schedule(scope: LearningCardActionScope, days: 1 | 3 | 7) { return this.run(scope, { type: "schedule", days }); }
  forget(scope: LearningCardActionScope) { return this.run(scope, { type: "forget" }); }

  private run(input: LearningCardActionScope, action: Action): Promise<LearningRunResultV3> {
    if (this.disposed) return Promise.reject(new Error("learning-card-disposed"));
    if (!hasLocalLearnerAuthority(input.authority)) return Promise.reject(new Error("learning-local-learner-required"));
    const scope = { ...input, source: { ...input.source } };
    const fingerprint = JSON.stringify([scope.conversationId, scope.source, action]);
    let pending = this.pending;
    if (pending?.requestId === scope.requestId) {
      if (pending.fingerprint !== fingerprint || pending.authority !== scope.authority) return Promise.reject(new Error("learning-card-request-reused"));
      if (pending.promise) return pending.promise;
    } else {
      const selected = this.snapshot.selected;
      if (action.type !== "start" && selected?.kind !== "v3") return Promise.reject(new Error("learning-card-legacy-readonly"));
      this.cancel();
      pending = { requestId: scope.requestId, fingerprint, authority: scope.authority, generation: this.generation,
        controller: new AbortController(), conversationId: scope.conversationId, selected };
      this.pending = pending;
    }
    const captured = pending!;
    const controller = new AbortController(), cancel = () => controller.abort();
    for (const signal of [scope.signal, captured.controller.signal]) {
      if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    }
    const check = async () => {
      if (controller.signal.aborted || captured.generation !== this.generation) throw abort();
      await scope.ensureCurrent();
      if (controller.signal.aborted || captured.generation !== this.generation) throw abort();
    };
    const execute = async (): Promise<LearningRunResultV3> => {
      await check();
      if (action.type === "start") {
        captured.invitation ??= this.commands.offer({ authority: scope.authority, requestId: scope.requestId,
          conversationId: scope.conversationId, source: scope.source, concept: action.concept });
        const saved = await this.commands.accept(captured.invitation, scope, controller.signal);
        // A post-CAS cancellation still delivers the durable acknowledgement.
        await scope.ownCommit?.(saved);
        await check();
        this.selectedKey = keyOf(saved.episode);
        const question = renderQuestionV3(saved.episode.questions.find(q => q.id === saved.episode.currentQuestionId)!);
        const text = question.prompt + (question.choices ? "\n" + question.choices.map((choice, i) => `${String.fromCharCode(65 + i)}. ${choice}`).join("\n") : "");
        scope.present(text);
        return { text, confirmProvided: async () => {} };
      }
      const selection = captured.selected;
      if (selection?.kind !== "v3") throw new Error("learning-card-legacy-readonly");
      if (!captured.turn) {
        const turn = await this.dialogue.prepare({ authority: scope.authority, requestId: scope.requestId, conversationId: scope.conversationId,
          source: scope.source, entry: "legacy-card", kind: "conversation", episodeId: selection.episode.id,
          text: action.type === "answer" ? action.text : "" }, controller.signal);
        // Bind the displayed card, never silently grade against a newer question.
        if (!turn.active || turn.active.revision !== selection.episode.revision || turn.active.currentQuestionId !== selection.question.id) throw new Error("learning-card-stale-selection");
        captured.turn = turn;
      }
      const turn = captured.turn, episode = turn.active!, question = renderQuestionV3(episode.questions.find(q => q.id === episode.currentQuestionId)!);
      if (!captured.action) {
        if (action.type === "undo" || action.type === "correct") {
          const effective = effectiveLearningV3(episode, turn.protection);
          const evidenceId = action.type === "correct" ? action.evidenceId : undefined;
          const evidence = [...effective.answers, ...effective.judgments].sort((a, b) => b.sequence - a.sequence)
            .find(item => action.type === "undo" || item.id === evidenceId);
          if (!evidence) throw new Error("learning-card-evidence-unavailable");
          captured.action = { type: "correct", questionId: evidence.questionId, evidenceId: evidence.id };
        } else if (action.type === "explanation") captured.action = { type: "none" };
        else if (action.type === "schedule") captured.action = { type: "schedule", questionId: question.id, days: action.days };
        else captured.action = { type: action.type, questionId: question.id };
      }
      const envelope = { control: { action: captured.action, replyRelation: action.type === "explanation" ? "current-question" : "unrelated" },
        reply: action.type === "explanation" ? question.explanation : "" };
      return runLearningTurnV3({ dialogue: this.dialogue, turn, signal: controller.signal,
        transport: async () => ({ text: JSON.stringify(envelope) }), present: scope.present, ensureCurrent: check,
        ownCommit: scope.ownCommit, minutes: this.options.minutes?.() });
    };
    captured.promise = execute().finally(async () => {
      scope.signal.removeEventListener("abort", cancel); captured.controller.signal.removeEventListener("abort", cancel);
      captured.promise = undefined;
      if (this.pending === captured) await this.load();
    });
    this.emit(); return captured.promise;
  }
}
