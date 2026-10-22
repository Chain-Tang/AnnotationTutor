import { canonicalMathAnswer, gradeCanonicalAnswer } from "../src/learning-answer.js";
import type { LearningIO } from "../src/learning-record-read.js";
import { createEpisodeV3, LearningV3Store, nextLearningSequence, questionRefV3, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";

export function protectionFixture() {
  const files = new Map<string, string>(), root = "learning/v3/episodes";
  const io: LearningIO = {
    read: async path => files.get(path) ?? null,
    list: async prefix => [...files.keys()].filter(path => path.startsWith(prefix + "/")),
    write: async (path, raw) => { files.set(path, raw); },
    compareWrite: async (path, before, next) => { if ((files.get(path) ?? null) !== before) throw new Error("external-conflict"); files.set(path, next); },
  };
  const store = new LearningV3Store(io, root);
  const episode = createEpisodeV3({ path: "Synthetic/math.md", version: "v1" }, questionRefV3("value-limit", "practice", 0), {
    at: "2026-10-09T00:00:00.000Z", requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(), invitationId: crypto.randomUUID(),
  });
  return { files, io, root, store, episode, path: `${root}/${episode.id}.json`, guardPath: store.protection.path(episode.id), reopen: () => new LearningV3Store(io, root) };
}
export function addProtectedAnswer(e: EpisodeV3, independence: "no-plugin-help" | "helped" | "unknown" = "no-plugin-help", questionId = e.currentQuestionId) {
  const q = renderQuestionV3(e.questions.find(q => q.id === questionId)!), answer = canonicalMathAnswer(q, q.answer)!;
  const requestId = crypto.randomUUID(), sequence = nextLearningSequence(e);
  e.requests.push(requestId);
  e.evidence.push({ id: crypto.randomUUID(), requestId, questionId, at: e.updatedAt, sequence, type: "answer", answer, evaluator: "deterministic", outcome: gradeCanonicalAnswer(q, answer) ? "correct" : "incorrect", independence, helpIds: e.help.filter(h => h.questionId === questionId && h.sequence < sequence).map(h => h.id) });
  return e;
}
export function addProtectedHelp(e: EpisodeV3, state: "prepared" | "presented" | "unknown" = "prepared", questionId = e.currentQuestionId) {
  const requestId = crypto.randomUUID(); e.requests.push(requestId);
  e.help.push({ id: crypto.randomUUID(), requestId, questionId, at: e.updatedAt, sequence: nextLearningSequence(e), kind: "hint", state, presentationId: crypto.randomUUID() });
  return e;
}
