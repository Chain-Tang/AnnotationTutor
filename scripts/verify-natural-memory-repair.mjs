import {evaluateObsidian} from './obsidian-eval.mjs';
import {writeFile} from 'node:fs/promises';
const result=await evaluateObsidian(`(async()=>{
 const p=app.plugins.plugins['annotation-tutor-lite'];const replies=[];
 for(let i=0;i<3;i++){
  const r=await p.runTutorConversation({text:'你刚才的判断不对，我从没说我独立做对三次。',history:[],historyOffset:0,signal:new AbortController().signal,options:{source:'chat',route:'chat',mode:'ask',context:{chat:{}}},onReply:()=>{},onEvent:()=>{}},crypto.randomUUID());replies.push(r.text);
 }
 return {version:p.manifest.version,model:p.settings.apiModel,replies,scope:'Three fresh no-history Direct API turns. Manual grounding assessment required; not a guarantee across models.'};
})()`,{vault:'Tutor-Acceptance',timeout:180000});
await writeFile('docs/qa/natural-learning-20260927/batch4/memory-repair.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
