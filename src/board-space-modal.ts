import {Modal,type App} from "obsidian";
import {t} from "./i18n.js";
/** An explicit surface choice; dismissal/cancellation never creates a new document. */
export function chooseDrawingStudio(app:App,signal:AbortSignal):Promise<boolean>{
  if(signal.aborted)return Promise.resolve(false);
  return new Promise(resolve=>{
    const modal=new Modal(app);let chosen=false;
    const abort=()=>modal.close();
    modal.titleEl.textContent=t("upgrade.drawingSpaceTitle");
    modal.contentEl.createEl("p",{text:t("upgrade.drawingSpaceBody")});
    const studio=modal.contentEl.createEl("button",{text:t("upgrade.drawingSpaceStudio"),cls:"mod-cta"});
    studio.onclick=()=>{chosen=true;modal.close();};
    modal.contentEl.createEl("button",{text:t("upgrade.drawingSpaceCancel")}).onclick=()=>modal.close();
    modal.onClose=()=>{signal.removeEventListener("abort",abort);resolve(chosen&&!signal.aborted);};
    signal.addEventListener("abort",abort,{once:true});modal.open();
  });
}
