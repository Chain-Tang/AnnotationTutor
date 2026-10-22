import { deflateSync, inflateSync } from "fflate";
import { sha256Hex } from "./board-brush-pack.js";
import { affectedBoardTiles, BOARD_TILE_GUTTER, BOARD_TILE_SIZE } from "./board-paint.js";
import type { BoardPaintOperation, BoardRect, BoardTileManifest, BoardTileRef } from "./board-types.js";

const OPERATION_THRESHOLD = 64;
const PIXEL_THRESHOLD = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

export type RestoredBoardTile = { ref: BoardTileRef; pixels: Uint8ClampedArray; width: number; height: number };
export type BoardPaintCheckpointStorage = {
  read(path: string): Promise<ArrayBuffer | null>;
  write(input: { boardId: string; layerId: string; key: string; revision: number; bytes: ArrayBuffer }): Promise<string>;
};
export type BoardPaintTileRenderer = (
  input: { layerId: string; key: string; bounds: BoardRect; revision: number },
) => Promise<Uint8ClampedArray> | Uint8ClampedArray;

function parseTileKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(":").map(Number);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error(`Invalid tile key: ${key}`);
  return { x: x!, y: y! };
}
function tileBounds(key: string, gutter = BOARD_TILE_GUTTER): BoardRect {
  const { x, y } = parseTileKey(key);
  return { x: x * BOARD_TILE_SIZE - gutter, y: y * BOARD_TILE_SIZE - gutter, width: BOARD_TILE_SIZE + gutter * 2, height: BOARD_TILE_SIZE + gutter * 2 };
}
function intersects(a: BoardRect, b: BoardRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}
function dependencies(operations: readonly BoardPaintOperation[]): string[] {
  return [...new Set(operations.flatMap(operation => [operation.maskAssetHash, ...(operation.brush?.resourceHashes ?? [])]).filter((value): value is string => !!value))].sort();
}
function operationPixelEstimate(operation: BoardPaintOperation): number {
  return Math.ceil(Math.max(1, operation.bounds.width) * Math.max(1, operation.bounds.height) * 4);
}

/** Persistent derived-tile cache. Raw paint operations and ink remain authoritative. */
export class BoardPaintCheckpointService {
  private readonly cache = new Map<string, RestoredBoardTile>();
  private cacheBytes = 0;
  private disposed = false;
  public constructor(private readonly storage: BoardPaintCheckpointStorage, private readonly maxCacheBytes = MAX_CACHE_BYTES) {}

  public async restoreVisible(manifest: BoardTileManifest | undefined, layerIds: ReadonlySet<string>, viewport: BoardRect): Promise<RestoredBoardTile[]> {
    this.assertActive();
    if (!manifest?.tiles.length) return [];
    const refs = manifest.tiles.filter(ref => layerIds.has(ref.layerId) && intersects(tileBounds(ref.key, manifest.gutter), viewport));
    const restored: RestoredBoardTile[] = [];
    for (const ref of refs) {
      this.assertActive();
      const cacheKey = `${ref.layerId}:${ref.key}:${ref.revision}:${ref.checksum}`;
      const cached = this.cache.get(cacheKey);
      if (cached) { this.cache.delete(cacheKey); this.cache.set(cacheKey, cached); restored.push(cached); continue; }
      try {
        const stored = await this.storage.read(ref.path);
        this.assertActive();
        if (!stored) continue;
        const compressed = new Uint8Array(stored);
        const checksum = await sha256Hex(compressed);
        this.assertActive();
        if (checksum !== ref.checksum.toLowerCase()) continue;
        const inflated = inflateSync(compressed);
        const side = manifest.tileSize + manifest.gutter * 2, expected = side * side * 4;
        if (inflated.byteLength !== expected) continue;
        const tile = { ref, pixels: new Uint8ClampedArray(inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength)), width: side, height: side };
        this.cache.set(cacheKey, tile); this.cacheBytes += tile.pixels.byteLength; this.trim(); restored.push(tile);
      } catch {
        this.assertActive(); // Disposal is cancellation, not a corrupt tile to skip.
        /* Corrupt checkpoints are skipped and rebuilt from authoritative operations. */
      }
    }
    return restored;
  }

  public invalidate(layerId: string, bounds: BoardRect): void {
    for (const [key, tile] of this.cache)
      if (tile.ref.layerId === layerId && intersects(tileBounds(tile.ref.key), bounds)) {
        this.cache.delete(key); this.cacheBytes -= tile.pixels.byteLength;
      }
  }

  public async checkpoint(input: {
    boardId: string;
    layerId: string;
    operations: readonly BoardPaintOperation[];
    manifest?: BoardTileManifest;
    render: BoardPaintTileRenderer;
    force?: boolean;
  }): Promise<BoardTileManifest> {
    this.assertActive();
    const prior = input.manifest ?? { format: "board-tiles-v1" as const, tileSize: BOARD_TILE_SIZE, gutter: BOARD_TILE_GUTTER, checkpointRevision: 0, compression: "deflate-rgba-v1" as const, tiles: [] };
    const layerRevision = Math.max(0, ...prior.tiles.filter(tile => tile.layerId === input.layerId).map(tile => tile.revision));
    const pending = input.operations.filter(operation => operation.layerId === input.layerId && operation.revision > layerRevision);
    if (!pending.length) return structuredClone(prior);
    const estimatedPixels = pending.reduce((sum, operation) => sum + operationPixelEstimate(operation), 0);
    if (!input.force && pending.length < OPERATION_THRESHOLD && estimatedPixels < PIXEL_THRESHOLD) return structuredClone(prior);
    const revision = Math.max(...pending.map(operation => operation.revision));
    const keys = [...new Set(pending.flatMap(operation => operation.affectedTiles.length ? operation.affectedTiles : affectedBoardTiles(operation.bounds)))].sort();
    const replacements: BoardTileRef[] = [];
    for (const key of keys) {
      this.assertActive();
      const bounds = tileBounds(key, prior.gutter), pixels = await input.render({ layerId: input.layerId, key, bounds, revision });
      this.assertActive();
      const side = prior.tileSize + prior.gutter * 2;
      if (pixels.byteLength !== side * side * 4) throw new Error(`Tile ${key} returned ${pixels.byteLength} bytes; expected ${side * side * 4}`);
      const compressed = deflateSync(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), { level: 6 });
      const checksum = await sha256Hex(compressed);
      this.assertActive();
      const path = await this.storage.write({
        boardId: input.boardId, layerId: input.layerId, key, revision,
        bytes: compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer,
      });
      this.assertActive();
      const { x, y } = parseTileKey(key);
      replacements.push({ key, layerId: input.layerId, x, y, revision, checksum, path, operationFromRevision: layerRevision + 1, operationToRevision: revision, dependencies: dependencies(input.operations.filter(operation => operation.layerId === input.layerId && operation.revision <= revision && operation.affectedTiles.includes(key))), byteLength: compressed.byteLength });
    }
    const replaced = new Set(replacements.map(ref => `${ref.layerId}:${ref.key}`));
    return {
      ...structuredClone(prior), compression: "deflate-rgba-v1",
      checkpointRevision: Math.max(prior.checkpointRevision, revision),
      tiles: [...prior.tiles.filter(ref => !replaced.has(`${ref.layerId}:${ref.key}`)), ...replacements],
    };
  }

  public rebuild(input: Omit<Parameters<BoardPaintCheckpointService["checkpoint"]>[0], "force">): Promise<BoardTileManifest> {
    return this.checkpoint({ ...input, force: true });
  }

  public dispose(): void { this.disposed = true; this.cache.clear(); this.cacheBytes = 0; }
  private assertActive(): void { if (this.disposed) throw new Error("paint-checkpoint-service-disposed"); }
  private trim(): void {
    while (this.cacheBytes > this.maxCacheBytes && this.cache.size) {
      const key = this.cache.keys().next().value as string, tile = this.cache.get(key)!;
      this.cache.delete(key); this.cacheBytes -= tile.pixels.byteLength;
    }
  }
}
