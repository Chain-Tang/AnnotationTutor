import { App, Modal, Setting } from "obsidian";
import type { TutorTask, TutorTaskCoordinator } from "./tutor-task.js";
import { t } from "./i18n.js";
export class TutorCollaborationModal extends Modal {
  private stop?:()=>void;
  constructor(app:App,private readonly tasks:TutorTaskCoordinator,private readonly start:(prompt:string,experts:string[])=>Promise<TutorTask>,private readonly remoteAvailable=false){super(app);}
  override onOpen():void{
    this.titleEl.textContent=t("board.collaborationTitle");
    const text=this.contentEl.createEl("textarea");text.placeholder=t("board.collaborationPrompt");text.setAttribute("aria-label",t("board.collaborationPrompt"));text.rows=3;text.style.width="100%";
    const experts=new Set(["codex"]);
    for(const expert of ["codex","opencode","remote"]){new Setting(this.contentEl).setName(expert==="remote"?t("board.remoteExpert"):expert).addToggle(toggle=>toggle.setValue(experts.has(expert)).setDisabled(expert==="remote"&&!this.remoteAvailable).onChange(value=>{if(value&&experts.size>=2){toggle.setValue(false);return;}value?experts.add(expert):experts.delete(expert);}));}
    const output=this.contentEl.createDiv();let active:TutorTask|undefined;let startButton:HTMLButtonElement|undefined;
    const render=()=>{
      output.empty();if(!active)return;
      const root=this.tasks.get(active.id,active.clientId);if(startButton)startButton.disabled=!["completed","failed","cancelled"].includes(root.state);
      for(const task of [root,...root.children.map(id=>this.tasks.get(id,root.clientId))]){
        output.createEl("p",{text:`${task.agent} · ${task.phase}${task.route?` · ${task.route.model}`:""}`});
        if(task.error)output.createEl("p",{text:task.error.message});
        for(const artifact of task.artifacts)if(artifact.type==="text")output.createEl("p",{text:String((artifact.data as {text?:string}).text??"")});
      }
    };
    new Setting(this.contentEl).addButton(button=>{startButton=button.buttonEl;button.setButtonText(t("board.collaborationStart")).setCta().onClick(async()=>{
      if(!text.value.trim())return;button.setDisabled(true);
      try{active=await this.start(text.value.trim(),[...experts]);render();}catch(error){output.textContent=String(error);button.setDisabled(false);}
    });}).addButton(button=>button.setButtonText(t("board.stopReply")).onClick(()=>{if(active)this.tasks.cancel(active.id,active.clientId);}));
    this.stop=this.tasks.subscribe(()=>render());
  }
  override onClose():void{this.stop?.();this.contentEl.empty();}
}
