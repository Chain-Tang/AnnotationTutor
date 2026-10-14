import {evaluateObsidian} from './obsidian-eval.mjs';import {writeFile} from 'node:fs/promises';
const result=await evaluateObsidian(`(async()=>{const p=app.plugins.plugins['annotation-tutor-lite'];
 const scope={context:'合成材料：x²在2处极限为4。',target:{id:'natural-failure-qa',source:'Tutor Board QA/Expert Failure QA.md',revision:'1',surface:'document'},current:async()=>true};
 const task=await p.delegateTutorToCodex('核对该数学结论，用两句中文回答。不要调用工具。',['codex'],{...scope,key:'cancel-'+crypto.randomUUID()});
 const end=Date.now()+30000;while(Date.now()<end){const t=p.tutorConversation.tasks.get(task.id,'obsidian'),child=t.children.map(id=>p.tutorConversation.tasks.get(id,'obsidian'));if(child.some(c=>c.route)||t.state==='completed')break;await new Promise(r=>setTimeout(r,100));}
 p.tutorConversation.tasks.cancel(task.id,'obsidian');await new Promise(r=>setTimeout(r,300));
 const cancelled=p.tutorConversation.tasks.get(task.id,'obsidian');
 const prior=p.settings.tutorCodexCommand;let failed;
 try {p.settings.tutorCodexCommand='/nonexistent/tutor-qa-codex';const next=await p.delegateTutorToCodex('核对数学结论。如果专家失败，请明确未获独立核验，不要声称专家已通过。',['codex'],{...scope,key:'partial-'+crypto.randomUUID()});
 const deadline=Date.now()+180000;while(Date.now()<deadline){failed=p.tutorConversation.tasks.get(next.id,'obsidian');if(['completed','failed','cancelled'].includes(failed.state))break;await new Promise(r=>setTimeout(r,200));}
 }finally{p.settings.tutorCodexCommand=prior;}
 await p.tutorResults.flush();return {cancelled,children:cancelled.children.map(id=>p.tutorConversation.tasks.get(id,'obsidian')),partial:failed,partialChildren:failed.children.map(id=>p.tutorConversation.tasks.get(id,'obsidian')),scope:'Real Codex connection cancelled; deliberately missing CLI for partial failure, actual Tutor model summarizes. Not a remote/provider outage test.'};})()`,{vault:'Tutor-Acceptance',timeout:240000});
const passed=result.cancelled.state==='cancelled'&&result.children.every(c=>c.state==='cancelled')&&result.partial.state==='completed'&&result.partialChildren.some(c=>c.state==='failed');
await writeFile('docs/qa/natural-learning-20260927/batch4/expert-failure.json',JSON.stringify({passed,...result},null,2));console.log(JSON.stringify({passed,cancelled:result.cancelled.state,partial:result.partial.state}));if(!passed)process.exitCode=1;
