import { evaluateObsidian } from "./obsidian-eval.mjs";

const vaultIndex = process.argv.indexOf("--vault");
if (vaultIndex < 0 || !process.argv[vaultIndex + 1]) throw new Error("Use --vault VAULT_NAME");
const vault = process.argv[vaultIndex + 1];
const stress = process.argv.includes("--stress");
const materials = process.argv.includes("--materials");
const layerIndex = process.argv.indexOf("--layers");
const layerCount = layerIndex >= 0 ? Number(process.argv[layerIndex + 1]) : 1;
if (!Number.isInteger(layerCount) || layerCount < 1 || layerCount > 30) throw new Error("--layers must be 1-30");
const viewportIndex = process.argv.indexOf("--viewport");
const viewport = viewportIndex >= 0 ? process.argv[viewportIndex + 1] : "";
if (viewport && !/^\d{3,4}x\d{3,4}$/.test(viewport)) throw new Error("--viewport must be WIDTHxHEIGHT");
const sourceIndex = process.argv.indexOf("--source");
const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : "Agent Memory/boards/BOARD-96284109-9f1a-4fe2-9973-44407bae7bdf.md";
const code = `(async()=>{
  const file=${JSON.stringify(source)};
  const leaf=app.workspace.getLeavesOfType('annotation-tutor-lite-board').find(item=>item.view.sourceFile===file&&item.view.history)??app.workspace.getLeaf('tab');
  if(!leaf.view.history)await leaf.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:file}});
  const v=leaf.view;
  if(v?.getViewType?.()!=='annotation-tutor-lite-board'||!v.history)throw new Error('Cannot open the QA Studio board');
  const stage=v.contentEl.querySelector('.atl-standalone-stage');
  const prior={pan:{...v.pan},zoom:v.zoom,objects:v.draftObjects,ink:v.bundle.ink,current:v.history.current,activeLayerId:v.activeLayerId,progressiveRenderEnabled:v.progressiveRenderEnabled,stageWidth:stage?.style.width,stageHeight:stage?.style.height};
  const methods=['renderLayeredScene','drawMinimap'];
  const originals=new Map(),samples={draw:[],zoom:[],renderLayeredScene:[],drawMinimap:[],layerRenderer:[]};
  for(const name of methods){const original=v[name];originals.set(name,original);v[name]=function(...args){const start=performance.now();try{return original.apply(this,args)}finally{samples[name].push(performance.now()-start)}}}
  const originalLayerRender=v.layerRenderer.render;
  v.layerRenderer.render=function(...args){const start=performance.now();try{return originalLayerRender.apply(this,args)}finally{samples.layerRenderer.push(performance.now()-start)}};
  try{
    v.progressiveRenderEnabled=false;
    if(${JSON.stringify(viewport)}&&stage){const [w,h]=${JSON.stringify(viewport)}.split('x');stage.style.width=w+'px';stage.style.height=h+'px';}
    if(${layerCount}>1){
      const layers=Array.from({length:${layerCount}},(_,i)=>({id:'PERF-LAYER-'+i,name:'Stress '+i,order:i,visible:true,locked:false,opacity:1,blendMode:'normal',kind:'vector'}));
      v.history.current={...v.history.renderDocument,layers};v.activeLayerId=layers[0].id;
    }
    if(${stress}){
      const anchor={kind:'canvas',pageId:'main'},ink={...v.bundle.ink},objects=[];
      for(let i=0;i<5000;i++){
        const id='PERF-'+i;
        const kind=${materials ? "['pencil','chalk','crayon','watercolor','sumi','oil'][i%6]" : "'pen'"};
        ink[id]={id,createdAt:'',points:Array.from({length:100},(_,j)=>({x:j,y:Math.sin(j/8)*4,pressure:.5,t:j*16}))};
        objects.push({id,kind:'ink',anchor,x:(i%100)*120,y:Math.floor(i/100)*45,width:100,height:16,color:'#283b62',strokeWidth:${materials ? 12 : 3},
          brush:{kind,engineVersion:2,opacity:1,pressure:true,smoothing:.6,streamline:.5,seed:i},inkId:id,layerId:${layerCount}>1?'PERF-LAYER-'+(i%${layerCount}):v.activeLayerId,
          createdBy:'human',editedBy:'human',revision:1,groupId:'perf'});
      }
      v.bundle.ink=ink;v.draftObjects=objects;
    }
    v.staticRenderKey='';v.layerRenderer.clear();
    let start=performance.now();v.draw();const cold=performance.now()-start;
    for(let i=0;i<12;i++){v.pan.x+=12;v.queueCameraRefine();start=performance.now();v.draw();samples.draw.push(performance.now()-start);if(!v.staticCanvas.style.transform)throw new Error('camera-preview-not-active')}
    v.stopCameraPreview();v.staticRenderKey='';start=performance.now();v.draw();const settled=performance.now()-start;
    for(let i=0;i<12;i++){v.zoom*=1.01;v.queueCameraRefine();start=performance.now();v.draw();samples.zoom.push(performance.now()-start)}
    v.stopCameraPreview();v.staticRenderKey='';start=performance.now();v.draw();const zoomSettled=performance.now()-start;
    const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {count:sorted.length,p50:sorted[Math.ceil(sorted.length*.5)-1]??0,p95:sorted[Math.ceil(sorted.length*.95)-1]??0,max:sorted.at(-1)??0}};
    return {cold,settled,zoomSettled,pan:summary(samples.draw),zoom:summary(samples.zoom),layers:summary(samples.renderLayeredScene),layerRenderer:summary(samples.layerRenderer),minimap:summary(samples.drawMinimap),dpr:v.contentEl.ownerDocument.defaultView.devicePixelRatio,canvas:[v.canvas.width,v.canvas.height],objects:${stress?5000:"v.history.renderDocument.objects.length"},layerCount:${layerCount}};
  }finally{
    for(const name of methods)v[name]=originals.get(name);
    v.layerRenderer.render=originalLayerRender;
    v.stopCameraPreview();v.cancelProgressiveRender();v.pan=prior.pan;v.zoom=prior.zoom;v.draftObjects=prior.objects;v.bundle.ink=prior.ink;v.history.current=prior.current;v.activeLayerId=prior.activeLayerId;v.progressiveRenderEnabled=prior.progressiveRenderEnabled;
    if(stage){stage.style.width=prior.stageWidth;stage.style.height=prior.stageHeight;}
    v.staticRenderKey='';v.layerRenderer.clear();v.schedule();
  }
})()`;
console.log(JSON.stringify(await evaluateObsidian(code,{vault,timeout:stress?120000:60000}),null,2));
