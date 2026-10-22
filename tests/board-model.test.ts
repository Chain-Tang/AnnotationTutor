import { describe, expect, it } from "vitest";
import {
  BoardHistory,
  boardDocumentSchema,
  boardObjectSchema,
  boardMarkdownAnchorStateSchema,
  boardSnapshotSchema,
  createBoardDocument,
  tutorCharacterProfileSchema,
  validateBoardInk,
  parseBoardDocument,
  upgradeBoardDocument,
  type BoardTextGeometryUpdate,
} from "../src/board-model.js";
import { builtInBoardAssets, builtInTutorCharacters } from "../src/board-characters.js";
import { defaultBoardBrush } from "../src/board-brushes.js";
import type { BoardDocument, BoardObject } from "../src/board-types.js";

function object(overrides: Partial<BoardObject> = {}): BoardObject {
  return {
    id: "object-1",
    kind: "rect",
    anchor: { kind: "markdown", key: "block-1", quote: "Example" },
    x: 1,
    y: 2,
    width: 100,
    height: 80,
    color: "#222222",
    strokeWidth: 2,
    createdBy: "human",
    editedBy: "human",
    revision: 1,
    groupId: "group-1",
    ...overrides,
  };
}
function board(objects: BoardObject[] = []): BoardDocument {
  return {
    ...createBoardDocument("lesson.md", "markdown", "BOARD-test"),
    objects,
  };
}

describe("board contracts", () => {
  it("lazily upgrades v3 standalone boards to v4 artboards and hybrid layers", () => {
    const v2 = createBoardDocument("Art/My board.tutorboard.md", "standalone", "BOARD-art");
    const v3 = upgradeBoardDocument(v2);
    const v4 = upgradeBoardDocument(v3);
    expect(v3.schemaVersion).toBe(3);
    expect(v4.schemaVersion).toBe(4);
    expect(v4.layers?.[0]).toMatchObject({ kind: "vector", alphaLocked: false, clippedToBelow: false });
    expect(v4.artboards?.[0]).toMatchObject({ width: 1920, height: 1080, dpi: 144 });
    expect(v4.tileManifest).toMatchObject({ tileSize: 512, gutter: 2 });
  });
  it("lazily upgrades v4 to v5 without changing objects, anchors or ink identities", () => {
    const v2 = createBoardDocument("Art/Scene.tutorboard.md", "standalone", "BOARD-v5");
    const v3 = upgradeBoardDocument(v2), v4 = upgradeBoardDocument(v3);
    v4.objects.push({
      id: "INK-object", kind: "ink", inkId: "INK-stable", anchor: { kind: "canvas", pageId: "main" },
      x: 10, y: 20, width: 30, height: 40, color: "#111111", strokeWidth: 3,
      createdBy: "human", editedBy: "human", revision: 1, groupId: "GROUP-stable",
    });
    const v5 = upgradeBoardDocument(v4);
    expect(v5.schemaVersion).toBe(5);
    expect(v5.objects[0]).toEqual(v4.objects[0]);
    expect(v5.vectorAssets).toEqual([]);
    expect(v5.characterDefinitions).toEqual([]);
  });
  it("requires a checksummed, dimensioned mask for replayable paint fills", () => {
    const v3 = upgradeBoardDocument(createBoardDocument("Art/Fill.tutorboard.md", "standalone", "BOARD-fill"));
    const v4 = upgradeBoardDocument(v3);
    v4.layers![0] = { ...v4.layers![0]!, kind: "paint" };
    const fill = {
      id: "PAINT-fill", layerId: v4.layers![0]!.id, type: "fill" as const,
      bounds: { x: 0, y: 0, width: 64, height: 64 }, affectedTiles: ["0:0"],
      color: "#112233", opacity: 1, createdAt: "2026-09-14T00:00:00.000Z", revision: 1,
    };
    expect(boardDocumentSchema.safeParse({ ...v4, paintOperations: [fill] }).success).toBe(false);
    expect(boardDocumentSchema.safeParse({
      ...v4,
      paintOperations: [{ ...fill, maskAssetHash: "a".repeat(64), maskWidth: 64, maskHeight: 64 }],
    }).success).toBe(true);
    const erase = { ...fill, id: "PAINT-erase", type: "erase" as const };
    expect(boardDocumentSchema.safeParse({ ...v4, paintOperations: [erase] }).success).toBe(false);
    expect(boardDocumentSchema.safeParse({
      ...v4,
      paintOperations: [{ ...erase, inkId: "INK-erase", strokeWidth: 24, brush: defaultBoardBrush("pen", 3) }],
    }).success).toBe(true);
  });
  it("reads v1 without inventing styles or identities and creates new v2 boards", () => {
    const legacy = { ...board([object()]), schemaVersion: 1 as const };
    expect(parseBoardDocument(JSON.stringify(legacy))).toEqual(legacy);
    expect(parseBoardDocument(legacy).objects[0]).not.toHaveProperty("drawingStyle");
    expect(board().schemaVersion).toBe(2);
  });
  it("validates portable styles, independent visual groups, and versioned stickers", () => {
    const styled = object({ kind: "text", text: "Why?", textStyle: { font: "handwritten", size: 24, align: "center" }, selectionGroupId: "selection-1" });
    expect(boardObjectSchema.safeParse(styled).success).toBe(true);
    expect(boardObjectSchema.safeParse({ ...styled, textStyle: { ...styled.textStyle, font: "https://font.example" } }).success).toBe(false);
    expect(boardObjectSchema.safeParse({ ...styled, textStyle: { ...styled.textStyle, size: Infinity } }).success).toBe(false);
    expect(boardObjectSchema.safeParse(object({ drawingStyle: { kind: "sketch", seed: 0xffffffff } })).success).toBe(true);
    expect(boardObjectSchema.safeParse(object({ drawingStyle: { kind: "sketch", seed: -1 } })).success).toBe(false);
    expect(boardObjectSchema.safeParse(object({ kind: "sticker", assetId: "asset-1", assetVersion: 2 })).success).toBe(true);
    expect(boardObjectSchema.safeParse(object({ kind: "sticker", assetId: "asset-1" })).success).toBe(false);
    expect(boardObjectSchema.safeParse(object({ assetId: "asset-1", assetVersion: 1 })).success).toBe(false);
  });
  it("bounds and validates Markdown relocation metadata without permitting duplicate IDs", () => {
    const entry = { id: "anchor:1", from: 0, to: 10, quote: "A paragraph", before: "", after: "", aliases: ["block:old"], status: "located" as const };
    const state = { textVersion: "buffer-1", entries: [entry] };
    expect(boardMarkdownAnchorStateSchema.safeParse(state).success).toBe(true);
    expect(boardMarkdownAnchorStateSchema.safeParse({ ...state, entries: [entry, entry] }).success).toBe(false);
    expect(boardMarkdownAnchorStateSchema.safeParse({ ...state, entries: [{ ...entry, to: -1 }] }).success).toBe(false);
    expect(boardDocumentSchema.safeParse({ ...board(), sourceType: "pdf", markdownAnchors: state }).success).toBe(false);
  });
  it("offers six searchable, locally defined kaomoji independently of the original characters", () => {
    const assets = builtInBoardAssets();
    const stickers = assets.filter(asset => asset.usage === "sticker");
    expect(stickers).toHaveLength(6);
    expect(new Set(stickers.map(asset => asset.id)).size).toBe(6);
    for (const sticker of stickers) {
      expect(tutorCharacterProfileSchema.safeParse(sticker).success).toBe(true);
      expect(sticker.objects?.[0]?.kind).toBe("text");
      expect(sticker.tags).toContain("颜文字");
      expect(sticker.assetPath).toBeUndefined();
    }
    expect(assets.slice(0, 2).map(({ usage: _usage, tags: _tags, ...asset }) => asset)).toEqual(builtInTutorCharacters());
  });
  it("keeps raw ink out of the board manifest and requires referenced ink", () => {
    const ink = object({ kind: "ink", inkId: "stroke-1" });
    expect(boardObjectSchema.safeParse(ink).success).toBe(true);
    expect(
      boardObjectSchema.safeParse({ ...ink, points: [{ x: 1, y: 2 }] }).success,
    ).toBe(false);
    expect(() => validateBoardInk(board([ink]), {})).toThrow(
      "Missing immutable ink",
    );
    expect(() =>
      validateBoardInk(board([ink]), {
        "stroke-1": {
          id: "stroke-1",
          points: [{ x: 0, y: 1 }],
          createdAt: new Date().toISOString(),
        },
      }),
    ).not.toThrow();
  });
  it.each(["constructor", "toString", "hasOwnProperty"])("requires own ink samples for the legal ID %s in boards, paint and characters", (inkId) => {
    const ink = object({ kind: "ink", inkId });
    expect(() => validateBoardInk(board([ink]), {})).toThrow("Missing immutable ink");
    const paintBoard = upgradeBoardDocument(upgradeBoardDocument(board()));
    paintBoard.layers![0]!.kind = "paint";
    paintBoard.paintOperations = [{
      id: "PAINT-prototype", layerId: paintBoard.layers![0]!.id, type: "erase", inkId,
      bounds: { x: 0, y: 0, width: 64, height: 64 }, affectedTiles: ["0:0"],
      color: "#112233", opacity: 1, strokeWidth: 24, brush: defaultBoardBrush("pen", 3),
      createdAt: "2026-09-14T00:00:00.000Z", revision: 1,
    }];
    expect(() => validateBoardInk(paintBoard, {})).toThrow("Missing immutable ink");
    const character = { id: "CHAR-prototype", version: 1, name: "Own ink", origin: "co_created", style: "custom",
      width: 100, height: 80, createdAt: "2026-09-14T00:00:00.000Z", objects: [ink], ink: {} };
    expect(tutorCharacterProfileSchema.safeParse(character).success).toBe(false);
    const samples = { [inkId]: { id: inkId, points: [{ x: 0, y: 0 }], createdAt: character.createdAt } };
    expect(() => validateBoardInk(board([ink]), samples)).not.toThrow();
    expect(() => validateBoardInk(paintBoard, samples)).not.toThrow();
    expect(tutorCharacterProfileSchema.safeParse({ ...character, ink: samples }).success).toBe(true);
  });
  it.each([NaN, Infinity, -Infinity, 1_000_001])(
    "rejects non-finite or unbounded coordinates: %s",
    (x) => {
      expect(boardObjectSchema.safeParse(object({ x })).success).toBe(false);
    },
  );
  it("rejects duplicate identities, unsafe paths, and mismatched anchors", () => {
    expect(
      boardDocumentSchema.safeParse(board([object(), object()])).success,
    ).toBe(false);
    expect(
      boardDocumentSchema.safeParse({ ...board(), sourceFile: "../private.md" })
        .success,
    ).toBe(false);
    expect(
      boardDocumentSchema.safeParse(
        board([object({ anchor: { kind: "pdf", page: 1 } })]),
      ).success,
    ).toBe(false);
  });
  it("rejects missing kind payloads and executable color strings", () => {
    for (const kind of ["ink", "path", "text", "character"] as const)
      expect(boardObjectSchema.safeParse(object({ kind })).success).toBe(false);
    expect(
      boardObjectSchema.safeParse(
        object({ color: 'url("https://example.com")' }),
      ).success,
    ).toBe(false);
  });
  it("validates screenshots and an invertible coordinate transform", () => {
    const snapshot = {
      pngBase64: "aGVsbG8=",
      width: 120,
      height: 90,
      imageToBoard: [1, 0, 0, 1, 0, 0],
      anchor: { kind: "pdf", page: 1 },
      layoutRevision: "layout-1",
    };
    expect(boardSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      boardSnapshotSchema.safeParse({
        ...snapshot,
        imageToBoard: [0, 0, 0, 0, 0, 0],
      }).success,
    ).toBe(false);
    expect(
      boardSnapshotSchema.safeParse({ ...snapshot, pngBase64: "<svg/>" })
        .success,
    ).toBe(false);
  });
  it("requires co-created character ink and uploaded image assets", () => {
    const profile = {
      id: "character-1",
      version: 1,
      name: "Tutor",
      origin: "uploaded",
      style: "custom",
      width: 100,
      height: 100,
      createdAt: new Date().toISOString(),
    };
    expect(tutorCharacterProfileSchema.safeParse(profile).success).toBe(false);
    expect(
      tutorCharacterProfileSchema.safeParse({
        ...profile,
        assetPath: "Agent Memory/characters/avatar.png",
      }).success,
    ).toBe(true);
    expect(
      tutorCharacterProfileSchema.safeParse({
        ...profile,
        origin: "co_created",
        objects: [object({ kind: "ink", inkId: "missing" })],
      }).success,
    ).toBe(false);
  });
});

describe("BoardHistory", () => {
  it("exposes a stable render snapshot without copying the full scene on every frame", () => {
    const history = new BoardHistory(board([object()]));
    const snapshot = history.renderDocument;
    expect(history.renderDocument).toBe(snapshot);
    expect(history.document).not.toBe(snapshot);
    history.transact(document => { document.objects[0]!.x = 42; }, "human");
    expect(history.renderDocument).not.toBe(snapshot);
    expect(snapshot.objects[0]!.x).toBe(1);
    expect(history.renderDocument.objects[0]!.x).toBe(42);
  });
  const text = (overrides: Partial<BoardObject> = {}): BoardObject => object({
    kind: "text", text: "为什么会这样？", height: 25,
    textStyle: { font: "handwritten", size: 20, align: "left" }, ...overrides,
  });
  const geometry = (item: BoardObject, height: number): BoardTextGeometryUpdate => ({
    id: item.id, text: item.text!, width: item.width, textStyle: { ...item.textStyle! }, height,
  });

  it("refines font height across history without adding undo steps or changing authorship", () => {
    const history = new BoardHistory(board());
    const item = text();
    history.transact(draft => { draft.objects.push(item, object({ id: "diagram" })); }, "tutor");
    history.transact(draft => { draft.objects[0]!.x = 99; });
    const before = history.document;
    expect(history.refreshTextGeometry([geometry(item, 75)])).toBe(true);
    expect(history.document.revision).toBe(before.revision + 1);
    expect(history.document.objects[0]).toEqual({ ...before.objects[0], height: 75 });
    expect(history.undo()?.objects[0]).toMatchObject({ x: item.x, height: 75 });
    expect(history.undo()?.objects).toEqual([]);
    expect(history.canUndo).toBe(false);
    expect(history.redo()?.objects[0]).toMatchObject({ x: item.x, height: 75 });
    expect(history.redo()?.objects[0]).toMatchObject({ x: 99, height: 75 });
    expect(history.canRedo).toBe(false);
  });

  it("does not revive undone text when fonts finish, and preserves a corrected redo", () => {
    const history = new BoardHistory(board());
    const item = text();
    history.transact(draft => { draft.objects.push(item); });
    history.undo();
    const before = history.document;
    expect(history.refreshTextGeometry([geometry(item, 75)])).toBe(false);
    expect(history.document).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redo()?.objects[0]?.height).toBe(75);
    expect(history.undo()?.objects).toEqual([]);
  });

  it.each([
    { text: "后来输入的新文字" },
    { width: 200 },
    { textStyle: { font: "sans" as const, size: 20, align: "left" as const } },
    { textStyle: { font: "handwritten" as const, size: 30, align: "left" as const } },
    { textStyle: { font: "handwritten" as const, size: 20, align: "right" as const } },
  ])("keeps later text and style edits when an earlier font measurement arrives: %j", change => {
    const item = text(), history = new BoardHistory(board([item]));
    history.transact(draft => { Object.assign(draft.objects[0]!, change); });
    const before = history.document;
    expect(history.refreshTextGeometry([geometry(item, 75)])).toBe(false);
    expect(history.document).toEqual(before);
    expect(history.undo()?.objects[0]).toMatchObject({ text: item.text, width: item.width, height: 75 });
    expect(history.redo()?.objects[0]).toMatchObject({ ...change, height: item.height });
  });

  it("does not change legacy font sizing or manufacture undo for a geometry-only refresh", () => {
    const legacy = text({ textStyle: undefined }), explicit = text({ id: "explicit" });
    const history = new BoardHistory(board([legacy, explicit]));
    expect(history.refreshTextGeometry([
      { ...geometry(explicit, 90), id: legacy.id, textStyle: { font: "sans", size: 25 / 1.2, align: "left" } },
      geometry(explicit, 75),
    ])).toBe(true);
    expect(history.document.objects[0]).toEqual(legacy);
    expect(history.document.objects[1]?.height).toBe(75);
    expect(history.canUndo).toBe(false);
    const revision = history.document.revision;
    expect(history.refreshTextGeometry([geometry(explicit, 75)])).toBe(false);
    expect(history.document.revision).toBe(revision);
  });

  it("rejects invalid geometry batches before changing visible or historical objects", () => {
    const item = text(), history = new BoardHistory(board([item]));
    history.transact(draft => { draft.objects[0]!.x = 99; });
    const before = history.document;
    expect(() => history.refreshTextGeometry([
      geometry(item, 75), { ...geometry(item, Infinity), id: "other" },
    ])).toThrow();
    expect(() => history.refreshTextGeometry([geometry(item, 75), geometry(item, 80)])).toThrow();
    expect(history.document).toEqual(before);
    expect(history.undo()?.objects[0]?.height).toBe(item.height);
    expect(history.redo()?.objects[0]?.height).toBe(item.height);
  });

  it("preserves the latest Markdown anchor metadata through drawing undo/redo without adding history", () => {
    const history = new BoardHistory(board());
    const state = { textVersion: "buffer-1", entries: [{ id: "anchor-1", from: 0, to: 10, quote: "A paragraph", before: "", after: "", aliases: [], status: "located" as const }] };
    expect(history.updateMarkdownAnchors(state)).toBe(true);
    expect(history.canUndo).toBe(false);
    expect(history.updateMarkdownAnchors(state)).toBe(false);
    history.transact(draft => { draft.objects.push(object()); });
    const moved = { ...state, textVersion: "buffer-2", entries: [{ ...state.entries[0]!, from: 20, to: 30 }] };
    history.updateMarkdownAnchors(moved);
    const latestRevision = history.document.revision;
    expect(history.undo()?.objects).toEqual([]);
    expect(history.document.markdownAnchors).toEqual(moved);
    expect(history.document.revision).toBeGreaterThan(latestRevision);
    expect(history.canUndo).toBe(false);
    history.redo();
    expect(history.document.markdownAnchors).toEqual(moved);
    moved.entries[0]!.from = 21;
    expect(history.document.markdownAnchors?.entries[0]?.from).toBe(20);
  });
  it("also protects Tutor objects which the learner has edited", () => {
    const history = new BoardHistory(board([object({ createdBy: "tutor", editedBy: "human" })]));
    expect(() => history.transact(draft => { draft.objects = []; }, "tutor")).toThrow("human objects");
    expect(history.canUndo).toBe(false);
  });
  it("adopts identical split metadata exactly without creating timestamps or losing drawing undo", () => {
    const history = new BoardHistory(board());
    history.transact(draft => { draft.objects.push(object()); });
    const mirror = new BoardHistory(history.document);
    mirror.updateSourceRevision("new-source");
    const expected = mirror.document;
    expected.updatedAt = "2026-09-26T12:39:44.740Z";
    expect(history.receiveMetadata(expected)).toBe(true);
    expect(history.document).toEqual(expected);
    expect(history.undo()?.objects).toEqual([]);
    expect(history.document.sourceRevision).toBe("new-source");
    expect(history.redo()?.objects).toHaveLength(1);
    const changed = history.document;
    changed.objects[0]!.color = "#abcdef";
    expect(history.receiveMetadata(changed)).toBe(false);
    expect(history.document.objects[0]!.color).not.toBe("#abcdef");
  });
  it("refreshes source metadata without consuming an undo step or restoring an old source version", () => {
    const history = new BoardHistory(board());
    history.updateSourceRevision("1:20");
    history.transact((draft) => {
      draft.objects.push(object());
    });
    history.updateSourceRevision("2:40");
    const version = history.document.revision;
    expect(history.undo()?.objects).toEqual([]);
    expect(history.document.sourceRevision).toBe("2:40");
    expect(history.document.revision).toBeGreaterThan(version);
    expect(history.canUndo).toBe(false);
    history.redo();
    expect(history.document.objects).toHaveLength(1);
    expect(history.document.sourceRevision).toBe("2:40");
  });
  it("undoes an entire Tutor response as one group and keeps revisions monotonic", () => {
    const history = new BoardHistory(board());
    history.transact((draft) => {
      draft.objects.push(object(), object({ id: "object-2" }));
    }, "tutor");
    expect(history.document.objects.map((item) => item.createdBy)).toEqual([
      "tutor",
      "tutor",
    ]);
    expect(history.document.revision).toBe(1);
    expect(history.undo()?.objects).toEqual([]);
    expect(history.document.revision).toBe(2);
    expect(history.redo()?.revision).toBe(3);
    expect(history.document.objects[0]?.revision).toBe(2);
    expect(history.document.objects[0]?.createdBy).toBe("tutor");
    expect(history.document.objects[0]?.editedBy).toBe("human");
  });
  it("preserves original authorship when the student edits Tutor objects", () => {
    const history = new BoardHistory(
      board([object({ createdBy: "tutor", editedBy: "tutor" })]),
    );
    history.transact((draft) => {
      draft.objects[0]!.x = 100;
      draft.objects[0]!.createdBy = "human";
    });
    expect(history.document.objects[0]).toMatchObject({
      x: 100,
      createdBy: "tutor",
      editedBy: "human",
      revision: 2,
    });
    history.undo();
    expect(history.document.objects[0]).toMatchObject({
      x: 1,
      createdBy: "tutor",
      revision: 3,
    });
  });
  it("rejects Tutor edits/deletions of student objects without changing history", () => {
    const history = new BoardHistory(board([object()]));
    expect(() =>
      history.transact((draft) => {
        draft.objects[0]!.x = 300;
      }, "tutor"),
    ).toThrow("human objects");
    expect(() =>
      history.transact((draft) => {
        draft.objects = [];
      }, "tutor"),
    ).toThrow("human objects");
    expect(history.canUndo).toBe(false);
    expect(history.document.revision).toBe(0);
  });
  it("clears redo on a new edit and prevents mutation through snapshots", () => {
    const history = new BoardHistory(board());
    history.document.objects.push(object());
    expect(history.document.objects).toEqual([]);
    history.transact((draft) => {
      draft.objects.push(object());
    });
    history.undo();
    history.transact((draft) => {
      draft.objects.push(object({ id: "other" }));
    });
    expect(history.canRedo).toBe(false);
    expect(history.redo()).toBeNull();
  });
  it("leaves revision and history unchanged for no-ops or invalid mutations", () => {
    const history = new BoardHistory(board([object()]));
    history.transact(() => {});
    expect(() =>
      history.transact((draft) => {
        draft.objects[0]!.width = -1;
      }),
    ).toThrow();
    expect(history.document.revision).toBe(0);
    expect(history.canUndo).toBe(false);
  });
});

it("moves every undo and redo locator without adding a history step or changing object identity", () => {
  const history = new BoardHistory(board());
  history.transact(draft => { draft.objects.push(object()); });
  history.transact(draft => { draft.objects[0]!.color = "#ff0000"; });
  history.undo();
  const moved = { ...history.document, sourceFile: "moved.md", revision: history.revision + 1 };
  history.receiveSourceMove(moved);
  expect(history.redo()!.objects[0]!.color).toBe("#ff0000");
  expect(history.document.sourceFile).toBe("moved.md");
  expect(history.undo()!.objects[0]!.id).toBe("object-1");
  expect(history.undo()!.objects).toEqual([]); expect(history.document.sourceFile).toBe("moved.md");
  expect(history.canUndo).toBe(false);
});
it("rejects a changed source-move scene without altering the current or undo states", () => {
  const history = new BoardHistory(board()); history.transact(d => { d.objects.push(object()); });
  const before = history.document;
  expect(() => history.receiveSourceMove({ ...before, sourceFile: "moved.md", objects: [] })).toThrow("board-source-move-scene-changed");
  expect(history.document).toEqual(before); expect(history.undo()!.sourceFile).toBe("lesson.md");
});
