import { describe, expect, it } from "vitest";
import { boardCameraPreviewTransform } from "../src/board-camera-preview.js";

describe("infinite canvas camera preview", () => {
  it("translates the existing viewport without rerendering its objects", () => {
    expect(boardCameraPreviewTransform({ pan: { x: 80, y: 40 }, zoom: 1 }, { pan: { x: 92, y: 34 }, zoom: 1 }))
      .toBe("matrix(1, 0, 0, 1, 12, -6)");
  });

  it("keeps world positions aligned around the zoom focal point", () => {
    expect(boardCameraPreviewTransform({ pan: { x: 100, y: 50 }, zoom: 1 }, { pan: { x: 0, y: 0 }, zoom: 2 }))
      .toBe("matrix(2, 0, 0, 2, -200, -100)");
  });

  it("rejects invalid camera state", () => {
    expect(boardCameraPreviewTransform({ pan: { x: 0, y: 0 }, zoom: 0 }, { pan: { x: 1, y: 1 }, zoom: 1 })).toBeNull();
  });

  it("reprojects a rotated or mirrored viewport during a pan", () => {
    const rotated = { pan: { x: 0, y: 0 }, zoom: 1, rotation: Math.PI / 2, center: { x: 100, y: 100 } };
    expect(boardCameraPreviewTransform(rotated, { ...rotated, pan: { x: 10, y: 0 } })).toBe("matrix(1, 0, 0, 1, 0, 10)");
    const mirrored = { pan: { x: 0, y: 0 }, zoom: 1, mirrored: true, center: { x: 100, y: 100 } };
    expect(boardCameraPreviewTransform(mirrored, { ...mirrored, pan: { x: 10, y: 0 } })).toBe("matrix(1, 0, 0, 1, -10, 0)");
  });
});
