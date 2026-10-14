import { effectiveLearningV3 } from "./learning-effective-v3.js";
import { questionRefV3, renderQuestionV3, type EpisodeV3, type EvidenceV3, type QuestionRefV3 } from "./learning-v3.js";
import { questionContentDigest, type ProtectionSnapshot } from "./learning-protection.js";

export function unseenLearningQuestion(episode:EpisodeV3,pool:QuestionRefV3["pool"],protection?:ProtectionSnapshot):QuestionRefV3 {
  const seen=new Set(episode.questions.map(ref=>renderQuestionV3(ref).prompt));
  const retained=new Set(protection?.episodeId===episode.id?[...protection.questions.values()].map(q=>q.contentDigest):[]);
  // The frozen renderer has 75 distinct parameter/template combinations.
  for(let seed=0;seed<75;seed++){
    const question=questionRefV3(episode.concept,pool,seed);
    if(!seen.has(renderQuestionV3(question).prompt)&&!retained.has(questionContentDigest(question)))return question;
  }
  throw new Error("learning-question-pool-exhausted");
}
export function reviewTime(now:Date,days:1|3|7){
  const due=new Date(now);due.setDate(due.getDate()+days);
  return {dueAt:due.toISOString(),localDate:`${due.getFullYear()}-${String(due.getMonth()+1).padStart(2,"0")}-${String(due.getDate()).padStart(2,"0")}`};
}

/** Mutates only the proposed episode inside the caller's CAS. Review task,
 * question selection and grading remain one transaction, with explicit links
 * to the evidence that justified this scheduling decision. */
export function advanceLearningAfterAnswer(episode:EpisodeV3,answer:Extract<EvidenceV3,{type:"answer"}>,now:Date,
  protection?:ProtectionSnapshot,remainingMinutes=20):void {
  const ref=episode.questions.find(q=>q.id===answer.questionId);
  if(!ref||episode.currentQuestionId!==answer.questionId)throw new Error("learning-progress-question-mismatch");
  if(answer.outcome==="correct"&&ref.pool==="practice"){
    const next=unseenLearningQuestion(episode,"transfer",protection);episode.questions.push(next);episode.currentQuestionId=next.id;
    episode.status=remainingMinutes<=5?"paused":"active";return;
  }
  if(answer.outcome!=="correct"&&ref.pool!=="delayed")return;
  const effective=effectiveLearningV3(episode,protection);
  const currentReview=effective.reviewTasks.find(t=>t.state==="active"&&t.questionId===answer.questionId);
  if(ref.pool==="delayed"&&!currentReview)throw new Error("learning-progress-review-unavailable");
  const verified=effective.answers.find(e=>e.id===answer.id);
  const independent=verified?.outcome==="correct"&&verified.independence==="no-plugin-help"&&!effective.dependentEvidenceIds.has(answer.id);
  const nextStep=ref.pool==="delayed"&&independent?Math.min(3,(currentReview!.step+1)):0;
  const days=nextStep===3?undefined:([1,3,7] as const)[nextStep]!;
  const dependencies=[...new Set([
    ...(currentReview?.dependsOn??effective.answers.filter(e=>e.outcome==="correct"&&e.questionId!==answer.questionId&&!effective.dependentEvidenceIds.has(e.id)).map(e=>e.id)),answer.id,
  ])];
  for(const task of episode.reviewTasks){
    if(task.id===currentReview?.id)task.state="completed";
    else if(task.state==="scheduled")task.state="invalidated";
  }
  episode.status="completed";
  if(days)episode.reviewTasks.push({id:crypto.randomUUID(),...reviewTime(now,days),step:nextStep,state:"scheduled",dependsOn:dependencies});
}
