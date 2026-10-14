import { ViewPlugin, Decoration, WidgetType, type DecorationSet, EditorView, type ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { foldedRanges } from "@codemirror/language";
import { editorInfoField, editorLivePreviewField, type MarkdownFileInfo } from "obsidian";
import { BoardAnchorRegistry, boardTextVersion } from "./board-anchors.js";
import { invertBoardMatrix, transformBoardPoint, type BoardSurface } from "./board-surfaces.js";
import type { BoardMarkdownAnchorState, BoardMatrix, BoardRect } from "./board-types.js";

import { createBoardSlotElement } from "./board-projection.js";
import type { BoardSlotSpec } from "./board-layout.js";
type SlotPosition=BoardSlotSpec&{pos:number};
const slotEffect=StateEffect.define<readonly SlotPosition[]>();
class SlotWidget extends WidgetType {
  constructor(readonly spec:BoardSlotSpec){super();}
  override eq(other:SlotWidget):boolean{return JSON.stringify(this.spec)===JSON.stringify(other.spec);}
  toDOM(view:EditorView):HTMLElement{return createBoardSlotElement(view.dom.ownerDocument,this.spec);}
  override get estimatedHeight():number{return this.spec.height;}
  override ignoreEvent():boolean{return true;}
}
const slotsField=StateField.define<{slots:readonly SlotPosition[];decorations:DecorationSet}>({
  create:()=>({slots:[],decorations:Decoration.none}),
  update(value,tr){
    let slots=value.slots.map(s=>({...s,pos:tr.changes.mapPos(s.pos,1)}));
    for(const effect of tr.effects)if(effect.is(slotEffect))slots=[...effect.value];
    const folds:Array<{from:number;to:number}>=[];foldedRanges(tr.state).between(0,tr.state.doc.length,(from,to)=>{folds.push({from,to});});
    const decorations=Decoration.set(slots.filter(s=>s.pos<=tr.state.doc.length&&!folds.some(f=>s.pos>f.from&&s.pos<=f.to)).map((s,index)=>Decoration.widget({widget:new SlotWidget(s),block:true,side:1+index}).range(s.pos)),true);
    return {slots,decorations};
  },provide:field=>EditorView.decorations.from(field,v=>v.decorations)
});

export type BoardEditorState = {
  view: EditorView;
  sourcePath: string;
  mode: "live-preview" | "source";
  composing: boolean;
  bufferRevision: string;
  ready: boolean;
  surfaces: BoardSurface[];
  anchors?: BoardMarkdownAnchorState;
};
export type BoardEditorEvent = {
  state: BoardEditorState;
  docChanged: boolean;
  compositionChanged: boolean;
  layoutChanged: boolean;
  destroyed: boolean;
};
export type BoardEditorCallbacks = {
  /** Return the shared source registry only when a board has actually opened. */
  getRegistry(sourcePath: string, text: string): BoardAnchorRegistry | undefined;
  /** Updates invalidate snapshots immediately; geometry arrives after CM measures. */
  onChange(event: BoardEditorEvent): void;
};

/** Public CM host bridge; no active-leaf lookup and no mutation of contentDOM. */
export class BoardEditorBridge {
  public readonly extension: Extension;
  private readonly clients = new Set<BoardEditorClient>();
  private disposed = false;
  public constructor(private readonly callbacks: BoardEditorCallbacks) {
    const bridge = this;
    this.extension = [slotsField, ViewPlugin.fromClass(class {
      private readonly client: BoardEditorClient;
      constructor(view: EditorView) {
        this.client = new BoardEditorClient(view, callbacks);
        if (bridge.disposed) this.client.destroy();
        else bridge.clients.add(this.client);
      }
      update(update: ViewUpdate): void { this.client.update(update); }
      docViewUpdate(): void { this.client.documentViewChanged(); }
      destroy(): void {
        bridge.clients.delete(this.client);
        this.client.destroy();
      }
    })];
  }
  public setSlots(container:HTMLElement,specs:readonly BoardSlotSpec[]):void {
    const candidates=[...this.clients].filter(client=>container.contains(client.view.dom));
    const outer=candidates.find(client=>!candidates.some(other=>other!==client&&other.view.dom.contains(client.view.dom)));
    outer?.setSlots(specs);
  }
  public get(container: HTMLElement, sourcePath?: string): BoardEditorState | undefined {
    const candidates = [...this.clients].filter((client) => container.contains(client.view.dom)
      && client.view.dom.ownerDocument === container.ownerDocument
      && (!sourcePath || client.sourcePath === sourcePath));
    // Embedded code/table editors may live inside the main editor. Prefer its
    // outer CM instance, while still distinguishing two splits of the same file.
    const outer = candidates.find((client) => !candidates.some((other) => other !== client && other.view.dom.contains(client.view.dom)));
    return outer?.snapshot();
  }
  public refresh(container?: HTMLElement): void {
    for (const client of this.clients)
      if (!container || container.contains(client.view.dom)) client.refresh();
  }
  public dispose(): void {
    this.disposed = true;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
  }
}

type EditorGeometry = { entryId: string; rect: BoardRect; matrix: BoardMatrix; width: number; height: number };

/** Geometry reads are confined to CM's measurement phase. */
export function measureBoardEditorGeometry(view: EditorView, registry: BoardAnchorRegistry): EditorGeometry[] {
  if (!view.inView) return [];
  const folds: Array<{ from: number; to: number }> = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { folds.push({ from, to }); });
  const visible = view.viewportLineBlocks;
  const content = view.contentDOM.getBoundingClientRect(), viewport = view.scrollDOM.getBoundingClientRect();
  const scaleX = view.scaleX || 1, scaleY = view.scaleY || 1;
  const result: EditorGeometry[] = [];
  for (const entry of registry.entries) {
    if (entry.status !== "located" || entry.to > view.state.doc.length || entry.from >= entry.to) continue;
    if (folds.some((fold) => fold.from < entry.to && fold.to > entry.from)) continue;
    // Rendered image/math replacement widgets appear in line blocks even when
    // their source is absent from visibleRanges. Fold placeholders were removed above.
    if (!visible.some((block) => block.from <= entry.to && block.to >= entry.from && block.bottom + view.documentTop > viewport.top && block.top + view.documentTop < viewport.bottom)) continue;
    const first = view.lineBlockAt(entry.from), last = view.lineBlockAt(Math.max(entry.from, entry.to - 1));
    const top = view.documentTop + first.top;
    const rect = { x: content.left, y: top, width: content.width, height: Math.max(1, last.bottom - first.top) };
    if (rect.width <= 0 || rect.y + rect.height <= viewport.top || rect.y >= viewport.bottom) continue;
    result.push({ entryId: entry.id, rect, matrix: [scaleX, 0, 0, scaleY, rect.x, rect.y], width: rect.width / scaleX, height: rect.height / scaleY });
  }
  return result;
}

class BoardEditorClient {
  public sourcePath = "";
  private mode: BoardEditorState["mode"] = "source";
  private composing = false;
  private epoch = 0;
  private text = "";
  private version = "";
  private ready = false;
  private surfaces: BoardSurface[] = [];
  private registry: BoardAnchorRegistry | undefined;
  private destroyed = false;
  private measurePending = false;
  private readonly cleanups: Array<() => void> = [];
  public constructor(public readonly view: EditorView, private readonly callbacks: BoardEditorCallbacks) {
    this.readIdentity();
    this.text = view.state.doc.toString();
    this.version = boardTextVersion(this.text);
    this.registry = this.sourcePath ? callbacks.getRegistry(this.sourcePath, this.text) : undefined;
    const listen = (type: string, callback: EventListener) => {
      view.dom.addEventListener(type, callback, true);
      this.cleanups.push(() => view.dom.removeEventListener(type, callback, true));
    };
    listen("compositionstart", () => this.composition(true));
    listen("compositionend", () => this.composition(false));
    const scrolled = () => { this.invalidate(); this.notify(false, false); this.requestMeasure(); };
    view.scrollDOM.addEventListener("scroll", scrolled, { passive: true });
    this.cleanups.push(() => view.scrollDOM.removeEventListener("scroll", scrolled));
    // Obsidian widgets may load resources after their initial CM transaction.
    listen("load", () => { this.invalidate(); this.requestMeasure(); });
    this.requestMeasure();
  }
  private readIdentity(): void {
    // Obsidian's .d.ts imports CM through CJS while this package is ESM. The
    // host external guarantees one runtime field despite the dual TS identity.
    this.sourcePath = this.view.state.field(editorInfoField as unknown as StateField<MarkdownFileInfo>, false)?.file?.path ?? "";
    this.mode = this.view.state.field(editorLivePreviewField as unknown as StateField<boolean>, false) ? "live-preview" : "source";
  }
  public snapshot(): BoardEditorState {
    const ready = this.ready && !this.destroyed && !this.composing && !this.view.composing && this.registry?.version === this.version;
    return { view: this.view, sourcePath: this.sourcePath, mode: this.mode, composing: this.composing || this.view.composing,
      bufferRevision: `${this.version}:${this.epoch}`, ready,
      surfaces: ready ? this.surfaces : [], ...(this.registry ? { anchors: this.registry.snapshot() } : {}) };
  }
  public update(update: ViewUpdate): void {
    if (this.destroyed) return;
    const beforeSource = this.sourcePath, beforeMode = this.mode;
    this.readIdentity();
    const identityChanged = beforeSource !== this.sourcePath;
    const changed = update.docChanged || identityChanged;
    if (changed) {
      const before = this.text;
      this.text = update.state.doc.toString();
      this.version = boardTextVersion(this.text);
      this.registry = this.sourcePath ? this.callbacks.getRegistry(this.sourcePath, this.text) : undefined;
      if (!identityChanged) this.registry?.applyChanges(before, this.text, update.changes);
    }
    if (changed || beforeMode !== this.mode || update.viewportChanged || update.geometryChanged || update.selectionSet || update.focusChanged) {
      this.invalidate();
      this.notify(changed, false);
      this.requestMeasure();
    }
  }
  private composition(active: boolean): void {
    if (this.destroyed) return;
    this.composing = active;
    this.invalidate();
    this.notify(false, true);
    if (!active) this.requestMeasure();
  }
  private invalidate(): void { this.epoch++; this.ready = false; }
  private notify(docChanged: boolean, compositionChanged: boolean, layoutChanged = true, destroyed = false): void {
    this.callbacks.onChange({ state: this.snapshot(), docChanged, compositionChanged, layoutChanged, destroyed });
  }
  public refresh(): void {
    if (this.destroyed) return;
    this.readIdentity();
    this.registry = this.sourcePath ? this.callbacks.getRegistry(this.sourcePath, this.text) : undefined;
    this.invalidate();
    this.requestMeasure();
  }
  public documentViewChanged(): void {
    if (this.destroyed) return;
    this.invalidate();
    this.notify(false, false);
    this.requestMeasure();
  }
  private slotKey="[]";
  public setSlots(specs:readonly BoardSlotSpec[]):void {
    if(this.destroyed||this.composing||this.view.composing)return;
    const slots=specs.flatMap(spec=>{const entry=this.registry?.resolve(spec.anchorKey);return entry?.status==="located"?[{...spec,pos:this.view.state.doc.lineAt(Math.min(entry.to,this.view.state.doc.length)).to}]:[];});
    const key=JSON.stringify(slots);if(key===this.slotKey)return;this.slotKey=key;
    // Effects alter presentation only; no document change and no text undo item.
    this.view.dispatch({effects:slotEffect.of(slots)});this.invalidate();this.requestMeasure();
  }
  public requestMeasure(): void {
    if (this.destroyed || this.measurePending) return;
    this.measurePending = true;
    this.view.requestMeasure({
      key: this,
      read: () => ({ epoch: this.epoch, registryVersion: this.registry?.version,
        geometry: this.registry?.version === this.version && !this.composing && !this.view.composing ? measureBoardEditorGeometry(this.view, this.registry) : [] }),
      write: ({ epoch, registryVersion, geometry }) => {
        this.measurePending = false;
        if (this.destroyed) return;
        if (epoch !== this.epoch || registryVersion !== this.registry?.version) { this.requestMeasure(); return; }
        const registry = this.registry;
        this.surfaces = registry ? geometry.flatMap((item): BoardSurface[] => {
          const entry = registry.resolve(item.entryId);
          if (!entry || entry.status !== "located") return [];
          const matrix = item.matrix;
          return [{ id: `md:${entry.id}`, kind: "markdown", element: this.view.contentDOM, viewportElement: this.view.scrollDOM,
            anchor: registry.anchor(entry), anchorAliases: entry.aliases, text: this.text.slice(entry.from, entry.to),
            width: item.width, height: item.height, getClientRect: () => ({ ...item.rect }),
            getLayoutVersion: () => `${this.sourcePath}:${this.mode}:${this.version}:${this.registry?.version}:${this.epoch}:${this.destroyed}`,
            toClient: () => matrix, project: (point) => transformBoardPoint(matrix, point), unproject: (point) => transformBoardPoint(invertBoardMatrix(matrix), point) }];
        }) : [];
        this.ready = !this.composing && !this.view.composing && this.registry?.version === this.version;
        this.notify(false, false);
      },
    });
  }
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.invalidate();
    for (const cleanup of this.cleanups) cleanup();
    this.surfaces = [];
    this.notify(false, false, true, true);
  }
}
