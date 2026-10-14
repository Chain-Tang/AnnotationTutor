import { parseLearningControlV3, validateLearningBinding, type LearningControlV3 } from "./learning-control-v3.js";
import { LearningDialogueV3, type DialogueTurnV3 } from "./learning-dialogue-v3.js";
import { learningPhaseId, type LearningCommandBinding, type LearningCommandResult, type LearningHelpTicket } from "./learning-commands-v3.js";
import { TeachingStreamV3, TEACHING_CONTROL_SCHEMA_ISSUES, type TeachingEnvelopeV3 } from "./learning-stream-v3.js";
import { LearningReplyGate, type LearningReplyPlan, type LearningPresentationObservation } from "./learning-reply-gate.js";
import { extractMathAnswer } from "./learning-answer-extract.js";
import { effectiveLearningV3 } from "./learning-effective-v3.js";
import { renderQuestionV3, type EpisodeV3, type HelpExposureV3 } from "./learning-v3.js";
import { lessonFor } from "./learning-episode.js";
import { hostSupportReply, supportStorageLease, type SupportStorageContext } from "./support-response.js";

type Options = {
  dialogue:LearningDialogueV3;turn:DialogueTurnV3;signal:AbortSignal;
  priorReplies?:readonly string[];
  storageContext?:()=>SupportStorageContext;
  transport(instructions:string,onDelta:(delta:string)=>void):Promise<{text:string}>;
  present(delta:string):boolean|void;
  /** Reserves one additional model call; may throw if the host budget is exhausted.
   * Contains only a bounded parser code, never the rejected model response. */
  onProtocolCorrection?(input:{attempt:1;errorCode:string}):void|Promise<void>;
  /** Checks live document and foreign evidence changes, not this request's own
   * committed phases. No learning mutation may bypass this host lease. */
  ensureCurrent():Promise<void>;
  ownCommit?(result:LearningCommandResult):Promise<void>|void;
  minutes?:number;
  resumeLegacy?(episodeId:string):Promise<{result?:LearningCommandResult;message?:string;needsNewQuestion?:boolean}>;
  expert?(input:{episode:EpisodeV3;kind:"explanation"|"diagram"|"research";signal:AbortSignal}):Promise<string|{text:string;commit?:LearningCommandResult}>;
};
export type LearningRunResultV3={text:string;/** Annotation append must call this only after real presentation. */confirmProvided():Promise<void>};
const formatQuestion=(e:EpisodeV3)=>{const q=renderQuestionV3(e.questions.find(q=>q.id===e.currentQuestionId)!);return q.prompt+(q.choices?"\n"+q.choices.map((c,i)=>`${String.fromCharCode(65+i)}. ${c}`).join("\n"):"");};
// Only syntax, pure schema structure and the captured invitation availability can be corrected here. Rejected permissions/bindings, consumer
// failures, resource limits and transport failures must retain their cause.
const correctableProtocolErrors=new Set([...TEACHING_CONTROL_SCHEMA_ISSUES.map(issue=>"teaching-control-schema-"+issue),"teaching-envelope-invalid","teaching-envelope-key-invalid","teaching-control-object-required","teaching-control-invalid","teaching-reply-escape-invalid","teaching-reply-unicode-invalid","teaching-reply-control-character","teaching-reply-string-required","teaching-envelope-extra-field","teaching-envelope-trailing-content","teaching-envelope-incomplete"]);
const protocolCorrection="\nFORMAT CORRECTION (the one allowed retry): The previous response did not form exactly one complete schema-valid JSON envelope. Use only the documented action fields and copy target IDs exactly from current Host state; do not use placeholders or omit required IDs. Reconsider the same learner request using the same permitted actions and bindings. Return only one JSON object with exactly ordered keys control then reply, using the schema above. Stop immediately after the final closing brace. Do not add prose, markdown fences, another JSON object, or any other suffix. Do not repeat a purported previous result; no prior command from this response was applied.";

/** The same bounded model protocol is usable by the sidebar and annotation
 * presenter. Only fixed commands write evidence; model prose stays in chat. */
export async function runLearningTurnV3(options:Options):Promise<LearningRunResultV3>{
  const {turn,dialogue,signal}=options,commands=dialogue.commands;
  if(!turn.eligible||!turn.authority)throw new Error("learning-local-conversation-required");
  let current=turn.active,text="";
  const storage=supportStorageLease(options.storageContext);
  const tickets=new Map<string,LearningHelpTicket>();
  const offered=new Set<string>(),confirmations=new Map<string,LearningPresentationObservation["state"]>();
  const assertCurrent=()=>{if(signal.aborted)throw new DOMException("Learning turn cancelled","AbortError");storage.assertCurrent();dialogue.assertCurrent(turn);};
  const committed=async(result:LearningCommandResult)=>{current=result.episode;await options.ownCommit?.(result);dialogue.bindCommitted(turn,result);return result;};
  const check=async()=>{assertCurrent();await options.ensureCurrent();assertCurrent();};
  const bind=(episode=current,questionId=episode?.currentQuestionId):LearningCommandBinding=>{
    if(!episode||!questionId)throw new Error("learning-question-unavailable");
    return {authority:turn.authority!,requestId:turn.requestId,episodeId:episode.id,questionId,expectedRevision:episode.revision,source:{...episode.source}};
  };
  const presenter={present:async(input:{text:string;presentationId:string;signal:AbortSignal}):Promise<LearningPresentationObservation>=>{
    await check();const provided=options.present(input.text);text+=input.text;offered.add(input.presentationId);
    return {state:provided===true?"provided":"unknown",presentationId:input.presentationId};
  }};
  const confirm=async(ticket:LearningHelpTicket,observation:LearningPresentationObservation)=>{
    // This cleanup records a fact already provided. It must still work after
    // cancelling generation; the store's deletion/source guards remain active.
    if(confirmations.get(ticket.presentationId)==="provided"||confirmations.get(ticket.presentationId)===observation.state)return;
    const result=await commands.confirmHelp(ticket,turn.authority!,observation.state==="provided"?"presented":"unknown");
    current=result.episode;tickets.set(ticket.presentationId,ticket);confirmations.set(ticket.presentationId,observation.state);await options.ownCommit?.(result);
  };
  const rememberHelp=(result:LearningCommandResult,presentationId:string)=>{const ticket=commands.ticket(result,presentationId,turn.requestId);tickets.set(presentationId,ticket);return ticket;};
  const preparedPlan=(ticket:LearningHelpTicket):LearningReplyPlan<LearningHelpTicket>=>({mode:"stream",presentationId:ticket.presentationId,help:{beforeHelp:async()=>ticket,confirmPresentation:confirm}});
  const prepareHelp=async(presentationId:string,kind:HelpExposureV3["kind"])=>{
    await check();const result=await commands.prepareHelp(bind(),kind,presentationId,signal),ticket=rememberHelp(result,presentationId);
    // Keep the ticket before host notifications: the save may be durable even
    // when a later lease check or ownCommit callback rejects this request.
    await committed(result);return ticket;
  };
  const helpPlan=(presentationId:string,kind:HelpExposureV3["kind"],mode:"stream"|"buffer"="stream"):LearningReplyPlan<LearningHelpTicket>=>({mode,presentationId,help:{
    beforeHelp:async()=>prepareHelp(presentationId,kind),confirmPresentation:confirm,
  }});
  await check();
  // A retry of the same captured request must find its saved receipt. Distinct
  // action phases retain distinct identities, even when they share a request.
  const presentationKinds=["discussion","hint","solution","answer","explain","pause","expert"] as const;
  const presentations=new Map(await Promise.all(presentationKinds.map(async kind=>[kind,await learningPhaseId(turn.requestId,"help",["presentation",kind])] as const)));
  let gate:LearningReplyGate<LearningControlV3,LearningHelpTicket>|undefined;
  const generateEnvelope=async():Promise<TeachingEnvelopeV3<LearningControlV3>|undefined>=>{
    const instructions=dialogue.instructions(turn)+storage.instructions;
    let repairDetail="";
    for(let attempt=0;attempt<2;attempt++){
      let parserFailure:Error|undefined,meaningfulContent=false,accepting=true;
      // Each attempt owns its parser, reply buffer and gate. Late callbacks from
      // a settled transport cannot enter the replacement attempt.
      const attemptGate=new LearningReplyGate<LearningControlV3,LearningHelpTicket>({signal,presenter,plan:control=>{
        const action=control.action;
        validateLearningBinding(control,action.type==="resume"?dialogue.resumeTarget(turn,action.questionId):turn.active);
        // Pure invitations use only host prose. A compound request keeps its
        // conceptual reply, without creating consent before full completion.
        if(control.support||action.type!=="none"&&action.type!=="explain-and-invite")return {mode:"suppress",presentationId:crypto.randomUUID()};
        const presentationId=presentations.get("discussion")!;
        return turn.active&&turn.active.status!=="deleted"&&control.replyRelation!=="unrelated"?helpPlan(presentationId,"related-discussion"):{mode:"stream",presentationId};
      }});
      gate=attemptGate;
      let leadingReply="",replyStarted=false;
      const stream=new TeachingStreamV3({validateControl:value=>parseLearningControlV3(value,{canInvite:turn.canInvite}),onControl:control=>attemptGate.acceptControl(control),onReply:delta=>{
        // Whitespace alone is not help. Keep it bounded inside this attempt.
        if(!replyStarted){leadingReply+=delta;if(!leadingReply.trim())return;replyStarted=true;attemptGate.enqueue(leadingReply);leadingReply="";}
        else attemptGate.enqueue(delta);
      },onError:error=>{parserFailure=error;attemptGate.abort(error);}});
      try{
        await check();
        const result=await options.transport(instructions+(attempt?protocolCorrection+repairDetail:""),delta=>{
          if(!accepting)return;
          assertCurrent();meaningfulContent ||= delta.trim().length>0;stream.push(delta);
        });
        // A transport may ignore cancellation or return the full response after
        // streaming it. Neither case may parse or append those bytes twice.
        assertCurrent();
        if(!stream.received&&!result.text){attemptGate.abort();await attemptGate.finish().catch(()=>{});return undefined;}
        if(!stream.received&&result.text){meaningfulContent=result.text.trim().length>0;stream.push(result.text);}
        const envelope=stream.finish();await attemptGate.finish();await check();return envelope;
      }catch(error){
        accepting=false;attemptGate.abort(error);await attemptGate.finish().catch(()=>{});
        const outcome=attemptGate.status();
        // Some transports wrap the parser's exception in Error(message). The
        // local onError receipt proves this attempt actually failed parsing;
        // a matching transport string alone is never enough to trigger retry.
        const safe=attempt===0&&parserFailure&&correctableProtocolErrors.has(parserFailure.message)&&
          error instanceof Error&&error.message===parserFailure.message&&error.name!=="AbortError"&&meaningfulContent&&
          outcome.offeredChars===0&&outcome.preparation==="not-started"&&tickets.size===0&&text.length===0;
        if(!safe||!parserFailure)throw error;
        const issue=TEACHING_CONTROL_SCHEMA_ISSUES.find(issue=>parserFailure!.message==="teaching-control-schema-"+issue);
        repairDetail=issue==='invitation-unavailable'?'\nThe captured Host state has canInvite=false, so action invite is unavailable. Reclassify only the latest learner message using the existing permitted bindings; do not invent an invitation or infer consent. If it explicitly requests a new/different question in activeEpisode, use next with activeQuestion.id and empty reply. A continue/repeat request uses resume; ordinary conversation uses none. No prior reply, invitation or learning write from this response was applied.':
          issue==="reply-relation"?'\nThe rejected field is control.replyRelation. Include it as a sibling of action, not inside action; its value must be exactly one JSON string: "unrelated", "current-question", or "uncertain". For resuming the specified exercise, use "current-question".':
          issue==="question-id"?'\nThe rejected field is control.action.questionId. Include the exact UUID from the activeQuestion or explicitly requested resume candidate in Host state. Do not use an episode ID, placeholder or omit it.':
          issue==='invitation-id'?'\nThe rejected field is control.action.invitationId. Use the exact listed pending invitation UUID only for explicit acceptance or decline; if none is available, use action none.':
          issue?'\nThe control schema was rejected. Recheck the exact action fields in Allowed action shapes against Host state; do not add any unlisted fields.':"";
        await check();await options.onProtocolCorrection?.({attempt:1,errorCode:parserFailure.message});await check();
      }finally{accepting=false;}
    }
    throw new Error("teaching-envelope-invalid");
  };
  const hostText=async(value:string,plan?:LearningReplyPlan<LearningHelpTicket>)=>{
    if(!value)return;
    const host=new LearningReplyGate({signal,presenter,plan:()=>plan??{mode:"stream",presentationId:crypto.randomUUID()}});
    try{host.acceptControl(undefined);host.enqueue((text?"\n\n":"")+value);await host.finish();}
    catch(error){host.abort(error);await host.finish().catch(()=>{});throw error;}
  };
  const completed=():LearningRunResultV3=>({text,confirmProvided:async()=>{for(const ticket of tickets.values())if(offered.has(ticket.presentationId))await confirm(ticket,{state:"provided",presentationId:ticket.presentationId});}});
  const emptyReply="这次没有收到可显示的回复。你可以再说一下希望我解释或继续哪一部分。";
  const offerLegacy=async(episodeId:string,message?:string)=>{
    await check();
    const invitation=await dialogue.offerLegacy(turn,episodeId);
    try{
      await check();
      await hostText((message?.trim()?message.trim()+"\n":"")+`要不要围绕“${lessonFor(invitation.concept).title}”换一道新题？你愿意的话，我会保存这次练习进度，方便下次继续。原来的记录仍保留，也可以继续讨论原题。`);
    }catch(error){
      // A cancelled, undisplayed invitation must not make a later short reply
      // silently authorize a record. A newer turn owns its own consent lease.
      try{dialogue.settle(turn,{control:{action:{type:"none"},replyRelation:"unrelated"},reply:""});}catch{/* Superseded turns cannot alter the new conversation. */}
      throw error;
    }
  };
  try{
    const envelope=await generateEnvelope();
    if(!envelope){await hostText(emptyReply);return completed();}
    const action=envelope.control.action;
    if(!["accept","invite","explain-and-invite","invite-from-legacy","resume-legacy"].includes(action.type))dialogue.settle(turn,envelope);
    if(action.type==="none"&&envelope.control.support){
      await hostText(hostSupportReply(envelope.control.support,turn.text,options.priorReplies,options.storageContext?.())!);
    }else if(action.type==="immediate-support"||action.type==="support-boundary"||action.type==="memory-clarification"||action.type==="capability-info"){
      await hostText(hostSupportReply(action,turn.text,options.priorReplies,options.storageContext?.())!);
    }else if(action.type==="invite"||action.type==="explain-and-invite"){
      const invitation=dialogue.offer(turn,envelope);
      try{
        await hostText(`要不要试一道“${lessonFor(invitation.concept).title}”的小题？你愿意的话，我会保存这次练习进度，方便下次继续；也可以直接聊下去。`);
      }catch(error){
        // A failed/cancelled disclosure cannot make a later short reply consent.
        try{dialogue.settle(turn,{control:{action:{type:"none"},replyRelation:"unrelated"},reply:""});}catch{/* A newer turn owns its own invitation. */}
        throw error;
      }
    }else if(action.type==="invite-from-legacy"){
      await offerLegacy(action.episodeId);
    }else if(action.type==="accept"){
      const accepted=await dialogue.accept(turn,envelope,signal);current=accepted.episode;await options.ownCommit?.(accepted);
      await hostText(formatQuestion(accepted.episode));
    }else if(action.type==="decline"){
      await hostText(envelope.reply.trim()?envelope.reply:"好，我们继续聊你关心的内容；这次不开始练习。" );
    }else if(action.type==="resume-legacy"){
      if(!turn.legacyCandidates.some(record=>record.id===action.episodeId))throw new Error("learning-legacy-target-unavailable");
      await check();const resumed=await options.resumeLegacy?.(action.episodeId);
      if(resumed?.result){dialogue.settle(turn,envelope);await committed(resumed.result);await hostText("接着这道旧题继续；旧记录仍保留，之前是否看到过帮助暂不作无提示判断。\n"+formatQuestion(resumed.result.episode));}
      else if(resumed?.needsNewQuestion)await offerLegacy(action.episodeId,resumed.message);
      else{await check();dialogue.settle(turn,envelope);await hostText(resumed?.message??"这份旧练习暂不能可靠地续记。旧记录仍可查看，也可以继续讨论原题。");}
    }else if(action.type==="resume"){
      const target=dialogue.resumeTarget(turn,action.questionId);
      if(!target)await hostText(turn.clarification??"我还不能确定你要继续哪次练习，可以告诉我题目或来源。");
      else{
        const tasks=effectiveLearningV3(target,turn.protectionByEpisode.get(target.id)).reviewTasks;
        const review=tasks.find(t=>t.state==="active")??tasks.filter(t=>t.state==="scheduled").sort((a,b)=>a.dueAt.localeCompare(b.dueAt))[0];
        const resumed=await committed(await commands.resume(bind(target),signal,review?.id));
        await hostText(resumed.episode.status==="completed"?(review?.state==="scheduled"
          ?"这次练习已完成，下次检查还没到时间。你也可以另换一道题，或先休息。"
          :"这次练习已完成，目前没有安排后续检查。你也可以另换一道题，或先休息。") :formatQuestion(resumed.episode));
      }
    }else if(action.type==="hint"||action.type==="solution"){
      const q=renderQuestionV3(current!.questions.find(q=>q.id===action.questionId)!);
      await hostText(action.type==="hint"?q.hint:`${q.answer}。${q.explanation}`,helpPlan(presentations.get(action.type)!,action.type==="hint"?"hint":"solution"));
    }else if(action.type==="answer"){
      if(!turn.canAnswer)throw new Error("learning-question-inactive");
      const question=renderQuestionV3(current!.questions.find(q=>q.id===action.questionId)!);
      // Whole-utterance extraction proves its own bounded source. A redundant
      // model offset cannot veto that proof or authorize a substring of prose.
      const whole=extractMathAnswer(question,turn.text);
      const extracted=whole.kind==='answer'||!action.span?whole:extractMathAnswer(question,turn.text,{start:action.span.from,end:action.span.to,text:turn.text.slice(action.span.from,action.span.to)});
      if(extracted.kind!=="answer")await hostText("我还不能把这句话可靠地记为答案。可以继续解释你的思路，或明确一下最终结果；本轮没有记成错误。");
      else{
        const presentationId=presentations.get("answer")!,saved=await commands.answer(bind(),extracted.answer,presentationId,signal,{remainingMinutes:options.minutes??20});
        const ticket=rememberHelp(saved,presentationId);await committed(saved);
        const evidence=saved.episode.evidence.find(e=>e.requestId===saved.phaseId&&e.type==="answer")!;
        let feedback=(evidence.outcome==="correct"?"这次计算正确。":"我们再看一下。")+question.explanation;
        if(saved.episode.currentQuestionId!==question.id)feedback+=saved.episode.status==="paused"?"新情境的题已保留，下次可以继续。":"\n换一种情境："+formatQuestion(saved.episode);
        else if(saved.episode.status==="completed")feedback+="\n这次进度已保存。以后继续相关学习时，可以再用新题检查；现在也可以休息。";
        await hostText(feedback,preparedPlan(ticket));
      }
    }else if(action.type==="explain"){
      if(!turn.canAnswer)throw new Error("learning-question-inactive");
      const presentationId=presentations.get("explain")!,saved=await commands.judgment(bind(),action.criteria,presentationId,signal),ticket=rememberHelp(saved,presentationId);await committed(saved);
      await hostText(`Tutor 判断（可纠正）：${envelope.reply.trim()?envelope.reply:"这份解释还需要进一步核对。"}\n本轮只记录题目相关判据，解释原文没有自动保存为学习证据。`,preparedPlan(ticket));
    }else if(action.type==="correct"){
      await committed(await commands.correct(bind(current,action.questionId),action.evidenceId,signal));
      await hostText("谢谢你指出来。旧判断及依赖它的检查结论已标为需要重新核对，后来的作答仍保留。");
    }else if(action.type==="pause"){
      const support=envelope.control.support;
      const ticket=!support&&envelope.reply.trim()&&envelope.control.replyRelation!=="unrelated"?await prepareHelp(presentations.get("pause")!,"related-discussion"):undefined;
      // Immediate guidance must not wait for a learning save. A failed save
      // can then report failure without falsely claiming the pause completed.
      if(support?.type==="immediate-support")await hostText(hostSupportReply(support,turn.text,options.priorReplies,options.storageContext?.())!);
      await check();await committed(await commands.pause(bind(),signal));
      await hostText(support?("今天先到这里，已有进度会保留。"+(support.type==="immediate-support"?"":"\n\n"+hostSupportReply(support,turn.text,options.priorReplies,options.storageContext?.()))):
        (envelope.reply.trim()?envelope.reply+"\n":"")+"今天先到这里，已有进度会保留。",ticket?preparedPlan(ticket):undefined);
    }else if(action.type==="next"){
      const saved=await committed(await commands.next(bind(),signal));await hostText(formatQuestion(saved.episode));
    }else if(action.type==="schedule"){
      await committed(await commands.schedule(bind(),action.days,signal));await hostText(`已安排约 ${action.days} 天后，在你继续相关学习时再检查；不会发送后台通知。`);
    }else if(action.type==="forget"){
      const saved=await commands.forget(bind(),signal);current=saved.episode;await options.ownCommit?.(saved);
      // Keep this request's display lease just long enough for the factual
      // deletion receipt, then clear the conversation even if display fails.
      try{await hostText("已停止使用这次学习记录。已有聊天和作品按各自的保存设置保留。");}
      finally{dialogue.expireConversation(turn.conversationId);}
    }else if(action.type==="expert"){
      if(!options.expert)await hostText("独立专家协作目前不可用，我可以先帮你核对，不会把未完成的检查说成通过。");
      else{
        const ticket=await prepareHelp(presentations.get("expert")!,"related-discussion");await check();
        const response=await options.expert({episode:structuredClone(current!),kind:action.kind,signal});
        if(typeof response!=="string"&&response.commit)await committed(response.commit);
        const reply=typeof response==="string"?response:response.text;await check();
        if(reply.trim())await hostText(reply,preparedPlan(ticket));
        else{await confirm(ticket,{state:"unknown",presentationId:ticket.presentationId});await hostText("专家这次没有返回可显示的回复；已有作品会保留，这次检查还不能算完成。");}
      }
    }
    if(!text.trim())await hostText(emptyReply);
    return completed();
  }catch(error){
    gate?.abort(error);await gate?.finish().catch(()=>{});
    for(const ticket of tickets.values())await confirm(ticket,{state:"unknown",presentationId:ticket.presentationId}).catch(()=>{});
    throw error;
  }
}
