import type { BoardDocument, BoardLayer, BoardObject } from "./board-types.js";

/** Only scenes whose layer compositing is independent can be revealed incrementally.
 * Group opacity, clipping and paint checkpoints stay on the exact compositor path. */
export function planProgressiveScene(document: BoardDocument, visibleObjects: readonly BoardObject[], threshold = 150): Array<{layer: BoardLayer; objects: BoardObject[]}> | null {
  if (visibleObjects.length < threshold || document.paintOperations?.length) return null;
  const layers = document.layers?.length ? document.layers : [{
    id: "layer-default", name: "Default", order: 0, visible: true, locked: false, opacity: 1, blendMode: "normal" as const,
  }];
  if (layers.some(layer => layer.visible && (layer.kind === "group" || layer.kind === "paint" || layer.parentId ||
    layer.clippedToBelow || layer.alphaLocked || layer.opacity !== 1 || layer.blendMode !== "normal"))) return null;
  const ordered = layers.filter(layer => layer.visible).sort((a, b) => a.order - b.order);
  const byLayer = new Map(ordered.map(layer => [layer.id, [] as BoardObject[]]));
  for (const object of visibleObjects) {
    if (!["ink", "path", "arrow", "rect", "ellipse"].includes(object.kind) || object.fill?.kind === "brush") return null;
    const target = byLayer.get(object.layerId ?? layers[0]!.id);
    if (!target) return null;
    target.push(object);
  }
  return ordered.map(layer => ({layer, objects: byLayer.get(layer.id)!}));
}
