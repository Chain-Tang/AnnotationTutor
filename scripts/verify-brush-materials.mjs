import { evaluateObsidian } from "./obsidian-eval.mjs";

// Run only against an explicitly selected development Vault. Creates a clearly
// named QA artwork; it never modifies a user's existing board.
const vaultIndex = process.argv.indexOf("--vault");
if (vaultIndex < 0 || !process.argv[vaultIndex + 1]) throw new Error("Use --vault VAULT_NAME");
const vault = process.argv[vaultIndex + 1];
const sourceIndex = process.argv.indexOf("--source");
const existingSource = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
const performanceRun = process.argv.includes("--performance");
const code = `(async()=>{
  const plugin=app.plugins.plugins['annotation-tutor-lite'];
  if(!plugin?.boards)throw new Error('Tutor plugin is not loaded');
  const source=${JSON.stringify(existingSource ?? "") }||(await plugin.boards.createStandalone()).document.sourceFile;
  const leaf=app.workspace.getLeaf('tab');
  await leaf.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:source}});
  app.workspace.setActiveLeaf(leaf,{focus:true});
  const view=leaf.view;
  if(!view.history)throw new Error('Studio did not open');
  const kinds=['pen','fountain','pencil','marker','highlighter','chalk','crayon','watercolor','sumi','oil'];
  const ink={};const objects=[],run=Date.now();
  const anchor={kind:'canvas',pageId:'main'};
  for(let row=0;row<kinds.length;row++){
    const kind=kinds[row],button=view.contentEl.querySelector('[data-brush="'+kind+'"]');
    if(!button)throw new Error('Missing brush card '+kind);
    button.click();
    const style=structuredClone(view.brush),width=view.width;
    if(style.engineVersion!==2)throw new Error('New stroke is not v2: '+kind);
    const y=35+row*135,id='QA-'+kind+'-'+run;
    const points=Array.from({length:90},(_,index)=>({x:index*9,y:42+Math.sin(index/8)*18,
      pressure:0.12+0.88*index/89,tiltX:-35+index*.6,tiltY:18,t:index*10}));
    ink[id]={id,createdAt:new Date().toISOString(),points};
    objects.push({id:'label-'+kind,kind:'text',anchor,x:30,y:y+6,width:165,height:36,color:'#202433',strokeWidth:0.1,
      text:kind,textStyle:{font:'sans',size:24,align:'left'},layerId:'qa-ink',createdBy:'human',editedBy:'human',revision:1,groupId:'qa'});
    objects.push({id:'stroke-'+kind,kind:'ink',anchor,x:200,y,width:850,height:82,color:'#283b62',strokeWidth:width,
      brush:style,inkId:id,layerId:'qa-ink',createdBy:'human',editedBy:'human',revision:1,groupId:'qa'});
  }
  view.bundle.ink=ink;
  view.history.transact(document=>{
    document.title='Tutor Brush Materials QA';
    document.artboards=[{id:'qa-artboard',name:'10 brush materials',x:0,y:0,width:1100,height:1450,dpi:144,background:'#ffffff',exportPreset:'screen'}];
    document.background={kind:'plain',color:'#ffffff',spacing:24,opacity:1};
    document.layers=[{id:'qa-ink',name:'Brush comparison',kind:'vector',order:0,visible:true,locked:false,opacity:1,blendMode:'normal'}];
    document.objects=objects;
  });
  view.activeArtboardId='qa-artboard';view.activeLayerId='qa-ink';
  view.staticRenderKey='';view.layerRenderer.clear();view.schedule();
  await view.host.save({document:view.history.document,ink:view.bundle.ink},view.preview());
  const png=await view.exportArtwork('png');
  const webp=await view.exportArtwork('webp');
  const svg=await view.exportArtwork('svg');
  const pdf=await view.exportArtwork('pdf');
  const ora=await view.exportArtwork('ora');
  const editable=await view.exportArtwork('tutorboard');
  const reopened=await plugin.boards.openStandalone(source);
  if(reopened.document.objects.length!==20||Object.keys(reopened.ink).length!==10)throw new Error('Reopen mismatch');
  if(reopened.document.objects.filter(object=>object.kind==='ink').some(object=>object.brush?.engineVersion!==2))throw new Error('Brush snapshots lost');
  let performance=null;
  if(${performanceRun}){
    const priorObjects=view.draftObjects,priorInk=view.bundle.ink,priorBrush=view.brush,priorWidth=view.width;
    const stressInk={...priorInk},stressObjects=[];
    try{
      for(let index=0;index<5000;index++){
        const strokeId='STRESS-'+index;
        stressInk[strokeId]={id:strokeId,createdAt:'',points:Array.from({length:100},(_,point)=>({x:point,y:Math.sin(point/8)*4,pressure:.5,t:point*16}))};
        stressObjects.push({id:'STRESS-OBJECT-'+index,kind:'ink',anchor,x:(index%100)*120,y:Math.floor(index/100)*45,
          width:100,height:16,color:'#283b62',strokeWidth:3,brush:{kind:'pen',opacity:1,pressure:true,smoothing:.6,streamline:.5,seed:index},
          inkId:strokeId,layerId:'qa-ink',createdBy:'human',editedBy:'human',revision:1,groupId:'stress'});
      }
      view.bundle.ink=stressInk;view.draftObjects=[...objects,...stressObjects];view.staticRenderKey='';view.layerRenderer.clear();
      view.renderMetrics.clear();view.draw();
      view.contentEl.querySelector('[data-brush="oil"]').click();view.width=32;
      view.gesture={pointerId:73,mode:'pen',startClient:{x:0,y:0},startWorld:{x:100,y:100},lastClient:{x:0,y:0},seed:73,points:[]};
      for(let index=0;index<120;index++){
        view.gesture.points.push({x:210+index*3,y:620+Math.sin(index/13)*40,pressure:.5+index/250,t:index*16});
        view.draw();
      }
      performance={...view.renderMetrics.snapshot(),objects:5000,points:500000,scope:'120 synchronous synthetic frames in real Obsidian; application render time, not device input latency or FPS'};
    }finally{
      view.gesture=null;view.livePainter.clear();view.bundle.ink=priorInk;view.draftObjects=priorObjects;
      view.brush=priorBrush;view.width=priorWidth;view.staticRenderKey='';view.layerRenderer.clear();view.schedule();
    }
  }
  return {source,png,webp,svg,pdf,ora,editable,brushes:kinds,objects:reopened.document.objects.length,ink: Object.keys(reopened.ink).length,performance};
})()`;
const result = await evaluateObsidian(code, { vault, timeout: performanceRun ? 240000 : 120000 });
console.log(JSON.stringify(result, null, 2));
