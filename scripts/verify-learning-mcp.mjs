// Real acceptance-vault connection. Only synthetic Limits QA.md is paired; no learning memory grant.
import {evaluateObsidian} from './obsidian-eval.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir,homedir} from 'node:os';
const evalHost=code=>evaluateObsidian(code,{vault:'Tutor-Acceptance'});
const setup=await evalHost(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];const before=p.settings.boardMcpEnabled;await app.workspace.getLeaf().openFile(app.vault.getAbstractFileByPath('Limits QA.md'));p.settings.boardMcpEnabled=true;await p.persistSettings();return {before,port:p.boardMcpConnection().port};})()`);
const home=await mkdtemp(join(tmpdir(),'tutor-learning-client-'));let client,clientId;
try{
 console.log('Waiting for the synthetic test document to be authorized in Obsidian.');
 const response=await fetch(`http://127.0.0.1:${setup.port}/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Tutor Learning Acceptance'}),signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw new Error('pairing failed');const record=await response.json();clientId=record.clientId;
 let entry;for(const file of await readdir(join(homedir(),'.local/share/tutor/instances'))){const value=JSON.parse(await readFile(join(homedir(),'.local/share/tutor/instances',file),'utf8'));if(value.port===setup.port)entry=value;}
 if(!entry)throw new Error('discovery not published');const dir=join(home,'.local/share/tutor');await mkdir(join(dir,'instances'),{recursive:true});await mkdir(join(dir,'clients'),{recursive:true});
 await writeFile(join(dir,'instances',entry.id+'.json'),JSON.stringify(entry));await writeFile(join(dir,'clients',`codex-${entry.id}.json`),JSON.stringify(record),{mode:0o600});
 client=new Client({name:'learning-acceptance',version:'0.4.2'});await client.connect(new StdioClientTransport({command:process.execPath,args:[join(process.cwd(),'host-plugins/tutor/scripts/connector.cjs')],env:{...process.env,HOME:home,TUTOR_INSTANCE_ID:entry.id},stderr:'pipe'}));
 const call=(name,args={})=>client.callTool({name,arguments:args});
 const docs=await call('tutor_list_documents');const denied=await call('tutor_read_learning');const hidden=await call('tutor_get_context',{source:'Tutor Learning/learning/v1/episodes/private.json'});
 if(!denied.isError||!hidden.isError)throw new Error('scope escalation');
 const key='p3-learning-'+Date.now();const first=await call('tutor_start_task',{prompt:'请核对：这份学习材料中 f(2)=7，所以 x→2 的极限也是7。请纠正错误，简短解释。',source:'Limits QA.md',key});if(first.isError)throw new Error('start failed');const id=first.structuredContent.task.id;
 const repeated=await call('tutor_start_task',{prompt:'same task',source:'Limits QA.md',key});if(repeated.structuredContent.task.id!==id)throw new Error('duplicate task');
 let task;for(let i=0;i<120;i++){task=(await call('tutor_task_status',{taskId:id})).structuredContent.task;if(['completed','failed','cancelled'].includes(task.state))break;await new Promise(r=>setTimeout(r,1000));}
 const cancelStart=await call('tutor_start_task',{prompt:'解释极限的直观含义',source:'Limits QA.md',key:key+'-cancel'});const cancelled=await call('tutor_cancel_task',{taskId:cancelStart.structuredContent.task.id});
 const report={realObsidian:true,officialMcpSdk:true,codexPluginConnector:true,modelRoute:task.route,state:task.state,error:task.error,artifacts:task.artifacts,authorizedDocuments:docs.structuredContent.documents,learningMemoryDenied:denied.isError,ungrantedDocumentDenied:hidden.isError,duplicateDeduped:true,cancelled:cancelled.structuredContent.task.state==='cancelled'};
 await writeFile('docs/qa/p3-mcp-20260926.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(task.state!=='completed')process.exitCode=1;
}finally{await client?.close();if(clientId)await evalHost(`(async()=>{await app.plugins.plugins['annotation-tutor-lite'].revokeTutorClient(${JSON.stringify(clientId)});return true;})()`);await rm(home,{recursive:true,force:true});await evalHost(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];p.settings.boardMcpEnabled=${setup.before};await p.persistSettings();return true;})()`);}
