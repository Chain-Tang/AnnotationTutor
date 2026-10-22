import { describe, expect, it } from "vitest";
import { createEpisodeV3, questionRefV3, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { canonicalMathAnswer } from "../src/learning-answer.js";
import { effectiveLearningV3, projectedEvidenceV3 } from "../src/learning-effective-v3.js";
import { learningContext } from "../src/learning-context.js";
import type { ProtectionSnapshot } from "../src/learning-protection.js";

function fixture() {
  const e=createEpisodeV3({path:"math.md",version:"1"},questionRefV3("value-limit","practice"),
    {at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID(),invitationId:crypto.randomUUID()});
  const transfer=questionRefV3(e.concept,"transfer"),delayed=questionRefV3(e.concept,"delayed"),later=questionRefV3(e.concept,"delayed",1);
  e.questions.push(transfer,delayed,later);
  function answer(questionId:string) {
    const q=renderQuestionV3(e.questions.find(q=>q.id===questionId)!),value=canonicalMathAnswer(q,q.answer)!;
    const item={id:crypto.randomUUID(),requestId:crypto.randomUUID(),questionId,at:e.createdAt,sequence:e.evidence.length+1,
      type:"answer" as const,answer:value,evaluator:"deterministic" as const,outcome:"correct" as const,independence:"no-plugin-help" as const,helpIds:[]};
    e.evidence.push(item);e.requests.push(item.requestId);return item;
  }
  const a=answer(e.currentQuestionId),b=answer(transfer.id),c=answer(delayed.id),d=answer(later.id);
  const task=(questionId:string,dependsOn:string[],state:EpisodeV3["reviewTasks"][number]["state"]="completed")=>({id:crypto.randomUUID(),dueAt:e.createdAt,localDate:"2026-10-09",step:1,questionId,dependsOn,state});
  e.reviewTasks.push(task(delayed.id,[a.id,b.id]),task(later.id,[c.id]),{...task(later.id,[d.id],"scheduled"),questionId:undefined});
  e.links.push({kind:"expert",taskId:crypto.randomUUID(),targetId:"synthetic",questionId:later.id,at:e.createdAt,evidenceIds:[d.id],state:"current"});
  return {e,a,b,c,d};
}
describe("one effective learning projection",()=>{
  it("never trusts no-plugin-help stored in a record without its independent protection",()=>{
    const {e}=fixture(),state=effectiveLearningV3(e);
    expect(state.answers).toHaveLength(4);
    expect(state.answers.every(x=>x.independence==="unknown")).toBe(true);
    expect(state.progressAnswers).toEqual([]);
    expect(projectedEvidenceV3(e).every(x=>!("independence" in x)||x.independence==="unknown")).toBe(true);
    expect(learningContext([e],{episodeId:e.id}).summary).toContain('"independence":"unknown"');
    expect(e.evidence[0]).toMatchObject({independence:"no-plugin-help"});
  });
  it("invalidates dependent review chains and expert conclusions while retaining later answer facts",()=>{
    const {e,a,b,c,d}=fixture(),requestId=crypto.randomUUID();
    e.evidence.push({id:crypto.randomUUID(),requestId,questionId:a.questionId,at:e.createdAt,sequence:5,type:"correction",evaluator:"learner",outcome:"unreviewed",corrects:a.id});e.requests.push(requestId);
    const state=effectiveLearningV3(e);
    expect(state.invalidatedEvidenceIds.has(a.id)).toBe(true);
    expect(state.answers.map(x=>x.id)).toEqual([b.id,c.id,d.id]);
    expect([...state.dependentEvidenceIds]).toEqual([c.id,d.id]);
    expect(state.reviewTasks.every(t=>t.state==="invalidated")).toBe(true);
    expect(state.links[0]?.state).toBe("needs-review");
    expect(e.reviewTasks[0]?.state).toBe("completed");
    expect(e.links[0]?.state).toBe("current");
    expect(learningContext([e],{episodeId:e.id}).summary).toContain('"reviewDue":null');
  });
  it("does not resurrect old success when its correction is itself disputed",()=>{
    const {e,a}=fixture();
    let corrects=a.id;
    for(let i=0;i<2;i++) {
      const requestId=crypto.randomUUID(),id=crypto.randomUUID();
      e.evidence.push({id,requestId,questionId:a.questionId,at:e.createdAt,sequence:e.evidence.length+1,type:"correction",evaluator:"learner",outcome:"unreviewed",corrects});
      e.requests.push(requestId);corrects=id;
    }
    expect(effectiveLearningV3(e).answers.some(x=>x.id===a.id)).toBe(false);
    expect(projectedEvidenceV3(e).some(x=>x.id===a.id)).toBe(false);
  });
  it("does not let a different document's protection invalidate an unrelated snapshot",()=>{
    const {e}=fixture(),snapshot=(revision:string,id=e.id)=>({episodeId:id,status:"missing" as const,revision,questions:new Map()} satisfies ProtectionSnapshot);
    const read=(entries: [string,ProtectionSnapshot][])=>learningContext([e],{episodeId:e.id},new Map(entries));
    expect(read([[e.id,snapshot("a")]]).revision).not.toBe(read([[e.id,snapshot("b")]]).revision);
    expect(read([["other",snapshot("a","other")]]).revision).toBe(read([["other",snapshot("b","other")]]).revision);
  });
});
