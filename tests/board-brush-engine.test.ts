import { describe, expect, it, vi } from "vitest";
import { brushEngineFor, missingBrushResources } from "../src/board-brush-engine.js";
import { defaultBoardBrush } from "../src/board-brushes.js";
import { studioBoardBrush } from "../src/board-brushes.js";
import { BoardDabStream, generateBrushDabs } from "../src/board-paint.js";

const hash = (character: string) => character.repeat(64);
const points = [{ x: 0, y: 0, pressure: 0.3, t: 0 }, { x: 12, y: 2, pressure: 0.9, t: 40 }];

function canvasHarness() {
  const drawImage = vi.fn(), createPattern = vi.fn(() => ({}));
  const document = {
    createElement: () => {
      const canvas = { width: 1, height: 1, ownerDocument: document, getContext: () => context };
      return canvas;
    },
  } as unknown as Document;
  const context = {
    canvas: { width: 100, height: 100, ownerDocument: document },
    globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000",
    save: vi.fn(), restore: vi.fn(), scale: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    drawImage, fillRect: vi.fn(), createPattern,
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  return { context, drawImage, createPattern };
}

describe("versioned brush engines", () => {
  it("keeps unversioned strokes on the original renderer", () => {
    const style = defaultBoardBrush("pencil", 7);
    expect(brushEngineFor(style).version).toBe(1);
    expect(missingBrushResources(style)).toEqual([]);
  });

  it("does not silently replace a missing resource with procedural dabs", () => {
    const style = { ...defaultBoardBrush("pencil", 7), engineVersion: 2 as const, tipHash: hash("a") };
    const { context, drawImage } = canvasHarness();
    expect(brushEngineFor(style).render(context, points, style, 12, "#334455")).toEqual({ drawn: false, missing: [hash("a")] });
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("uses a resource tip and board-anchored grain in the same rendering path", () => {
    const style = { ...defaultBoardBrush("pencil", 7), engineVersion: 2 as const, tipHash: hash("b"), grainHash: hash("c") };
    const { context, drawImage, createPattern } = canvasHarness();
    const source = { width: 2, height: 2 } as CanvasImageSource;
    const result = brushEngineFor(style).render(context, points, style, 12, "#334455", new Map([[hash("b"), source], [hash("c"), source]]), { x: 100, y: 40 });
    expect(result).toEqual({ drawn: true, missing: [] });
    expect(drawImage.mock.calls.length).toBeGreaterThan(1);
    expect(createPattern).toHaveBeenCalled();
  });

  it("interprets opaque black-on-white tips as masks while preserving alpha tips", () => {
    const style = { ...defaultBoardBrush("pen", 4), engineVersion: 2 as const, tipHash: hash("d") };
    const { context } = canvasHarness();
    const source = { width: 2, height: 1 } as CanvasImageSource;
    vi.spyOn(context, "getImageData").mockImplementation(() => ({
      data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
    } as ImageData));
    brushEngineFor(style).render(context, points, style, 4, "#123456", new Map([[hash("d"), source]]));
    const mask = vi.mocked(context.putImageData).mock.calls[0]![0];
    expect([...mask.data].filter((_, index) => index % 4 === 3)).toEqual([255, 0]);
  });

  it("streams v2 material dabs without changing their final deterministic geometry", () => {
    const track=Array.from({length:80},(_,index)=>({x:index*2,y:Math.sin(index/7)*9,pressure:.2+index/100,t:index*12}));
    for(const kind of ["pencil","chalk","crayon","watercolor","oil"] as const){
      const style=studioBoardBrush(kind,123),stream=new BoardDabStream(style,18);
      const live=[];
      for(let count=2;count<=track.length;count++)live.push(...stream.append(track.slice(0,count)));
      expect(live).toEqual(generateBrushDabs(track,style,18));
    }
  });
});
