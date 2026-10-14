import {evaluateObsidian} from './obsidian-eval.mjs';
import {writeFile} from 'node:fs/promises';
const result=await evaluateObsidian(`(async()=>{
 const p=app.plugins.plugins['annotation-tutor-lite'];const e=(await p.learningV2.list()).find(e=>e.source.path.includes('Natural Learning')&&e.status==='active');if(!e)throw Error('active fixture missing');
 const disclosure='我今天因为考试很挫败，只想被理解，先不要出题了。';
 const historyBefore=JSON.stringify(p.tutorConversation.state.history);
 const result=await p.runTutorConversation({text:disclosure,history:[],historyOffset:0,signal:new AbortController().signal,options:{source:'chat',route:'chat',mode:'ask',metadata:{learningEpisodeId:e.id},context:{chat:{notePath:e.source.path,content:'函数值与极限可以不同。',selection:'函数值与极限'}}},onReply:()=>{},onEvent:()=>{}},crypto.randomUUID());
 const next=(await p.learningV2.list()).find(x=>x.id===e.id);
 return {version:p.manifest.version,model:p.settings.apiModel,reply:result.text,paused:next.status==='paused',evidenceUnchanged:JSON.stringify(e.evidence)===JSON.stringify(next.evidence),noDisclosure:!JSON.stringify(next).includes(disclosure),historyUnchanged:historyBefore===JSON.stringify(p.tutorConversation.state.history)};
})()`,{vault:'Tutor-Acceptance',timeout:180000});
result.passed=result.paused&&result.evidenceUnchanged&&result.noDisclosure&&result.historyUnchanged;
await writeFile('docs/qa/natural-learning-20260927/batch4/active-support.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
