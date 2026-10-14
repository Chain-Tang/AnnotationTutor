import { App, Modal, Setting } from "obsidian";
import type { SurfaceScene } from "./tutor-surface.js";
import type { TutorClientGrant } from "./tutor-mcp.js";
import { t } from "./i18n.js";

export class TutorPairingModal extends Modal {
  private settled=false;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(app:App,private readonly name:string,private readonly scenes:SurfaceScene[],private readonly documents:string[],private readonly readOnly:boolean,private readonly done:(grant:TutorClientGrant|null)=>void){super(app);}
  override onOpen():void{
    this.titleEl.textContent=t("board.pairTitle",{name:this.name});
    this.contentEl.createEl("p",{text:t("board.pairExplanation")});
    const selected=new Set<string>();let write=false,memory=false,evidence=false;
    for(const source of this.documents)new Setting(this.contentEl).setName(source).addToggle(toggle=>toggle.setValue(false).onChange(value=>{if(value)selected.add(source);else selected.delete(source);}));
    new Setting(this.contentEl).setName(t("board.pairWrite")).setDesc(t("board.pairWriteDesc")).addToggle(toggle=>toggle.setDisabled(this.readOnly).onChange(value=>{write=value;}));
    new Setting(this.contentEl).setName(t("board.pairMemory")).addToggle(toggle=>toggle.onChange(value=>{memory=value;}));
    new Setting(this.contentEl).setName(t("upgrade.pairEvidence")).setDesc(t("upgrade.pairEvidenceDesc")).addToggle(toggle=>toggle.onChange(value=>{evidence=value;}));
    new Setting(this.contentEl).addButton(button=>button.setButtonText(t("board.pairDeny")).onClick(()=>this.close())).addButton(button=>button.setButtonText(t("board.pairAllow")).setCta().onClick(()=>{
      if(!selected.size)return;
      const scenes=this.scenes.filter(scene=>selected.has(scene.target.source));
      this.settled=true;this.done({clientId:crypto.randomUUID(),name:this.name,createdAt:new Date().toISOString(),documents:[...selected],targets:scenes.map(s=>s.target.id),humanObjectIds:write?scenes.flatMap(s=>s.selection):[],read:true,write,learningMemory:memory,learningEvidence:evidence});this.close();
    }));
    this.timer=setTimeout(()=>this.close(),120000);
  }
  override onClose():void{clearTimeout(this.timer);if(!this.settled){this.settled=true;this.done(null);}this.contentEl.empty();}
}
