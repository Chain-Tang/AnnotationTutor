import { z } from "zod";
import { DesktopStateRecord, type DesktopStateIO } from "../desktop-state-io.js";
import { ClipperPairingStore, clipperClientSchema } from "./pairing.js";
import { requestReceiptSchema } from "./server.js";

/** A policy marker is the final initialization commit. Its presence requires
 * both independent journals; missing bytes must never reset replay protection. */
export async function loadClipperState(io:DesktopStateIO,vaultId:string,targetDirectory:string,initialize=false){
  const names=["clipper-policy-v2.json","clipper-clients-v2.json","clipper-requests-v2.json"] as const;
  const raw=await Promise.all(names.map(name=>io.read(name)));
  const fresh=raw.every(value=>value===null);
  if(raw.some(value=>value===null)&&!fresh)throw new Error("clipper-state-incomplete");
  if(fresh&&!initialize)throw new Error("clipper-state-not-initialized");
  const schema=z.object({version:z.literal(2),explicitPairing:z.literal(true),vaultId:z.literal(vaultId)}).strict();
  if(fresh){
    await io.compareWrite(names[1],null,"[]");await io.compareWrite(names[2],null,"[]");
    await io.compareWrite(names[0],null,JSON.stringify(schema.parse({version:2,explicitPairing:true,vaultId})));
  }
  const missing=():never=>{throw new Error("clipper-state-missing");};
  const policy=new DesktopStateRecord(io,names[0],value=>schema.parse(value),missing);await policy.load();
  const clients=new DesktopStateRecord(io,names[1],value=>z.array(clipperClientSchema).max(128).parse(value),missing);
  const grants=await clients.load();
  const receipts=new DesktopStateRecord(io,names[2],value=>z.array(requestReceiptSchema).max(4096).parse(value),missing);
  const records=await receipts.load();
  const auth=new ClipperPairingStore({vaultId,targetDirectory,clients:grants,persist:value=>clients.save(value)});
  return {auth,receipts,records,fresh};
}
