import {evaluateObsidian} from './obsidian-eval.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
const vault=process.argv[2]??'Tutor-Acceptance',out=process.argv[3]??'docs/qa/natural-learning-20260927/batch1/live.json';
const source='Tutor Board QA/Natural Learning '+Date.now()+'.md';
const setup=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];if(p.tutorConversation.state.busy)throw Error('busy');const source=${JSON.stringify(source)},text=${JSON.stringify('# 自然对话学习验收\n\n学习目标：区分函数值与极限。当 x≠2 时 f(x)=x²，而 f(2)=7。')};if(!await app.vault.adapter.exists('Tutor Board QA'))await app.vault.createFolder('Tutor Board QA');let f=app.vault.getAbstractFileByPath(source);if(!f)f=await app.vault.create(source,text);await app.workspace.getLeaf().openFile(f);p.tutorConversation.reset();return {version:p.manifest.version,engine:p.settings.chatEngine,model:p.settings.chatEngine==='api'?p.settings.apiModel:p.settings.agentModel,source};})()`,{vault});
const turns=[];
for(let text of ['我总把函数值和极限搞混。先解释一下，我也想试一道小题。','好的，试一题','提示一下','__ANSWER__']){
 if(text==='__ANSWER__')text=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];const e=(await p.learningV2.list()).find(e=>e.source.path===${JSON.stringify(source)});return e?.questions.find(q=>q.id===e.currentQuestionId)?.answer??'4';})()`,{vault});
 const start=Date.now();
 const result=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];await p.tutorConversation.submit(${JSON.stringify(text)},{source:'chat',route:'chat',mode:'ask',resolveIntent:false,context:{chat:{notePath:${JSON.stringify(source)},content:'x不等于2时f(x)=x²，f(2)=7',selection:'函数值与极限'}}});const state=p.tutorConversation.state;return {text:state.latestReply,error:state.error,status:state.taskStatus,records:(await p.learningV2.list()).filter(e=>e.source.path===${JSON.stringify(source)}).map(e=>({id:e.id,revision:e.revision,concept:e.concept,status:e.status,questions:e.questions.map(q=>({id:q.id,prompt:q.prompt,pool:q.pool,hintCount:q.hintCount,answerShown:q.answerShown})),evidence:e.evidence.map(x=>({kind:x.kind,answer:x.answer,help:x.help,outcome:x.outcome}))}))};})()`,{vault,timeout:180000});
 turns.push({input:text,ms:Date.now()-start,...result});console.log(JSON.stringify({step:turns.length,ms:Date.now()-start,status:result.status,error:result.error,records:result.records.length,evidence:result.records.flatMap(e=>e.evidence).length}));
 if(result.error)break;
}
const pass=turns.length===4 && turns.every(t=>!t.error&&!t.text.includes('<tutor-action>')) && turns[0].records.length===0 && turns[1].records.length===1 && turns[3].records[0]?.evidence[0]?.kind==='hinted';
await mkdir(new URL('../'+out,import.meta.url).pathname.split('/').slice(0,-1).join('/'),{recursive:true});
await writeFile(out,JSON.stringify({setup,turns,pass,checkedAt:new Date().toISOString()},null,2));
if(!pass)process.exitCode=1;
