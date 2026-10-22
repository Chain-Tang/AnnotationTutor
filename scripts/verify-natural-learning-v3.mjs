/** Real model / ChatView.send host-method verification, restricted to Tutor-Acceptance.
 * This does not replace CUA/manual typing and clicking acceptance.
 * Run only after installing a sealed S2 candidate. CLI evaluations are serial;
 * each model request has one retained handle, polled without resubmission.
 *
 * node scripts/verify-natural-learning-v3.mjs --dry-run
 * node scripts/verify-natural-learning-v3.mjs --expected-build <releaseBuildId> --screenshots
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {build} from 'esbuild';
import {evaluateObsidian} from './obsidian-eval.mjs';

const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),options={vault:'Tutor-Acceptance',out:undefined,expectedBuild:undefined,screenshots:false,dryRun:false,timeout:300000};
for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--screenshots')options.screenshots=true;
  else if(arg==='--dry-run')options.dryRun=true;
  else if(['--vault','--out','--expected-build','--timeout-ms'].includes(arg)){
    const value=args[++i];if(!value||value.startsWith('--'))throw new Error('missing-argument');
    if(arg==='--vault')options.vault=value;
    else if(arg==='--out')options.out=resolve(value);
    else if(arg==='--expected-build')options.expectedBuild=value;
    else options.timeout=Number(value);
  }else throw new Error('unknown-argument');
}
// Never accept another Vault, including a differently cased Documents alias.
if(options.vault!=='Tutor-Acceptance')throw new Error('acceptance-vault-required');
if(!Number.isSafeInteger(options.timeout)||options.timeout<30000||options.timeout>600000)throw new Error('invalid-turn-timeout');
const runId=randomUUID(),stamp=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
const output=options.out??join(root,'docs/qa/commercial-optimization-20261009/s2-natural-learning',`live-v3-${stamp}.json`);
const source=`Tutor Board QA/Natural Learning V3 ${stamp}.md`,globalKey='__tutorNaturalLearningV3QA';
const sourceText='# 自然对话学习验收\n\n此页为合成验收材料，不包含个人信息。\n\n学习目标：区分函数值与极限。当 x≠2 时 f(x)=x²，而 f(2)=7。\n\n极限描述附近的趋向；某个孤立点的取值可以不同。';
// Reconstruct the answer only in Node from the frozen host curriculum. No
// answer, hint, command protocol or privileged authority is injected into UI.
const rendererBuild=await build({entryPoints:[join(root,'src/learning-question-bank-v2-2.ts')],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const rendererText=rendererBuild.outputFiles[0].text,rendererHash=createHash('sha256').update(rendererText).digest('hex');
const {instantiateQuestion}=await import('data:text/javascript;base64,'+Buffer.from(rendererText).toString('base64'));
if(instantiateQuestion('value-limit','practice',0).answer!=='9')throw new Error('curriculum-renderer-self-check-failed');
if(options.dryRun){
  console.log(JSON.stringify({dryRun:true,vault:options.vault,source,output,rendererHash,modelCalls:0,obsidianCalls:0}));
  process.exit(0);
}
await mkdir(dirname(output),{recursive:true});
const report={format:'tutor-natural-learning-v3-live-acceptance-v1',runId,startedAt:new Date().toISOString(),vault:options.vault,source,rendererHash,
  scope:'Four synthetic turns through the installed ChatView.send host method and configured Direct API. This is not full GUI acceptance. No claim about other entries, models, persistence after restart, or commercial readiness.',setup:null,turns:[],checks:[],screenshots:[],pass:false};
const evalHost=code=>evaluateObsidian(code,{vault:options.vault,timeout:15000});
const save=async()=>writeFile(output,JSON.stringify(report,null,2)+'\n');
const check=(name,pass)=>{report.checks.push({name,pass:!!pass});if(!pass)throw new Error('acceptance-check-failed:'+name);};
// Only categorical failures reach stdout/report. Provider messages may contain
// request data, so preserve their length and bounded code, never raw strings.
const failureCode=error=>String(error?.message??error).match(/(?:acceptance-check-failed:[a-z-]+|[a-z][a-z0-9-]{3,80})/)?.[0]??'verification-failed';
const owned=`const qa=window[${JSON.stringify(globalKey)}];if(!qa||qa.id!==${JSON.stringify(runId)})throw Error('qa-handle-unavailable');const p=app.plugins.plugins['annotation-tutor-lite'];if(app.vault.getName()!=='Tutor-Acceptance'||p!==qa.plugin)throw Error('qa-host-changed');`;
const snapshotCode=`(async()=>{${owned}
 if(p.tutorConversation.conversationId!==qa.conversationId)throw Error('qa-conversation-changed');
 const state=p.tutorConversation.state,read=await p.learningV3.readEffectiveResult();
 if(JSON.stringify(state.history.filter(m=>m.role==='user').map(m=>m.text))!==JSON.stringify(qa.inputs))throw Error('qa-unexpected-user-message');
 const records=[];for(const e of read.records.filter(e=>e.source.path===qa.source)){
   const raw=await p.learningV3.io.read(p.learningV3.root+'/'+e.id+'.json'),protection=read.protectionByEpisode.get(e.id);
   records.push({id:e.id,revision:e.revision,source:e.source,concept:e.concept,status:e.status,currentQuestionId:e.currentQuestionId,
     questions:e.questions,evidence:e.evidence,help:e.help,reviewTasks:e.reviewTasks,
     durable:raw!==null&&JSON.stringify(JSON.parse(raw))===JSON.stringify(e),
     protection:{status:protection?.status,revision:protection?.revision}});
 }
 const clean=text=>String(text??'').replace(/sk-[A-Za-z0-9_.-]{8,}/g,'[redacted]').replace(/Bearer\\s+\\S+/gi,'Bearer [redacted]').slice(0,8000);
 let task;try{task=state.taskId?p.tutorConversation.tasks.get(state.taskId,'obsidian'):undefined;}catch{}
 return {busy:state.busy,status:state.taskStatus,taskId:state.taskId,error:!!state.error,errorLength:state.error?.length??0,
   failure:state.failure?{category:state.failure.category,statusCode:state.failure.status}:undefined,
   route:{engine:p.settings.chatEngine,model:clean(p.settings.chatEngine==='api'?p.settings.apiModel:p.settings.agentModel)},
   metrics:task?.metrics,firstFeedbackMs:qa.run?.firstFeedbackMs,replyEvents:qa.run?.replyEvents??0,
   history:state.history.map(m=>({role:m.role,text:clean(m.text),status:m.status})),
   records,sourceCompleteness:read.integrityIssues.some(issue=>issue.scope?.source===qa.source&&!issue.recovered)?'partial':'complete',
   learningCardEnabled:p.settings.learningFlowEnabled};})()`;

async function screenshot(step){
  if(!options.screenshots)return;
  const path=output.replace(/\.json$/i,'')+`-${step}.png`;
  const result=await evalHost(`(async()=>{${owned}
    if(p.tutorConversation.conversationId!==qa.conversationId)throw Error('qa-conversation-changed');
    const el=qa.view.contentEl.querySelector('.atl-chat-messages'),win=el?.ownerDocument.defaultView;if(!el||!win||!el.isConnected)throw Error('qa-chat-not-visible');
    if([...win.document.querySelectorAll('.atl-support-private')].some(e=>{const r=e.getBoundingClientRect();return r.width&&r.height;}))throw Error('qa-private-surface-visible');
    await new Promise(r=>win.requestAnimationFrame(()=>win.requestAnimationFrame(r)));
    let remote=win.electron?.remote;const loader=win.require;
    if(!remote?.getCurrentWebContents&&loader){try{remote=loader('electron').remote;}catch{}if(!remote?.getCurrentWebContents)try{remote=loader('@electron/remote');}catch{}}
    const wc=remote?.getCurrentWebContents?.();if(!wc?.capturePage)throw Error('qa-capture-unavailable');
    const rect=el.getBoundingClientRect(),zoom=wc.getZoomFactor(),x=Math.ceil(Math.max(0,rect.left)*zoom),y=Math.ceil(Math.max(0,rect.top)*zoom),
      width=Math.floor(Math.min(win.innerWidth,rect.right)*zoom)-x,height=Math.floor(Math.min(win.innerHeight,rect.bottom)*zoom)-y;
    if(width<10||height<10)throw Error('qa-chat-not-visible');
    const image=await wc.capturePage({x,y,width,height});if(image.isEmpty?.())throw Error('qa-capture-empty');
    require('fs').writeFileSync(${JSON.stringify(path)},image.toPNG());return {path:${JSON.stringify(path)},cssRect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},zoom,devicePixelRatio:win.devicePixelRatio,kind:'actual-electron-compositor-chat-crop'};
  })()`);
  report.screenshots.push({step,...result});
}

async function turn(step,input){
  const started=Date.now(),handle=randomUUID();
  await evalHost(`(()=>{${owned}
    if(p.tutorConversation.state.busy||qa.run&&!qa.run.done)throw Error('qa-turn-busy');
    if(p.tutorConversation.conversationId!==qa.conversationId||p.settings.chatEngine!=='api'||p.settings.apiModel!==qa.model)throw Error('qa-route-or-conversation-changed');
    if(!qa.view.contentEl.isConnected||qa.view.selectionContext?.notePath!==qa.source)throw Error('qa-ui-target-changed');
    const textarea=qa.view.contentEl.querySelector('textarea.atl-chat-input');if(!textarea||qa.view.busy)throw Error('qa-input-unavailable');
    const run={id:${JSON.stringify(handle)},startedAt:Date.now(),done:false,error:false,firstFeedbackMs:null,replyEvents:0};qa.run=run;
    const priorLength=p.tutorConversation.state.history.length;qa.inputs.push(${JSON.stringify(input)});
    let last='';run.unsubscribe=p.tutorConversation.subscribe(state=>{const reply=state.history.at(-1);if(state.history.length>priorLength&&reply?.role==='assistant'&&reply.text&&reply.text!==last){last=reply.text;run.replyEvents++;run.firstFeedbackMs??=Date.now()-run.startedAt;}});
    textarea.value=${JSON.stringify(input)};textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('input',{bubbles:true}));
    // The actual UI handler creates localLearnerAuthority and resolves context.
    // Never call tutorConversation.submit or a teaching command in this verifier.
    run.promise=Promise.resolve(qa.view.send()).then(()=>{run.done=true;},()=>{run.error=true;run.done=true;}).finally(()=>run.unsubscribe());
    return {handle:run.id};})()`);
  let lastLog=0,pollFailures=0;
  while(true){
    let progress;
    try{progress=await evalHost(`(()=>{${owned}if(qa.run?.id!==${JSON.stringify(handle)})throw Error('qa-request-handle-changed');if(p.tutorConversation.conversationId!==qa.conversationId)throw Error('qa-conversation-changed');return {done:qa.run.done,error:qa.run.error,busy:p.tutorConversation.state.busy,status:p.tutorConversation.state.taskStatus,replyEvents:qa.run.replyEvents};})()`);pollFailures=0;}
    catch(error){if(++pollFailures>=3||Date.now()-started>options.timeout)throw error;await new Promise(r=>setTimeout(r,1000));continue;}
    if(progress.done){check(step+'-send-settled',!progress.error&&!progress.busy);break;}
    if(Date.now()-started>options.timeout)throw new Error('qa-turn-timeout');
    if(Date.now()-lastLog>=10000){lastLog=Date.now();console.log(JSON.stringify({step,elapsedMs:Date.now()-started,status:progress.status??'preparing',replyEvents:progress.replyEvents}));}
    await new Promise(r=>setTimeout(r,1000));
  }
  const state=await evalHost(snapshotCode);
  report.turns.push({step,input,elapsedMs:Date.now()-started,...state});await save();
  check(step+'-completed',!state.error&&state.status==='complete');
  check(step+'-route-unchanged',state.route.engine==='api'&&state.route.model===report.setup.model);
  check(step+'-card-disabled',state.learningCardEnabled===false);
  check(step+'-source-readable',state.sourceCompleteness==='complete');
  check(step+'-durable',state.records.every(record=>record.durable&&record.protection.status==='valid'));
  check(step+'-control-hidden',state.history.every(message=>!message.text.includes('"control"')&&!message.text.includes('<tutor-action>')));
  await screenshot(step);await save();return state;
}

try{
  report.setup=await evalHost(`(async()=>{
    if(app.vault.getName()!=='Tutor-Acceptance')throw Error('acceptance-vault-required');
    const p=app.plugins.plugins['annotation-tutor-lite'];if(!p?.learningV3||!p.learningDialogue||!p.learningCard)throw Error('s2-candidate-not-installed');
    if(p.tutorConversation.state.busy||p.learningCard.snapshot.busy||p.support?.busy||p.runningAgents?.size)throw Error('qa-host-busy');
    if(p.settings.chatEngine!=='api'||!p.settings.apiKey?.trim())throw Error('configured-direct-api-required');
    const prior=window[${JSON.stringify(globalKey)}];if(prior?.run&&!prior.run.done)throw Error('qa-prior-request-still-running');
    const release=JSON.parse(await app.vault.adapter.read((p.manifest.dir??app.vault.configDir+'/plugins/annotation-tutor-lite')+'/release-files.json'));
    if(${JSON.stringify(options.expectedBuild??null)}&&release.buildId!==${JSON.stringify(options.expectedBuild??null)})throw Error('installed-build-mismatch');
    const source=${JSON.stringify(source)},text=${JSON.stringify(sourceText)};
    if(await app.vault.adapter.exists(source))throw Error('qa-source-already-exists');
    if(!await app.vault.adapter.exists('Tutor Board QA'))await app.vault.createFolder('Tutor Board QA');
    const file=await app.vault.create(source,text),leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);app.workspace.setActiveLeaf(leaf,{focus:true});
    const ctx=await p.chatContext();if(ctx?.notePath!==source||ctx.content!==text)throw Error('qa-source-context-mismatch');
    const beforeLearningCard=p.settings.learningFlowEnabled,model=p.settings.apiModel;if(/sk-[A-Za-z0-9_.-]{8,}/.test(model))throw Error('qa-invalid-model-label');
    const qa={id:${JSON.stringify(runId)},plugin:p,source,view:null,model,beforeLearningCard,conversationId:null,inputs:[]};window[${JSON.stringify(globalKey)}]=qa;
    p.settings.learningFlowEnabled=false;
    const view=await p.openChat();if(!view||typeof view.send!=='function')throw Error('qa-chat-view-unavailable');view.newChat();
    view.seedSelection({...ctx,notePath:source,noteTitle:file.basename,content:text,selection:'区分函数值与极限',observation:{...ctx.observation,scope:'selection'}});
    qa.view=view;qa.conversationId=p.tutorConversation.conversationId;
    return {version:p.manifest.version,releaseBuildId:release.buildId,engine:p.settings.chatEngine,model,routeEvidence:'configured Direct API branch captured before and after each real UI turn',source,learningCardEnabled:false,originalLearningCardEnabled:beforeLearningCard,
      platform:{obsidian:app.version??null,electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,platform:process.platform,arch:process.arch}};
  })()`);
  check('empty-synthetic-source',(await evalHost(snapshotCode)).records.length===0);await save();
  const invitation=await turn('invite','我总把函数值和极限搞混。请先简单解释一下，我也想试一道小题。');
  check('no-pre-consent-record',invitation.records.length===0);
  check('save-disclosure-shown',invitation.history.at(-1)?.text.includes('我会保存这次练习进度'));
  const accepted=await turn('accept','好的，试一题。');check('exactly-one-consented-episode',accepted.records.length===1);
  const episode=accepted.records[0],ref=episode.questions.find(question=>question.id===episode.currentQuestionId);
  check('expected-question-pack',ref?.packVersion==='limits-v3-1');
  const question=instantiateQuestion(ref.concept,ref.pool,ref.seed);
  check('question-renderer-matches',question.templateId===ref.templateId&&accepted.history.at(-1)?.text.includes(question.prompt));
  check('accept-is-not-a-grade',episode.evidence.length===0&&episode.help.length===0);
  const hinted=await turn('hint','提示一下，先不要告诉我完整答案。'),hintedEpisode=hinted.records.find(record=>record.id===episode.id);
  check('hint-target-stable',hintedEpisode?.currentQuestionId===ref.id);
  const hint=hintedEpisode.help.find(item=>item.questionId===ref.id&&item.kind==='hint'&&item.state==='presented');
  check('hint-was-durable-and-presented',!!hint);check('hint-is-not-a-grade',hintedEpisode.evidence.length===0);
  const answered=await turn('answer',question.answer),final=answered.records.find(record=>record.id===episode.id);
  const answers=final?.evidence.filter(item=>item.type==='answer'&&item.questionId===ref.id)??[];
  check('single-deterministic-correct-answer',answers.length===1&&answers[0].evaluator==='deterministic'&&answers[0].outcome==='correct');
  check('helped-answer-not-independent',answers[0].independence==='helped'&&answers[0].helpIds.includes(hint.id));
  check('hint-preserved-after-answer',final.help.some(item=>item.id===hint.id&&item.state==='presented'));
  report.pass=true;
}catch(error){report.failure={code:failureCode(error),at:new Date().toISOString()};process.exitCode=1;}
finally{
  try{
    report.cleanup=await evalHost(`(async()=>{
      const qa=window[${JSON.stringify(globalKey)}],p=app.plugins.plugins['annotation-tutor-lite'];if(qa?.id!==${JSON.stringify(runId)}||qa.plugin!==p)return {owned:false};
      const sameConversation=p.tutorConversation.conversationId===qa.conversationId;
      if(sameConversation&&qa.run&&!qa.run.done)p.tutorConversation.cancel();
      p.settings.learningFlowEnabled=qa.beforeLearningCard;p.refreshChatViews();qa.run?.unsubscribe?.();
      return {owned:true,settingsRestored:p.settings.learningFlowEnabled===qa.beforeLearningCard,requestSettled:qa.run?.done??true,cancelRequested:!qa.run?.done&&sameConversation,syntheticRecordsPreserved:true};
    })()`);
  }catch{report.cleanup={verified:false};report.pass=false;process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({pass:report.pass,turns:report.turns.length,checks:report.checks.length,failed:report.checks.filter(item=>!item.pass).map(item=>item.name),failure:report.failure?.code,report:output}));
}
