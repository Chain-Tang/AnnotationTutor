import { evaluateObsidian } from "./obsidian-eval.mjs";

const vaultIndex = process.argv.indexOf("--vault");
if (vaultIndex < 0 || !process.argv[vaultIndex + 1]) throw new Error("Use --vault VAULT_NAME");
const vault = process.argv[vaultIndex + 1];
const code = `(async()=>{
  const plugin=app.plugins.plugins['annotation-tutor-lite'];
  if(!plugin?.boards)throw new Error('Tutor plugin is not loaded');
  const bundle=await plugin.boards.createStandalone(),source=bundle.document.sourceFile;
  const leaf=app.workspace.getLeaf('tab');
  await leaf.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:source}});
  app.workspace.setActiveLeaf(leaf,{focus:true});
  const view=leaf.view;
  if(!view.history)throw new Error('Studio did not open');
  const assets=[];
  const png=canvas=>new Promise(resolve=>canvas.toBlob(async blob=>resolve(new Uint8Array(await blob.arrayBuffer())),'image/png'));
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');
  for(const role of ['tip','grain','paper']){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=32;
    const ctx=canvas.getContext('2d');
    if(role==='tip'){
      const gradient=ctx.createRadialGradient(16,16,2,16,16,15);
      gradient.addColorStop(0,'#ffffffff');gradient.addColorStop(.7,'#ffffffdd');gradient.addColorStop(1,'#ffffff00');
      ctx.fillStyle=gradient;ctx.fillRect(0,0,32,32);
    }else{
      for(let y=0;y<32;y++)for(let x=0;x<32;x++){
        const value=role==='grain'?(x*y*17+x*31+y*13)%255:(x*83+y*47)%255;
        ctx.fillStyle='rgb('+value+','+value+','+value+')';ctx.fillRect(x,y,1,1);
      }
    }
    const bytes=await png(canvas),digest=await hash(bytes);
    const path=await view.host.writeBrushResource(digest,'image/png',bytes.buffer);
    assets.push({role,ref:{hash:digest,mimeType:'image/png',width:32,height:32,path,
      license:'CC0-1.0',author:'Tutor QA',source:'https://github.com/mypaint/mypaint-brushes'}});
  }
  view.contentEl.querySelector('[data-brush="chalk"]').click();
  const refs=Object.fromEntries(assets.map(asset=>[asset.role,asset.ref]));
  const style={...view.brush,tipHash:refs.tip.hash,grainHash:refs.grain.hash,paperHash:refs.paper.hash,
    resourceHashes:assets.map(asset=>asset.ref.hash),engineVersion:2};
  view.brush=style;view.color='#9b3640';view.width=42;
  view.history.transact(document=>{
    document.title='Tutor Resource Brush QA';
    document.brushDefinitions??=[];
    document.brushDefinitions.push({formatVersion:2,id:'qa-material',version:1,name:'QA tip grain paper',engine:'dab',kind:'chalk',style,
      tip:refs.tip,grain:refs.grain,paper:refs.paper,license:'CC0-1.0',author:'Tutor QA'});
  });
  await view.loadBrushResources();
  if(view.brushImages.size!==3)throw new Error('Brush images did not decode');
  view.gesture={pointerId:42,mode:'pen',startClient:{x:0,y:0},startWorld:{x:60,y:100},lastClient:{x:0,y:0},seed:42,
    points:Array.from({length:90},(_,index)=>({x:80+index*10,y:250+Math.sin(index/11)*90,pressure:.3+index/130,t:index*12}))};
  view.finish(42);
  const object=view.history.document.objects.find(item=>item.kind==='ink');
  if(!object||object.brush?.tipHash!==refs.tip.hash)throw new Error('Resource snapshot was not saved');
  await view.host.save({document:view.history.document,ink:view.bundle.ink},view.preview());
  await view.exportCurrentBrush();
  const pack=source.replace(/\\.md$/i,'.tutorbrush');
  const file=new File([await app.vault.adapter.readBinary(pack)],'qa.tutorbrush',{type:'application/zip'});
  await view.importBrushFile(file);
  if(view.brush.tipHash!==refs.tip.hash)throw new Error('Resource pack did not import');
  const exported=await view.exportArtwork('tutorboard');
  const preview=await view.exportArtwork('png');
  const reopened=await plugin.boards.openStandalone(source);
  if(reopened.document.brushDefinitions?.length!==2)throw new Error('Brush definitions lost on reopen');
  return {source,pack,exported,preview,resources:assets.map(asset=>({role:asset.role,hash:asset.ref.hash})),objects:reopened.document.objects.length};
})()`;
const result = await evaluateObsidian(code, { vault, timeout: 120000 });
console.log(JSON.stringify(result, null, 2));
