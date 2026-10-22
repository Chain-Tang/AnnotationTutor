import { describe, expect, it, vi } from "vitest";
import { LiveBrushPainter } from "../src/board-live-paint.js";
import { studioBoardBrush } from "../src/board-brushes.js";

describe("live material preview", () => {
  it("composites only the growing dab footprint instead of the whole viewport", () => {
    const made: HTMLCanvasElement[]=[];
    const document = {
      createElement: () => {const canvas=makeCanvas(1, 1);made.push(canvas);return canvas;},
    } as unknown as Document;
    const makeCanvas = (width: number, height: number) => {
      const canvas = { width, height, ownerDocument: document } as HTMLCanvasElement;
      const context = {
        canvas, globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000",
        save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
        setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(),
        beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), ellipse: vi.fn(), fill: vi.fn(), createPattern: vi.fn(() => ({})),
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
      canvas.getContext = vi.fn(() => context) as unknown as typeof canvas.getContext;
      return canvas;
    };
    const main = makeCanvas(2400, 1600);
    const context = main.getContext("2d")!;
    const transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
      inverse: () => ({ transformPoint: (point: { x: number; y: number }) => point }) };
    context.getTransform = vi.fn(() => transform as DOMMatrix) as typeof context.getTransform;
    const painter = new LiveBrushPainter();
    const style = studioBoardBrush("crayon", 11);
    const points = [{ x: 100, y: 100, pressure: 0.6, t: 0 }, { x: 125, y: 105, pressure: 0.8, t: 16 }];
    expect(painter.render(context, points, style, 18, "#304060")).toBe(true);
    const draw = vi.mocked(context.drawImage).mock.lastCall!;
    expect(draw[3]).toBeLessThan(100);
    expect(draw[4]).toBeLessThan(100);
    expect(draw[7]).toBeLessThan(100);
    expect(draw[8]).toBeLessThan(100);
    for(let i=0;i<100;i++){points.push({x:130+i*8,y:105,pressure:.8,t:32+i*16});painter.render(context,points,style,18,"#304060");}
    // No reallocation as the stroke grows, and masking updates only new samples.
    const display=made[1]!;expect(display.width).toBe(2400);expect(display.height).toBe(1600);
    const dirty=vi.mocked(display.getContext("2d")!.clearRect).mock.lastCall!;
    expect(dirty[2]).toBeLessThan(120);expect(dirty[3]).toBeLessThan(120);

  });
});
