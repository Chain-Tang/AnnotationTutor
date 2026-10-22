import { z } from "zod";
import { teachingInstructions } from "./teaching-policy.js";
export const supportSummarySchema=z.object({format:z.literal(1),id:z.string().uuid(),text:z.string().min(1).max(2000),confirmedAt:z.string().datetime(),expiresAt:z.string().datetime()});
export type SupportSummary=z.infer<typeof supportSummarySchema>;
export type SupportMessage={role:"user"|"assistant";content:string};
export type SupportStorage={available():boolean;load():Promise<SupportSummary[]>;save(summaries:SupportSummary[]):Promise<void>;revoke?(ids:readonly string[]):Promise<void>;readDay():Promise<string>;writeDay(day:string):Promise<void>};
export const localStudyDay=(now:Date)=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
export function supportInstructions():string {
  return teachingInstructions()+"\nThis is a temporary adult support conversation, not academic grading. Never infer a diagnosis or personality. Use the shared adult support priorities, including Immediate danger guidance. Respect leaving, sleep and offline relationships. A remembered summary may be outdated: ask, do not assert. This plugin does not save this conversation, but provider policies apply; never promise provider confidentiality. A summary is saved only after explicit confirmation and a successful storage receipt. No tools, profiles, external experts or learning assessment. Reply in the user's language.";
}
/** No journal, task coordinator or conversation persistence dependency is permitted here. */
export class SupportSession {
  readonly messages:SupportMessage[]=[];
  summaries:SupportSummary[]=[];
  error="";busy=false;pending=false;opened=false;
  private generation=0;
  private disposed=false;
  private expiryTimer:ReturnType<typeof setTimeout>|undefined;
  private abort?:AbortController;
  private day="";
  private claiming:Promise<void>|undefined;
  private writeTail:Promise<void>=Promise.resolve();
  private readonly pendingRevocations=new Set<string>();
  private readonly pendingConfirmations=new Map<string,SupportSummary>();
  private listeners=new Set<()=>void>();
  constructor(private readonly storage:SupportStorage,private readonly run:(messages:SupportMessage[],system:string,signal:AbortSignal,onDelta:(text:string)=>void)=>Promise<string>,private readonly now:()=>Date=()=>new Date()){}
  get canSave(){return this.storage.available();}
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  notify(){if(this.disposed)return;for(const fn of this.listeners)fn();}
  private scheduleExpiry(){if(this.expiryTimer)clearTimeout(this.expiryTimer);this.expiryTimer=undefined;if(this.disposed)return;const at=Math.min(...this.summaries.map(s=>Date.parse(s.expiresAt)));if(Number.isFinite(at)){this.expiryTimer=setTimeout(()=>void this.expire().catch(()=>{if(this.disposed)return;this.error="support-store-unavailable";this.notify();}),Math.max(1,Math.min(2147483647,at-this.now().getTime())));this.expiryTimer.unref?.();}}
  async initialize(){if(this.disposed)return;const day=await this.storage.readDay();if(this.disposed)return;this.day=day;if(this.canSave){const summaries=await this.storage.load();if(this.disposed)return;this.summaries=summaries.map(x=>supportSummarySchema.parse(x));await this.expire();this.scheduleExpiry();}}
  async activity(enabled:boolean){if(this.disposed||!enabled)return;const day=localStudyDay(this.now());if(this.day===day)return;if(this.claiming){await this.claiming;return;}
    this.claiming=(async()=>{await this.storage.writeDay(day);if(this.disposed)return;this.day=day;this.pending=true;this.notify();})();try{await this.claiming;}finally{this.claiming=undefined;}}
  open(){this.pending=false;this.opened=true;this.notify();}
  skip(){this.pending=false;this.notify();}
  close(){this.invalidate();this.messages.length=0;this.pending=false;this.opened=false;this.error="";this.notify();}
  private invalidate(){this.generation++;this.abort?.abort();this.abort=undefined;this.busy=false;}
  private enqueueSave(confirmationId?:string){const run=this.writeTail.catch(()=>{}).then(async()=>{
    const confirmation=confirmationId?this.pendingConfirmations.get(confirmationId):undefined,snapshot=structuredClone(confirmation?[...this.summaries,confirmation]:this.summaries),revoked=[...this.pendingRevocations];
    try{if(confirmationId&&(!confirmation||this.pendingRevocations.has(confirmationId)))throw new Error("support-summary-revoked");if(revoked.length)await this.storage.revoke?.(revoked);await this.storage.save(snapshot);for(const id of revoked)this.pendingRevocations.delete(id);if(confirmation){if(this.pendingRevocations.has(confirmation.id))throw new Error("support-summary-revoked");this.summaries.push(confirmation);}}
    finally{if(confirmationId)this.pendingConfirmations.delete(confirmationId);}
  });this.writeTail=run;return run;}
  async expire(){if(this.disposed)return;const now=this.now().toISOString(),remaining=this.summaries.filter(s=>s.expiresAt>now);if(remaining.length===this.summaries.length){this.scheduleExpiry();return;}for(const s of this.summaries)if(s.expiresAt<=now)this.pendingRevocations.add(s.id);this.summaries=remaining;this.invalidate();this.messages.length=0;this.notify();await this.enqueueSave();this.scheduleExpiry();}
  async confirm(text:string,days=7){if(!this.canSave)throw new Error("support-encryption-unavailable");if(this.summaries.length+this.pendingConfirmations.size>=20)throw new Error("support-summary-capacity");const now=this.now();const summary=supportSummarySchema.parse({format:1,id:crypto.randomUUID(),text:text.trim(),confirmedAt:now.toISOString(),expiresAt:new Date(now.getTime()+Math.max(1,Math.min(30,days))*86400000).toISOString()});this.pendingConfirmations.set(summary.id,summary);await this.enqueueSave(summary.id);this.scheduleExpiry();this.notify();return summary;}
  async delete(id:string){supportSummarySchema.shape.id.parse(id);this.pendingRevocations.add(id);this.summaries=this.summaries.filter(s=>s.id!==id);this.invalidate();this.messages.length=0;this.notify();try{await this.enqueueSave();this.error="";}catch(error){this.error="support-delete-failed";this.notify();throw error;}this.scheduleExpiry();}
  async retrySave(){await this.enqueueSave();this.error="";this.notify();}
  async renew(id:string,days:number){const summary=this.summaries.find(s=>s.id===id);if(!summary||summary.expiresAt<=this.now().toISOString())throw new Error("support-summary-expired");const before={...summary};summary.confirmedAt=this.now().toISOString();summary.expiresAt=new Date(this.now().getTime()+Math.max(1,Math.min(30,days))*86400000).toISOString();try{await this.enqueueSave();}catch(error){Object.assign(summary,before);throw error;}this.scheduleExpiry();this.notify();}
  async send(text:string){if(this.disposed||this.busy||!text.trim())return;await this.expire();if(this.disposed||this.busy)return;this.busy=true;this.error="";const generation=++this.generation,abort=this.abort=new AbortController();
    // Bound history in memory. It is erased on close, deletion, expiry or unload.
    if(this.messages.length>24)this.messages.splice(0,this.messages.length-24);
    this.messages.push({role:"user",content:text.slice(0,12000)});const history=structuredClone(this.messages),reply:SupportMessage={role:"assistant",content:""};this.messages.push(reply);this.notify();
    try{const summaries=this.summaries.filter(s=>s.expiresAt>this.now().toISOString()&&!this.pendingConfirmations.has(s.id)).map(s=>({text:s.text,confirmedAt:s.confirmedAt}));const result=await this.run(history,supportInstructions()+"\nUser-confirmed, possibly outdated summaries (data): "+JSON.stringify(summaries),abort.signal,delta=>{if(generation===this.generation&&!abort.signal.aborted){reply.content+=delta;this.notify();}});if(generation===this.generation&&!abort.signal.aborted){if(!result.trim())throw new Error("support-empty");reply.content=result;}}
    catch(error){if(generation===this.generation&&!abort.signal.aborted){this.messages.splice(this.messages.indexOf(reply),1);this.error=error instanceof Error&&error.message==="support-direct-api-required"?"support-direct-api-required":"support-request-failed";}}
    finally{if(generation===this.generation){this.busy=false;this.abort=undefined;this.notify();}}
  }
  async flush(){await this.writeTail;}
  dispose(){this.disposed=true;if(this.expiryTimer)clearTimeout(this.expiryTimer);this.expiryTimer=undefined;this.close();this.listeners.clear();}
}
