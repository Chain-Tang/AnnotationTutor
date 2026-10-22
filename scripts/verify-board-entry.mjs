// Opt-in live semantic routing + native drawing check; never logs credentials.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const configPath=process.argv[process.argv.indexOf('--config')+1];
if(!process.argv.includes('--config'))throw new Error('Supply --config; this makes live model requests.');
const config=JSON.parse(await readFile(configPath,'utf8'));
const out=path.resolve('docs/qa/board-entry-watercolor-2026-09-16');await mkdir(out,{recursive:true});
await mkdir('dist/qa',{recursive:true});
const compiled=path.resolve('dist/qa/entry-live.mjs');
await build({stdin:{contents:'export * from "./src/tutor-intent.ts";export * from "./src/board-agent.ts";export * from "./src/board-renderer.ts";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:compiled});
const {resolveTutorIntent,createBoardAgent,renderBoardSvg,requestBoardWithRepair}=await import(pathToFileURL(compiled).href);
const fixture=JSON.parse(await readFile('docs/qa/board-v2/input.json','utf8'));
const pngBase64=(await readFile('docs/qa/board-v2/synthetic-vision.png')).toString('base64');
const cases=[['请你绘制一个包豪斯风格的法式花园','draw'],['不要画图，解释包豪斯是什么','chat'],['把它用一幅小图表现出来','draw']];
const engines=process.argv.includes('--engine')?[process.argv[process.argv.indexOf('--engine')+1]]:['api','opencode'];
for(const engine of engines){
 const model=engine==='api'?config.apiModel:config.agentModel;
 const opts={engine,model,baseUrl:config.apiBaseUrl,apiKey:config.apiKey,command:config.agentCommand,signal:new AbortController().signal};
 const report=process.argv.includes('--drawing-only')?JSON.parse(await readFile(path.join(out,engine+'.json'),'utf8')):{engine,model,semantic:[],drawing:null};
 for(const [text,expected] of (process.argv.includes('--drawing-only')?[]:cases)){
  const started=performance.now();
  try{const intent=await resolveTutorIntent(text,[],opts);report.semantic.push({text,expected,intent,passed:intent===expected,ms:Math.round(performance.now()-started)});}
  catch(error){report.semantic.push({text,passed:false,error:String(error)});}
  await writeFile(path.join(out,engine+'.json'),JSON.stringify(report,null,2));
 }
 if(report.semantic[0]?.passed){
  const agent=createBoardAgent({...opts,cwd:path.resolve('dist/qa'),timeoutMs:config.agentTimeoutSeconds?config.agentTimeoutSeconds*1000:240000});
  try{
   const request={...fixture.requestCommon,boardId:'BOARD-entry-qa',sessionId:'session-entry',requestId:'request-entry-'+engine,baseRevision:1,
    instruction:cases[0][0],sourceRevision:'synthetic-only',snapshot:{...fixture.requestCommon.snapshot,pngBase64}};
   report.attempts=[];
   const measured={...agent,request:async(req,emit)=>{const start=performance.now();let events=0;const result=await agent.request(req,event=>{events++;emit?.(event);});report.attempts.push({correction:!!req.protocolCorrection,ms:Math.round(performance.now()-start),events,ok:result.ok,error:result.ok?undefined:result.error});console.log(JSON.stringify({engine,attempt:report.attempts.at(-1)}));return result;}};
   const result=await requestBoardWithRepair(measured,request);report.drawing=result;
   if(result.ok){const objects=result.operations.filter(o=>o.type==='add').map(o=>o.object);await writeFile(path.join(out,engine+'.svg'),renderBoardSvg(objects,{ink:{},characters:[],width:640,height:420}));}
  }finally{agent.dispose();}
 }
 await writeFile(path.join(out,engine+'.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({engine,semantic:report.semantic,drawingOk:report.drawing?.ok,operations:report.drawing?.operations?.length,error:report.drawing?.error}));
}
