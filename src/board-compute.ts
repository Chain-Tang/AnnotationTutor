import { classifyBoardStroke } from "./board-semantics.js";
import type { BoardBrushKind, BoardObject, BoardPoint, BoardSemanticKind, InkStroke } from "./board-types.js";

export type BoardComputeRequest = {
  id: string;
  points: BoardPoint[];
  width: number;
  height: number;
  brushKind?: BoardBrushKind;
};
export type BoardComputeResult = {
  id: string;
  simplified: BoardPoint[];
  kind: BoardSemanticKind;
  confidence: number;
};
export type BoardWorkerMessage = { type: "derive"; request: BoardComputeRequest };
export type BoardWorkerResponse = { type: "derived"; result: BoardComputeResult } | { type: "error"; id: string; error: string };

function simplify(points: readonly BoardPoint[], tolerance = 0.65): BoardPoint[] {
  if (points.length <= 2) return [...points];
  const output: BoardPoint[] = [points[0]!];
  let last = points[0]!;
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index]!;
    if (Math.hypot(point.x - last.x, point.y - last.y) >= tolerance) {
      output.push(point); last = point;
    }
  }
  output.push(points.at(-1)!);
  return output;
}

function fallback(request: BoardComputeRequest): BoardComputeResult {
  const object = {
    id: request.id, kind: "ink", anchor: { kind: "canvas", pageId: "compute" },
    x: 0, y: 0, width: request.width, height: request.height, color: "#000000", strokeWidth: 1,
    ...(request.brushKind ? { brush: { kind: request.brushKind, opacity: 1, pressure: true, smoothing: 0.5, streamline: 0.5, seed: 1 } } : {}),
    inkId: request.id, createdBy: "human", editedBy: "human", revision: 1, groupId: "compute",
  } satisfies BoardObject;
  const stroke = { id: request.id, points: request.points, createdAt: new Date(0).toISOString() } satisfies InkStroke;
  const classification = classifyBoardStroke(object, stroke);
  return { id: request.id, simplified: simplify(request.points), ...classification };
}

const WORKER_SOURCE = `
self.onmessage = function(event) {
  const r = event.data.request, p = r.points || [], out = [];
  if (p.length) { out.push(p[0]); let last = p[0]; for (let i=1;i<p.length-1;i++) { const q=p[i]; if (Math.hypot(q.x-last.x,q.y-last.y)>=.65) { out.push(q); last=q; } } if (p.length>1) out.push(p[p.length-1]); }
  let length=0; for(let i=1;i<p.length;i++) length+=Math.hypot(p[i].x-p[i-1].x,p[i].y-p[i-1].y);
  const chord=p.length>1?Math.hypot(p[p.length-1].x-p[0].x,p[p.length-1].y-p[0].y):0;
  const straight=chord/Math.max(1,length), aspect=Math.max(r.width,r.height)/Math.max(1,Math.min(r.width,r.height));
  let kind='unknown', confidence=.3;
  if(straight>.965&&length>10){ kind=r.brushKind==='highlighter'?'highlight':r.width>r.height*3?'underline':'line'; confidence=Math.min(.96,straight); }
  else if(chord/Math.max(1,Math.hypot(r.width,r.height))<.22&&p.length>=8&&aspect<4){kind=aspect<1.35?'circle':'ellipse';confidence=.72;}
  else if(Math.hypot(r.width,r.height)<220&&length<900){kind='handwriting';confidence=.58;}
  self.postMessage({type:'derived',result:{id:r.id,simplified:out,kind,confidence}});
};`;

/** Worker-first geometry pipeline with a yielded main-thread fallback. */
export class BoardComputeService {
  private worker: Worker | null = null;
  private url = "";
  private readonly pending = new Map<string, { resolve: (value: BoardComputeResult) => void; reject: (error: unknown) => void }>();
  public constructor() {
    try {
      if (typeof Worker !== "undefined" && typeof Blob !== "undefined") {
        this.url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
        this.worker = new Worker(this.url);
        this.worker.onmessage = (event: MessageEvent<BoardWorkerResponse>) => {
          const id = event.data.type === "derived" ? event.data.result.id : event.data.id;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          event.data.type === "derived" ? pending.resolve(event.data.result) : pending.reject(new Error(event.data.error));
        };
        this.worker.onerror = () => { this.worker?.terminate(); this.worker = null; };
      }
    } catch { this.worker = null; }
  }
  public derive(request: BoardComputeRequest): Promise<BoardComputeResult> {
    if (!this.worker)
      return new Promise((resolve) => setTimeout(() => resolve(fallback(request)), 0));
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker!.postMessage({ type: "derive", request } satisfies BoardWorkerMessage);
    });
  }
  public dispose(): void {
    this.worker?.terminate();
    if (this.url) URL.revokeObjectURL(this.url);
    for (const pending of this.pending.values()) pending.reject(new Error("board-compute-disposed"));
    this.pending.clear();
  }
}
