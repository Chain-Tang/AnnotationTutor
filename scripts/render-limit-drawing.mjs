// Render recorded synthetic QA output through the actual Obsidian canvas engine.
// No model requests, edits to notes, or changes to the user's active conversation.
import { build } from 'esbuild';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root=process.cwd(),out=path.resolve('docs/qa/limit-drawing-2026-09-18');
const bundle=path.resolve('dist/qa/limit-render.cjs');
await build({stdin:{contents:'export {renderBoardCanvas} from "./src/board-renderer.ts"; export {builtInBoardAssets} from "./src/board-characters.ts"; export {configureBoardFonts,ensureBoardFonts,boardHandwrittenText} from "./src/board-fonts.ts";',resolveDir:root},bundle:true,platform:'node',format:'iife',globalName:'LimitQA',outfile:bundle});
async function render(root,bundle,out) {
  const fs=require('fs');window.eval(fs.readFileSync(bundle,'utf8'));
  try {
    LimitQA.configureBoardFonts({readBinary:async file=>fs.readFileSync(root+'/'+file)});
    const image=new Image();image.src='data:image/png;base64,'+fs.readFileSync(out+'/input.png').toString('base64');await image.decode();
    for (const name of ['fixed-layout','fixed-plot']) {
      const report=JSON.parse(fs.readFileSync(out+'/'+name+'.json','utf8'));
      if (!report.result.ok) throw new Error('Cannot render failed QA response: '+name);
      const objects=report.result.operations.map(operation=>operation.object),characters=LimitQA.builtInBoardAssets();
      await LimitQA.ensureBoardFonts(document,LimitQA.boardHandwrittenText(objects,characters));
      const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      LimitQA.renderBoardCanvas(context,objects,{ink:{},characters});
      fs.writeFileSync(out+'/'+name+'.png',Buffer.from(canvas.toDataURL('image/png').split(',')[1],'base64'));
    }
    return 'Rendered both recorded responses; mathematical correctness requires visual review.';
  } finally {delete window.LimitQA;}
}
console.log(execFileSync('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',['eval','vault=Documents',`code=(${render.toString()})(${[root,bundle,out].map(v=>JSON.stringify(v)).join(',')})`],{encoding:'utf8',timeout:30000}));
