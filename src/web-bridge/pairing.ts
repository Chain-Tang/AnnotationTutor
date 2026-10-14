import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isTrustedBridgeOrigin } from "./protocol.js";

export const clipperCapabilitySchema=z.enum(["capture","ask"]);
export type ClipperCapability=z.infer<typeof clipperCapabilitySchema>;
const directory=z.string().min(1).max(1000).refine(value=>!value.startsWith("/")&&!value.includes("\\")&&!value.split("/").some(part=>!part||part==="."||part===".."));
export const clipperClientSchema=z.object({clientId:z.string().uuid(),vaultId:z.string().min(1).max(200),name:z.string().min(1).max(80),
  origin:z.string().refine(isTrustedBridgeOrigin),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),capabilities:z.array(clipperCapabilitySchema).min(1).max(2),
  targetDirectory:directory,createdAt:z.string().datetime(),revokedAt:z.string().datetime().optional()}).strict();
export type ClipperClient=z.infer<typeof clipperClientSchema>;
export const clipperPairRequestSchema=z.object({v:z.literal(2),name:z.string().trim().min(1).max(80),capabilities:z.array(clipperCapabilitySchema).min(1).max(2),proofHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ClipperPairChallenge={challengeId:string;name:string;origin:string;capabilities:ClipperCapability[];targetDirectory:string;vaultId:string;expiresAt:string};
export type ClipperApproval={capabilities:ClipperCapability[];targetDirectory:string};
type Challenge=ClipperPairChallenge&{proofHash:string;state:"pending"|"approved"|"denied"|"consumed";approval?:ClipperApproval};
export class ClipperAccessError extends Error {constructor(readonly code:string,readonly status=403){super(code);}}
export const clipperDigest=(value:string)=>createHash("sha256").update(value).digest("hex");
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

/** Independent client grants; the persistence boundary receives hashes, never bearer tokens. */
export class ClipperPairingStore {
  private clients:ClipperClient[];
  private challenges=new Map<string,Challenge>();
  private rates=new Map<string,number[]>();
  private tail:Promise<unknown>=Promise.resolve();
  private revoked=new Set<(clientId:string)=>void>();
  private failures=new Set<()=>void>();
  private blocked=false;
  get persistenceBlocked(){return this.blocked;}
  private requirePersistence(){if(this.blocked)throw new ClipperAccessError("authorization-storage-unavailable",503);}
  private async persistClients(clients:ClipperClient[]){
    try{await this.options.persist(structuredClone(clients));this.blocked=false;}
    catch(error){this.blocked=true;for(const listener of this.failures){try{listener();}catch{/* A listener cannot undo the fail-closed state. */}}throw error;}
  }
  constructor(readonly options:{vaultId:string;targetDirectory:string;clients:readonly ClipperClient[];persist:(clients:ClipperClient[])=>Promise<void>;now?:()=>number}){
    directory.parse(options.targetDirectory);
    z.string().min(1).max(200).parse(options.vaultId);
    this.clients=z.array(clipperClientSchema).max(128).parse(options.clients);
    if(this.clients.some(client=>client.vaultId!==options.vaultId)||new Set(this.clients.map(client=>client.clientId)).size!==this.clients.length||new Set(this.clients.map(client=>client.tokenHash)).size!==this.clients.length)throw new Error("clipper-grant-identity-mismatch");
  }
  private now(){return this.options.now?.()??Date.now();}
  private queue<T>(run:()=>Promise<T>):Promise<T>{const next=this.tail.catch(()=>{}).then(run);this.tail=next;return next;}
  request(input:unknown,origin:string):ClipperPairChallenge{
    this.requirePersistence();
    if(!isTrustedBridgeOrigin(origin))throw new ClipperAccessError("pairing-origin-denied");
    const parsed=clipperPairRequestSchema.safeParse(input);if(!parsed.success)throw new ClipperAccessError("invalid-pairing-request",400);
    const now=this.now();for(const [id,challenge] of this.challenges)if(Date.parse(challenge.expiresAt)<=now)this.challenges.delete(id);
    for(const [key,times] of this.rates)if(times.every(time=>now-time>=300000))this.rates.delete(key);
    const recent=(this.rates.get(origin)??[]).filter(time=>now-time<300000);
    if(recent.length>=3||this.challenges.size>=16||(!this.rates.has(origin)&&this.rates.size>=64))throw new ClipperAccessError("pairing-rate-limited",429);
    this.rates.set(origin,[...recent,now]);
    const challenge:Challenge={challengeId:randomUUID(),name:parsed.data.name,origin,capabilities:[...new Set(parsed.data.capabilities)],targetDirectory:this.options.targetDirectory,
      vaultId:this.options.vaultId,expiresAt:new Date(now+300000).toISOString(),proofHash:parsed.data.proofHash,state:"pending"};
    this.challenges.set(challenge.challengeId,challenge);
    const {proofHash:_,state:__,...visible}=challenge;return visible;
  }
  approve(challengeId:string,decision:ClipperApproval|null):void{
    const challenge=this.challenges.get(challengeId);
    if(!challenge||Date.parse(challenge.expiresAt)<=this.now()||challenge.state!=="pending")return;
    if(!decision){challenge.state="denied";return;}
    const capabilities=[...new Set(z.array(clipperCapabilitySchema).min(1).max(2).parse(decision.capabilities))];
    if(capabilities.some(capability=>!challenge.capabilities.includes(capability)))throw new ClipperAccessError("capability-expansion-denied");
    challenge.approval={capabilities,targetDirectory:directory.parse(decision.targetDirectory)};challenge.state="approved";
  }
  claim(challengeId:string,proof:string,origin:string){return this.queue(async()=>{
    this.requirePersistence();
    const challenge=this.challenges.get(challengeId);
    if(!challenge||Date.parse(challenge.expiresAt)<=this.now())throw new ClipperAccessError("pairing-expired",410);
    if(!/^[a-f0-9]{64}$/.test(proof)||challenge.origin!==origin||!equal(clipperDigest(proof),challenge.proofHash))throw new ClipperAccessError("pairing-proof-denied");
    if(challenge.state==="consumed")throw new ClipperAccessError("pairing-consumed",409);
    if(challenge.state==="denied")throw new ClipperAccessError("pairing-denied");
    if(challenge.state==="pending")return {state:"pending" as const,expiresAt:challenge.expiresAt};
    if(this.clients.length>=128)throw new ClipperAccessError("client-capacity-reached",429);
    const token=randomBytes(32).toString("base64url"),client:ClipperClient={clientId:randomUUID(),vaultId:this.options.vaultId,name:challenge.name,origin,
      tokenHash:clipperDigest(token),capabilities:challenge.approval!.capabilities,targetDirectory:challenge.approval!.targetDirectory,createdAt:new Date(this.now()).toISOString()};
    await this.persistClients([...this.clients,client]);
    this.clients.push(client);challenge.state="consumed";
    return {state:"paired" as const,v:2 as const,clientId:client.clientId,vaultId:client.vaultId,token,capabilities:client.capabilities,targetDirectory:client.targetDirectory};
  });}
  authorize(header:string|undefined,origin:string,capability?:ClipperCapability):ClipperClient{
    this.requirePersistence();
    const token=/^Bearer ([\w-]{43})$/.exec(header??"")?.[1];
    const digest=token?clipperDigest(token):"";
    const client=this.clients.find(client=>!client.revokedAt&&client.origin===origin&&equal(client.tokenHash,digest));
    if(!client)throw new ClipperAccessError("unauthorized",401);
    if(capability&&!client.capabilities.includes(capability))throw new ClipperAccessError("capability-not-granted");
    return structuredClone(client);
  }
  revoke(clientId:string):Promise<void>{return this.queue(async()=>{
    const client=this.clients.find(client=>client.clientId===clientId);if(!client)return;
    if(client.revokedAt&&!this.blocked)return;
    client.revokedAt??=new Date(this.now()).toISOString();for(const listener of this.revoked){try{listener(clientId);}catch{/* Revocation still must persist if one observer fails. */}}
    await this.persistClients(this.clients);
  });}
  subscribeRevocations(listener:(clientId:string)=>void){this.revoked.add(listener);return()=>{this.revoked.delete(listener);};}
  subscribePersistenceFailures(listener:()=>void){this.failures.add(listener);return()=>{this.failures.delete(listener);};}
  listClients(){return this.clients.map(({tokenHash:_,...client})=>structuredClone(client));}
}
