import { describe, expect, it, vi } from "vitest";
import { BoardPaintCheckpointService } from "../src/board-paint-checkpoint.js";
import { defaultBoardBrush } from "../src/board-brushes.js";
import type { BoardPaintOperation } from "../src/board-types.js";

const operation = (revision: number, key = "0:0"): BoardPaintOperation => ({
  id: `paint-${revision}`, layerId: "paint-layer", type: "stroke", bounds: { x: 0, y: 0, width: 40, height: 40 },
  affectedTiles: [key], color: "#111111", opacity: 1, strokeWidth: 4, inkId: `ink-${revision}`,
  brush: defaultBoardBrush("pen", revision), createdAt: new Date(revision).toISOString(), revision,
});

describe("persistent paint checkpoints", () => {
  it('does not repopulate a disposed cache after an in-flight read',async()=>{
    let release!:(data:ArrayBuffer)=>void;const pending=new Promise<ArrayBuffer>(r=>{release=r;});
    let bytes!:ArrayBuffer;
    const service=new BoardPaintCheckpointService({read:()=>pending,write:async input=>{bytes=input.bytes;return 'synthetic';}});
    const manifest=await service.rebuild({boardId:'board',layerId:'paint-layer',operations:[operation(1)],render:()=>new Uint8ClampedArray(516**2*4)});
    const result=service.restoreVisible(manifest,new Set(['paint-layer']),{x:0,y:0,width:10,height:10});
    service.dispose();release(bytes);await expect(result).rejects.toThrow('paint-checkpoint-service-disposed');
    expect((service as unknown as {cache:Map<string,unknown>;cacheBytes:number}).cache.size).toBe(0);
  });
  it('does not write or continue rendering after disposal while a tile is being prepared',async()=>{
    let release!:(data:Uint8ClampedArray)=>void;const pending=new Promise<Uint8ClampedArray>(r=>{release=r;});
    const write=vi.fn(async()=> 'synthetic'),render=vi.fn(()=>pending),service=new BoardPaintCheckpointService({read:async()=>null,write});
    const result=service.rebuild({boardId:'board',layerId:'paint-layer',operations:[operation(1,'0:0'),operation(2,'1:0')],render});
    service.dispose();release(new Uint8ClampedArray(516**2*4));await expect(result).rejects.toThrow('paint-checkpoint-service-disposed');
    expect(write).not.toHaveBeenCalled();expect(render).toHaveBeenCalledOnce();
  });
  it('does not start a second tile or publish a manifest after disposal during an already-started write',async()=>{
    let release!:(path:string)=>void;const pending=new Promise<string>(r=>{release=r;});
    const write=vi.fn(()=>pending),render=vi.fn(()=>new Uint8ClampedArray(516**2*4)),service=new BoardPaintCheckpointService({read:async()=>null,write});
    const result=service.rebuild({boardId:'original',layerId:'paint-layer',operations:[operation(1,'0:0'),operation(2,'1:0')],render});
    await vi.waitFor(()=>expect(write).toHaveBeenCalledOnce());service.dispose();release('original-derived-file');
    await expect(result).rejects.toThrow('paint-checkpoint-service-disposed');expect(render).toHaveBeenCalledOnce();expect(write).toHaveBeenCalledOnce();
  });
  it("checkpoints after 64 operations and restores only visible checksummed tiles", async () => {
    const files = new Map<string, ArrayBuffer>();
    const service = new BoardPaintCheckpointService({
      read: async path => files.get(path) ?? null,
      write: async input => { const path = `tiles/${input.layerId}/${input.key}.r${input.revision}.rgba.deflate`; files.set(path, input.bytes); return path; },
    });
    const operations = Array.from({ length: 64 }, (_, index) => operation(index + 1, index % 2 ? "0:0" : "1:0"));
    const manifest = await service.checkpoint({
      boardId: "board", layerId: "paint-layer", operations,
      render: ({ key }) => new Uint8ClampedArray((512 + 4) ** 2 * 4).fill(key === "0:0" ? 17 : 29),
    });
    expect(manifest.compression).toBe("deflate-rgba-v1");
    expect(manifest.checkpointRevision).toBe(64);
    expect(manifest.tiles).toHaveLength(2);
    const restored = await service.restoreVisible(manifest, new Set(["paint-layer"]), { x: 0, y: 0, width: 300, height: 300 });
    expect(restored).toHaveLength(1);
    expect(restored[0]!.pixels[0]).toBe(17);
  });

  it("skips corrupt data and can force a rebuild below the automatic threshold", async () => {
    const files = new Map<string, ArrayBuffer>();
    const storage = {
      read: async (path: string) => files.get(path) ?? null,
      write: async (input: { layerId: string; key: string; revision: number; bytes: ArrayBuffer }) => { const path = `${input.layerId}-${input.key}-${input.revision}`; files.set(path, input.bytes); return path; },
    };
    const service = new BoardPaintCheckpointService(storage);
    expect((await service.checkpoint({ boardId: "board", layerId: "paint-layer", operations: [operation(1)], render: () => new Uint8ClampedArray((512 + 4) ** 2 * 4) })).tiles).toHaveLength(0);
    const manifest = await service.rebuild({ boardId: "board", layerId: "paint-layer", operations: [operation(1)], render: () => new Uint8ClampedArray((512 + 4) ** 2 * 4).fill(8) });
    files.set(manifest.tiles[0]!.path, new Uint8Array([1, 2, 3]).buffer);
    expect(await service.restoreVisible(manifest, new Set(["paint-layer"]), { x: 0, y: 0, width: 10, height: 10 })).toEqual([]);
  });
});
