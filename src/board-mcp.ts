import {TutorA2AService} from "./tutor-a2a.js";
import {AgentCard} from "@a2a-js/sdk";
import {ServerCallContext} from "@a2a-js/sdk/server";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { TutorMcpTools, TutorClientGrant } from "./tutor-mcp.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BoardMcpAdapter, BoardToolEvent, BoardToolRuntime, BoardVectorAsset } from "./board-types.js";
import { ServiceWork } from "./service-work.js";
import { communicationIdentitySchema, type CommunicationIdentity } from "./tutor-communication.js";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };
export type BoardMcpCallRecord = { at: string; method: string; tool?: string; ok: boolean };

function token(): string {
  const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}
function response(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function failure(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Minimal local Streamable-HTTP MCP adapter. It never exposes DOM, Vault, shell or arbitrary scripts. */
export class LocalBoardMcpAdapter implements BoardMcpAdapter {
  private server?: Server;
  private sessionToken = "";
  private readonly calls: BoardMcpCallRecord[] = [];
  private readonly work = new ServiceWork();
  private stopping?: Promise<void>;
  private starting?: Promise<{ host: "127.0.0.1"; port: number; token: string }>;
  public constructor(
    private readonly runtime: BoardToolRuntime,
    private readonly options: { readOnly?: boolean; maxBodyBytes?: number;
      tutor?:TutorMcpTools;
      a2a?:TutorA2AService;
      authenticate?:(token:string)=>TutorClientGrant|undefined;
      pair?:(name:string,signal:AbortSignal,identity?:CommunicationIdentity)=>Promise<{token:string;clientId:string}>;
    } = {},
  ) {}
  public get running(): boolean { return !!this.server?.listening; }
  public recentCalls(): readonly BoardMcpCallRecord[] { return this.calls; }
  public start(): Promise<{ host: "127.0.0.1"; port: number; token: string }> {
    if(this.work.closed)return Promise.reject(new Error("service-stopped"));
    if(this.starting)return this.starting;
    const starting=this.work.run(undefined,()=>this.startCurrent());this.starting=starting;
    void starting.finally(()=>{if(this.starting===starting)this.starting=undefined;}).catch(()=>{});
    return starting;
  }
  private async startCurrent(): Promise<{ host: "127.0.0.1"; port: number; token: string }> {
    this.work.assertOpen();
    if (this.server?.listening) {
      const address = this.server.address() as AddressInfo;
      return { host: "127.0.0.1", port: address.port, token: this.sessionToken };
    }
    this.sessionToken = token();
    this.server = createServer((request, result) => {
      void this.work.run(undefined,signal=>this.handleHttp(request,result,signal)).catch(()=>{
        if(!result.headersSent&&!result.destroyed){result.writeHead(503);result.end();}
      });
    });
    const opening=this.server;
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    if(this.work.closed){await new Promise<void>(resolve=>opening.close(()=>resolve()));throw new Error("service-stopped");}
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Board MCP failed to bind a local TCP port");
    return { host: "127.0.0.1", port: address.port, token: this.sessionToken };
  }
  public stop(): Promise<void> {
    if(this.stopping)return this.stopping;
    const drained=this.work.close(),toolsDrained=this.options.tutor?.close();
    const server = this.server; this.server = undefined; this.sessionToken = "";
    this.stopping=(async()=>{
      const closed=server?new Promise<void>((resolve,reject)=>server.close(error=>error&&(error as NodeJS.ErrnoException).code!=="ERR_SERVER_NOT_RUNNING"?reject(error):resolve())):Promise.resolve();
      server?.closeAllConnections();
      await Promise.all([closed,drained,toolsDrained]);
    })();
    return this.stopping;
  }
  public async handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try{return await this.work.run(undefined,()=>this.handleRpcCurrent(request));}
    catch(error){return failure(request.id,-32000,error instanceof Error?error.message:"Service unavailable");}
  }
  private async handleRpcCurrent(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return failure(request.id, -32600, "Invalid JSON-RPC request");
    try {
      if (request.method === "initialize") return response(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tutor-board", version: "1.0.0" },
      });
      if (request.method === "notifications/initialized") return response(request.id, {});
      if (request.method === "tools/list") return response(request.id, { tools: this.toolList() });
      if (request.method !== "tools/call") return failure(request.id, -32601, "Method not found");
      const name = request.params?.name, args = request.params?.arguments;
      if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return failure(request.id, -32602, "tools/call requires a tool name and object arguments");
      const data = await this.invoke(name, args as Record<string, unknown>);
      this.record(request.method, name, true);
      return response(request.id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });
    } catch (error) {
      this.record(request.method, typeof request.params?.name === "string" ? request.params.name : undefined, false);
      const message = error instanceof Error ? error.message : String(error);
      return response(request.id, { content: [{ type: "text", text: message }], isError: true });
    }
  }
  private toolList(): Array<Record<string, unknown>> {
    const lifecycle = [
      ["board.begin_transaction", "Begin an isolated draft transaction for one Artboard."],
      ["board.checkpoint", "Validate and snapshot the current draft."],
      ["board.commit", "Commit a validated draft and return its vector asset."],
      ["board.rollback", "Discard a draft without modifying the board."],
    ].map(([name, description]) => ({ name, description, inputSchema: { type: "object", additionalProperties: true } }));
    const runtime = this.runtime.searchTools().filter(tool => !this.options.readOnly || !tool.write).map(tool => ({
      name: tool.name, description: tool.description,
      inputSchema: { type: "object", properties: { transactionId: { type: "string" }, arguments: { type: "object" } }, required: ["transactionId", "arguments"], additionalProperties: false },
    }));
    return [...lifecycle.filter(tool => !this.options.readOnly || tool.name === "board.begin_transaction" || tool.name === "board.rollback"), ...runtime];
  }
  private async invoke(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "board.begin_transaction") {
      const artboardId = args.artboardId, baseRevision = args.baseRevision;
      if (typeof artboardId !== "string") throw new Error("artboardId is required (use 'active' for the visible Studio)");
      if (baseRevision !== undefined && typeof baseRevision !== "number") throw new Error("baseRevision must be a number");
      return this.runtime.beginTransaction({ artboardId, baseRevision: baseRevision ?? -1, asset: args.asset as BoardVectorAsset | undefined });
    }
    const transactionId = args.transactionId;
    if (typeof transactionId !== "string") throw new Error("transactionId is required");
    if (name === "board.checkpoint") return this.runtime.checkpoint(transactionId);
    if (name === "board.commit") {
      if (this.options.readOnly) throw new Error("MCP session is read-only");
      return this.runtime.commit(transactionId);
    }
    if (name === "board.rollback") { await this.runtime.rollback(transactionId); return { rolledBack: true }; }
    const descriptor = this.runtime.searchTools().find(tool => tool.name === name);
    if (!descriptor) throw new Error(`Unknown board tool: ${name}`);
    if (this.options.readOnly && descriptor.write) throw new Error("MCP session is read-only");
    const events: BoardToolEvent[] = [];
    for await (const event of this.runtime.call(transactionId, { name, arguments: (args.arguments as Record<string, unknown> | undefined) ?? {} })) events.push(event);
    return { events };
  }
  private async handleHttp(request: IncomingMessage, result: ServerResponse, signal: AbortSignal): Promise<void> {
    // No browser origins and no DNS rebinding: this service is deliberately local.
    const address=this.server?.address() as AddressInfo|undefined;
    if(request.headers.origin || request.headers.host!==`127.0.0.1:${address?.port}`){result.writeHead(403);result.end();return;}
    if(request.method==="GET"&&request.url==="/.well-known/agent-card.json"&&this.options.a2a){result.writeHead(200,{"content-type":"application/json"});result.end(JSON.stringify(AgentCard.toJSON(this.options.a2a.card(`http://127.0.0.1:${address?.port}/a2a`))));return;}
    if(request.method!=="POST" || !["/mcp","/pair","/a2a"].includes(request.url??"")){result.writeHead(404);result.end();return;}
    const bearer=(request.headers.authorization??"").replace(/^Bearer /,"");
    const grant=this.options.authenticate?.(bearer);
    const legacy=bearer===this.sessionToken && !!this.sessionToken;
    if(request.url!=="/pair" && !grant && !legacy){result.writeHead(401,{"content-type":"application/json"});result.end(JSON.stringify({error:"Tutor pairing is missing or revoked"}));return;}
    try {
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of request){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>(this.options.maxBodyBytes??1_000_000))throw new Error("MCP request body is too large");chunks.push(buffer);}
      signal.throwIfAborted();
      const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(request.url==="/pair"){
        if(!this.options.pair || typeof parsed.name!=="string" || !parsed.name.trim() || parsed.name.length>80)throw new Error("Pairing requires a client name");
        const abort=new AbortController();const disconnected=()=>abort.abort();result.once("close",disconnected);signal.addEventListener("abort",disconnected,{once:true});
        try{
          const identity=parsed.communicationIdentity===undefined?undefined:communicationIdentitySchema.parse(parsed.communicationIdentity);
          const paired=await this.options.pair(parsed.name,abort.signal,identity);
          if(!abort.signal.aborted){result.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});result.end(JSON.stringify(paired));}
        }finally{result.off("close",disconnected);signal.removeEventListener("abort",disconnected);}return;
      }
      if(request.url==="/a2a"){
        if(!grant||!this.options.a2a){result.writeHead(401);result.end();return;}
        const abort=new AbortController(),cancel=()=>abort.abort();result.once("close",cancel);signal.addEventListener("abort",cancel,{once:true});
        try{
        const context=new ServerCallContext({requestedVersion:typeof request.headers["a2a-version"]==="string"?request.headers["a2a-version"]:"1.0",user:{isAuthenticated:true,userName:grant.clientId}});
        const response=await this.options.a2a.handler(grant,`http://127.0.0.1:${address?.port}/a2a`,abort.signal,()=>!!this.options.authenticate?.(bearer)).handle(parsed,context);
        if(Symbol.asyncIterator in response){result.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});for await(const event of response){if(abort.signal.aborted)break;result.write(`data: ${JSON.stringify(event)}\n\n`);}result.end();}
        else if(!result.destroyed){result.writeHead(200,{"content-type":"application/json"});result.end(JSON.stringify(response));}
        }finally{result.off("close",cancel);signal.removeEventListener("abort",cancel);}return;
      }
      const server=grant&&this.options.tutor ? this.options.tutor.server(grant) : this.legacySdkServer();
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      result.once("close",()=>{void transport.close();void server.close();});
      await server.connect(transport);
      await transport.handleRequest(request,result,parsed);
    } catch(error){
      if(!result.headersSent&&!result.destroyed){result.writeHead(400,{"content-type":"application/json"});result.end(JSON.stringify({error:error instanceof Error?error.message:"Invalid request"}));}
    }
  }
  private legacySdkServer():McpServer{
    const server=new McpServer({name:"tutor-board",version:"0.3.0"},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:this.toolList()}));
    server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
      try{const data=await this.work.run(extra.signal,()=>this.invoke(request.params.name,request.params.arguments??{}));this.record("tools/call",request.params.name,true);return {content:[{type:"text",text:JSON.stringify(data)}],structuredContent:data};}
      catch(error){this.record("tools/call",request.params.name,false);return {isError:true,content:[{type:"text",text:error instanceof Error?error.message:"Tool failed"}]};}
    });return server;
  }
  private record(method: string, tool: string | undefined, ok: boolean): void {
    this.calls.unshift({ at: new Date().toISOString(), method, tool, ok });
    if (this.calls.length > 100) this.calls.length = 100;
  }
}
