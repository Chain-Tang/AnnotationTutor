import { describe, expect, it } from "vitest";
import { BOARD_BRUSH_DEFAULT_WIDTHS, boardBrushSizePresets, brushSizeFromSlider, paintBoardBrushPreview, sliderFromBrushSize } from "../src/board-brush-ui.js";
import { BOARD_BRUSHES } from "../src/board-brushes.js";

describe("professional brush size controls", () => {
  it("round-trips the nonlinear slider and gives more travel to small sizes", () => {
    for (const value of [1, 2, 4, 16, 64, 200]) {
      const roundTrip = brushSizeFromSlider(sliderFromBrushSize(value, 1, 200), 1, 200);
      expect(roundTrip).toBeCloseTo(value, 0);
    }
    expect(brushSizeFromSlider(0.5, 1, 200)).toBeLessThan(30);
  });

  it("defines five material-aware presets and a recommended size for all built-in brushes", () => {
    expect(BOARD_BRUSHES).toContain("crayon");
    for (const kind of BOARD_BRUSHES) {
      expect(boardBrushSizePresets(kind, 200)).toHaveLength(5);
      expect(BOARD_BRUSH_DEFAULT_WIDTHS[kind]).toBeGreaterThanOrEqual(1);
    }
    expect(boardBrushSizePresets("oil", 64).at(-1)).toBe(64);
    expect(BOARD_BRUSH_DEFAULT_WIDTHS.sumi).toBe(18);
    expect(BOARD_BRUSH_DEFAULT_WIDTHS.oil).toBe(32);
  });

  it("renders a material preview with the selected stroke colour", () => {
    const fills: string[] = [];
    const context = new Proxy({ globalAlpha: 1 } as unknown as CanvasRenderingContext2D, {
      get: (target, key) => Reflect.get(target, key) ?? (() => {}),
      set: (target, key, value) => {
        if (key === "fillStyle") fills.push(String(value));
        return Reflect.set(target, key, value);
      },
    });
    const canvas = {
      clientWidth: 180,
      clientHeight: 52,
      ownerDocument: { defaultView: { devicePixelRatio: 1 } },
      getContext: () => context,
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    paintBoardBrushPreview(canvas, "oil", 32, "#127a48");
    expect(fills).toContain("#127a48");
  });
});
