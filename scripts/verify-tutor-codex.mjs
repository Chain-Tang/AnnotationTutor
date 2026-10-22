import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
await build({entryPoints:['src/tutor-codex.ts'],outfile:'dist/qa-codex-adapter.cjs',platform:'node',format:'cjs',target:'node22',bundle:true});
const {CodexAppServerAdapter}=createRequire(import.meta.url)('../dist/qa-codex-adapter.cjs');
const adapter=new CodexAppServerAdapter({command:process.env.TUTOR_CODEX_COMMAND??'/Applications/ChatGPT.app/Contents/Resources/codex'}),start=Date.now();let chars=0;
try{
 const result=await adapter.run({task:{id:'qa'},prompt:'请独立核对这个解释，用两句中文指出结论是否正确以及理由。无需任何工具。',context:'学生说：函数 f(x)=x² 在 x=2 处连续，因此 x 趋近 2 时 f(x) 趋近 4。',signal:AbortSignal.timeout(180000),emit:event=>{if(event.type==='text')chars+=event.data.text.length;}});
 const report={ok:true,elapsedMs:Date.now()-start,streamedChars:chars,artifacts:result};await mkdir('docs/qa/upgrade-m2',{recursive:true});await writeFile('docs/qa/upgrade-m2/codex-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,elapsedMs:report.elapsedMs,streamedChars:chars,artifacts:result.length}));
}catch(error){console.log(JSON.stringify({ok:false,elapsedMs:Date.now()-start,error:error.message}));process.exitCode=1;}finally{adapter.dispose();}
