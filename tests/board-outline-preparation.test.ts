import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { Worker as NodeWorker } from "node:worker_threads";
import vm from "node:vm";
import { BoardOutlinePreparation, canPreparePressureOutline } from "../src/board-outline-preparation.js";
import { packedPressureOutline } from "../src/board-pressure-geometry.js";
import { boardBrushOutline, defaultBoardBrush } from "../src/board-brushes.js";
import { normalizedBoardPoints, renderBoardCanvas } from "../src/board-renderer.js";
import type { BoardBrushStyle, BoardInk, BoardObject, BoardPoint } from "../src/board-types.js";
import golden from "./fixtures/board-outline-c37.json" with {type: "json"};

function pack(points: readonly BoardPoint[]) {
  return new Float64Array(points.flatMap(p => [p.x, p.y, p.pressure ?? NaN]));
}
const points = [{x: 20, y: 30, pressure: .1, t: 0}, {x: 60, y: 60, pressure: .8, t: 16}, {x: 80, y: 50, pressure: .4, t: 32}];
const object: BoardObject = {id: "stroke", kind: "ink", anchor: {kind: "canvas", pageId: "main"},
  x: 10, y: 20, width: 100, height: 40, color: "#123456", strokeWidth: 4,
  brush: defaultBoardBrush("pen"), inkId: "ink", createdBy: "human", editedBy: "human", revision: 1, groupId: "g"};
const ink: BoardInk = {ink: {id: "ink", points, createdAt: ""}};

class FakeWorker {
  static instances: FakeWorker[] = [];
  constructor() { FakeWorker.instances.push(this); }
  onmessage: ((event: {data: unknown}) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  message: {id: number; strokes: Parameters<typeof packedPressureOutline>[0][]} | null = null;
  transfer: Transferable[] = [];
  postMessage(message: NonNullable<FakeWorker["message"]>, transfer: Transferable[]) { this.message = message; this.transfer = transfer; }
  reply(outlines = this.message!.strokes.map(stroke => ({id: stroke.id, points: packedPressureOutline(stroke)}))) {
    this.onmessage?.({data: {id: this.message!.id, outlines}});
  }
}
function service(timeout = 3000) {
  FakeWorker.instances = [];
  const revokeObjectURL = vi.fn();
  const environment = {Worker: FakeWorker, Blob, URL: {createObjectURL: () => "blob:local", revokeObjectURL}} as unknown as Pick<typeof globalThis, "Worker" | "Blob" | "URL">;
  return {preparation: new BoardOutlinePreparation(environment, "offline-worker", timeout), revokeObjectURL};
}

describe("cold pressure geometry", () => {
  it.each(golden.cases)("matches frozen C37 geometry: $name", fixture => {
    const samples = pack(fixture.points), before = samples.slice();
    const packed = packedPressureOutline({id: "sample", samples, ...fixture.object,
      brush: fixture.object.brush as BoardBrushStyle, local: fixture.local});
    expect(Array.from(packed)).toEqual(fixture.outline.flatMap(p => [p.x, p.y]));
    expect(samples).toEqual(before);
  });
  it.each([points, [{x: 1, y: 2}, {x: 1, y: 8}], [{x: 5, y: 4}, {x: 7, y: 4}],
    [{x: 1, y: 2}, {x: 1, y: 2}]].map(samples => ({samples})))("shares the renderer transform including degenerate extents", ({samples}) => {
    const derived = packedPressureOutline({id: "stroke", samples: pack(samples), width: object.width,
      height: object.height, strokeWidth: object.strokeWidth, brush: object.brush!});
    expect(Array.from(derived)).toEqual(boardBrushOutline(normalizedBoardPoints(samples, object.width, object.height), object, true).flatMap(p => [p.x, p.y]));
  });
  it("does not replace erased, single-point, textured or unsupported brush paths", () => {
    expect(canPreparePressureOutline(object, ink)).toBe(true);
    for (const candidate of [{...object, erasedRanges: [[0, 1] as [number, number]]}, {...object, brush: defaultBoardBrush("watercolor")},
      {...object, brush: {...object.brush!, engineVersion: 2 as const, tipHash: "texture"}}, {...object, kind: "path" as const}])
      expect(canPreparePressureOutline(candidate, ink)).toBe(false);
    expect(canPreparePressureOutline(object, {ink: {...ink.ink!, points: [points[0]!]}})).toBe(false);
  });
  it("renders the same Canvas commands without rewriting ink", async () => {
    const makeContext = () => {
      const commands: unknown[][] = [];
      const context = new Proxy({globalAlpha: 1} as unknown as CanvasRenderingContext2D, {
        get: (target, key) => Reflect.get(target, key) ?? ((...args: unknown[]) => commands.push([key, ...args])),
        set: (target, key, value) => Reflect.set(target, key, value),
      });
      return {commands, context};
    };
    const old = makeContext(), prepared = makeContext(), before = structuredClone(ink);
    const geometry = packedPressureOutline({id: object.id, samples: pack(points), width: object.width,
      height: object.height, strokeWidth: object.strokeWidth, brush: object.brush!});
    renderBoardCanvas(old.context, [object], {ink, characters: []});
    renderBoardCanvas(prepared.context, [object], {ink, characters: [], pressureOutlines: new Map([[object.id, geometry]])});
    expect(prepared.commands).toEqual(old.commands); expect(ink).toEqual(before);
  });
  it("runs the bundled offline worker protocol with transferable buffers", async () => {
    const compiled = await build({entryPoints: ["src/board-outline-worker.ts"], bundle: true, platform: "browser", format: "iife", write: false});
    const worker = new NodeWorker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};${compiled.outputFiles[0]!.text};parentPort.on('message',data=>self.onmessage({data}));`, {eval: true});
    try {
      const samples = pack(points);
      const response = new Promise<{id: number; outlines: {id: string; points: Float64Array}[]}>(resolve => worker.once("message", resolve));
      worker.postMessage({id: 1, strokes: [{id: object.id, samples, width: object.width, height: object.height, strokeWidth: object.strokeWidth, brush: object.brush!}]}, [samples.buffer]);
      expect(samples.byteLength).toBe(0);
      const reply = await response;
      expect(reply.id).toBe(1); expect(reply.outlines[0]!.points).toBeInstanceOf(Float64Array);
      expect(Array.from(reply.outlines[0]!.points)).toEqual(boardBrushOutline(normalizedBoardPoints(points, object.width, object.height), object, true).flatMap(p => [p.x, p.y]));
    } finally { await worker.terminate(); }
  });
});

describe("outline preparation lifecycle", () => {
  it("transfers a bounded derived copy and accepts cross-window typed arrays", async () => {
    const {preparation, revokeObjectURL} = service(), before = JSON.stringify(ink);
    const result = preparation.prepare([object], ink), worker = FakeWorker.instances[0]!;
    expect(worker.transfer).toEqual([worker.message!.strokes[0]!.samples.buffer]);
    const values = Array.from(packedPressureOutline(worker.message!.strokes[0]!));
    worker.reply([{id: object.id, points: vm.runInNewContext(`new Float64Array(${JSON.stringify(values)})`)}]);
    expect(Array.from((await result)!.get(object.id)!)).toEqual(values);
    expect(JSON.stringify(ink)).toBe(before); preparation.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
  it("cancels a pending batch and ignores its late response/error after restart", async () => {
    const {preparation} = service();
    const old = preparation.prepare([object], ink), first = FakeWorker.instances[0]!;
    preparation.cancel(); expect(await old).toBeNull();
    const next = preparation.prepare([object], ink), second = FakeWorker.instances[1]!;
    first.reply(); first.onerror?.(); expect(preparation.available).toBe(true);
    second.reply(); expect((await next)!.has(object.id)).toBe(true); preparation.dispose();
  });
  it.each(["missing", "duplicate", "nonfinite", "oversized"])("falls back atomically on %s output", async invalid => {
    const {preparation} = service(); const result = preparation.prepare([object], ink), worker = FakeWorker.instances[0]!;
    const good = {id: object.id, points: new Float64Array([1, 2])};
    worker.reply(invalid === "missing" ? [] : invalid === "duplicate" ? [good, good] :
      [{id: object.id, points: invalid === "nonfinite" ? new Float64Array([NaN, 1]) : new Float64Array(400)}]);
    expect(await result).toBeNull(); expect(preparation.available).toBe(false); preparation.dispose();
  });
  it("times out and handles worker failure without leaving pending geometry", async () => {
    vi.useFakeTimers();
    try {
      const {preparation} = service(10); const result = preparation.prepare([object], ink);
      await vi.advanceTimersByTimeAsync(11); expect(await result).toBeNull(); expect(preparation.available).toBe(false);
      preparation.dispose();
    } finally { vi.useRealTimers(); }
    const {preparation} = service(); const result = preparation.prepare([object], ink);
    FakeWorker.instances[0]!.onerror?.(); expect(await result).toBeNull(); preparation.dispose();
  });
  it("does not queue concurrent jobs or exceed batch/point limits", async () => {
    const {preparation} = service(); const result = preparation.prepare([object], ink);
    expect(await preparation.prepare([object], ink)).toBeNull(); FakeWorker.instances[0]!.reply(); await result;
    expect(await preparation.prepare(Array(129).fill(object), ink)).toBeNull();
    const big = {ink: {...ink.ink!, points: Array(64_001).fill(points[0])}};
    expect((await preparation.prepare([object], big))!.size).toBe(0); preparation.dispose();
  });
  it("preserves synchronous rendering when the worker capability is absent", async () => {
    const preparation = new BoardOutlinePreparation({Worker: undefined} as unknown as Pick<typeof globalThis, "Worker" | "Blob" | "URL">, "offline-worker");
    expect(preparation.available).toBe(false); expect(await preparation.prepare([object], ink)).toBeNull(); preparation.dispose();
  });
});
