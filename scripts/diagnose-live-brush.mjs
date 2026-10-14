import { evaluateObsidian } from "./obsidian-eval.mjs";

const vaultIndex = process.argv.indexOf("--vault");
if (vaultIndex < 0 || !process.argv[vaultIndex + 1]) throw new Error("Use --vault VAULT_NAME");
const vault = process.argv[vaultIndex + 1];
const stress = process.argv.includes("--stress");
const zoomIndex = process.argv.indexOf("--zoom");
const requestedZoom = zoomIndex >= 0 ? Number(process.argv[zoomIndex + 1]) : null;
if (requestedZoom !== null && (!Number.isFinite(requestedZoom) || requestedZoom <= 0)) throw new Error("Invalid --zoom");
const code = `(async()=>{
  const v=app.workspace.activeLeaf?.view;
  if(v?.getViewType?.()!=='annotation-tutor-lite-board'||!v.history)throw new Error('Open the QA Studio board first');
  const prior={gesture:v.gesture,brush:v.brush,width:v.width,objects:v.draftObjects,ink:v.bundle.ink,zoom:v.zoom};
  const original=v.livePainter.render.bind(v.livePainter);
  const painter=[],frames=[];
  v.livePainter.render=(...args)=>{const start=performance.now();try{return original(...args)}finally{painter.push(performance.now()-start)}};
  try{
    if(${requestedZoom !== null})v.zoom=${requestedZoom ?? 1};
    if(${stress}){
      const anchor={kind:'canvas',pageId:'main'},ink={...v.bundle.ink},objects=[];
      for(let i=0;i<5000;i++){
        const id='PERF-'+i;
        ink[id]={id,createdAt:'',points:Array.from({length:100},(_,j)=>({x:j,y:Math.sin(j/8)*4,pressure:.5,t:j*16}))};
        objects.push({id,kind:'ink',anchor,x:(i%100)*120,y:Math.floor(i/100)*45,width:100,height:16,color:'#283b62',strokeWidth:3,
          brush:{kind:'pen',opacity:1,pressure:true,smoothing:.6,streamline:.5,seed:i},inkId:id,layerId:v.activeLayerId,
          createdBy:'human',editedBy:'human',revision:1,groupId:'perf'});
      }
      v.bundle.ink=ink;v.draftObjects=objects;v.staticRenderKey='';v.layerRenderer.clear();
    }
    v.contentEl.querySelector('[data-brush="oil"]').click();v.width=32;
    v.gesture={pointerId:73,mode:'pen',startClient:{x:0,y:0},startWorld:{x:100,y:100},lastClient:{x:0,y:0},seed:73,points:[]};
    v.staticRenderKey='';const coldStart=performance.now();v.draw();const cold=performance.now()-coldStart;
    for(let i=0;i<${stress ? 120 : 40};i++){
      v.gesture.points.push({x:210+i*3,y:620+Math.sin(i/13)*40,pressure:.5+i/250,t:i*16});
      const start=performance.now();v.draw();frames.push(performance.now()-start);
    }
    const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {count:sorted.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)}};
    return {cold,frame:summary(frames),painter:summary(painter),zoom:v.zoom,dpr:v.contentEl.ownerDocument.defaultView.devicePixelRatio,canvas:[v.canvas.width,v.canvas.height]};
  }finally{
    v.livePainter.render=original;v.gesture=prior.gesture;v.brush=prior.brush;v.width=prior.width;
    v.draftObjects=prior.objects;v.bundle.ink=prior.ink;v.zoom=prior.zoom;v.livePainter.clear();v.staticRenderKey='';v.layerRenderer.clear();v.schedule();
  }
})()`;
console.log(JSON.stringify(await evaluateObsidian(code,{vault,timeout:stress?120000:60000}),null,2));
