import { z } from "zod";
import { hasLocalLearnerAuthority, type LocalLearnerAuthority } from "./learning-control-v3.js";
import { effectiveLearningV3 } from "./learning-effective-v3.js";
import { questionIndependence, type ProtectionSnapshot } from "./learning-protection.js";
import { gradeCanonicalAnswer, mathAnswerSchema, type MathAnswer } from "./learning-answer.js";
import { createEpisodeV3, nextLearningSequence, questionRefV3, renderQuestionV3, type EpisodeV3, type EvidenceV3, type HelpExposureV3, type LearningV3Store, type QuestionRefV3 } from "./learning-v3.js";
import type { ConceptId } from "./learning-episode.js";
import { advanceLearningAfterAnswer, reviewTime, unseenLearningQuestion } from "./learning-progress-v3.js";

const uuid=z.string().uuid();
export type LearningCommandBinding = {
  authority: LocalLearnerAuthority;
  requestId: string;
  episodeId: string;
  questionId: string;
  expectedRevision: number;
  source: EpisodeV3["source"];
};
export type LearningHelpTicket = {
  episodeId:string;questionId:string;helpId:string;presentationId:string;requestId:string;
  source:EpisodeV3["source"];preparedRevision:number;
};
export type LearningCommandResult = {episode:EpisodeV3;replayed:boolean;phaseId:string;protectionRevision?:string};
type Phase="answer"|"judgment"|"correction"|"pause"|"resume"|"help"|"presentation-presented"|"presentation-unknown"|"next"|"schedule"|"forget"|"artifact";

/** Fixed namespace + constrained payload only. These UUID receipts never carry
 * prose and survive restarts; one phase cannot be reused for a different action. */
export async function learningPhaseId(requestId:string,phase:Phase,payload?:unknown):Promise<string> {
  uuid.parse(requestId);
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(["tutor-learning-command-v1",requestId,phase,payload??null]))));
  hash[6]=(hash[6]!&15)|128;hash[8]=(hash[8]!&63)|128;
  const h=[...hash.slice(0,16)].map(n=>n.toString(16).padStart(2,"0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function abort(signal?:AbortSignal){if(signal?.aborted)throw new DOMException("Learning operation cancelled","AbortError");}
function authorized(authority:unknown){if(!hasLocalLearnerAuthority(authority))throw new Error("learning-local-learner-required");}
function sameSource(a:EpisodeV3["source"],b:EpisodeV3["source"]){return a.path===b.path&&a.version===b.version&&a.annotationId===b.annotationId;}
// Capture caller-owned data before queuing. The authority is a branded object,
// so preserve its identity rather than cloning the whole binding.
function captureBinding(binding:LearningCommandBinding):LearningCommandBinding{return {...binding,source:{...binding.source}};}
function linkedSignals(...signals:(AbortSignal|undefined)[]){
  const controller=new AbortController(),listeners:(()=>void)[]=[];
  for(const signal of signals){
    if(!signal)continue;
    const cancel=()=>controller.abort();
    if(signal.aborted)cancel();
    else{signal.addEventListener("abort",cancel,{once:true});listeners.push(()=>signal.removeEventListener("abort",cancel));}
  }
  return {signal:controller.signal,dispose:()=>{for(const remove of listeners)remove();}};
}

/** Preallocated in memory. It is not a persisted episode or a consumed consent
 * until accept() has confirmed the episode CAS. Never serialize this handle. */
export type LearningInvitationV3 = Readonly<{id:string;episodeId:string;questionId:string;conversationId:string;source:EpisodeV3["source"];concept:ConceptId}>;
type InvitationState={handle:LearningInvitationV3;draft:EpisodeV3;expired:boolean;consumed:boolean;expiry:AbortController};

export class LearningCommandsV3 {
  private tail:Promise<unknown>=Promise.resolve();
  private invitations=new WeakMap<LearningInvitationV3,InvitationState>();
  constructor(readonly store:LearningV3Store,private now:()=>Date=()=>new Date()){}
  private serial<T>(action:()=>Promise<T>):Promise<T>{const result=this.tail.catch(()=>{}).then(action);this.tail=result;return result;}

  offer(input:{authority:LocalLearnerAuthority;conversationId:string;requestId:string;source:EpisodeV3["source"];concept:ConceptId;question?:QuestionRefV3;legacy?:EpisodeV3["legacy"]}):LearningInvitationV3 {
    authorized(input.authority);uuid.parse(input.conversationId);uuid.parse(input.requestId);
    const question=input.question??questionRefV3(input.concept,"practice");
    if(question.concept!==input.concept)throw new Error("learning-invitation-concept-mismatch");
    const draft=createEpisodeV3(input.source,question,{at:this.now().toISOString(),requestId:input.requestId,conversationId:input.conversationId,invitationId:crypto.randomUUID()},input.legacy);
    const handle=Object.freeze({id:draft.consent.invitationId,episodeId:draft.id,questionId:question.id,conversationId:input.conversationId,source:Object.freeze({...input.source}),concept:input.concept});
    this.invitations.set(handle,{handle,draft,expired:false,consumed:false,expiry:new AbortController()});return handle;
  }
  expire(invitation:LearningInvitationV3){const state=this.invitations.get(invitation);if(state&&!state.consumed){state.expired=true;state.expiry.abort();}}
  accept(invitation:LearningInvitationV3,input:{authority:LocalLearnerAuthority;requestId:string;conversationId:string;source:EpisodeV3["source"]},signal?:AbortSignal):Promise<LearningCommandResult>{
    input={...input,source:{...input.source}};
    authorized(input.authority);uuid.parse(input.requestId);
    return this.serial(async()=>{
      const state=this.invitations.get(invitation);
      if(!state||state.expired&&!state.consumed||input.conversationId!==invitation.conversationId||!sameSource(input.source,invitation.source))throw new Error("learning-invitation-expired");
      const linked=linkedSignals(state.expiry.signal,signal);
      try{
        const read=await this.store.readEffectiveResult(),existing=read.records.find(e=>e.id===invitation.episodeId);
        if(existing){
          if(existing.status==="deleted"||existing.consent.invitationId!==invitation.id||existing.questions[0]?.id!==invitation.questionId)throw new Error("learning-invitation-conflict");
          state.consumed=true;return {episode:existing,replayed:true,phaseId:existing.consent.requestId,protectionRevision:read.protectionByEpisode.get(existing.id)?.revision};
        }
        abort(linked.signal);
        state.draft.consent={...state.draft.consent,at:this.now().toISOString(),requestId:input.requestId};
        state.draft.createdAt=state.draft.consent.at;state.draft.updatedAt=state.draft.createdAt;state.draft.requests=[input.requestId];
        const episode=await this.store.save(state.draft,linked.signal,input.requestId);
        // save() owns the commit boundary. Do not hide a committed episode if
        // expiry or caller cancellation arrived while CAS was completing.
        state.consumed=true;return {episode,replayed:false,phaseId:input.requestId,protectionRevision:this.store.committedProtectionRevision(episode)};
      }finally{linked.dispose();}
    });
  }

  private async current(binding:LearningCommandBinding){
    authorized(binding.authority);uuid.parse(binding.requestId);
    const read=await this.store.readEffectiveResult(),episode=read.records.find(e=>e.id===binding.episodeId);
    if(!episode||episode.status==="deleted")throw new Error("learning-target-unavailable");
    if(!sameSource(episode.source,binding.source))throw new Error("learning-source-changed");
    return {episode,protection:read.protectionByEpisode.get(episode.id)};
  }
  private execute(binding:LearningCommandBinding,phase:Phase,payload:unknown,
    mutate:(episode:EpisodeV3,phaseId:string,protection:ProtectionSnapshot|undefined)=>void,
    signal?:AbortSignal,merge=false):Promise<LearningCommandResult> {
    authorized(binding.authority);
    return this.serial(async()=>{
      const phaseId=await learningPhaseId(binding.requestId,phase),receipt=await learningPhaseId(binding.requestId,phase,[binding.episodeId,binding.questionId,payload]);
      const {episode,protection}=await this.current(binding);
      if(episode.requests.includes(phaseId)){
        if(!episode.requests.includes(receipt))throw new Error("learning-command-replay-conflict");
        return {episode,replayed:true,phaseId,protectionRevision:protection?.revision};
      }
      abort(signal);
      if(!merge&&episode.revision!==binding.expectedRevision)throw new Error("learning-v3-revision-conflict");
      if(!episode.questions.some(q=>q.id===binding.questionId))throw new Error("learning-question-unavailable");
      episode.requests.push(phaseId,receipt);mutate(episode,phaseId,protection);
      const saved=await this.store.save(episode,signal,binding.requestId);
      return {episode:saved,replayed:false,phaseId,protectionRevision:this.store.committedProtectionRevision(saved)};
    });
  }

  attachArtifact(binding:LearningCommandBinding,link:Pick<EpisodeV3["links"][number],"kind"|"taskId"|"targetId"|"evidenceIds">,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);
    link=z.object({kind:z.enum(["drawing","expert"]),taskId:uuid,targetId:z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),evidenceIds:z.array(uuid).max(500)}).strict().parse(link);
    return this.execute(binding,"artifact",link,(episode,_phase,protection)=>{
      const effective=effectiveLearningV3(episode,protection),valid=new Set([...effective.answers,...effective.judgments].map(item=>item.id));
      if(link.evidenceIds.some(id=>!valid.has(id)||effective.dependentEvidenceIds.has(id)))throw new Error("learning-artifact-evidence-invalid");
      if(episode.currentQuestionId!==binding.questionId)throw new Error("learning-question-inactive");
      episode.links.push({...link,evidenceIds:[...link.evidenceIds],questionId:binding.questionId,at:this.now().toISOString(),state:"current"});
    },signal);
  }

  prepareHelp(binding:LearningCommandBinding,kind:HelpExposureV3["kind"],presentationId:string,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);
    uuid.parse(presentationId);
    return this.execute(binding,"help",{kind,presentationId},(e,phaseId)=>{
      if(e.currentQuestionId!==binding.questionId||e.status==="deleted")throw new Error("learning-question-inactive");
      e.help.push({id:crypto.randomUUID(),requestId:phaseId,questionId:binding.questionId,at:this.now().toISOString(),sequence:nextLearningSequence(e),kind,state:"prepared",presentationId});
    },signal);
  }
  ticket(result:LearningCommandResult,presentationId:string,requestId:string):LearningHelpTicket {
    const help=result.episode.help.find(h=>h.presentationId===presentationId);
    if(!help)throw new Error("learning-help-unavailable");
    return {episodeId:result.episode.id,questionId:help.questionId,helpId:help.id,presentationId,requestId,source:{...result.episode.source},preparedRevision:result.episode.revision};
  }
  confirmHelp(ticket:LearningHelpTicket,authority:LocalLearnerAuthority,state:"presented"|"unknown"):Promise<LearningCommandResult>{
    ticket={...ticket,source:{...ticket.source}};
    return this.execute({...ticket,authority,expectedRevision:ticket.preparedRevision},state==="presented"?"presentation-presented":"presentation-unknown",{helpId:ticket.helpId,presentationId:ticket.presentationId,state},e=>{
      const help=e.help.find(h=>h.id===ticket.helpId);
      if(!help||help.presentationId!==ticket.presentationId||help.questionId!==ticket.questionId)throw new Error("learning-help-ticket-mismatch");
      if(help.state!=="presented")help.state=state;
    },undefined,true);
  }

  answer(binding:LearningCommandBinding,answer:MathAnswer,presentationId:string,signal?:AbortSignal,progress?:{remainingMinutes:number}):Promise<LearningCommandResult>{
    binding=captureBinding(binding);answer=mathAnswerSchema.parse(answer);
    const minutes=progress?z.number().min(0).max(1440).parse(progress.remainingMinutes):undefined;
    uuid.parse(presentationId);
    return this.execute(binding,"answer",{answer,presentationId,minutes:minutes??null},(e,phaseId,protection)=>{
      if(e.status!=="active"||e.currentQuestionId!==binding.questionId)throw new Error("learning-question-inactive");
      const question=renderQuestionV3(e.questions.find(q=>q.id===binding.questionId)!);
      if(question.kind!==answer.kind)throw new Error("learning-answer-kind-mismatch");
      const sequence=nextLearningSequence(e),helpIds=e.help.filter(h=>h.questionId===binding.questionId).map(h=>h.id);
      const evidence:EvidenceV3={id:crypto.randomUUID(),requestId:phaseId,questionId:binding.questionId,at:this.now().toISOString(),sequence,type:"answer",answer,
        evaluator:"deterministic",outcome:gradeCanonicalAnswer(question,answer)?"correct":"incorrect",independence:questionIndependence(e,binding.questionId,sequence,protection),helpIds};
      e.evidence.push(evidence);
      // The explanation is help for subsequent attempts, not for the answer
      // submitted just before it. Both persist before any feedback is shown.
      e.help.push({id:crypto.randomUUID(),requestId:phaseId,questionId:binding.questionId,at:this.now().toISOString(),sequence:sequence+1,kind:"solution",state:"prepared",presentationId});
      if(minutes!==undefined)advanceLearningAfterAnswer(e,evidence,this.now(),protection,minutes);
    },signal);
  }
  judgment(binding:LearningCommandBinding,criteria:Extract<EvidenceV3,{type:"judgment"}>["criteria"],presentationId:string,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);criteria=structuredClone(criteria);uuid.parse(presentationId);
    return this.execute(binding,"judgment",{criteria,presentationId},(e,phaseId)=>{
      if(e.status!=="active"||e.currentQuestionId!==binding.questionId)throw new Error("learning-question-inactive");
      const sequence=nextLearningSequence(e);
      e.evidence.push({id:crypto.randomUUID(),requestId:phaseId,questionId:binding.questionId,at:this.now().toISOString(),sequence,type:"judgment",evaluator:"tutor",outcome:"unreviewed",criteria,helpIds:e.help.filter(h=>h.questionId===binding.questionId).map(h=>h.id)});
      e.help.push({id:crypto.randomUUID(),requestId:phaseId,questionId:binding.questionId,at:this.now().toISOString(),sequence:sequence+1,kind:"related-discussion",state:"prepared",presentationId});
    },signal);
  }
  correct(binding:LearningCommandBinding,evidenceId:string,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);
    uuid.parse(evidenceId);
    return this.execute(binding,"correction",{evidenceId},(e,phaseId)=>{
      const original=e.evidence.find(x=>x.id===evidenceId);
      if(!original||original.questionId!==binding.questionId)throw new Error("learning-correction-question-mismatch");
      if(original.type==="correction"||e.evidence.some(item=>item.type==="correction"&&item.corrects===evidenceId))throw new Error("learning-correction-evidence-unavailable");
      e.evidence.push({id:crypto.randomUUID(),requestId:phaseId,questionId:original.questionId,at:this.now().toISOString(),sequence:nextLearningSequence(e),type:"correction",evaluator:"learner",outcome:"unreviewed",corrects:evidenceId});
      const effective=effectiveLearningV3(e);e.reviewTasks=effective.reviewTasks;e.links=effective.links;
    },signal);
  }
  pause(binding:LearningCommandBinding,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);
    return this.execute(binding,"pause",{},e=>{
      if(e.currentQuestionId!==binding.questionId||!["active","paused"].includes(e.status))throw new Error("learning-question-inactive");
      e.status="paused";
    },signal);
  }
  resume(binding:LearningCommandBinding,signal?:AbortSignal,reviewTaskId?:string):Promise<LearningCommandResult>{
    binding=captureBinding(binding);
    if(reviewTaskId)uuid.parse(reviewTaskId);
    return this.execute(binding,"resume",{reviewTaskId:reviewTaskId??null},(e,phaseId,protection)=>{
      const effective=effectiveLearningV3(e),task=reviewTaskId?effective.reviewTasks.find(t=>t.id===reviewTaskId):undefined;
      if(reviewTaskId&&(!task||!["active","scheduled"].includes(task.state)))throw new Error("learning-review-task-unavailable");
      if(task?.state==="active"){
        if(e.currentQuestionId!==task.questionId)throw new Error("learning-review-target-changed");
        e.status="active";return;
      }
      // Only an already-consumed exact review task can merge a stale revision.
      // A new consumption or ordinary resume still honors the captured lease.
      if(e.revision!==binding.expectedRevision)throw new Error("learning-v3-revision-conflict");
      if(task&&Date.parse(task.dueAt)<=this.now().getTime()){
        const stored=e.reviewTasks.find(t=>t.id===task.id)!,question=unseenLearningQuestion(e,"delayed",protection);
        e.questions.push(question);e.currentQuestionId=question.id;e.status="active";
        stored.state="active";stored.questionId=question.id;stored.consumedBy=phaseId;
      }else if(e.status!=="completed")e.status="active";
    },signal,!!reviewTaskId);
  }
  next(binding:LearningCommandBinding,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);
    return this.execute(binding,"next",{},(e,_phaseId,protection)=>{
      if(e.currentQuestionId!==binding.questionId)throw new Error("learning-question-inactive");
      const question=unseenLearningQuestion(e,"practice",protection);
      for(const task of e.reviewTasks)if(task.state==="active")task.state="invalidated";
      e.questions.push(question);e.currentQuestionId=question.id;e.status="active";
    },signal);
  }
  schedule(binding:LearningCommandBinding,days:1|3|7,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);z.union([z.literal(1),z.literal(3),z.literal(7)]).parse(days);
    return this.execute(binding,"schedule",{days},(e,_phaseId,protection)=>{
      if(e.currentQuestionId!==binding.questionId)throw new Error("learning-question-inactive");
      const effective=effectiveLearningV3(e,protection),previous=effective.reviewTasks.filter(t=>t.state==="scheduled").at(-1);
      for(const task of e.reviewTasks)if(task.state==="scheduled")task.state="invalidated";
      // Retained downstream facts are still visible after a correction, but
      // they cannot justify a replacement task while their basis is disputed.
      e.reviewTasks.push({id:crypto.randomUUID(),...reviewTime(this.now(),days),step:previous?.step??0,state:"scheduled",dependsOn:previous?.dependsOn??effective.answers.filter(x=>x.outcome==="correct"&&!effective.dependentEvidenceIds.has(x.id)).map(x=>x.id)});
    },signal);
  }
  forget(binding:LearningCommandBinding,signal?:AbortSignal):Promise<LearningCommandResult>{
    binding=captureBinding(binding);
    return this.execute(binding,"forget",{},e=>{e.status="deleted";e.evidence=[];e.help=[];e.reviewTasks=[];e.links=[];},signal);
  }
  flush(){return this.tail;}
}
