import { questionIndependence, type ProtectionSnapshot } from "./learning-protection.js";
import { renderQuestionV3, type EpisodeV3, type EvidenceV3 } from "./learning-v3.js";

type Answer = Extract<EvidenceV3, { type: "answer" }>;
type Judgment = Extract<EvidenceV3, { type: "judgment" }>;
export type EffectiveLearningV3 = {
  invalidatedEvidenceIds: ReadonlySet<string>;
  dependentEvidenceIds: ReadonlySet<string>;
  answers: Answer[];
  judgments: Judgment[];
  progressAnswers: Answer[];
  reviewTasks: EpisodeV3["reviewTasks"];
  links: EpisodeV3["links"];
};

/** The one projection used by dialogue, prompts and external readers. Raw
 * append-only events remain intact; a disputed prerequisite invalidates its
 * dependent conclusions, never the learner's later answer itself. */
export function effectiveLearningV3(episode: EpisodeV3, protection?: ProtectionSnapshot): EffectiveLearningV3 {
  const invalidatedEvidenceIds = new Set(episode.evidence.flatMap(item => item.type === "correction" ? [item.corrects] : []));
  const dependentEvidenceIds = new Set<string>();
  const invalidatedTasks = new Set<string>();
  // Completed review tasks retain both their prerequisites and question. This
  // permits transitive invalidation without pretending a later answer vanished.
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of episode.reviewTasks) {
      const invalid = task.state === "invalidated" || task.dependsOn.some(id => invalidatedEvidenceIds.has(id) || dependentEvidenceIds.has(id));
      if (!invalid || invalidatedTasks.has(task.id)) continue;
      invalidatedTasks.add(task.id); changed = true;
      if (task.questionId) for (const item of episode.evidence)
        if (item.type !== "correction" && item.questionId === task.questionId) dependentEvidenceIds.add(item.id);
    }
  }
  const answers = episode.evidence.filter((item): item is Answer => item.type === "answer" && !invalidatedEvidenceIds.has(item.id))
    .map(item => ({ ...item, independence: questionIndependence(episode, item.questionId, item.sequence, protection) }));
  const judgments = episode.evidence.filter((item): item is Judgment => item.type === "judgment" && !invalidatedEvidenceIds.has(item.id));
  return {
    invalidatedEvidenceIds, dependentEvidenceIds, answers, judgments,
    progressAnswers: answers.filter(item => item.outcome === "correct" && item.independence === "no-plugin-help" && !dependentEvidenceIds.has(item.id)),
    reviewTasks: episode.reviewTasks.map(task => ({ ...task, ...(invalidatedTasks.has(task.id) ? { state: "invalidated" as const } : {}) })),
    links: episode.links.map(link => ({ ...link, ...(link.evidenceIds.some(id => invalidatedEvidenceIds.has(id) || dependentEvidenceIds.has(id)) ? { state: "needs-review" as const } : {}) })),
  };
}

/** No caller may accidentally fall back to trusting a stored independence
 * declaration when its protection file is unavailable. */
export function projectedEvidenceV3(episode: EpisodeV3, protection?: ProtectionSnapshot) {
  const effective = effectiveLearningV3(episode, protection);
  const answers = new Map(effective.answers.map(item => [item.id, item]));
  return episode.evidence.filter(item => !effective.invalidatedEvidenceIds.has(item.id)).map(item => {
    if (item.type === "correction") return { id: item.id, questionId: item.questionId, kind: "correction" as const, corrects: item.corrects, evaluator: item.evaluator, outcome: "unreviewed" as const };
    const question = episode.questions.find(q => q.id === item.questionId)!;
    return { id: item.id, questionId: item.questionId, question: renderQuestionV3(question).prompt, pool: question.pool,
      evaluator: item.evaluator, outcome: item.outcome,
      ...(item.type === "answer" ? { answer: item.answer, independence: answers.get(item.id)!.independence } : { criteria: item.criteria }),
      ...(effective.dependentEvidenceIds.has(item.id) ? { progress: "needs-review" as const } : {}),
      help: episode.help.filter(help => item.helpIds.includes(help.id)).map(({ id, kind, state }) => ({ id, kind, state })),
    };
  });
}
