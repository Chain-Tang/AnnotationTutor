import { describe, expect, it } from "vitest";
import { createEpisodeV3, questionRefV3 } from "../src/learning-v3.js";
import { parseLearningControlV3, learningControlV3Schema, localLearnerAuthority, permitsLearningControl, validateLearningBinding } from "../src/learning-control-v3.js";

const episode = () => createEpisodeV3({path:"math.md",version:"v1"}, questionRefV3("value-limit","practice"),
  {at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID(),invitationId:crypto.randomUUID()});
describe("explicit local learning control", () => {
  it('separates a bound pause from finite support, without permitting help or grading to be disguised',()=>{
    const e=episode(),support={type:'support-boundary',need:'departure'} as const;
    const control={action:{type:'pause',questionId:e.currentQuestionId},replyRelation:'unrelated',support};
    expect(parseLearningControlV3(control).support).toEqual(support);
    expect(()=>validateLearningBinding(parseLearningControlV3(control),e)).not.toThrow();
    expect(()=>validateLearningBinding(parseLearningControlV3({...control,action:{type:'pause',questionId:crypto.randomUUID()}}),e)).toThrow('question-mismatch');
    for(const type of ['answer','hint','solution','forget'])expect(learningControlV3Schema.safeParse({...control,action:{type,questionId:e.currentQuestionId}}).success).toBe(false);
    expect(learningControlV3Schema.safeParse({...control,action:{type:'expert',questionId:e.currentQuestionId,kind:'explanation'}}).success).toBe(false);
    expect(learningControlV3Schema.safeParse({...control,support:{...support,privateText:'sensitive'}}).success).toBe(false);
    expect(learningControlV3Schema.safeParse({...control,action:{type:'support-boundary',need:'availability'}}).success).toBe(false);
  });
  it('validates compound invitations with the same availability and bounded concept rules',()=>{
    const control={action:{type:'explain-and-invite',concept:'value-limit'},replyRelation:'unrelated'};
    expect(parseLearningControlV3(control,{canInvite:true}).action.type).toBe('explain-and-invite');
    expect(()=>parseLearningControlV3(control,{canInvite:false})).toThrow('invitation-unavailable');
    expect(()=>parseLearningControlV3({...control,action:{...control.action,attempt:'PRIVATE'}})).toThrow();
    expect(()=>parseLearningControlV3({...control,action:{...control.action,concept:'invented'}})).toThrow();
  });
  it("requires an in-memory local learner capability, not a serialized claim", () => {
    const authority=localLearnerAuthority();
    for(const entry of ["sidebar","annotation","board","legacy-card"] as const)
      expect(permitsLearningControl({entry,kind:"conversation",authority})).toBe(true);
    expect(permitsLearningControl({entry:"external",kind:"conversation",authority})).toBe(false);
    expect(permitsLearningControl({entry:"sidebar",kind:"document-edit",authority})).toBe(false);
    expect(permitsLearningControl({entry:"sidebar",kind:"conversation",authority:JSON.parse(JSON.stringify(authority))})).toBe(false);
  });
  it("does not admit private prose, model-provided answers or actor impersonation into control", () => {
    const questionId=crypto.randomUUID();
    for(const extra of [{answer:9},{actor:"obsidian"},{feedback:"private disclosure"},{attempt:"private disclosure"}])
      expect(learningControlV3Schema.safeParse({action:{type:"answer",questionId,...extra},replyRelation:"current-question"}).success).toBe(false);
    expect(learningControlV3Schema.safeParse({action:{type:"explain",questionId,criteria:[{id:"psychological-state",state:"supported"}]},replyRelation:"current-question"}).success).toBe(false);
  });
  it("binds actions and curriculum criteria to the exact current question", () => {
    const e=episode();
    expect(()=>validateLearningBinding({action:{type:"hint",questionId:crypto.randomUUID()},replyRelation:"current-question"},e)).toThrow("question-mismatch");
    expect(()=>validateLearningBinding({action:{type:"hint",questionId:e.currentQuestionId},replyRelation:"current-question"},e)).not.toThrow();
    expect(()=>validateLearningBinding({action:{type:"explain",questionId:e.currentQuestionId,criteria:[{id:"finite-jump",state:"supported"}]},replyRelation:"current-question"},e)).toThrow("criterion-mismatch");
  });
  it("binds a correction to its original question after the learner has moved on", () => {
    const e=episode(),old=e.currentQuestionId;
    e.evidence.push({type:"judgment",id:crypto.randomUUID(),questionId:old,requestId:e.consent.requestId,at:e.createdAt,sequence:1,evaluator:"tutor",outcome:"unreviewed",criteria:[{id:"point-versus-limit",state:"uncertain"}],helpIds:[]});
    const next=questionRefV3(e.concept,"transfer");e.questions.push(next);e.currentQuestionId=next.id;
    expect(()=>validateLearningBinding({action:{type:"correct",questionId:old,evidenceId:e.evidence[0]!.id},replyRelation:"current-question"},e)).not.toThrow();
    expect(()=>validateLearningBinding({action:{type:"correct",questionId:next.id,evidenceId:e.evidence[0]!.id},replyRelation:"current-question"},e)).toThrow("evidence-mismatch");
  });
  it("rejects both a corrected fact and a correction event as new correction targets",()=>{
    const e=episode(),id=crypto.randomUUID(),correctionId=crypto.randomUUID();
    e.evidence.push({type:"judgment",id,questionId:e.currentQuestionId,requestId:e.consent.requestId,at:e.createdAt,sequence:1,evaluator:"tutor",outcome:"unreviewed",criteria:[{id:"point-versus-limit",state:"uncertain"}],helpIds:[]});
    e.evidence.push({type:"correction",id:correctionId,questionId:e.currentQuestionId,requestId:e.consent.requestId,at:e.createdAt,sequence:2,evaluator:"learner",outcome:"unreviewed",corrects:id});
    for(const evidenceId of [id,correctionId])expect(()=>validateLearningBinding({action:{type:"correct",questionId:e.currentQuestionId,evidenceId},replyRelation:"current-question"},e)).toThrow("evidence-unavailable");
  });
  it.each([
    [{action:{type:"hint"},replyRelation:"current-question"},"question-id"],
    [{action:{type:"hint",questionId:"PRIVATE_UUID"},replyRelation:"current-question"},"question-id"],
    [{action:{type:"accept",invitationId:"PRIVATE_UUID"},replyRelation:"unrelated"},"invitation-id"],
    [{action:{type:"none"},replyRelation:"PRIVATE_RELATION"},"reply-relation"],
    [{action:{type:"PRIVATE_ACTION"},replyRelation:"uncertain"},"action"],
    [{action:{type:"none",PRIVATE_FIELD:"PRIVATE_VALUE"},replyRelation:"unrelated"},"shape"],
  ])("reduces schema issues to bounded metadata without copying model values %#",(value,issue)=>{
    expect(()=>parseLearningControlV3(value)).toThrow("teaching-control-schema-"+issue);
    try{parseLearningControlV3(value);}catch(error){expect(String(error)).not.toContain("PRIVATE");}
  });

});
