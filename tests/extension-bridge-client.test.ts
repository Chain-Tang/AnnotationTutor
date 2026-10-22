import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BridgeClient, type LocalStorage } from "../extension/src/bridge-client.js";
import type { BridgeConfig } from "../extension/src/messages.js";
function storage(initial:Record<string,unknown>={}):LocalStorage&{data:Record<string,unknown>} {
  const data=structuredClone(initial);return {data,get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(key=>key in data).map(key=>[key,data[key]])),set:async values=>{Object.assign(data,structuredClone(values));},remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete data[key];}};
}
const config=():BridgeConfig=>({v:2,clientId:randomUUID(),vaultId:"synthetic-vault",token:"a".repeat(43),port:51256,capabilities:["capture","ask"],targetDirectory:"Approved"});
describe("browser explicit bridge client",()=>{
  it("clears legacy shared tokens and never starts pairing from a status probe",async()=>{
    const local=storage({token:"legacy"}),send=vi.fn<typeof fetch>();const client=new BridgeClient(local,send);
    expect(await client.connect(false)).toEqual({ok:false});expect(send).not.toHaveBeenCalled();expect(local.data).not.toHaveProperty("token");
  });
  it("creates a challenge only after explicit connect and stores the host-approved grant locally",async()=>{
    const local=storage(),approved=config(),challengeId=randomUUID();let grantReady=false;
    const send=vi.fn<typeof fetch>(async (input,init)=>{
      const path=new URL(input.toString()).pathname;
      if(path==="/pair"){
        const body=JSON.parse(init!.body as string);expect(body.v).toBe(2);expect(body).not.toHaveProperty("token");expect(body.proofHash).toMatch(/^[a-f0-9]{64}$/);
        return Response.json({v:2,challengeId,vaultId:approved.vaultId,expiresAt:new Date(Date.now()+300000).toISOString()},{status:202});
      }
      if(path==="/pair/claim")return grantReady?Response.json({...approved,state:"paired"}):Response.json({state:"pending"},{status:202});
      throw new Error("unexpected endpoint");
    });
    const client=new BridgeClient(local,send);expect(await client.connect(true)).toEqual({ok:false,pending:true});expect(local.data).not.toHaveProperty("clipperConnection");
    expect(await client.connect(false)).toEqual({ok:false,pending:true});grantReady=true;expect(await client.connect(false)).toEqual({ok:true});expect(await client.load()).toEqual(approved);
    expect(send.mock.calls.filter(([url])=>url.toString().endsWith("/pair"))).toHaveLength(1);expect(local.data).not.toHaveProperty("clipperPairing");
  });
  it("rejects a paired response for another vault and does not trust a name or port",async()=>{
    const saved=config(),local=storage({clipperConnection:saved});const send=vi.fn<typeof fetch>(async()=>Response.json({...saved,vaultId:"different-vault"}));
    const client=new BridgeClient(local,send);expect(await client.connect(false)).toEqual({ok:false});expect(local.data.clipperConnection).toEqual(saved);
    expect(send.mock.calls.every(([url])=>new URL(url.toString()).pathname==="/ping")).toBe(true);
  });
  it("sends each paid POST exactly once even after a transport error or 401",async()=>{
    const send=vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(new Response(null,{status:401}));
    const client=new BridgeClient(storage(),send),saved=config();
    await expect(client.fetch(saved,"/ask",{method:"POST",body:"synthetic"})).rejects.toThrow("lost response");expect(send).toHaveBeenCalledTimes(1);
    expect((await client.fetch(saved,"/ask",{method:"POST",body:"synthetic"})).status).toBe(401);expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([url])=>url.toString().endsWith("/ask"))).toBe(true);
  });
});
