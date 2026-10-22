import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceLearningAfterAnswer, reviewTime, unseenLearningQuestion } from "../src/learning-progress-v3.js";
import { effectiveLearningV3 } from "../src/learning-effective-v3.js";
import { canonicalMathAnswer } from "../src/learning-answer.js";
import { nextLearningSequence, questionRefV3, renderQuestionV3, type EpisodeV3, type EvidenceV3 } from "../src/learning-v3.js";
import { addProtectedAnswer, addProtectedHelp, protectionFixture } from "./learning-protection-fixture.js";

type Answer = Extract<EvidenceV3, { type: "answer" }>;
type Rig = ReturnType<typeof protectionFixture>;
const now = new Date("2026-10-09T15:42:17.321Z");
const day = 86_400_000;
const lastAnswer = (e: EpisodeV3): Answer => {
  const result = e.evidence.at(-1); if (result?.type !== "answer") throw new Error("invalid-answer-fixture"); return result;
};
function incorrectAnswer(e: EpisodeV3): Answer {
  addProtectedAnswer(e); const answer = lastAnswer(e), q = renderQuestionV3(e.questions.find(q=>q.id===answer.questionId)!);
  const wrong = canonicalMathAnswer(q, q.kind === "choice" ? q.choices!.find(choice=>choice!==q.answer)! : String(Number(q.answer) + 12345));
  if (!wrong) throw new Error("invalid-incorrect-fixture");
  answer.answer = wrong; answer.outcome = "incorrect"; return answer;
}
async function firstReview() {
  const f = protectionFixture(); let e = await f.store.save(f.episode);
  addProtectedAnswer(e); const practice = lastAnswer(e);
  advanceLearningAfterAnswer(e, practice, now, await f.store.protection.read(e.id)); e = await f.store.save(e);
  addProtectedAnswer(e); const transfer = lastAnswer(e);
  advanceLearningAfterAnswer(e, transfer, now, await f.store.protection.read(e.id)); e = await f.store.save(e);
  return { f, e, practice, transfer };
}
async function activate(f: Rig, e: EpisodeV3) {
  const task = e.reviewTasks.find(t=>t.state==="scheduled"); if (!task) throw new Error("missing-scheduled-fixture");
  const question = unseenLearningQuestion(e, "delayed"), requestId = crypto.randomUUID();
  task.state = "active"; task.questionId = question.id; task.consumedBy = requestId;
  e.questions.push(question); e.currentQuestionId = question.id; e.requests.push(requestId); e.status = "active";
  return { e: await f.store.save(e), taskId: task.id, due: new Date(task.dueAt) };
}
async function passDelayed(f: Rig, initial: EpisodeV3) {
  const active = await activate(f, initial), e = active.e;
  addProtectedAnswer(e); const answer = lastAnswer(e);
  advanceLearningAfterAnswer(e, answer, active.due, await f.store.protection.read(e.id));
  return { e: await f.store.save(e), answer, previousTaskId: active.taskId, due: active.due };
}
function correctEvidence(e: EpisodeV3, target: EvidenceV3) {
  const requestId = crypto.randomUUID(); e.requests.push(requestId);
  e.evidence.push({ id: crypto.randomUUID(), requestId, questionId: target.questionId, at: e.updatedAt, sequence: nextLearningSequence(e), type: "correction", evaluator: "learner", outcome: "unreviewed", corrects: target.id });
}

beforeEach(()=>vi.stubEnv("TZ", "UTC"));
afterEach(()=>vi.unstubAllEnvs());

describe("v3 progress against durable protection", () => {
  it.each([20,5])("moves correct practice to a distinct transfer question with %i estimated minutes remaining", async remaining => {
    const f = protectionFixture(); let e = await f.store.save(f.episode);
    const original = e.questions[0]!, originalPrompt = renderQuestionV3(original).prompt;
    addProtectedAnswer(e); const answer = lastAnswer(e);
    advanceLearningAfterAnswer(e, answer, now, await f.store.protection.read(e.id), remaining);
    e = await f.store.save(e);
    const next = e.questions.find(q=>q.id===e.currentQuestionId)!;
    expect(next).toMatchObject({pool:"transfer",concept:original.concept}); expect(next.id).not.toBe(original.id);
    expect(renderQuestionV3(next).prompt).not.toBe(originalPrompt);
    expect(e.status).toBe(remaining<=5?"paused":"active"); expect(e.reviewTasks).toEqual([]);
    const snapshot = await f.store.readEffectiveResult();
    expect(effectiveLearningV3(e,snapshot.protectionByEpisode.get(e.id)).progressAnswers.map(a=>a.id)).toEqual([answer.id]);
  });

  it("keeps an incorrect practice answer on its existing question", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode), id = e.currentQuestionId;
    const answer = incorrectAnswer(e);
    advanceLearningAfterAnswer(e, answer, now, await f.store.protection.read(e.id));
    const saved = await f.store.save(e);
    expect(saved.currentQuestionId).toBe(id); expect(saved.questions).toHaveLength(1); expect(saved.reviewTasks).toEqual([]);
    expect(saved.evidence.at(-1)).toMatchObject({id:answer.id,outcome:"incorrect"});
  });

  it("schedules 1/3/7 day checks with cumulative evidence dependencies and distinct delayed questions", async () => {
    const initial = await firstReview(), {f,practice,transfer} = initial; let e = initial.e;
    expect(e.reviewTasks).toEqual([expect.objectContaining({step:0,state:"scheduled",dueAt:new Date(now.getTime()+day).toISOString(),localDate:"2026-10-10",dependsOn:[practice.id,transfer.id]})]);
    const facts = [practice.id,transfer.id], prompts = new Set(e.questions.map(q=>renderQuestionV3(q).prompt));
    for(const [index,days] of [3,7,undefined].entries()) {
      const result = await passDelayed(f,e); e=result.e; facts.push(result.answer.id);
      const used = e.questions.find(q=>q.id===result.answer.questionId)!;
      expect(used.pool).toBe("delayed"); expect(prompts.has(renderQuestionV3(used).prompt)).toBe(false); prompts.add(renderQuestionV3(used).prompt);
      expect(e.reviewTasks.find(t=>t.id===result.previousTaskId)).toMatchObject({state:"completed",questionId:used.id,consumedBy:expect.any(String)});
      const pending=e.reviewTasks.filter(t=>t.state==="scheduled");
      if(days===undefined) expect(pending).toEqual([]);
      else expect(pending).toEqual([expect.objectContaining({step:index+1,dueAt:new Date(result.due.getTime()+days*day).toISOString(),dependsOn:facts})]);
    }
    expect(e.status).toBe("completed"); expect(e.reviewTasks.map(t=>t.state)).toEqual(["completed","completed","completed"]);
    const snapshot=await f.reopen().readEffectiveResult();
    expect(effectiveLearningV3(snapshot.records[0]!,snapshot.protectionByEpisode.get(e.id)).progressAnswers.map(a=>a.id)).toEqual(facts);
  });

  it.each(["presented","prepared","unknown","missing-protection"] as const)("does not advance the no-help review stage after %s", async state => {
    const initial=await firstReview(), progressed=await passDelayed(initial.f,initial.e), active=await activate(initial.f,progressed.e);
    const e=active.e, oldTask=e.reviewTasks.find(t=>t.id===active.taskId)!;
    expect(oldTask.step).toBe(1);
    if(state!=="missing-protection") addProtectedHelp(e,state);
    addProtectedAnswer(e,state==="presented"?"helped":"unknown"); const answer=lastAnswer(e);
    advanceLearningAfterAnswer(e,answer,active.due,state==="missing-protection"?undefined:await initial.f.store.protection.read(e.id));
    const saved=await initial.f.store.save(e), pending=saved.reviewTasks.filter(t=>t.state==="scheduled");
    expect(pending).toEqual([expect.objectContaining({step:0,dueAt:new Date(active.due.getTime()+day).toISOString()})]);
    expect(saved.reviewTasks.find(t=>t.id===active.taskId)?.state).toBe("completed");
    const projected=effectiveLearningV3(saved,await initial.f.store.protection.read(e.id));
    expect(projected.answers.find(a=>a.id===answer.id)?.independence).toBe(state==="presented"?"helped":"unknown");
    expect(projected.progressAnswers.some(a=>a.id===answer.id)).toBe(false);
  });

  it("resets a failed delayed check to next day while retaining its incorrect answer", async () => {
    const initial=await firstReview(), step1=await passDelayed(initial.f,initial.e), step2=await passDelayed(initial.f,step1.e), active=await activate(initial.f,step2.e);
    const e=active.e; expect(e.reviewTasks.find(t=>t.id===active.taskId)?.step).toBe(2);
    const answer=incorrectAnswer(e);
    advanceLearningAfterAnswer(e,answer,active.due,await initial.f.store.protection.read(e.id));
    const saved=await initial.f.store.save(e), next=saved.reviewTasks.find(t=>t.state==="scheduled")!;
    expect(next).toMatchObject({step:0,dueAt:new Date(active.due.getTime()+day).toISOString()});
    expect(next.dependsOn).toContain(answer.id); expect(saved.evidence).toContainEqual(answer);
    expect(saved.reviewTasks.find(t=>t.id===active.taskId)?.state).toBe("completed");
  });

  it("cannot continue an active task after a prerequisite was corrected", async () => {
    const initial=await firstReview(), active=await activate(initial.f,initial.e);
    let e=active.e; correctEvidence(e,initial.practice); e=await initial.f.store.save(e);
    expect(e.reviewTasks.find(t=>t.id===active.taskId)?.state).toBe("active");
    expect(effectiveLearningV3(e,await initial.f.store.protection.read(e.id)).reviewTasks.find(t=>t.id===active.taskId)?.state).toBe("invalidated");
    addProtectedAnswer(e); const later=lastAnswer(e), before=structuredClone(e);
    expect(()=>advanceLearningAfterAnswer(e,later,active.due)).toThrow("review-unavailable");
    expect(e).toEqual(before);
    // The fact can remain append-only even though it cannot revive this task.
    e=await initial.f.store.save(e);
    const projected=effectiveLearningV3(e,await initial.f.store.protection.read(e.id));
    expect(projected.answers.some(a=>a.id===later.id)).toBe(true);
    expect(projected.progressAnswers.some(a=>a.id===later.id)).toBe(false);
    expect(projected.reviewTasks.some(t=>t.state==="scheduled"||t.state==="active")).toBe(false);
  });

  it("keeps later independently answered facts when a completed chain's old prerequisite is corrected", async () => {
    const initial=await firstReview(), one=await passDelayed(initial.f,initial.e), two=await passDelayed(initial.f,one.e);
    let e=two.e; const before=e.evidence.filter(a=>a.type==="answer");
    correctEvidence(e,initial.practice); e=await initial.f.store.save(e);
    const projected=effectiveLearningV3(e,await initial.f.store.protection.read(e.id));
    expect(e.evidence.filter(a=>a.type==="answer")).toEqual(before);
    expect(projected.answers.map(a=>a.id)).toEqual([initial.transfer.id,one.answer.id,two.answer.id]);
    expect(projected.answers.filter(a=>a.id===one.answer.id||a.id===two.answer.id).every(a=>a.independence==="no-plugin-help")).toBe(true);
    expect(projected.reviewTasks.every(t=>t.state==="invalidated")).toBe(true);
    expect([...projected.dependentEvidenceIds]).toEqual([one.answer.id,two.answer.id]);
  });

  it("starts a new valid review chain without reattaching retained facts from a corrected chain", async () => {
    const initial=await firstReview(), one=await passDelayed(initial.f,initial.e), two=await passDelayed(initial.f,one.e), f=initial.f;
    let e=two.e; correctEvidence(e,initial.practice);e=await f.store.save(e);
    const next=unseenLearningQuestion(e,"practice",await f.store.protection.read(e.id));
    e.questions.push(next);e.currentQuestionId=next.id;e.status="active";e=await f.store.save(e);
    addProtectedAnswer(e);const practice=lastAnswer(e);
    advanceLearningAfterAnswer(e,practice,now,await f.store.protection.read(e.id));e=await f.store.save(e);
    addProtectedAnswer(e);const transfer=lastAnswer(e);
    advanceLearningAfterAnswer(e,transfer,now,await f.store.protection.read(e.id));e=await f.store.save(e);
    const fresh=e.reviewTasks.at(-1)!, projection=effectiveLearningV3(e,await f.store.protection.read(e.id));
    expect(fresh.dependsOn).toEqual([initial.transfer.id,practice.id,transfer.id]);
    expect(projection.reviewTasks.find(t=>t.id===fresh.id)?.state).toBe("scheduled");
    expect(fresh.dependsOn).not.toContain(one.answer.id);expect(fresh.dependsOn).not.toContain(two.answer.id);
    expect(e.evidence).toContainEqual(one.answer);expect(e.evidence).toContainEqual(two.answer);
    expect(projection.answers.filter(a=>a.id===one.answer.id||a.id===two.answer.id).every(a=>a.independence==="no-plugin-help")).toBe(true);
  });

  it("skips pre-recovery orphan questions that remain in durable protection", async () => {
    const f=protectionFixture(); let e=await f.store.save(f.episode); const old=f.files.get(f.path)!;
    addProtectedAnswer(e); advanceLearningAfterAnswer(e,lastAnswer(e),now,await f.store.protection.read(e.id)); e=await f.store.save(e);
    const lost=e.questions.find(q=>q.id===e.currentQuestionId)!;
    e=await f.store.save(addProtectedHelp(e,"presented"));
    f.files.set(f.path+".previous",old); f.files.set(f.path,"{synthetic-corrupt");
    const reopened=f.reopen(), recovered=await reopened.readEffectiveResult(); e=recovered.records[0]!;
    expect(e.questions).toHaveLength(1); expect(recovered.protectionByEpisode.get(e.id)?.questions.has(lost.id)).toBe(true);
    addProtectedAnswer(e,"unknown");
    advanceLearningAfterAnswer(e,lastAnswer(e),now,recovered.protectionByEpisode.get(e.id));
    expect(renderQuestionV3(e.questions.find(q=>q.id===e.currentQuestionId)!).prompt).not.toBe(renderQuestionV3(lost).prompt);
    await expect(reopened.save(e)).resolves.toMatchObject({currentQuestionId:e.currentQuestionId});
  });
});

describe("frozen unseen pools and schedule dates", () => {
  it("selects the requested independent pool and compares rendered content instead of only IDs/seeds", () => {
    const e=protectionFixture().episode, used=questionRefV3(e.concept,"delayed",75); e.questions.push(used);
    const next=unseenLearningQuestion(e,"delayed");
    expect(next.pool).toBe("delayed"); expect(next.seed).toBe(1);
    expect(renderQuestionV3(next).prompt).not.toBe(renderQuestionV3(used).prompt);
    expect(unseenLearningQuestion(e,"transfer").pool).toBe("transfer");
  });

  it("reports exhaustion instead of regenerating a new UUID or equivalent seed", () => {
    const e=protectionFixture().episode;
    e.questions.push(...Array.from({length:75},(_,seed)=>questionRefV3(e.concept,"delayed",seed+75)));
    const before=structuredClone(e);
    expect(()=>unseenLearningQuestion(e,"delayed")).toThrow("learning-question-pool-exhausted");
    expect(e).toEqual(before);
  });

  it("stores absolute deadlines and the scheduling local date across month/year boundaries", () => {
    const time=new Date("2026-12-31T23:59:58.123Z"), before=time.toISOString();
    expect(reviewTime(time,1)).toEqual({dueAt:"2027-01-01T23:59:58.123Z",localDate:"2027-01-01"});
    expect(reviewTime(time,3)).toEqual({dueAt:"2027-01-03T23:59:58.123Z",localDate:"2027-01-03"});
    expect(reviewTime(time,7)).toEqual({dueAt:"2027-01-07T23:59:58.123Z",localDate:"2027-01-07"});
    expect(time.toISOString()).toBe(before);
  });

  it.each([
    ["2026-03-07T12:30:00-05:00","2026-03-08T16:30:00.000Z","2026-03-08",23],
    ["2026-10-31T12:30:00-04:00","2026-11-01T17:30:00.000Z","2026-11-01",25],
  ])("schedules a local next day through DST from %s", (start,absolute,local,hours) => {
    vi.stubEnv("TZ","America/New_York"); const time=new Date(start as string), due=reviewTime(time,1);
    expect(due).toEqual({dueAt:absolute,localDate:local});
    expect(Date.parse(due.dueAt)-time.getTime()).toBe((hours as number)*3_600_000);
    vi.stubEnv("TZ","Asia/Shanghai");
    expect(due).toEqual({dueAt:absolute,localDate:local});
  });
});
