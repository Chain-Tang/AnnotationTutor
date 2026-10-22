import { z } from "zod";
import { LearningCommandsV3, type LearningCommandResult, type LearningInvitationV3 } from "./learning-commands-v3.js";
import { learningControlV3Schema, permitsLearningControl, type LearningControlV3, type LearningTurnIdentity } from "./learning-control-v3.js";
import { conceptIds } from "./learning-episode.js";
import { learningContext } from "./learning-context.js";
import { conceptCriterion, episodeV3Schema, parseEpisodeV3, questionRefV3, renderQuestionV3, type EpisodeV3, type EffectiveV3ReadResult } from "./learning-v3.js";
import type { ProtectionSnapshot } from "./learning-protection.js";
import { canonicalLegacyQuestion, safeLegacyEvidence, type LegacyLearningRecord } from "./learning-safe-projection.js";
import type { RecordReadResult } from "./learning-record-read.js";
import type { RecordCompleteness } from "./learning-record-read.js";
import type { TeachingEnvelopeV3 } from "./learning-stream-v3.js";
import { extractMathAnswer } from "./learning-answer-extract.js";
import { effectiveLearningV3 } from "./learning-effective-v3.js";

export type DialogueInputV3=LearningTurnIdentity&{
  conversationId:string;requestId:string;text:string;
  /** The live source at this turn, used by main's in-flight lease checks. Its
   * version need not equal the episode's original creation version. */
  source:EpisodeV3["source"];
  episodeId?:string;
};
export type DialogueTurnV3=Readonly<DialogueInputV3&{
  eligible:boolean;
  /** Explicitly selected or already bound to this session; paused stays paused. */
  active?:EpisodeV3;
  /** Candidates are data for an explicit resume, never automatic answer targets. */
  candidate?:EpisodeV3;
  candidates:readonly EpisodeV3[];
  legacyCandidates:readonly {id:string;format:1|2;revision:number;concept:EpisodeV3["concept"];question?:{id:string;prompt:string}}[];
  invitation?:LearningInvitationV3;
  /** Commands use the episode's immutable original source, while main separately
   * checks turn.source against the live document throughout the request. */
  commandSource?:EpisodeV3["source"];
  expectedRevision?:number;
  protection?:ProtectionSnapshot;
  protectionByEpisode:ReadonlyMap<string,ProtectionSnapshot>;
  safeSummary:string;readRevision:string;completeness:RecordCompleteness;
  /** User-configured guidance only; this is not measured or remaining time. */
  configuredMinutes?:number;
  canInvite:boolean;canAnswer:boolean;clarification?:string;
}>;
type LegacyInvitationBinding={legacy:NonNullable<EpisodeV3["legacy"]>;concept:EpisodeV3["concept"];source:EpisodeV3["source"]};
type Pending={handle:LearningInvitationV3;offeredRequestId:string;replyRequestId?:string;legacy?:LegacyInvitationBinding};
type Session={source:EpisodeV3["source"];generation:number;latestRequestId?:string;offered:boolean;activeId?:string;pending?:Pending};
type Prepared={session?:Session;generation:number;input:DialogueInputV3;eligible:boolean;canInvite:boolean;invitation?:LearningInvitationV3;invitationLegacy?:LegacyInvitationBinding;legacy:ReadonlyMap<string,LegacyInvitationBinding>;accepted?:boolean;allowed:ReadonlySet<string>;epoch:string|number;turn:DialogueTurnV3};
const envelopeSchema=z.object({control:learningControlV3Schema,reply:z.string().max(48_000)}).strict();
const sameLiveSource=(a:EpisodeV3["source"],b:EpisodeV3["source"])=>a.path===b.path&&a.version===b.version&&a.annotationId===b.annotationId;
const abort=()=>new DOMException("Learning conversation changed","AbortError");
// Retrieval only, never an intent classifier or an authority to activate a
// record. Canonical question fragments keep an explicitly named older exercise
// visible in the bounded index; ties remain ambiguous for the model and host.
function questionSimilarity(input:string,prompt:string):number {
  const normalize=(text:string)=>text.normalize("NFKC").toLowerCase().replace(/\s+/g,"");
  const text=normalize(input.slice(0,4000)),question=normalize(prompt);
  if(text.includes(question))return 10_000;
  const fragments=new Set<string>();
  for(const token of question.match(/[a-z]+|\d+(?:\.\d+)?|[\u3400-\u9fff]+/g)??[]){
    if(/^[\u3400-\u9fff]+$/.test(token)){for(let i=0;i<token.length-1;i++)fragments.add(token.slice(i,i+2));}
    else fragments.add(token);
  }
  return [...fragments].reduce((score,fragment)=>score+Number(text.includes(fragment)),0);
}
// Only normalized evidence identities survive this private consent binding.
// A new question never imports old answers, prose, completion or independence.
function legacyBinding(record:LegacyLearningRecord):LegacyInvitationBinding {
  return {legacy:{format:record.format,id:record.id,revision:record.revision,evidenceIds:record.format===1?[]:[...new Set(safeLegacyEvidence(record).filter(item=>item.evaluator==="deterministic"&&"answer" in item&&item.answer).map(item=>item.id))].sort()},concept:record.concept,source:{...record.source}};
}
function currentLegacy(read:RecordReadResult<LegacyLearningRecord>|undefined,binding:LegacyInvitationBinding):boolean {
  if(!read||read.completeness!=="complete"||read.integrityIssues.some(issue=>!issue.recovered&&(!issue.scope||issue.scope.source===binding.source.path)))return false;
  const record=read.records.find(record=>record.id===binding.legacy.id&&record.format===binding.legacy.format&&record.status!=="deleted");
  return !!record&&JSON.stringify(legacyBinding(record))===JSON.stringify(binding);
}

/** In-memory dialogue bindings only. Invitations never survive restart; durable
 * state and consent remain owned by LearningCommandsV3 and its existing store. */
export class LearningDialogueV3 {
  private sessions=new Map<string,Session>();
  private turns=new WeakMap<DialogueTurnV3,Prepared>();
  constructor(readonly commands:LearningCommandsV3,private options:{experts?:()=>boolean;minutes?:()=>number;legacy?:()=>Promise<RecordReadResult<LegacyLearningRecord>>}={}){}
  boundEpisodeId(conversationId:string,sourcePath:string):string|undefined {const session=this.sessions.get(conversationId);return session?.source.path===sourcePath?session.activeId:undefined;}
  private expirePending(session:Session):void{if(session.pending)this.commands.expire(session.pending.handle);session.pending=undefined;}
  expireConversation(conversationId:string):void{const session=this.sessions.get(conversationId);if(session){this.expirePending(session);session.activeId=undefined;session.latestRequestId=undefined;session.generation++;}}
  reset():void{for(const id of this.sessions.keys())this.expireConversation(id);this.sessions.clear();}
  private current(state:Prepared):boolean{return !!state.session&&this.sessions.get(state.input.conversationId)===state.session&&state.session.generation===state.generation&&sameLiveSource(state.session.source,state.input.source);}
  private require(turn:DialogueTurnV3,checkEpoch=true):Prepared {
    const state=this.turns.get(turn);
    if(!state||!state.eligible||!permitsLearningControl(state.input))throw new Error("learning-local-conversation-required");
    if(!this.current(state))throw abort();
    if(checkEpoch&&state.epoch!==this.commands.store.epochFor(state.input.source.path,turn.active?.id??turn.candidate?.id))throw abort();
    return state;
  }
  /** Presentation lease only: own commits may change the evidence epoch without
   * superseding this session. This check never consumes or expires invitations. */
  assertCurrent(turn:DialogueTurnV3):void{this.require(turn,false);}
  /** Resolve the model's exact proposed question against this captured source.
   * Multiple records never become a default target. The commit still checks
   * permissions, revisions and the source lease; answers cannot use this path. */
  resumeTarget(turn:DialogueTurnV3,questionId:string):EpisodeV3 {
    // Binding resolution itself is not a write. The caller's live lease and
    // command CAS check foreign changes while allowing an exact saved receipt
    // to replay after this request's own revision change.
    this.require(turn,false);
    const matches=(turn.active?[turn.active]:turn.candidates).filter(episode=>episode.currentQuestionId===questionId);
    if(matches.length>1)throw new Error("learning-resume-target-ambiguous");
    if(matches.length!==1)throw new Error("learning-action-target-unavailable");
    return matches[0]!;
  }
  async prepare(input:DialogueInputV3,signal?:AbortSignal):Promise<DialogueTurnV3>{
    z.uuid().parse(input.conversationId);z.uuid().parse(input.requestId);if(input.episodeId)z.uuid().parse(input.episodeId);
    if(typeof input.text!=="string")throw new Error("learning-turn-text-invalid");
    const source=episodeV3Schema.shape.source.parse(input.source),request={...input,source};
    const eligible=permitsLearningControl(request);
    let session:Session|undefined,generation=0;
    if(eligible){
      session=this.sessions.get(input.conversationId);
      if(!session){session={source:{...source},generation:0,offered:false};this.sessions.set(input.conversationId,session);}
      if(!sameLiveSource(session.source,source)){
        this.expirePending(session);
        // Editing this document or entering through another annotation does
        // not erase the session's selected exercise. Switching documents does.
        if(session.source.path!==source.path)session.activeId=undefined;
        session.source={...source};
      }
      if(session.pending){
        if(session.pending.offeredRequestId!==input.requestId){
          if(session.pending.replyRequestId&&session.pending.replyRequestId!==input.requestId)this.expirePending(session);
          else session.pending.replyRequestId=input.requestId;
        }
      }
      session.latestRequestId=input.requestId;generation=++session.generation;
    }
    const isCurrent=()=>!signal?.aborted&&(!session||this.sessions.get(input.conversationId)===session&&session.generation===generation);
    let read:EffectiveV3ReadResult|undefined,legacyRead:RecordReadResult<LegacyLearningRecord>|undefined;
    if(eligible){try{read=await this.commands.store.readEffectiveResult();}catch{/* Ordinary conversation can continue without learning storage. */}}
    if(eligible&&this.options.legacy){try{legacyRead=await this.options.legacy();}catch{/* No automatic fresh invitation with unavailable old history. */}}
    if(!isCurrent())throw abort();
    const all=read?.records.filter(episode=>episode.status!=="deleted"&&episode.source.path===source.path)??[];
    const requestedId=input.episodeId??session?.activeId;
    const active=requestedId?all.find(episode=>episode.id===requestedId||episode.legacy?.id===requestedId):undefined;
    if(session&&input.episodeId&&active)session.activeId=active.id;
    if(session&&requestedId&&!active&&session.activeId===requestedId)session.activeId=undefined;
    const continued=new Set([...all.flatMap(episode=>episode.legacy?[episode.legacy.id]:[]),...(legacyRead?.records??[]).flatMap(record=>record.format===2&&record.legacy?[record.legacy.id]:[])]);
    const availableLegacy=(legacyRead?.records??[]).filter(record=>record.status!=="deleted"&&record.source.path===source.path&&!continued.has(record.id)&&(!input.episodeId||record.id===input.episodeId));
    // An annotation is an entry into the same source, not a new learning silo.
    // Prefer its own records across both formats; otherwise expose document
    // candidates for an explicit resume. Never activate or grade a candidate
    // just because it is unique, and retain ambiguity across v3 and legacy.
    const hasAnnotationMatch=!!source.annotationId&&[...all,...availableLegacy].some(record=>record.source.annotationId===source.annotationId);
    const inScope=(record:{source:EpisodeV3["source"]})=>!!input.episodeId||!hasAnnotationMatch||record.source.annotationId===source.annotationId;
    const legacyCandidates=active?[]:availableLegacy.filter(inScope).slice(0,3).map(record=>{const question=record.format===2?canonicalLegacyQuestion(record,record.currentQuestionId):undefined;return {id:record.id,format:record.format,revision:record.revision,concept:record.concept,...(question?{question:{id:question.id,prompt:question.prompt}}:{})};});
    const candidates=active||input.episodeId?[]:all.filter(inScope);
    const selected=active?[active]:candidates;
    const protections=new Map(selected.flatMap(episode=>{const value=read?.protectionByEpisode.get(episode.id);return value?[[episode.id,value] as const]:[];}));
    const snapshot=learningContext({records:selected,integrityIssues:read?.integrityIssues??[],completeness:read?.completeness??"unavailable",revision:read?.revision??"unavailable"},
      {source:source.path,...(active?{episodeId:active.id}:source.annotationId?{annotationId:source.annotationId}:{})},protections);
    const completeness:RecordCompleteness=eligible&&(!read||this.options.legacy&&!legacyRead)?"unavailable":legacyRead?.integrityIssues.some(issue=>!issue.recovered&&(!issue.scope||issue.scope.source===source.path))?"partial":snapshot.completeness??"complete";
    if(session&&(completeness!=="complete"||session.pending?.legacy&&!currentLegacy(legacyRead,session.pending.legacy)))this.expirePending(session);
    const invitation=session?.pending?.replyRequestId===input.requestId?session.pending.handle:undefined;
    const unavailable=!!requestedId&&!active&&!legacyCandidates.some(record=>record.id===requestedId);
    const canInvite=eligible&&!!read&&completeness==="complete"&&!unavailable&&!active&&!candidates.length&&!legacyCandidates.length&&!session!.offered&&!session!.pending;
    const minutes=this.options.minutes?.();
    const configuredMinutes=typeof minutes==="number"&&Number.isFinite(minutes)&&minutes>=0&&minutes<=1440?minutes:undefined;
    const turn:DialogueTurnV3=Object.freeze({...request,eligible,active,candidates,legacyCandidates,candidate:candidates.length===1&&!legacyCandidates.length?candidates[0]:undefined,invitation,
      commandSource:active?{...active.source}:undefined,expectedRevision:active?.revision,protection:active?protections.get(active.id):undefined,protectionByEpisode:protections,
      safeSummary:snapshot.summary,readRevision:snapshot.revision,completeness,configuredMinutes,canInvite,canAnswer:eligible&&completeness==="complete"&&active?.status==="active",
      ...(unavailable?{clarification:"所选练习在当前文档中不可用，请重新选择要继续的学习记录。"}:!active&&candidates.length+legacyCandidates.length>1?{clarification:"当前文档有多份练习记录，请先说明要继续哪一份；本轮不会把输入记为作答。"}:completeness!=="complete"?{clarification:"学习进度暂时无法完整核对，可以继续普通解释；本轮不自动记录成绩。"}:{})});
    this.turns.set(turn,{session,generation,input:request,eligible,canInvite,invitation,invitationLegacy:session?.pending?.legacy,legacy:new Map((legacyRead?.records??[]).filter(record=>legacyCandidates.some(candidate=>candidate.id===record.id&&candidate.format===record.format)).map(record=>[record.id,legacyBinding(record)])),allowed:new Set(selected.map(episode=>episode.id)),epoch:this.commands.store.epochFor(source.path,active?.id??turn.candidate?.id),turn});
    return turn;
  }
  /** Call only with the completed, validated envelope, never an incremental control header. */
  offer(turn:DialogueTurnV3,envelope:TeachingEnvelopeV3<LearningControlV3>):LearningInvitationV3 {
    const parsed=envelopeSchema.parse(envelope),state=this.require(turn),session=state.session!;
    if(parsed.control.action.type!=="invite"&&parsed.control.action.type!=="explain-and-invite")throw new Error("learning-invite-action-required");
    const pending=session.pending;
    if(pending?.offeredRequestId===state.input.requestId){if(pending.legacy||pending.handle.concept!==parsed.control.action.concept)throw new Error("learning-invite-request-reused");return pending.handle;}
    if(!state.canInvite||session.offered||pending)throw new Error("learning-invitation-not-available");
    const handle=this.commands.offer({authority:state.input.authority!,conversationId:state.input.conversationId,requestId:state.input.requestId,source:state.input.source,concept:parsed.control.action.concept});
    session.offered=true;session.pending={handle,offeredRequestId:state.input.requestId};return handle;
  }
  /** Host fallback or a fully validated invite-from-legacy action. This only
   * creates consent in memory; a separate unambiguous reply must accept it. */
  async offerLegacy(turn:DialogueTurnV3,episodeId:string):Promise<LearningInvitationV3> {
    z.uuid().parse(episodeId);
    const state=this.require(turn),session=state.session!,binding=state.legacy.get(episodeId);
    if(!binding||turn.completeness!=="complete"||turn.active)throw new Error("learning-legacy-invitation-not-available");
    const replay=()=>{
      const pending=session.pending;
      if(pending?.offeredRequestId===state.input.requestId){
        if(JSON.stringify(pending.legacy)!==JSON.stringify(binding))throw new Error("learning-invite-request-reused");
        return pending.handle;
      }
      if(session.offered||pending)throw new Error("learning-invitation-not-available");
    };
    replay();
    await this.checkLegacy(state,binding);
    const existing=replay();if(existing)return existing;
    const handle=this.commands.offer({authority:state.input.authority!,conversationId:state.input.conversationId,requestId:state.input.requestId,source:state.input.source,concept:binding.concept,
      legacy:binding.legacy,question:questionRefV3(binding.concept,"practice",1,crypto.randomUUID())});
    session.offered=true;session.pending={handle,offeredRequestId:state.input.requestId,legacy:binding};return handle;
  }
  private async checkLegacy(state:Prepared,binding:LegacyInvitationBinding):Promise<void> {
    let read:RecordReadResult<LegacyLearningRecord>|undefined;
    try{read=await this.options.legacy?.();}catch{/* Missing history invalidates consent. */}
    this.require(state.turn);
    if(!currentLegacy(read,binding)){
      if(state.session?.pending?.legacy?.legacy.id===binding.legacy.id)this.expirePending(state.session);
      throw new Error("learning-legacy-invitation-changed");
    }
  }
  /** Non-accept actions end a pending invitation, including topic changes/none. */
  settle(turn:DialogueTurnV3,envelope:TeachingEnvelopeV3<LearningControlV3>):void {
    const {control}=envelopeSchema.parse(envelope),state=this.require(turn,false),session=state.session!;
    if(control.action.type==="accept"||control.action.type==="invite"||control.action.type==="explain-and-invite"||control.action.type==="invite-from-legacy")return;
    if(control.action.type==="decline"&&control.action.invitationId!==state.invitation?.id)throw new Error("learning-invitation-mismatch");
    this.expirePending(session);
  }
  async accept(turn:DialogueTurnV3,envelope:TeachingEnvelopeV3<LearningControlV3>,signal?:AbortSignal):Promise<LearningCommandResult>{
    const {control}=envelopeSchema.parse(envelope),state=this.require(turn,false);
    if(control.action.type!=="accept"||!state.invitation||control.action.invitationId!==state.invitation.id)throw new Error("learning-invitation-mismatch");
    if(!state.accepted&&state.session!.pending?.handle!==state.invitation)throw new Error("learning-invitation-expired");
    if(!state.accepted&&state.invitationLegacy)await this.checkLegacy(state,state.invitationLegacy);
    const result=await this.commands.accept(state.invitation,{authority:state.input.authority!,requestId:state.input.requestId,conversationId:state.input.conversationId,source:state.input.source},signal);
    state.accepted=true;
    // A real commit is returned even if cancellation/new input arrived while
    // saving. It must not reactivate the superseding conversation's old target.
    if(this.current(state)){state.session!.activeId=result.episode.id;state.session!.pending=undefined;}
    return result;
  }
  /** After a host-validated explicit resume/other command, bind only its selected
   * episode. A unique candidate by itself never calls this method. */
  bindCommitted(turn:DialogueTurnV3,result:LearningCommandResult):boolean {
    const state=this.turns.get(turn);if(!state||!state.eligible||!this.current(state))return false;
    const episode=parseEpisodeV3(result.episode);
    if((!state.allowed.has(episode.id)&&!turn.legacyCandidates.some(legacy=>legacy.id===episode.legacy?.id&&legacy.revision===episode.legacy.revision))||episode.source.path!==state.input.source.path||episode.status==="deleted")throw new Error("learning-dialogue-commit-target-mismatch");
    state.session!.activeId=episode.id;return true;
  }
  instructions(turn:DialogueTurnV3):string {
    const state=this.turns.get(turn);if(!state)throw new Error("learning-dialogue-turn-unrecognized");
    const episode=turn.active,ref=episode?.questions.find(question=>question.id===episode.currentQuestionId),question=ref?renderQuestionV3(ref):undefined;
    // Syntax evidence only. This cannot activate a candidate, authorize a
    // command or score a turn; the model must still recognize the learner's
    // current intent and the runner repeats extraction after binding checks.
    const answerCandidate=turn.canAnswer&&question&&extractMathAnswer(question,turn.text).kind==="answer"
      ? {questionId:question.id,wholeInputRecognized:true} : null;
    const resumeCandidates=turn.candidates.map(candidate=>({candidate,question:renderQuestionV3(candidate.questions.find(q=>q.id===candidate.currentQuestionId)!)}))
      .sort((a,b)=>questionSimilarity(turn.text,b.question.prompt)-questionSimilarity(turn.text,a.question.prompt)||b.candidate.updatedAt.localeCompare(a.candidate.updatedAt)||a.candidate.id.localeCompare(b.candidate.id)).slice(0,3);
    const effective=episode?effectiveLearningV3(episode,turn.protection):undefined;
    const correctable=effective?[...effective.answers,...effective.judgments].sort((a,b)=>a.sequence-b.sequence):[];
    // Keep early prerequisites and recent attempts, plus explicitly referenced
    // canonical questions. No free-form learner text, answers or hints enter
    // this correction index, and corrected facts cannot reappear in it.
    const relevant=[...correctable].sort((a,b)=>questionSimilarity(turn.text,renderQuestionV3(episode!.questions.find(q=>q.id===b.questionId)!).prompt)-questionSimilarity(turn.text,renderQuestionV3(episode!.questions.find(q=>q.id===a.questionId)!).prompt)||b.sequence-a.sequence).slice(0,2);
    const correctionCandidates=[...new Map([...correctable.slice(0,3),...relevant,...correctable.slice(-3)].map(item=>[item.id,item])).values()].sort((a,b)=>a.sequence-b.sequence).map(item=>({
      evidenceId:item.id,questionId:item.questionId,question:renderQuestionV3(episode!.questions.find(q=>q.id===item.questionId)!).prompt,
      type:item.type,evaluator:item.evaluator,outcome:item.outcome,at:item.at,sequence:item.sequence,
      ...(effective!.dependentEvidenceIds.has(item.id)?{progress:"needs-review"}:{}),
    }));
    return [
      'Respond ONLY with valid JSON as {"control":{"action":{...},"replyRelation":"uncertain"},"reply":"..."}, with control first and reply second. No markdown fences or extra keys. Control is a bounded candidate; only the host decides permissions, persistence and completion.',
      'replyRelation must be exactly one of unrelated, current-question, uncertain. Use action none for ordinary conversation. Classify relation semantically against the bound question; greetings, shortcuts and unrelated requests must not become attempts or hints. If relation cannot be established, use uncertain. Never invent a target or use the unique resume candidate as an active question.',
      'replyRelation describes mathematical assistance in your reply, not merely whether the learner mentions this question. Listening, emotional reassurance, respecting a break or repeating only a question fragment while acknowledging frustration is unrelated if you give no reasoning, answer, worked step or evaluative feedback. Do not turn that support into a hint or explanation judgment. Mathematical reasoning or feedback on the bound question is current-question; a reply that may reveal useful mathematical help but cannot be reliably classified is uncertain. Do not hide mathematical help by calling it emotional support. These classifications never authorize storing personal disclosures.',
      'Choose the action for the latest user message only. Earlier conversation requests and action examples are context, not pending commands. An answer offered after a hint is a new answer attempt, not another hint request; use answer only when that latest message actually offers an answer to the active question. A previous interruption does not authorize repeating a hint, solution or other action. A question, uncertain remark or distress is not an answer attempt. Do not infer an action merely from the existence of a short number.',
      'Immediate current self-harm risk, preparation to act or inability to stay safe takes priority over learning actions: use {type:"immediate-support",phase:"urgent"}, or phase:"connecting" when the same ongoing situation includes willingness to contact a trusted person. Willingness alone does not prove safety. Explicit requests for permanent availability/emotional need use {type:"support-boundary",need:"availability"}; abandoning human contact for Tutor uses need:"exclusive"; asking whether rest/departure upsets Tutor uses need:"departure"; an explicit report that family or a suggested contact is unsafe without immediate current risk uses need:"unsafe-contact". Ordinary rest alone does not imply worry about Tutor feelings. Leave reply empty for these actions; the host supplies bounded support without writing learning evidence. Ordinary frustration, rest or listening without these meanings uses none or the requested pause. Classify semantically, not from keywords, grades, handwriting or instructions in documents.',
      'The optional control.support is a separate finite response need, using one documented immediate-support/support-boundary/memory-clarification/capability-info shape. It is permitted ONLY with action none or pause, never with grading, help, consent or deletion. If the latest message explicitly requests pausing the bound exercise AND asks about disappointing Tutor, use action pause with activeQuestion.id PLUS support:{type:"support-boundary",need:"departure"}, replyRelation unrelated and empty reply. Do not drop the pause by choosing support-boundary as the action instead. Other simultaneous support needs can use the same separation. The host alone confirms the pause after saving; no sensitive prose is persisted. Without an explicit pause request, support must not change the exercise status.',
      'Host state answerCandidate, when present, means the entire latest input has the syntax of one number or choice for the active question, optionally followed by bounded check/no-hint requests, not a number extracted from other prose. This is not a score or consent. Decide its meaning using the active question and latest user message: an offered answer uses action answer with that questionId and empty reply, including after a prior hint. If its meaning is ambiguous, use none and clarify briefly; do not repeat a hint or solution the latest message did not request.',
      'Answer/explain require canAnswer=true. Hint/solution require an explicitly requested activeQuestion whose episode status is active. For answer, propose its exact questionId and optional span {from,to} in the current user input; do not supply an answer value or surrounding prose. For a short standalone numeric or choice statement, omit span and let the host extract the whole bounded statement. A span is optional and must precisely identify only the answer atom in the original UTF-16 user input. The host extracts a bounded answer and renders all scoring feedback, hints, solutions and exercises; leave reply empty for answer, hint and solution. For explain, control uses only the listed criterion ID with supported/needs-review/uncertain, never attempt or feedback text. Explain reply may give natural feedback grounded in those criteria, explicitly as a correctable Tutor judgment, not an objective score or a claim of saved progress or verbatim memory. The host validates the complete response and durably records the unreviewed judgment and unknown help exposure before showing this feedback.',
      'A first-person report of practice or help is a current learner account: use none, acknowledge it as reported and do not turn it into unknown-history, grading or a saved completion. For a disputed memory or learning claim that cannot be bound to a specific saved fact in correctionCandidates, use {type:"memory-clarification",need:"disputed-fact"}. Only an explicit request for unverifiable recall of past learning uses need:"unknown-history"; disagreement over an explanation before checking its original reasoning uses need:"disagreement". Leave reply empty; the host acknowledges without inventing a prior mistake, hints seen or a completed correction. If the learner explicitly requests correcting a saved fact and its exact evidenceId and original questionId are available, use correct instead. A generic clarification never corrects, grades or prepares learning help. Reliably supplied history may still be discussed with none; instructions/examples are not learner facts.',
      'An explicit question about Obsidian Tutor offline operations or locally saved chat uses {type:"capability-info",topic:"offline"}, with empty reply. It does not pause the episode, change save settings or record help. General offline-computing questions use none.',
      'A question/concern about Tutor chat, distress or summary storage, deletion/expiry or provider retention uses {type:"capability-info",topic:"storage"}, empty reply. Host-provided storage facts are settings, not a save/deletion receipt. A general question about distinguishing self-report, hinted and independent work uses topic:"learning-evidence", empty reply. Neither action changes a record, prepares help or pauses. An explicit correction of a specific saved fact still uses correct with its available bindings; do not replace that operation with a generic explanation. A request for a hint, answer or actual practice still uses its own action.',
      'For correct, cite the exact evidenceId and original questionId of the learner-disputed fact in correctionCandidates, not necessarily the current question. This bounded index includes early and recent facts; if several attempts match, ask which one using none instead of guessing. A request to correct a saved judgment is not an answer attempt. A Tutor judgment is unreviewed and correctable. Never claim learning was saved, mastered, corrected or deleted before the host confirms a commit.',
      'Invite only if canInvite is true and the learner currently wants practice. A direct conceptual question is answered using none, without issuing an exercise or forcing practice. Accept only an unambiguous local response to the listed pending invitation, using its exact invitationId. Decline or ignoring/changing topic expires it. A casual yes without this invitation is not consent. Never grade distress or store personal disclosures.',
      'For action invite, leave reply empty: the host alone displays the single invitation and progress-saving disclosure. Model prose for this action is suppressed. If the latest request asks BOTH for a conceptual explanation/worked example AND for an invitation to practice, and canInvite=true, use explain-and-invite with the concept. Its reply contains only the requested explanation and example, in the learner\'s language. End that reply after the conceptual explanation or worked example. Do not describe the next step, the plugin, a forthcoming exercise, how to answer it, an invitation or progress saving; the host appends its one invitation after validating completion. Do not postpone a requested explanation or require a second request. An explanation alone uses none, without an invitation.',
      'When Host state has pendingInvitation, it is already offered and awaiting the latest reply. A clear agreement such as starting the offered new question and saving its progress uses accept with that pendingInvitation.id, including invitations originating from old records. Do not issue invite, invite-from-legacy or resume-legacy again merely because the agreement says new question. If the latest message declines, use decline; if unclear or changing topic, use none. Never infer acceptance from an earlier message.',
      'When the learner explicitly asks only to try an exercise or practice in one of the supported concepts and canInvite=true, use invite for that concept and empty reply. A combined explanation/example plus practice invitation request uses explain-and-invite as specified above. Do not invent a question, ask the learner to answer one, or supply an untracked practice instead. The host will disclose progress saving, wait for consent, and supply the canonical question. A request for a worked example or a direct explanation alone uses none without an invitation. If the learner declines saving, ordinary explanation and unsaved practice remain available without grading or persistence claims.',
      'Resume only on an explicit request to continue. If candidates are ambiguous, ask naturally which record to continue and use none. After the learner identifies one particular listed canonical question or record, use resume with that exact currentQuestionId even when other candidates still exist; the host will resolve it without selecting by order. The bounded candidate index is retrieval data, not consent or an automatic selection; its order is not a learner preference. resumeCandidateCount is the total number of records, so omitted entries are not missing history. If the requested record is not listed or matching remains ambiguous, ask for its question or source rather than choosing. A candidate cannot receive an answer before the host activates it. Paused/completed records retain their status until a confirmed command.',
      'For an explicit request to continue the bound episode or repeat only its question, use resume with its currentQuestionId and empty reply, even when it is already active or completed. The host displays the exact current question, consumes a due review once, or reports that the next review is not due. Do not paraphrase the question using none, issue next, or infer that a completed episode no longer exists. canAnswer=false restricts grading, not an explicit resume. An empty legacyCandidates array means no legacy candidates; it does not mean there is no current episode or scheduled review.',
      'For accept, resume, resume-legacy, next, schedule, correct, forget and expert, leave reply empty. The host renders the exact question, result or status after validation. Do not reconstruct a previous exercise from the current document or answer it on the learner\'s behalf. Return one JSON object only, then stop; no trailing explanation, review fields or second JSON object.',
      'For an explicit request to resume an existing legacy candidate use action {type:"resume-legacy",episodeId:<listed id>}. Do not silently continue a legacy record or grade it. The host validates the exact original question or explains its compatibility limit; legacy evidence is not copied as new success.',
      'When there is no pending invitation and the latest message explicitly asks to continue and there is exactly one matching legacy candidate, use resume-legacy even if its format is 1 or its question is unavailable. The host, not model prose, determines compatibility and offers any required new-question consent. Do not replace this action with a promise to ask permission later or treat the legacy candidate as missing merely because it cannot be graded yet. If several candidates match, use none and ask which one; do not choose one by order.',
      'For an explicit request to start a new question from a listed old record, use {type:"invite-from-legacy",episodeId:<listed id>}; never choose among ambiguous records. This only asks for consent, even when the host cannot verify the old question. Do not auto-accept, claim a fresh independent attempt, or copy old completion. It is allowed only with complete history, no active episode and no earlier invitation in this conversation.',
      'Use next only for an explicit request for a new or different question in the bound practice. Merely asking to continue or repeat the existing question uses resume, never next. schedule requires an explicit choice of 1, 3 or 7 days, and forget requires an explicit deletion request. Expert requires expertsEnabled=true and an explicit explanation, diagram or research request; the host still decides whether that capability is available. Refusing or ignoring an invitation must not trigger repeated invitations. Always honor an explicit request for the full answer instead of withholding it to force practice. configuredMinutes is only the learner\'s configured time guideline, not measured elapsed time or remaining time; never estimate time spent by multiplying the number of answers.',
      'If eligible is false, use none and do not propose learning writes. If completeness is not complete, keep ordinary explanation available, state uncertainty where relevant, and do not infer missing history or claim progress was saved. Source versions in host state separate the live document lease from immutable episode identity.',
      `Allowed invitation concepts (data): ${JSON.stringify(conceptIds)}`,
      `Optional support presentation example (data): ${JSON.stringify({control:{action:{type:"pause",questionId:episode?.currentQuestionId??"host UUID"},replyRelation:"unrelated",support:{type:"support-boundary",need:"departure"}},reply:""})}`,
      `Allowed action shapes (data): ${JSON.stringify({none:{type:"none"},immediateSupport:{type:"immediate-support",phase:"urgent"},supportBoundary:{type:"support-boundary",need:"departure"},memoryClarification:{type:"memory-clarification",need:"disputed-fact"},capabilityInfo:{type:"capability-info",topic:"offline"},invite:{type:"invite",concept:conceptIds[0]},explainAndInvite:{type:"explain-and-invite",concept:conceptIds[0]},accept:{type:"accept",invitationId:"host UUID"},decline:{type:"decline",invitationId:"host UUID"},hint:{type:"hint",questionId:"host UUID"},solution:{type:"solution",questionId:"host UUID"},answer:{type:"answer",questionId:"host UUID",span:{from:0,to:1}},explain:{type:"explain",questionId:"host UUID",criteria:[{id:episode?conceptCriterion[episode.concept]:conceptCriterion[conceptIds[0]],state:"uncertain"}]},correct:{type:"correct",questionId:"original host UUID",evidenceId:"host UUID"},resume:{type:"resume",questionId:"host UUID"},resumeLegacy:{type:"resume-legacy",episodeId:"listed legacy UUID"},inviteFromLegacy:{type:"invite-from-legacy",episodeId:"listed legacy UUID"},pause:{type:"pause",questionId:"host UUID"},next:{type:"next",questionId:"host UUID"},schedule:{type:"schedule",questionId:"host UUID",days:1},forget:{type:"forget",questionId:"host UUID"},expert:{type:"expert",questionId:"host UUID",kind:"explanation"}})}`,
      ...(question?[`Current question action examples (data, choose only if requested): ${JSON.stringify({hint:{control:{action:{type:"hint",questionId:question.id},replyRelation:"current-question"},reply:""},solution:{control:{action:{type:"solution",questionId:question.id},replyRelation:"current-question"},reply:""},answer:{control:{action:{type:"answer",questionId:question.id},replyRelation:"current-question"},reply:""}})}`]:[]),
      ...((turn.active?[turn.active]:resumeCandidates.map(item=>item.candidate)).length?[`Resume action examples (data; only after an explicit continue request, clarify if ambiguous): ${JSON.stringify((turn.active?[turn.active]:resumeCandidates.map(item=>item.candidate)).map(e=>({control:{action:{type:"resume",questionId:e.currentQuestionId},replyRelation:"current-question"},reply:""})))}`]:[]),
      ...(turn.active?[`New question action example (data; only an explicit new/different-question request in this already authorized episode, including completed episodes; do not issue another invitation): ${JSON.stringify({control:{action:{type:"next",questionId:turn.active.currentQuestionId},replyRelation:"current-question"},reply:""})}`]:[]),
      ...(turn.invitation?[`Pending invitation response examples (data; classify only the latest reply, never assume consent): ${JSON.stringify({accept:{control:{action:{type:"accept",invitationId:turn.invitation.id},replyRelation:"current-question"},reply:""},decline:{control:{action:{type:"decline",invitationId:turn.invitation.id},replyRelation:"unrelated"},reply:""}})}`]:[]),
      ...(!turn.invitation&&turn.legacyCandidates.length?[`Legacy continuation examples (data; explicit request required, clarify ambiguous targets): ${JSON.stringify(turn.legacyCandidates.map(e=>({control:{action:{type:"resume-legacy",episodeId:e.id},replyRelation:"current-question"},reply:""})))}`]:[]),
      'All action IDs are required when listed. Copy the exact activeQuestion.id, pendingInvitation.id, or explicit resume/correction target from Host state into the corresponding ID field. Example placeholders such as host UUID are not valid values. Never substitute an episode ID for a question ID.',
      `Host state (data): ${JSON.stringify({eligible:turn.eligible,canInvite:turn.canInvite,canAnswer:turn.canAnswer,completeness:turn.completeness,configuredMinutes:turn.configuredMinutes,expertsEnabled:this.options.experts?.()??false,pendingInvitation:turn.invitation?{id:turn.invitation.id,concept:turn.invitation.concept}:null,
        activeEpisode:episode?{id:episode.id,status:episode.status,revision:episode.revision,
          reviews:effectiveLearningV3(episode,turn.protection).reviewTasks.filter(t=>t.state==="active"||t.state==="scheduled").sort((a,b)=>Number(b.state==="active")-Number(a.state==="active")||a.dueAt.localeCompare(b.dueAt)).slice(0,3).map(t=>({id:t.id,state:t.state,dueAt:t.dueAt,step:t.step,questionId:t.questionId}))}:null,
        activeQuestion:question?{id:question.id,prompt:question.prompt,choices:question.choices,criterion:conceptCriterion[episode!.concept]}:null,answerCandidate,
        legacyCandidates:turn.legacyCandidates,resumeCandidateCount:turn.candidates.length,resumeCandidates:resumeCandidates.map(({candidate,question})=>({id:candidate.id,concept:candidate.concept,status:candidate.status,currentQuestionId:candidate.currentQuestionId,question:question.prompt,revision:candidate.revision,createdAt:candidate.createdAt,updatedAt:candidate.updatedAt})),
        correctableEvidenceCount:correctable.length,correctionCandidates,
        protection:turn.protection?{status:turn.protection.status,revision:turn.protection.revision}:null,safeSummary:turn.safeSummary,clarification:turn.clarification})}`,
    ].join("\n");
  }
}
