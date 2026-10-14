import { describe, expect, it } from "vitest";
import { StudioLayerRenderer, canPreviewOnStaticScene } from "../src/board-layer-renderer.js";
import type { BoardLayer } from "../src/board-types.js";

const layer = (id: string, order: number, overrides: Partial<BoardLayer> = {}): BoardLayer => ({
  id, name: id, order, visible: true, locked: false, opacity: 1,
  blendMode: "normal", kind: "vector", ...overrides,
});

function fakeCanvas(): HTMLCanvasElement {
  const ownerDocument = { createElement: () => fakeCanvas() };
  const canvas = { width: 800, height: 600, ownerDocument } as unknown as HTMLCanvasElement;
  const context = {
    canvas, globalAlpha: 1, globalCompositeOperation: "source-over",
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    setTransform: () => {}, save: () => {}, restore: () => {}, drawImage: () => {}, clearRect: () => {},
  } as unknown as CanvasRenderingContext2D;
  canvas.getContext = (() => context) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

describe("Studio layer preview and cache", () => {
  it("uses direct preview only for an opaque, ordinary top-level layer", () => {
    const layers = [layer("bottom", 0), layer("top", 1)];
    expect(canPreviewOnStaticScene(layers, "top")).toBe(true);
    expect(canPreviewOnStaticScene(layers, "bottom")).toBe(false);
    expect(canPreviewOnStaticScene(layers, "top", true)).toBe(false);
    for (const variant of [
      { opacity: 0.5 }, { blendMode: "multiply" as const },
      { alphaLocked: true }, { clippedToBelow: true }, { kind: "group" as const },
      { parentId: "bottom" }, { visible: false },
    ]) expect(canPreviewOnStaticScene([layers[0]!, layer("top", 1, variant)], "top")).toBe(false);
  });

  it("keeps an unchanged layer raster when another layer changes", () => {
    const renderer = new StudioLayerRenderer();
    const context = fakeCanvas().getContext("2d")!;
    const layers = [layer("bottom", 0), layer("top", 1)];
    const versions = new Map([["bottom", "a"], ["top", "a"]]);
    const painted: string[] = [];
    const draw = (_target: CanvasRenderingContext2D, item: BoardLayer) => { painted.push(item.id); };
    renderer.render(context, layers, item => versions.get(item.id)!, draw);
    expect(painted).toEqual(["bottom", "top"]);
    renderer.render(context, layers, item => versions.get(item.id)!, draw);
    expect(painted).toEqual(["bottom", "top"]);
    versions.set("top", "b");
    renderer.render(context, layers, item => versions.get(item.id)!, draw);
    expect(painted).toEqual(["bottom", "top", "top"]);
    context.getTransform = (() => ({ a: 1, b: 0, c: 0, d: 1, e: 20, f: 0 })) as CanvasRenderingContext2D["getTransform"];
    renderer.render(context, layers, item => versions.get(item.id)!, draw);
    expect(painted).toEqual(["bottom", "top", "top", "bottom", "top"]);
  });

  it("draws many ordinary vector layers directly without full-viewport layer canvases", () => {
    const renderer = new StudioLayerRenderer();
    const context = fakeCanvas().getContext("2d")!;
    const layers = Array.from({ length: 20 }, (_, index) => layer(`layer-${index}`, index));
    const doc = context.canvas.ownerDocument;
    let allocations = 0;
    doc.createElement = ((...args: Parameters<Document["createElement"]>) => {
      allocations++;
      return fakeCanvas() as ReturnType<Document["createElement"]>;
    }) as Document["createElement"];
    const painted: string[] = [];
    renderer.render(context, layers, "revision-1", (_target, item) => painted.push(item.id), undefined, undefined, () => true);
    expect(painted).toEqual(layers.map(item => item.id));
    expect(allocations).toBe(0);
  });

  it("retains isolation for alpha lock and clipping in a dense layer stack", () => {
    const renderer = new StudioLayerRenderer();
    const context = fakeCanvas().getContext("2d")!;
    const layers = Array.from({ length: 20 }, (_, index) => layer(`layer-${index}`, index));
    layers[4]!.alphaLocked = true;
    layers[9]!.clippedToBelow = true;
    let allocations = 0;
    context.canvas.ownerDocument.createElement = (() => { allocations++; return fakeCanvas(); }) as Document["createElement"];
    renderer.render(context, layers, "revision-1", () => {}, undefined, undefined, () => true);
    expect(allocations).toBeGreaterThanOrEqual(3);
  });

  it("requires the scene to certify direct compositing safety", () => {
    const renderer = new StudioLayerRenderer();
    const context = fakeCanvas().getContext("2d")!;
    const layers = Array.from({ length: 8 }, (_, index) => layer(`layer-${index}`, index));
    let allocations = 0;
    context.canvas.ownerDocument.createElement = (() => { allocations++; return fakeCanvas(); }) as Document["createElement"];
    renderer.render(context, layers, "revision-1", () => {}, undefined, undefined, item => item.id !== "layer-2");
    expect(allocations).toBe(1);
  });
});
