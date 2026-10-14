import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { BoardAnchorRegistry, boardTextVersion, indexMarkdownBoardBlocks } from "../src/board-anchors.js";

describe("shared Markdown board anchors", () => {
  it("indexes source blocks including multiline code/math, tables, lists and callouts", () => {
    const text = "# Heading\nParagraph\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n$$\nx^2\n\ny^2\n$$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n^table\n\n- One\n- Two\n\n> [!note]\n> Explanation\n>\n> More";
    const blocks = indexMarkdownBoardBlocks(text);
    expect(blocks).toHaveLength(7);
    expect(blocks[2]!.quote).toContain("\n\nconst b");
    expect(blocks[3]!.quote).toContain("\n\ny^2");
    expect(blocks[4]!.blockId).toBe("table");
    for (const block of blocks) expect(text.slice(block.from, block.to)).toBe(block.quote);
  });
  it("migrates v1 keys to aliases and retains stable IDs when typing before and inside a block", () => {
    const before = "First.\n\nEnergy stays constant. ^energy";
    const registry = new BoardAnchorRegistry(before, undefined, [{ kind: "markdown", key: "old-key", quote: "Energy stays constant. ^energy", sourceLine: 2 }]);
    const energy = registry.resolve("old-key")!;
    const id = energy.id;
    const changes = ChangeSet.of([{ from: 0, insert: "New introduction.\n\n" }, { from: before.indexOf("constant"), to: before.indexOf("constant") + 8, insert: "the same" }], before.length);
    const next = "New introduction.\n\nFirst.\n\nEnergy stays the same. ^energy";
    expect(changes.apply(Text.of(before.split("\n"))).toString()).toBe(next);
    registry.applyChanges(before, next, changes);
    expect(registry.resolve("old-key")!.id).toBe(id);
    expect(registry.resolve("old-key")!.quote).toBe("Energy stays the same. ^energy");
    expect(registry.resolve("old-key")!.from).toBe(next.indexOf("Energy"));
  });
  it("deduplicates mirrored split transactions instead of shifting source offsets twice", () => {
    const before = "Paragraph.", after = "Intro.\n\nParagraph.";
    const registry = new BoardAnchorRegistry(before), id = registry.entries[0]!.id;
    const changes = ChangeSet.of({ from: 0, insert: "Intro.\n\n" }, before.length);
    expect(registry.applyChanges(before, after, changes)).toBe(true);
    const snapshot = registry.snapshot();
    expect(registry.applyChanges(before, after, changes)).toBe(false);
    expect(registry.snapshot()).toEqual(snapshot);
    expect(registry.resolve(id)!.from).toBe(8);
  });
  it("preserves removed anchors and restores them after text undo, including reopening the board", () => {
    const before = "First.\n\nRemove me.\n\nLast.", after = "First.\n\nLast.";
    const registry = new BoardAnchorRegistry(before), id = registry.entries[1]!.id;
    const changes = ChangeSet.of({ from: 8, to: 20 }, before.length);
    registry.applyChanges(before, after, changes);
    expect(registry.resolve(id)!.status).toBe("missing");
    const restored = new BoardAnchorRegistry(after, registry.snapshot());
    const undo = ChangeSet.of({ from: 8, insert: "Remove me.\n\n" }, after.length);
    restored.applyChanges(after, before, undo);
    expect(restored.resolve(id)!.status).toBe("located");
    expect(restored.resolve(id)!.quote).toBe("Remove me.");
    expect(restored.version).toBe(boardTextVersion(before));
  });
  it("ignores late split mirrors while allowing a real undo to restore an earlier text version", () => {
    const initial = "Text.", first = "One.\n\nText.", second = "Two.\n\nOne.\n\nText.";
    const registry = new BoardAnchorRegistry(initial), id = registry.entries[0]!.id;
    const change1 = ChangeSet.of({ from: 0, insert: "One.\n\n" }, initial.length);
    const change2 = ChangeSet.of({ from: 0, insert: "Two.\n\n" }, first.length);
    registry.applyChanges(initial, first, change1);
    registry.applyChanges(first, second, change2);
    expect(registry.applyChanges(initial, first, change1)).toBe(false);
    expect(registry.resolve(id)!.from).toBe(12);
    expect(registry.applyChanges(second, first, ChangeSet.of({ from: 0, to: 6 }, second.length))).toBe(true);
    expect(registry.resolve(id)!.from).toBe(6);
  });
  it("restores stable IDs when Obsidian undoes an appended line by replacing its entire paragraph",()=>{
    const before="# Lesson\n\nA duplicate.\n\nA duplicate.\n",registry=new BoardAnchorRegistry(before);
    const ids=registry.entries.map(e=>e.id);
    const id=registry.entries[2]!.id,from=registry.entries[2]!.from,to=registry.entries[2]!.to;
    const appended="\n An extra explanation.",edit=ChangeSet.of({from:to,to:before.length,insert:appended},before.length);
    const after=edit.apply(Text.of(before.split('\n'))).toString();
    registry.applyChanges(before,after,edit);
    expect(registry.resolve(id)).toMatchObject({status:'located',quote:'A duplicate.'+appended});
    const undo=ChangeSet.of({from,to:after.length,insert:before.slice(from)},after.length);
    registry.applyChanges(after,before,undo);
    expect(registry.resolve(id)).toMatchObject({status:'located',from,to,quote:'A duplicate.'});
    expect(registry.entries.filter(e=>e.status==='located').map(e=>e.id)).toEqual(ids);
    const snapshot=registry.snapshot();
    expect(registry.applyChanges(before,after,edit)).toBe(true);
    expect(registry.applyChanges(after,before,undo)).toBe(true);
    expect(registry.snapshot()).toEqual(snapshot);
    // A late mirrored update must not restore the edited version again.
    expect(registry.applyChanges(before,after,edit)).toBe(true);
    expect(registry.applyChanges(before,before,ChangeSet.empty(before.length))).toBe(false);
    expect(registry.version).toBe(boardTextVersion(after));
  });
  it("does not revive old IDs for a replacement whose full document differs from the former source",()=>{
    const before='Intro.\n\nOriginal.',registry=new BoardAnchorRegistry(before),id=registry.entries[1]!.id;
    const after='Intro.\n\nEdited.';
    registry.applyChanges(before,after,ChangeSet.of({from:8,to:before.length,insert:'Edited.'},before.length));
    registry.applyChanges(after,'Changed.\n\nOriginal.\n\nOriginal.',ChangeSet.of({from:0,to:after.length,insert:'Changed.\n\nOriginal.\n\nOriginal.'},after.length));
    expect(registry.resolve(id)?.status).toBe('missing');
  });
  it("does not let an older tombstone steal a still-located block edited to the same text", () => {
    const initial = "Same.\n\nSome.", registry = new BoardAnchorRegistry(initial);
    const removedId = registry.entries[0]!.id, liveId = registry.entries[1]!.id;
    registry.applyChanges(initial, "Some.", ChangeSet.of({ from: 0, to: 7 }, initial.length));
    registry.applyChanges("Some.", "Same.", ChangeSet.of({ from: 1, to: 2, insert: "a" }, 5));
    expect(registry.resolve(removedId)!.status).toBe("missing");
    expect(registry.resolve(liveId)).toMatchObject({ status: "located", quote: "Same.", from: 0 });
  });
  it("does not silently map deleted text onto its replacement or an ambiguous repeated paragraph", () => {
    const registry = new BoardAnchorRegistry("Old paragraph."), id = registry.entries[0]!.id;
    registry.applyChanges("Old paragraph.", "New paragraph.", ChangeSet.of({ from: 0, to: 14, insert: "New paragraph." }, 14));
    expect(registry.resolve(id)!.status).toBe("missing");
    registry.reconcile("Old paragraph.\n\nOld paragraph.");
    expect(registry.resolve(id)!.status).toBe("missing");
  });
  it("keeps repeated-paragraph IDs through unrelated insertion and treats split/merge as unresolved", () => {
    const before = "Again.\n\nAgain.";
    const registry = new BoardAnchorRegistry(before), ids = registry.entries.map((entry) => entry.id);
    registry.applyChanges(before, "Header.\n\n" + before, ChangeSet.of({ from: 0, insert: "Header.\n\n" }, before.length));
    expect(ids.map((id) => registry.resolve(id)!.from)).toEqual([9, 17]);
    const text = "A long paragraph.", split = "A long\n\n paragraph.";
    const splitRegistry = new BoardAnchorRegistry(text), id = splitRegistry.entries[0]!.id;
    splitRegistry.applyChanges(text, split, ChangeSet.of({ from: 6, insert: "\n\n" }, text.length));
    expect(splitRegistry.resolve(id)!.status).toBe("missing");
  });
  it("hydrates a stable registry without regenerating IDs or mutating caller state", () => {
    const text = "Intro.\n\nA paragraph.", registry = new BoardAnchorRegistry(text);
    const saved = registry.snapshot(), copy = structuredClone(saved);
    const reopened = new BoardAnchorRegistry(text, saved);
    expect(reopened.snapshot()).toEqual(saved);
    reopened.reconcile("Changed.");
    expect(saved).toEqual(copy);
  });
});
