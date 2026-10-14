// Explicit --config opts into two live semantic model requests; no image generation.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const arg=key=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:undefined;
if(!arg('--config'))throw Error('Provide --config PATH to run live checks');
const s=JSON.parse(await readFile(arg('--config'),'utf8')),out=path.resolve('docs/qa/reference-materials-2026-09-18');
await mkdir(out,{recursive:true});
const bundle=path.resolve('dist/qa/material-intent.mjs');
await build({stdin:{contents:'export * from "./src/tutor-intent.ts";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:bundle});
const {resolveTutorAction}=await import(pathToFileURL(bundle).href);
const reports=await Promise.all((arg('--engine')?[arg('--engine')]:['api','opencode']).map(async engine=>{
 const text=engine==='api'?'先生成一张花园参考图，再用铅笔画轮廓，用油画笔铺色。':'先生成一张花园参考图，再用钢笔勾轮廓，用蜡笔填色。';
 const expected=engine==='api'?{outlineBrush:'pencil',colorMode:'brush',colorBrush:'oil'}:{outlineBrush:'fountain',colorMode:'brush',colorBrush:'crayon'};
 const start=performance.now();
 try{
  const result=await resolveTutorAction(text,[],{engine,model:engine==='api'?s.apiModel:s.agentModel,baseUrl:s.apiBaseUrl,apiKey:s.apiKey,command:s.agentCommand,signal:new AbortController().signal});
  const passed=result.intent==='draw'&&result.drawing.mode==='reference'&&Object.entries(expected).every(([k,v])=>result.drawing.style?.[k]===v);
  return {engine,text,expected,result,passed,ms:Math.round(performance.now()-start)};
 }catch(error){return{engine,text,expected,passed:false,error:String(error)}}
}));
await writeFile(path.join(out,arg('--output')||'semantic-styles-live.json'),JSON.stringify(reports,null,2)+'\n');console.log(JSON.stringify(reports));
if(reports.some(r=>!r.passed))process.exitCode=1;
