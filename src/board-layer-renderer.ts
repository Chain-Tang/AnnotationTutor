import type { BoardLayer } from "./board-types.js";

/** A normal, opaque top layer can be previewed over the already composed scene.
 * Anything requiring isolation (erase, clipping, alpha lock, groups or blending)
 * must continue through the layer compositor. */
export function canPreviewOnStaticScene(layers: readonly BoardLayer[], activeLayerId: string, erasing = false): boolean {
  if (erasing) return false;
  const visible = layers.filter(layer => layer.visible && !layer.parentId).sort((a, b) => a.order - b.order);
  const top = visible.at(-1);
  return !!top && top.id === activeLayerId && top.kind !== "group" && !top.alphaLocked &&
    !top.clippedToBelow && top.blendMode === "normal" && top.opacity === 1;
}

/** Isolated layers and groups: erase stays local; group opacity is applied once. */
export class StudioLayerRenderer {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private cameraKey = "";
  private overlayCanvas?: HTMLCanvasElement;
  private scratchCanvas?: HTMLCanvasElement;
  clear(): void { this.cache.clear(); this.cameraKey = ""; this.overlayCanvas = undefined; }
  /** Scene teardown also releases pooled surfaces; ordinary redraws keep pooling. */
  dispose(): void {
    for (const canvas of new Set([...this.cache.values(), this.overlayCanvas, this.scratchCanvas]))
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    this.clear(); this.scratchCanvas = undefined;
  }

  render(context: CanvasRenderingContext2D, layers: readonly BoardLayer[], revision: string | ((layer: BoardLayer) => string),
    draw: (target: CanvasRenderingContext2D, layer: BoardLayer) => void,
    only?: ReadonlySet<string>, overlay?: { layerId: string; clip?:{x:number;y:number;width:number;height:number}; draw: (context: CanvasRenderingContext2D) => void },
    canDrawDirect?: (layer: BoardLayer) => boolean): void {
    const width = context.canvas.width, height = context.canvas.height, matrix = context.getTransform();
    const cameraKey = `${width}:${height}:${matrix.a}:${matrix.b}:${matrix.c}:${matrix.d}:${matrix.e}:${matrix.f}`;
    if (cameraKey !== this.cameraKey) {
      // A full-viewport raster from a different camera almost never matches
      // another pan position. Retaining many such canvases caused large GC
      // pauses during long drawing sessions.
      this.cache.clear();
      this.cameraKey = cameraKey;
    }
    const map = new Map(layers.map(layer => [layer.id, layer]));
    const children = new Map<string | undefined, BoardLayer[]>();
    // Isolating every ordinary layer in a viewport-sized canvas makes a
    // 20-layer drawing allocate and composite tens of megapixels per camera
    // stop. Direct drawing is equivalent for fully opaque vector layers with
    // normal blending and no clipping or live overlay.
    const directOrdinaryLayers = !only && !overlay && !!canDrawDirect &&
      layers.filter(layer => layer.visible && layer.kind === "vector").length >= 8;
    const reuseIsolationCanvas = !only && !overlay && layers.filter(layer => layer.visible && layer.kind !== "group").length >= 8;
    const liveAncestors = new Set<string>();
    for (const layer of layers) {
      const seen = new Set<string>(); let current: BoardLayer | undefined = layer;
      while (current) {
        if (seen.has(current.id)) throw new Error("layer-cycle");
        seen.add(current.id);
        if (layer.id === overlay?.layerId) liveAncestors.add(current.id);
        current = current.parentId ? map.get(current.parentId) : undefined;
      }
      const parent = layer.parentId && map.get(layer.parentId)?.kind === "group" ? layer.parentId : undefined;
      const siblings = children.get(parent) ?? []; siblings.push(layer); children.set(parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order);
    const revisionFor = (layer: BoardLayer): string => {
      const own = typeof revision === "string" ? revision : revision(layer);
      if (layer.kind !== "group") return own;
      return JSON.stringify([own, (children.get(layer.id) ?? []).map(child =>
        [child.id, child.order, child.visible, child.opacity, child.blendMode, child.clippedToBelow, revisionFor(child)])]);
    };
    const create = () => {
      const canvas = context.canvas.ownerDocument.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
    };
    const compose = (target: CanvasRenderingContext2D, parent?: string, includeAll = !only): void => {
      let below: HTMLCanvasElement | undefined;
      const siblings = children.get(parent) ?? [];
      for (let index = 0; index < siblings.length; index++) {
        const layer = siblings[index]!;
        if (!layer.visible) continue;
        let nextVisible: BoardLayer | undefined;
        for (let next = index + 1; next < siblings.length; next++) {
          if (siblings[next]!.visible) { nextVisible = siblings[next]; break; }
        }
        if (directOrdinaryLayers && canDrawDirect?.(layer) && layer.kind === "vector" && layer.opacity === 1 &&
          layer.blendMode === "normal" && !layer.alphaLocked && !layer.clippedToBelow &&
          !nextVisible?.clippedToBelow) {
          target.save();
          target.setTransform(matrix);
          draw(target, layer);
          target.restore();
          below = undefined;
          continue;
        }
        if (reuseIsolationCanvas && parent === undefined && layer.kind !== "group" &&
          layer.opacity === 1 && layer.blendMode === "normal" && !layer.clippedToBelow &&
          !nextVisible?.clippedToBelow) {
          let scratch = this.scratchCanvas;
          if (!scratch) scratch = this.scratchCanvas = create();
          if (scratch.width !== width || scratch.height !== height) { scratch.width = width; scratch.height = height; }
          const paint = scratch.getContext("2d"); if (!paint) throw new Error("Canvas unavailable");
          paint.setTransform(1, 0, 0, 1, 0, 0);
          paint.globalAlpha = 1;
          paint.globalCompositeOperation = "source-over";
          paint.clearRect(0, 0, width, height);
          paint.setTransform(matrix);
          draw(paint, layer);
          target.save();
          target.setTransform(1, 0, 0, 1, 0, 0);
          target.drawImage(scratch, 0, 0);
          target.restore();
          below = undefined;
          continue;
        }
        // Mask layers still render when not exported, so clipping cannot leak.
        const key = JSON.stringify([revisionFor(layer), layer.id, width, height, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f, only ? [...only].sort() : null]);
        const liveGroup = layer.kind === "group" && liveAncestors.has(layer.id);
        let canvas = liveGroup ? undefined : this.cache.get(key);
        if (!canvas) {
          canvas = create(); const paint = canvas.getContext("2d"); if (!paint) throw new Error("Canvas unavailable");
          if (layer.kind === "group") compose(paint, layer.id,includeAll||!!only?.has(layer.id));
          else { paint.setTransform(matrix); draw(paint, layer); }
          if (!liveGroup) this.cache.set(key, canvas);
        }
        if (overlay?.layerId === layer.id) {
          const draft = this.overlayCanvas ?? (this.overlayCanvas = create());
          if (draft.width !== width || draft.height !== height) { draft.width = width; draft.height = height; }
          const paint = draft.getContext("2d")!; paint.setTransform(1, 0, 0, 1, 0, 0);
          paint.globalCompositeOperation = "source-over"; paint.globalAlpha = 1;
          paint.clearRect(0, 0, width, height);paint.save();
          if(overlay.clip){paint.setTransform(matrix);const r=overlay.clip;paint.beginPath();paint.rect(r.x,r.y,r.width,r.height);paint.clip();paint.setTransform(1,0,0,1,0,0);}
          paint.drawImage(canvas, 0, 0);
          paint.setTransform(matrix); overlay.draw(paint); paint.restore(); canvas = draft;
        }
        let composited = canvas;
        if (layer.clippedToBelow) {
          if (!below) continue;
          composited = create(); const paint = composited.getContext("2d")!;
          paint.drawImage(canvas, 0, 0); paint.globalCompositeOperation = "destination-in"; paint.drawImage(below, 0, 0);
        }
        if (includeAll || only?.has(layer.id) || layer.kind === "group") {
          target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha *= layer.opacity;
          target.globalCompositeOperation = layer.blendMode === "normal" ? "source-over" : layer.blendMode;
          target.drawImage(composited, 0, 0); target.restore();
        }
        below = composited;
      }
    };
    compose(context);
    let pixels = [...this.cache.values()].reduce((total, canvas) => total + canvas.width * canvas.height, 0);
    while (this.cache.size > 24 || pixels > 32_000_000) {
      const key = this.cache.keys().next().value; if (!key) break;
      const canvas = this.cache.get(key)!; pixels -= canvas.width * canvas.height; this.cache.delete(key);
    }
  }
}
