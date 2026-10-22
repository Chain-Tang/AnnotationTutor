import { Notice } from "obsidian";
import { t } from "./i18n.js";
import { limitsLessons, lessonFor, type ConceptId } from "./learning-episode.js";
import type { LearningCardV3, LearningCardActionScope } from "./learning-card-v3.js";
import type { LearningRunResultV3 } from "./learning-runner-v3.js";
import type { TeachingMode } from "./teaching-policy.js";

export type LearningPanelHost={
  activity?:()=>void;card:LearningCardV3;minutes:()=>number;
  run:(action:(card:LearningCardV3,scope:LearningCardActionScope)=>Promise<LearningRunResultV3>,present:(delta:string)=>boolean,options?:{newRecord?:boolean})=>Promise<LearningRunResultV3>;
  help?:(mode:TeachingMode,text:string)=>Promise<void>;draw?:()=>Promise<void>;explain?:(answer:string)=>Promise<void>;
  expert?:(kind:"explanation"|"diagram"|"research")=>Promise<void>;
  expertsEnabled?:()=>boolean;
};
export type LearningPanelMount = (()=>void) & { refresh():void };

/** The existing optional card is a presenter over shared V3 commands. It never
 * reconstructs a legacy flow or reads answer/explanation fields from a bank. */
export function mountLearningPanel(parent:HTMLElement,host:LearningPanelHost):LearningPanelMount{
  const root=parent.createEl("details",{cls:"atl-learning-card"});root.createEl("summary",{text:t("upgrade.learningTitle")});const body=root.createDiv();
  let answerDraft="",reflectionDraft="",localBusy=false,lastKey="",lastQuestion="",feedback="",errorText="",disposed=false,actionGeneration=0;
  let explanationOpen=false,explanationText="",explanationAttempted=false;
  const correctionDrafts=new Map<string,string>();
  const act=async(fn:()=>Promise<void>)=>{
    if(localBusy||disposed)return;host.activity?.();localBusy=true;errorText="";render();
    try{await fn();}catch(error){if(!disposed&&!(error instanceof Error&&error.name==="AbortError")){errorText=t("upgrade.cardFailure");new Notice(errorText);}}
    finally{localBusy=false;if(!disposed)render();}
  };
  const button=(label:string,fn:()=>Promise<void>,container:HTMLElement=body)=>{const b=container.createEl("button",{text:label});b.disabled=localBusy||host.card.snapshot.busy;b.onclick=()=>void act(fn);return b;};
  const visible=()=>{
    if(!root.isConnected||!root.open)return false;
    for(let el:HTMLElement|null=root;el;el=el.parentElement){const style=getComputedStyle(el);if(el.hidden||el.getAttribute("aria-hidden")==="true"||style.display==="none"||style.visibility==="hidden")return false;}
    return true;
  };
  const run=async(action:Parameters<LearningPanelHost["run"]>[0],options?:{newRecord?:boolean;explanation?:boolean})=>{
    const generation=++actionGeneration,key=host.card.snapshot.selected?.key;
    if(!options?.explanation)feedback="";
    await host.run(action,delta=>{
      const selected=host.card.snapshot.selected;
      if(disposed||generation!==actionGeneration||!visible()||(!options?.newRecord&&selected?.key!==key))return false;
      if(options?.explanation){
        const info=body.querySelector<HTMLDetailsElement>(".atl-learning-explanation");
        if(!explanationOpen||!info?.open)return false;
        explanationText+=delta;info.querySelector("p")!.textContent=explanationText;
      }else{
        const status=body.querySelector<HTMLElement>(".atl-learning-feedback");if(!status)return false;feedback+=delta;status.textContent=feedback;
      }
      return true;
    },{newRecord:options?.newRecord});
    // The synchronous presenter supplies the observation. Do not call the
    // annotation-only confirmProvided hook or replay returned text.
  };
  const render=()=>{
    if(disposed)return;
    const snapshot=host.card.snapshot,selected=snapshot.selected,key=selected?.key??"",questionId=selected?.kind==="v3"?selected.question.id:"";
    if(lastKey!==key){lastKey=key;answerDraft="";reflectionDraft="";feedback="";errorText="";correctionDrafts.clear();}
    if(lastQuestion!==questionId||!selected){lastQuestion=questionId;answerDraft="";explanationOpen=false;explanationText="";explanationAttempted=false;}
    body.empty();body.createEl("p",{cls:"setting-item-description",text:t("upgrade.cardMinutes",{minutes:host.minutes()})});
    if(snapshot.completeness!=="complete")body.createEl("p",{text:t("upgrade.cardIncomplete"),attr:{role:"status"}});
    const setup=selected?body.createEl("details"):body;if(selected)setup.createEl("summary",{text:t("upgrade.chooseLesson")});
    const choose=setup.createEl("select",{attr:{"aria-label":t("upgrade.chooseLesson")}});
    for(const lesson of limitsLessons)choose.createEl("option",{value:lesson.id,text:lesson.title});
    if(selected)choose.value=selected.kind==="v3"?selected.episode.concept:selected.record.concept;
    const start=button(t("upgrade.startLesson"),async()=>{const concept=choose.value as ConceptId;root.open=true;await run((card,scope)=>card.start(scope,concept),{newRecord:true});},setup);
    start.disabled=start.disabled||snapshot.completeness!=="complete";
    if(snapshot.entries.length){
      const history=setup.createEl("select",{attr:{"aria-label":t("upgrade.episodes")}});history.createEl("option",{value:"",text:t("upgrade.cardSelectHistory")});
      for(const entry of snapshot.entries)history.createEl("option",{value:entry.key,text:`${lessonFor(entry.concept).title} · ${entry.updatedAt.slice(0,10)} · ${entry.source.path}`});
      history.value=key;history.disabled=localBusy||snapshot.busy;
      history.onchange=()=>{actionGeneration++;host.card.select(history.value||undefined);};
    }
    body.createEl("p",{cls:"atl-learning-feedback",text:feedback,attr:{role:"status"}});
    if(errorText)body.createEl("p",{text:errorText,attr:{role:"status"}});
    if(!selected)return;
    if(selected.kind==="legacy-readonly"){
      const record=selected.record;body.createEl("h4",{text:lessonFor(record.concept).title});body.createEl("small",{text:record.source.path});
      body.createEl("p",{text:t("upgrade.cardLegacyReadonly")});
      const evidence=body.createEl("details");evidence.createEl("summary",{text:t("upgrade.evidence")});
      for(const item of record.evidence)evidence.createEl("p",{text:`${item.at.slice(0,16)} · ${item.answer}\n${item.feedback}`});
      return;
    }
    const {episode,question,effective}=selected;
    body.createEl("h4",{text:question.goal});body.createEl("small",{text:episode.source.path+(episode.source.annotationId?` · ${episode.source.annotationId}`:"")});
    const info=body.createEl("details",{cls:"atl-learning-explanation"});info.open=explanationOpen;
    info.createEl("summary",{text:t("upgrade.explanation")});info.createEl("p",{text:explanationText});
    info.ontoggle=()=>{
      if(disposed||!info.isConnected)return;explanationOpen=info.open;
      if(!info.open&&!explanationText)explanationAttempted=false;
      if(info.open&&!explanationAttempted&&!localBusy&&!snapshot.busy){explanationAttempted=true;void act(()=>run((card,scope)=>card.explanation(scope),{explanation:true}));}
    };
    const independent=effective.progressAnswers,refById=new Map(episode.questions.map(q=>[q.id,q]));
    body.createEl("p",{text:t("upgrade.cardEvidenceCounts",{independent:independent.filter(a=>refById.get(a.questionId)?.pool==="practice").length,transfer:independent.filter(a=>refById.get(a.questionId)?.pool==="transfer").length,delayed:independent.filter(a=>refById.get(a.questionId)?.pool==="delayed").length,hinted:effective.answers.filter(a=>a.independence!=="no-plugin-help").length})});
    const row=body.createDiv({cls:"atl-learning-actions"});
    if(episode.status!=="completed")button(t(episode.status==="paused"?"upgrade.resume":"upgrade.pause"),()=>run((card,scope)=>episode.status==="paused"?card.resume(scope):card.pause(scope)),row);
    if(effective.answers.length||effective.judgments.length)button(t("upgrade.cardCorrectLast"),()=>run((card,scope)=>card.undo(scope)),row);
    if(episode.status==="completed"){
      const due=effective.reviewTasks.filter(task=>task.state==="scheduled").sort((a,b)=>(a.dueAt??"").localeCompare(b.dueAt??""))[0]?.dueAt;
      body.createEl("p",{text:t("upgrade.reviewDue",{date:due?.slice(0,10)??""})});
      const review=button(t("upgrade.delayedCheck"),()=>run((card,scope)=>card.resume(scope)));review.disabled=review.disabled||!due||due>new Date().toISOString();
    }else if(episode.status==="active"){
      body.createEl("p",{text:question.prompt});
      if(question.choices){const select=body.createEl("select",{attr:{"aria-label":t("upgrade.answer")}});select.createEl("option",{value:"",text:t("upgrade.chooseAnswer")});for(const choice of question.choices)select.createEl("option",{value:choice,text:choice});select.value=answerDraft;select.onchange=()=>answerDraft=select.value;}
      else{const input=body.createEl("input",{type:"text",value:answerDraft,attr:{"aria-label":t("upgrade.answer")}});input.oninput=()=>answerDraft=input.value;}
      button(t("upgrade.submitAnswer"),async()=>{const draft=answerDraft;if(draft.trim())await run((card,scope)=>card.answer(scope,draft));});
      button(t("upgrade.hint"),()=>run((card,scope)=>card.hint(scope)));
      const modes=body.createDiv({cls:"atl-learning-actions"});button(t("upgrade.mode.answer"),()=>run((card,scope)=>card.solution(scope)),modes);
      if(host.help)for(const mode of ["coach","check"] as const)button(t(`upgrade.mode.${mode}`),()=>host.help!(mode,question.prompt+(answerDraft?`\n${answerDraft}`:"")),modes);
      if(host.draw)button(t("upgrade.draw"),()=>host.draw!());
      if(host.explain){
        const reflection=body.createEl("textarea",{placeholder:t("upgrade.reflect"),attr:{"aria-label":t("upgrade.reflect")}});reflection.value=reflectionDraft;reflection.oninput=()=>reflectionDraft=reflection.value;
        body.createEl("p",{cls:"setting-item-description",text:t("upgrade.cardReflectionTemporary")});
        button(t("upgrade.checkExplanation"),()=>host.explain!(reflectionDraft));
        button(t("upgrade.pause"),()=>run((card,scope)=>card.pause(scope)));
      }
    }
    const evidence=body.createEl("details");evidence.createEl("summary",{text:t("upgrade.evidence")});
    for(const item of selected.evidence){
      const entry=evidence.createDiv();
      if("kind" in item){entry.createEl("p",{text:t("upgrade.cardCorrected")});continue;}
      entry.createEl("p",{text:item.question});
      const value="answer" in item&&item.answer?(item.answer.kind==="number"?String(item.answer.value):String.fromCharCode(65+item.answer.index)):"";
      const outcome=item.outcome==="correct"?t("upgrade.correct"):item.outcome==="incorrect"?t("upgrade.tryAgain"):t("upgrade.evaluator.tutor");
      entry.createEl("p",{text:[value,outcome,...("independence" in item&&item.independence?[t(`upgrade.cardIndependence.${item.independence}`)]:[]),...(item.progress?[t("upgrade.cardNeedsReview")]:[])].filter(Boolean).join(" · ")});
      if(effective.answers.some(answer=>answer.id===item.id)||effective.judgments.some(judgment=>judgment.id===item.id)){
        const reason=entry.createEl("input",{placeholder:t("upgrade.correction"),value:correctionDrafts.get(item.id)??"",attr:{"aria-label":t("upgrade.correction")}});reason.oninput=()=>correctionDrafts.set(item.id,reason.value);
        button(t("upgrade.correctJudgment"),async()=>{if(reason.value.trim())await run((card,scope)=>card.correct(scope,item.id));},entry);
      }
    }
    if(host.expert&&(host.expertsEnabled?.()??true)){const experts=body.createDiv({cls:"atl-learning-actions"});for(const kind of ["explanation","diagram","research"] as const)button(t(`upgrade.expert.${kind}`),()=>host.expert!(kind),experts);}
  };
  const stop=host.card.subscribe(render);render();return Object.assign(()=>{disposed=true;actionGeneration++;stop();if(localBusy)host.card.cancel();root.remove();},{refresh:render});
}
