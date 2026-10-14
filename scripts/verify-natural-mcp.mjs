import {evaluateObsidian} from './obsidian-eval.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {randomBytes,createHash,randomUUID} from 'node:crypto';import {writeFile,readFile} from 'node:fs/promises';
const source=JSON.parse(await readFile('docs/qa/natural-learning-20260927/batch3/cross-entry.json','utf8')).renamed;
const token=randomBytes(32).toString('hex'),clientId='qa-'+randomUUID(),hash=createHash('sha256').update(token).digest('hex');
const grant={clientId,name:'Synthetic learning evidence QA',createdAt:new Date().toISOString(),targets:[],documents:[source],humanObjectIds:[],read:true,write:false,learningMemory:false,learningEvidence:true};
const host=code=>evaluateObsidian(code,{vault:'Tutor-Acceptance'});let client,setup;
try{
 setup=await host(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];const before=p.settings.boardMcpEnabled;p.settings.boardMcpEnabled=true;await p.applyBoardMcp();p.settings.tutorPairings.push(${JSON.stringify({tokenHash:hash,grant})});return {before,port:p.boardMcpConnection().port,snapshot:await p.learningContextSnapshot({source:${JSON.stringify(source)},allowedSources:[${JSON.stringify(source)}]})};})()`);
 client=new Client({name:'natural-learning-qa',version:'0.5.3'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${setup.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 const call=(name,args={})=>client.callTool({name,arguments:args});
 const result=await call('tutor_get_learning_context',{source});const denied=await call('tutor_get_learning_context',{source:'ungranted.md'});const legacy=await call('tutor_read_learning');
 await host(`(()=>{const p=app.plugins.plugins['annotation-tutor-lite'];p.tutorTools.revoke(${JSON.stringify(clientId)});return true;})()`);
 let revoked=false;try{revoked=!!(await call('tutor_get_learning_context',{source})).isError;}catch{revoked=true;}
 const passed=JSON.stringify(result.structuredContent)===JSON.stringify(setup.snapshot)&&!!denied.isError&&!!legacy.isError&&revoked;
 await writeFile('docs/qa/natural-learning-20260927/batch4/mcp-live.json',JSON.stringify({passed,officialSDK:true,transport:'Streamable HTTP',sameSnapshot:JSON.stringify(result.structuredContent)===JSON.stringify(setup.snapshot),ungrantedDenied:!!denied.isError,legacyMemoryStillDenied:!!legacy.isError,revoked,scope:'Temporary synthetic grant in test vault. Does not validate the human pairing UI or broaden existing client grants.'},null,2));console.log(JSON.stringify({passed}));if(!passed)process.exitCode=1;
}finally{await client?.close();if(setup)await host(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];p.settings.tutorPairings=p.settings.tutorPairings.filter(r=>r.grant.clientId!==${JSON.stringify(clientId)});p.settings.boardMcpEnabled=${setup.before};await p.applyBoardMcp();return true;})()`);}
