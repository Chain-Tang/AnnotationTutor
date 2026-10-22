import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n.js";
import { communicationIdentityKey, type CommunicationIdentity, type CommunicationMessage, type CommunicationSpaceView } from "./tutor-communication.js";
export type CommunicationUiSpace={key:string;label:string;local:boolean;caller:CommunicationIdentity;space:CommunicationSpaceView};
export interface TutorCommunicationUi {
  spaces():Promise<CommunicationUiSpace[]>;
  create(title:string,goal:string,background:string):Promise<void>;
  members():{identity:CommunicationIdentity;name:string}[];
  setMember(spaceId:string,identity:CommunicationIdentity,include:boolean):Promise<void>;
  bindCodex(spaceId:string):Promise<string>;
  openNote(spaceId:string,kind:"context"|"conversation"):Promise<void>;
  send(space:CommunicationUiSpace,recipient:CommunicationIdentity,text:string):Promise<void>;
  messages(space:CommunicationUiSpace):Promise<CommunicationMessage[]>;
  peers():Promise<{id:string;name:string;connected:boolean}[]>;
  connect(instanceId:string):Promise<void>;
  disconnect(instanceId:string):Promise<void>;
}
export class TutorCommunicationModal extends Modal {
  private active?:CommunicationUiSpace;
  private timer?:ReturnType<typeof setInterval>;
  private dead=false;
  private loading=false;
  private readonly drafts=new Map<string,string>();
  private epoch=0;
  constructor(app:App,private readonly ui:TutorCommunicationUi){super(app);}
  override onOpen(){this.dead=false;this.titleEl.textContent=t("upgrade.communicationTitle");void this.render();}
  private async render(){
    if(this.dead)return;const epoch=++this.epoch,live=()=>!this.dead&&epoch===this.epoch;clearInterval(this.timer);this.contentEl.empty();
    this.contentEl.createEl("p",{text:t("upgrade.communicationIntro")});
    const error=this.contentEl.createDiv();
    const act=async(run:()=>Promise<void>)=>{try{await run();}catch(e){if(!this.dead)error.textContent=e instanceof Error?e.message:"Communication failed";}};
    let spaces:CommunicationUiSpace[];
    try{spaces=await this.ui.spaces();}catch(e){error.textContent=String(e);return;}
    if(!live())return;
    this.active=spaces.find(item=>item.key===this.active?.key)??spaces[0];
    if(spaces.length)new Setting(this.contentEl).setName(t("upgrade.communicationSpace")).addDropdown(drop=>{
      for(const item of spaces)drop.addOption(item.key,item.label);
      drop.setValue(this.active!.key).onChange(key=>{this.active=spaces.find(item=>item.key===key);void this.render();});
    });else this.contentEl.createEl("p",{text:t("upgrade.communicationEmpty")});
    const active=this.active;
    if(active){
      const recipients=active.space.members.filter(member=>member.read&&communicationIdentityKey(member.identity)!==communicationIdentityKey(active.caller));let selected=recipients[0]?.identity;
      new Setting(this.contentEl).setName(t("upgrade.communicationRecipient")).addDropdown(drop=>{
        for(const member of recipients)drop.addOption(communicationIdentityKey(member.identity),`${member.identity.kind} · ${member.identity.agentId}`);
        drop.onChange(key=>{selected=recipients.find(m=>communicationIdentityKey(m.identity)===key)?.identity;});
      });
      const input=this.contentEl.createEl("textarea",{attr:{"aria-label":t("upgrade.communicationMessage"),placeholder:t("upgrade.communicationMessage")}});input.rows=4;input.style.width="100%";input.value=this.drafts.get(active.key)??"";input.oninput=()=>{this.drafts.set(active.key,input.value);};
      new Setting(this.contentEl).addButton(button=>button.setButtonText(t("upgrade.communicationSend")).setCta().onClick(()=>void act(async()=>{
        if(!selected||!input.value.trim())return;button.setDisabled(true);
        try{await this.ui.send(active,selected,input.value.trim());input.value="";this.drafts.delete(active.key);if(live())error.textContent=t("upgrade.communicationPending");await refresh();}finally{if(live())button.setDisabled(false);}
      }))).addButton(button=>button.setButtonText(t("upgrade.communicationRefresh")).onClick(()=>void act(refresh)));
      if(active.local){
        new Setting(this.contentEl).addButton(button=>button.setButtonText(t("upgrade.communicationCodex")).onClick(()=>void act(async()=>{button.setDisabled(true);try{await this.ui.bindCodex(active.space.spaceId);if(live())await this.render();}finally{button.setDisabled(false);}})))
          .addButton(button=>button.setButtonText(t("upgrade.communicationContext")).onClick(()=>void act(()=>this.ui.openNote(active.space.spaceId,"context"))))
          .addButton(button=>button.setButtonText(t("upgrade.communicationTranscript")).onClick(()=>void act(()=>this.ui.openNote(active.space.spaceId,"conversation"))));
        this.contentEl.createEl("h3",{text:t("upgrade.communicationMembers")});
        for(const member of this.ui.members())new Setting(this.contentEl).setName(member.name).setDesc(`${member.identity.kind} · ${member.identity.agentId}`).addToggle(toggle=>{
          toggle.setValue(active.space.members.some(item=>communicationIdentityKey(item.identity)===communicationIdentityKey(member.identity))).onChange(include=>void act(async()=>{await this.ui.setMember(active.space.spaceId,member.identity,include);await this.render();}));
        });
      }
      const output=this.contentEl.createDiv();
      const refresh=async()=>{
        if(this.loading||!live())return;this.loading=true;
        try{const messages=await this.ui.messages(active);if(!live()||this.active?.key!==active.key)return;output.empty();
          for(const message of messages.slice(-20)){const row=output.createDiv();row.createEl("p",{text:`${message.envelope.sender.kind} · ${message.envelope.sender.agentId} · ${message.deliveries.map(item=>item.status).join(", ")}`});row.createEl("pre",{text:message.envelope.payload.text}).style.whiteSpace="pre-wrap";}
        }finally{this.loading=false;}
      };
      await act(refresh);if(!live())return;this.timer=setInterval(()=>void act(refresh),2500);
    }
    this.contentEl.createEl("h3",{text:t("upgrade.communicationCreate")});
    let title="",goal="",background="";
    new Setting(this.contentEl).setName(t("upgrade.communicationName")).addText(text=>text.onChange(value=>{title=value;}));
    new Setting(this.contentEl).setName(t("upgrade.communicationGoal")).addTextArea(text=>{text.inputEl.rows=2;text.onChange(value=>{goal=value;});});
    new Setting(this.contentEl).setName(t("upgrade.communicationBackground")).addTextArea(text=>{text.inputEl.rows=2;text.onChange(value=>{background=value;});});
    new Setting(this.contentEl).addButton(button=>button.setButtonText(t("upgrade.communicationCreate")).onClick(()=>void act(async()=>{if(!title.trim()||!goal.trim())return;button.setDisabled(true);try{await this.ui.create(title.trim(),goal.trim(),background.trim());this.active=undefined;await this.render();}finally{button.setDisabled(false);}})));
    this.contentEl.createEl("h3",{text:t("upgrade.communicationPeers")});
    let peers:Awaited<ReturnType<TutorCommunicationUi["peers"]>>;
    try{peers=await this.ui.peers();}catch(e){if(live())error.textContent=e instanceof Error?e.message:"Communication unavailable";return;}
    if(!live())return;
    for(const peer of peers)new Setting(this.contentEl).setName(peer.name).addButton(button=>button.setButtonText(t(peer.connected?"upgrade.communicationDisconnect":"upgrade.communicationConnect")).onClick(()=>void act(async()=>{
      button.setDisabled(true);try{if(peer.connected)await this.ui.disconnect(peer.id);else await this.ui.connect(peer.id);await this.render();}finally{button.setDisabled(false);}
    })));
  }
  override onClose(){this.dead=true;this.epoch++;clearInterval(this.timer);this.contentEl.empty();}
}
