import { createHash } from "node:crypto";
import { credentialSlots, isCredentialReference, normalizeCredentialReferences, type CredentialReferences, type CredentialSlot } from "./credential-types.js";
import type { CredentialSettingsWriter, CredentialStore } from "./credential-store.js";

export type CredentialSettings = Record<CredentialSlot,string> & {apiBaseUrl:string;boardImageBaseUrl:string;boardImageProvider:string;tutorRemoteUrl:string;credentialRefs:CredentialReferences};
type Entry={value:string;dirty:boolean;legacy:boolean;unavailable?:boolean;generation:number};
export type CredentialStatus = {storage:"available"|"unavailable";state:"ready"|"session-only"|"migration-pending"|"reference-unavailable"|"save-failed";legacySlots:CredentialSlot[];sessionSlots:CredentialSlot[];unavailableSlots:CredentialSlot[]};
const sessions=new WeakMap<object,CredentialSettingsSession>();
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
export function credentialBinding(settings:CredentialSettings,slot:CredentialSlot):string {
  const endpoint=slot==="apiKey"?settings.apiBaseUrl:slot==="boardImageApiKey"?`${settings.boardImageProvider}\n${settings.boardImageBaseUrl}`:slot==="tutorRemoteToken"?settings.tutorRemoteUrl:"mcp-configuration";
  return hash(`${slot}\n${endpoint.trim().replace(/\/+$/,"")}`);
}
export function credentialStatusFor(settings:object):CredentialStatus|undefined {return sessions.get(settings)?.status();}

/** Compatibility adapter: callers can read settings.apiKey synchronously, but
 * JSON/string spread never includes secrets. Only save() commits references. */
export class CredentialSettingsSession {
  private readonly entries=new Map<string,Entry>();
  private readonly legacy=new Map<CredentialSlot,string>();
  private queue:Promise<unknown>=Promise.resolve();
  private initialized=false;
  private saveFailed=false;
  private disposed=false;
  constructor(private readonly settings:CredentialSettings,private readonly store:CredentialStore,private readonly writer:CredentialSettingsWriter) {
    settings.credentialRefs=normalizeCredentialReferences(settings.credentialRefs);
    for(const slot of credentialSlots) {
      const value=settings[slot];if(typeof value==="string"&&value)this.legacy.set(slot,value);
      Object.defineProperty(settings,slot,{configurable:true,enumerable:false,
        get:()=>this.entries.get(this.key(slot))?.value??this.legacy.get(slot)??"",
        set:(value:unknown)=>{if(this.disposed)return;const key=this.key(slot),before=this.entries.get(key);const next=typeof value==="string"?value:"";
          if(before?.value===next&&!before.unavailable)return;
          this.entries.set(key,{value:next,dirty:true,legacy:before?.legacy??false,generation:(before?.generation??0)+1});}});
    }
    sessions.set(settings,this);
  }
  private key(slot:CredentialSlot,binding=credentialBinding(this.settings,slot)):string{return `${slot}:${binding}`;}
  async initialize():Promise<CredentialStatus> {
    if(this.disposed)throw new Error("credential-session-closed");
    if(this.initialized)return this.status();
    for(const ref of this.settings.credentialRefs) {
      try {this.entries.set(this.key(ref.slot,ref.binding),{value:await this.store.get(ref),dirty:false,legacy:false,generation:0});}
      catch {this.entries.set(this.key(ref.slot,ref.binding),{value:"",dirty:false,legacy:false,unavailable:true,generation:0});}
    }
    for(const [slot,value] of this.legacy)this.entries.set(this.key(slot),{value,dirty:true,legacy:true,generation:0});
    this.legacy.clear();this.initialized=true;
    if([...this.entries.values()].some(entry=>entry.legacy)) {
      try {await this.save();}catch{/* Existing connections stay live; no failed migration is reported complete. */}
    }
    return this.status();
  }
  status():CredentialStatus {
    const slots=(predicate:(entry:Entry)=>boolean)=>credentialSlots.filter(slot=>[...this.entries].some(([key,entry])=>key.startsWith(`${slot}:`)&&predicate(entry)));
    const legacySlots=slots(entry=>entry.legacy),sessionSlots=slots(entry=>entry.dirty&&!entry.legacy&&!!entry.value),unavailableSlots=slots(entry=>!!entry.unavailable);
    return {storage:this.store.available()?"available":"unavailable",state:legacySlots.length?"migration-pending":this.saveFailed?"save-failed":sessionSlots.length?"session-only":unavailableSlots.length?"reference-unavailable":"ready",legacySlots,sessionSlots,unavailableSlots};
  }
  save():Promise<CredentialStatus> {
    const task=this.queue.catch(()=>{}).then(()=>this.saveCurrent());this.queue=task;return task;
  }
  async flush():Promise<void> {await this.queue;}
  dispose():void {this.disposed=true;this.entries.clear();this.legacy.clear();sessions.delete(this.settings);}
  private async saveCurrent():Promise<CredentialStatus> {
    if(this.disposed)throw new Error("credential-session-closed");
    if(!this.initialized)throw new Error("credential-session-not-initialized");
    const pending=[...this.entries].filter(([,entry])=>entry.dirty).map(([key,entry])=>({key,...entry}));
    const available=this.store.available();
    if(!available&&pending.some(entry=>entry.legacy&&entry.value)){this.saveFailed=true;throw new Error("credential-migration-pending");}
    let refs=this.settings.credentialRefs.map(ref=>({...ref}));
    const stored=new Set<string>();
    const payload:Record<string,unknown>={...this.settings};
    for(const slot of credentialSlots)delete payload[slot];
    // Legacy shared service tokens never become trusted client credentials.
    for(const slot of ["webBridgeToken","androidInkToken"])if(slot in payload)payload[slot]="";
    try {
      for(const entry of pending) {
        const separator=entry.key.indexOf(":"),slot=entry.key.slice(0,separator) as CredentialSlot,binding=entry.key.slice(separator+1);
        if(!entry.value){refs=refs.filter(ref=>ref.slot!==slot||ref.binding!==binding);stored.add(entry.key);continue;}
        if(!available)continue; // Explicit session-only value, never a plaintext save.
        const reference=await this.store.put(slot,binding,entry.value);
        if(!isCredentialReference(reference)||reference.slot!==slot||reference.binding!==binding||await this.store.get(reference)!==entry.value)throw new Error("credential-readback-failed");
        refs=refs.filter(ref=>ref.slot!==slot||ref.binding!==binding);refs.push(reference);stored.add(entry.key);
      }
      payload.credentialRefs=refs;
      if(this.disposed)throw new Error("credential-session-closed");
      await this.writer.write(payload);
      this.settings.credentialRefs=refs;
      for(const entry of pending) {
        const current=this.entries.get(entry.key);
        if(stored.has(entry.key)&&current?.generation===entry.generation){current.dirty=false;current.legacy=false;current.unavailable=false;}
      }
      this.saveFailed=false;
      return this.status();
    } catch {this.saveFailed=true;throw new Error(pending.some(entry=>entry.legacy)?"credential-migration-pending":"credential-save-failed");}
  }
}
