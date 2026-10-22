import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { createBoardDocument, upgradeBoardDocument } from "../src/board-model.js";
import { buildOpenRasterArchive, buildTutorBoardArchive, sanitizeBoardForPublicShare } from "../src/board-share.js";
import { defaultBoardBrush } from "../src/board-brushes.js";
import { sha256Hex } from "../src/board-brush-pack.js";

function v4Board() {
  let document = createBoardDocument("private/lesson.md", "markdown", "BOARD-share");
  document = upgradeBoardDocument(document);
  document = upgradeBoardDocument(document);
  document.layers!.push({ id: "hidden", name: "Hidden", order: 1, visible: false, locked: false, opacity: 1, blendMode: "normal", kind: "vector", alphaLocked: false, clippedToBelow: false });
  document.objects.push({ id: "secret", kind: "rect", anchor: { kind: "markdown", key: "p", quote: "x" }, x: 0, y: 0, width: 10, height: 10, color: "#000", strokeWidth: 1, layerId: "hidden", createdBy: "human", editedBy: "human", revision: 1, groupId: "g" });
  document.semanticGroups!.push({ id: "semantic", objectIds: ["secret"], kind: "handwriting", confidence: 1, recognition: { text: "secret", alternatives: [], language: "en", provider: "cloud-provider", recognizedAt: "2026-09-14T00:00:00.000Z", userCorrected: false }, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" });
  return document;
}

describe("artwork sharing", () => {
  it("removes private path, recognition and hidden layers by default", () => {
    const shared = sanitizeBoardForPublicShare(v4Board());
    expect(shared.sourceFile).toBe("shared.md");
    expect(shared.layers?.some(layer => layer.id === "hidden")).toBe(false);
    expect(shared.objects).toHaveLength(0);
    expect(JSON.stringify(shared)).not.toContain("cloud-provider");
  });

  it("creates a checksummed editable tutorboard archive", async () => {
    const archive = unzipSync(await buildTutorBoardArchive({ document: v4Board(), ink: {} }));
    expect(Object.keys(archive)).toContain("board.json");
    expect(Object.keys(archive)).toContain("checksums.json");
    expect(JSON.parse(strFromU8(archive["checksums.json"]!)).format).toBe("tutorboard-checksums-v1");
  });

  it("stores v5 vector assets as portable archive entries", async () => {
    const document = upgradeBoardDocument(v4Board());
    document.vectorAssets!.push({
      format: "board-vector-v1", id: "face", version: 1, name: "Face", width: 100, height: 100,
      rootIds: ["head"], createdAt: "2026-09-16T00:00:00.000Z",
      nodes: [{ id: "head", name: "Head", kind: "shape", semanticRole: "face", transform: [1, 0, 0, 1, 0, 0], opacity: 1, blendMode: "normal", visible: true, locked: false, shape: { kind: "ellipse", cx: 50, cy: 50, rx: 40, ry: 45 }, fill: { kind: "solid", color: "#ffd5c2", opacity: 1 } }],
    });
    const archive = unzipSync(await buildTutorBoardArchive({ document, ink: {} }));
    document.objects.push({
      id: "face-object", kind: "vector", vectorAssetId: "face", vectorAssetVersion: 1,
      anchor: { kind: "markdown", key: "face", quote: "" }, x: 0, y: 0, width: 100, height: 100,
      color: "#000000", strokeWidth: 1, layerId: document.layers![0]!.id,
      createdBy: "human", editedBy: "human", revision: 1, groupId: "vector",
    });
    const usedArchive = unzipSync(await buildTutorBoardArchive({ document, ink: {} }));
    expect(Object.keys(archive)).not.toContain("vectors/face-v1.json");
    expect(Object.keys(usedArchive)).toContain("vectors/face-v1.json");
    expect(JSON.parse(strFromU8(usedArchive["vectors/face-v1.json"]!)).nodes[0].semanticRole).toBe("face");
  });

  it("packages only fill masks referenced by the shared document", async () => {
    const document = v4Board();
    document.layers![0] = { ...document.layers![0]!, kind: "paint" };
    const used = "a".repeat(64), unused = "b".repeat(64);
    document.paintOperations!.push({
      id: "paint-fill", layerId: document.layers![0]!.id, type: "fill",
      bounds: { x: 0, y: 0, width: 1, height: 1 }, affectedTiles: ["0:0"],
      color: "#000000", opacity: 1, maskAssetHash: used, maskWidth: 1, maskHeight: 1,
      createdAt: "2026-09-14T00:00:00.000Z", revision: 1,
    });
    const archive = unzipSync(await buildTutorBoardArchive({
      document, ink: {}, paintAssets: new Map([[used, new Uint8Array([1])], [unused, new Uint8Array([2])]]),
    }));
    expect(Object.keys(archive)).toContain(`paint/${used}.mask.deflate`);
    expect(Object.keys(archive)).not.toContain(`paint/${unused}.mask.deflate`);
  });

  it("packages referenced v2 brush resources and fails closed when one is absent", async () => {
    const document = v4Board();
    const bytes = new Uint8Array([1, 2, 3]), hash = await sha256Hex(bytes);
    document.brushDefinitions!.push({
      formatVersion: 2, id: "paper", version: 1, name: "Paper", engine: "dab", kind: "pencil",
      style: { ...defaultBoardBrush("pencil"), engineVersion: 2, paperHash: hash, resourceHashes: [hash] },
      paper: { hash, mimeType: "image/png", width: 2, height: 2 },
    });
    await expect(buildTutorBoardArchive({ document, ink: {} })).rejects.toThrow("Missing brush asset");
    const archive = unzipSync(await buildTutorBoardArchive({ document, ink: {}, brushAssets: new Map([[hash, bytes]]) }));
    expect(archive[`brushes/${hash}.bin`]).toEqual(bytes);
  });

  it("creates a standard OpenRaster structure with an uncompressed mimetype", () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const archive = unzipSync(buildOpenRasterArchive({ width: 64, height: 64, layers: [{ name: "Ink", png }], mergedPng: png }));
    expect(strFromU8(archive.mimetype!)).toBe("image/openraster");
    expect(strFromU8(archive["stack.xml"]!)).toContain("data/layer-0000.png");
  });
});
