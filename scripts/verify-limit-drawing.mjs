// Opt-in reproduction using synthetic lesson pixels and the current connection.
// Never records credentials, request headers, or provider reasoning.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const arg = key => process.argv.includes(key) ? process.argv[process.argv.indexOf(key)+1] : undefined;
if (!arg('--config')) throw new Error('Supply --config PATH to make a live request.');
const config=JSON.parse(await readFile(arg('--config'),'utf8'));
const out=path.resolve('docs/qa/limit-drawing-2026-09-18');await mkdir(out,{recursive:true});await mkdir('dist/qa',{recursive:true});
const bundle=path.resolve('dist/qa/limit-drawing.mjs');
await build({stdin:{contents:'export * from "./src/board-agent.ts"; export {nodeHttpStream,SseDecoder} from "./src/api-stream.ts"; export {resolveTutorAction} from "./src/tutor-intent.ts";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:bundle});
const {createBoardAgent,requestBoardWithRepair,nodeHttpStream,SseDecoder,resolveTutorAction}=await import(pathToFileURL(bundle).href);
const text='请你用几何的方法，绘制一个图来直观表示极限';
const action=await resolveTutorAction(text,[],{engine:'api',model:config.apiModel,baseUrl:config.apiBaseUrl,apiKey:config.apiKey,signal:new AbortController().signal});
const {requestCommon}=JSON.parse(await readFile('docs/qa/board-v2/input.json','utf8'));
const request={...requestCommon,boardId:'BOARD-limit-qa',sessionId:'SESSION-limit-qa',requestId:'REQUEST-limit-qa',
  sourceFile:'Synthetic limit lesson.md',requiresDrawing:true,instruction:text,
  context:'例子：当 x 接近 2，f(x)=x² 接近 4。下方为绘图区。',
  snapshot:{...requestCommon.snapshot,width:800,height:600,pngBase64:(await readFile(path.join(out,'input.png'))).toString('base64')}};
const attempts=[];let attempt;const events=[];const started=performance.now();
const agent=createBoardAgent({engine:'api',model:config.apiModel,baseUrl:config.apiBaseUrl,apiKey:config.apiKey,timeoutMs:90000,
  httpStream:async input=>{
    attempt={status:null,contentType:'',finishReason:null,done:false,content:'',contentChars:0,ms:null};attempts.push(attempt);
    const decoder=new SseDecoder(data=>{if(data==='[DONE]'){attempt.done=true;return;}try{const c=JSON.parse(data),v=c.choices?.find(v=>v.index===0||v.index===undefined);if(typeof v?.delta?.content==='string')attempt.content+=v.delta.content;if(v?.finish_reason)attempt.finishReason=v.finish_reason;if(c.usage)attempt.usage={prompt_tokens:c.usage.prompt_tokens,completion_tokens:c.usage.completion_tokens};}catch{/* Production decoder remains authoritative. */}});
    try {await nodeHttpStream({...input,onResponse:r=>{attempt.status=r.status;attempt.contentType=r.contentType;input.onResponse(r);},onChunk:chunk=>{if(/event-stream/.test(attempt.contentType))decoder.push(chunk);try{input.onChunk(chunk);}catch(error){attempt.firstValidationError??=String(error);if(arg('--drain')!=='true')throw error;}}});}
    finally {try{decoder.finish();}catch{}attempt.contentChars=attempt.content.length;attempt.ms=Math.round(performance.now()-started);}
  }});
try{
  const result=arg('--repair')==='true'?await requestBoardWithRepair(agent,request,e=>events.push({type:e.type,...(e.type==='preview'?{objects:e.operations.length}:{chars:e.text.length})})):await agent.request(request,e=>events.push({type:e.type,...(e.type==='preview'?{objects:e.operations.length}:{chars:e.text.length})}));
  const report={action,model:config.apiModel,attempts,events,result,totalMs:Math.round(performance.now()-started)};
  await writeFile(path.join(out,arg('--output')||'baseline.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,attempts:attempts.map(({content,...meta})=>({...meta,tail:content.slice(-450)})),result:result.ok?{ok:true,objects:result.operations.length,description:result.description}:result}));
  if(!result.ok)process.exitCode=1;
}finally{agent.dispose();}
