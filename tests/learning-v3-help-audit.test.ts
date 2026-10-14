import { describe, expect, it } from "vitest";
import {
  conceptCriterion,
  createEpisodeV3,
  parseEpisodeV3,
  questionRefV3,
  type EpisodeV3,
  type EvidenceV3,
  type HelpExposureV3,
} from "../src/learning-v3.js";

const at = "2026-10-09T00:00:00.000Z";

function fixture() {
  return createEpisodeV3(
    { path: "Synthetic/math.md", version: "v1" },
    questionRefV3("value-limit", "practice", 0),
    {
      at,
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      invitationId: crypto.randomUUID(),
    },
  );
}

function addHelp(
  episode: EpisodeV3,
  state: HelpExposureV3["state"],
  sequence: number,
  questionId = episode.currentQuestionId,
) {
  const help: HelpExposureV3 = {
    id: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    questionId,
    at,
    sequence,
    kind: "hint",
    state,
    presentationId: crypto.randomUUID(),
  };
  episode.requests.push(help.requestId);
  episode.help.push(help);
  return help;
}

function addJudgment(episode: EpisodeV3, sequence: number, helpIds: string[]) {
  const judgment: Extract<EvidenceV3, { type: "judgment" }> = {
    id: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    questionId: episode.currentQuestionId,
    at,
    sequence,
    type: "judgment",
    evaluator: "tutor",
    outcome: "unreviewed",
    criteria: [{ id: conceptCriterion[episode.concept], state: "supported" }],
    helpIds,
  };
  episode.requests.push(judgment.requestId);
  episode.evidence.push(judgment);
  return judgment;
}

describe("v3 judgments retain prior help exposure", () => {
  it.each(["prepared", "presented", "unknown"] as const)(
    "rejects omission of preceding %s help for the same question",
    state => {
      const episode = fixture();
      const help = addHelp(episode, state, 1);
      const judgment = addJudgment(episode, 2, [help.id]);
      expect(parseEpisodeV3(episode).evidence).toHaveLength(1);

      judgment.helpIds = [];
      expect(() => parseEpisodeV3(episode)).toThrow("learning-v3-reference-invalid");
    },
  );

  it("accepts a judgment referencing all preceding help states", () => {
    const episode = fixture();
    const help = [
      addHelp(episode, "prepared", 1),
      addHelp(episode, "presented", 2),
      addHelp(episode, "unknown", 3),
    ];
    const judgment = addJudgment(episode, 4, help.map(item => item.id));
    expect(parseEpisodeV3(episode).evidence[0]).toEqual(judgment);

    judgment.helpIds = [help[1]!.id];
    expect(() => parseEpisodeV3(episode)).toThrow("learning-v3-reference-invalid");
  });

  it("does not require a judgment to reference help that occurs later", () => {
    const episode = fixture();
    const prior = addHelp(episode, "prepared", 1);
    const judgment = addJudgment(episode, 2, [prior.id]);
    const later = addHelp(episode, "presented", 3);
    expect(parseEpisodeV3(episode).evidence[0]).toEqual(judgment);

    judgment.helpIds.push(later.id);
    expect(() => parseEpisodeV3(episode)).toThrow("learning-v3-reference-invalid");
  });

  it("requires only prior help from the judgment's own question", () => {
    const episode = fixture();
    const otherQuestion = questionRefV3("value-limit", "transfer", 1);
    episode.questions.push(otherQuestion);
    const otherHelp = addHelp(episode, "presented", 1, otherQuestion.id);
    const ownHelp = addHelp(episode, "prepared", 2);
    const judgment = addJudgment(episode, 3, [ownHelp.id]);
    expect(parseEpisodeV3(episode).evidence[0]).toEqual(judgment);

    judgment.helpIds.push(otherHelp.id);
    expect(() => parseEpisodeV3(episode)).toThrow("learning-v3-reference-invalid");
  });
});
