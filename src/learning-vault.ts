import { TFile, type App } from "obsidian";
import type { LearningIO } from "./learning-episode-store.js";
export function learningVaultIO(app:App):LearningIO{
  const ensure=async(path:string)=>{let base="";for(const part of path.split("/").slice(0,-1)){base=base?`${base}/${part}`:part;if(!await app.vault.adapter.exists(base)){try{await app.vault.createFolder(base);}catch(error){if(!await app.vault.adapter.exists(base))throw error;}}}};
  return {
    read:async path=>await app.vault.adapter.exists(path)?app.vault.adapter.read(path):null,
    list:async path=>await app.vault.adapter.exists(path)?(await app.vault.adapter.list(path)).files:[],
    write:async(path,text)=>{await ensure(path);await app.vault.adapter.write(path,text);},
    compareWrite:async(path,previous,next)=>{await ensure(path);const file=app.vault.getAbstractFileByPath(path);if(file instanceof TFile){await app.vault.process(file,current=>{if(current!==previous)throw new Error("learning-external-conflict");return next;});}else{if(previous!==null||await app.vault.adapter.exists(path))throw new Error("learning-external-conflict");await app.vault.create(path,next);}},
  };
}
