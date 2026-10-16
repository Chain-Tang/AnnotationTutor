// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { captureBoardSurface, projectCapturedBoardSlot, type BoardProjection } from "../src/board-projection.js";
import { multiplyBoardMatrices } from "../src/board-surfaces.js";
import type { BoardMatrix } from "../src/board-types.js";

describe("frame-scoped board geometry", () => {
  it("measures one slot once for a thousand attached transforms and captures the clip", () => {
    let offset = 30;
    const element = document.createElement("div");
    const matrix = vi.fn((): BoardMatrix => [2, 0, 0, 2, offset, 80]);
    const rect = vi.fn(() => ({ x: offset, y: 80, width: 600, height: 400 }));
    const clip = vi.fn(() => ({ x: offset + 10, y: 90, width: 580, height: 380 }));
    const slot: BoardProjection = { id: "source/slot", kind: "markdown", element, viewportElement: element,
      anchor: { kind: "markdown", key: "paragraph", quote: "Text" }, width: 600, height: 400, text: "Text",
      projectionId: "slot", layoutRevision: 7, modelToSlot: [1, 0, 0, 1, 0, 0],
      getClientRect: rect, clipRect: clip, toClient: matrix, project: () => { throw Error("uncaptured projection"); },
      unproject: () => { throw Error("uncaptured inverse"); } };
    const captured = captureBoardSurface(slot) as BoardProjection;
    for (let index = 0; index < 1_000; index++) {
      const binding: BoardMatrix = [1, 0, 0, 1, index, index / 2];
      const projected = projectCapturedBoardSlot(captured, binding);
      expect(projected.toClient()).toEqual(multiplyBoardMatrices([2, 0, 0, 2, 30, 80], binding));
      expect(projected.unproject(projected.project({ x: 10, y: 20 }))).toEqual({ x: 10, y: 20 });
      expect(projected.clipRect()).toEqual({ x: 40, y: 90, width: 580, height: 380 });
    }
    expect(matrix).toHaveBeenCalledOnce(); expect(rect).toHaveBeenCalledOnce(); expect(clip).toHaveBeenCalledOnce();
    offset = 90;
    expect(captured.project({ x: 0, y: 0 })).toEqual({ x: 30, y: 80 });
    const nextSlot: BoardProjection = { ...slot, layoutRevision: 8 };
    const next = captureBoardSurface(nextSlot) as BoardProjection;
    expect(next.project({ x: 0, y: 0 })).toEqual({ x: 90, y: 80 });
    expect(next.clipRect().x).toBe(100); expect(next.layoutRevision).toBe(8);
  });
});
