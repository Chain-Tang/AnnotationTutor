import {ClientFactory,JsonRpcTransportFactory} from '@a2a-js/sdk/client';
import {SendMessageRequest,GetTaskRequest,SubscribeToTaskRequest,CancelTaskRequest,TaskState} from '@a2a-js/sdk';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const evalHost=code=>{const raw=execFileSync('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',['vault=Documents','eval','code='+code],{encoding:'utf8',timeout:45000});const start=raw.indexOf('=>');return JSON.parse(raw.slice(start+2).trim());};
const setup=evalHost(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];if(p.tutorConversation.state.busy)throw new Error('busy');const before=p.settings.boardMcpEnabled;p.settings.boardMcpEnabled=true;await p.persistSettings();const scenes=await Promise.all((await p.tutorSurfaces()).map(s=>s.read()));return {before,port:p.boardMcpConnection().port,scenes:scenes.map(s=>({target:s.target,count:s.objects.length}))};})()`);
let client;const home=await mkdtemp(join(tmpdir(),'tutor-connector-qa-'));let clientId;
try{
 const pairing=fetch(`http://127.0.0.1:${setup.port}/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Codex Tutor QA'}),signal:AbortSignal.timeout(30000)});
 await new Promise(resolve=>setTimeout(resolve,700));
 const clicked=evalHost(`(()=>{const modal=[...document.querySelectorAll('.modal')].find(m=>m.querySelector('.modal-title')?.textContent.includes('Codex Tutor QA'));if(!modal)return {ok:false};const row=[...modal.querySelectorAll('.setting-item')].find(r=>r.querySelector('.setting-item-name')?.textContent.includes('Tutor-'));if(!row)return {ok:false,reason:'synthetic canvas not in pairing scope'};row.querySelector('.checkbox-container').click();[...modal.querySelectorAll('button')].find(b=>b.textContent==='授权所选范围').click();return {ok:true};})()`);
 if(!clicked.ok)throw new Error('Pairing UI not completed');const response=await pairing;if(!response.ok)throw new Error('pairing failed');const record=await response.json();clientId=record.clientId;
 const instances=await import('node:fs/promises').then(fs=>fs.readdir(join(process.env.HOME,'.local/share/tutor/instances')));let entry;
 for(const file of instances){const value=JSON.parse(await readFile(join(process.env.HOME,'.local/share/tutor/instances',file),'utf8'));if(value.port===setup.port)entry=value;}
 if(!entry)throw new Error('discovery not published');const dir=join(home,'.local/share/tutor');await mkdir(join(dir,'instances'),{recursive:true});await mkdir(join(dir,'clients'),{recursive:true});
 await writeFile(join(dir,'instances',entry.id+'.json'),JSON.stringify(entry));await writeFile(join(dir,'clients',`codex-${entry.id}.json`),JSON.stringify(record),{mode:0o600});
 client=new Client({name:'formal-codex-plugin-qa',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[join(process.cwd(),'host-plugins/tutor/scripts/connector.cjs')],env:{...process.env,HOME:home,TUTOR_INSTANCE_ID:entry.id},stderr:'pipe'}));
 if(!process.argv.includes("--codex-only")){
 const tools=await client.listTools();if(!tools.tools.some(t=>t.name==='tutor_start_task'))throw new Error('Tutor tools not forwarded');
 const status=await client.callTool({name:'tutor_status',arguments:{}});if(status.isError)throw new Error('status failed');
 const started=await client.callTool({name:'tutor_start_task',arguments:{prompt:'请用一句中文解释：为什么函数 x² 在 x=2 处的极限是 4？只解释，不画图。',key:'m2-host-positive'}});if(started.isError)throw new Error(JSON.stringify(started.content));
 const taskId=started.structuredContent.task.id;let task;const end=Date.now()+90000;
 while(Date.now()<end){await new Promise(resolve=>setTimeout(resolve,1000));task=(await client.callTool({name:'tutor_task_status',arguments:{taskId}})).structuredContent.task;if(['completed','failed','cancelled'].includes(task.state))break;}
 const report={ok:task?.state==='completed',toolCount:tools.tools.length,pairedThroughObsidian:true,transport:'Codex plugin stdio → SDK Streamable HTTP',task};await mkdir('docs/qa/upgrade-m2',{recursive:true});await writeFile('docs/qa/upgrade-m2/mcp-host.json',JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,toolCount:report.toolCount,state:task?.state,route:task?.route,error:task?.error}));if(!report.ok)process.exitCode=1;
 const a2a=await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:(input,init)=>fetch(input,{...init,headers:{...Object.fromEntries(new Headers(init?.headers).entries()),Authorization:`Bearer ${record.token}`}})})]}).createFromUrl(`http://127.0.0.1:${setup.port}`);
 const request=SendMessageRequest.fromJSON({message:{messageId:'m6-'+Date.now(),role:'ROLE_USER',parts:[{text:'请独立检查：函数 f(x)=x² 在 x=2 处极限是4。用一句话说明理由，不作图。'}]},configuration:{returnImmediately:true}});
 const startAt=Date.now(),remote=await a2a.sendMessage(request);if(!('id' in remote))throw new Error('A2A did not return task');
 const duplicate=await a2a.sendMessage(request);if(duplicate.id!==remote.id)throw new Error('A2A duplicate task');
 let frames=0;for await(const event of a2a.resubscribeTask(SubscribeToTaskRequest.fromJSON({id:remote.id}),{signal:AbortSignal.timeout(90000)})){frames++;}
 const completed=await a2a.getTask(GetTaskRequest.fromJSON({id:remote.id}));
 const viaMcp=(await client.callTool({name:'tutor_task_status',arguments:{taskId:remote.id}})).structuredContent.task;
 if(completed.status?.state!==TaskState.TASK_STATE_COMPLETED||viaMcp.state!=='completed')throw new Error('A2A positive failed');
 // Reconnect and query using the same authorization, never re-send the model request.
 const restored=await a2a.getTask(GetTaskRequest.fromJSON({id:remote.id}));
 const cancel=await a2a.sendMessage(SendMessageRequest.fromJSON({message:{messageId:'m6-cancel-'+Date.now(),role:'ROLE_USER',parts:[{text:'请说明极限定义。'}]},configuration:{returnImmediately:true}}));
 await a2a.cancelTask(CancelTaskRequest.fromJSON({id:cancel.id}));
 const cancelled=(await client.callTool({name:'tutor_task_status',arguments:{taskId:cancel.id}})).structuredContent.task;
 if(cancelled.state!=='cancelled'||cancelled.artifacts.length)throw new Error('A2A cancellation failed');
 await mkdir('docs/qa/upgrade-m6',{recursive:true});const a2aReport={passed:true,protocol:'A2A 1.0 official SDK → real Obsidian → configured Direct API',elapsedMs:Date.now()-startAt,frames,taskId:remote.id,route:viaMcp.route,answerLength:JSON.stringify(completed.artifacts).length,sharedMcpTask:true,duplicateRequest:true,reconnectedTaskId:restored.id,cancelled:true,remoteHttps:'not tested: endpoint not provided'};await writeFile('docs/qa/upgrade-m6/host-result.json',JSON.stringify(a2aReport,null,2));console.log(JSON.stringify(a2aReport));
 }
 if(process.argv.some(a=>['--codex-plugin','--codex-only'].includes(a))){await mkdir(join(home,'.agents'),{recursive:true});await symlink(join(process.env.HOME,'.agents/plugins'),join(home,'.agents/plugins'));await symlink(join(process.env.HOME,'plugins'),join(home,'plugins'));const {verifyCodexPlugin}=await import('./verify-codex-plugin.mjs');const report=await verifyCodexPlugin({...process.env,HOME:home,CODEX_HOME:process.env.CODEX_HOME??join(process.env.HOME,'.codex'),TUTOR_INSTANCE_ID:entry.id});await writeFile('docs/qa/upgrade-m2/codex-plugin-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}


}finally{await client?.close();if(clientId)evalHost(`(async()=>{await app.plugins.plugins['annotation-tutor-lite'].revokeTutorClient(${JSON.stringify(clientId)});return {revoked:true};})()`);await rm(home,{recursive:true,force:true});evalHost(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];p.settings.boardMcpEnabled=${JSON.stringify(setup.before)};await p.persistSettings();return {restored:true};})()`);}
