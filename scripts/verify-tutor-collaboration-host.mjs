import {execFileSync} from 'node:child_process';import {mkdir,writeFile} from 'node:fs/promises';
const code=`(async()=>{
 const p=app.plugins.plugins['annotation-tutor-lite'];if(p.tutorConversation.state.busy)throw new Error('busy');
 const source=p.settings.memoryRoot+'/standalone/Upgrade-M0-QA.md';const file=app.vault.getAbstractFileByPath(source);
 // Read only the synthetic note; existing user conversations are not used.
 const leaf=app.workspace.getLeaf('tab');if(file)await leaf.openFile(file);
 const before=p.settings.tutorCodexCommand;p.settings.tutorCodexCommand='/Applications/ChatGPT.app/Contents/Resources/codex';
 const started=Date.now();try{
 const task=await p.delegateTutorToCodex('请与独立 Codex 专家合作，用简短中文核对 x² 在 x=2 处极限为4。不要调用工具、不要作图或写入文档。',['codex']);
 const end=Date.now()+180000;let final;
 while(Date.now()<end){final=p.tutorConversation.tasks.get(task.id,'obsidian');if(['completed','failed','cancelled'].includes(final.state))break;await new Promise(r=>setTimeout(r,500));}
 if(final.state!=='completed')throw new Error(JSON.stringify({state:final.state,error:final.error}));
 const children=final.children.map(id=>p.tutorConversation.tasks.get(id,'obsidian'));
 if(children.length!==1||children[0].state!=='completed')throw new Error('expert incomplete');
 return JSON.stringify({passed:true,elapsedMs:Date.now()-started,lead:{agent:final.agent,route:final.route,state:final.state},experts:children.map(t=>({agent:t.agent,route:t.route,state:t.state})),artifacts:final.artifacts.length,modelCalls:final.metrics.modelCalls,isolated:true});
 }finally{p.settings.tutorCodexCommand=before;}
})()`;
const raw=execFileSync('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',['vault=Documents','eval','code='+code],{encoding:'utf8',timeout:210000,killSignal:'SIGKILL'});
await mkdir('docs/qa/upgrade-m2',{recursive:true});await writeFile('docs/qa/upgrade-m2/collaboration-host.txt',raw);console.log(raw);if(!raw.includes('"passed":true'))process.exitCode=1;
