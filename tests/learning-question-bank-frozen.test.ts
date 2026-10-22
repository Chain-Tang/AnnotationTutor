import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { instantiateQuestion, questionTemplates } from "../src/learning-question-bank-v2-2.js";
import { instantiateQuestion as currentQuestion, questionTemplates as currentTemplates } from "../src/learning-question-bank.js";
import { lessonFor } from "../src/learning-episode.js";
import { createEpisodeV2 } from "../src/learning-v2.js";
import { canonicalLegacyQuestion, safeLegacyEvidence } from "../src/learning-safe-projection.js";
import { questionRefV3, renderQuestionV3 } from "../src/learning-v3.js";

const fixture=JSON.parse(readFileSync(new URL("./fixtures/learning-question-bank-v2-2.json",import.meta.url),"utf8")) as {packVersion:string;templates:Array<{templateId:string;combinations:number;sha256:string}>};
describe("frozen limits-v2-2 and limits-v3-1 renderer",()=>{
  it("pins every authored field for all 1,350 template and parameter combinations",()=>{
    const actual=questionTemplates.map(template=>{
      const combinations=[];
      for(let seed=template.variant;seed<75;seed+=3){const {id,...question}=instantiateQuestion(template.concept,template.pool,seed);combinations.push(question);}
      return {templateId:template.id,combinations:combinations.length,sha256:createHash("sha256").update(JSON.stringify(combinations)).digest("hex")};
    });
    expect(fixture.packVersion).toBe("limits-v2-2");expect(actual).toHaveLength(54);expect(actual).toEqual(fixture.templates);
    expect(actual.reduce((sum,t)=>sum+t.combinations,0)).toBe(1350);
  });
  it("keeps the current export compatible and prevents mutation of registered templates",()=>{
    expect(currentQuestion).toBe(instantiateQuestion);expect(currentTemplates).toBe(questionTemplates);
    expect(Object.isFrozen(questionTemplates)).toBe(true);
    expect(questionTemplates.every(template=>Object.isFrozen(template))).toBe(true);
  });
  it("reconstructs historical and v3 questions independently of future lesson goal changes",()=>{
    const q=instantiateQuestion("value-limit","practice",0),lesson=lessonFor("value-limit"),goal=lesson.goal;
    const e=createEpisodeV2({path:"Synthetic/math.md",version:"1"},q,{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()});
    try{
      lesson.goal="SYNTHETIC_FUTURE_GOAL";
      expect(instantiateQuestion(q.concept,q.pool,q.seed).rubric).toEqual(q.rubric);
      expect(canonicalLegacyQuestion(e,q.id)).toMatchObject({prompt:q.prompt,rubric:q.rubric});
      expect(renderQuestionV3(questionRefV3(q.concept,q.pool,q.seed,q.id))).toMatchObject({prompt:q.prompt,rubric:q.rubric});
    }finally{lesson.goal=goal;}
  });
  it("keeps unknown v2-1 provenance unverified instead of guessing the current template",()=>{
    const q={...instantiateQuestion("jump","practice",0),packVersion:"limits-v2-1" as const};
    const requestId=crypto.randomUUID(),at=new Date().toISOString();
    const e=createEpisodeV2({path:"Synthetic/math.md",version:"1"},q,{at,requestId,conversationId:crypto.randomUUID()});
    e.evidence.push({id:crypto.randomUUID(),requestId,at,questionId:q.id,answer:q.answer,help:{hints:0,answerShown:false},kind:"unassisted",evaluator:"deterministic",outcome:"correct",feedback:"SYNTHETIC_PRIVATE_FEEDBACK"});
    expect(canonicalLegacyQuestion(e,q.id)).toBeUndefined();
    expect(safeLegacyEvidence(e)).toEqual([{id:e.evidence[0]!.id,kind:"legacy-unverified",evaluator:"unverified",outcome:"unreviewed"}]);
  });
  it("repeats only the frozen parameter space for valid high seeds",()=>{
    for(const seed of [75,149,999975,1000000])for(const template of questionTemplates){
      const {id,seed:actualSeed,...actual}=instantiateQuestion(template.concept,template.pool,seed);
      const {id:expectedId,seed:expectedSeed,...expected}=instantiateQuestion(template.concept,template.pool,seed%75);
      expect(actual).toEqual(expected);
    }
  });
});
