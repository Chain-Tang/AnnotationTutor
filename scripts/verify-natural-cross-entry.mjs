import {evaluateObsidian} from './obsidian-eval.mjs';
import {readFile,writeFile} from 'node:fs/promises';
const source=JSON.parse(await readFile('docs/qa/natural-learning-20260927/batch2/live.json','utf8')).setup.source;
const result=await evaluateObsidian(`(async()=>{
 const p=app.plugins.plugins['annotation-tutor-lite'],source=${JSON.stringify(source)};
 const before=(await p.learningV2.list()).find(e=>e.source.path===source&&e.status==='active');if(!before)throw Error('active fixture missing');
 const id='ANN-'+crypto.randomUUID(),at=new Date().toISOString();
 await p.finishCreate({id,sourceFile:source,anchor:{blockId:'qa-natural',selectedText:'函数值与极限',sourceType:'markdown'},anchorOrigin:'generated',userNote:'合成批注：继续已有练习',status:'saved',concepts:[],relatedMemoryCells:[],createdAt:at,updatedAt:at},false);
 const context=await p.learningContextSnapshot({source,annotationId:id});
 const reply=await p.replyInAnnotation(id,'继续这道题，给我一点提示');
 const after=(await p.learningV2.list()).find(e=>e.id===before.id),q=e=>e.questions.find(q=>q.id===e.currentQuestionId);
 if(!reply.ok||!reply.agentText||after.evidence.length!==before.evidence.length||q(after).hintCount!==q(before).hintCount+1)throw Error('annotation hint failed: '+JSON.stringify(reply));
 const file=app.vault.getAbstractFileByPath(source),leaf=app.workspace.getLeaf();await leaf.openFile(file);
 const modes=[];for(const mode of [{mode:'preview'},{mode:'source',source:false},{mode:'source',source:true}]){await leaf.setViewState({type:'markdown',state:{file:source,...mode}});const observed=await p.chatContext();modes.push({mode,source:observed?.notePath,observation:observed?.observation});}
 const renamed=source.replace('.md',' Renamed.md');await app.fileManager.renameFile(file,renamed);
 for(let i=0;i<40;i++){if((await p.learningV2.list()).find(e=>e.id===before.id)?.source.path===renamed)break;await new Promise(r=>setTimeout(r,50));}
 const restored=(await p.learningV2.list()).find(e=>e.id===before.id);
 return {passed:context.episodes[0]?.id===before.id&&restored.source.path===renamed&&modes.every(m=>m.source===source),id:before.id,annotation:id,reply:reply.agentText,modes,renamed:restored.source.path,version:p.manifest.version,visualPassed:false,scope:'Real model, annotation API and Obsidian view-state APIs; visual/IME interaction still unverified'};
})()`,{vault:'Tutor-Acceptance',timeout:180000});
await writeFile('docs/qa/natural-learning-20260927/batch3/cross-entry.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
