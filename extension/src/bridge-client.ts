import { BRIDGE_DISCOVERY_PORTS, type BridgeConfig } from "./messages.js";

export interface LocalStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validRequestId = (value: string): boolean => UUID.test(value);
export const bridgeUrl = (config: {port:number}, path: string): string => `http://127.0.0.1:${config.port}${path}`;
function isConfig(value: unknown): value is BridgeConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as BridgeConfig;
  return item.v === 2 && UUID.test(item.clientId) && typeof item.vaultId === "string" && !!item.vaultId &&
    /^[\w-]{43}$/.test(item.token) && BRIDGE_DISCOVERY_PORTS.includes(item.port) &&
    Array.isArray(item.capabilities) && item.capabilities.length > 0 && item.capabilities.every(v => v === "capture" || v === "ask") && typeof item.targetDirectory === "string";
}
type PendingPair = {challengeId:string;proof:string;port:number;expiresAt:string;vaultId:string};
export type ConnectionStatus = {ok:boolean;pending?:boolean;error?:string};

/** Pairing is an explicit UI action. Read/reconnect paths never replay a capture or model request. */
export class BridgeClient {
  private pairTail: Promise<unknown> = Promise.resolve();
  constructor(private storage:LocalStorage, private send:typeof fetch = fetch) {}
  async load():Promise<BridgeConfig|null> {
    const stored=await this.storage.get(["clipperConnection","token"]);
    // Old shared tokens have no authenticated vault or client scope.
    if (stored.token !== undefined) await this.storage.remove("token");
    return isConfig(stored.clipperConnection) ? stored.clipperConnection : null;
  }
  async fetch(config:BridgeConfig,path:string,init:RequestInit={}):Promise<Response> {
    const headers=new Headers(init.headers);headers.set("Authorization",`Bearer ${config.token}`);
    return this.send(bridgeUrl(config,path),{...init,headers});
  }
  private async quick(url:string,init:RequestInit={}):Promise<Response> {
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),1500);
    try{return await this.send(url,{...init,signal:abort.signal});}finally{clearTimeout(timer);}
  }
  async locate(config:BridgeConfig):Promise<BridgeConfig|null> {
    for (const port of [...new Set([config.port,...BRIDGE_DISCOVERY_PORTS])]) {
      try {
        const response=await this.quick(bridgeUrl({port},"/ping"),{headers:{Authorization:`Bearer ${config.token}`}});
        if(!response.ok)continue;
        const value=await response.json() as Record<string,unknown>;
        if(value.v!==2||value.clientId!==config.clientId||value.vaultId!==config.vaultId)continue;
        const next={...config,port,capabilities:value.capabilities,targetDirectory:value.targetDirectory};
        if(!isConfig(next))continue;
        await this.storage.set({clipperConnection:next});return next;
      }catch{/* A status probe never resubmits work. */}
    }
    return null;
  }
  connect(explicit=false):Promise<ConnectionStatus> {
    const next=this.pairTail.catch(()=>{}).then(()=>this.connectOnce(explicit));this.pairTail=next;return next;
  }
  private async connectOnce(explicit:boolean):Promise<ConnectionStatus> {
    const stored=await this.storage.get("clipperPairing"),pending=stored.clipperPairing as PendingPair|undefined;
    if(pending&&Date.parse(pending.expiresAt)>Date.now()){
      try{
        const response=await this.quick(bridgeUrl(pending,"/pair/claim"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({challengeId:pending.challengeId,proof:pending.proof})});
        if(response.status===202)return {ok:false,pending:true};
        if(!response.ok){await this.storage.remove("clipperPairing");return {ok:false,error:"pairing-denied-or-expired"};}
        const value=await response.json() as Record<string,unknown>;
        const config={v:value.v,clientId:value.clientId,vaultId:value.vaultId,token:value.token,capabilities:value.capabilities,targetDirectory:value.targetDirectory,port:pending.port};
        if(!isConfig(config)||config.vaultId!==pending.vaultId)throw new Error("pairing-identity-mismatch");
        await this.storage.set({clipperConnection:config});await this.storage.remove("clipperPairing");return {ok:true};
      }catch{return {ok:false,pending:true};}
    }
    if(pending)await this.storage.remove("clipperPairing");
    const config=await this.load();if(config&&await this.locate(config))return {ok:true};
    if(!explicit)return {ok:false};
    const proof=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,"0")).join("");
    const proofHash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(proof))),byte=>byte.toString(16).padStart(2,"0")).join("");
    for(const port of BRIDGE_DISCOVERY_PORTS){
      try{
        const response=await this.quick(bridgeUrl({port},"/pair"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({v:2,name:"Tutor Advanced Clipper",capabilities:["capture","ask"],proofHash})});
        if(response.status!==202)continue;
        const value=await response.json() as Record<string,unknown>;
        if(typeof value.challengeId!=="string"||!UUID.test(value.challengeId)||typeof value.expiresAt!=="string"||typeof value.vaultId!=="string")continue;
        await this.storage.set({clipperPairing:{challengeId:value.challengeId,proof,expiresAt:value.expiresAt,vaultId:value.vaultId,port}});
        return {ok:false,pending:true};
      }catch{/* Only an explicit connection action can discover a pairing endpoint. */}
    }
    return {ok:false,error:"bridge-unavailable"};
  }
}
