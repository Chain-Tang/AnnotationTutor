import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
async function main(){
const home=join(homedir(),'.local','share','tutor');
let selected=process.env.TUTOR_INSTANCE_ID, remote, remotePort;
const read=async path=>JSON.parse(await readFile(path,'utf8'));
async function instances(){
  let names=[];try{names=await readdir(join(home,'instances'));}catch{return [];}
  const result=[];
  for(const name of names.filter(n=>/^[a-f0-9]{24}\.json$/.test(n))){
    try{const entry=await read(join(home,'instances',name));if(entry.id+'.json'!==name||!Number.isInteger(entry.port)||entry.port<1||entry.port>65535||!Number.isInteger(entry.pid))continue;process.kill(entry.pid,0);result.push(entry);}catch{}
  }return result;
}
async function instance(id){const list=await instances();const result=list.find(i=>i.id===(id??selected))??(!id&&!selected&&list.length===1?list[0]:undefined);if(!result)throw new Error(list.length?'Choose an instanceId with tutor_connect.':'Tutor unavailable: open Obsidian and enable Tutor MCP.');return result;}
async function connect(){
  const entry=await instance(),record=await read(join(home,'clients',`codex-${entry.id}.json`)).catch(()=>null);
  if(!record?.token)throw new Error('Tutor is not paired. Call tutor_connect and select the permitted scope in Obsidian.');
  if(remote&&remotePort===entry.port)return remote;
  await remote?.close();remote=undefined;remotePort=undefined;
  const client=new Client({name:'tutor-codex',version:'0.3.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${entry.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${record.token}`}}}));
  remote=client;remotePort=entry.port;return client;
}
const tools=[
 {name:'tutor_instances',description:'Find running local Obsidian Tutor vaults. This contains no credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'tutor_connect',description:'Request pairing with one local vault. Choose the authorized documents, canvases and selected objects in the Obsidian dialog. Existing pairing can be reused; re-pair only to change scope.',inputSchema:{type:'object',properties:{instanceId:{type:'string',pattern:'^[a-f0-9]{24}$'},repair:{type:'boolean'}},additionalProperties:false}},
 {name:'tutor_diagnose',description:'Check local service and pairing without printing credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false}}
];
const server=new Server({name:'tutor-connector',version:'0.3.0'},{capabilities:{tools:{listChanged:true}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>{try{return {tools:[...tools,...(await(await connect()).listTools()).tools]};}catch{return {tools};}});
server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  const name=request.params.name,args=request.params.arguments??{};
  const result=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
  try{
    if(name==='tutor_instances')return result({instances:await instances()});
    if(name==='tutor_connect'){
      if(args.instanceId!==undefined&&!/^[a-f0-9]{24}$/.test(args.instanceId))throw new Error('Invalid instanceId');
      const entry=await instance(args.instanceId);selected=entry.id;
      if(!args.repair){try{await connect();return result({connected:true,instanceId:entry.id});}catch{}}
      const response=await fetch(`http://127.0.0.1:${entry.port}/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Codex Tutor plugin'}),signal:AbortSignal.any([extra.signal,AbortSignal.timeout(125000)])});
      if(!response.ok)throw new Error('Pairing declined, busy, or unavailable. Check Obsidian.');
      const data=await response.json();if(!/^[a-f0-9]{64}$/.test(data.token))throw new Error('Invalid pairing response');
      const dir=join(home,'clients');await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,`codex-${entry.id}.json`);
      await writeFile(path+'.tmp',JSON.stringify({token:data.token,clientId:data.clientId}),{mode:0o600});await rename(path+'.tmp',path);
      await remote?.close();remote=undefined;await connect();await server.sendToolListChanged();return result({connected:true,instanceId:entry.id});
    }
    if(name==='tutor_diagnose'){const entry=await instance();await connect();return result({available:true,instanceId:entry.id,name:entry.name});}
    return await(await connect()).callTool(request.params,undefined,{signal:extra.signal,timeout:120000});
  }catch(error){return {isError:true,content:[{type:'text',text:String(error.message??'Tutor connection failed').replace(/Bearer\s+\S+/gi,'Bearer [redacted]')}]};}
});
await server.connect(new StdioServerTransport());
process.on('SIGTERM',()=>{void remote?.close();void server.close();});

}
main().catch(()=>{process.stderr.write("Tutor connector failed to start. Use Node.js 22 or later.\n");process.exitCode=1;});
