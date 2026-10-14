import { BoardDabStream, generateBrushDabs, renderBrushDabs } from "./board-paint.js";
import { applyBrushTextureMask, brushEngineFor, brushNeedsRaster, missingBrushResources, renderRawBrushDabs, type BrushResources } from "./board-brush-engine.js";
import type { BoardBrushStyle, BoardPoint } from "./board-types.js";

export class LiveBrushPainter {
  private key="";
  private canvas?:HTMLCanvasElement;
  private display?:HTMLCanvasElement;
  private stream?:BoardDabStream;
  private count=0;
  private bounds={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
  clear():void{this.key="";this.canvas=undefined;this.display=undefined;this.stream=undefined;this.count=0;this.bounds={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};}
  dispose():void{for(const canvas of [this.canvas,this.display])if(canvas){canvas.width=0;canvas.height=0;}this.clear();}
  render(context:CanvasRenderingContext2D,points:readonly BoardPoint[],style:BoardBrushStyle,size:number,color:string,resources?:BrushResources):boolean{
    if(missingBrushResources(style,resources).length)return false;
    // Sumi's final pooling depends on total stroke length, so it cannot use the
    // append-only dab stream. Other materials never regenerate earlier dabs.
    if(brushNeedsRaster(style)&&style.kind==="sumi"){
      const result=brushEngineFor(style).render(context,points,style,size,color,resources);
      return result.drawn;
    }
    if(!brushNeedsRaster(style)&&!["watercolor","oil","crayon","chalk","pencil"].includes(style.kind))return false;
    if(!context.canvas?.ownerDocument||!context.getTransform)return false;
    const m=context.getTransform(),width=context.canvas.width,height=context.canvas.height,key=JSON.stringify([style,size,color,width,height,m.a,m.b,m.c,m.d,m.e,m.f]);
    if(key!==this.key||points.length<this.count){this.clear();this.key=key;this.canvas=context.canvas.ownerDocument.createElement("canvas");this.canvas.width=width;this.canvas.height=height;this.stream=new BoardDabStream(style,size);}
    const target=this.canvas!.getContext("2d");if(!target)return false;
    const hadSamples=this.stream!.hasSamples,dabs=this.stream!.append(points);
    if(!hadSamples){target.setTransform(1,0,0,1,0,0);target.clearRect(0,0,width,height);}
    target.setTransform(m);
    const next=this.stream!.hasSamples?dabs:generateBrushDabs(points,style,size);
    if(brushNeedsRaster(style))renderRawBrushDabs(target,next,style,color,resources);
    else renderBrushDabs(target,next,color);
    this.count=points.length;
    // The raw ink is append-only, but compositing a viewport-sized preview on
    // every pointer event made a small stroke scale with the window's DPR/area.
    // Track the actual dab footprint and copy only that rectangle.
    const dirty={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
    for(const dab of next){
      const x=m.a*dab.x+m.c*dab.y+m.e,y=m.b*dab.x+m.d*dab.y+m.f;
      const cos=Math.cos(dab.rotation),sin=Math.sin(dab.rotation);
      const dx=Math.hypot((m.a*cos+m.c*sin)*dab.radiusX,(-m.a*sin+m.c*cos)*dab.radiusY)+4;
      const dy=Math.hypot((m.b*cos+m.d*sin)*dab.radiusX,(-m.b*sin+m.d*cos)*dab.radiusY)+4;
      dirty.left=Math.min(dirty.left,x-dx);dirty.top=Math.min(dirty.top,y-dy);
      dirty.right=Math.max(dirty.right,x+dx);dirty.bottom=Math.max(dirty.bottom,y+dy);
      this.bounds.left=Math.min(this.bounds.left,x-dx);this.bounds.top=Math.min(this.bounds.top,y-dy);
      this.bounds.right=Math.max(this.bounds.right,x+dx);this.bounds.bottom=Math.max(this.bounds.bottom,y+dy);
    }
    if(!Number.isFinite(this.bounds.left))return false;
    const left=Math.max(0,Math.floor(this.bounds.left)),top=Math.max(0,Math.floor(this.bounds.top));
    const right=Math.min(width,Math.ceil(this.bounds.right)),bottom=Math.min(height,Math.ceil(this.bounds.bottom));
    if(right<=left||bottom<=top)return true;
    const cropWidth=right-left,cropHeight=bottom-top;
    let output=this.canvas!,outputX=left,outputY=top;
    if(brushNeedsRaster(style)){
      const display=this.display??(this.display=context.canvas.ownerDocument.createElement("canvas"));
      // Keep one display surface for the gesture. Reallocating the growing
      // footprint and texturing its entire area on every sample was quadratic.
      if(display.width!==width||display.height!==height){display.width=width;display.height=height;}
      const paint=display.getContext("2d");if(!paint)return false;
      const dl=Math.max(0,Math.floor(dirty.left)),dt=Math.max(0,Math.floor(dirty.top));
      const dr=Math.min(width,Math.ceil(dirty.right)),db=Math.min(height,Math.ceil(dirty.bottom));
      paint.setTransform(1,0,0,1,0,0);
      if(!hadSamples)paint.clearRect(0,0,width,height);
      if(dr>dl&&db>dt){
        paint.save();paint.beginPath();paint.rect(dl,dt,dr-dl,db-dt);paint.clip();
        paint.clearRect(dl,dt,dr-dl,db-dt);
        paint.drawImage(this.canvas!,dl,dt,dr-dl,db-dt,dl,dt,dr-dl,db-dt);
        try{
          const inverse=m.inverse(),corners=[{x:dl,y:dt},{x:dr,y:dt},{x:dl,y:db},{x:dr,y:db}].map(point=>inverse.transformPoint(point));
          const minX=Math.min(...corners.map(point=>point.x)),maxX=Math.max(...corners.map(point=>point.x));
          const minY=Math.min(...corners.map(point=>point.y)),maxY=Math.max(...corners.map(point=>point.y));
          paint.setTransform(m);
          applyBrushTextureMask(paint,style,resources,{x:minX,y:minY,width:maxX-minX,height:maxY-minY});
        }catch{paint.restore();return false;}
        paint.restore();
      }
      output=display;

    }
    context.save();context.setTransform(1,0,0,1,0,0);
    context.drawImage(output,outputX,outputY,cropWidth,cropHeight,left,top,cropWidth,cropHeight);
    context.restore();return true;
  }
}
