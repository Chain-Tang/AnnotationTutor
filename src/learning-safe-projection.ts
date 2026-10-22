import { lessonFor, type LearningEpisode } from "./learning-episode.js";
import type { EpisodeV2 } from "./learning-v2.js";
import { instantiateQuestion } from "./learning-question-bank-v2-2.js";
import { canonicalMathAnswer, gradeCanonicalAnswer } from "./learning-answer.js";

export type LegacyLearningRecord = LearningEpisode|EpisodeV2;
/** Reconstruct text from the authored bank. Never trust an old file's prompt,
 * answer key, feedback, rubric or learner prose as an externally shareable field. */
export function canonicalLegacyQuestion(record:LegacyLearningRecord,questionId:string) {
  if(record.format===1){const lesson=lessonFor(record.concept);return [lesson.question,lesson.transfer].find(q=>q.id===questionId);}
  const saved=record.questions.find(q=>q.id===questionId);
  if(!saved||saved.packVersion!=="limits-v2-2"||saved.concept!==record.concept)return;
  try {
    const canonical=instantiateQuestion(saved.concept,saved.pool,saved.seed);
    if(canonical.templateId!==saved.templateId||JSON.stringify(canonical.parameters)!==JSON.stringify(saved.parameters))return;
    return {...canonical,id:saved.id};
  }catch{return;}
}
export function safeLegacyEvidence(record:LegacyLearningRecord) {
  const corrected=new Set(record.evidence.flatMap(item=>item.corrects?[item.corrects]:[]));
  return record.evidence.filter(item=>!corrected.has(item.id)).map(item=>{
    if(item.corrects)return {id:item.id,kind:"correction",corrects:item.corrects,evaluator:"learner",outcome:"unreviewed"};
    const question=canonicalLegacyQuestion(record,item.questionId);
    const answer=question&&item.evaluator==="deterministic"&&item.kind!=="explanation"&&item.kind!=="self-report"
      ?canonicalMathAnswer(question,item.answer):undefined;
    if(!question||!answer)return {id:item.id,kind:"legacy-unverified",evaluator:"unverified",outcome:"unreviewed"};
    return {id:item.id,kind:item.kind,answer,questionId:question.id,question:question.prompt,
      help:"help" in item?item.help:{hints:item.hintCount},evaluator:"deterministic",
      outcome:gradeCanonicalAnswer(question,answer)?"correct":"incorrect"};
  });
}
