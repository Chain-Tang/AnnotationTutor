// Opt-in QA inside the real Obsidian canvas renderer; no model/API calls.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const out=path.resolve('docs/qa/reference-materials-2026-09-18');fs.mkdirSync(out,{recursive:true});
await build({stdin:{contents:'export * from "./src/board-reference-paint.ts"; export * from "./src/board-reference-style.ts"; export {renderBoardCanvas,renderBoardSvg} from "./src/board-renderer.ts";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'iife',globalName:'ReferenceQA',outfile:'dist/qa/reference-regions.cjs'});
async function render(bundle,sourcePath,out) {
 const fs=require('fs');window.eval(fs.readFileSync(bundle,'utf8'));
 const image=new Image();image.src='data:image/png;base64,'+fs.readFileSync(sourcePath).toString('base64');await image.decode();
 const source=document.createElement('canvas');const ratio=Math.min(1,384/Math.max(image.naturalWidth,image.naturalHeight));
 source.width=Math.round(image.naturalWidth*ratio);source.height=Math.round(image.naturalHeight*ratio);
 const ctx=source.getContext('2d');ctx.drawImage(image,0,0,source.width,source.height);
 const pixels={width:source.width,height:source.height,data:ctx.getImageData(0,0,source.width,source.height).data},reports=[];
 for(const [name,style] of Object.entries(ReferenceQA.referencePaintPresets)) {
  const start=performance.now(),r=ReferenceQA.reconstructReference(pixels,{x:0,y:0,width:640,height:640*pixels.height/pixels.width},{kind:'markdown',key:'qa',quote:'qa'},'material-'+name,6000,style);
  const rebuilt=performance.now(),c=document.createElement('canvas');c.width=640;c.height=Math.round(640*pixels.height/pixels.width);
  const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);ReferenceQA.renderBoardCanvas(x,r.objects,{ink:{},characters:[]});
  const firstRender=performance.now();ReferenceQA.renderBoardCanvas(x,r.objects,{ink:{},characters:[]});const cachedRender=performance.now()-firstRender;
  // Redraw on a clean backing for the exported comparison (transparent washes must not compound).
  x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);ReferenceQA.renderBoardCanvas(x,r.objects,{ink:{},characters:[]});
  fs.writeFileSync(out+'/'+name+'.png',Buffer.from(c.toDataURL('image/png').split(',')[1],'base64'));
  fs.writeFileSync(out+'/'+name+'.json',JSON.stringify(r));
  reports.push({name,objects:r.objects.length,regions:r.regionCount,materialRegions:r.objects.filter(o=>o.fill?.kind==='brush').length,sampling:r.samplingWidth,traceMs:Math.round(rebuilt-start),firstRenderMs:Math.round(firstRender-rebuilt),cachedRenderMs:Math.round(cachedRender)});
 }
 fs.writeFileSync(out+'/comparison.json',JSON.stringify(reports,null,2));return JSON.stringify(reports);
}
const args=[path.resolve('dist/qa/reference-regions.cjs'),path.resolve('docs/qa/reference-routing-2026-09-16/generated-reference.png'),out];
console.log(execFileSync('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',['eval','vault=Documents',`code=(${render.toString()})(${args.map(v=>JSON.stringify(v)).join(',')})`],{encoding:'utf8',timeout:120000}));
