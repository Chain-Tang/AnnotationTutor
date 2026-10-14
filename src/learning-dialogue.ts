import { z } from "zod";
import { conceptIds, gradeMathAnswer, lessonFor, type ConceptId, type LearningEpisode } from "./learning-episode.js";
import { LearningV2Store, createEpisodeV2, type EpisodeV2 } from "./learning-v2.js";
import { instantiateQuestion, nextQuestion } from "./learning-question-bank.js";
import { learningContext } from "./learning-context.js";
import { canonicalLegacyQuestion, safeLegacyEvidence } from "./learning-safe-projection.js";
import { combineRecordReadResults, completeRecordReadResult, type RecordReadResult, type RecordCompleteness } from "./learning-record-read.js";

export const teachingActionSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("invite"),concept:z.enum(conceptIds)}).strict(),
  z.object({type:z.enum(["accept","decline","hint","answer","pause","resume","solution","forget","next"])}).strict(),
  z.object({type:z.literal("correct"),evidenceId:z.string().uuid()}).strict(),
  z.object({type:z.literal("expert"),kind:z.enum(["explanation","diagram","research"])}).strict(),
  z.object({type:z.literal("explain"),attempt:z.string().max(600).optional(),feedback:z.string().min(1).max(2000)}).strict(),
  z.object({type:z.literal("schedule"),days:z.number().int().min(1).max(90)}).strict(),
  z.object({type:z.literal("none")}).strict(),
]);
export type TeachingAction = z.infer<typeof teachingActionSchema>;
const teachingEnvelope = z.object({action:teachingActionSchema,reply:z.string().max(24000)}).strict();
/** Decode only the reply string of a validated JSON control envelope, across arbitrary SSE boundaries. */
export class TeachingStream {
  private raw=""; private action?:TeachingAction; text=""; received=false;
  constructor(private emit:(delta:string)=>void,private holdProse=false){}
  push(delta:string){
    this.received=true;this.raw+=delta;if(this.raw.length>40000)throw new Error("teaching-control-too-large");
    if(!this.action){
      const prefix=/^\s*\{\s*"action"\s*:\s*/.exec(this.raw);
      if(prefix){const start=prefix[0].length;let depth=0,quote=false,escape=false;
        for(let i=start;i<this.raw.length;i++){const c=this.raw[i]!;if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;continue;}
          if(c==='"')quote=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){const checked=teachingActionSchema.safeParse(JSON.parse(this.raw.slice(start,i+1)));if(!checked.success)throw new Error("Tutor 的学习动作未通过校验，本轮没有记录成绩。");this.action=checked.data;break;}}
      }
    }
    if(!this.action)return;
    const match=/"reply"\s*:\s*"/.exec(this.raw);if(!match)return;
    let decoded="",i=match.index+match[0].length;
    for(;i<this.raw.length;i++){const c=this.raw[i]!;if(c==='"')break;
      if(c==='\\'){const n=this.raw[i+1];if(!n)break;if(n==='u'){if(i+6>this.raw.length)break;decoded+=JSON.parse('"'+this.raw.slice(i,i+6)+'"');i+=5;}else{decoded+=JSON.parse('"'+this.raw.slice(i,i+2)+'"');i++;}}else decoded+=c;
    }
    if(this.action.type!=="none"&&this.action.type!=="invite"&&this.action.type!=="pause")return;
    const addition=decoded.slice(this.text.length);this.text=decoded;if(!this.holdProse&&addition)this.emit(addition);
  }
  finish():TeachingAction {
    const checked=teachingEnvelope.safeParse((()=>{try{return JSON.parse(this.raw);}catch{return null;}})());
    if(!checked.success)throw new Error("Tutor 的学习回复不完整，本轮未记录。请继续提问或重试。");
    this.action=checked.data.action;
    if(this.action.type==="none"||this.action.type==="invite"||this.action.type==="pause"){
      const addition=checked.data.reply.slice(this.text.length);this.text=checked.data.reply;if(!this.holdProse&&addition)this.emit(addition);
    }
    return this.action;
  }
}
export type DialogueTurn = {
  conversationId:string;requestId:string;text:string;source:LearningEpisode["source"];
  epoch:number;episode?:EpisodeV2;legacy?:LearningEpisode;invitation?:ConceptId;canInvite:boolean;remainingMinutes:number;
  completeness:RecordCompleteness;learningRevision:string;
};
type Session = {source:string;version:string;offered:Set<ConceptId>;invitation?:ConceptId;activeId?:string};
/** One per vault, shared by sidebar and popouts; only consented mathematical work is persisted. */
export class LearningDialogue {
  private sessions=new Map<string,Session>();
  constructor(readonly store:LearningV2Store,private legacy:()=>Promise<LearningEpisode[]|RecordReadResult<LearningEpisode>>,private minutes:()=>number=()=>20,private experts:()=>boolean=()=>false){}
  reset(){this.sessions.clear();this.store.invalidate();}
  async prepare(input:{conversationId:string;requestId:string;text:string;source:LearningEpisode["source"];episodeId?:string}):Promise<DialogueTurn> {
    const read=await this.store.listResult(),oldInput=await this.legacy();
    const oldRead="records" in oldInput?oldInput:completeRecordReadResult(oldInput);
    const records=read.records,old=oldRead.records;
    let session=this.sessions.get(input.conversationId);
    if(!session){session={source:input.source.path,version:input.source.version,offered:new Set()};this.sessions.set(input.conversationId,session);}
    if(session.source!==input.source.path||session.version!==input.source.version){session.invitation=undefined;session.source=input.source.path;session.version=input.source.version;}
    const episode=records.find(e=>e.id===(input.episodeId??session.activeId)&&e.status!=="deleted");
    // Resume candidates are scoped to this document, never the globally active card.
    const related=records.filter(e=>e.source.path===input.source.path&&e.status!=="deleted");
    const legacy=old.filter(e=>e.source.path===input.source.path);
    const anchored=related.filter(e=>!!input.source.annotationId&&e.source.annotationId===input.source.annotationId);
    const candidate=episode ?? (anchored.length===1?anchored[0]:related.length===1?related[0]:undefined);
    const snapshot=learningContext(combineRecordReadResults<LearningEpisode|EpisodeV2>([read,oldRead]),{source:input.source.path,episodeId:input.episodeId??session.activeId,annotationId:input.source.annotationId});
    if(snapshot.completeness!=="complete")session.invitation=undefined;
    return {...input,epoch:this.store.epochFor(input.source.path,candidate?.id),episode:candidate,legacy:snapshot.completeness==="complete"&&!candidate&&legacy.length===1?legacy[0]:undefined,
      completeness:snapshot.completeness??"complete",learningRevision:snapshot.revision,
      remainingMinutes:Math.max(0,this.minutes()-records.flatMap(e=>e.evidence).filter(e=>new Date(e.at).toDateString()===new Date().toDateString()&&!e.corrects).length*5),
      invitation:session.invitation,canInvite:snapshot.completeness==="complete"&&!candidate&&!session.invitation&&session.offered.size===0};
  }
  instructions(turn:DialogueTurn):string {
    const q=turn.episode?canonicalLegacyQuestion(turn.episode,turn.episode.currentQuestionId):undefined;
    return [
      'You are connected to a learning application. Respond ONLY with a JSON object: {"action":{...},"reply":"..."}. Put action first, reply second. No markdown fences or other text. The application streams only the reply string to the learner; the action is hidden. Use {"type":"none"} for ordinary questions. The host prints all exercise questions, invitations, hints, solutions and grading feedback after validating the action. For accept, hint, answer, solution and resume, leave reply empty. For pause with distress, reply warmly to the actual need; the host records only paused status, never this prose. For invite, reply explains the concept but does not ask a question; the host supplies the invitation.',
      `The invite concept MUST be ONE string from: ${conceptIds.join(", ")}. Example: {"action":{"type":"invite","concept":"value-limit"},"reply":"极限看附近的趋势，函数值看某一点。"}. Pending invitation acceptance: {"action":{"type":"accept"},"reply":""}. Hint request: {"action":{"type":"hint"},"reply":""}.`,
      "Respect the approximate daily budget in host state. When it is exhausted, do not invite additional practice; offer to continue another day without pressure. If the learner explicitly requests more, honor their choice. Use semantic intent, not literal keywords. Ordinary unrelated questions: answer directly and action none. Distress: support first; pause an active exercise, do not grade or store the disclosure. Never turn a casual 'okay' into an answer.",
      "When learningCompleteness is partial or unavailable, do not infer that the learner has never studied, invent missing memories, or claim unavailable progress was saved. Continue explaining from the current materials. Do not invite or resume a missing record; say progress is temporarily unavailable when relevant.",
      `Available actions: ${JSON.stringify({invite:{type:"invite",concept:"value-limit"},accept:{type:"accept"},decline:{type:"decline"},answer:{type:"answer"},hint:{type:"hint"},solution:{type:"solution"},pause:{type:"pause"},resume:{type:"resume"},correct:{type:"correct",evidenceId:"exact ID"},expert:{type:"expert",kind:"explanation"},explain:{type:"explain",attempt:"exact mathematical quote from the learner, omit personal disclosures",feedback:"rubric-based Tutor judgment, cite the attempt; no objective score"},forget:{type:"forget"},next:{type:"next"},schedule:{type:"schedule",days:3},none:{type:"none"}})}.`,
      "Invite only if relevant to limits/continuity and helpful, never on distress or explicit answer-only requests. The host supplies the short invitation and progress-saving disclosure. Accept only an unambiguous conversational yes to the pending invitation; ignore or topic change means none. Resume only if the learner explicitly requests continuing. Do not independently answer the exercise unless the learner requested solution. For numeric/choice answers use answer; free reasoning uses explain. A memory dispute is correct with exact evidenceId or discuss uncertainty, not a new wrong answer. Forget only for explicit deletion of this learning record. Use expert only if expertsEnabled and the learner asks for an independent check or source suggestions; kind explanation, diagram or research. Never delegate distress or ordinary questions. Use next for an explicitly requested different exercise, schedule to change the review interval in days. If the user actively resumes relevant learning and reviewDue is past, mention the due check once without pressure and use resume only when they want to proceed.",
      `Host state (data): ${JSON.stringify({expertsEnabled:this.experts(),estimatedRemainingMinutes:turn.remainingMinutes,canInvite:turn.canInvite,learningCompleteness:turn.completeness,pendingInvitation:turn.invitation,episode:turn.episode?{id:turn.episode.id,status:turn.episode.status,concept:turn.episode.concept,reviewDue:turn.episode.reviewDue,evidence:safeLegacyEvidence(turn.episode).slice(-3)}:null,legacy:turn.legacy?{id:turn.legacy.id,concept:turn.legacy.concept}:null,question:q?{id:q.id,prompt:q.prompt,choices:q.choices,rubric:[lessonFor(turn.episode!.concept).goal]}:null})}`,
    ].join("\n");
  }
  async apply(turn:DialogueTurn,action:TeachingAction|undefined,signal:AbortSignal):Promise<string> {
    if(signal.aborted||turn.epoch!==this.store.epochFor(turn.source.path,turn.episode?.id))throw new DOMException("Learning context changed","AbortError");
    const session=this.sessions.get(turn.conversationId);if(!session)return "";
    let type=action?.type??"none";
    const activeQuestion=turn.episode?.questions.find(q=>q.id===turn.episode!.currentQuestionId);
    const literal=turn.text.trim();
    // With an active, bound question, an exact answer is authoritative. A model
    // must not reinterpret a choice such as “不相等” as disputing old evidence.
    if(turn.episode?.status==="active"&&activeQuestion&&["answer","explain","correct"].includes(type)&&
      (activeQuestion.kind==="number"?/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(literal):activeQuestion.choices?.includes(literal)))type="answer";
    if(type==="invite") {
      if(!turn.canInvite||action?.type!=="invite")return "";
      session.invitation=action.concept;session.offered.add(action.concept);
      return `\n\n要不要试一道“${lessonFor(action.concept).title}”小题？如果你愿意，我会保存这次练习的进度，方便下次继续；也可以直接聊下去。`;
    }
    if(type==="accept") {
      if(!turn.invitation)return "";
      const existing=(await this.store.list()).find(e=>e.requests.includes(turn.requestId));if(existing)return "";
      const prior=await this.store.list();
      const q=nextQuestion(turn.invitation,"practice",prior.filter(e=>e.concept===turn.invitation).flatMap(e=>e.questions));
      const saved=await this.store.save(createEpisodeV2(turn.source,q,{at:new Date().toISOString(),requestId:turn.requestId,conversationId:turn.conversationId}),signal,turn.requestId);
      session.activeId=saved.id;session.invitation=undefined;return `\n\n${q.prompt}${q.choices?"\n"+q.choices.join(" / "):""}`;
    }
    // A pending invitation is single-turn only. Ignoring it never means consent.
    session.invitation=undefined;
    if(type==="none"||type==="decline")return "";
    if(type==="resume"&&!turn.episode&&turn.legacy){
      const q=instantiateQuestion(turn.legacy.concept,"practice");
      const saved=await this.store.save(createEpisodeV2(turn.legacy.source,q,{at:new Date().toISOString(),requestId:turn.requestId,conversationId:turn.conversationId},turn.legacy),signal,turn.requestId);
      session.activeId=saved.id;return `\n\n接着之前的学习，换一道题试试。本次进度会保存在新的续学记录中。\n${q.prompt}`;
    }
    if(!turn.episode)return "";
    const current=(await this.store.list()).find(e=>e.id===turn.episode!.id);
    if(!current||current.status==="deleted"||current.revision!==turn.episode.revision)throw new Error("learning-v2-revision-conflict");
    if(current.requests.includes(turn.requestId))return "";
    const e=structuredClone(current),q=e.questions.find(q=>q.id===e.currentQuestionId)!;
    let reply="";
    switch(type){
      case "forget": e.status="deleted";e.evidence=[];reply="已停止使用这次学习记录。";break;
      case "pause": e.status="paused";reply="今天先到这里，已有进度会保留。";break;
      case "resume":
        if(e.status==="completed" && e.reviewDue && e.reviewDue>new Date().toISOString()){reply="这次练习已完成。下次检查还没到时间；也可以告诉我想换一道题，或先休息。";break;}
        if(e.reviewDue && e.reviewDue<=new Date().toISOString()){
          const unseen=nextQuestion(e.concept,"delayed",e.questions,e.questions.filter(q=>q.pool==="delayed").length);
          e.questions.push(unseen);e.currentQuestionId=unseen.id;reply=unseen.prompt;
        }else reply=q.prompt;
        e.status="active";session.activeId=e.id;break;
      case "next": {const next=nextQuestion(e.concept,"practice",e.questions,e.questions.length);e.questions.push(next);e.currentQuestionId=next.id;e.status="active";reply=next.prompt;break;}
      case "schedule": if(action?.type!=="schedule")return "";e.reviewDue=new Date(Date.now()+action.days*86400000).toISOString();reply=`已改为约 ${action.days} 天后，相关学习时再检查；不会发后台通知。`;break;
      case "hint": if(e.status!=="active")return "";q.hintCount++;reply=q.hint;break;
      case "solution": q.answerShown=true;reply=`${q.answer}。${q.explanation}`;break;
      case "correct": {
        if(action?.type!=="correct"||!e.evidence.some(x=>x.id===action.evidenceId))return "";
        e.evidence.push({id:crypto.randomUUID(),requestId:turn.requestId,at:new Date().toISOString(),questionId:q.id,answer:"学习者质疑此条判断，需重新验证。",help:{hints:0,answerShown:false},kind:"self-report",evaluator:"learner",outcome:"unreviewed",feedback:"旧判断已失效。",corrects:action.evidenceId});
        reply="谢谢你指出来。这条判断已标为需要重新核对，我不会继续把它当作已验证的事实。";break;
      }
      case "answer": case "explain": {
        if(e.status!=="active")return "";
        const text=turn.text.trim();
        const isSimple=q.kind==="number"?/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text):q.choices?.includes(text);
        if(type==="answer"&&!isSimple)return "\n\n我还不能把这句话可靠地记为作答。可以继续说明你的思路，不必急着给一个数字。";
        const explanationOnly=type==="explain"&&!isSimple;
        // Legacy v2 has arbitrary text fields. Until this turn is hosted by
        // the restricted v3 store, feedback is conversational only. A model's
        // classification or a keyword filter cannot authorize copying prose.
        if(explanationOnly)return `\n\nTutor 判断（可纠正）：${action?.type==="explain"?action.feedback:""}\n这份解释的原文没有自动保存为学习证据。`;
        const outcome=explanationOnly?"unreviewed":gradeMathAnswer({id:q.id,prompt:q.prompt,kind:q.kind as "number"|"choice",answer:q.answer,explanation:q.explanation},text)?"correct":"incorrect";
        const helped=q.hintCount>0||q.answerShown;
        e.evidence.push({id:crypto.randomUUID(),requestId:turn.requestId,at:new Date().toISOString(),questionId:q.id,answer:text,
          help:{hints:q.hintCount,answerShown:q.answerShown},kind:explanationOnly?"explanation":helped?"hinted":q.pool==="practice"?"unassisted":q.pool,
          evaluator:explanationOnly?"tutor":"deterministic",outcome,feedback:explanationOnly&&action?.type==="explain"?action.feedback:q.explanation});
        if(explanationOnly)reply=`Tutor 判断（可纠正）：${action?.type==="explain"?action.feedback:""}`;
        else {reply=(outcome==="correct"?"这次计算正确。":"我们再看一下。")+q.explanation;q.answerShown=true;
          if(outcome==="correct"&&q.pool==="practice") {const next=nextQuestion(e.concept,"transfer",e.questions,e.questions.length);e.questions.push(next);e.currentQuestionId=next.id;if(turn.remainingMinutes<=5){e.status="paused";reply+="今天预留的学习时间差不多了。新情境的题已经留好，下次可以继续；想现在继续也可以告诉我。";}else reply+=`\n换一种情境：${next.prompt}`;}
          else if(outcome==="correct"){
            e.status="completed";
            const days=q.pool==="delayed"&&!helped ? [3,7,0][Math.min(2,e.reviewStep)]! : 1;
            e.reviewStep=q.pool==="delayed"&&!helped ? Math.min(3,e.reviewStep+1) : 0;
            e.reviewDue=days?new Date(Date.now()+days*86400000).toISOString():undefined;
            reply+=days?`大约 ${days} 天后相关学习时，我们可以用一道新题再验证；现在也可以休息。`:"这组延迟检查已经完成，可以休息或探索新问题。";
          }else if(q.pool==="delayed"){e.status="completed";e.reviewStep=0;e.reviewDue=new Date(Date.now()+86400000).toISOString();reply+="先看这一步帮助，下一次相关学习时再换新题试试。";}}
        break;
      }
      default:return "";
    }
    e.requests.push(turn.requestId);await this.store.save(e,signal,turn.requestId);
    return reply?"\n\n"+reply:"";
  }
}
