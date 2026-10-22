import { invertBoardMatrix, multiplyBoardMatrices, transformBoardPoint, type BoardSurface } from "./board-surfaces.js";
import type { BoardMatrix, BoardPoint, BoardRect } from "./board-types.js";
import type { BoardSlotSpec } from "./board-layout.js";

export interface BoardProjection extends BoardSurface { projectionId:string; layoutRevision:number; clipRect():BoardRect; modelToSlot:BoardMatrix }

/** Geometry belongs to one synchronous draw/hit batch, never the next frame. */
export function captureBoardSurface(surface: BoardSurface): BoardSurface {
  const matrix = surface.toClient(), inverse = invertBoardMatrix(matrix), rect = surface.getClientRect();
  const captured = { ...surface, toClient: () => matrix, getClientRect: () => rect,
    project: (point: BoardPoint) => transformBoardPoint(matrix, point),
    unproject: (point: BoardPoint) => transformBoardPoint(inverse, point) };
  if ("clipRect" in surface) {
    const clip = (surface as BoardProjection).clipRect();
    return { ...captured, clipRect: () => clip } as BoardProjection;
  }
  return captured;
}

/** Reuse one measured slot for every attachment without changing object order. */
export function projectCapturedBoardSlot(slot: BoardProjection, modelToSlot: BoardMatrix): BoardProjection {
  const matrix = multiplyBoardMatrices(slot.toClient(), modelToSlot), inverse = invertBoardMatrix(matrix);
  return { ...slot, modelToSlot, toClient: () => matrix,
    project: point => transformBoardPoint(matrix, point), unproject: point => transformBoardPoint(inverse, point) };
}
export function createBoardSlotElement(doc:Document,spec:BoardSlotSpec):HTMLElement{
  const el=doc.createElement("div");el.className="atl-board-slot";el.dataset.boardSlot=spec.id;el.setAttribute("role","presentation");
  const inner=doc.createElement("div");inner.className="atl-board-slot-space";el.append(inner);updateBoardSlotElement(el,spec);return el;
}
export function updateBoardSlotElement(el:HTMLElement,spec:BoardSlotSpec):void{
  const inner=el.firstElementChild as HTMLElement;const height=`${spec.height}px`,width=`${spec.width}px`;
  if(inner.style.height!==height)inner.style.height=height;if(inner.style.width!==width)inner.style.width=width;
}
export function projectBoardSlot(base:BoardSurface,el:HTMLElement,modelToSlot:BoardMatrix,revision:number):BoardProjection{
  const inner=el.firstElementChild as HTMLElement;
  const toClient=():BoardMatrix=>{const r=inner.getBoundingClientRect();return multiplyBoardMatrices([r.width? r.width/(inner.offsetWidth||r.width):1,0,0,r.height? r.height/(inner.offsetHeight||r.height):1,r.x,r.y],modelToSlot);};
  return {...base,id:`${base.id}/${el.dataset.boardSlot}`,projectionId:el.dataset.boardSlot!,layoutRevision:revision,modelToSlot,
    getLayoutVersion:()=>`${base.getLayoutVersion?.()??""}:${revision}:${el.isConnected}:${el.scrollLeft}`,
    getClientRect:()=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:el.clientHeight||r.height};},
    clipRect:()=>{const r=el.getBoundingClientRect(),v=base.viewportElement.getBoundingClientRect();const x=Math.max(r.x,v.x),y=Math.max(r.y,v.y),right=Math.min(r.right,v.right),bottom=Math.min(r.top+(el.clientHeight||r.height),v.bottom);return {x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};},
    width:inner.offsetWidth||parseFloat(inner.style.width),height:inner.offsetHeight||parseFloat(inner.style.height),toClient,
    project:(p:BoardPoint)=>transformBoardPoint(toClient(),p),unproject:(p:BoardPoint)=>transformBoardPoint(invertBoardMatrix(toClient()),p)};
}

/** Reading placeholders only. CM owns and disposes its own block widgets. */
export class BoardSlotViews {
  private elements=new Map<string,HTMLElement>();
  private reading=false;
  private positions=new Map<string,number>();
  private listening=new WeakSet<HTMLElement>();
  private observe(el:HTMLElement):HTMLElement{
    if(!this.listening.has(el)){this.listening.add(el);el.scrollLeft=this.positions.get(el.dataset.boardSlot!)??0;
      el.addEventListener("scroll",()=>{this.positions.set(el.dataset.boardSlot!,el.scrollLeft);this.onScroll();},{passive:true});}
    return el;
  }
  constructor(private container:HTMLElement,private onScroll:()=>void){}
  sync(surfaces:readonly BoardSurface[],specs:readonly BoardSlotSpec[],editing:boolean):void{
    if(editing){if(this.reading)this.clear();this.reading=false;return;}
    this.reading=true;const used=new Set<string>(),last=new Map<string,HTMLElement>();
    const sources=new Map<string,BoardSurface>();
    for(const surface of surfaces)if(surface.anchor.kind==="markdown"&&!sources.has(surface.anchor.key))sources.set(surface.anchor.key,surface);
    for(const spec of specs){const source=sources.get(spec.anchorKey);if(!source?.element.isConnected)continue;
      const prior=last.get(spec.anchorKey)??source.element;let el=this.elements.get(spec.id);
      if(!el){el=createBoardSlotElement(this.container.ownerDocument,spec);this.observe(el);this.elements.set(spec.id,el);}else updateBoardSlotElement(el,spec);
      if(prior.nextElementSibling!==el)prior.after(el);last.set(spec.anchorKey,el);used.add(spec.id);}
    for(const [id,el]of this.elements)if(!used.has(id)){el.remove();this.elements.delete(id);}
  }
  /** One lookup table per synchronous frame; CM widgets remain owned by CM. */
  captureElements():ReadonlyMap<string,HTMLElement>{
    const elements=this.reading?this.elements.values():this.container.querySelectorAll<HTMLElement>(".atl-board-slot");
    const found=new Map<string,HTMLElement>();
    for(const element of elements){const id=element.dataset.boardSlot;if(id&&element.isConnected&&!found.has(id))found.set(id,this.observe(element));}
    return found;
  }
  get(id:string):HTMLElement|undefined{const el=this.reading?this.elements.get(id):[...this.container.querySelectorAll<HTMLElement>(".atl-board-slot")].find(el=>el.dataset.boardSlot===id);return el&&this.observe(el);}
  clear():void{for(const el of this.elements.values())el.remove();this.elements.clear();}
}

/** One stroke uses one inverse mapping even if media finish loading mid-stroke. */
export function freezeBoardProjection(surface:BoardSurface):BoardSurface {
  if(!("projectionId" in surface))return surface;
  const matrix=surface.toClient(),inverse=invertBoardMatrix(matrix);
  return {...surface,toClient:()=>matrix,project:p=>transformBoardPoint(matrix,p),unproject:p=>transformBoardPoint(inverse,p)};
}
