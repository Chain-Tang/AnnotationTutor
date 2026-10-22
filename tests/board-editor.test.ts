// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => {
  const { StateField } = await import("@codemirror/state");
  return {
    editorInfoField: StateField.define({ create: () => ({ file: null }), update: (value) => value }),
    editorLivePreviewField: StateField.define({ create: () => false, update: (value) => value }),
  };
});
import { EditorState, type StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldEffect, unfoldEffect, foldState } from "@codemirror/language";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { BoardAnchorRegistry, indexMarkdownBoardBlocks } from "../src/board-anchors.js";
import { BoardEditorBridge, measureBoardEditorGeometry, type BoardEditorEvent } from "../src/board-editor.js";
import { boardSurfaceLayoutRevision, type BoardSurface } from "../src/board-surfaces.js";

const views: EditorView[] = [], bridges: BoardEditorBridge[] = [];
type Measure = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;
const requests = new Map<EditorView, Measure>();
beforeEach(() => {
  vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation(function (this: EditorView, request) {
    if (request) requests.set(this, request);
  });
});
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const view of views.splice(0)) view.destroy();
  requests.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function geometry(view: EditorView): void {
  vi.spyOn(view, "inView", "get").mockReturnValue(true);
  vi.spyOn(view, "documentTop", "get").mockReturnValue(100);
  vi.spyOn(view, "scaleX", "get").mockReturnValue(1);
  vi.spyOn(view, "scaleY", "get").mockReturnValue(1);
  vi.spyOn(view.contentDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 100, 700, 600));
  vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  const blocks = () => Array.from({ length: view.state.doc.lines }, (_, index) => {
    const line = view.state.doc.line(index + 1);
    return { from: line.from, to: line.to, top: index * 24, bottom: index * 24 + 24, height: 24, length: line.length, type: 0 };
  });
  vi.spyOn(view, "viewportLineBlocks", "get").mockImplementation(() => blocks() as EditorView["viewportLineBlocks"]);
  vi.spyOn(view, "lineBlockAt").mockImplementation((pos) => blocks()[view.state.doc.lineAt(pos).number - 1]! as ReturnType<EditorView["lineBlockAt"]>);
}
function fixture(text: string, path = "Physics.md", live = true, registryMap = new Map<string, BoardAnchorRegistry>()) {
  const events: BoardEditorEvent[] = [];
  const bridge = new BoardEditorBridge({
    getRegistry(source, sourceText) {
      if (!registryMap.has(source)) registryMap.set(source, new BoardAnchorRegistry(sourceText));
      return registryMap.get(source);
    },
    onChange: (event) => events.push(event),
  });
  bridges.push(bridge);
  const create = (source: string, sourceText: string, preview: boolean) => {
    const container = document.createElement("div");
    document.body.append(container);
    const info = editorInfoField as unknown as StateField<{ file: { path: string } }>;
    const mode = editorLivePreviewField as unknown as StateField<boolean>;
    const state = EditorState.create({ doc: sourceText, extensions: [info.init(() => ({ file: { path: source } })), mode.init(() => preview), foldState, bridge.extension] });
    const view = new EditorView({ state, parent: container });
    views.push(view); geometry(view);
    return { container, view };
  };
  const current = create(path, text, live);
  return { ...current, bridge, events, registryMap, create };
}
function measure(view: EditorView): void {
  const request = requests.get(view);
  expect(request).toBeDefined();
  requests.delete(view);
  request!.write?.(request!.read(view), view);
}
const key = (surface: BoardSurface): string => surface.anchor.kind === "markdown" ? surface.anchor.key : "";

describe("CodeMirror board bridge", () => {
  it.each([true, false])("measures editable surfaces in %s Live Preview and maps transactions before any layout read", (live) => {
    const { view, container, bridge, events, registryMap } = fixture("Energy stays constant.", "Physics.md", live);
    expect(bridge.get(container)!.ready).toBe(false);
    expect(view.lineBlockAt).not.toHaveBeenCalled();
    measure(view);
    const before = bridge.get(container)!;
    expect(before.mode).toBe(live ? "live-preview" : "source");
    expect(before.surfaces).toHaveLength(1);
    const id = key(before.surfaces[0]!);
    const oldLayout = boardSurfaceLayoutRevision(before.surfaces[0]!);
    vi.mocked(view.lineBlockAt).mockClear();
    view.dispatch({ changes: { from: 0, insert: "Introduction.\n\n" } });
    const pending = bridge.get(container)!;
    expect(pending.ready).toBe(false);
    expect(pending.bufferRevision).not.toBe(before.bufferRevision);
    expect(view.lineBlockAt).not.toHaveBeenCalled();
    expect(events.some((event) => event.docChanged && !event.state.ready)).toBe(true);
    expect(boardSurfaceLayoutRevision(before.surfaces[0]!)).not.toBe(oldLayout);
    expect(registryMap.get("Physics.md")!.resolve(id)!.from).toBe(15);
    measure(view);
    const after = bridge.get(container)!;
    expect(after.ready).toBe(true);
    expect(after.surfaces.find((surface) => key(surface) === id)!.getClientRect().y).toBe(148);
  });

  it("binds concrete containers and deduplicates mirrored changes in two splits of the same source", () => {
    const { view, container, bridge, create, registryMap } = fixture("Same source.");
    const second = create("Physics.md", "Same source.", false);
    const other = create("Other.md", "Other source.", true);
    measure(view); measure(second.view); measure(other.view);
    expect(bridge.get(container)!.view).toBe(view);
    expect(bridge.get(second.container)!.view).toBe(second.view);
    expect(bridge.get(other.container, "Physics.md")).toBeUndefined();
    const id = registryMap.get("Physics.md")!.entries[0]!.id;
    view.dispatch({ changes: { from: 0, insert: "Start.\n\n" } });
    second.view.dispatch({ changes: { from: 0, insert: "Start.\n\n" } });
    measure(view); measure(second.view);
    expect(registryMap.get("Physics.md")!.resolve(id)!.from).toBe(8);
    expect(bridge.get(other.container)!.surfaces[0]!.text).toBe("Other source.");
    expect(bridge.get(container)!.surfaces.map(key)).toEqual(bridge.get(second.container)!.surfaces.map(key));
  });

  it("keeps a lagging split unready without rewinding shared anchors on refresh or late mirrored transactions", () => {
    const { view, container, bridge, create, registryMap } = fixture("Paragraph.");
    const second = create("Physics.md", "Paragraph.", false);
    measure(view); measure(second.view);
    const oldSurface = bridge.get(second.container)!.surfaces[0]!;
    const oldLayout = boardSurfaceLayoutRevision(oldSurface);
    view.dispatch({ changes: { from: 0, insert: "One.\n\n" } });
    view.dispatch({ changes: { from: 0, insert: "Two.\n\n" } });
    const saved = registryMap.get("Physics.md")!.snapshot();
    expect(bridge.get(second.container)!.ready).toBe(false);
    expect(boardSurfaceLayoutRevision(oldSurface)).not.toBe(oldLayout);
    bridge.refresh();
    measure(view); measure(second.view);
    expect(registryMap.get("Physics.md")!.snapshot()).toEqual(saved);
    expect(bridge.get(container)!.ready).toBe(true);
    expect(bridge.get(second.container)!.ready).toBe(false);
    second.view.dispatch({ changes: { from: 0, insert: "One.\n\n" } });
    measure(second.view);
    expect(registryMap.get("Physics.md")!.snapshot()).toEqual(saved);
    expect(bridge.get(second.container)!.ready).toBe(false);
    second.view.dispatch({ changes: { from: 0, insert: "Two.\n\n" } });
    measure(second.view);
    expect(bridge.get(second.container)!.ready).toBe(true);
    expect(bridge.get(second.container)!.surfaces.map(key)).toEqual(bridge.get(container)!.surfaces.map(key));
  });

  it("suspends visual readiness during composition and invalidates cached snapshots on scroll and teardown", () => {
    const { view, container, bridge, events } = fixture("A paragraph.");
    measure(view);
    const surface = bridge.get(container)!.surfaces[0]!, layout = boardSurfaceLayoutRevision(surface);
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(bridge.get(container)!.composing).toBe(true);
    expect(bridge.get(container)!.ready).toBe(false);
    expect(events.at(-1)!.compositionChanged).toBe(true);
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    measure(view);
    expect(bridge.get(container)!.ready).toBe(true);
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(bridge.get(container)!.ready).toBe(false);
    expect(boardSurfaceLayoutRevision(surface)).not.toBe(layout);
    bridge.dispose();
    expect(bridge.get(container)).toBeUndefined();
    expect(events.at(-1)!.destroyed).toBe(true);
    const count = events.length;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(events).toHaveLength(count);
  });

  it("uses block-widget dimensions for rendered media and hides folds without deleting anchors", () => {
    const text = "# Heading\n\n![[diagram.png]]";
    const { view, registryMap } = fixture(text);
    const registry = registryMap.get("Physics.md")!;
    const media = indexMarkdownBoardBlocks(text)[1]!;
    const block = { from: media.from, to: media.to, top: 50, bottom: 250, height: 200, length: media.to - media.from, type: 3 };
    vi.spyOn(view, "visibleRanges", "get").mockReturnValue([]);
    vi.mocked(view.lineBlockAt).mockReturnValue(block as ReturnType<EditorView["lineBlockAt"]>);
    vi.spyOn(view, "viewportLineBlocks", "get").mockReturnValue([block] as EditorView["viewportLineBlocks"]);
    const geometry = measureBoardEditorGeometry(view, registry);
    expect(geometry).toHaveLength(1);
    expect(geometry[0]!.rect).toMatchObject({ y: 150, height: 200 });
    view.dispatch({ effects: foldEffect.of({ from: media.from, to: media.to }) });
    expect(measureBoardEditorGeometry(view, registry)).toHaveLength(0);
    expect(registry.entries.find((entry) => entry.from === media.from)!.status).toBe("located");
  });

  it("keeps local drawing dimensions independent of editor transforms and hides virtualized or partially folded blocks", () => {
    const text = "- First\n- Second\n- Third";
    const { view, registryMap } = fixture(text);
    const registry = registryMap.get("Physics.md")!;
    vi.spyOn(view, "scaleX", "get").mockReturnValue(2);
    vi.spyOn(view, "scaleY", "get").mockReturnValue(2);
    const measured = measureBoardEditorGeometry(view, registry)[0]!;
    expect(measured).toMatchObject({ width: 350, height: 36, matrix: [2, 0, 0, 2, 20, 100] });
    vi.spyOn(view, "viewportLineBlocks", "get").mockReturnValue([]);
    expect(measureBoardEditorGeometry(view, registry)).toEqual([]);
    expect(registry.entries[0]!.status).toBe("located");
    view.dispatch({ effects: foldEffect.of({ from: 7, to: text.length }) });
    vi.spyOn(view, "viewportLineBlocks", "get").mockReturnValue([{ from: 0, to: text.length, top: 0, bottom: 24 }] as EditorView["viewportLineBlocks"]);
    expect(measureBoardEditorGeometry(view, registry)).toEqual([]);
    expect(registry.entries[0]!.status).toBe("located");
  });

  it("invalidates image-load geometry immediately but reads layout only during the next CM measurement", () => {
    const { view, bridge, container } = fixture("![[image.png]]");
    measure(view);
    const surface = bridge.get(container)!.surfaces[0]!, version = boardSurfaceLayoutRevision(surface);
    vi.mocked(view.lineBlockAt).mockClear();
    view.dom.dispatchEvent(new Event("load"));
    expect(view.lineBlockAt).not.toHaveBeenCalled();
    expect(bridge.get(container)!.ready).toBe(false);
    expect(boardSurfaceLayoutRevision(surface)).not.toBe(version);
    const block = { from: 0, to: view.state.doc.length, top: 0, bottom: 200, height: 200, type: 3 };
    vi.mocked(view.lineBlockAt).mockReturnValue(block as ReturnType<EditorView["lineBlockAt"]>);
    measure(view);
    expect(bridge.get(container)!.surfaces[0]!.getClientRect().height).toBe(200);
  });
});

describe('C60 temporary CodeMirror drawing blocks',()=>{
 it.each([true,false])('restores one drawing block after paragraph-replacement undo in mirrored editors (%s)',live=>{
  const text='# Heading\n\nParagraph.\n',f=fixture(text,'Physics.md',live),second=f.create('Physics.md',text,!live);
  measure(f.view);measure(second.view);
  const registry=f.registryMap.get('Physics.md')!,entry=registry.entries[1]!,id=entry.id,from=entry.from,to=entry.to;
  const specs=[{id:'SLOT-undo',anchorKey:id,width:640,height:264}];
  for(const container of [f.container,second.container])f.bridge.setSlots(container,specs);
  for(const view of [f.view,second.view])view.dispatch({changes:{from:to,to:text.length,insert:'\n Additional explanation.'}});
  for(const container of [f.container,second.container])f.bridge.setSlots(container,specs);
  for(const view of [f.view,second.view])view.dispatch({changes:{from,to:view.state.doc.length,insert:text.slice(from)}});
  for(const container of [f.container,second.container])f.bridge.setSlots(container,specs);
  measure(f.view);measure(second.view);
  expect(registry.resolve(id)).toMatchObject({status:'located',quote:'Paragraph.',from,to});
  for(const container of [f.container,second.container]){
   expect(container.querySelectorAll('[data-board-slot="SLOT-undo"]')).toHaveLength(1);
   expect(bridgeText(container)).toBe(text);
   expect(f.bridge.get(container)!.surfaces.some(s=>key(s)===id)).toBe(true);
  }
  function bridgeText(container:HTMLElement){return f.bridge.get(container)!.view.state.doc.toString();}
 });
 it.each([true,false])('inserts an owned block without source edits, focus changes or learning input (%s)',live=>{
  const f=fixture('First paragraph.\n\nSecond paragraph.','Physics.md',live);measure(f.view);
  const key=f.registryMap.get('Physics.md')!.entries[0]!.id,selection=f.view.state.selection.toJSON(),text=f.view.state.doc.toString();
  f.events.length=0;f.bridge.setSlots(f.container,[{id:'SLOT-c60',anchorKey:key,width:640,height:264}]);
  expect(f.view.dom.querySelector('.atl-board-slot')).not.toBeNull();expect(f.view.state.doc.toString()).toBe(text);
  expect(f.view.state.selection.toJSON()).toEqual(selection);expect(f.events.every(e=>!e.docChanged)).toBe(true);
  measure(f.view);const epoch=f.events.length;f.bridge.setSlots(f.container,[{id:'SLOT-c60',anchorKey:key,width:640,height:264}]);expect(f.events).toHaveLength(epoch);
  f.bridge.setSlots(f.container,[]);expect(f.view.dom.querySelector('.atl-board-slot')).toBeNull();expect(f.view.state.doc.toString()).toBe(text);
 });
 it('hides folded block widgets and restores their identity on expansion',()=>{
  const f=fixture('# Heading\n\nParagraph.\n\nLater.');measure(f.view);const entry=f.registryMap.get('Physics.md')!.entries.find(e=>e.quote==='Paragraph.')!;
  f.bridge.setSlots(f.container,[{id:'SLOT-fold',anchorKey:entry.id,width:640,height:264}]);expect(f.view.dom.querySelector('[data-board-slot="SLOT-fold"]')).not.toBeNull();
  f.view.dispatch({effects:foldEffect.of({from:9,to:24})});expect(f.view.dom.querySelector('[data-board-slot="SLOT-fold"]')).toBeNull();
  f.view.dispatch({effects:unfoldEffect.of({from:9,to:24})});expect(f.view.dom.querySelector('[data-board-slot="SLOT-fold"]')).not.toBeNull();
 });
});


describe("board editor hot-path boundaries", () => {
  it("does not clone anchors for repeated readiness reads or unchanged layout notifications", () => {
    const { view, container, bridge, registryMap, events } = fixture("First.\n\nSecond.");
    const registry = registryMap.get("Physics.md")!;
    const snapshots = vi.spyOn(registry, "snapshot");
    measure(view);
    const shared = events.at(-1)!.state.anchors;
    expect(shared).toBeDefined();
    expect(Object.isFrozen(shared!.entries[0])).toBe(true);
    snapshots.mockClear();
    for (let update = 0; update < 100; update++) {
      expect(bridge.getStatus(container)!.ready).toBe(true);
      view.scrollDOM.dispatchEvent(new Event("scroll"));
      measure(view);
      expect(events.at(-1)!.state.anchors).toBe(shared);
    }
    expect(snapshots).not.toHaveBeenCalled();
    const saved = bridge.get(container)!;
    expect(snapshots).toHaveBeenCalledTimes(1);
    saved.anchors!.entries[0]!.quote = "caller mutation";
    expect(registry.entries[0]!.quote).toBe("First.");
    view.dispatch({ changes: { from: 0, insert: "New.\n\n" } });
    expect(events.at(-1)!.state.anchors).not.toBe(shared);
    expect(shared!.entries[0]!.quote).toBe("First.");
  });

  it("queries only source intervals on screen in a ten-thousand-block document", () => {
    const text = Array.from({ length: 10000 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
    const { view, registryMap } = fixture(text);
    const registry = registryMap.get("Physics.md")!;
    const visible = registry.entries[5000]!;
    // Warm the source index; geometry should never iterate all anchors again.
    registry.entriesIntersecting(visible.from, visible.to);
    const entries = vi.spyOn(registry, "entries", "get");
    const queried = vi.spyOn(registry, "entriesIntersecting");
    const block = { from: visible.from, to: visible.to, top: 0, bottom: 24, height: 24, type: 0 };
    vi.spyOn(view, "viewportLineBlocks", "get").mockReturnValue([block] as EditorView["viewportLineBlocks"]);
    vi.mocked(view.lineBlockAt).mockReturnValue(block as ReturnType<EditorView["lineBlockAt"]>);
    for (let scroll = 0; scroll < 10; scroll++) {
      expect(measureBoardEditorGeometry(view, registry).map(item => item.entryId)).toEqual([visible.id]);
    }
    expect(entries).not.toHaveBeenCalled();
    expect(queried).toHaveBeenCalledTimes(10);
    expect(queried.mock.results.every(result => result.value.length === 1)).toBe(true);
    expect(view.lineBlockAt).toHaveBeenCalledTimes(20);
  });
});
