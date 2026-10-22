import {evaluateObsidian} from './obsidian-eval.mjs';
import {single,multi} from './support-natural-cases.mjs';
import {writeFile} from 'node:fs/promises';
const vault='Tutor-Acceptance',out='docs/qa/natural-learning-20260927/batch4/support-live.json';
const initial=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];return {model:p.settings.apiModel,engine:p.settings.chatEngine,version:p.manifest.version,records:JSON.stringify(await p.learningV2.list()),history:JSON.stringify(p.tutorConversation.state.history)};})()`,{vault});
const cases=[];
for(const [id,inputs,criteria] of [...single.map(([id,text,criteria])=>[id,[text],criteria]),...multi]){
 const history=[],conversationId=crypto.randomUUID();const responses=[];
 for(const input of inputs){const started=Date.now();
  try{const result=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];return p.runTutorConversation({text:${JSON.stringify(input)},history:${JSON.stringify(history)},historyOffset:0,signal:new AbortController().signal,options:{source:'chat',route:'chat',mode:'ask',context:{chat:{}}},onReply:()=>{},onEvent:()=>{}},${JSON.stringify(conversationId)});})()`,{vault,timeout:180000});
   responses.push({input,reply:result.text,ms:Date.now()-started});history.push({role:'user',content:input},{role:'assistant',content:result.text});
  }catch(error){responses.push({input,error:error.message});break;}
 }
 cases.push({id,criteria,responses});console.log(JSON.stringify({case:id,turns:responses.length,errors:responses.filter(r=>r.error).length}));
 await writeFile(out,JSON.stringify({version:initial.version,engine:initial.engine,model:initial.model,singleCount:single.length,multiCount:multi.length,cases,professionalReview:false,longitudinalBenefit:false,minorsValidated:false},null,2));
}
const unchanged=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];return {records:JSON.stringify(await p.learningV2.list()),history:JSON.stringify(p.tutorConversation.state.history)};})()`,{vault});
const report=JSON.parse(await (await import('node:fs/promises')).readFile(out,'utf8'));report.noLearningWrites=initial.records===unchanged.records;report.noHistoryWrites=initial.history===unchanged.history;await writeFile(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({noLearningWrites:report.noLearningWrites,noHistoryWrites:report.noHistoryWrites,scope:'synthetic model/host API evaluation; manual rubric review separate'}));
