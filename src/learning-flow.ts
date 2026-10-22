import { createEpisode, recordAttempt, lessonFor, type ConceptId, type LearningEpisode, LIMITS_PACK_VERSION } from "./learning-episode.js";
import { LearningEpisodeStore } from "./learning-episode-store.js";
import { safeLegacyEvidence } from "./learning-safe-projection.js";
import { canonicalMathAnswer } from "./learning-answer.js";
import { t } from "./i18n.js";
/** The plugin owns one instance across split views. Input drafts remain in the view. */
export class LearningFlow {
  episodes:LearningEpisode[]=[];
  activeId:string|null=null;
  busy=false;
  private undoState:LearningEpisode|null=null;
  private listeners=new Set<()=>void>();
  constructor(public readonly store:LearningEpisodeStore){}
  get active(){return this.episodes.find(e=>e.id===this.activeId);}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  notify(){for(const fn of this.listeners)fn();}
  async load(){this.episodes=await this.store.list();this.activeId??=this.episodes.find(e=>e.status!=="completed")?.id??this.episodes[0]?.id??null;this.notify();}
  select(id:string){if(this.busy)throw new Error("learning-busy");this.activeId=id;this.undoState=null;this.notify();}
  async start(source:LearningEpisode["source"],concept:ConceptId){if(this.busy)throw new Error("learning-busy");this.busy=true;this.notify();try{const result=await this.store.save(createEpisode(source,concept));this.episodes.unshift(result);this.activeId=result.id;this.undoState=null;}finally{this.busy=false;this.notify();}}
  async update(change:(episode:LearningEpisode)=>LearningEpisode){if(this.busy||!this.active)throw new Error("learning-busy-or-missing");const current=this.active;this.busy=true;this.notify();try{const result=await this.store.save(change(structuredClone(current)));this.episodes=this.episodes.map(e=>e.id===result.id?result:e);this.undoState=current;}finally{this.busy=false;this.notify();}}
  async answer(answer:string){
    if(this.busy||!this.active)throw new Error("learning-busy-or-missing");
    const lesson=lessonFor(this.active.concept),question=this.active.stage==="attempt"?lesson.question:lesson.transfer;
    const canonical=canonicalMathAnswer(question,answer);
    if(!canonical)return {status:"clarification-needed" as const,message:t("upgrade.answerClarification")};
    const value=canonical.kind==="number"?String(canonical.value):question.choices![canonical.index]!;
    await this.update(e=>recordAttempt(e,value));
    return {status:"saved" as const};
  }
  hint(){return this.update(e=>{e.hintCount++;return e;});}
  pause(){return this.update(e=>{if(e.status==="completed")throw new Error("episode-already-completed");return {...e,status:e.status==="paused"?"active":"paused"};});}
  finish(_reflection:string,days=1){return this.update(e=>{if(e.status!=="active"||e.stage!=="reflect")throw new Error("episode-not-ready-to-finish");return {...e,status:"completed",reviewDue:new Date(Date.now()+Math.max(1,days)*86400000).toISOString()};});}
  review(){return this.update(e=>{if(!e.reviewDue||e.reviewDue>new Date().toISOString())throw new Error("delayed-check-not-due");return {...e,status:"active",stage:"delayed",hintCount:0};});}
  async undo(){const before=this.undoState;if(!before)throw new Error("learning-no-undo");await this.update(current=>({...before,revision:current.revision}));this.undoState=null;}
  get canUndo(){return !!this.undoState;}
  /** A learner correction replaces the interpretation, never fabricates an independent success. */
  correct(evidenceId:string,_reason:string){return this.update(e=>{if(!e.evidence.some(x=>x.id===evidenceId))throw new Error("evidence-not-found");e.evidence.push({id:crypto.randomUUID(),at:new Date().toISOString(),questionId:"learner-correction",packVersion:LIMITS_PACK_VERSION,kind:"self-report",answer:"",hintCount:0,evaluator:"learner",outcome:"unreviewed",feedback:"Learner disputed this judgment; recheck required.",corrects:evidenceId});return e;});}
  /** Legacy cards have no bounded explanation schema. Keep feedback in the
   * current view; never route either free-text argument through the store. */
  async explanation(_answer:string,_feedback:string){return {status:"display-only" as const,message:t("upgrade.reflectionTemporary")};}
  async renameSource(oldPath:string,newPath:string){
    await this.store.flush();
    const records=await this.store.list();
    for(const e of records.filter(e=>e.source.path===oldPath))await this.store.save({...e,source:{...e.source,path:newPath}});
    await this.load();
  }
  async link(kind:LearningEpisode["links"][number]["kind"],id:string,targetId?:string){await this.update(e=>{if(!e.links.some(l=>l.kind===kind&&l.id===id))e.links.push({kind,id,...(targetId?{targetId}:{})});return e;});}
  context(){const e=this.active;if(!e)return "";return JSON.stringify({episodeId:e.id,source:e.source,goal:lessonFor(e.concept).goal,attempts:safeLegacyEvidence(e).slice(-5),hintCount:e.hintCount});}
}
