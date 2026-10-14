// Opt-in semantic workflow check against the configured engines. No credentials in output.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const flag=process.argv.indexOf('--config');
if(flag<0)throw new Error('Supply --config PATH to make live requests.');
const settings=JSON.parse(await readFile(process.argv[flag+1],'utf8'));
const out=path.resolve('docs/qa/reference-routing-2026-09-16');await mkdir(out,{recursive:true});await mkdir('dist/qa',{recursive:true});
const bundle=path.resolve('dist/qa/reference-routing.mjs');
await build({stdin:{contents:'export * from "./src/tutor-intent.ts";',resolveDir:process.cwd()},platform:'node',format:'esm',bundle:true,outfile:bundle});
const {resolveTutorAction}=await import(pathToFileURL(bundle).href);
const {history}=JSON.parse(await readFile(path.join(out,'user-context.json'),'utf8'));
const prior=history.slice(0,-1),latest=history.at(-1).content;
const cases=[
 {text:latest,history:prior,expected:'reference'},
 {text:'你可以先生成示意图，再根据示意图精细调整，生成一个更美观的包豪斯抽象风格花园',history:prior.slice(0,2),expected:'reference'},
 {text:'不要调用生图，直接把现有花坛填成红黄蓝色',history:prior,expected:'native'},
 {text:'画一个简单的力学示意图，用箭头标注力',history:[],expected:'native'},
 {text:'解释一下为什么生成示意图会失败，不要作画',history:prior,expected:'chat'},
];
const arg=key=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:undefined;
const engines=arg('--engine')?[arg('--engine')]:['api','opencode'];
if(engines.some(e=>!['api','opencode'].includes(e)))throw new Error('Invalid engine');
const selected=arg('--case')?cases.filter((_,i)=>i+1===Number(arg('--case'))):cases;
if(!selected.length)throw new Error('Invalid case');
const report=[];
for(const engine of engines){
 for(const example of selected){
  const start=performance.now();
  try{
   const result=await resolveTutorAction(example.text,example.history,{engine,model:engine==='api'?settings.apiModel:settings.agentModel,
    baseUrl:settings.apiBaseUrl,apiKey:settings.apiKey,command:settings.agentCommand,signal:new AbortController().signal});
   report.push({engine,text:example.text,expected:example.expected,result,passed:(result.intent==='chat'?'chat':result.drawing.mode)===example.expected,ms:Math.round(performance.now()-start)});
  }catch(error){report.push({engine,text:example.text,error:String(error),passed:false});}
  await writeFile(path.join(out,arg('--output')||'semantic-live.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.at(-1)));
 }
}
