import { z } from "zod";

const number = z.number().finite().min(-1e9).max(1e9);
const range = z.tuple([number, number]).refine(([a,b])=>b-a>=1e-9 && b>a,"Increasing range required");
const expression = z.string().min(1).max(400);
const piece = z.object({expression,from:number,to:number,includeFrom:z.boolean().default(true),includeTo:z.boolean().default(false)})
  .strict().refine(p=>p.to>p.from,"Increasing piece domain required");
export const mathPlotSchema = z.object({
  version:z.literal(1), title:z.string().max(100).optional(),
  xRange:range,yRange:range,
  curves:z.array(z.object({id:z.string().regex(/^[a-zA-Z][\w-]{0,30}$/),expression:expression.optional(),
    pieces:z.array(piece).min(1).max(8).optional(),
    excludedX:z.array(number).max(8).default([]),
    valueAt:z.array(z.object({x:number,y:number}).strict()).max(8).default([]),
    color:z.string().regex(/^#[\da-fA-F]{6}$/).default("#2563eb"),
  }).strict().refine(c=>!!c.expression !== !!c.pieces,"Use expression or pieces, not both")).min(1).max(2),
  limits:z.array(z.object({curveId:z.string(),at:number,value:number,side:z.enum(["both","left","right"]).default("both")}).strict()).max(4).default([]),
  /** A bounded placement proposal, not independent mathematical point positions. */
  placement:z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().min(.1).max(1),height:z.number().min(.1).max(1)})
    .strict().refine(r=>r.x+r.width<=1 && r.y+r.height<=1,"Placement must fit").optional(),
}).strict();
export type MathPlotSpec = z.infer<typeof mathPlotSchema>;
type Expr = {kind:"number";value:number}|{kind:"x"}|{kind:"unary";sign:1|-1;arg:Expr}|{kind:"binary";op:string;left:Expr;right:Expr}|{kind:"call";fn:string;arg:Expr};
const functions:Record<string,(x:number)=>number> = {sin:Math.sin,cos:Math.cos,tan:Math.tan,exp:Math.exp,expm1:Math.expm1,ln:Math.log,log:Math.log,sqrt:Math.sqrt,abs:Math.abs};

/** A bounded arithmetic parser. No eval, Function, member access or user code. */
export function parseMathExpression(input:string): Expr {
  if(input.length>400)throw new Error("math-expression-too-complex");
  const tokens:string[]=[];const source=input.replace(/²/g,"^2").replace(/³/g,"^3").replace(/π/g,"pi");
  const token=/\s*(?:(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?|([a-zA-Z]+)|([()+\-*/^]))/y;
  let offset=0;
  while(offset<source.length){if(!source.slice(offset).trim())break;token.lastIndex=offset;const m=token.exec(source);if(!m)throw new Error("math-invalid-expression");tokens.push((m[1]??"")+(m[2]??"") || m[3] || m[4]!);offset=token.lastIndex;}
  let at=0,nodes=0;
  function parse(min=0,depth=0):Expr {
    if(depth>16 || ++nodes>128)throw new Error("math-expression-too-complex");
    const t=tokens[at++];let left:Expr;
    if(t===undefined)throw new Error("math-invalid-expression");
    if(t==="+"||t==="-")left={kind:"unary",sign:t==="+"?1:-1,arg:parse(3,depth+1)};
    else if(t==="("){left=parse(0,depth+1);if(tokens[at++]!==")")throw new Error("math-invalid-expression");}
    else if(t==="x")left={kind:"x"};
    else if(t==="pi"||t==="e")left={kind:"number",value:t==="pi"?Math.PI:Math.E};
    else if(Object.hasOwn(functions,t)){if(tokens[at++]!=="(")throw new Error("math-invalid-expression");left={kind:"call",fn:t,arg:parse(0,depth+1)};if(tokens[at++]!==")")throw new Error("math-invalid-expression");}
    else if(Number.isFinite(Number(t)))left={kind:"number",value:Number(t)};
    else throw new Error("math-invalid-expression");
    while(at<tokens.length){const op=tokens[at]!;const p=op==="+"||op==="-"?1:op==="*"||op==="/"?2:op==="^"?4:0;if(!p||p<min)break;at++;left={kind:"binary",op,left,right:parse(op==="^"?p:p+1,depth+1)};if(++nodes>128)throw new Error("math-expression-too-complex");}
    return left;
  }
  const ast=parse();if(at!==tokens.length)throw new Error("math-invalid-expression");return ast;
}
export function evaluateMath(ast:Expr,x:number):number {
  switch(ast.kind){
    case "number":return ast.value;case "x":return x;case "unary":return ast.sign*evaluateMath(ast.arg,x);
    case "call":return functions[ast.fn]!(evaluateMath(ast.arg,x));
    case "binary":{const a=evaluateMath(ast.left,x),b=evaluateMath(ast.right,x);return ast.op==="+"?a+b:ast.op==="-"?a-b:ast.op==="*"?a*b:ast.op==="/"?a/b:a**b;}
  }
}
export type MathDrawing = {
  kind:"path"|"arrow"|"text"|"ellipse";x:number;y:number;width:number;height:number;color:string;strokeWidth:number;
  points?:{x:number;y:number}[];text?:string;textStyle?:{font:"handwritten";size:number;align:"left"};
  fill?:{kind:"solid";color:string;opacity:number};
};
type Curve = MathPlotSpec["curves"][number];
function curveFunction(curve:Curve):(x:number)=>number {
  const ast=curve.expression?parseMathExpression(curve.expression):undefined;
  const pieces=curve.pieces?.map(p=>({...p,ast:parseMathExpression(p.expression)}));
  if(pieces)for(let i=1;i<pieces.length;i++){const a=pieces[i-1]!,b=pieces[i]!;if(a.to>b.from||(a.to===b.from&&a.includeTo&&b.includeFrom))throw new Error("math-overlapping-pieces");}
  return x=>{
    const point=curve.valueAt.find(p=>p.x===x);if(point)return point.y;
    if(curve.excludedX.includes(x))return NaN;
    if(ast)return evaluateMath(ast,x);
    const p=pieces?.find(p=>(x>p.from||(p.includeFrom&&x===p.from))&&(x<p.to||(p.includeTo&&x===p.to)));
    return p?evaluateMath(p.ast,x):NaN;
  };
}
const pretty=(n:number)=>Number(n.toPrecision(5)).toString();

/** Compile mathematical relationships into existing editable host primitives. */
export function compileMathPlot(input:unknown, image:{width:number;height:number}): MathDrawing[] {
  const checked=mathPlotSchema.safeParse(input);if(!checked.success)throw new Error("math-invalid-spec");
  const spec=checked.data;
  if(new Set(spec.curves.map(c=>c.id)).size!==spec.curves.length)throw new Error("math-duplicate-curve");
  const fs=new Map(spec.curves.map(c=>[c.id,curveFunction(c)]));
  const [xmin,xmax]=spec.xRange,[ymin,ymax]=spec.yRange;
  for(const l of spec.limits){
    const f=fs.get(l.curveId);if(!f||l.at<xmin||l.at>xmax||l.value<ymin||l.value>ymax)throw new Error("math-invalid-limit");
    for(const side of l.side==="both"?[-1,1]:[l.side==="left"?-1:1]){
      const h=Math.min((xmax-xmin)/10,Math.max(1,Math.abs(l.at)));
      const values=[1e-2,1e-3,1e-4,1e-5,1e-6].map(t=>{const x=l.at+side*h*t;return x>=xmin&&x<=xmax?f(x):NaN;});
      const last=values.at(-1)!;const prior=values.at(-2)!;
      if(!Number.isFinite(last)||!Number.isFinite(prior)||Math.abs(last-l.value)>1e-3*Math.max(1,Math.abs(l.value))||Math.abs(last-l.value)>Math.abs(prior-l.value)+1e-8)
        throw new Error("math-inconsistent-limit");
    }
  }
  const r=spec.placement??{x:.08,y:.22,width:.84,height:.7};
  const box={x:r.x*image.width,y:r.y*image.height,w:r.width*image.width,h:r.height*image.height};
  if(box.w<220||box.h<160)throw new Error("math-area-too-small");
  const pad=36,left=box.x+pad,right=box.x+box.w-pad,top=box.y+pad,bottom=box.y+box.h-pad;
  const point=(x:number,y:number)=>({x:left+(x-xmin)/(xmax-xmin)*(right-left),y:bottom-(y-ymin)/(ymax-ymin)*(bottom-top)});
  const drawings:MathDrawing[]=[];
  const path=(points:{x:number;y:number}[],color:string,arrow=false,width=2)=>{
    if(points.length<2 || points.every(p=>p.x===points[0]!.x && p.y===points[0]!.y))return;const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));
    drawings.push({kind:arrow?"arrow":"path",x,y,width:Math.max(...points.map(p=>p.x))-x,height:Math.max(...points.map(p=>p.y))-y,color,strokeWidth:width,points:points.map(p=>({x:p.x-x,y:p.y-y}))});
  };
  const text=(value:string,x:number,y:number,color="#334155",size=16)=>{
    const w=Math.min(box.w,Math.max(40,value.length*size*.8)),h=size*1.4;
    drawings.push({kind:"text",x:Math.max(0,Math.min(x,image.width-w)),y:Math.max(0,Math.min(y,image.height-h)),width:w,height:h,color,strokeWidth:1,text:value,textStyle:{font:"handwritten",size,align:"left"}});
  };
  const segmentInBox=(a:{x:number;y:number},b:{x:number;y:number},r:{x:number;y:number;width:number;height:number})=>{
    let low=0,high=1;for(const axis of ["x","y"] as const){const delta=b[axis]-a[axis],min=r[axis],max=min+(axis==="x"?r.width:r.height);
      if(delta===0){if(a[axis]<min||a[axis]>max)return false;continue;}const t1=(min-a[axis])/delta,t2=(max-a[axis])/delta;low=Math.max(low,Math.min(t1,t2));high=Math.min(high,Math.max(t1,t2));if(low>high)return false;
    }return true;
  };
  const labels:Array<{value:string;p:{x:number;y:number};color:string}>=[];
  const placeLabel=({value,p,color}:typeof labels[number])=>{
    const width=Math.min(box.w,Math.max(40,value.length*16*.8)),height=16*1.4,gap=12;
    // Nearby ticks can occupy every immediate quadrant. Explore bounded,
    // asymmetric offsets too, while preferring the closest clear position.
    const candidates:number[][]=[];
    for(const extraX of [0,16,32,64])for(const extraY of [0,16,32,64]){
      const dx=gap+extraX,dy=gap+extraY;
      candidates.push([p.x+dx,p.y+dy],[p.x-width-dx,p.y+dy],[p.x+dx,p.y-height-dy],[p.x-width-dx,p.y-height-dy],
        [p.x+dx,p.y-height/2],[p.x-width-dx,p.y-height/2],[p.x-width/2,p.y+dy],[p.x-width/2,p.y-height-dy]);
    }
    const boxes=candidates.map(([x,y])=>({x:Math.max(box.x,Math.min(x!,box.x+box.w-width)),y:Math.max(box.y,Math.min(y!,box.y+box.h-height)),width,height}));
    const overlaps=(a:typeof boxes[number],b:{x:number;y:number;width:number;height:number})=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
    const score=(r:typeof boxes[number])=>{let cost=0;for(const drawing of drawings){
      if(drawing.kind==="text"||drawing.kind==="ellipse"){if(overlaps({...r,x:r.x-3,y:r.y-3,width:r.width+6,height:r.height+6},drawing))cost+=drawing.kind==="text"?100:30;}
      else if(drawing.points){const padding=drawing.strokeWidth/2+3,expanded={x:r.x-padding,y:r.y-padding,width:r.width+padding*2,height:r.height+padding*2};
        const points=drawing.points.map(p=>({x:drawing.x+p.x,y:drawing.y+p.y}));
        let hit=points.some((b,i)=>i>0&&segmentInBox(points[i-1]!,b,expanded));
        if(!hit&&drawing.kind==="arrow"&&points.length>=2){
          const tip=points.at(-1)!,previous=points.at(-2)!,angle=Math.atan2(tip.y-previous.y,tip.x-previous.x),head=Math.max(7,drawing.strokeWidth*3.5);
          hit=[-1,1].some(side=>segmentInBox(tip,{x:tip.x-head*Math.cos(angle+side*Math.PI/6),y:tip.y-head*Math.sin(angle+side*Math.PI/6)},expanded));
        }
        if(hit)cost+=drawing.kind==="arrow"?20:drawing.color==="#94a3b8"?2:10;
      }
    }return cost;};
    // Consider actual segments, not the entire curve's bounding rectangle.
    // Labels are added after every limit's arrows, so neighbouring limits also
    // participate. Deterministic ties keep reopening/export geometry stable.
    let chosen=boxes[0]!,best=Infinity;
    for(const candidate of boxes){const cost=score(candidate);if(cost<best){chosen=candidate;best=cost;}if(cost===0)break;}
    text(value,chosen.x,chosen.y,color);
  };
  const dot=(x:number,y:number,color:string,hollow=false)=>{const p=point(x,y);drawings.push({kind:"ellipse",x:p.x-4,y:p.y-4,width:8,height:8,color,strokeWidth:2,fill:{kind:"solid",color:hollow?"#ffffff":color,opacity:1}});};
  const zeroX=Math.max(xmin,Math.min(xmax,0)),zeroY=Math.max(ymin,Math.min(ymax,0));
  path([point(xmin,zeroY),point(xmax,zeroY)],"#475569",true);
  path([point(zeroX,ymin),point(zeroX,ymax)],"#475569",true);
  text("x",right+8,point(0,zeroY).y-8);text("y",point(zeroX,0).x-8,top-25);
  if(spec.title)text(spec.title,box.x,box.y,"#334155",18);
  const xTicks=new Set([xmin,xmax,...spec.limits.map(l=>l.at)]);
  const yTicks=new Set([ymin,ymax,...spec.limits.map(l=>l.value)]);
  for(const x of xTicks){const p=point(x,zeroY);path([{x:p.x,y:p.y-3},{x:p.x,y:p.y+3}],"#64748b",false,1);text(pretty(x),p.x-8,p.y+6);}
  for(const y of yTicks){const p=point(zeroX,y);path([{x:p.x-3,y:p.y},{x:p.x+3,y:p.y}],"#64748b",false,1);text(pretty(y),p.x-30,p.y-10);}
  for(const curve of spec.curves){
    const f=fs.get(curve.id)!;
    const breaks=[...(curve.pieces??[]).flatMap(p=>[p.from,p.to]),...curve.excludedX,...curve.valueAt.map(p=>p.x)];
    const xs=new Set<number>();for(let i=0;i<=256;i++)xs.add(xmin+(xmax-xmin)*i/256);
    for(const b of breaks)if(b>xmin&&b<xmax){const e=(xmax-xmin)*1e-7;xs.add(b-e);xs.add(b);xs.add(b+e);}
    for(const l of spec.limits.filter(l=>l.curveId===curve.id))xs.add(l.at);
    let segment:{x:number;y:number}[]=[],previousX:number|undefined;
    const flush=()=>{path(segment,curve.color);segment=[];};
    for(const x of [...xs].sort((a,b)=>a-b)){
      const y=f(x);
      if(!Number.isFinite(y)||y<ymin||y>ymax){flush();previousX=undefined;continue;}
      if(previousX!==undefined){const middle=f((previousX+x)/2);
        if(breaks.some(b=>b>=previousX!&&b<=x)||!Number.isFinite(middle)||middle<ymin||middle>ymax||Math.abs(point(x,y).y-segment.at(-1)!.y)>(bottom-top)*.45)flush();}
      segment.push(point(x,y));previousX=x;
    }
    flush();
    for(const p of curve.valueAt)if(p.x>=xmin&&p.x<=xmax&&p.y>=ymin&&p.y<=ymax)dot(p.x,p.y,curve.color);
  }
  for(const l of spec.limits){
    const p=point(l.at,l.value),color="#d22f46",f=fs.get(l.curveId)!;
    path([point(l.at,zeroY),p],"#94a3b8",false,1);path([point(zeroX,l.value),p],"#94a3b8",false,1);
    dot(l.at,l.value,color,!Number.isFinite(f(l.at))||Math.abs(f(l.at)-l.value)>1e-8);
    // Sampling arrows stay on the actual function and point toward the limit.
    for(const side of l.side==="both"?[-1,1]:[l.side==="left"?-1:1]){
      const dx=(xmax-xmin)*.075,x1=l.at+side*dx,x2=l.at+side*dx*.4,y1=f(x1),y2=f(x2);
      if(x1>=xmin&&x1<=xmax&&Number.isFinite(y1)&&Number.isFinite(y2)&&y1>=ymin&&y1<=ymax&&y2>=ymin&&y2<=ymax)
        path([point(x1,y1),point(x2,y2)],"#16a34a",true,3);
    }
    labels.push({value:`(${pretty(l.at)}, ${pretty(l.value)})`,p,color});
  }
  for(const label of labels)placeLabel(label);
  if(drawings.length>80)throw new Error("math-diagram-too-complex");
  return drawings;
}

export function mathPlotPrompt(): string {
  return `For a function/limit plot, emit operation.type="plot", operation.plot=<MathPlotSpec>, never manually guessed curve/marker pixels.
MathPlotSpec: {version:1,title?,xRange:[min,max],yRange:[min,max],curves:[{id,expression?,pieces?:[{expression,from,to,includeFrom?,includeTo?}],excludedX?:number[],valueAt?:[{x,y}],color?:"#RRGGBB"}],limits:[{curveId,at,value,side:"both"|"left"|"right"}],placement?:{x,y,width,height}}.
Use ONE expression OR non-overlapping ordered pieces per curve. Expressions are arithmetic strings with x, pi, e, + - * / ^, parentheses and sin/cos/tan/exp/expm1/ln/log/sqrt/abs. No assignments, code, implicit multiplication, LaTeX or other functions. At most 2 curves and 4 finite limits. Set ranges to contain the approach on each requested side. Leave a little vertical margin above/below each limit. Undefined function values must remain undefined; never add valueAt to turn sin(x)/x at zero into a defined function. valueAt is ONLY for an explicitly specified exceptional function value.
The host computes all axes, labels, samples, holes, guides and arrows consistently. Do not emit additional raw operations for the same plot. Optional placement is a rectangle normalized to the screenshot (not math coordinates); choose readable blank space, >=220x160 image pixels. Omit placement to use the default area. Use title to name the formula. If the request is general, state which example you choose in the reply, such as x^2 at x=2; otherwise respect the source/requested formula. Never claim numerical checks prove a limit.
Example operation: {"type":"plot","plot":{"version":1,"title":"f(x) = x²","xRange":[0,3],"yRange":[0,10],"curves":[{"id":"f","expression":"x^2"}],"limits":[{"curveId":"f","at":2,"value":4,"side":"both"}]}}`;
}
