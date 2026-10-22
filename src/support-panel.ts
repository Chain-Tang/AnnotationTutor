import { t } from "./i18n.js";
import type { SupportSession } from "./support-session.js";
/** Inline, no focus stealing. All descendants are excluded from board capture. */
export function mountSupportPanel(parent:HTMLElement,session:SupportSession,host:{quiet:()=>boolean;days:()=>number}):()=>void{
  const root=parent.createDiv({cls:"atl-support-private atl-support-card"});
  const body=root.createDiv();body.createEl("p",{cls:"setting-item-description",text:t("upgrade.supportBrief")});
  const privacy=body.createEl("details");privacy.createEl("summary",{text:t("upgrade.supportPrivacyTitle")});privacy.createEl("p",{text:t("upgrade.supportPrivacy")});
  const unavailable=body.createEl("p",{text:t("upgrade.supportNoEncryption")});
  const transcript=body.createDiv({cls:"atl-support-transcript"});const error=body.createEl("p",{attr:{role:"status"}});
  const retry=body.createEl("button",{text:t("upgrade.supportRetryDelete")});retry.onclick=()=>void session.retrySave().catch(()=>{});
  const input=body.createEl("textarea",{attr:{"aria-label":t("upgrade.supportInput")},placeholder:t("upgrade.supportInput")});
  const send=body.createEl("button",{text:t("upgrade.supportSend")});send.onclick=()=>{if(session.busy||!input.value.trim())return;const value=input.value;void session.send(value).then(()=>{if(!session.error)input.value="";});};
  input.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();send.click();}});
  const close=body.createEl("button",{text:t("upgrade.supportClose")});close.onclick=()=>session.close();
  const urgent=body.createEl("details");urgent.createEl("summary",{text:t("upgrade.supportUrgentTitle")});urgent.createEl("p",{text:t("upgrade.supportUrgent")});
  const summaryTools=body.createEl("details");summaryTools.createEl("summary",{text:t("upgrade.supportSummaries")});
  const summary=summaryTools.createEl("textarea",{attr:{"aria-label":t("upgrade.supportSummaryText")},placeholder:t("upgrade.supportSummaryText")});
  const confirm=summaryTools.createEl("button",{text:t("upgrade.supportConfirm",{days:host.days()})});let saving=false;
  confirm.onclick=async()=>{if(saving||!summary.value.trim())return;saving=true;render();try{await session.confirm(summary.value,host.days());summary.value="";}catch{session.error="support-save-failed";session.notify();}finally{saving=false;render();}};
  const saved=summaryTools.createDiv();let previousMessages="",previousSummaries="",wasOpen=false;
  const render=()=>{
    root.hidden=!session.opened;
    if(wasOpen&&!session.opened){input.value="";summary.value="";}wasOpen=session.opened;
    retry.hidden=session.error!=="support-delete-failed";
    unavailable.hidden=session.canSave;confirm.disabled=!session.canSave||saving;send.disabled=session.busy;
    error.textContent=session.error?t(`upgrade.${session.error}`):"";
    const messageKey=JSON.stringify(session.messages);if(messageKey!==previousMessages){previousMessages=messageKey;transcript.empty();for(const message of session.messages)transcript.createEl("p",{cls:message.role,text:`${message.role==="assistant"?"Tutor":t("upgrade.you")}: ${message.content}`});transcript.scrollTop=transcript.scrollHeight;}
    const summaryKey=JSON.stringify(session.summaries);if(summaryKey!==previousSummaries){previousSummaries=summaryKey;saved.empty();for(const item of session.summaries){const row=saved.createDiv();row.createEl("p",{text:`${item.text}\n${t("upgrade.expires")}${item.expiresAt.slice(0,10)}`});const renew=row.createEl("button",{text:t("upgrade.supportRenew",{days:host.days()})});renew.onclick=()=>void session.renew(item.id,host.days()).catch(()=>{session.error="support-request-failed";session.notify();});const remove=row.createEl("button",{text:t("upgrade.delete")});remove.onclick=()=>void session.delete(item.id).catch(()=>{error.textContent=t("upgrade.supportDeleteFailed");});}}
  };
  const stop=session.subscribe(render);render();return()=>{stop();input.value="";summary.value="";root.remove();};
}

/** Only the opt-in check-in occupies the sidebar, never a second composer. */
export function mountSupportCheckin(parent:HTMLElement,session:SupportSession,host:{quiet:()=>boolean;open:(draft?:string)=>void}):()=>void{
  const root=parent.createDiv({cls:"atl-support-private atl-support-card atl-support-checkin"});
  root.createEl("p",{text:t("upgrade.checkinQuestion")});
  const ready=root.createEl("button",{text:t("upgrade.supportReady")});ready.onclick=()=>session.skip();
  for(const key of ["supportSmall","supportListen"]){const button=root.createEl("button",{text:t(`upgrade.${key}`)});button.onclick=()=>host.open(t(`upgrade.${key}`));}
  const skip=root.createEl("button",{text:t("upgrade.skip")});skip.onclick=()=>session.skip();
  const render=()=>{root.hidden=!session.pending||!host.quiet()||session.opened;};
  const stop=session.subscribe(render),win=root.ownerDocument.defaultView!,timer=win.setInterval(render,1000);render();return()=>{stop();win.clearInterval(timer);root.remove();};
}
