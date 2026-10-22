import {evaluateObsidian} from './obsidian-eval.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const output=`${process.cwd()}/docs/qa/natural-learning-20260927/batch3/performance`;await mkdir(output,{recursive:true});
const code=`(async()=>{
const p=app.plugins.plugins['annotation-tutor-lite'];if(p.tutorConversation.state.busy)throw new Error('busy');
const source=p.settings.memoryRoot+'/standalone/Natural-Desktop-Performance-QA.md',leaf=app.workspace.getLeavesOfType('annotation-tutor-lite-board').find(l=>l.view.history&&l.view.sourceFile===source&&l.view.canvas?.isConnected)??app.workspace.getLeaf('tab');if(!leaf.view.history)await Promise.race([leaf.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:source}}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('view-open-timeout')),15000))]);const v=leaf.view;app.workspace.setActiveLeaf(leaf,{focus:true});await new Promise(r=>setTimeout(r,300));
const layer=(id,order)=>({id,name:id,order,kind:'paint',visible:true,locked:false,opacity:1,blendMode:'normal'});
const gradient=(id,layerId,bounds,color,extra={})=>({id,layerId,type:'gradient',bounds,color,opacity:1,gradient:{kind:'linear',from:{x:0,y:0},to:{x:256,y:0},endColor:color},affectedTiles:[],revision:1,createdAt:new Date().toISOString(),...extra});
v.history.transact(d=>{d.artboards=[{id:'qa',name:'QA',x:0,y:0,width:256,height:256,dpi:144,background:'#ffffff',exportPreset:'screen'}];d.objects=[];d.layers=[layer('base',0),layer('top',1)];d.paintOperations=[gradient('base','base',{x:0,y:0,width:256,height:256},'#ff0000'),gradient('top','top',{x:40,y:40,width:100,height:100},'#0000ff')];});v.activeArtboardId='qa';v.activeLayerId='top';
const pixel=(x,y)=>[...v.renderArtboardCanvas().getContext('2d').getImageData(x,y,1,1).data];
if(pixel(10,10).join()!=='255,0,0,255'||pixel(70,70).join()!=='0,0,255,255')throw new Error('layer base colors');
v.history.transact(d=>d.paintOperations.push(gradient('locked','top',{x:0,y:0,width:200,height:200},'#00ff00',{alphaLocked:true,clipRect:{x:40,y:40,width:50,height:50},revision:2})));
if(pixel(60,60).join()!=='0,255,0,255'||pixel(120,120).join()!=='0,0,255,255'||pixel(20,20).join()!=='255,0,0,255')throw new Error('alpha lock or selection');
v.history.transact(d=>{d.layers[1].locked=true;});if(v.layerEditable('top'))throw new Error('locked layer editable');
const strokeId='INK-QA-ERASE-'+crypto.randomUUID();v.bundle.ink[strokeId]={id:strokeId,createdAt:new Date().toISOString(),points:[{x:0,y:0,pressure:1},{x:30,y:0,pressure:1}]};
v.history.transact(d=>{d.layers[1].locked=false;d.paintOperations.push({id:'erase',layerId:'top',type:'erase',bounds:{x:55,y:60,width:30,height:1},affectedTiles:[],color:'#000000',opacity:1,strokeWidth:20,inkId:strokeId,brush:{...v.brush,kind:'pen',opacity:1,pressure:false},revision:3,createdAt:new Date().toISOString()});});
const erased=pixel(68,60);if(erased[0]<250||erased[1]>5||erased[2]>5)throw new Error('erased other layer '+erased);
// Export a subset before a full capture: the cache must not hide the base layer.
v.renderArtboardCanvas(new Set(['top']),false);if(pixel(10,10).join()!=='255,0,0,255')throw new Error('export cache contamination');
// One symmetric gesture must be a single undo unit.
v.symmetry=true;v.brush={...v.brush,kind:'pen',opacity:1,pressure:false};const beforeSymmetry=v.history.document.paintOperations.length;
v.gesture={pointerId:9,mode:'pen',startClient:{x:0,y:0},startWorld:{x:100,y:100},lastClient:{x:0,y:0},seed:42,points:[{x:100,y:100},{x:120,y:100}]};v.finish(9);
if(v.history.document.paintOperations.length!==beforeSymmetry+2)throw new Error('symmetry missing');v.history.undo();if(v.history.document.paintOperations.length!==beforeSymmetry)throw new Error('symmetry needs multiple undo');v.symmetry=false;
// Live alpha lock and erase must match final compositing, including lower layers.
v.fitArtboard();v.history.transact(d=>{d.layers[1].alphaLocked=true;});v.color='#00ff00';v.width=12;
v.gesture={pointerId:10,mode:'pen',startClient:{x:0,y:0},startWorld:{x:10,y:10},lastClient:{x:0,y:0},seed:42,points:[{x:10,y:10},{x:25,y:10}]};v.draw();
const live=(x,y)=>[...v.canvas.getContext('2d').getImageData(Math.round((x*v.zoom+v.pan.x)*window.devicePixelRatio),Math.round((y*v.zoom+v.pan.y)*window.devicePixelRatio),1,1).data];
if(live(18,10).join()!=='255,0,0,255')throw new Error('live alpha lock '+live(18,10));
v.gesture=null;v.livePainter.clear();v.gesture={pointerId:11,mode:'erase',startClient:{x:0,y:0},startWorld:{x:110,y:110},lastClient:{x:0,y:0},seed:42,points:[{x:110,y:110},{x:130,y:110}]};v.draw();if(live(120,110).join()!=='255,0,0,255')throw new Error('live erase');v.gesture=null;v.livePainter.clear();
const snap=v.snapshotForObjects([]);if(!snap.pngBase64)throw new Error('paint capture missing');
// An isolated group applies its opacity once, not once per overlapping child.
v.history.transact(d=>{d.layers.push({...layer('group',2),kind:'group',opacity:.5},{...layer('child-a',3),parentId:'group'},{...layer('child-b',4),parentId:'group'});d.paintOperations.push(gradient('group-a','child-a',{x:0,y:0,width:40,height:40},'#0000ff'),gradient('group-b','child-b',{x:0,y:0,width:40,height:40},'#00ff00'));});
const groupPixel=pixel(10,10);if(Math.abs(groupPixel[0]-127)>1||Math.abs(groupPixel[1]-128)>1||groupPixel[2]!==0)throw new Error('group opacity composed per child '+groupPixel);
v.history.undo();
v.commit();await new Promise(r=>setTimeout(r,500));await v.host.save({...v.bundle,document:v.history.document},v.preview());
const reopened=await v.host.open(source);if(reopened.document.paintOperations.length!==4)throw new Error('paint persistence');
require('fs').writeFileSync(${JSON.stringify(output+'/layers.png')},Buffer.from(v.renderArtboardCanvas().toDataURL('image/png').split(',')[1],'base64'));
v.history.transact(d=>{d.layers.push({...layer('objects',2),kind:'vector'});d.objects=Array.from({length:1000},(_,i)=>({id:'qa-'+i,kind:'rect',anchor:{kind:'canvas',pageId:'main'},x:(i%40)*40,y:Math.floor(i/40)*25,width:12,height:12,color:'#6f52ac',strokeWidth:1,layerId:'objects',createdBy:'human',editedBy:'human',revision:1,groupId:'qa'}));});
v.activeLayerId='top';v.fitArtboard();v.renderMetrics.clear();v.draw();v.brush={...v.brush,kind:'watercolor',opacity:.5,seed:42};v.width=32;
v.gesture={pointerId:1,mode:'pen',startClient:{x:0,y:0},startWorld:{x:30,y:30},lastClient:{x:0,y:0},seed:42,points:[]};
for(let i=0;i<200;i++){v.gesture.points.push({x:30+i*.9,y:100+Math.sin(i/20)*40,pressure:.7,t:i*10});v.draw();}
const burst=v.renderMetrics.snapshot();v.gesture=null;v.livePainter.clear();v.draw();v.renderMetrics.clear();
v.gesture={pointerId:2,mode:'pen',startClient:{x:0,y:0},startWorld:{x:30,y:30},lastClient:{x:0,y:0},seed:42,points:[]};
for(let i=0;i<200;i++){v.gesture.points.push({x:30+i*.9,y:100+Math.sin(i/20)*40,pressure:.7,t:i*16});v.draw();await new Promise(r=>require('node:timers').setTimeout(r,16));}
const timings=v.renderMetrics.snapshot();v.gesture=null;v.livePainter.clear();v.draw();
return {passed:true,source,checks:['single symmetry undo','live alpha lock','live erase','isolated group opacity','layer isolation','alpha lock','selection clipping','locked layer','erase keeps lower layer','export cache','paint snapshot','save/reopen'],render:timings,burst,renderTargetPassed:timings.warm.p95<=16.7,objects:1000,dpr:window.devicePixelRatio,host:process.versions,scope:'200 paced synthetic frames (16ms between application draws), plus an unpaced stress loop in real Obsidian; not end-to-end pen latency'};
})()`;
const result=await evaluateObsidian(code,{vault:'Tutor-Acceptance'});await writeFile(output+'/host-result.txt',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
