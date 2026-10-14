import {describe,it,expect} from 'vitest';
import {compileMathPlot,parseMathExpression,evaluateMath,type MathDrawing} from '../src/board-math.js';
import {BoardResponseStream,parseBoardAgentResponse} from '../src/board-agent.js';
import {createBoardDocument,BoardHistory,validateBoardDocument} from '../src/board-model.js';
import {applyBoardOperations} from '../src/board-ai.js';
import type {BoardAgentRequest} from '../src/board-types.js';
const image={width:800,height:600};
const spec=(expression='x^2',at=2,value=4)=>({version:1,title:expression,xRange:[-3,3],yRange:[-2,10],curves:[{id:'f',expression}],limits:[{curveId:'f',at,value}]});
const absolute=(d:MathDrawing)=>(d.points??[]).map(p=>({x:d.x+p.x,y:d.y+p.y}));
// Independent geometry witness: test the rendered segment against the four
// rectangle edges, rather than asserting the compiler's chosen quadrant.
const crossesLabel=(d:MathDrawing,label:MathDrawing)=>{
  const pad=d.strokeWidth/2+2;
  const left=label.x-pad,right=label.x+label.width+pad,top=label.y-pad,bottom=label.y+label.height+pad;
  const inside=(p:{x:number;y:number})=>p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom;
  const ps=absolute(d),segments=ps.slice(1).map((b,i)=>[ps[i]!,b]);
  if(d.kind==='arrow'&&ps.length>=2){
    const tip=ps.at(-1)!,previous=ps.at(-2)!,angle=Math.atan2(tip.y-previous.y,tip.x-previous.x),length=Math.max(7,d.strokeWidth*3.5);
    for(const sign of [-1,1])segments.push([tip,{x:tip.x-length*Math.cos(angle+sign*Math.PI/6),y:tip.y-length*Math.sin(angle+sign*Math.PI/6)}]);
  }
  for(const [a,b] of segments as [{x:number;y:number},{x:number;y:number}][]){
    if(inside(a)||inside(b))return true;
    for(const x of [left,right])if(b.x!==a.x){const t=(x-a.x)/(b.x-a.x),y=a.y+t*(b.y-a.y);if(t>=0&&t<=1&&y>=top&&y<=bottom)return true;}
    for(const y of [top,bottom])if(b.y!==a.y){const t=(y-a.y)/(b.y-a.y),x=a.x+t*(b.x-a.x);if(t>=0&&t<=1&&x>=left&&x<=right)return true;}
  }
  return false;
};
const overlap=(a:MathDrawing,b:MathDrawing)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const request=():BoardAgentRequest=>({boardId:'b',sessionId:'s',requestId:'r',baseRevision:0,sourceRevision:'v',sourceFile:'a.md',anchor:{kind:'markdown',key:'a',quote:'lesson'},snapshot:{...image,pngBase64:'fake',imageToBoard:[1,0,0,1,0,0],anchor:{kind:'markdown',key:'a',quote:'lesson'},layoutRevision:'l'},objects:[],instruction:'draw a limit',context:'',character:null,math:true,requiresDrawing:true});

describe('host computed mathematical diagrams',()=>{
  it.each([
    {name:'saved C36 parabola layout',plot:{...spec(),xRange:[0,4],yRange:[0,16]},size:{width:800,height:500}},
    {name:'removable sine limit',plot:{...spec('sin(x)/x',0,1),yRange:[0,2]},size:image},
    {name:'exponential limit',plot:{...spec('(exp(x)-1)/x',0,1),xRange:[-1,1],yRange:[0,2]},size:image},
    {name:'descending curve',plot:{...spec('-x',1,-1),yRange:[-3,3]},size:image},
    {name:'flat curve',plot:{...spec('1',0,1),yRange:[0,2]},size:image},
  ])('keeps coordinate labels clear of curves, arrows and text: $name',({plot,size})=>{
    const ds=compileMathPlot(plot,size),labels=ds.filter(d=>d.kind==='text'&&d.color==='#d22f46');
    expect(labels).toHaveLength(1);
    for(const label of labels){
      expect(ds.filter(d=>d.points&&d.color!=='#94a3b8').some(d=>crossesLabel(d,label))).toBe(false);
      expect(ds.filter(d=>d!==label&&(d.kind==='text'||d.kind==='ellipse')).some(d=>overlap(d,label))).toBe(false);
    }
  });
  it('places adjacent limit labels without covering each other or their approach arrows',()=>{
    const plot={...spec(),xRange:[0,4],yRange:[0,16],limits:[{curveId:'f',at:2,value:4},{curveId:'f',at:2.1,value:4.41}]};
    const ds=compileMathPlot(plot,image),labels=ds.filter(d=>d.kind==='text'&&d.color==='#d22f46');
    expect(labels).toHaveLength(2);expect(overlap(labels[0]!,labels[1]!)).toBe(false);
    for(const label of labels)expect(ds.filter(d=>d.points&&d.color!=='#94a3b8').some(d=>crossesLabel(d,label))).toBe(false);
  });
  it('considers all four neighbouring limits before placing their labels',()=>{
    const plot={...spec(),xRange:[0,4],yRange:[0,16],limits:[2,2.02,2.04,2.06].map(at=>({curveId:'f',at,value:at*at}))};
    const ds=compileMathPlot(plot,image),labels=ds.filter(d=>d.kind==='text'&&d.color==='#d22f46');
    expect(labels).toHaveLength(4);
    for(let i=0;i<labels.length;i++){
      expect(labels.slice(i+1).some(d=>overlap(d,labels[i]!))).toBe(false);
      expect(ds.filter(d=>d.points&&d.color!=='#94a3b8').some(d=>crossesLabel(d,labels[i]!))).toBe(false);
    }
  });
  it('keeps long coordinate labels inside a narrow reserved area at either edge',()=>{
    const size={width:400,height:300},placement={x:.1,y:.1,width:.65,height:.65};
    const plot={version:1,xRange:[1000,2000],yRange:[1000,2000],curves:[{id:'f',expression:'x'}],limits:[{curveId:'f',at:1000,value:1000,side:'right'},{curveId:'f',at:2000,value:2000,side:'left'}],placement};
    const ds=compileMathPlot(plot,size),labels=ds.filter(d=>d.kind==='text'&&d.color==='#d22f46');
    expect(labels).toHaveLength(2);
    for(const d of labels){expect(d.x).toBeGreaterThanOrEqual(40);expect(d.y).toBeGreaterThanOrEqual(30);expect(d.x+d.width).toBeLessThanOrEqual(300);expect(d.y+d.height).toBeLessThanOrEqual(225);}
  });
  it('preserves deterministic label geometry through both protocols and saved reopening',()=>{
    const plot={...spec(),xRange:[0,4],yRange:[0,16]};
    expect(compileMathPlot(JSON.parse(JSON.stringify(plot)),image)).toEqual(compileMathPlot(plot,image));
    const r=request(),wire=JSON.stringify({requestId:'r',baseRevision:0,description:'plot',operations:[{type:'plot',plot}]});
    const batch=parseBoardAgentResponse(wire,r);if(!batch.ok)throw Error(batch.error);
    const stream=new BoardResponseStream(r);stream.push(JSON.stringify({seq:0,type:'turn.begin',requestId:'r',baseRevision:0})+'\n'+JSON.stringify({seq:1,type:'operation',operation:{type:'plot',plot}})+'\n'+JSON.stringify({seq:2,type:'turn.end'}));
    const final=stream.finish();if(!final.ok)throw Error(final.error);
    const geometry=(ops:typeof final.operations)=>ops.flatMap(o=>o.type==='add'&&o.object.kind==='text'?[{x:o.object.x,y:o.object.y,width:o.object.width,height:o.object.height,text:o.object.text}]:[]);
    expect(geometry(batch.operations)).toEqual(geometry(final.operations));
    const history=new BoardHistory(createBoardDocument('a.md','markdown','b'));
    history.transact(d=>{d.objects=applyBoardOperations(d.objects,batch.operations);},'tutor');
    const saved=validateBoardDocument(JSON.parse(JSON.stringify(history.document)));
    expect(saved.objects.filter(o=>o.kind==='text')).toEqual(history.document.objects.filter(o=>o.kind==='text'));
  });
  it('uses the host reserved area instead of a model supplied placement for batch and streamed plots',()=>{
    const r={...request(),drawingArea:{x:240,y:180,width:500,height:370}};
    const plot={...spec(),placement:{x:0,y:0,width:1,height:1}};
    const batch=parseBoardAgentResponse(JSON.stringify({requestId:'r',baseRevision:0,description:'plot',operations:[{type:'plot',plot}]}),r);
    const expected=compileMathPlot({...plot,placement:{x:.3,y:.3,width:.625,height:370/600}},image);
    if(!batch.ok)throw new Error(batch.error);
    expect(batch.operations.map(o=>o.type==='add'?[o.object.x,o.object.y,o.object.width,o.object.height]:null)).toEqual(expected.map(o=>[o.x,o.y,Math.max(1,o.width),Math.max(1,o.height)]));
    const stream=new BoardResponseStream(r);stream.push(JSON.stringify({seq:0,type:'turn.begin',requestId:'r',baseRevision:0})+'\n'+JSON.stringify({seq:1,type:'operation',operation:{type:'plot',plot}})+'\n'+JSON.stringify({seq:2,type:'turn.end'}));
    const final=stream.finish();if(!final.ok)throw new Error(final.error);
    expect(final.operations.map(o=>o.type==='add'?[o.object.x,o.object.y,o.object.width,o.object.height]:null)).toEqual(batch.operations.map(o=>o.type==='add'?[o.object.x,o.object.y,o.object.width,o.object.height]:null));
  });
  it('keeps host labels readable on a Retina capture and uses the same CSS geometry',()=>{
    const normal=request(),retina={...request(),drawingPixelRatio:2,snapshot:{...request().snapshot,width:1600,height:1200,imageToBoard:[.5,0,0,.5,0,0] as [number,number,number,number,number,number]}};
    const response=JSON.stringify({requestId:'r',baseRevision:0,description:'plot',operations:[{type:'plot',plot:spec()}]});
    const a=parseBoardAgentResponse(response,normal),b=parseBoardAgentResponse(response,retina);if(!a.ok||!b.ok)throw new Error('plot failed');
    const labels=(ops:typeof a.operations)=>ops.flatMap(o=>o.type==='add'&&o.object.kind==='text'?[{x:o.object.x,y:o.object.y,size:o.object.textStyle!.size}]:[]);
    expect(labels(b.operations)).toEqual(labels(a.operations));expect(labels(b.operations).every(t=>t.size>=16)).toBe(true);
  });
  it('evaluates bounded arithmetic with precedence and rejects executable syntax',()=>{
    for(const [s,x,y] of [['-x^2',2,-4],['2^3^2',0,512],['sin(pi/2)',0,1],['x²+exp(0)',3,10],['sqrt(abs(-4))',0,2]] as const)
      expect(evaluateMath(parseMathExpression(s),x)).toBeCloseTo(y);
    for(const s of ['process.exit()','x.constructor','x=1','(()=>1)()','Math.sin(x)','random(x)','2x','('.repeat(30)+'x'+')'.repeat(30),'x+'.repeat(201)+'x'])expect(()=>parseMathExpression(s)).toThrow();
  });
  it('places x² curve, finite limit and guides on the same point',()=>{
    const ds=compileMathPlot(spec(),image),dot=ds.find(d=>d.kind==='ellipse')!;
    const target={x:dot.x+4,y:dot.y+4};
    const curve=ds.find(d=>d.kind==='path'&&d.color==='#2563eb')!;
    expect(absolute(curve)).toContainEqual(target);
    expect(ds.filter(d=>d.color==='#94a3b8').map(d=>absolute(d).at(-1))).toEqual([target,target]);
    expect(dot.fill?.color).toBe('#d22f46');
    for(const d of ds){expect(d.x).toBeGreaterThanOrEqual(0);expect(d.y).toBeGreaterThanOrEqual(0);expect(d.x+d.width).toBeLessThanOrEqual(image.width);expect(d.y+d.height).toBeLessThanOrEqual(image.height);}
  });
  it.each(['sin(x)/x','(exp(x)-1)/x'])('keeps %s undefined at zero with an open limit marker and two curve segments',expression=>{
    const ds=compileMathPlot(spec(expression,0,1),image),dot=ds.find(d=>d.kind==='ellipse')!;
    expect(dot.fill?.color).toBe('#ffffff');
    const x=dot.x+4,curves=ds.filter(d=>d.kind==='path'&&d.color==='#2563eb');expect(curves).toHaveLength(2);
    for(const c of curves){const xs=absolute(c).map(p=>p.x);expect(Math.min(...xs)<x&&Math.max(...xs)>x).toBe(false);}
  });
  it('distinguishes a removable hole from an exceptional function value',()=>{
    const s=spec('(x^2-1)/(x-1)',1,2);s.curves=[{id:'f',expression:'(x^2-1)/(x-1)',valueAt:[{x:1,y:5}]} as any];
    const ds=compileMathPlot(s,image),dots=ds.filter(d=>d.kind==='ellipse');
    expect(dots).toHaveLength(2);expect(dots[0]!.x).toBe(dots[1]!.x);expect(dots[0]!.y).toBeLessThan(dots[1]!.y);expect(dots[1]!.fill?.color).toBe('#ffffff');
    const target=dots[0]!.x+4;
    for(const c of ds.filter(d=>d.kind==='path'&&d.color==='#2563eb'))expect(absolute(c).some(p=>p.x===target)).toBe(false);
  });
  it('splits piecewise jumps and rejects a claimed two sided limit at a jump',()=>{
    const s={version:1,xRange:[-2,2],yRange:[-2,2],curves:[{id:'f',pieces:[{expression:'-1',from:-2,to:0},{expression:'1',from:0,to:2,includeTo:true}]}],limits:[] as any[]};
    const curves=compileMathPlot(s,image).filter(d=>d.kind==='path'&&d.color==='#2563eb');
    expect(curves).toHaveLength(2);expect(curves.every(d=>d.height===0)).toBe(true);
    expect(()=>compileMathPlot({...s,limits:[{curveId:'f',at:0,value:1}]},image)).toThrow('math-inconsistent-limit');
    expect(compileMathPlot({...s,limits:[{curveId:'f',at:0,value:1,side:'right'}]},image).length).toBeGreaterThan(0);
  });
  it('never connects 1/x across its asymptote or sqrt across undefined x',()=>{
    const s={...spec('1/x',0,0),limits:[]};
    const curves=compileMathPlot(s,image).filter(d=>d.kind==='path'&&d.color==='#2563eb');expect(curves).toHaveLength(2);
    const center=64+36+(672-72)/2;
    for(const c of curves){const xs=absolute(c).map(p=>p.x);expect(Math.min(...xs)<center&&Math.max(...xs)>center).toBe(false);}
    expect(()=>compileMathPlot(spec('1/x',0,0),image)).toThrow('math-inconsistent-limit');
    expect(compileMathPlot({...s,curves:[{id:'f',expression:'sqrt(x)'}]},image).filter(d=>d.kind==='path'&&d.color==='#2563eb')).toHaveLength(1);
  });
  it('rejects wrong limits, overlapping pieces and unrenderable areas',()=>{
    expect(()=>compileMathPlot(spec('x^2',2,5),image)).toThrow('math-inconsistent-limit');
    expect(()=>compileMathPlot(spec(),{width:100,height:100})).toThrow('math-area-too-small');
    expect(()=>compileMathPlot({...spec(),curves:[{id:'f',pieces:[{expression:'x',from:0,to:2},{expression:'x',from:1,to:3}]}]},image)).toThrow('math-overlapping-pieces');
  });
  it('accepts a plot through both protocols, with stable preview IDs and host ownership',()=>{
    const r=request(),operation={type:'plot',plot:spec()};
    const response={requestId:r.requestId,baseRevision:r.baseRevision,description:'drawn',operations:[operation]};
    const result=parseBoardAgentResponse(JSON.stringify(response),r);expect(result.ok).toBe(true);
    const previews:any[]=[];const stream=new BoardResponseStream(r,e=>{if(e.type==='preview')previews.push(e.operations);});
    stream.push(JSON.stringify({seq:0,type:'turn.begin',requestId:r.requestId,baseRevision:0})+'\n'+JSON.stringify({seq:1,type:'operation',operation})+'\n');
    expect(stream.finish().ok).toBe(false);
    stream.push(JSON.stringify({seq:2,type:'turn.end'}));const final=stream.finish();expect(final.ok).toBe(true);
    if(!final.ok)throw new Error('plot failed');
    expect(final.operations).toEqual(previews[0]);expect(final.operations.every(op=>op.type==='add'&&op.object.createdBy==='tutor')).toBe(true);
    expect(new Set(final.operations.map(op=>op.type==='add'&&op.object.selectionGroupId)).size).toBe(1);
    const student={id:'student',kind:'rect' as const,anchor:r.anchor,x:0,y:0,width:10,height:10,color:'#222222',strokeWidth:1,createdBy:'human' as const,editedBy:'human' as const,revision:1,groupId:'student'};
    const doc={...createBoardDocument('a.md','markdown','b'),objects:[student]};
    const history=new BoardHistory(doc);
    history.transact(d=>{d.objects=applyBoardOperations(d.objects,final.operations);},'tutor');
    const reopened=validateBoardDocument(JSON.parse(JSON.stringify(history.document)));
    expect(reopened.objects).toHaveLength(final.operations.length+1);
    expect(history.undo()?.objects).toEqual([student]);expect(history.canUndo).toBe(false);
    expect(history.redo()?.objects).toHaveLength(final.operations.length+1);
    const raw={...response,operations:[{type:'add',object:{kind:'ellipse',x:1,y:1,width:10,height:10,color:'#123456',strokeWidth:2}}]};
    expect(parseBoardAgentResponse(JSON.stringify(raw),r)).toMatchObject({ok:false,error:'math-plot-required'});
    expect(parseBoardAgentResponse(JSON.stringify({...response,baseRevision:99}),r)).toMatchObject({ok:false,error:'stale-response'});
  });
});
