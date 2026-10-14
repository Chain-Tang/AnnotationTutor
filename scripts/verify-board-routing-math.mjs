// Explicit, opt-in live QA using synthetic lesson data and the effective plugin route.
// Prints/saves metadata and validated editable objects; never credentials or raw replies.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const arg=k=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:undefined;
if(!arg('--config'))throw new Error('Supply --config to authorize a live QA request');
const out=path.resolve('docs/qa/board-routing-math-2026-09-18');await mkdir(out,{recursive:true});await mkdir('dist/qa',{recursive:true});
const bundle=path.resolve('dist/qa/routing-math.mjs');
await build({stdin:{contents:'export * from "./src/board-agent.ts";export * from "./src/board-connection.ts";export {migrateSettings} from "./src/settings-config.ts";export {resolveTutorAction} from "./src/tutor-intent.ts";export {drawingDiagnostics} from "./src/ai-execution.ts";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:bundle});
const lib=await import(pathToFileURL(bundle).href),settings=lib.migrateSettings(JSON.parse(await readFile(arg('--config'),'utf8')));
const effective=lib.resolveBoardConnection(settings);
const route=arg('--opencode')==='true'?lib.resolveBoardConnection({...settings,boardConnectionMode:'custom',boardEngine:'opencode'}):effective;
const instruction=arg('--instruction')||'请你用几何的方法，绘制一个图来直观表示极限';
const action=await lib.resolveTutorAction(instruction,[],{engine:settings.chatEngine,model:settings.chatEngine==='api'?settings.apiModel:settings.agentModel,baseUrl:settings.apiBaseUrl,apiKey:settings.apiKey,command:settings.agentCommand,signal:new AbortController().signal});
if(action.intent!=='draw'||action.drawing.mode!=='math')throw new Error('Semantic math routing failed: '+JSON.stringify(action));
const {requestCommon}=JSON.parse(await readFile('docs/qa/board-v2/input.json','utf8'));
const request={...requestCommon,boardId:'BOARD-math-qa',sessionId:'SESSION-math-qa',requestId:'REQUEST-math-qa-'+Date.now(),sourceFile:'Synthetic math lesson.md',requiresDrawing:true,math:true,instruction,context:'当 x 接近 2，f(x)=x² 接近 4。下方为空白绘图区。',snapshot:{...requestCommon.snapshot,width:800,height:600,pngBase64:(await readFile('docs/qa/limit-drawing-2026-09-18/input.png')).toString('base64')}};
const agent=lib.createBoardAgent({...route,baseUrl:settings.apiBaseUrl,apiKey:settings.apiKey,command:settings.agentCommand,cwd:process.cwd(),timeoutMs:90000});
const events=[],started=Date.now();
try{
  const result=await lib.requestBoardWithRepair(agent,request,e=>events.push({type:e.type,...(e.type==='preview'?{objects:e.operations.length}:e.type==='reply'?{chars:e.text.length}:{})}));
  const report={route,effective,action,events,diagnostics:lib.drawingDiagnostics(),result,elapsedMs:Date.now()-started};
  const name=arg('--output')||(route.engine==='api'?'direct-live':'opencode-live');
  await writeFile(path.join(out,name+'.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,result:result.ok?{ok:true,objects:result.operations.length,description:result.description}:result}));
  if(!result.ok)process.exitCode=1;
}finally{agent.dispose();}
