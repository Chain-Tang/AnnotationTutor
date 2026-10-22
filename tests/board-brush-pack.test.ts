import { describe, expect, it } from "vitest";
import { exportTutorBrush, importTutorBrush, sha256Hex } from "../src/board-brush-pack.js";
import { defaultBoardBrush } from "../src/board-brushes.js";

describe("Tutor brush packs", () => {
  it("round-trips a data-only checksummed PNG resource", async () => {
    const resource = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const hash = await sha256Hex(resource);
    const brush = {
      formatVersion: 1 as const, id: "grain-pencil", version: 1, name: "Grain pencil", engine: "dab" as const,
      kind: "pencil" as const, style: defaultBoardBrush("pencil", 9), license: "CC0-1.0",
      grain: { hash, mimeType: "image/png" as const, width: 64, height: 64, license: "CC0-1.0" },
    };
    const archive = await exportTutorBrush({ brush, resources: new Map([[hash, resource]]) });
    const imported = await importTutorBrush(archive);
    expect(imported.brush).toEqual(brush);
    expect(imported.resources.get(hash)).toEqual(resource);
  });

  it("rejects executable or unverified resource declarations", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const brush = {
      formatVersion: 1 as const, id: "unsafe", version: 1, name: "Unsafe", engine: "dab" as const,
      kind: "chalk" as const, style: defaultBoardBrush("chalk", 2),
      tip: { hash: "0".repeat(64), mimeType: "image/png" as const, width: 32, height: 32 },
    };
    await expect(exportTutorBrush({ brush, resources: new Map([["0".repeat(64), bytes]]) })).rejects.toThrow("checksum");
  });

  it("round-trips v2 paper and numeric MyPaint metadata without executing it", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    const brush = {
      formatVersion: 2 as const, id: "paper-pencil", version: 1, name: "Paper pencil", engine: "dab" as const,
      kind: "pencil" as const, style: { ...defaultBoardBrush("pencil", 9), engineVersion: 2 as const, paperHash: hash },
      paper: { hash, mimeType: "image/png" as const, width: 64, height: 64, license: "CC0-1.0" },
      myb: { version: 3 as const, settings: { opaque: { base_value: 0.75 } } },
    };
    expect((await importTutorBrush(await exportTutorBrush({ brush, resources: new Map([[hash, bytes]]) }))).brush).toEqual(brush);
    await expect(exportTutorBrush({ brush: { ...brush, myb: { version: 3, settings: { "onload();": { base_value: 1 } } } } as never, resources: new Map([[hash, bytes]]) })).rejects.toThrow();
  });
});
