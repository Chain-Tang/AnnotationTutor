// Render opt-in synthetic math QA through the actual Obsidian canvas renderer.
import {build} from 'esbuild';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),out=path.resolve('docs/qa/board-routing-math-2026-09-18'),bundle=path.resolve('dist/qa/math-render.cjs');
await build({stdin:{contents:'export {renderBoardCanvas} from "./src/board-renderer.ts";export {compileMathPlot} from "./src/board-math.ts";export {builtInBoardAssets} from "./src/board-characters.ts";export {configureBoardFonts,ensureBoardFonts,boardHandwrittenText} from "./src/board-fonts.ts";',resolveDir:root},bundle:true,platform:'node',format:'iife',globalName:'MathQA',outfile:bundle});
async function render(root,bundle,out){
  const fs=require('fs');window.eval(fs.readFileSync(bundle,'utf8'));
  try{
    MathQA.configureBoardFonts({readBinary:async file=>fs.readFileSync(root+'/'+file)});
    const report=JSON.parse(fs.readFileSync(out+'/direct-live.json','utf8'));
    if(!report.result.ok)throw new Error('Live plot failed');
    const objects=report.result.operations.map(op=>op.object),characters=MathQA.builtInBoardAssets();
    await MathQA.ensureBoardFonts(document,MathQA.boardHandwrittenText(objects,characters));
    const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,800,600);
    MathQA.renderBoardCanvas(ctx,objects,{ink:{},characters});
    fs.writeFileSync(out+'/direct-live.png',Buffer.from(canvas.toDataURL('image/png').split(',')[1],'base64'));
    const target=objects.find(o=>o.kind==='ellipse'),curves=objects.filter(o=>o.kind==='path'&&o.color==='#2563eb');
    const residual=target?Math.min(...curves.flatMap(c=>(c.points??[]).map(p=>Math.hypot(c.x+p.x-target.x-target.width/2,c.y+p.y-target.y-target.height/2)))):null;
    const summary={objects:objects.length,limitMarker:target&&{x:target.x+target.width/2,y:target.y+target.height/2},curveToMarkerDistance:residual};
    fs.writeFileSync(out+'/geometry-check.json',JSON.stringify(summary,null,2));return summary;
  }finally{delete window.MathQA;}
}
console.log(execFileSync('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',['eval','vault=Documents',`code=(${render.toString()})(${[root,bundle,out].map(JSON.stringify).join(',')})`],{encoding:'utf8',timeout:30000}));
