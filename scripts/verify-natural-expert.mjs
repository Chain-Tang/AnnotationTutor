import {evaluateObsidian} from './obsidian-eval.mjs';import {writeFile} from 'node:fs/promises';
const vault='Tutor-Acceptance',out='docs/qa/natural-learning-20260927/batch4/expert-live.json';
const result=await evaluateObsidian(`(async()=>{
 const p=app.plugins.plugins['annotation-tutor-lite'];const e=(await p.learningV2.list()).find(e=>e.source.path.includes('Natural Learning')&&e.status==='active');if(!e)throw Error('fixture missing');
 const q=e.questions.find(q=>q.id===e.currentQuestionId);const wrong='极限等于孤立点的函数值99，不需要看附近的公式。';e.evidence.push({id:crypto.randomUUID(),requestId:crypto.randomUUID(),at:new Date().toISOString(),questionId:q.id,answer:wrong,help:{hints:q.hintCount,answerShown:q.answerShown},kind:'explanation',evaluator:'learner',outcome:'unreviewed',feedback:'合成错误样本，待独立核对。'});await p.learningV2.save(e);
 const before=p.settings.learningExpertsEnabled;p.settings.learningExpertsEnabled=true;p.tutorConversation.reset();
 try {await p.tutorConversation.submit('请独立的 Codex 专家核对我这道题的解释和数学关系。',{source:'chat',route:'chat',mode:'ask',resolveIntent:false,metadata:{learningEpisodeId:e.id},context:{chat:{notePath:e.source.path,content:'合成材料：函数值与极限可以不同。',selection:'函数值与极限'}}});
 const next=(await p.learningV2.list()).find(x=>x.id===e.id),link=next.links.filter(l=>l.kind==='expert').at(-1);
 if(!link)throw Error('expert not linked: '+p.tutorConversation.state.latestReply+' / '+p.tutorConversation.state.error);
 const task=p.tutorConversation.tasks.get(link.taskId,'obsidian');await p.tutorResults.flush();
 return {task,children:task.children.map(id=>p.tutorConversation.tasks.get(id,'obsidian')),reply:p.tutorConversation.state.latestReply,error:p.tutorConversation.state.error,episode:e.id,evidenceUnchanged:JSON.stringify(e.evidence)===JSON.stringify(next.evidence)};
 }finally{p.settings.learningExpertsEnabled=before;}
})()`,{vault,timeout:240000});
await writeFile(out,JSON.stringify({result},null,2));console.log(JSON.stringify({state:result.task.state,children:result.children.map(c=>({state:c.state,route:c.route})),error:result.error}));
const recovery=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];await p.prepareUpgrade();await app.plugins.disablePlugin('annotation-tutor-lite');await app.plugins.enablePlugin('annotation-tutor-lite');const q=app.plugins.plugins['annotation-tutor-lite'];return q.tutorConversation.tasks.get(${JSON.stringify(result.task.id)},'obsidian');})()`,{vault});
const passed=!result.error&&result.task.state==='completed'&&result.children.every(c=>c.state==='completed')&&result.evidenceUnchanged&&JSON.stringify(recovery.artifacts)===JSON.stringify(result.task.artifacts.map(a=>({...a,data:{text:a.data.text,...(a.data.reviewStatus?{reviewStatus:a.data.reviewStatus}:{}),...(a.data.evidenceRevision?{evidenceRevision:a.data.evidenceRevision}:{})}})));
await writeFile(out,JSON.stringify({passed,result,recovery},null,2));console.log(JSON.stringify({passed,recovered:recovery.state,modelCalls:recovery.metrics.modelCalls}));if(!passed)process.exitCode=1;
