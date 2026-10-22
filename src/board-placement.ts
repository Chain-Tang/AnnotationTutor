import type {BoardMatrix, BoardObject, BoardRect} from "./board-types.js";
import {boardObjectBounds} from "./board-spatial.js";
import {transformBoardPoint, invertBoardMatrix} from "./board-surfaces.js";

export type DrawingSpace = {viewport:BoardRect; protected:BoardRect[]};
export const overlaps = (a:BoardRect,b:BoardRect):boolean => a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
const contains=(a:BoardRect,b:BoardRect)=>b.x>=a.x && b.y>=a.y && b.x+b.width<=a.x+a.width && b.y+b.height<=a.y+a.height;
export function rectUnion(rects:readonly BoardRect[]):BoardRect {
  if(!rects.length)return {x:0,y:0,width:0,height:0};
  const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));
  return {x,y,width:Math.max(...rects.map(r=>r.x+r.width))-x,height:Math.max(...rects.map(r=>r.y+r.height))-y};
}
export function mapRect(r:BoardRect,m:BoardMatrix):BoardRect {
  const points=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,y])=>transformBoardPoint(m,{x:x!,y:y!}));
  return rectUnion(points.map(p=>({...p,width:0,height:0})));
}
export function objectClientBounds(object:BoardObject,m:BoardMatrix):BoardRect {
  const r=boardObjectBounds(object),pad=Math.max(2,object.strokeWidth/2);
  return mapRect({x:r.x-pad,y:r.y-pad,width:r.width+2*pad,height:r.height+2*pad},m);
}
export function safeDrawingRect(space:DrawingSpace,r:BoardRect):boolean {
  return [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>=0 && r.height>=0 && contains(space.viewport,r) && !space.protected.some(p=>overlaps(p,r));
}

/** Conservative occupancy raster. Cells touching any protected material are unavailable.
 * Bounded O(rows*columns + obstacles*occupied cells), independent of rectangle combinations. */
export function findDrawingRect(space:DrawingSpace,desired={width:520,height:380},minimum={width:280,height:200},preferred?:BoardRect):BoardRect|null {
  const v=space.viewport;
  if(v.width<minimum.width||v.height<minimum.height)return null;
  const step=Math.max(8,Math.max(v.width,v.height)/240),cols=Math.floor(v.width/step),rows=Math.floor(v.height/step);
  const grid=new Uint8Array(cols*rows);
  for(const p of space.protected){
    if(!overlaps(v,p))continue;
    const x0=Math.max(0,Math.floor((p.x-v.x)/step)),x1=Math.min(cols,Math.ceil((p.x+p.width-v.x)/step));
    const y0=Math.max(0,Math.floor((p.y-v.y)/step)),y1=Math.min(rows,Math.ceil((p.y+p.height-v.y)/step));
    for(let y=y0;y<y1;y++)grid.fill(1,y*cols+x0,y*cols+x1);
  }
  const heights=new Int32Array(cols);let best:BoardRect|null=null,bestScore=-Infinity;
  for(let y=0;y<rows;y++){
    for(let x=0;x<cols;x++)heights[x]=grid[y*cols+x]?0:heights[x]!+1;
    const stack:number[]=[];
    for(let x=0;x<=cols;x++){
      const height=x===cols?0:heights[x]!;
      while(stack.length && heights[stack.at(-1)!]!>height){
        const index=stack.pop()!,h=heights[index]!,left=stack.length?stack.at(-1)!+1:0;
        const width=(x-left)*step,availableHeight=h*step;
        const scale=Math.min(1,width/desired.width,availableHeight/desired.height);
        const w=desired.width*scale,hh=desired.height*scale;
        if(w<minimum.width||hh<minimum.height)continue;
        const area={x:v.x+left*step,y:v.y+(y-h+1)*step,width:w,height:hh};
        if(preferred){area.x=Math.max(area.x,Math.min(preferred.x,area.x+width-w));area.y=Math.max(area.y,Math.min(preferred.y,area.y+availableHeight-hh));}
        const distance=preferred?Math.hypot(area.x-preferred.x,area.y-preferred.y):area.y-v.y;
        const score=scale*10000-distance;
        if(score>bestScore && safeDrawingRect(space,area)){best=area;bestScore=score;}
      }
      stack.push(x);
    }
  }
  return best;
}

/** Keep a response's relative geometry together. Never squash either axis, enlarge, or shrink labels below 12 CSS px. */
export function placeDrawingGroup(objects:readonly BoardObject[],matrix:BoardMatrix,space:DrawingSpace):BoardObject[]|null {
  if(!objects.length)return [];
  const bounds=rectUnion(objects.map(o=>objectClientBounds(o,matrix)));
  const maxScale=Math.min(1,640/Math.max(1,bounds.width),480/Math.max(1,bounds.height));
  const textMinimum=Math.max(.65,...objects.filter(o=>o.kind==='text').map(o=>12/Math.max(1,(o.textStyle?.size??16)*Math.hypot(matrix[2],matrix[3]))));
  if(textMinimum>maxScale)return null;
  if(maxScale===1 && safeDrawingRect(space,bounds))return objects.map(o=>structuredClone(o));
  const target=findDrawingRect(space,{width:Math.max(1,bounds.width)*maxScale,height:Math.max(1,bounds.height)*maxScale},
    {width:Math.max(1,bounds.width)*textMinimum,height:Math.max(1,bounds.height)*textMinimum},bounds);
  if(!target)return null;
  const scale=target.width/Math.max(1,bounds.width),inverse=invertBoardMatrix(matrix);
  const placed=objects.map(object=>{
    const p=transformBoardPoint(matrix,object),next=transformBoardPoint(inverse,{x:target.x+(p.x-bounds.x)*scale,y:target.y+(p.y-bounds.y)*scale});
    return {...structuredClone(object),...next,width:object.width*scale,height:object.height*scale,strokeWidth:object.strokeWidth*scale,
      ...(object.points?{points:object.points.map(p=>({...p,x:p.x*scale,y:p.y*scale}))}:{}),
      ...(object.textStyle?{textStyle:{...object.textStyle,size:object.textStyle.size*scale}}:{})};
  });
  return safeDrawingRect(space,rectUnion(placed.map(o=>objectClientBounds(o,matrix))))?placed:null;
}
