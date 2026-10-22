import { describe, expect, it } from "vitest";
import {
  BoardConflictError,
  BoardRepository,
  type BoardStorageAdapter,
} from "../src/board-store.js";
import { BoardHistory } from "../src/board-model.js";
import type { BoardObject, TutorCharacterProfile } from "../src/board-types.js";

class MemoryAdapter implements BoardStorageAdapter {
  public readonly files = new Map<string, string>();
  public readonly folders = new Set<string>();
  public readonly writes: string[] = [];
  public readonly reads: string[] = [];
  public failPath: string | undefined;
  public corruptOnFailure = false;
  public async readBinary(path:string):Promise<ArrayBuffer>{return new TextEncoder().encode(await this.read(path)).buffer;}
  public async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  public async read(path: string): Promise<string> {
    this.reads.push(path);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }
  public async write(path: string, value: string): Promise<void> {
    this.writes.push(path);
    if (path === this.failPath) {
      if (this.corruptOnFailure) this.files.set(path, "{interrupted");
      throw new Error("Simulated disk error");
    }
    this.files.set(path, value);
  }
  public async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
  public async list(
    path: string,
  ): Promise<{ files: string[]; folders: string[] }> {
    const child = (candidate: string) =>
      candidate.startsWith(path + "/") &&
      !candidate.slice(path.length + 1).includes("/");
    return {
      files: [...this.files.keys()].filter(child),
      folders: [...this.folders].filter(child),
    };
  }
}

function strokeObject(): BoardObject {
  return {
    id: "ink-object",
    kind: "ink",
    anchor: { kind: "markdown", key: "paragraph", quote: "Hello" },
    x: 1,
    y: 2,
    width: 80,
    height: 40,
    inkId: "INK-original",
    color: "#225566",
    strokeWidth: 2,
    createdBy: "human",
    editedBy: "human",
    revision: 1,
    groupId: "group-1",
  };
}
const stroke = {
  id: "INK-original",
  createdAt: "2026-09-12T00:00:00.000Z",
  points: [
    { x: 0, y: 0 },
    { x: 80, y: 40 },
  ],
};
function setup(root = "Agent Memory") {
  const adapter = new MemoryAdapter();
  return { adapter, repository: new BoardRepository(adapter, root) };
}

describe("BoardRepository", () => {
  it("keeps a standalone work discoverable through its real Vault entry", async () => {
    const { adapter, repository } = setup();
    const bundle = await repository.open("Agent Memory/standalone/temporary.md", "standalone");
    bundle.document.sourceFile = `Agent Memory/boards/${bundle.document.id}.md`;
    await repository.save(bundle.document, bundle.ink, "<svg></svg>");
    const entry = adapter.files.get(`Agent Memory/boards/${bundle.document.id}.md`);
    expect(entry).toContain(`boardId: ${bundle.document.id}`);
    expect(entry).not.toContain(`[[${bundle.document.sourceFile}]]`);
    expect(adapter.files.get(`Agent Memory/boards/${bundle.document.id}.svg`)).toBe("<svg></svg>");
    const writer = new BoardRepository(adapter, "Agent Memory");
    const reopened = await writer.open(bundle.document.sourceFile, "standalone");
    expect(reopened.document.id).toBe(bundle.document.id);
    reopened.document.title = "我的第一幅画";
    reopened.document.revision++;
    // The title is metadata, not a rename of the stable board identity.
    await writer.save(reopened.document, reopened.ink);
    expect(adapter.files.get(`Agent Memory/boards/${bundle.document.id}.md`)).toContain("# 我的第一幅画");
  });
  it("migrates v1 only on first save with an exact durable legacy backup and untouched objects", async () => {
    const { adapter, repository } = setup();
    const fresh = (await repository.open("legacy.md", "markdown")).document;
    const legacy = { ...fresh, schemaVersion: 1 as const, revision: 7, objects: [{ ...strokeObject(), kind: "rect" as const, inkId: undefined }] };
    const path = repository.boardPath(legacy.id);
    const original = JSON.stringify(legacy, null, 4) + "\n";
    adapter.folders.add("Agent Memory/boards");
    adapter.files.set(path, original);
    const reopened = new BoardRepository(adapter, "Agent Memory");
    const bundle = await reopened.open("legacy.md", "markdown");
    expect(bundle.document.schemaVersion).toBe(1);
    expect(adapter.writes).toEqual([]);
    await reopened.save(bundle.document, bundle.ink);
    const migrated = JSON.parse(adapter.files.get(path)!);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.objects).toEqual(JSON.parse(original).objects);
    expect(migrated.revision).toBe(7);
    expect(adapter.files.get(path.replace(".board.json", ".v1.board.json"))).toBe(original);
    expect(adapter.files.get(path.replace(".board.json", ".previous.board.json"))).toBe(original);
    // A controller holding its v1 snapshot can save again without a false conflict.
    await reopened.save(bundle.document, bundle.ink);
    bundle.document.revision++;
    await reopened.save(bundle.document, bundle.ink);
    expect(adapter.files.get(path.replace(".board.json", ".v1.board.json"))).toBe(original);
    expect([...adapter.files.keys()].some(name => name.includes(".conflict-"))).toBe(false);
  });
  it("retains the v1 backup when the migration manifest write is interrupted", async () => {
    const { adapter, repository } = setup();
    const document = (await repository.open("legacy.md", "markdown")).document;
    const path = repository.boardPath(document.id);
    const original = JSON.stringify({ ...document, schemaVersion: 1 });
    adapter.folders.add("Agent Memory/boards");
    adapter.files.set(path, original);
    const reopened = new BoardRepository(adapter, "Agent Memory");
    const bundle = await reopened.open("legacy.md", "markdown");
    adapter.failPath = path;
    adapter.corruptOnFailure = true;
    await expect(reopened.save(bundle.document, bundle.ink)).rejects.toThrow("disk error");
    expect(adapter.files.get(path.replace(".board.json", ".v1.board.json"))).toBe(original);
    const recovered = await new BoardRepository(adapter, "Agent Memory").open("legacy.md", "markdown");
    expect(recovered.document.schemaVersion).toBe(1);
  });
  it("does not create files during reads and shares a source identity before saving", async () => {
    const { adapter, repository } = setup();
    expect(await repository.read("lesson.md", "markdown")).toBeNull();
    const [one, two] = await Promise.all([
      repository.open("lesson.md", "markdown"),
      repository.open("lesson.md", "markdown"),
    ]);
    expect(one.document.id).toBe(two.document.id);
    expect(adapter.files.size).toBe(0);
  });
  it("writes raw ink before the manifest, then reopens without duplicate point data", async () => {
    const { adapter, repository } = setup();
    const bundle = await repository.open("lesson.md", "markdown");
    bundle.document.objects.push(strokeObject());
    bundle.document.revision++;
    bundle.ink[stroke.id] = stroke;
    await repository.save(bundle.document, bundle.ink, "<svg/>");
    const path = repository.boardPath(bundle.document.id),
      raw = adapter.files.get(path)!;
    expect(adapter.writes.indexOf(repository.inkPath(stroke.id))).toBeLessThan(
      adapter.writes.indexOf(path),
    );
    expect(raw).not.toContain('"points"');
    const restored = await new BoardRepository(adapter, "Agent Memory").open(
      "lesson.md",
      "markdown",
    );
    expect(restored).toEqual(bundle);
    expect(adapter.files.get(path.replace(".board.json", ".md"))).toContain(
      "[[lesson.md]]",
    );
    expect(adapter.files.get(path.replace(".board.json", ".svg"))).toBe(
      "<svg/>",
    );
  });
  it("serializes saves and captures mutable inputs when queued", async () => {
    const { adapter, repository } = setup();
    const bundle = await repository.open("lesson.md", "markdown"),
      history = new BoardHistory(bundle.document);
    history.transact((draft) => {
      draft.objects.push(strokeObject());
    });
    const first = history.document,
      saveOne = repository.save(first, { [stroke.id]: stroke });
    first.sourceFile = "accidental.md";
    history.transact((draft) => {
      draft.objects[0]!.x = 90;
    });
    await Promise.all([
      saveOne,
      repository.save(history.document, { [stroke.id]: stroke }),
    ]);
    const stored = JSON.parse(
      adapter.files.get(repository.boardPath(bundle.document.id))!,
    );
    expect(stored).toMatchObject({ sourceFile: "lesson.md", revision: 2 });
    expect(stored.objects[0].x).toBe(90);
  });
  it("retains the previous valid manifest if a write is interrupted", async () => {
    const { adapter, repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    await repository.save(document, {});
    const path = repository.boardPath(document.id);
    adapter.failPath = path;
    adapter.corruptOnFailure = true;
    document.revision++;
    document.characterId = "tutor-book";
    await expect(repository.save(document, {})).rejects.toThrow("disk error");
    await expect(repository.flush()).rejects.toThrow("disk error");
    adapter.failPath = undefined;
    const recovered = await new BoardRepository(adapter, "Agent Memory").open(
      "lesson.md",
      "markdown",
    );
    expect(recovered.document).toMatchObject({
      id: document.id,
      revision: 0,
      characterId: "tutor-round",
    });
  });
  it("keeps an unresolved save failure through unrelated reads until the same board saves", async () => {
    const { adapter, repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    adapter.failPath = repository.boardPath(document.id);
    await expect(repository.save(document, {})).rejects.toThrow("disk error");
    await repository.characters();
    await repository.read("unrelated.md", "markdown");
    await expect(repository.flush()).rejects.toThrow("disk error");
    adapter.failPath = undefined;
    await repository.save(document, {});
    await expect(repository.flush()).resolves.toBeUndefined();
  });
  it("preserves external and local versions instead of overwriting a conflict", async () => {
    const { adapter, repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    await repository.save(document, {});
    const path = repository.boardPath(document.id),
      external = { ...document, revision: 20, characterId: "tutor-book" };
    adapter.files.set(path, JSON.stringify(external));
    expect(await repository.onExternalChange(path)).toMatchObject({
      boardId: document.id,
      stale: true,
    });
    document.revision++;
    const error = (await repository
      .save(document, {})
      .catch((error) => error)) as BoardConflictError;
    expect(error).toBeInstanceOf(BoardConflictError);
    expect(JSON.parse(adapter.files.get(path)!)).toEqual(external);
    expect(JSON.parse(adapter.files.get(error.localPath)!)).toEqual(document);
    expect(
      (await repository.open("lesson.md", "markdown")).document.revision,
    ).toBe(20);
  });
  it("rejects a stale split-view snapshot after a newer save", async () => {
    const { repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    await repository.save(document, {});
    await repository.save({ ...document, revision: 2 }, {});
    await expect(
      repository.save({ ...document, revision: 1 }, {}),
    ).rejects.toBeInstanceOf(BoardConflictError);
  });
  it("does not silently adopt external edits when a second split passively reads", async () => {
    const { adapter, repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    await repository.save(document, {});
    const path = repository.boardPath(document.id);
    adapter.files.set(
      path,
      JSON.stringify({ ...document, characterId: "tutor-book" }),
    );
    expect(
      (await repository.read("lesson.md", "markdown"))?.document.characterId,
    ).toBe("tutor-round");
    await expect(
      repository.save({ ...document, revision: 1 }, {}),
    ).rejects.toBeInstanceOf(BoardConflictError);
    expect(
      (await repository.open("lesson.md", "markdown")).document.characterId,
    ).toBe("tutor-book");
  });
  it("recognizes own writes but does not ignore later external writes", async () => {
    const { adapter, repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    await repository.save(document, {});
    const path = repository.boardPath(document.id);
    expect(await repository.onExternalChange(path)).toBeNull();
    adapter.files.set(path, "external");
    expect(await repository.onExternalChange(path)).not.toBeNull();
  });
  it("uses an adapter's atomic process to catch external changes at commit time", async () => {
    const { adapter, repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    await repository.save(document, {});
    const external = JSON.stringify({
      ...document,
      revision: 15,
      characterId: "tutor-book",
    });
    Object.assign(adapter, {
      process: async (path: string, update: (raw: string) => string) => {
        adapter.files.set(path, external);
        const result = update(external);
        adapter.files.set(path, result);
        return result;
      },
    });
    await expect(
      repository.save({ ...document, revision: 1 }, {}),
    ).rejects.toBeInstanceOf(BoardConflictError);
    expect(adapter.files.get(repository.boardPath(document.id))).toBe(external);
  });
  it("can rebuild previews after a derived-file write failure without changing the manifest", async () => {
    const { adapter, repository } = setup();
    const { document } = await repository.open("lesson.md", "markdown");
    const svgPath = repository
      .boardPath(document.id)
      .replace(".board.json", ".svg");
    adapter.failPath = svgPath;
    await expect(repository.save(document, {}, "<svg/>")).rejects.toThrow(
      "disk error",
    );
    const savedManifest = adapter.files.get(repository.boardPath(document.id));
    adapter.failPath = undefined;
    await repository.save(document, {}, "<svg/>");
    expect(adapter.files.get(repository.boardPath(document.id))).toBe(
      savedManifest,
    );
    expect(adapter.files.get(svgPath)).toBe("<svg/>");
  });
  it("accepts unchanged ink with reordered fields after another view reopens it", async () => {
    const { repository } = setup();const bundle=await repository.open("order.md","markdown");
    bundle.document.objects.push(strokeObject());await repository.save(bundle.document,{[stroke.id]:stroke});
    await repository.open("order.md","markdown");bundle.document.revision++;
    const reordered={points:stroke.points.map(p=>({...p,y:p.y,x:p.x})),createdAt:stroke.createdAt,id:stroke.id};
    await expect(repository.save(bundle.document,{[stroke.id]:reordered})).resolves.toBeUndefined();
    reordered.points[0]!.x++;
    await expect(repository.save(bundle.document,{[stroke.id]:reordered})).rejects.toThrow("Immutable ink");
  });
  it("keeps ink immutable even when an object is moved or resized", async () => {
    const { adapter, repository } = setup();
    const bundle = await repository.open("lesson.md", "markdown");
    bundle.document.objects.push(strokeObject());
    await repository.save(bundle.document, { [stroke.id]: stroke });
    const path = repository.inkPath(stroke.id),
      original = adapter.files.get(path);
    bundle.document.revision++;
    bundle.document.objects[0]!.width = 200;
    await repository.save(bundle.document, { [stroke.id]: stroke });
    expect(adapter.files.get(path)).toBe(original);
    expect(await repository.onExternalChange(path)).toBeNull();
    adapter.files.set(
      path,
      JSON.stringify({ ...stroke, points: [{ x: 999, y: 0 }] }),
    );
    expect(await repository.onExternalChange(path)).toMatchObject({
      boardId: bundle.document.id,
      stale: true,
    });
    adapter.files.set(path, original!);
    await expect(
      repository.save(
        { ...bundle.document, revision: 3 },
        { [stroke.id]: { ...stroke, points: [{ x: 999, y: 1 }] } },
      ),
    ).rejects.toThrow("Immutable ink");
  });
  it("does not reread immutable ink mirrors or sealed packs on each artwork save", async () => {
    const { adapter, repository } = setup();
    const bundle = await repository.open("long-drawing.md", "markdown");
    for (let index = 0; index < 129; index++) {
      const inkId = `INK-${index}`;
      bundle.ink[inkId] = { id: inkId, createdAt: stroke.createdAt, points: [{ x: 0, y: index }, { x: 10, y: index }] };
      bundle.document.objects.push({ ...strokeObject(), id: `OBJ-${index}`, inkId });
    }
    bundle.document.revision++;
    await repository.save(bundle.document, bundle.ink);
    adapter.reads.length = 0;
    adapter.writes.length = 0;
    bundle.document.revision++;
    bundle.document.title = "Updated title";
    await repository.save(bundle.document, bundle.ink);
    expect(adapter.reads.some(path => path.includes("/ink/"))).toBe(false);
    expect(adapter.reads.some(path => path.includes("PACK-000001.inkpack"))).toBe(false);
    expect(adapter.writes.some(path => path.includes("/ink/"))).toBe(false);
  });
  it("keeps roots isolated and source renames preserve the board identity", async () => {
    const { adapter, repository } = setup("Custom/Tutor");
    const bundle = await repository.open("old.md", "markdown");
    await repository.save(bundle.document, {});
    await repository.renameSource("old.md", "Lessons/new.md");
    expect(
      (await repository.open("Lessons/new.md", "markdown")).document.id,
    ).toBe(bundle.document.id);
    expect(await repository.read("old.md", "markdown")).toBeNull();
    expect(
      await new BoardRepository(adapter, "Other Root").read(
        "Lessons/new.md",
        "markdown",
      ),
    ).toBeNull();
    expect(
      [...adapter.files.keys()].every((path) =>
        path.startsWith("Custom/Tutor/"),
      ),
    ).toBe(true);
  });
  it("stores versioned co-created profiles and hydrates ink from a single source", async () => {
    const { adapter, repository } = setup();
    const profile: TutorCharacterProfile = {
      id: "student-tutor",
      version: 1,
      name: "Our Tutor",
      origin: "co_created",
      style: "custom",
      width: 80,
      height: 40,
      createdAt: stroke.createdAt,
      objects: [strokeObject()],
      ink: { [stroke.id]: stroke },
    };
    await repository.saveCharacter(profile);
    expect(
      adapter.files.get(repository.characterPath(profile.id, 1)),
    ).not.toContain('"points"');
    expect(await repository.getCharacter(profile.id, 1)).toEqual(profile);
    await expect(
      repository.saveCharacter({ ...profile, name: "Overwrite" }),
    ).rejects.toThrow("immutable");
    await repository.saveCharacter({ ...profile, version: 2, name: "Next" });
    expect((await repository.characters()).map((item) => item.version)).toEqual(
      [1, 2],
    );
  });
  it("lists saved originals while rejecting paths outside the reference directory",async()=>{
    const {adapter,repository}=setup();
    await adapter.mkdir("Agent Memory/references");
    adapter.files.set("Agent Memory/references/one.png","image-bytes");
    adapter.files.set("Agent Memory/references/one.png.json",JSON.stringify({prompt:"Original character"}));
    adapter.files.set("Agent Memory/references/bad.svg","not-an-image");
    expect(await repository.references()).toEqual([{path:"Agent Memory/references/one.png",prompt:"Original character"}]);
    expect((await repository.readReference("Agent Memory/references/one.png")).mimeType).toBe("image/png");
    for(const path of ["private.png","Agent Memory/references/../private.png","Agent Memory/characters/one.png","https://example.com/image.png"])
      await expect(repository.readReference(path)).rejects.toThrow();
  });
  it("saves and restores a full 6000-stroke reference character without losing editability",async()=>{
    const {repository}=setup();
    const objects:BoardObject[]=Array.from({length:6000},(_,index)=>({...strokeObject(),id:`path-${index}`,kind:"path",inkId:undefined,
      points:[{x:0,y:0},{x:20,y:10}],createdBy:"tutor",editedBy:"tutor",
      characterPart:{id:index<3000?"hair":"clothes",name:index<3000?"头发":"衣服"}}));
    const profile:TutorCharacterProfile={id:"reference-character",version:1,name:"Reference",origin:"co_created",style:"custom",width:80,height:40,createdAt:stroke.createdAt,objects};
    await repository.saveCharacter(profile);
    expect((await repository.getCharacter(profile.id,1))?.objects).toEqual(objects);
    await expect(repository.saveCharacter({...profile,version:2,objects:[...objects,{...objects[0]!,id:"overflow"}]})).rejects.toThrow();
  });
  it("soft-hides custom materials, rejects built-ins, and restores them on a new version", async () => {
    const { adapter, repository } = setup();
    const profile: TutorCharacterProfile = {
      id: "student-sticker", version: 1, name: "Student sticker", origin: "co_created", style: "custom",
      usage: "sticker", width: 80, height: 40, createdAt: stroke.createdAt, objects: [strokeObject()], ink: { [stroke.id]: stroke },
    };
    await repository.saveCharacter(profile);
    expect((await repository.setCharacterHidden(profile.id, true)).hiddenProfileIds).toEqual([profile.id]);
    expect((await repository.characters()).map(item => item.id)).toContain(profile.id);
    const reopened = new BoardRepository(adapter, "Agent Memory");
    expect((await reopened.characterLibraryState()).hiddenProfileIds).toEqual([profile.id]);
    await expect(reopened.setCharacterHidden("tutor-round", true)).rejects.toThrow("Built-in");
    await reopened.saveCharacter({ ...profile, version: 2 });
    expect((await reopened.characterLibraryState()).hiddenProfileIds).toEqual([]);
    expect(adapter.files.has(reopened.characterPath(profile.id, 1))).toBe(true);
  });
  it("hides one built-in expression without hiding its siblings or old artwork", async () => {
    const { adapter, repository } = setup();
    const state = await repository.setBuiltInStickerHidden("tutor-round", "thinking", true);
    expect(state.hiddenStickerKeys).toEqual(["tutor-round:v1:thinking"]);
    expect(state.hiddenProfileIds).toEqual([]);
    const reopened = new BoardRepository(adapter, "Agent Memory");
    expect((await reopened.characterLibraryState()).hiddenStickerKeys).toEqual(["tutor-round:v1:thinking"]);
    await expect(reopened.setBuiltInStickerHidden("student-sticker", "thinking", true)).rejects.toThrow("Unknown");
    expect((await reopened.setBuiltInStickerHidden("tutor-round", "thinking", false)).hiddenStickerKeys).toEqual([]);
  });
  it("rejects unsafe roots and missing image dependencies", async () => {
    const { adapter, repository } = setup();
    expect(() => new BoardRepository(adapter, "../outside")).toThrow(
      "vault-relative",
    );
    await expect(
      repository.saveCharacter({
        id: "image",
        version: 1,
        name: "Image",
        origin: "uploaded",
        style: "custom",
        width: 20,
        height: 20,
        createdAt: stroke.createdAt,
        assetPath: "Agent Memory/characters/missing.png",
      }),
    ).rejects.toThrow("missing");
  });
  it("saves nested versioned sticker dependencies before the parent and preserves old versions", async () => {
    const { adapter, repository } = setup();
    const image: TutorCharacterProfile = { id: "image", version: 1, name: "Image", origin: "uploaded", style: "custom", usage: "sticker", tags: ["smile"], width: 20, height: 20, createdAt: stroke.createdAt, assetPath: "Agent Memory/characters/image.png" };
    adapter.files.set(image.assetPath!, "binary-image");
    const reference = (id: string, version = 1): BoardObject => ({ ...strokeObject(), inkId: undefined, kind: "sticker", assetId: id, assetVersion: version });
    const middle: TutorCharacterProfile = { ...image, id: "middle", origin: "co_created", assetPath: undefined, objects: [reference("image")] };
    const parent: TutorCharacterProfile = { ...middle, id: "parent", objects: [reference("middle")] };
    await repository.saveCharacter(parent, [middle, image]);
    expect(adapter.writes.indexOf(repository.characterPath("image", 1))).toBeLessThan(adapter.writes.indexOf(repository.characterPath("middle", 1)));
    expect(adapter.writes.indexOf(repository.characterPath("middle", 1))).toBeLessThan(adapter.writes.indexOf(repository.characterPath("parent", 1)));
    expect((await repository.getCharacter("parent", 1))?.objects?.[0]).toMatchObject({ assetId: "middle", assetVersion: 1 });
    await repository.saveCharacter({ ...image, version: 2, tags: ["new"] });
    expect((await repository.getCharacter("image", 1))?.tags).toEqual(["smile"]);
    expect((await repository.getCharacter("parent", 1))?.objects?.[0]?.assetVersion).toBe(1);
  });
  it("rejects missing versions, cyclic stickers and image paths outside the asset directory", async () => {
    const { adapter, repository } = setup();
    const make = (id: string, assetId: string): TutorCharacterProfile => ({ id, version: 1, name: id, origin: "co_created", style: "custom", usage: "sticker", width: 80, height: 40, createdAt: stroke.createdAt, objects: [{ ...strokeObject(), inkId: undefined, kind: "sticker", assetId, assetVersion: 1 }] });
    await expect(repository.saveCharacter(make("a", "missing"))).rejects.toThrow("Missing versioned asset");
    await expect(repository.saveCharacter(make("a", "b"), [make("b", "a")])).rejects.toThrow("Recursive");
    expect(adapter.writes).toEqual([]);
    adapter.files.set("private.png", "image");
    await expect(repository.saveCharacter({ ...make("a", "b"), origin: "uploaded", objects: undefined, assetPath: "private.png" })).rejects.toThrow("characters directory");
    await expect(repository.saveCharacter({ ...make("a", "b"), origin: "uploaded", objects: undefined, assetPath: "https://example.com/private.png" })).rejects.toThrow();
  });
  it("resolves built-in sticker references without creating competing built-in copies", async () => {
    const { adapter, repository } = setup();
    await repository.saveCharacter({ id: "our-sticker", version: 1, name: "Our sticker", origin: "co_created", style: "custom", width: 80, height: 40, createdAt: stroke.createdAt, objects: [{ ...strokeObject(), kind: "sticker", inkId: undefined, assetId: "tutor-kaomoji-thinking", assetVersion: 1 }] });
    expect((await repository.getCharacter("our-sticker", 1))?.objects?.[0]?.assetId).toBe("tutor-kaomoji-thinking");
    expect([...adapter.files.keys()].filter(path => path.endsWith(".character.json"))).toHaveLength(1);
  });
  it("chunks immutable v3 ink and recovers a damaged new pack from the previous board snapshot", async () => {
    const { adapter, repository } = setup();
    const bundle = await repository.open("long-session.md", "markdown");
    const makeStroke = (index: number) => ({
      id: `INK-${index}`,
      createdAt: stroke.createdAt,
      points: [{ x: 0, y: index }, { x: 10, y: index }],
    });
    const makeObject = (index: number): BoardObject => ({
      ...strokeObject(), id: `OBJ-${index}`, inkId: `INK-${index}`, groupId: `GROUP-${index}`,
    });
    for (let index = 0; index < 129; index++) {
      bundle.document.objects.push(makeObject(index));
      bundle.ink[`INK-${index}`] = makeStroke(index);
    }
    bundle.document.revision++;
    await repository.save(bundle.document, bundle.ink);
    expect(bundle.document.schemaVersion).toBe(3);
    expect(bundle.document.inkManifest?.packs).toHaveLength(2);
    expect(bundle.document.inkManifest?.packs[0]).toMatchObject({ sealed: true, pointCount: 256 });
    const active = bundle.document.inkManifest!.packs[1]!;
    const activePath = repository.inkPackPath(bundle.document.id, active.id);
    const previousPack = adapter.files.get(activePath);
    bundle.document.objects.push(makeObject(129));
    bundle.ink["INK-129"] = makeStroke(129);
    bundle.document.revision++;
    await repository.save(bundle.document, bundle.ink);
    const nextPath = repository.inkPackPath(bundle.document.id, bundle.document.inkManifest!.packs[1]!.id);
    expect(nextPath).not.toBe(activePath);
    expect(adapter.files.get(activePath)).toBe(previousPack);
    adapter.files.set(nextPath, "{corrupt");
    const recovered = await new BoardRepository(adapter, "Agent Memory").open("long-session.md", "markdown");
    expect(recovered.document.revision).toBe(1);
    expect(recovered.document.objects).toHaveLength(129);
  });
});
