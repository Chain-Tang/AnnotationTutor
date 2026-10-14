import { brushNeedsRaster } from "./board-brush-engine.js";
import { boardOutlineWorkerSource } from "./board-outline-worker-source.js";
import type { PackedPressureStroke } from "./board-pressure-geometry.js";
import type { BoardInk, BoardObject } from "./board-types.js";

type Environment = Pick<typeof globalThis, "Worker" | "Blob" | "URL">;
export function canPreparePressureOutline(object: BoardObject, ink: BoardInk): boolean {
  return object.kind === "ink" && !!object.inkId && (ink[object.inkId]?.points.length ?? 0) > 1 &&
    !object.erasedRanges?.length && !!object.brush && !brushNeedsRaster(object.brush) &&
    object.brush.kind === "pen";
}

/** Bounded, transferable cold geometry. Worker failure preserves the legacy
 * renderer; cancellation discards derived data and never edits the document. */
export class BoardOutlinePreparation {
  private worker: Worker | null = null;
  private url = "";
  private serial = 0;
  private failed = false;
  private pending: { id: number; expected: Map<string, number>; timer: ReturnType<typeof setTimeout>;
    resolve: (result: ReadonlyMap<string, Float64Array> | null) => void } | null = null;
  constructor(private readonly environment: Environment = globalThis,
    private readonly source = boardOutlineWorkerSource, private readonly timeoutMs = 3000) {}
  get available(): boolean { return !this.failed && !!this.source && typeof this.environment.Worker === "function"; }
  private start(): boolean {
    if (this.worker) return true;
    if (!this.available) return false;
    try {
      this.url = this.environment.URL.createObjectURL(new this.environment.Blob([this.source], { type: "text/javascript" }));
      const worker = this.worker = new this.environment.Worker(this.url);
      worker.onmessage = event => {
        if (this.worker !== worker) return;
        const pending = this.pending;
        if (!pending || event.data?.id !== pending.id) return;
        const result = new Map<string, Float64Array>();
        try {
          if (!Array.isArray(event.data.outlines) || event.data.outlines.length !== pending.expected.size) throw Error("outline-result");
          for (const outline of event.data.outlines) {
            const count = pending.expected.get(outline.id);
            if (count === undefined || result.has(outline.id) || !ArrayBuffer.isView(outline.points) ||
              Object.prototype.toString.call(outline.points) !== "[object Float64Array]" ||
              outline.points.length % 2 || outline.points.length > count * 60 + 100 ||
              !outline.points.every(Number.isFinite)) throw Error("outline-result");
            result.set(outline.id, outline.points);
          }
        } catch { this.fail(); return; }
        clearTimeout(pending.timer); this.pending = null; pending.resolve(result);
      };
      worker.onerror = () => { if (this.worker === worker) this.fail(); };
      return true;
    } catch { this.fail(); return false; }
  }
  async prepare(objects: readonly BoardObject[], ink: BoardInk): Promise<ReadonlyMap<string, Float64Array> | null> {
    if (objects.length > 128 || this.pending || !this.start()) return null;
    const strokes: PackedPressureStroke[] = [], expected = new Map<string, number>();
    let total = 0;
    for (const object of objects) {
      if (!canPreparePressureOutline(object, ink)) continue;
      const points = ink[object.inkId!]!.points;
      if (total + points.length > 64_000 || expected.has(object.id)) continue;
      total += points.length;
      const samples = new Float64Array(points.length * 3);
      for (let i = 0; i < points.length; i++) {
        samples[i * 3] = points[i]!.x; samples[i * 3 + 1] = points[i]!.y;
        samples[i * 3 + 2] = points[i]!.pressure ?? NaN;
      }
      strokes.push({ id: object.id, samples, width: object.width, height: object.height,
        strokeWidth: object.strokeWidth, brush: { ...object.brush! } });
      expected.set(object.id, points.length);
    }
    if (!strokes.length) return new Map();
    return new Promise(resolve => {
      const id = ++this.serial;
      const timer = setTimeout(() => this.fail(), this.timeoutMs);
      this.pending = { id, expected, timer, resolve };
      try { this.worker!.postMessage({ id, strokes }, strokes.map(stroke => stroke.samples.buffer)); }
      catch { this.fail(); }
    });
  }
  private release(): void {
    this.worker?.terminate(); this.worker = null;
    if (this.url) this.environment.URL.revokeObjectURL(this.url);
    this.url = "";
  }
  private fail(): void { this.failed = true; this.cancel(); this.release(); }
  cancel(): void {
    if (!this.pending) return;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
    this.release(); pending.resolve(null);
  }
  dispose(): void { this.failed = true; this.cancel(); this.release(); }
}
