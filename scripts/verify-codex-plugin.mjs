import {spawn} from 'node:child_process';
/** Official App Server in an ephemeral QA session; no existing user task is used. */
export async function verifyCodexPlugin(env){
 const child=spawn('/Applications/ChatGPT.app/Contents/Resources/codex',['app-server','--listen','stdio://'],{cwd:env.HOME,env,stdio:['pipe','pipe','pipe']});
 let seq=0,buffer='',threadId='',resolveTurn,rejectTurn,chars=0,answer='';const pending=new Map(),calls=[];
 const completed=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;});void completed.catch(()=>{});
 const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});send({id,method,params});});
 const fail=error=>{for(const wait of pending.values())wait.reject(error);pending.clear();rejectTurn(error);};
 child.on('error',fail);child.on('exit',()=>fail(new Error('App Server exited')));child.stderr.on('data',()=>{});
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>3e6){fail(new Error('response too large'));child.kill();return;}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;let msg;try{msg=JSON.parse(line);}catch{fail(new Error('invalid frame'));return;}
  if(msg.id!==undefined&&!msg.method){const wait=pending.get(msg.id);pending.delete(msg.id);msg.error?wait?.reject(new Error(msg.error.message)):wait?.resolve(msg.result);}
  else if(msg.id!==undefined){console.log(JSON.stringify({serverRequest:msg.method}));send({id:msg.id,error:{message:'QA does not authorize additional permissions or commands.'}});}
  else if(msg.params?.threadId===threadId){if(msg.method==='item/agentMessage/delta'){chars+=msg.params.delta?.length??0;answer+=msg.params.delta??'';}if(msg.method==='item/started')console.log(JSON.stringify({item:msg.params.item?.type,tool:msg.params.item?.tool}));
   if(msg.method==='item/completed'&&msg.params.item?.type==='mcpToolCall'){const item=msg.params.item;calls.push({server:item.server,tool:item.tool,status:item.status,error:item.error?.message});if(calls.length>20){fail(new Error('QA tool budget exceeded'));child.kill();}}
   if(msg.method==='turn/completed')resolveTurn(msg.params.turn);
  }
 }});
 const timer=setTimeout(()=>{fail(new Error('Codex plugin QA timeout'));child.kill();},180000),start=Date.now();
 try{
  await rpc('initialize',{clientInfo:{name:'tutor-plugin-qa',version:'0.3.0'},capabilities:{experimentalApi:false}});send({method:'initialized'});
  const installed=await rpc('plugin/installed',{cwds:[env.HOME]}),plugins=installed.marketplaces.flatMap(m=>m.plugins);
  const tutor=plugins.find(p=>p.id==='tutor@personal'||p.id.startsWith('tutor@'));if(!tutor)throw new Error('Installed Tutor plugin not discovered: '+JSON.stringify(plugins.map(p=>({id:p.id,name:p.name}))));
  const config=(await rpc('config/read',{cwd:env.HOME,includeLayers:false})).config;
  const thread=await rpc('thread/start',{cwd:env.HOME,ephemeral:true,sandbox:'read-only',approvalPolicy:'untrusted',config:{mcp_servers:Object.fromEntries(Object.keys(config.mcp_servers??{}).filter(n=>!n.toLowerCase().includes('tutor')).map(n=>[n,{enabled:false}])),web_search:'disabled',plugins:Object.fromEntries(plugins.map(p=>[p.id,{enabled:p.id===tutor.id,...(p.id===tutor.id?{mcp_servers:{tutor:{default_tools_approval_mode:'approve'}}}:{})}])),features:{code_mode:false,shell_tool:false,unified_exec:false,apps:false,hooks:false,multi_agent:false},apps:{_default:{enabled:false}}},developerInstructions:'This is a Tutor plugin integration test. Use only the Tutor MCP tools to ask the independent Tutor. Do not use shell, filesystem, other plugins, external apps, or read any credentials. The test is already paired to a synthetic Obsidian canvas.'});threadId=thread.thread.id;const inventory=await rpc('mcpServerStatus/list',{threadId,limit:100});console.log(JSON.stringify({mcpInventory:inventory.data?.filter(s=>s.name==='tutor').map(s=>({name:s.name,pluginId:s.pluginId,status:s.runtimeStatus,error:s.toolsError,tools:Object.keys(s.tools??{})}))}));
  await rpc('turn/start',{threadId,disabledPluginIds:plugins.filter(p=>p.id!==tutor.id).map(p=>p.id),input:[{type:'text',text:'请调用 Tutor 插件：先诊断连接，然后使用 tutor_start_task 请独立的 Tutor 用一句中文说明 x² 在 x=2 处的极限为何是4（不画图、不保存、不修改文档），用 tutor_task_status 查询直到完成。最后转述 Tutor 的回答。不要自行替代 Tutor 回答。',text_elements:[]}],sandboxPolicy:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted'});
  const turn=await completed;const used=calls.filter(c=>c.tool?.includes('tutor_start_task'));
  const report={answer,passed:turn.status==='completed'&&used.length>0&&calls.some(c=>c.tool?.includes('tutor_task_status')),model:thread.model,modelProvider:thread.modelProvider,pluginId:tutor.id,elapsedMs:Date.now()-start,calls,replyChars:chars,turnStatus:turn.status,ephemeral:true};if(!report.passed)throw new Error(JSON.stringify(report));return report;
 }finally{clearTimeout(timer);child.kill();}
}
