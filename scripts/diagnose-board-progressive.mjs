import { evaluateObsidian } from "./obsidian-eval.mjs";

const vaultIndex=process.argv.indexOf("--vault");
if(vaultIndex<0||!process.argv[vaultIndex+1])throw new Error("Use --vault VAULT_NAME");
const vault=process.argv[vaultIndex+1];
const source="Agent Memory/boards/BOARD-96284109-9f1a-4fe2-9973-44407bae7bdf.md";
const code=`(async()=>{
  const file=${JSON.stringify(source)};
  const leaf=app.workspace.getLeavesOfType('annotation-tutor-lite-board').find(item=>item.view.sourceFile===file&&item.view.history)??app.workspace.getLeaf('tab');
  if(!leaf.view.history)await leaf.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:file}});
  const v=leaf.view,stage=v.contentEl.querySelector('.atl-standalone-stage');
  if(!stage||!v.history)throw new Error('QA Studio is unavailable');
  if(v.contentEl.ownerDocument.visibilityState!=='visible')throw new Error('Bring Obsidian to the foreground before running the frame-by-frame QA');
  const prior={current:v.history.current,ink:v.bundle.ink,activeLayerId:v.activeLayerId,pan:{...v.pan},zoom:v.zoom,stageWidth:stage.style.width,stageHeight:stage.style.height,progressiveRenderEnabled:v.progressiveRenderEnabled};
  try{
    stage.style.width='1200px';stage.style.height='900px';
    const layers=Array.from({length:20},(_,i)=>({id:'PERF-LAYER-'+i,name:'Stress '+i,order:i,visible:true,locked:false,opacity:1,blendMode:'normal',kind:'vector'}));
    const ink={...v.bundle.ink},objects=[],anchor={kind:'canvas',pageId:'main'};
    for(let i=0;i<5000;i++){
      const id='PERF-'+i,kind=['pencil','chalk','crayon','watercolor','sumi','oil'][i%6];
      ink[id]={id,createdAt:'',points:Array.from({length:100},(_,j)=>({x:j,y:Math.sin(j/8)*4,pressure:.5,t:j*16}))};
      objects.push({id,kind:'ink',anchor,x:(i%100)*120,y:Math.floor(i/100)*45,width:100,height:16,color:'#283b62',strokeWidth:12,
        brush:{kind,engineVersion:2,opacity:1,pressure:true,smoothing:.6,streamline:.5,seed:i},inkId:id,layerId:'PERF-LAYER-'+(i%20),
        createdBy:'human',editedBy:'human',revision:1,groupId:'perf'});
    }
    v.history.current={...v.history.renderDocument,revision:v.history.revision+1,objects,layers,paintOperations:[]};
    v.bundle.ink=ink;v.activeLayerId=layers[0].id;v.pan={x:0,y:0};v.zoom=.6;v.progressiveRenderEnabled=true;
    v.cancelProgressiveRender();v.staticRenderKey='';v.layerRenderer.clear();v.lastProgressiveRender=null;
    const started=performance.now();v.draw();const firstDrawMs=performance.now()-started;
    if(!v.progressiveKey)throw new Error('Progressive path did not start; visible objects='+v.visibleObjects.length);
    const limit=performance.now()+60000;
    while(v.progressiveKey&&performance.now()<limit)await new Promise(resolve=>requestAnimationFrame(resolve));
    if(v.progressiveKey)throw new Error('Progressive rendering did not finish');
    const result=v.lastProgressiveRender;
    const canvas=v.staticCanvas,ctx=canvas.getContext('2d');
    const progressive=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    v.progressiveRenderEnabled=false;v.staticRenderKey='';v.layerRenderer.clear();
    const syncStart=performance.now();v.draw();const syncMs=performance.now()-syncStart;
    const exact=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let changedPixels=0,maxChannelDifference=0;
    for(let i=0;i<exact.length;i+=4){
      const difference=Math.max(Math.abs(exact[i]-progressive[i]),Math.abs(exact[i+1]-progressive[i+1]),Math.abs(exact[i+2]-progressive[i+2]),Math.abs(exact[i+3]-progressive[i+3]));
      if(difference){changedPixels++;maxChannelDifference=Math.max(maxChannelDifference,difference);}
    }
    return {firstDrawMs,progressive:result,syncMs,changedPixels,maxChannelDifference,canvas:[canvas.width,canvas.height],visibleObjects:v.visibleObjects.length};
  }finally{
    v.cancelProgressiveRender();v.history.current=prior.current;v.bundle.ink=prior.ink;v.activeLayerId=prior.activeLayerId;v.pan=prior.pan;v.zoom=prior.zoom;v.progressiveRenderEnabled=prior.progressiveRenderEnabled;
    stage.style.width=prior.stageWidth;stage.style.height=prior.stageHeight;v.staticRenderKey='';v.layerRenderer.clear();v.schedule();
  }
})()`;
console.log(JSON.stringify(await evaluateObsidian(code,{vault,timeout:120000}),null,2));
