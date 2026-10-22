import { App,Modal } from "obsidian";
import { t } from "./i18n.js";
import type { TutorTask,TutorTaskCoordinator } from "./tutor-task.js";
import { parseExpertReview } from "./learning-experts.js";
export class LearningExpertModal extends Modal {
  private stop?:()=>void;
  private task?:TutorTask;
  private closed=false;
  constructor(app:App,private tasks:TutorTaskCoordinator,private start:()=>Promise<TutorTask>){super(app);}
  override onOpen(){this.titleEl.textContent=t("upgrade.expertTitle");const status=this.contentEl.createEl("p",{text:t("upgrade.expertStarting"),attr:{role:"status"}}),output=this.contentEl.createDiv();
    const cancel=this.contentEl.createEl("button",{text:t("upgrade.cancel")});cancel.onclick=()=>{if(this.task)this.tasks.cancel(this.task.id,this.task.clientId);};
    const render=()=>{if(!this.task)return;const task=this.tasks.get(this.task.id,this.task.clientId);status.textContent=[task.agent,task.phase,task.route?.model??""].join(" · ");output.empty();
      const children=task.children.map(id=>this.tasks.get(id,task.clientId));for(const child of children)output.createEl("p",{text:[child.agent,child.state,child.route?.model??"",child.error?.message??""].join(" · ")});
      if(children.some(c=>c.state!=="completed")&&task.state==="completed")output.createEl("p",{text:t("upgrade.expertPartial")});
      if(task.error){output.createEl("p",{text:task.error.message});
        for(const child of children.filter(c=>c.state==="completed")){const draft=child.artifacts.filter(a=>a.type==="text").at(-1)?.data as {text?:string}|undefined;if(draft?.text){const detail=output.createEl("details");detail.createEl("summary",{text:t("upgrade.expertDraft")});detail.createEl("p",{text:draft.text});}}
      }
      const final=task.artifacts.filter(a=>a.type==="text").at(-1)?.data as {text?:string;reviewStatus?:string}|undefined;
      if(final?.reviewStatus==="stale")output.createEl("p",{text:t("upgrade.expertStale")});
      if(final?.text){try{const review=parseExpertReview(final.text);output.createEl("p",{text:t(`upgrade.verdict.${review.verdict}`)});output.createEl("h4",{text:t("upgrade.expertEvidence")});for(const evidence of review.evidence)output.createEl("p",{text:`${evidence.claim}\n${evidence.sourceRef}`});output.createEl("h4",{text:t("upgrade.expertSuggestions")});for(const suggestion of review.suggestions)output.createEl("p",{text:suggestion});output.createEl("h4",{text:t("upgrade.expertUncertainty")});for(const uncertainty of review.uncertainties)output.createEl("p",{text:uncertainty});}catch{output.createEl("p",{text:t("upgrade.expertUnstructured")});output.createEl("p",{text:final.text});}}
    };
    this.stop=this.tasks.subscribe(()=>render());void this.start().then(task=>{this.task=task;if(this.closed)this.tasks.cancel(task.id,task.clientId);else render();}).catch(()=>{if(!this.closed)status.textContent=t("upgrade.expertFailed");});
  }
  override onClose(){this.closed=true;if(this.task)this.tasks.cancel(this.task.id,this.task.clientId);this.stop?.();this.contentEl.empty();}
}
