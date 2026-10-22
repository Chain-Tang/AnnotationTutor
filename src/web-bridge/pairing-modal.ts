import { Modal, Setting, type App, type ButtonComponent } from "obsidian";
import type { ClipperApproval, ClipperPairChallenge } from "./pairing.js";

/** Unchecked capabilities require a local, explicit choice; extension names are untrusted display text. */
export class ClipperPairingModal extends Modal {
  private finished=false;
  constructor(app:App,private challenge:ClipperPairChallenge,private decide:(approval:ClipperApproval|null)=>void){super(app);}
  override onOpen(){
    this.titleEl.setText("连接浏览器 Clipper");
    this.contentEl.createEl("p",{text:`浏览器请求名称：${this.challenge.name}`});
    this.contentEl.createEl("p",{text:`来源：${this.challenge.origin}`});
    this.contentEl.createEl("p",{text:"请选择允许的操作。扩展名称不是身份验证；请确认这正是你刚刚发起的连接。请求五分钟后失效。"});
    let capture=false,ask=false,targetDirectory=this.challenge.targetDirectory,confirm:ButtonComponent|undefined;
    const update=()=>confirm?.setDisabled(!(capture||ask)||!targetDirectory.trim()||Date.now()>=Date.parse(this.challenge.expiresAt));
    if(this.challenge.capabilities.includes("capture"))new Setting(this.contentEl).setName("保存网页").setDesc("仅允许保存到下面指定的目录，不包含模型分析。").addToggle(toggle=>toggle.setValue(false).onChange(value=>{capture=value;update();}));
    if(this.challenge.capabilities.includes("ask"))new Setting(this.contentEl).setName("向 Tutor 提问").setDesc("将本次网页材料发送给配置的模型，可能产生供应商费用。").addToggle(toggle=>toggle.setValue(false).onChange(value=>{ask=value;update();}));
    new Setting(this.contentEl).setName("保存目录").addText(text=>text.setValue(targetDirectory).onChange(value=>{targetDirectory=value;update();}));
    new Setting(this.contentEl).addButton(button=>button.setButtonText("拒绝").onClick(()=>this.close())).addButton(button=>{
      confirm=button;button.setButtonText("允许所选操作").setCta().setDisabled(true).onClick(()=>{
        if(!(capture||ask)||Date.now()>=Date.parse(this.challenge.expiresAt))return;
        const path=targetDirectory.trim();if(!path||path.startsWith("/")||path.includes("\\")||path.split("/").some(part=>!part||part==="."||part===".."))return;
        this.finished=true;this.decide({capabilities:[...(capture?["capture" as const]:[]),...(ask?["ask" as const]:[])],targetDirectory:path});this.close();
      });
    });
  }
  override onClose(){if(!this.finished){this.finished=true;this.decide(null);}this.contentEl.empty();}
  static request(app:App,challenge:ClipperPairChallenge):Promise<ClipperApproval|null>{return new Promise(resolve=>new ClipperPairingModal(app,challenge,resolve).open());}
}
