import { describe, expect, it } from "vitest";
import { LocalBoardMcpAdapter } from "../src/board-mcp.js";
import { DefaultBoardToolRuntime } from "../src/board-tools.js";

describe("local Board MCP adapter", () => {
  it("cancels a pending pairing when the client disconnects", async () => {
    let entered!:()=>void, aborted!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;}),cancelled=new Promise<void>(resolve=>{aborted=resolve;});
    const adapter=new LocalBoardMcpAdapter(new DefaultBoardToolRuntime(),{pair:async(_name,signal)=>{
      entered();await new Promise<void>(resolve=>signal.addEventListener("abort",()=>{aborted();resolve();},{once:true}));throw new Error("pairing-cancelled");
    }});
    const endpoint=await adapter.start(),request=new AbortController();
    try{
      const response=fetch(`http://${endpoint.host}:${endpoint.port}/pair`,{method:"POST",body:JSON.stringify({name:"temporary-client"}),signal:request.signal}).catch(()=>undefined);
      await ready;request.abort();await cancelled;await response;
    }finally{await adapter.stop();}
  });
  it("exposes typed tools but no shell, DOM, Vault or script capability", async () => {
    const adapter = new LocalBoardMcpAdapter(new DefaultBoardToolRuntime());
    const initialized = await adapter.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(initialized.result).toMatchObject({ protocolVersion: "2025-06-18" });
    const listed = await adapter.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const text = JSON.stringify(listed.result);
    expect(text).toContain("node.create");
    expect(text).toContain("board.begin_transaction");
    expect(text).not.toMatch(/shell|javascript|vault|dom/i);
  });

  it("starts only on localhost with a token and releases the port", async () => {
    const adapter = new LocalBoardMcpAdapter(new DefaultBoardToolRuntime());
    const endpoint = await adapter.start();
    expect(endpoint.host).toBe("127.0.0.1");
    expect(endpoint.port).toBeGreaterThan(0);
    expect(endpoint.token).toMatch(/^[a-f0-9]{48}$/);
    expect(adapter.running).toBe(true);
    const url = `http://${endpoint.host}:${endpoint.port}/mcp`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    const initialized = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion:"2025-06-18",clientInfo:{name:"test",version:"1"},capabilities:{}} }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    await adapter.stop();
    expect(adapter.running).toBe(false);
  });
});
