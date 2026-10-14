// Opt-in live provider check. Never part of pnpm test; uses the configured image
// endpoint, then exercises the production reconstruction/history/store modules.
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import assert from "node:assert/strict";

const args = new Map();
for(let i=2;i<process.argv.length;i+=2) args.set(process.argv[i],process.argv[i+1]);
if(!args.get("--settings") || !args.get("--sharp")) throw new Error("Required: --settings PATH --sharp MODULE --out DIRECTORY");
const out=path.resolve(args.get("--out") || "docs/qa/image-refusal-recovery-2026-09-16");
await fs.mkdir(out,{recursive:true});
const settings=JSON.parse(await fs.readFile(args.get("--settings"),"utf8"));
const sharp=(await import(pathToFileURL(args.get("--sharp")).href)).default;
const bundle=path.join(out,".runtime.mjs");
await build({stdin:{contents:[
  'export * from "./src/board-image-provider.ts";',
  'export * from "./src/board-reference-paint.ts";',
  'export * from "./src/board-model.ts";',
  'export * from "./src/board-store.ts";',
  'export { renderBoardSvg } from "./src/board-renderer.ts";',
].join("\n"),resolveDir:process.cwd()},bundle:true,platform:"node",format:"esm",outfile:bundle});
const runtime=await import(pathToFileURL(bundle).href);
const config={baseUrl:settings.boardImageBaseUrl,model:settings.boardImageModel,
  apiKey:settings.boardImageUseSharedApiKey?settings.apiKey:settings.boardImageApiKey};
const provider=settings.boardImageProvider==="qwen-compatible"?runtime.createQwenImageProvider(config):runtime.createOpenAIImageProvider(config);
const request={width:1024,height:1024,count:1,quality:"standard",transparent:false,thinking:false,watermark:false};
const report={scope:"Live configured image provider plus production headless reconstruction/playback/history/storage. Not an Obsidian GUI acceptance test.",model:settings.boardImageModel,startedAt:new Date().toISOString(),checks:{}};
const record=async()=>fs.writeFile(path.join(out,"result.json"),JSON.stringify(report,null,2)+"\n");
try {
  // A single reproduction of the user's exact request; no retry loop or rewrite.
  let candidates;
  try {
    candidates=await provider.generate({...request,requestId:"verify-ip-refusal",prompt:"请你绘制一个二次元的米老鼠"});
    report.checks.originalRequest="provider returned an image this time";
  } catch(error) {
    report.checks.originalRequest={name:error.name,reason:error.reason,code:error.providerCode,retryable:error.retryable,message:error.message};
    await record();
    if(error.name!=="ImageContentRefusal")throw error;
  }
  let prompt="请你绘制一个二次元的米老鼠";
  if(!candidates){
    // A separate synthetic success case, not an automatic substitute for the user.
    prompt="绘制一个原创的可爱鲸鱼小精灵角色，圆润浅蓝色身体，小鳍和弯弯尾巴，友善表情，戴一片海草围巾，柔和水彩配色，白色背景，无文字。";
    console.log("Original request refused; running a separate original-character success case.");
    candidates=await provider.generate({...request,requestId:"verify-original-character",prompt});
  }
  const candidate=candidates[0];assert(candidate?.bytes.length);
  const extension=candidate.mimeType==="image/webp"?"webp":candidate.mimeType==="image/jpeg"?"jpg":"png";
  await fs.writeFile(path.join(out,`reference.${extension}`),candidate.bytes);
  const pixels=await sharp(candidate.bytes).resize(384,384,{fit:"inside",withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const anchor={kind:"markdown",key:"qa",quote:"绘图区"};
  const result=runtime.reconstructReference({width:pixels.info.width,height:pixels.info.height,data:new Uint8ClampedArray(pixels.data)},
    {x:0,y:0,width:420,height:420*pixels.info.height/pixels.info.width},anchor,"QA-REFERENCE",6000);
  assert(result.objects.length>0 && result.objects.length<=6000);
  let frames=0,last=0;
  await runtime.playReferenceStrokes(result.objects,{valid:()=>true,instant:()=>false,
    preview:objects=>{assert(objects.length>last);last=objects.length;frames++;},wait:()=>Promise.resolve()});
  assert.equal(last,result.objects.length);
  const history=new runtime.BoardHistory(runtime.createBoardDocument("Recovery QA.md","markdown"));
  history.transact(doc=>doc.objects.push(...result.objects),"tutor");
  const svg=runtime.renderBoardSvg(history.document.objects,{ink:{},characters:[],width:420,height:420});
  await fs.writeFile(path.join(out,"repaint.svg"),svg);
  await sharp(Buffer.from(svg)).png().toFile(path.join(out,"repaint.png"));
  history.undo();assert.equal(history.document.objects.length,0);
  history.redo();assert.equal(history.document.objects.length,result.objects.length);
  const root=path.join(out,"store");await fs.mkdir(root,{recursive:true});
  const safe=p=>{const resolved=path.resolve(root,p);assert(resolved.startsWith(root+path.sep));return resolved;};
  const adapter={
    exists:async p=>fs.access(safe(p)).then(()=>true,()=>false),
    read:p=>fs.readFile(safe(p),"utf8"),
    write:(p,data)=>fs.writeFile(safe(p),data),
    mkdir:p=>fs.mkdir(safe(p),{recursive:true}),
    list:async p=>{const entries=await fs.readdir(safe(p),{withFileTypes:true});return {files:entries.filter(e=>e.isFile()).map(e=>p+"/"+e.name),folders:entries.filter(e=>e.isDirectory()).map(e=>p+"/"+e.name)};},
  };
  const repo=new runtime.BoardRepository(adapter,"Memory");
  await repo.save(history.document,{},svg);await repo.flush();
  const reopened=await new runtime.BoardRepository(adapter,"Memory").open("Recovery QA.md","markdown");
  assert.deepEqual(reopened.document.objects,history.document.objects);
  report.checks.success={prompt,latencyMs:candidate.latencyMs,bytes:candidate.bytes.length,strokes:result.objects.length,
    frames,undoRedo:true,persistReopen:true,preview:"repaint.svg",nativeEditable:true};
  report.finishedAt=new Date().toISOString();await record();
  console.log(JSON.stringify(report,null,2));
} finally {await fs.rm(bundle,{force:true});}
