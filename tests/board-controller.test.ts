// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardAnchorRegistry } from "../src/board-anchors.js";
import type { App } from "obsidian";
const { capture, notice } = vi.hoisted(() => ({
  capture: vi.fn(),
  notice: vi.fn(),
}));
vi.mock("obsidian", async () => {
  const { StateField } = await import("@codemirror/state");
  return {
  editorInfoField: StateField.define({ create: () => ({ file: null }), update: (value) => value }),
  editorLivePreviewField: StateField.define({ create: () => false, update: (value) => value }),
  Notice: class {
    constructor(message: string) {
      notice(message);
    }
  },
  TFile: class {},
  View: class {},
  setIcon: (element: HTMLElement, icon: string) => { element.dataset.icon = icon; },
  Modal: class {
    containerEl = document.createElement("div");
    onClose?: () => void;
    titleEl = document.createElement("h2");
    contentEl = document.createElement("div");
    open() {
      this.contentEl.classList.add("test-modal");
      document.body.append(this.titleEl, this.contentEl);
    }
    close() {
      this.titleEl.remove();
      this.contentEl.remove();
      this.onClose?.();
    }
  },
  };
});
vi.mock("../src/board-capture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/board-capture.js")>()),
  captureBoardSnapshot: capture,
}));
// Real font subset/loading behavior is covered in board-fonts.test.ts; keep
// controller tests focused on editing, transactions and rendered geometry.
vi.mock("../src/board-fonts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/board-fonts.js")>()),
  ensureBoardFonts: vi.fn(async () => {}),
  boardFontSvgCss: vi.fn(async () => ""),
}));

import { TutorConversation, type TutorSubmitOptions } from "../src/tutor-conversation.js";
import type { ChatContext } from "../src/chat-prompt.js";
import { contextVersion } from "../src/teaching-policy.js";
import { hasLocalLearnerAuthority, permitsLearningControl } from "../src/learning-control-v3.js";
import { ImageContentRefusal } from "../src/board-image-error.js";
import * as boardFonts from "../src/board-fonts.js";
import { InspirationBoards } from "../src/board-controller.js";
import { EditorState, Transaction, type StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldState } from "@codemirror/language";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import type { BoardEditorState } from "../src/board-editor.js";
import { boardSurfaceLayoutRevision, BoardCaptureError } from "../src/board-capture.js";
import { createBoardDocument, type BoardHistory } from "../src/board-model.js";
import { overlaps } from "../src/board-placement.js";
import type { DrawingSpace } from "../src/board-placement.js";
import type { TutorBoardSurface, BoardSurfaceOperation } from "../src/tutor-board-surface.js";
import type { ChangeSet } from "../src/tutor-surface.js";
import { DEFAULT_SETTINGS } from "../src/settings-config.js";
import {
  discoverBoardSurfaces,
  registerMarkdownBoardSection,
  multiplyBoardMatrices,
  type BoardSurface,
} from "../src/board-surfaces.js";
import type {
  ImageGenerationProvider,
  BoardAgent,
  BoardAgentRequest,
  BoardAgentResult,
  BoardAgentEvent,
  BoardObject,
  BoardDocument,
  BoardBundle,
  BoardAnchor,
  TutorCharacterProfile,
} from "../src/board-types.js";
import {
  BoardRepository,
  type BoardStorageAdapter,
  type BoardSourceMoveParticipant,
} from "../src/board-store.js";
import { BoardDraftStore, type BoardDraftIO } from "../src/board-draft.js";
import { t } from "../src/i18n.js";
import { surfaceJournalFixture } from "./surface-journal-fixture.js";

class MemoryAdapter implements BoardStorageAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  failWrites = false;
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw Error("missing");
    return value;
  }
  async write(path: string, content: string): Promise<void> {
    if (this.failWrites) throw Error("disk unavailable");
    this.files.set(path, content);
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> { this.files.set(path, Array.from(new Uint8Array(data)).join(",")); }
  async readBinary(path:string):Promise<ArrayBuffer> { return Uint8Array.from((this.files.get(path)??"").split(",").map(Number)).buffer; }
  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return {
      files: [...this.files.keys()].filter(
        (item) =>
          item.startsWith(path + "/") &&
          !item.slice(path.length + 1).includes("/"),
      ),
      folders: [],
    };
  }
}
type TestView = Parameters<InspirationBoards["toggle"]>[0] & {
  containerEl: HTMLElement;
};
const managers: InspirationBoards[] = [];
const codeMirrorViews: EditorView[] = [];
type EditorMeasure = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;
const editorMeasures = new Map<EditorView, EditorMeasure>();

const nativeElementRect=HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  vi.useFakeTimers();
  // The browser lays out temporary blocks after prose. happy-dom needs this
  // geometry boundary mocked; source DOM and controller projection stay real.
  HTMLElement.prototype.getBoundingClientRect=function(this:HTMLElement){
    if(this.classList.contains('atl-board-slot')){
      const previous=this.previousElementSibling?.getBoundingClientRect();
      return new DOMRect(previous?.x??20,previous?.bottom??300,previous?.width??700,parseFloat((this.firstElementChild as HTMLElement).style.height));
    }
    if(this.classList.contains('atl-board-slot-space')){
      const parent=this.parentElement!,r=parent.getBoundingClientRect();return new DOMRect(r.x-parent.scrollLeft,r.y,parseFloat(this.style.width),parseFloat(this.style.height));
    }
    return nativeElementRect.call(this);
  };
  notice.mockReset();
  capture.mockReset();
  vi.mocked(boardFonts.ensureBoardFonts).mockReset().mockResolvedValue(undefined);
  // happy-dom aliases every Alt press to AltGraph; browsers distinguish the
  // normal shortcut modifier from a keyboard layout's character-entry modifier.
  const modifierState = KeyboardEvent.prototype.getModifierState;
  vi.spyOn(KeyboardEvent.prototype, "getModifierState").mockImplementation(function (this: KeyboardEvent, key) {
    return key === "AltGraph" ? false : modifierState.call(this, key);
  });
  // CM's state, transactions and ViewPlugin are real. Only the host's layout
  // measurement boundary is controlled because happy-dom does not lay out text.
  vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation(function (this: EditorView, request) {
    if (request) editorMeasures.set(this, request);
  });
  vi.stubGlobal("Option", function (text: string, value: string) {
    const option = document.createElement("option");
    option.textContent = text;
    option.value = value;
    return option;
  });
  Object.defineProperty(HTMLElement.prototype, "createEl", {
    configurable: true,
    value(
      this: HTMLElement,
      tag: string,
      options: Record<string, string> = {},
    ) {
      const element = this.ownerDocument.createElement(tag);
      for (const [key, value] of Object.entries(options)) {
        if (key === "text") element.textContent = value;
        else if (key === "cls") element.className = value;
        else element.setAttribute(key, value);
      }
      this.append(element);
      return element;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "addClass", {
    configurable: true,
    value(this: HTMLElement, name: string) {
      this.classList.add(name);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "createDiv", {
    configurable: true,
    value(this: HTMLElement, options: Record<string, string> = {}) {
      return this.createEl("div", options);
    },
  });
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: [...text].length * 12 }),
    } as unknown as CanvasRenderingContext2D,
    {
      get: (target, key) => Reflect.get(target, key) ?? (() => {}),
      set: (target, key, value) => Reflect.set(target, key, value),
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
    window.setTimeout(() => callback(0), 16),
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) =>
    window.clearTimeout(handle),
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  capture.mockImplementation(async (surface: BoardSurface) => ({
    pngBase64: "aGVsbG8=",
    width: 600,
    height: 400,
    imageToBoard: [1, 0, 0, 1, 0, 0],
    anchor: surface.anchor,
    layoutRevision: boardSurfaceLayoutRevision(surface),
  }));
});
afterEach(async () => {
  for (const manager of managers.splice(0))
    await manager.dispose().catch(() => {});
  for (const editor of codeMirrorViews.splice(0)) editor.destroy();
  editorMeasures.clear();
  await vi.advanceTimersByTimeAsync(50);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  HTMLElement.prototype.getBoundingClientRect=nativeElementRect;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function view(path = "Physics.md"): TestView {
  const containerEl = document.createElement("div");
  containerEl.innerHTML =
    '<div class="view-content"><div class="markdown-preview-view"><div class="markdown-preview-section"><div><p>Energy stays constant.</p></div></div></div></div>';
  document.body.append(containerEl);
  for (const item of [
    containerEl,
    ...containerEl.querySelectorAll(
      ".view-content, .markdown-preview-view, .markdown-preview-section",
    ),
  ]) {
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
  }
  const paragraph = containerEl.querySelector<HTMLElement>(
    ".markdown-preview-section > div",
  )!;
  vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 100, 700, 200),
  );
  registerMarkdownBoardSection(paragraph, path, {
    lineStart: 0,
    lineEnd: 0,
    text: "Energy stays constant. ^energy",
  });
  return {
    containerEl,
    file: { path, extension: "md", stat: { mtime: 1, size: 20 } },
    getMode: () => "preview",
    getViewData: () => sourceText,
    getViewType: () => "markdown",
    addAction: (_icon: string, title: string, click: () => void) => {
      const button = document.createElement("button");
      button.textContent = title;
      button.onclick = click;
      containerEl.append(button);
      return button;
    },
  } as unknown as TestView;
}
function setup(views = [view()], agent?: BoardAgent, conversation?: TutorConversation, imageProvider?: ImageGenerationProvider,
  captureConversationContext?: (view: TestView) => Promise<ChatContext>, drafts?: BoardDraftStore,
  sourceMoveParticipants?: (source: string) => BoardSourceMoveParticipant[]) {
  const adapter = new MemoryAdapter(),
    settings = {
      ...DEFAULT_SETTINGS,
      memoryRoot: "Board Memory",
      boardAnimate: false,
    };
  const active = { view: views[0] };
  const actualAgent: BoardAgent = agent ?? {
    request: vi.fn(async () => ({
      ok: false as const,
      error: "No configured model",
    })),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
  const app = {
    vault: { adapter },
    workspace: {
      activeLeaf: active,
      openLinkText: vi.fn(),
      iterateAllLeaves: (callback: (leaf: { view: TestView }) => void) => {
        for (const target of views) callback({ view: target });
      },
    },
  } as unknown as App;
  const transactions=surfaceJournalFixture();
  const manager = new InspirationBoards({
    app, drafts,
    conversation,
    captureConversationContext,
    sourceMoveParticipants,
    transactions:transactions.journal,
    settings: () => settings,
    saveSettings: async () => {},
    createAgent: () => actualAgent,
    createImageProvider: () => imageProvider ?? null,
    dismissPdfSelection: vi.fn(),
  });
  managers.push(manager);
  return { manager, adapter, settings, agent: actualAgent, views, active, app,transactions };
}

const sourceText = "Energy stays constant. ^energy";
type LayerProbe = {
  bundle(): BoardBundle;
  history: { canUndo: boolean; canRedo: boolean };
  selection: Set<string>;
  editorState(): BoardEditorState | undefined;
  surfaceFor(anchor: BoardAnchor): BoardSurface | undefined;
};
type DraftValidationProbe = LayerProbe & {
  history: BoardHistory;
  surfaces: BoardSurface[];
  draw(): void;
  drawingSpace(surface: BoardSurface, exclude?: Set<string>): DrawingSpace;
  toolSurface(): TutorBoardSurface;
  flush(): Promise<void>;
  save(): Promise<void>;
};
function boardLayer(manager: InspirationBoards, target: TestView): LayerProbe {
  const layers = (manager as unknown as { layers: Map<TestView, LayerProbe> }).layers;
  expect(layers.get(target)).toBeDefined();
  return layers.get(target)!;
}
function attachEditor(manager: InspirationBoards, target: TestView, text = sourceText, live = true, focused = true): EditorView {
  Object.assign(target, { getMode: () => "source" });
  target.containerEl.querySelector(".markdown-preview-view")?.remove();
  const parent = document.createElement("div");
  parent.className = "markdown-source-view mod-cm6";
  target.containerEl.querySelector(".view-content")!.append(parent);
  const info = editorInfoField as unknown as StateField<{ file: { path: string } }>;
  const mode = editorLivePreviewField as unknown as StateField<boolean>;
  const editor = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: [
    info.init(() => ({ file: { path: target.file!.path } })), mode.init(() => live), foldState, manager.editorExtension,
  ] }) });
  codeMirrorViews.push(editor);
  vi.spyOn(editor, "inView", "get").mockReturnValue(true);
  vi.spyOn(editor, "hasFocus", "get").mockReturnValue(focused);
  vi.spyOn(editor, "documentTop", "get").mockReturnValue(100);
  vi.spyOn(editor, "scaleX", "get").mockReturnValue(1);
  vi.spyOn(editor, "scaleY", "get").mockReturnValue(1);
  vi.spyOn(editor.contentDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 100, 700, 600));
  vi.spyOn(editor.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  const blocks = () => Array.from({ length: editor.state.doc.lines }, (_, index) => {
    const line = editor.state.doc.line(index + 1);
    return { from: line.from, to: line.to, top: index * 24, bottom: index * 24 + 24, height: 24, length: line.length, type: 0 };
  });
  vi.spyOn(editor, "viewportLineBlocks", "get").mockImplementation(() => blocks() as EditorView["viewportLineBlocks"]);
  vi.spyOn(editor, "lineBlockAt").mockImplementation(position => blocks()[editor.state.doc.lineAt(position).number - 1]! as ReturnType<EditorView["lineBlockAt"]>);
  return editor;
}
async function measureEditor(editor: EditorView): Promise<void> {
  const request = editorMeasures.get(editor);
  expect(request).toBeDefined();
  editorMeasures.delete(editor);
  request!.write?.(request!.read(editor), editor);
  await settle();
}
function useSourceFile(scenario: ReturnType<typeof setup>, text = sourceText): void {
  Object.assign(scenario.app.vault, { cachedRead: vi.fn(async () => text) });
}
function successfulAgent(): BoardAgent {
  return { request: vi.fn(async (request: BoardAgentRequest): Promise<BoardAgentResult> => ({
    ok: true, requestId: request.requestId, baseRevision: request.baseRevision, description: "Observed", operations: [],
  })), cancel: vi.fn(), dispose: vi.fn() };
}
function button(target: TestView, key: string): HTMLButtonElement {
  const found = [
    ...target.containerEl.querySelectorAll<HTMLButtonElement>(
      ".atl-board-toolbar button, .atl-board-conversation button",
    ),
  ].find((item) => item.textContent === t(`board.${key}`));
  if (!found)
    throw Error(`Missing button ${key}: ${target.containerEl.textContent}`);
  return found;
}
function canvas(target: TestView): HTMLCanvasElement {
  return target.containerEl.querySelector<HTMLCanvasElement>(
    ".atl-board-layer",
  )!;
}
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
}
function pointer(target: TestView, type: string, x: number, y: number): void {
  canvas(target).dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "pen",
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pressure: 0.6,
      clientX: x,
      clientY: y,
    }),
  );
}
async function draw(target: TestView): Promise<void> {
  button(target, "pen").click();
  pointer(target, "pointerdown", 100, 150);
  pointer(target, "pointermove", 140, 180);
  pointer(target, "pointerup", 140, 180);
  await settle();
}
function stored(
  adapter: MemoryAdapter,
  source = "Physics.md",
): BoardDocument | undefined {
  return [...adapter.files.entries()]
    .filter(([path]) => /\/[^.]+\.board\.json$/.test(path))
    .map(([, value]) => JSON.parse(value) as BoardDocument)
    .find((board) => board.sourceFile === source);
}

function pdfView(rotation: 0 | 90 | 180 | 270): TestView {
  const target = view("Diagram.pdf");
  const root = target.containerEl.querySelector<HTMLElement>(".view-content")!;
  root.innerHTML =
    '<div class="pdf-viewer-container"><div class="pdfViewer"><div class="page" data-page-number="1"></div></div></div>';
  const page = root.querySelector<HTMLElement>(".page")!;
  const landscape = rotation % 180 === 0,
    width = landscape ? 700 : 400,
    height = landscape ? 400 : 700;
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 100, width, height),
  );
  vi.spyOn(
    root.querySelector(".pdf-viewer-container")!,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 800, 600));
  const transforms = {
    0: [1, 0, 0, -1, 0, 400],
    90: [0, 1, 1, 0, 0, 0],
    180: [-1, 0, 0, 1, 700, 0],
    270: [0, -1, -1, 0, 400, 700],
  };
  return Object.assign(target, {
    file: {
      path: "Diagram.pdf",
      extension: "pdf",
      stat: { mtime: 1, size: 20 },
    },
    getViewType: () => "pdf",
    viewer: {
      child: {
        pdfViewer: {
          pdfViewer: {
            getPageView: () => ({
              div: page,
              viewport: { width, height, transform: transforms[rotation] },
              pdfPage: {
                getViewport: () => ({
                  width: 700,
                  height: 400,
                  transform: transforms[0],
                }),
              },
            }),
          },
        },
      },
    },
  });
}

describe("CodeMirror manager integration", () => {
  it.each([true, false])("keeps the reading anchor and stroke identity when switching to CM6 Live Preview=%s", async (live) => {
    const target = view(), scenario = setup([target]);
    useSourceFile(scenario);
    await scenario.manager.toggle(target);
    await settle();
    await draw(target);
    const original = stored(scenario.adapter)!.objects[0]!;
    const layer = boardLayer(scenario.manager, target);
    const before = layer.surfaceFor(original.anchor)!.project(original);
    const editor = attachEditor(scenario.manager, target, sourceText, live);
    await scenario.manager.sync();
    expect(boardLayer(scenario.manager, target)).toBe(layer);
    await measureEditor(editor);
    expect(layer.editorState()).toMatchObject({ ready: true, mode: live ? "live-preview" : "source" });
    expect(layer.surfaceFor(original.anchor)).toBeDefined();
    expect(layer.surfaceFor(original.anchor)!.anchor).toMatchObject({ kind: "markdown", key: original.anchor.kind === "markdown" ? original.anchor.key : "" });
    editor.dispatch({ changes: { from: 0, insert: "Introduction.\n\n" } });
    expect(layer.editorState()?.ready).toBe(false);
    await measureEditor(editor);
    const moved = layer.surfaceFor(original.anchor)!.project(original);
    expect(moved).toMatchObject({ x: before.x, y: before.y + 48 });
    expect(stored(scenario.adapter)!.objects[0]).toEqual(original);
    expect(stored(scenario.adapter)!.markdownAnchors?.entries.find(entry => entry.id === (original.anchor.kind === "markdown" ? original.anchor.key : ""))?.from).toBe(15);
  });

  it("invalidates an in-flight Tutor result immediately after an unsaved CM6 transaction", async () => {
    let finish!: (value: BoardAgentResult) => void;
    let observed!: BoardAgentRequest;
    const agent: BoardAgent = { request: vi.fn((request: BoardAgentRequest) => {
      observed = request;
      return new Promise<BoardAgentResult>(resolve => { finish = resolve; });
    }), cancel: vi.fn(), dispose: vi.fn() };
    const target = view(), scenario = setup([target], agent);
    useSourceFile(scenario);
    const editor = attachEditor(scenario.manager, target);
    await scenario.manager.toggle(target);
    await measureEditor(editor);
    button(target, "send").click();
    await settle();
    expect(agent.request).toHaveBeenCalledOnce();
    const oldBuffer = observed.bufferRevision;
    const oldFileStat = { ...target.file!.stat };
    editor.dispatch({ changes: { from: 0, insert: "Unsaved.\n\n" } });
    expect(boardLayer(scenario.manager, target).editorState()?.bufferRevision).not.toBe(oldBuffer);
    expect(agent.cancel).toHaveBeenCalled();
    finish({ ok: true, requestId: observed.requestId, baseRevision: observed.baseRevision, description: "Late drawing", operations: [{ type: "add", object: {
      id: "Tutor-stale-buffer", kind: "rect", anchor: observed.anchor, x: 10, y: 10, width: 20, height: 20,
      color: "#6655aa", strokeWidth: 2, createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "response-stale",
    } }] });
    await measureEditor(editor);
    expect(target.file!.stat).toEqual(oldFileStat);
    expect(boardLayer(scenario.manager, target).bundle().document.objects).toEqual([]);
    expect(capture).toHaveBeenCalledOnce();
    button(target, "pause").click();
  });

  it("deduplicates mirrored CM6 source changes while both same-document splits have together enabled", async () => {
    const first = view(), second = view(), agent = successfulAgent();
    const scenario = setup([first, second], agent);
    useSourceFile(scenario);
    const firstEditor = attachEditor(scenario.manager, first, sourceText, true, true);
    const secondEditor = attachEditor(scenario.manager, second, sourceText, false, false);
    await scenario.manager.toggle(first);
    await scenario.manager.toggle(second);
    await measureEditor(firstEditor);
    await measureEditor(secondEditor);
    button(first, "together").click();
    button(second, "together").click();
    const insert = "New heading.\n\n";
    firstEditor.dispatch({ changes: { from: 0, insert } });
    secondEditor.dispatch({ changes: { from: 0, insert } });
    await measureEditor(firstEditor);
    await measureEditor(secondEditor);
    await vi.advanceTimersByTimeAsync(4000);
    expect(agent.request).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    const request = vi.mocked(agent.request).mock.calls[0]![0];
    expect(request.sourceFile).toBe("Physics.md");
    expect(request.bufferRevision).toBe(boardLayer(scenario.manager, first).editorState()?.bufferRevision);
    expect(boardLayer(scenario.manager, first).bundle().document.markdownAnchors).toEqual(boardLayer(scenario.manager, second).bundle().document.markdownAnchors);
    expect(boardLayer(scenario.manager, first).bundle().document.markdownAnchors?.entries.find(entry => entry.blockId === "energy")?.from).toBe(insert.length);
    await vi.advanceTimersByTimeAsync(4000);
    expect(agent.request).toHaveBeenCalledOnce();
  });

  it("keeps CM6 undo transactions out of board undo while preserving relocated anchor metadata", async () => {
    const target = view(), scenario = setup([target]);
    useSourceFile(scenario);
    const editor = attachEditor(scenario.manager, target);
    await scenario.manager.toggle(target);
    await measureEditor(editor);
    await draw(target);
    const original = stored(scenario.adapter)!.objects[0]!;
    const transaction = editor.state.update({ changes: { from: 0, insert: "Temporary paragraph.\n\n" }, annotations: Transaction.userEvent.of("input") });
    const inverse = transaction.changes.invert(transaction.startState.doc);
    editor.dispatch(transaction);
    await measureEditor(editor);
    // This is the actual CM inverse transaction delivered by an undo command;
    // the test deliberately does not substitute or call the board's history.
    editor.dispatch({ changes: inverse, annotations: Transaction.userEvent.of("undo") });
    await measureEditor(editor);
    expect(editor.state.doc.toString()).toBe(sourceText);
    expect(stored(scenario.adapter)!.objects[0]).toEqual(original);
    expect(boardLayer(scenario.manager, target).history.canUndo).toBe(true);
    const latestAnchors = stored(scenario.adapter)!.markdownAnchors;
    button(target, "undo").click();
    await settle();
    expect(stored(scenario.adapter)!.objects).toEqual([]);
    expect(boardLayer(scenario.manager, target).history.canUndo).toBe(false);
    expect(stored(scenario.adapter)!.markdownAnchors).toEqual(latestAnchors);
    expect(editor.state.doc.toString()).toBe(sourceText);
  });

  it("retains a manual instruction until the real CM6 measurement makes its source ready", async () => {
    const target = view(), agent = successfulAgent(), scenario = setup([target], agent);
    useSourceFile(scenario);
    const editor = attachEditor(scenario.manager, target);
    await scenario.manager.toggle(target);
    const prompt = target.containerEl.querySelector<HTMLInputElement>('.atl-board-quick-input input[type="text"]')!;
    prompt.value = "请根据这一段问我一个问题";
    button(target, "send").click();
    await settle();
    expect(boardLayer(scenario.manager, target).editorState()?.ready).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    await measureEditor(editor);
    expect(capture).toHaveBeenCalledOnce();
    expect(agent.request).toHaveBeenCalledOnce();
    expect(vi.mocked(agent.request).mock.calls[0]![0].instruction).toBe("请根据这一段问我一个问题");
  });

  it.each(["before-request", "after-compositionend"] as const)("never captures during IME and resumes a manual instruction when its final commit arrives %s", async (commitTiming) => {
    const target = view(), agent = successfulAgent(), scenario = setup([target], agent);
    useSourceFile(scenario);
    const editor = attachEditor(scenario.manager, target, sourceText, true, false);
    await scenario.manager.toggle(target);
    await measureEditor(editor);
    editor.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const commit = () => editor.dispatch({ changes: { from: 0, insert: "中文问题。\n\n" }, annotations: Transaction.userEvent.of("input.type.compose") });
    if (commitTiming === "before-request") commit();
    const prompt = target.containerEl.querySelector<HTMLInputElement>('.atl-board-quick-input input[type="text"]')!;
    prompt.value = "解释刚才输入的中文";
    button(target, "send").click();
    await vi.advanceTimersByTimeAsync(4000);
    expect(boardLayer(scenario.manager, target).editorState()?.composing).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    expect(agent.request).not.toHaveBeenCalled();
    editor.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    if (commitTiming === "after-compositionend") commit();
    expect(capture).not.toHaveBeenCalled();
    await measureEditor(editor);
    expect(boardLayer(scenario.manager, target).editorState()).toMatchObject({ ready: true, composing: false });
    expect(capture).toHaveBeenCalledOnce();
    expect(agent.request).toHaveBeenCalledOnce();
    expect(vi.mocked(agent.request).mock.calls[0]![0]).toMatchObject({ instruction: "解释刚才输入的中文", context: "中文问题。" });
  });

  it("retries one capture-layout-changed failure after CM6 settles and sends the manual instruction only once", async () => {
    const target = view(), agent = successfulAgent(), scenario = setup([target], agent);
    useSourceFile(scenario);
    const editor = attachEditor(scenario.manager, target);
    await scenario.manager.toggle(target);
    await measureEditor(editor);
    await draw(target);
    button(target, "select").click();
    pointer(target, "pointerdown", 120, 165);
    pointer(target, "pointerup", 120, 165);
    await settle();
    const layer = boardLayer(scenario.manager, target);
    expect(layer.selection.size).toBe(1);
    const defaultCapture = capture.getMockImplementation()!;
    const selectedDuringCapture: number[] = [];
    capture.mockImplementation(async (surface: BoardSurface, ...options: unknown[]) => {
      selectedDuringCapture.push(layer.selection.size);
      if (selectedDuringCapture.length === 1) throw new BoardCaptureError("capture-layout-changed");
      return defaultCapture(surface, ...options);
    });
    const prompt = target.containerEl.querySelector<HTMLInputElement>('.atl-board-quick-input input[type="text"]')!;
    prompt.value = "等页面稳定后解释一下";
    button(target, "send").click();
    await settle();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(selectedDuringCapture).toEqual([0, 0]);
    expect(layer.selection.size).toBe(1);
    expect(agent.request).toHaveBeenCalledOnce();
    expect(vi.mocked(agent.request).mock.calls[0]![0].instruction).toBe("等页面稳定后解释一下");
    expect(button(target, "pause")).toBeDefined();
    expect(target.containerEl.querySelector(".atl-board-status")!.textContent).not.toContain(t("board.captureError"));
  });

  it.each(["cm6", "pdf"] as const)("hides the vertical toolbar and temporary conversation while capturing the full %s viewport", async (kind) => {
    const target = kind === "pdf" ? pdfView(90) : view();
    const agent = successfulAgent(), scenario = setup([target], agent);
    let editor: EditorView | undefined;
    if (kind === "cm6") {
      useSourceFile(scenario);
      editor = attachEditor(scenario.manager, target);
    }
    await scenario.manager.toggle(target);
    if (editor) await measureEditor(editor);
    else await settle();
    const root = target.containerEl.querySelector<HTMLElement>(".view-content")!;
    const toolbar = target.containerEl.querySelector<HTMLElement>(".atl-board-toolbar")!;
    vi.mocked(root.getBoundingClientRect).mockReturnValue(new DOMRect(40, 60, 800, 600));
    vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(64, 500, 752, 112));
    button(target, "send").click();
    await settle();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![1]).toEqual([
      toolbar,
      target.containerEl.querySelector(".atl-board-selection-bar"),
      target.containerEl.querySelector(".atl-board-conversation"),
    ]);
    expect(capture.mock.calls[0]![2]).toEqual({ x: 40, y: 60, width: 800, height: 600 });
    expect(agent.request).toHaveBeenCalledOnce();
  });
});

describe("inspiration board controller", () => {
  it("names, reselects and independently duplicates a manually selected character part",async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();await draw(target);
    const layer=boardLayer(s.manager,target),id=layer.bundle().document.objects[0]!.id;
    layer.selection.add(id);button(target,"characterParts").click();await settle();
    const name=document.querySelector<HTMLInputElement>('.test-modal input')!;name.value="眼睛";
    const save=[...document.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(b=>b.textContent===t('board.save'))!;
    save.click();await settle();
    const original=stored(s.adapter)!.objects[0]!;expect(original.characterPart?.name).toBe("眼睛");
    layer.selection.clear();button(target,"characterParts").click();await settle();
    [...document.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(b=>b.textContent==="眼睛")!.click();
    expect([...layer.selection]).toEqual([id]);
    button(target,"duplicate").click();await settle();
    const objects=stored(s.adapter)!.objects;expect(objects).toHaveLength(2);
    expect(objects[1]!.characterPart?.id).not.toBe(original.characterPart?.id);
    expect(objects[1]!.selectionGroupId).not.toBe(original.selectionGroupId);
    button(target,"undo").click();await settle();expect(stored(s.adapter)!.objects).toHaveLength(1);
  });
  it("reuses a render snapshot only while its revision is current",async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();await draw(target);
    const layer=boardLayer(s.manager,target) as unknown as {draw():void;renderSnapshot:BoardBundle["document"]|null};
    layer.draw();const first=layer.renderSnapshot;
    for(let i=0;i<10;i++)layer.draw();
    expect(layer.renderSnapshot).toBe(first);
    button(target,"undo").click();await settle();layer.draw();
    expect(layer.renderSnapshot).not.toBe(first);
    expect(layer.renderSnapshot!.objects).toHaveLength(0);
    button(target,"redo").click();await settle();layer.draw();
    expect(layer.renderSnapshot!.objects).toHaveLength(1);
  });
  it("opens a hidden board idempotently after a resolved intent and never opens on pre-cancellation",async()=>{
    const s=setup(),target=s.views[0]!;
    const stopped=new AbortController();stopped.abort();
    await expect(s.manager.ensureOpen(target.file!.path,stopped.signal)).rejects.toThrow();
    expect(target.containerEl.querySelector('.atl-board-layer')).toBeNull();
    const id=await s.manager.ensureOpen(target.file!.path,new AbortController().signal);await settle();
    expect(id).toBeTruthy();
    expect(await s.manager.ensureOpen(target.file!.path,new AbortController().signal)).toBe(id);
    expect(target.containerEl.querySelectorAll('.atl-board-layer')).toHaveLength(1);
    await s.manager.toggle(target);await settle();
    expect(await s.manager.ensureOpen(target.file!.path,new AbortController().signal)).toBeTruthy();
    expect(target.containerEl.querySelectorAll('.atl-board-layer')).toHaveLength(1);
  });
  it("opens only the bound source view when the active split has the same file", async () => {
    const original=view(), other=view(), s=setup([original,other]);
    s.active.view=other;
    const id=await s.manager.ensureOpen(original.file!.path,new AbortController().signal,original);
    expect(original.containerEl.querySelector('.atl-board-layer')).not.toBeNull();
    expect(other.containerEl.querySelector('.atl-board-layer')).toBeNull();
    expect(await s.manager.ensureOpen(original.file!.path,new AbortController().signal,original)).toBe(id);
  });
  it.each(['detached','removed','retargeted'] as const)("never falls back to another split when the bound source view is %s", async (reason) => {
    const original=view(), other=view(), s=setup([original,other]);
    s.active.view=other;
    if(reason==='detached')original.containerEl.remove();
    if(reason==='removed')s.views.splice(0,1);
    if(reason==='retargeted')original.file!.path='Other.md';
    await expect(s.manager.ensureOpen('Physics.md',new AbortController().signal,original)).rejects.toThrow();
    expect(other.containerEl.querySelector('.atl-board-layer')).toBeNull();
  });
  it("coalesces pen previews and reuses committed scene pixels until the gesture ends",async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();await draw(target);
    const layer=boardLayer(s.manager,target) as unknown as {draw():void;penPreview():void;paintSceneKey:string;paintScene:HTMLCanvasElement|null;brush:{kind:string}};
    layer.brush.kind="watercolor";
    const preview=vi.spyOn(layer,"penPreview");
    pointer(target,"pointerdown",110,160);
    for(let i=0;i<30;i++)pointer(target,"pointermove",115+i,170+i);
    expect(preview).not.toHaveBeenCalled();layer.draw();expect(preview).toHaveBeenCalledOnce();
    const cache=layer.paintScene,key=layer.paintSceneKey;expect(cache).not.toBeNull();expect(key).not.toBe("");
    const drawImage=vi.fn();cache!.getContext("2d")!.drawImage=drawImage;
    pointer(target,"pointermove",150,215);layer.draw();
    expect(layer.paintScene).toBe(cache);expect(layer.paintSceneKey).toBe(key);
    // One composite of cached pixels; no second write into the backing canvas.
    expect(drawImage).toHaveBeenCalledTimes(1);
    pointer(target,"pointerup",155,220);await settle();layer.draw();
    expect(layer.paintScene).toBeNull();expect(stored(s.adapter)?.objects).toHaveLength(2);
  });
  it("does not mount a board when intent is cancelled while its data is loading", async () => {
    const s = setup(), target = s.views[0]!;
    const abort = new AbortController();
    const repository = (s.manager as unknown as { repository: BoardRepository }).repository;
    const original = repository.open.bind(repository);
    vi.spyOn(repository, "open").mockImplementationOnce(async (...args) => {
      const bundle = await original(...args);
      abort.abort();
      return bundle;
    });
    await expect(s.manager.ensureOpen(target.file!.path, abort.signal)).rejects.toThrow();
    expect(target.containerEl.querySelector(".atl-board-layer")).toBeNull();
  });
  it("offers all built-in brush previews and closes the material palette from all exit paths", async () => {
    const target = view(), { manager } = setup([target]);
    await manager.toggle(target); await settle();
    const pen = button(target, "pen");
    const palette = target.containerEl.querySelector<HTMLElement>(".atl-board-brush-palette")!;
    pen.click();
    expect(palette.hidden).toBe(false);
    expect(palette.querySelectorAll("[role=menuitemradio]")).toHaveLength(10);
    expect(palette.querySelectorAll("canvas.atl-board-brush-stroke")).toHaveLength(10);
    pen.click();
    expect(palette.hidden).toBe(true);
    pen.click();
    button(target, "select").click();
    expect(palette.hidden).toBe(true);
    pen.click();
    canvas(target).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 200 }));
    expect(palette.hidden).toBe(true);
    pen.click();
    palette.querySelector<HTMLButtonElement>('[data-brush="sumi"]')!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(palette.hidden).toBe(true);
    expect(document.activeElement).toBe(pen);
  });

  it("labels stroke controls, separates shape fill, and reflects the chosen stroke colour", async () => {
    const target = view(), { manager } = setup([target]);
    await manager.toggle(target); await settle();
    const panel = target.containerEl.querySelector<HTMLDetailsElement>(".atl-board-property-panel")!;
    panel.open = true;
    expect(panel.querySelector(".atl-board-stroke-section")?.textContent).toContain(t("board.opacity"));
    expect(panel.querySelector(".atl-board-stroke-section")?.textContent).toContain(t("board.smoothing"));
    expect(panel.querySelector(".atl-board-fill-section")?.textContent).toContain(t("board.fillHint"));
    const fillColor = panel.querySelector<HTMLInputElement>('.atl-board-fill-control input[type="color"]')!;
    expect(fillColor.disabled).toBe(true);
    const strokeColor = panel.querySelector<HTMLInputElement>('.atl-board-color-control input[type="color"]')!;
    strokeColor.value = "#127a48";
    strokeColor.dispatchEvent(new Event("input", { bubbles: true }));
    const toolbar = target.containerEl.querySelector<HTMLElement>(".atl-board-toolbar")!;
    expect(toolbar.style.getPropertyValue("--atl-board-stroke-color")).toBe("#127a48");
  });

  it("persists a fast straight pen stroke even when the device emits no pointermove", async () => {
    const target = view(), { manager, adapter } = setup([target]);
    await manager.toggle(target); await settle();
    button(target, "pen").click();
    pointer(target, "pointerdown", 100, 150);
    pointer(target, "pointerup", 220, 150);
    await settle();
    const document = stored(adapter)!;
    expect(document.objects).toHaveLength(1);
    expect(document.objects[0]).toMatchObject({ kind: "ink", width: 120, height: 1 });
    const inkId = document.objects[0]!.inkId!;
    const stroke = boardLayer(manager, target).bundle().ink[inkId]!;
    expect(stroke.points).toHaveLength(2);
    expect(stroke.points[1]).toMatchObject({ x: 120, y: 0 });
  });

  it("selects and drags ink, then exposes a safe visible delete action", async () => {
    const target = view(), { manager, adapter } = setup([target]);
    await manager.toggle(target); await settle();
    await draw(target);
    const before = stored(adapter)!.objects[0]!;

    button(target, "select").click();
    pointer(target, "pointerdown", 120, 165);
    pointer(target, "pointermove", 170, 195);
    pointer(target, "pointerup", 170, 195);
    await settle();

    const moved = stored(adapter)!.objects[0]!;
    expect(moved.x).toBe(before.x + 50);
    expect(moved.y).toBe(before.y + 30);
    const selectionBar = target.containerEl.querySelector<HTMLElement>(
      ".atl-board-selection-bar",
    )!;
    expect(selectionBar.hidden).toBe(false);
    expect(selectionBar.textContent).toContain(t("board.dragSelection"));
    selectionBar.querySelector<HTMLButtonElement>(
      '[data-board-action="remove"]',
    )!.click();
    await settle();
    expect(stored(adapter)!.objects).toHaveLength(0);
    expect(boardLayer(manager, target).selection.size).toBe(0);
  });

  it("drags a selected freehand object from empty space inside its selection box", async () => {
    const target = view(), { manager, adapter } = setup([target]);
    await manager.toggle(target); await settle();
    button(target, "pen").click();
    pointer(target, "pointerdown", 100, 150);
    pointer(target, "pointermove", 100, 250);
    pointer(target, "pointermove", 250, 250);
    pointer(target, "pointerup", 250, 250);
    await settle();

    button(target, "select").click();
    pointer(target, "pointerdown", 100, 200);
    pointer(target, "pointerup", 100, 200);
    const before = stored(adapter)!.objects[0]!;
    // This point is inside the L-shaped stroke's selection box but does not
    // touch either segment of the actual ink path.
    pointer(target, "pointerdown", 180, 190);
    pointer(target, "pointermove", 205, 215);
    pointer(target, "pointerup", 205, 215);
    await settle();

    const moved = stored(adapter)!.objects[0]!;
    expect(moved.x).toBe(before.x + 25);
    expect(moved.y).toBe(before.y + 25);
  });

  it("keeps visible objects rendered when they extend outside their anchor element", async () => {
    const target = view(), { manager, adapter } = setup([target]);
    await manager.toggle(target); await settle();
    await draw(target);
    await manager.toggle(target);

    const document = stored(adapter)!;
    document.objects[0]!.x = -200;
    document.revision++;
    const path = [...adapter.files.keys()].find((candidate) =>
      candidate.endsWith(`${document.id}.board.json`),
    )!;
    adapter.files.set(path, JSON.stringify(document));
    const paragraph = target.containerEl.querySelector<HTMLElement>(
      ".markdown-preview-section > div",
    )!;
    vi.mocked(paragraph.getBoundingClientRect).mockReturnValue(
      new DOMRect(300, 100, 400, 200),
    );
    const transform = vi.fn();
    const context = new Proxy(
      { transform } as unknown as CanvasRenderingContext2D,
      {
        get: (object, key) => Reflect.get(object, key) ?? (() => {}),
        set: (object, key, value) => Reflect.set(object, key, value),
      },
    );
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);

    await manager.toggle(target); await settle();
    expect(transform).toHaveBeenCalledWith(1, 0, 0, 1, 300, 100);
  });

  it("offers labeled SVG tools and commits multiline handwritten text as editable undoable content", async () => {
    const target = view(),
      { manager, adapter } = setup([target]);
    await manager.toggle(target);
    await settle();
    for (const key of [
      "pen",
      "erase",
      "select",
      "text",
      "arrow",
      "rect",
      "ellipse",
      "sticker",
      "undo",
      "redo",
    ]) {
      const control = button(target, key);
      expect(control.querySelector("svg")).not.toBeNull();
      expect(control.getAttribute("aria-label")).toBe(t(`board.${key}`));
    }
    button(target, "text").click();
    pointer(target, "pointerdown", 100, 150);
    const editor = target.containerEl.querySelector<HTMLTextAreaElement>(
      ".atl-board-text-editor",
    )!;
    expect(editor).not.toBeNull();
    editor.value = "为什么能量守恒？\n请画出你的解释。";
    editor.dispatchEvent(new Event("input"));
    const nativeUndo = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(nativeUndo);
    expect(nativeUndo.defaultPrevented).toBe(false);
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await settle();
    const first = stored(adapter)!.objects[0]!;
    expect(first.text).toBe("为什么能量守恒？\n请画出你的解释。");
    expect(first.textStyle?.font).toBe("handwritten");
    expect(first.height).toBeGreaterThan(first.textStyle!.size);
    button(target, "select").click();
    canvas(target).dispatchEvent(
      new MouseEvent("dblclick", { clientX: 110, clientY: 155, bubbles: true }),
    );
    const editAgain = target.containerEl.querySelector<HTMLTextAreaElement>(
      ".atl-board-text-editor",
    )!;
    expect(editAgain.value).toBe(first.text);
    editAgain.value = "修改后的问题";
    editAgain.blur();
    await settle();
    expect(stored(adapter)!.objects[0]!.id).toBe(first.id);
    expect(stored(adapter)!.objects[0]!.text).toBe("修改后的问题");
    button(target, "undo").click();
    await settle();
    expect(stored(adapter)!.objects[0]!.text).toBe(first.text);
    button(target, "undo").click();
    await settle();
    expect(stored(adapter)!.objects).toEqual([]);
    button(target, "redo").click();
    await settle();
    expect(stored(adapter)!.objects[0]!.id).toBe(first.id);
  });

  it("keeps manual shape seeds stable and separates visual grouping from undo transactions", async () => {
    const target = view(),
      { manager, adapter } = setup([target]);
    await manager.toggle(target);
    await settle();
    for (const [key, x] of [
      ["rect", 100],
      ["ellipse", 250],
      ["arrow", 400],
    ] as const) {
      button(target, key).click();
      pointer(target, "pointerdown", x, 150);
      pointer(target, "pointermove", x + 70, 210);
      pointer(target, "pointerup", x + 70, 210);
      await settle();
    }
    const shapes = stored(adapter)!.objects;
    expect(shapes.map((o) => o.kind)).toEqual(["rect", "ellipse", "arrow"]);
    expect(shapes.every((o) => Number.isInteger(o.drawingStyle?.seed))).toBe(
      true,
    );
    button(target, "select").click();
    pointer(target, "pointerdown", 75, 125);
    pointer(target, "pointermove", 500, 250);
    pointer(target, "pointerup", 500, 250);
    button(target, "group").click();
    await settle();
    const grouped = stored(adapter)!.objects;
    expect(new Set(grouped.map((o) => o.selectionGroupId)).size).toBe(1);
    expect(grouped[0]!.selectionGroupId).toBeTruthy();
    expect(new Set(grouped.map((o) => o.groupId)).size).toBe(3);
    button(target, "ungroup").click();
    await settle();
    expect(stored(adapter)!.objects.every((o) => !o.selectionGroupId)).toBe(
      true,
    );
    button(target, "undo").click();
    await settle();
    expect(stored(adapter)!.objects[0]!.selectionGroupId).toBe(
      grouped[0]!.selectionGroupId,
    );
    await manager.toggle(target);
    await manager.toggle(target);
    await settle();
    expect(stored(adapter)!.objects.map((o) => o.drawingStyle)).toEqual(
      shapes.map((o) => o.drawingStyle),
    );
  });

  it("inserts searchable expression assets without replacing the Tutor identity", async () => {
    const target = view(),
      { manager, adapter } = setup([target]);
    await manager.toggle(target);
    await settle();
    await draw(target);
    const identity = stored(adapter)!.characterId;
    button(target, "sticker").click();
    await settle();
    const modal = document.querySelector(".atl-board-sticker-modal")!;
    expect(
      modal.querySelectorAll(".atl-board-sticker-tile").length,
    ).toBeGreaterThan(12);
    const search = modal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    search.value = "qwerty-no-match";
    search.dispatchEvent(new Event("input"));
    expect(modal.querySelectorAll(".atl-board-sticker-tile")).toHaveLength(0);
    search.value = "";
    search.dispatchEvent(new Event("input"));
    modal
      .querySelectorAll<HTMLButtonElement>(".atl-board-sticker-tile")[12]!
      .click();
    await settle();
    const board = stored(adapter)!;
    expect(board.characterId).toBe(identity);
    expect(board.objects.at(-1)).toMatchObject({
      kind: "sticker",
      assetVersion: 1,
    });
    expect(board.objects.at(-1)!.assetId).toBeTruthy();
    button(target, "undo").click();
    await settle();
    expect(stored(adapter)!.objects).toHaveLength(1);
    expect(notice).not.toHaveBeenCalled();
  });
  it("removes custom stickers from the library without inserting or deleting their manifests, then undoes", async () => {
    const target = view(), scenario = setup([target]);
    const path = "Board Memory/characters/student-sticker.v1.character.json";
    scenario.adapter.folders.add("Board Memory/characters");
    scenario.adapter.files.set(path, JSON.stringify({
      id: "student-sticker", version: 1, name: "Student sticker", origin: "co_created", style: "custom",
      usage: "sticker", width: 80, height: 40, createdAt: "2026-09-15T00:00:00.000Z", objects: [{
        id: "shape", kind: "rect", anchor: { kind: "markdown", key: "preview", quote: "" }, x: 0, y: 0,
        width: 80, height: 40, color: "#7062b5", strokeWidth: 2, createdBy: "human", editedBy: "human", revision: 1, groupId: "group",
      }],
    }));
    await scenario.manager.toggle(target); await settle();
    button(target, "sticker").click(); await settle();
    const modal = document.querySelector<HTMLElement>(".atl-board-sticker-modal")!;
    const custom = [...modal.querySelectorAll<HTMLElement>(".atl-board-sticker-card")]
      .find(card => card.textContent?.includes("Student sticker"))!;
    custom.querySelector<HTMLButtonElement>(".atl-board-sticker-remove")!.click();
    await settle();
    expect(modal.textContent).not.toContain("Student sticker");
    expect(stored(scenario.adapter)?.objects ?? []).toHaveLength(0);
    expect(scenario.adapter.files.has(path)).toBe(true);
    expect(JSON.parse(scenario.adapter.files.get("Board Memory/characters/library.json")!).hiddenProfileIds).toEqual(["student-sticker"]);
    modal.querySelector<HTMLButtonElement>(".atl-board-sticker-undo button")!.click();
    await settle();
    expect(modal.textContent).toContain("Student sticker");
    expect(JSON.parse(scenario.adapter.files.get("Board Memory/characters/library.json")!).hiddenProfileIds).toEqual([]);
  });
  it("lets users remove and later restore a single built-in expression", async () => {
    const target=view(), scenario=setup([target]);
    await scenario.manager.toggle(target); await settle();
    button(target,"sticker").click(); await settle();
    const modal=document.querySelector<HTMLElement>(".atl-board-sticker-modal")!;
    const count=modal.querySelectorAll(".atl-board-sticker-card").length;
    modal.querySelector<HTMLButtonElement>(".atl-board-sticker-card .atl-board-sticker-remove")!.click();
    await settle();
    expect(modal.querySelectorAll(".atl-board-sticker-card")).toHaveLength(count-1);
    expect(JSON.parse(scenario.adapter.files.get("Board Memory/characters/library.json")!).hiddenStickerKeys).toHaveLength(1);
    expect(stored(scenario.adapter)?.objects ?? []).toHaveLength(0);
    modal.querySelectorAll<HTMLButtonElement>(".atl-board-sticker-filters button")[3]!.click();
    expect(modal.querySelectorAll(".atl-board-sticker-card")).toHaveLength(1);
    modal.querySelector<HTMLButtonElement>(".atl-board-sticker-card .atl-board-sticker-remove")!.click();
    await settle();
    expect(JSON.parse(scenario.adapter.files.get("Board Memory/characters/library.json")!).hiddenStickerKeys).toEqual([]);
  });
  it("redraws after an image reflows Markdown, invalidates pending vision, and releases replaced size targets", async () => {
    let resize!: TestResizeObserver;
    class TestResizeObserver implements ResizeObserver {
      readonly targets = new Set<Element>();
      readonly disconnect = vi.fn(() => this.targets.clear());
      constructor(readonly callback: ResizeObserverCallback) {
        resize = this;
      }
      observe(target: Element): void {
        this.targets.add(target);
      }
      unobserve(target: Element): void {
        this.targets.delete(target);
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    let resolveRequest!: (result: BoardAgentResult) => void;
    const agent: BoardAgent = {
      request: vi.fn(
        () =>
          new Promise<BoardAgentResult>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    const target = view(),
      { manager, adapter } = setup([target], agent);
    await manager.toggle(target);
    await settle();
    await draw(target);
    const section = target.containerEl.querySelector<HTMLElement>(
      ".markdown-preview-section",
    )!;
    const paragraph = section.querySelector<HTMLElement>("div")!;
    const notifyResize = () =>
      resize.callback(
        [
          {
            target: section,
            contentRect: section.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        resize,
      );
    expect(resize.targets.size).toBe(3);
    expect(resize.targets.has(section)).toBe(true);
    button(target, "send").click();
    await settle();
    expect(agent.request).toHaveBeenCalledOnce();
    const request = vi.mocked(agent.request).mock.calls[0]![0];
    const cancellationCount = vi.mocked(agent.cancel).mock.calls.length;
    // Initial/same-size deliveries must not cancel a request or start a render loop.
    notifyResize();
    await settle();
    expect(agent.cancel).toHaveBeenCalledTimes(cancellationCount);
    const transform = vi.fn();
    const context = new Proxy(
      { transform } as unknown as CanvasRenderingContext2D,
      {
        get: (object, key) => Reflect.get(object, key) ?? (() => {}),
        set: (object, key, value) => Reflect.set(object, key, value),
      },
    );
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    // A late image increases content height and moves this paragraph, while
    // root/viewport size and source text remain exactly the same.
    vi.mocked(section.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 800, 800),
    );
    vi.mocked(paragraph.getBoundingClientRect).mockReturnValue(
      new DOMRect(20, 300, 700, 200),
    );
    notifyResize();
    await settle();
    expect(transform).toHaveBeenCalledWith(1, 0, 0, 1, 20, 300);
    expect(agent.cancel).toHaveBeenCalledTimes(cancellationCount + 1);
    resolveRequest({
      ok: true,
      requestId: request.requestId,
      baseRevision: request.baseRevision,
      operations: [],
      description: "Obsolete layout result",
    });
    await settle();
    expect(target.containerEl.textContent).not.toContain(
      "Obsolete layout result",
    );
    expect(stored(adapter)!.objects).toHaveLength(1);
    const replacement = section.cloneNode(false) as HTMLElement;
    replacement.append(paragraph);
    section.replaceWith(replacement);
    vi.spyOn(replacement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 800),
    );
    await settle();
    expect(resize.targets.size).toBe(3);
    expect(resize.targets.has(section)).toBe(false);
    expect(resize.targets.has(replacement)).toBe(true);
    await manager.toggle(target);
    expect(resize.disconnect).toHaveBeenCalledOnce();
    expect(resize.targets.size).toBe(0);
  });

  it("coalesces overlapping layouts through pending saves and source loading without orphaning a layer", async () => {
    const target = view(),
      { manager, adapter } = setup([target]);
    const repository = new BoardRepository(adapter, "Board Memory");
    await repository.save(createBoardDocument("Other.md", "markdown"), {});
    await repository.save(createBoardDocument("Final.md", "markdown"), {});
    await manager.toggle(target);
    await settle();
    await draw(target);
    const original = stored(adapter)!;
    let releaseSave!: () => void,
      releaseLoad!: () => void,
      signalSave!: () => void,
      signalLoad!: () => void;
    const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      }),
      loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      }),
      saving = new Promise<void>((resolve) => {
        signalSave = resolve;
      }),
      loading = new Promise<void>((resolve) => {
        signalLoad = resolve;
      });
    const write = adapter.write.bind(adapter);
    let blockSave = true;
    vi.spyOn(adapter, "write").mockImplementation(async (path, content) => {
      if (blockSave) {
        blockSave = false;
        signalSave();
        await saveGate;
      }
      return write(path, content);
    });
    await draw(target);
    await saving;
    const paragraph = target.containerEl.querySelector<HTMLElement>(
      ".markdown-preview-section > div",
    )!;
    const switchSource = (path: string) => {
      target.file = { ...target.file!, path };
      registerMarkdownBoardSection(paragraph, path, {
        lineStart: 0,
        lineEnd: 0,
        text: `Content for ${path}. ^energy`,
      });
    };
    switchSource("Other.md");
    const firstSync = manager.sync(),
      secondSync = manager.sync();
    expect(firstSync).toBe(secondSync);
    const exists = adapter.exists.bind(adapter);
    let blockLoad = true;
    vi.spyOn(adapter, "exists").mockImplementation(async (path) => {
      if (blockLoad && path === "Board Memory/characters") {
        blockLoad = false;
        signalLoad();
        await loadGate;
      }
      return exists(path);
    });
    releaseSave();
    await loading;
    // Another file-open arrives after the old canvas has been disposed and
    // the replacement canvas exists, while its asynchronous initialization waits.
    switchSource("Final.md");
    const thirdSync = manager.sync();
    releaseLoad();
    await Promise.all([firstSync, secondSync, thirdSync]);
    await settle();
    expect(
      target.containerEl.querySelectorAll(".atl-board-layer"),
    ).toHaveLength(1);
    expect(stored(adapter, "Physics.md")!.objects).toHaveLength(2);
    expect(stored(adapter, "Physics.md")!.objects[0]).toEqual(
      original.objects[0],
    );
    expect(stored(adapter, "Other.md")!.objects).toHaveLength(0);
    await draw(target);
    expect(stored(adapter, "Final.md")!.objects).toHaveLength(1);
    expect(stored(adapter, "Other.md")!.objects).toHaveLength(0);
    await manager.sync();
    expect(
      target.containerEl.querySelectorAll(".atl-board-layer"),
    ).toHaveLength(1);
    await manager.toggle(target);
    expect(
      target.containerEl.querySelectorAll(".atl-board-layer"),
    ).toHaveLength(0);
    expect(notice).not.toHaveBeenCalled();
  });

  it("scrolls the PDF viewport instead of a non-scrollable overflowing page in drawing mode", async () => {
    const target = pdfView(0),
      { manager } = setup([target]);
    const page = target.containerEl.querySelector<HTMLElement>(".page")!;
    const viewport = target.containerEl.querySelector<HTMLElement>(
      ".pdf-viewer-container",
    )!;
    Object.defineProperty(page, "scrollHeight", { value: 900 });
    const pageScroll = vi.spyOn(page, "scrollBy");
    const viewportScroll = vi.spyOn(viewport, "scrollBy");
    await manager.toggle(target);
    await settle();
    button(target, "pen").click();
    const event = new WheelEvent("wheel", {
      clientX: 120,
      clientY: 150,
      deltaY: 120,
      cancelable: true,
    });
    canvas(target).dispatchEvent(event);
    expect(viewportScroll).toHaveBeenCalledWith({ left: 0, top: 120 });
    expect(pageScroll).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("uses the currently visible PDF page after scrolling away from the last drawing", async () => {
    const target = pdfView(0),
      { manager, agent } = setup([target]);
    const first = target.containerEl.querySelector<HTMLElement>(".page")!;
    const second = first.cloneNode() as HTMLElement;
    second.dataset.pageNumber = "2";
    first.parentElement!.append(second);
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 900, 700, 400),
    );
    const pdf = target.viewer as {
      child: {
        pdfViewer: { pdfViewer: { getPageView(index: number): unknown } };
      };
    };
    const firstPage = pdf.child.pdfViewer.pdfViewer.getPageView(0) as {
      div: HTMLElement;
    };
    pdf.child.pdfViewer.pdfViewer.getPageView = (index) => ({
      ...firstPage,
      div: index === 0 ? first : second,
    });
    await manager.toggle(target);
    await settle();
    await draw(target);
    vi.mocked(first.getBoundingClientRect).mockReturnValue(
      new DOMRect(20, -900, 700, 400),
    );
    vi.mocked(second.getBoundingClientRect).mockReturnValue(
      new DOMRect(20, 100, 700, 400),
    );
    target.containerEl
      .querySelector(".pdf-viewer-container")!
      .dispatchEvent(new Event("scroll"));
    await settle();
    button(target, "send").click();
    await settle();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![0].anchor).toEqual({ kind: "pdf", page: 2 });
    expect(agent.request).toHaveBeenCalledWith(
      expect.objectContaining({ anchor: { kind: "pdf", page: 2 } }),
      expect.any(Function),
    );
  });

  it("places characters on a visible Markdown anchor when the last anchor is outside the source viewport", async () => {
    const target = view(),
      { manager, adapter } = setup([target]);
    await manager.toggle(target);
    await settle();
    await draw(target);
    const first = target.containerEl.querySelector<HTMLElement>(
      ".markdown-preview-section > div",
    )!;
    const second = document.createElement("div");
    second.textContent = "The visible paragraph.";
    first.parentElement!.append(second);
    registerMarkdownBoardSection(second, "Physics.md", {
      lineStart: 0,
      lineEnd: 0,
      text: "The visible paragraph. ^visible",
    });
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(
      new DOMRect(420, 100, 300, 200),
    );
    vi.mocked(first.getBoundingClientRect).mockReturnValue(
      new DOMRect(20, 100, 300, 200),
    );
    // Both paragraphs are inside the root, but only the second is inside the source viewport.
    vi.mocked(
      target.containerEl.querySelector<HTMLElement>(".markdown-preview-view")!
        .getBoundingClientRect,
    ).mockReturnValue(new DOMRect(400, 0, 400, 600));
    await settle();
    button(target, "character").click();
    await settle();
    const place = [
      ...document.querySelectorAll<HTMLButtonElement>(".test-modal button"),
    ].find((item) => item.textContent === t("board.round"))!;
    place.click();
    await settle();
    expect(stored(adapter)!.objects.at(-1)?.anchor).toMatchObject({
      kind: "markdown",
      key: "block:visible",
    });
  });

  it("restores any saved character version without changing characters already on the board", async () => {
    const target = view(),
      { manager, adapter } = setup([target]);
    const repository = new BoardRepository(adapter, "Board Memory");
    for (const version of [1, 2]) {
      const profile: TutorCharacterProfile = {
        id: "co-created-buddy",
        version,
        name: "Our buddy",
        origin: "co_created",
        style: "custom",
        width: 100,
        height: 100,
        createdAt: "2026-09-12T00:00:00Z",
        objects: [
          {
            id: `shape-${version}`,
            kind: "ellipse",
            anchor: { kind: "markdown", key: "shape", quote: "" },
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            color: version === 1 ? "red" : "blue",
            strokeWidth: 2,
            createdBy: "human",
            editedBy: "human",
            revision: 1,
            groupId: "group",
          },
        ],
      };
      await repository.saveCharacter(profile);
    }
    await manager.toggle(target);
    await settle();
    const choose = async (version: number) => {
      button(target, "character").click();
      await settle();
      const options = [
        ...document.querySelectorAll<HTMLButtonElement>(".test-modal button"),
      ];
      for (const expected of [1, 2])
        expect(
          options.some(
            (item) =>
              item.textContent ===
              `Our buddy — ${t("board.characterVersion", { version: expected })}`,
          ),
        ).toBe(true);
      options
        .find(
          (item) =>
            item.textContent ===
            `Our buddy — ${t("board.characterVersion", { version })}`,
        )!
        .click();
      await settle();
    };
    await choose(2);
    await choose(1);
    expect(stored(adapter)!.characterVersion).toBe(1);
    expect(
      stored(adapter)!.objects.map((object) => object.characterVersion),
    ).toEqual([2, 1]);
    await manager.toggle(target);
    await manager.toggle(target);
    await settle();
    expect(stored(adapter)!.characterVersion).toBe(1);
    expect(
      stored(adapter)!.objects.map((object) => object.characterVersion),
    ).toEqual([2, 1]);
    expect(notice).not.toHaveBeenCalled();
  });

  it("clips drawing input to the PDF document viewport while keeping root-space ink coordinates", async () => {
    const target = pdfView(0),
      { manager, adapter } = setup([target]);
    const root =
      target.containerEl.querySelector<HTMLElement>(".view-content")!;
    const viewport = root.querySelector<HTMLElement>(".pdf-viewer-container")!;
    vi.mocked(viewport.getBoundingClientRect).mockReturnValue(
      new DOMRect(80, 48, 720, 532),
    );
    const toolbar = document.createElement("div");
    toolbar.className = "pdf-toolbar";
    const zoom = document.createElement("button");
    zoom.textContent = "Zoom in";
    const nativeZoom = vi.fn();
    zoom.onclick = nativeZoom;
    toolbar.append(zoom);
    root.prepend(toolbar);
    await manager.toggle(target);
    await settle();
    await draw(target);
    expect(canvas(target).style.clipPath).toBe("inset(48px 0px 20px 80px)");
    const ink = stored(adapter, "Diagram.pdf")!.objects[0]!;
    expect(ink.x).toBe(80);
    expect(ink.y).toBe(50);
    zoom.click();
    expect(nativeZoom).toHaveBeenCalledOnce();
    // Native sidebar transitions move the document viewport without changing
    // view-content's own dimensions. The canvas clip must follow that move.
    vi.mocked(viewport.getBoundingClientRect).mockReturnValue(
      new DOMRect(180, 48, 620, 532),
    );
    viewport.dispatchEvent(new Event("transitionend", { bubbles: true }));
    await settle();
    expect(canvas(target).style.clipPath).toBe("inset(48px 0px 20px 180px)");
    expect(stored(adapter, "Diagram.pdf")!.objects[0]).toEqual(ink);
  });

  it("flushes and recreates a migrated view in its new window, rebinding blur and frame handling", async () => {
    const target = view(),
      { manager, adapter } = setup([target]);
    await manager.toggle(target);
    await settle();
    button(target, "pen").click();
    pointer(target, "pointerdown", 100, 150);
    pointer(target, "pointermove", 140, 180);
    const originalCanvas = canvas(target);
    const oldCancel = vi.mocked(window.cancelAnimationFrame);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const popout = frame.contentWindow as Window & typeof globalThis;
    vi.spyOn(popout, "requestAnimationFrame").mockImplementation((callback) =>
      window.setTimeout(() => callback(0), 16),
    );
    vi.spyOn(popout, "cancelAnimationFrame").mockImplementation((handle) =>
      window.clearTimeout(handle),
    );
    const context = new Proxy({} as CanvasRenderingContext2D, {
      get: (target, key) => Reflect.get(target, key) ?? (() => {}),
      set: (target, key, value) => Reflect.set(target, key, value),
    });
    vi.spyOn(popout.HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    Object.defineProperty(
      popout.HTMLCanvasElement.prototype,
      "setPointerCapture",
      { configurable: true, value: vi.fn() },
    );
    Object.defineProperty(
      popout.HTMLCanvasElement.prototype,
      "releasePointerCapture",
      { configurable: true, value: vi.fn() },
    );
    popout.document.body.append(target.containerEl);
    await manager.sync();
    await settle();
    expect(canvas(target)).not.toBe(originalCanvas);
    expect(canvas(target).ownerDocument).toBe(popout.document);
    expect(
      target.containerEl.querySelectorAll(".atl-board-layer"),
    ).toHaveLength(1);
    expect(stored(adapter)?.objects).toHaveLength(1);
    expect(oldCancel).toHaveBeenCalled();
    button(target, "together").click();
    expect(button(target, "pause").querySelector("svg")).not.toBeNull();
    expect(
      [...button(target, "pause").childNodes].some(
        node => node.nodeType === 3 && !!node.textContent?.trim(),
      ),
    ).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(button(target, "pause")).toBeDefined();
    popout.dispatchEvent(new popout.Event("blur"));
    expect(button(target, "together")).toBeDefined();
    await draw(target);
    expect(stored(adapter)?.objects).toHaveLength(2);
    expect(notice).not.toHaveBeenCalled();
  });

  it("exports after a source edit without a false conflict or extra drawing undo step", async () => {
    const {
      manager,
      adapter,
      views: [target],
    } = setup();
    await manager.toggle(target);
    await settle();
    await draw(target!);
    target!.file!.stat.mtime = 2;
    target!.file!.stat.size = 40;
    await manager.changed("Physics.md");
    button(target!, "settings").click();
    const exportButton = [
      ...document.querySelectorAll<HTMLButtonElement>(".test-modal button"),
    ].find((item) => item.textContent === t("board.export"))!;
    exportButton.click();
    await settle();
    expect(stored(adapter)?.sourceRevision).toBe("2:40");
    expect(
      [...adapter.files.keys()].some((path) => path.includes(".conflict-")),
    ).toBe(false);
    button(target!, "undo").click();
    await settle();
    expect(stored(adapter)?.objects).toHaveLength(0);
    expect(stored(adapter)?.sourceRevision).toBe("2:40");
    await manager.toggle(target);
    await manager.toggle(target);
    await settle();
    expect(notice).not.toHaveBeenCalled();
  });

  it("retains unsaved drawing through a failed close and retries before releasing it", async () => {
    const {
      manager,
      adapter,
      views: [target],
    } = setup();
    await manager.toggle(target);
    await settle();
    adapter.failWrites = true;
    await draw(target!);
    await expect(manager.toggle(target)).rejects.toThrow("disk unavailable");
    expect(canvas(target!)).not.toBeNull();
    adapter.failWrites = false;
    await manager.toggle(target);
    expect(canvas(target!)).toBeNull();
    expect(stored(adapter)?.objects).toHaveLength(1);
  });

  it("preserves the current local version on an external edit before close and reload", async () => {
    const {
      manager,
      adapter,
      views: [target],
    } = setup();
    await manager.toggle(target);
    await settle();
    await draw(target!);
    const original = stored(adapter)!,
      path = `Board Memory/boards/${original.id}.board.json`;
    adapter.files.set(
      path,
      JSON.stringify({
        ...original,
        revision: original.revision + 10,
        objects: [],
      }),
    );
    await manager.changed(path);
    await settle();
    const conflict = [...adapter.files.entries()].find(
      ([file]) => file.includes(".conflict-") && file.endsWith(".board.json"),
    );
    expect(JSON.parse(conflict![1]).objects).toHaveLength(1);
    expect(JSON.parse(adapter.files.get(path)!).objects).toHaveLength(0);
    await manager.toggle(target);
    await manager.toggle(target);
    await settle();
    expect(canvas(target!)).not.toBeNull();
    expect(notice).not.toHaveBeenCalled();
  });

  it("a referenced pack edit pauses the overlay and preserves its local strokes as a conflict fork", async () => {
    const { manager, adapter, views: [target] } = setup();
    await manager.toggle(target); await settle(); await draw(target!);
    const original = stored(adapter)!, path = `Board Memory/boards/${original.id}.board.json`, authority = adapter.files.get(path);
    const packPath = `Board Memory/ink-packs/${original.id}/${original.inkManifest!.packs[0]!.id}.inkpack.json`, pack = JSON.parse(adapter.files.get(packPath)!);
    const originalInk = structuredClone(pack.strokes), id = original.objects[0]!.inkId!; pack.strokes[id].points[0].x += 100;
    const externalBytes = JSON.stringify(pack); adapter.files.set(packPath, externalBytes);
    await manager.changed(packPath); await settle();
    expect(adapter.files.get(path)).toBe(authority); expect(adapter.files.get(packPath)).toBe(externalBytes);
    const conflict = [...adapter.files.entries()].find(([file]) => file.includes(".conflict-") && file.endsWith(".board.json"));
    expect(conflict).toBeDefined(); const fork = JSON.parse(conflict![1]); expect(fork.objects[0].id).toBe(original.objects[0]!.id);
    const forkPack = JSON.parse(adapter.files.get(`Board Memory/ink-packs/${original.id}/${fork.inkManifest.packs[0].id}.inkpack.json`)!);
    expect(forkPack.strokes).toEqual(originalInk); expect(canvas(target!)).not.toBeNull();
  });

  it("blocks a root switch on failed saves while unloading still detaches listeners", async () => {
    const {
      manager,
      adapter,
      views: [target],
    } = setup();
    await manager.toggle(target);
    await settle();
    adapter.failWrites = true;
    await draw(target!);
    await expect(manager.changeRoot()).rejects.toThrow("disk unavailable");
    expect(canvas(target!)).not.toBeNull();
    await expect(manager.dispose()).rejects.toThrow("disk unavailable");
    expect(canvas(target!)).toBeNull();
  });

  it("relocates a complete response away from text, protects existing art, and undoes once", async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as any;
    const anchor=layer.surfaces[0].anchor;
    const shape={id:"new",kind:"rect",anchor,x:30,y:30,width:160,height:100,color:"#000000",strokeWidth:2,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:"response"};
    const original=JSON.parse(JSON.stringify(shape));
    const operations=layer.placeOperations([{type:"add",object:shape}],layer.surfaces[0]);
    expect(operations[0].object.y).toBeGreaterThan(200);expect(shape).toEqual(original);
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(operations[0].object),"tutor");
    const next=layer.placeOperations([{type:"add",object:{...shape,id:"second"}}],layer.surfaces[0]);
    expect(next[0].object.x).not.toBe(operations[0].object.x);
    expect(layer.history.document.objects).toHaveLength(1);layer.history.undo();expect(layer.history.document.objects).toHaveLength(0);
  });
  it("validates 128 new Tutor objects with one occupancy measurement and defers painting", async () => {
    const s = setup(), target = s.views[0]!;
    await s.manager.toggle(target); await settle();
    const layer = boardLayer(s.manager, target) as DraftValidationProbe, surface = layer.toolSurface();
    const objects: BoardObject[] = Array.from({ length: 128 }, (_, index) => ({
      id: `batch-${index}`, kind: "rect", anchor: layer.surfaces[0]!.anchor,
      x: 30 + index % 12 * 35, y: 230 + Math.floor(index / 12) * 15,
      width: 20, height: 8, color: "#000000", strokeWidth: 2,
      createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "batch",
    }));
    const change: ChangeSet<BoardSurfaceOperation> = { id: "batch", taskId: "task", targetId: surface.id,
      baseRevision: (await surface.read()).target.revision, dependencies: [],
      operations: objects.map(object => ({ type: "add", object })), };
    const draw = vi.spyOn(layer, "draw"), space = vi.spyOn(layer, "drawingSpace");
    await expect(surface.preview(change)).resolves.toContain("<svg");
    expect(draw).not.toHaveBeenCalled();
    expect(space).toHaveBeenCalledOnce();
    expect(space.mock.calls[0]![1]).toEqual(new Set(objects.map(object => object.id)));
    expect(layer.bundle().document.objects).toEqual([]);
  });
  it("skips occupancy reads when a Tutor update preserves placement", async () => {
    const s = setup(), target = s.views[0]!;
    await s.manager.toggle(target); await settle();
    const layer = boardLayer(s.manager, target) as DraftValidationProbe;
    const object: BoardObject = { id: "unchanged-bounds", kind: "rect", anchor: layer.surfaces[0]!.anchor,
      x: 30, y: 230, width: 100, height: 60, color: "#000000", strokeWidth: 2,
      createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "response" };
    layer.history.transact(document => document.objects.push(object), "tutor");
    const surface = layer.toolSurface();
    const change: ChangeSet<BoardSurfaceOperation> = { id: "color", taskId: "task", targetId: surface.id,
      baseRevision: (await surface.read()).target.revision, dependencies: [],
      operations: [{ type: "update", objectId: object.id, expectedRevision: 1, object: { ...object, color: "#ff0000" } }], };
    const draw = vi.spyOn(layer, "draw"), space = vi.spyOn(layer, "drawingSpace");
    await expect(surface.preview(change)).resolves.toContain("#ff0000");
    expect(draw).not.toHaveBeenCalled(); expect(space).not.toHaveBeenCalled();
    expect(layer.bundle().document.objects[0]!.color).toBe("#000000");
  });
  it("rejects Tutor geometry after prose moves into its space without repainting the rejected draft", async () => {
    const s = setup(), target = s.views[0]!;
    await s.manager.toggle(target); await settle();
    const layer = boardLayer(s.manager, target) as DraftValidationProbe, surface = layer.toolSurface();
    const object: BoardObject = { id: "unsafe", kind: "rect", anchor: layer.surfaces[0]!.anchor,
      x: 30, y: 230, width: 100, height: 60, color: "#000000", strokeWidth: 2,
      createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "response" };
    const change: ChangeSet<BoardSurfaceOperation> = { id: "unsafe", taskId: "task", targetId: surface.id,
      baseRevision: (await surface.read()).target.revision, dependencies: [], operations: [{ type: "add", object }], };
    vi.mocked(target.containerEl.querySelector<HTMLElement>(".markdown-preview-section > div")!.getBoundingClientRect)
      .mockReturnValue(new DOMRect(20, 100, 700, 400));
    const draw = vi.spyOn(layer, "draw");
    expect(() => surface.preview(change)).toThrow(t("upgrade.drawingSpaceChanged"));
    expect(draw).not.toHaveBeenCalled(); expect(layer.bundle().document.objects).toEqual([]);
  });
  it("keeps occupancy measurements separate for each anchor in a mixed Tutor batch", async () => {
    const target = view(), text = `${sourceText}\n\nA later paragraph.`;
    Object.assign(target, { getViewData: () => text });
    const later = document.createElement("div"); later.textContent = "A later paragraph.";
    target.containerEl.querySelector(".markdown-preview-section")!.append(later);
    vi.spyOn(later, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 400, 700, 40));
    registerMarkdownBoardSection(later, "Physics.md", { lineStart: 2, lineEnd: 2, text });
    const s = setup([target]); useSourceFile(s, text);
    await s.manager.toggle(target); await settle();
    const layer = boardLayer(s.manager, target) as DraftValidationProbe, surface = layer.toolSurface();
    expect(layer.surfaces).toHaveLength(2);
    const objects: BoardObject[] = layer.surfaces.flatMap((anchor, index) => [0, 1].map(number => ({
      id: `anchor-${index}-${number}`, kind: "rect", anchor: anchor.anchor,
      x: 30 + number * 40, y: 30, width: 20, height: 20, color: "#000000", strokeWidth: 2,
      createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "mixed",
    })));
    const space = vi.spyOn(layer, "drawingSpace").mockImplementation(anchor => ({
      viewport: { x: 0, y: anchor.getClientRect().y, width: 800, height: 100 }, protected: [],
    }));
    const change: ChangeSet<BoardSurfaceOperation> = { id: "mixed", taskId: "task", targetId: surface.id,
      baseRevision: (await surface.read()).target.revision, dependencies: [],
      operations: objects.map(object => ({ type: "add", object })), };
    await expect(surface.preview(change)).resolves.toContain("<svg");
    expect(space).toHaveBeenCalledTimes(2);
    expect(new Set(space.mock.calls.map(([anchor]) => anchor.id)).size).toBe(2);
    expect(layer.bundle().document.objects).toEqual([]);
  });
  it("starts every split flush and waits for the remaining splits when one fails", async () => {
    const first = view(), second = view("Other.md"), s = setup([first, second]);
    await s.manager.toggle(first); await s.manager.toggle(second); await settle();
    const left = boardLayer(s.manager, first) as DraftValidationProbe, right = boardLayer(s.manager, second) as DraftValidationProbe;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const leftFlush = vi.spyOn(left, "flush").mockRejectedValueOnce(new Error("failed-split"));
    const rightFlush = vi.spyOn(right, "flush").mockReturnValueOnce(gate);
    let settled = false;
    const switching = s.manager.changeRoot().catch(error => { settled = true; throw error; });
    await Promise.resolve(); await Promise.resolve();
    expect(leftFlush).toHaveBeenCalledOnce(); expect(rightFlush).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(canvas(first)).not.toBeNull(); expect(canvas(second)).not.toBeNull();
    release(); await expect(switching).rejects.toThrow("failed-split");
    expect(canvas(first)).not.toBeNull(); expect(canvas(second)).not.toBeNull();
  });
  it("persists the original scene before waiting for asynchronous preview fonts", async () => {
    const s = setup(), target = s.views[0]!;
    await s.manager.toggle(target); await settle();
    const layer = boardLayer(s.manager, target) as DraftValidationProbe;
    const object: BoardObject = { id: "durable-before-fonts", kind: "rect", anchor: layer.surfaces[0]!.anchor,
      x: 30, y: 230, width: 100, height: 60, color: "#ff0000", strokeWidth: 2,
      createdBy: "human", editedBy: "human", revision: 1, groupId: "original" };
    layer.history.transact(document => document.objects.push(object));
    let release!: () => void, entered!: () => void;
    const fontGate = new Promise<void>(resolve => { release = resolve; });
    const loading = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(boardFonts.ensureBoardFonts).mockImplementationOnce(() => { entered(); return fontGate; });
    const save = layer.save(); await loading;
    expect(stored(s.adapter)!.objects).toEqual([object]);
    release(); await save;
    expect(s.adapter.files.get(`Board Memory/boards/${layer.bundle().document.id}.svg`)).toContain("#ff0000");
  });
  it("hides a protected diagram after source reflow, keeps its data, and restores when the space returns",async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    const surface=layer.surfaces[0];const shape:BoardObject={id:"protected",kind:"rect",anchor:surface.anchor,x:30,y:230,width:160,height:100,color:"#000000",strokeWidth:2,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:"LAYOUT-response"};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),"tutor");layer.draw();expect(layer.hiddenLayoutObjects.size).toBe(0);
    const before=layer.bundle();const paragraph=target.containerEl.querySelector<HTMLElement>(".markdown-preview-section > div")!;
    vi.mocked(paragraph.getBoundingClientRect).mockReturnValue(new DOMRect(20,100,700,400));layer.draw();
    expect(layer.hiddenLayoutObjects.has(shape.id)).toBe(true);expect(layer.bundle()).toEqual(before);
    expect(target.containerEl.querySelector<HTMLButtonElement>('.atl-board-layout-notice')!.hidden).toBe(false);
    const ctx=canvas(target).getContext("2d")!;ctx.transform=vi.fn();
    layer.draft=layer.bundle().document.objects;layer.draw();
    expect(ctx.transform).not.toHaveBeenCalled(); // An erase/shape draft must not resurrect the hidden diagram.
    layer.draft=null;
    vi.mocked(paragraph.getBoundingClientRect).mockReturnValue(new DOMRect(20,100,700,200));layer.draw();
    expect(layer.hiddenLayoutObjects.size).toBe(0);expect(layer.bundle()).toEqual(before);
  });
  it("records explicit diagram rearrangement as a human edit while preserving its original author",async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    const shape:BoardObject={id:"rearranged",kind:"rect",anchor:layer.surfaces[0].anchor,x:30,y:80,width:100,height:60,color:"#000000",strokeWidth:2,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:"LAYOUT-response"};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),"tutor");layer.draw();layer.hiddenLayoutObjects.add(shape.id);
    const before=layer.bundle().document.objects[0];layer.inspectHiddenDrawing();
    const move=[...document.querySelectorAll<HTMLButtonElement>(".test-modal button")].find(button=>button.textContent===t("upgrade.drawingRearrange"))!;expect(move).toBeDefined();move.click();await settle();
    const after=layer.bundle().document.objects[0];expect(after).toMatchObject({id:shape.id,createdBy:"tutor",editedBy:"human"});expect(after.y).not.toBe(before.y);
    expect(s.agent.request).not.toHaveBeenCalled();expect(await s.transactions.journal.recordsForClient("obsidian")).toEqual([]);
    expect(stored(s.adapter)!.objects[0]).toEqual(after);button(target,"undo").click();await settle();expect(stored(s.adapter)!.objects[0]!.y).toBe(before.y);
  });
  it("keeps an existing annotated drawing visible when reflow only consumes its placement clearance",async()=>{
    const target=view(),text=sourceText+'\n\nA later paragraph.';Object.assign(target,{getViewData:()=>text});
    const first=target.containerEl.querySelector<HTMLElement>('.markdown-preview-section > div')!;
    vi.mocked(first.getBoundingClientRect).mockReturnValue(new DOMRect(20,100,700,31));
    const later=document.createElement('div');later.textContent='A later paragraph.';target.containerEl.querySelector('.markdown-preview-section')!.append(later);
    vi.spyOn(later,'getBoundingClientRect').mockReturnValue(new DOMRect(20,203.0625,700,24));
    registerMarkdownBoardSection(later,'Physics.md',{lineStart:2,lineEnd:2,text});
    const s=setup([target]);useSourceFile(s,text);await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    // Captured reading/source geometry: the drawing still clears the actual
    // paragraph, but the editor's larger line gaps consume the 12px reserve.
    const shape:BoardObject={id:'clearance-title',kind:'text',anchor:layer.surfaces[0].anchor,x:38,y:129.648893360161,width:302.4,height:22.45472837022133,text:'f(x) = x²',textStyle:{font:'handwritten',size:18,align:'left'},color:'#334155',strokeWidth:1,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-response'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),'tutor');layer.changed('tutor');await settle();
    const before=layer.bundle();
    expect(layer.hiddenLayoutObjects.size).toBe(0);
    const bounds={x:56,y:227.648893360161,width:306.4,height:26.45472837022133};
    expect(layer.drawingSpace(layer.surfaces[0]).protected.some((r:any)=>overlaps(r,bounds))).toBe(true);
    // Reserved figures stay visible after prose wraps; their source geometry
    // remains unchanged and the temporary block follows its paragraph.
    vi.mocked(later.getBoundingClientRect).mockReturnValue(new DOMRect(20,208,700,24));layer.draw();
    expect(layer.hiddenLayoutObjects.has(shape.id)).toBe(false);expect(layer.bundle()).toEqual(before);
    vi.mocked(later.getBoundingClientRect).mockReturnValue(new DOMRect(20,203.0625,700,24));layer.draw();
    expect(layer.hiddenLayoutObjects.size).toBe(0);expect(layer.bundle()).toEqual(before);
  });
  it.each(['blank','text','media'] as const)("treats a %s editor line according to its actual content during reflow",async(kind)=>{
    const target=view(),first=target.containerEl.querySelector<HTMLElement>('.markdown-preview-section > div')!;
    vi.mocked(first.getBoundingClientRect).mockReturnValue(new DOMRect(20,100,700,31));
    const content=document.createElement('div');content.className='cm-content';
    const line=document.createElement('div');line.className='cm-line';line.textContent=kind==='text'?'Visible source text':'\u200b   ';
    if(kind==='media')line.append(document.createElement('img'));
    content.append(line);target.containerEl.append(content);vi.spyOn(line,'getBoundingClientRect').mockReturnValue(new DOMRect(20,227,700,24));
    const s=setup([target]);await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    const shape:BoardObject={id:'editor-line-protection',kind:'rect',anchor:layer.surfaces[0].anchor,x:38,y:130,width:160,height:100,color:'#000000',strokeWidth:1,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-response'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),'tutor');layer.changed('tutor');await settle();
    expect(layer.hiddenLayoutObjects.has(shape.id)).toBe(kind!=='blank');
    expect(layer.bundle().document.objects[0]).toEqual(shape);
  });
  it("captures new math on the paragraph immediately above its drawing area rather than a distant heading",async()=>{
    const target=view(),text=sourceText+'\n\nDraw below this paragraph.';Object.assign(target,{getViewData:()=>text});
    const first=target.containerEl.querySelector<HTMLElement>('.markdown-preview-section > div')!;
    vi.mocked(first.getBoundingClientRect).mockReturnValue(new DOMRect(20,100,700,31));
    const later=document.createElement('div');later.textContent='Draw below this paragraph.';target.containerEl.querySelector('.markdown-preview-section')!.append(later);
    vi.spyOn(later,'getBoundingClientRect').mockReturnValue(new DOMRect(20,200,700,24));registerMarkdownBoardSection(later,'Physics.md',{lineStart:2,lineEnd:2,text});
    const s=setup([target]);useSourceFile(s,text);await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    layer.setTogether(true);await layer.performAgent({instruction:'Plot x² near 2',history:[],onReply:()=>{},math:true,requiresDrawing:true});
    // The model is deliberately unavailable: this checks the request/capture
    // origin, not whether a mocked response can draw a mathematically valid plot.
    expect(s.agent.request).toHaveBeenCalledOnce();expect(capture).toHaveBeenCalledOnce();
    const request=vi.mocked(s.agent.request).mock.calls[0]![0];
    expect(request.anchor).toMatchObject({kind:'markdown',quote:'Draw below this paragraph.'});
    expect(capture.mock.calls[0]![0].anchor).toEqual(request.anchor);
    expect(layer.bundle().document.objects).toHaveLength(0);
  });
  it("keeps a Tutor diagram visible while writing over it, undoing, redoing and reopening",async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as any;
    const shape:BoardObject={id:"annotated-diagram",kind:"rect",anchor:layer.surfaces[0].anchor,x:30,y:230,width:160,height:100,color:"#000000",strokeWidth:2,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:"LAYOUT-response"};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),"tutor");layer.changed("tutor");await settle();
    const original=layer.bundle().document.objects[0];
    button(target,"pen").click();pointer(target,"pointerdown",100,360);pointer(target,"pointermove",180,400);pointer(target,"pointerup",180,400);await settle();
    expect(layer.bundle().document.objects).toHaveLength(2);
    expect(layer.hiddenLayoutObjects.size).toBe(0);
    expect(layer.bundle().document.objects[0]).toEqual(original);
    button(target,"undo").click();await settle();expect(layer.hiddenLayoutObjects.size).toBe(0);
    button(target,"redo").click();await settle();expect(layer.hiddenLayoutObjects.size).toBe(0);
    const saved=stored(s.adapter)!;expect(saved.objects).toHaveLength(2);
    await s.manager.toggle(target);
    expect(target.containerEl.querySelector('.atl-board-layout-notice')).toBeNull();
    // Upgrade from 0.4.5 can leave a notice referring to a disposed controller.
    const stale=document.createElement('button');stale.className='atl-board-layout-notice';
    target.containerEl.querySelector('.view-content')!.append(stale);
    await s.manager.toggle(target);await settle();
    expect(stale.isConnected).toBe(false);
    expect(target.containerEl.querySelectorAll('.atl-board-layout-notice')).toHaveLength(1);
    const reopened=boardLayer(s.manager,target) as any;
    expect(reopened.hiddenLayoutObjects.size).toBe(0);
    expect(reopened.bundle().document.objects).toEqual(saved.objects);
  });
  it("anchors new ink to the artwork rather than a nearer paragraph and preserves alignment after reflow",async()=>{
    const target=view(),text=sourceText+'\n\nA later paragraph.';
    Object.assign(target,{getViewData:()=>text});
    const later=document.createElement('div');later.textContent='A later paragraph.';
    target.containerEl.querySelector('.markdown-preview-section')!.append(later);
    vi.spyOn(later,'getBoundingClientRect').mockReturnValue(new DOMRect(20,320,700,24));
    registerMarkdownBoardSection(later,'Physics.md',{lineStart:2,lineEnd:2,text});
    const s=setup([target]);useSourceFile(s,text);await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as any,origin=layer.surfaces[0];
    const shape:BoardObject={id:'art-origin',kind:'rect',anchor:origin.anchor,x:30,y:330,width:160,height:100,color:'#000000',strokeWidth:2,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-response'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),'tutor');layer.changed('tutor');await settle();
    const p=layer.objectSurface(shape).project({x:shape.x+40,y:shape.y+40});
    button(target,'pen').click();pointer(target,'pointerdown',p.x,p.y);pointer(target,'pointermove',p.x+50,p.y+20);pointer(target,'pointerup',p.x+50,p.y+20);await settle();
    const ink=layer.bundle().document.objects.find((o:BoardObject)=>o.kind==='ink')!;
    expect(ink.anchor).toEqual(shape.anchor);
    const offset=()=>{const a=layer.objectSurface(ink).project(ink),b=layer.objectSurface(shape).project(shape);return {x:a.x-b.x,y:a.y-b.y};};
    const before=offset();vi.mocked(later.getBoundingClientRect).mockReturnValue(new DOMRect(20,350,700,24));layer.draw();
    expect(offset()).toEqual(before);expect(layer.hiddenLayoutObjects.size).toBe(0);
    expect(layer.bundle().document.objects.find((o:BoardObject)=>o.id===shape.id)).toEqual(shape);
    button(target,'undo').click();await settle();button(target,'redo').click();await settle();
    expect(layer.bundle().document.objects.find((o:BoardObject)=>o.id===ink.id)?.anchor).toEqual(shape.anchor);
    const saved=stored(s.adapter)!;await s.manager.toggle(target);await s.manager.toggle(target);await settle();
    expect(boardLayer(s.manager,target).bundle().document.objects).toEqual(saved.objects);
  });
  it("keeps notes in the empty interior of a multi-object diagram on its shared anchor",async()=>{
    const target=view(),text=sourceText+'\n\nA later paragraph.';Object.assign(target,{getViewData:()=>text});
    const later=document.createElement('div');later.textContent='A later paragraph.';target.containerEl.querySelector('.markdown-preview-section')!.append(later);
    vi.spyOn(later,'getBoundingClientRect').mockReturnValue(new DOMRect(20,320,700,24));registerMarkdownBoardSection(later,'Physics.md',{lineStart:2,lineEnd:2,text});
    const s=setup([target]);useSourceFile(s,text);await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    const base:BoardObject={id:'axis-x',kind:'arrow',anchor:layer.surfaces[0].anchor,x:30,y:330,width:160,height:1,points:[{x:0,y:0},{x:160,y:0}],color:'#000000',strokeWidth:2,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-plot'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(base,{...base,id:'axis-y',width:1,height:100,points:[{x:0,y:0},{x:0,y:100}]}),'tutor');layer.changed('tutor');await settle();
    const p=layer.objectSurface(base).project({x:base.x+40,y:base.y+40});
    button(target,'pen').click();pointer(target,'pointerdown',p.x,p.y);pointer(target,'pointermove',p.x+40,p.y+10);pointer(target,'pointerup',p.x+40,p.y+10);await settle();
    expect(layer.bundle().document.objects.find((o:BoardObject)=>o.kind==='ink')?.anchor).toEqual(base.anchor);
    // Outside the composition, a new note still belongs to its document block.
    pointer(target,'pointerdown',500,460);pointer(target,'pointermove',530,470);pointer(target,'pointerup',530,470);await settle();
    expect(layer.bundle().document.objects.at(-1)?.anchor).toEqual(layer.surfaces[1].anchor);
  });
  it.each(['text','rect'] as const)("anchors a new %s annotation to artwork without joining or editing its group",async(tool)=>{
    const target=view(),text=sourceText+'\n\nA later paragraph.';Object.assign(target,{getViewData:()=>text});
    const later=document.createElement('div');later.textContent='A later paragraph.';target.containerEl.querySelector('.markdown-preview-section')!.append(later);
    vi.spyOn(later,'getBoundingClientRect').mockReturnValue(new DOMRect(20,320,700,24));registerMarkdownBoardSection(later,'Physics.md',{lineStart:2,lineEnd:2,text});
    const s=setup([target]);useSourceFile(s,text);await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    const shape:BoardObject={id:'annotation-reference',kind:'rect',anchor:layer.surfaces[0].anchor,x:30,y:330,width:160,height:100,color:'#000000',strokeWidth:2,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-reference'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),'tutor');layer.changed('tutor');await settle();
    const p=layer.objectSurface(shape).project({x:shape.x+40,y:shape.y+40});
    button(target,tool).click();pointer(target,'pointerdown',p.x,p.y);
    if(tool==='text'){
      const editor=target.containerEl.querySelector<HTMLTextAreaElement>('.atl-board-text-editor')!;editor.value='Why?';editor.dispatchEvent(new Event('input'));
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));
    }else{pointer(target,'pointermove',p.x+40,p.y+20);pointer(target,'pointerup',p.x+40,p.y+20);}
    await settle();const objects=layer.bundle().document.objects;
    expect(objects).toHaveLength(2);expect(objects[0]).toEqual(shape);
    expect(objects[1]).toMatchObject({kind:tool,anchor:shape.anchor,createdBy:'human'});
    expect(objects[1].groupId).not.toBe(shape.groupId);
  });
  it("selects artwork outside its paragraph while allowing annotation of a locked reference without editing it",async()=>{
    const target=view(),text=sourceText+'\n\nA later paragraph.';Object.assign(target,{getViewData:()=>text});
    const later=document.createElement('div');later.textContent='A later paragraph.';target.containerEl.querySelector('.markdown-preview-section')!.append(later);
    vi.spyOn(later,'getBoundingClientRect').mockReturnValue(new DOMRect(20,320,700,24));registerMarkdownBoardSection(later,'Physics.md',{lineStart:2,lineEnd:2,text});
    const s=setup([target]);useSourceFile(s,text);await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    const shape:BoardObject={id:'locked-reference',kind:'rect',anchor:layer.surfaces[0].anchor,x:30,y:330,width:160,height:100,color:'#000000',strokeWidth:2,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-reference',layerId:'reference'};
    layer.history.transact((doc:BoardDocument)=>{doc.layers!.push({id:'reference',name:'Reference',order:1,visible:true,locked:false,opacity:1,blendMode:'normal'});doc.objects.push(shape);},'tutor');layer.changed('tutor');await settle();
    const writingLayer=layer.activeLayerId;
    const p=layer.objectSurface(shape).project({x:shape.x+40,y:shape.y+40});
    button(target,'select').click();pointer(target,'pointerdown',p.x,p.y);pointer(target,'pointerup',p.x,p.y);await settle();expect(layer.selection.has(shape.id)).toBe(true);
    layer.history.transact((doc:BoardDocument)=>{doc.layers!.find(l=>l.id==='reference')!.locked=true;});layer.changed();await settle();
    layer.selection.clear();layer.activeLayerId=writingLayer; // Switch to the unlocked writing layer, not the selected reference.
    button(target,'pen').click();pointer(target,'pointerdown',p.x,p.y);pointer(target,'pointermove',p.x+40,p.y+10);pointer(target,'pointerup',p.x+40,p.y+10);await settle();
    expect(layer.bundle().document.objects.find((o:BoardObject)=>o.kind==='ink')?.anchor).toEqual(shape.anchor);
    expect(layer.bundle().document.objects.find((o:BoardObject)=>o.id===shape.id)).toEqual(shape);
    button(target,'erase').click();pointer(target,'pointerdown',p.x-40,p.y-40);pointer(target,'pointerup',p.x-40,p.y-40);await settle();
    expect(layer.bundle().document.objects.find((o:BoardObject)=>o.id===shape.id)).toEqual(shape);
    layer.history.transact((doc:BoardDocument)=>{doc.layers!.find(l=>l.id==='reference')!.visible=false;});layer.changed();await settle();
    button(target,'pen').click();pointer(target,'pointerdown',180,480);pointer(target,'pointermove',190,490);pointer(target,'pointerup',190,490);await settle();
    expect(layer.bundle().document.objects.at(-1)?.anchor).toEqual(layer.surfaces[1].anchor);
  });
  it.each(["text","ellipse"] as const)("allows manual %s over a drawing but still keeps the next new diagram away",async(kind)=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    const surface=layer.surfaces[0],shape:BoardObject={id:"original-diagram",kind:"rect",anchor:surface.anchor,x:30,y:230,width:160,height:100,color:"#000000",strokeWidth:2,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:"LAYOUT-response"};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(shape),"tutor");
    layer.history.transact((doc:BoardDocument)=>doc.objects.push({...shape,id:"manual-note",kind,x:55,y:245,width:90,height:28,groupId:"manual",...(kind==="text"?{text:"Why?",textStyle:{font:"sans",size:20,align:"left"}}:{})}));
    layer.draw();expect(layer.hiddenLayoutObjects.size).toBe(0);
    const next=layer.placeOperations([{type:"add",object:{...shape,id:"next-diagram"}}],surface);
    expect(overlaps(next[0].object,shape)).toBe(false);
    const before=layer.bundle();
    vi.mocked(target.containerEl.querySelector<HTMLElement>(".markdown-preview-section > div")!.getBoundingClientRect).mockReturnValue(new DOMRect(20,100,700,400));layer.draw();
    expect(layer.hiddenLayoutObjects.has(shape.id)).toBe(true);expect(layer.bundle()).toEqual(before);
  });
  it("refuses crowded layouts while allowing explicit source annotations without changing human objects",async()=>{
    const s=setup(),target=s.views[0]!;await s.manager.toggle(target);await settle();const layer=boardLayer(s.manager,target) as any;
    vi.mocked(target.containerEl.querySelector<HTMLElement>(".markdown-preview-section > div")!.getBoundingClientRect).mockReturnValue(new DOMRect(0,0,800,600));layer.draw();
    const shape={id:"circle",kind:"ellipse",anchor:layer.surfaces[0].anchor,x:30,y:30,width:160,height:100,color:"#000000",strokeWidth:2,createdBy:"tutor",editedBy:"tutor",revision:1,groupId:"annotation"};
    expect(()=>layer.placeOperations([{type:"add",object:shape}],layer.surfaces[0])).toThrow(t("upgrade.drawingSpaceChanged"));
    expect(layer.placeOperations([{type:"add",object:shape}],layer.surfaces[0],true)[0].object).toEqual(shape);
    expect(layer.bundle().document.objects).toHaveLength(0);
  });
  it("fits a rotated Tutor shape inside the portable preview", async () => {
    const agent: BoardAgent = {
      request: vi.fn(
        async (request: BoardAgentRequest): Promise<BoardAgentResult> => ({
          ok: true,
          requestId: request.requestId,
          baseRevision: request.baseRevision,
          description: "Rotated diagram",
          operations: [
            {
              type: "add",
              object: {
                id: "rotated-shape",
                kind: "rect",
                anchor: request.anchor,
                x: 200,
                y: 50,
                width: 220,
                height: 20,
                rotation: Math.PI / 2,
                color: "#123456",
                strokeWidth: 2,
                createdBy: "tutor",
                editedBy: "tutor",
                revision: 1,
                groupId: "rotated-group",
              },
            },
          ],
        }),
      ),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    const {
      manager,
      adapter,
      views: [target],
    } = setup(undefined, agent);
    await manager.toggle(target);
    await settle();
    button(target!, "send").click();
    await settle();
    const id = stored(adapter)!.id,
      svg = adapter.files.get(`Board Memory/boards/${id}.svg`)!;
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(
      Number(parsed.documentElement.getAttribute("height")),
    ).toBeGreaterThanOrEqual(240);
    const matrix = parsed
      .querySelector("g")!
      .getAttribute("transform")!
      .match(/matrix\(([^)]+)\)/)![1]!
      .split(" ")
      .map(Number);
    const corners = [
      [0, 0],
      [220, 0],
      [0, 20],
      [220, 20],
    ].map(([x = 0, y = 0]) => ({
      x: matrix[0]! * x + matrix[2]! * y + matrix[4]!,
      y: matrix[1]! * x + matrix[3]! * y + matrix[5]!,
    }));
    expect(Math.min(...corners.map((point) => point.x))).toBeGreaterThanOrEqual(
      19,
    );
    expect(Math.min(...corners.map((point) => point.y))).toBeGreaterThanOrEqual(
      19,
    );
    expect(Math.max(...corners.map((point) => point.y))).toBeLessThan(
      Number(parsed.documentElement.getAttribute("height")),
    );
  });
  for (const rotation of [0, 90, 180, 270] as const)
    it(`resizes a ${rotation}° PDF from its screen handle while fixing the opposite corner`, async () => {
      const target = pdfView(rotation),
        { manager, adapter } = setup([target]);
      await manager.toggle(target);
      await settle();
      await draw(target);
      const original = stored(adapter, "Diagram.pdf")!.objects[0]!;
      button(target, "select").click();
      pointer(target, "pointerdown", 140, 180);
      pointer(target, "pointermove", 180, 210);
      pointer(target, "pointerup", 180, 210);
      await settle();
      const resized = stored(adapter, "Diagram.pdf")!.objects[0]!;
      expect(resized.width).toBeCloseTo(original.width * 2);
      expect(resized.height).toBeCloseTo(original.height * 2);
      const surface = discoverBoardSurfaces(target, "Diagram.pdf")[0]!;
      const corners = [
        [0, 0],
        [resized.width, 0],
        [0, resized.height],
        [resized.width, resized.height],
      ].map(([x = 0, y = 0]) =>
        surface.project({ x: resized.x + x, y: resized.y + y }),
      );
      expect(Math.min(...corners.map((point) => point.x))).toBeCloseTo(100);
      expect(Math.min(...corners.map((point) => point.y))).toBeCloseTo(150);
      expect(Math.max(...corners.map((point) => point.x))).toBeCloseTo(180);
      expect(Math.max(...corners.map((point) => point.y))).toBeCloseTo(210);
    });

  it("draws, persists, undoes, and restores editable ink after reopening", async () => {
    const {
      manager,
      adapter,
      views: [target],
    } = setup();
    await manager.toggle(target);
    await settle();
    await draw(target!);
    expect(stored(adapter)?.objects).toHaveLength(1);
    expect(stored(adapter)?.objects[0]?.kind).toBe("ink");
    expect(
      [...adapter.files.keys()].filter((path) => path.endsWith(".ink.json")),
    ).toHaveLength(1);
    expect(capture).not.toHaveBeenCalled();
    button(target!, "undo").click();
    await settle();
    expect(stored(adapter)?.objects).toHaveLength(0);
    button(target!, "redo").click();
    await settle();
    expect(stored(adapter)?.objects).toHaveLength(1);
    const revision = stored(adapter)!.revision;
    await manager.toggle(target);
    expect(canvas(target!)).toBeNull();
    await manager.toggle(target);
    await settle();
    expect(canvas(target!)).not.toBeNull();
    expect(stored(adapter)!.revision).toBe(revision);
    expect(notice).not.toHaveBeenCalled();
  });

  it("keeps native text-field undo and delete shortcuts away from the drawing history", async () => {
    const {
      manager,
      adapter,
      views: [target],
    } = setup();
    await manager.toggle(target);
    await settle();
    await draw(target!);
    const input = target!.containerEl.querySelector<HTMLInputElement>(
      '.atl-board-quick-input input[type="text"]',
    )!;
    input.value = "Keep typing";
    input.focus();
    const undo = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const remove = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(undo);
    input.dispatchEvent(remove);
    await settle();
    expect(undo.defaultPrevented).toBe(false);
    expect(remove.defaultPrevented).toBe(false);
    expect(stored(adapter)?.objects).toHaveLength(1);
    canvas(target!).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    expect(stored(adapter)?.objects).toHaveLength(0);
  });

  it.each(["input-scroll", "dom-refresh", "viewport-scroll"] as const)(
    "keeps explicit requests through incidental %s but cancels viewport changes",
    async (change) => {
      const {
        manager,
        agent,
        views: [target],
      } = setup();
      await manager.toggle(target);
      await settle();
      const input = target!.containerEl.querySelector<HTMLInputElement>(
        '.atl-board-quick-input input[type="text"]',
      )!;
      input.value =
        "Continue my drawing after this long instruction moves the caret.";
      button(target!, "send").click();
      if (change === "input-scroll") input.dispatchEvent(new Event("scroll"));
      else if (change === "dom-refresh") {
        target!.containerEl
          .querySelector(".view-content")!
          .append(document.createElement("span"));
        await Promise.resolve();
      } else
        target!.containerEl
          .querySelector(".markdown-preview-view")!
          .dispatchEvent(new Event("scroll"));
      await settle();
      expect(agent.request).toHaveBeenCalledTimes(
        change === "viewport-scroll" ? 0 : 1,
      );
      expect(capture).toHaveBeenCalledTimes(
        change === "viewport-scroll" ? 0 : 1,
      );
    },
  );

  it("drops late Tutor operations after pausing and stops automatic capture", async () => {
    let resolve!: (result: BoardAgentResult) => void;
    let request: BoardAgentRequest | undefined;
    const agent: BoardAgent = {
      request: vi.fn((input: BoardAgentRequest) => {
        request = input;
        return new Promise<BoardAgentResult>((done) => {
          resolve = done;
        });
      }),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    const {
      manager,
      adapter,
      views: [target],
    } = setup(undefined, agent);
    await manager.toggle(target);
    await settle();
    await draw(target!);
    const input = target!.containerEl.querySelector<HTMLInputElement>(
      '.atl-board-quick-input input[type="text"]',
    )!;
    input.value = "Add a smile";
    button(target!, "send").click();
    await settle();
    expect(agent.request).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    button(target!, "pause").click();
    resolve({
      ok: true,
      requestId: request!.requestId,
      baseRevision: request!.baseRevision,
      description: "A smile",
      operations: [
        {
          type: "add",
          object: {
            id: "Tutor-late",
            kind: "ellipse",
            anchor: request!.anchor,
            x: 10,
            y: 20,
            width: 30,
            height: 30,
            color: "#112233",
            strokeWidth: 2,
            createdBy: "tutor",
            editedBy: "tutor",
            revision: 1,
            groupId: "response-1",
          },
        },
      ],
    });
    await settle();
    await draw(target!);
    await vi.advanceTimersByTimeAsync(4000);
    expect(stored(adapter)?.objects.map((object) => object.createdBy)).toEqual([
      "human",
      "human",
    ]);
    expect(capture).toHaveBeenCalledOnce();
    expect(agent.cancel).toHaveBeenCalled();
  });

  it("shares source state across splits and cleans only the closed view", async () => {
    const first = view(),
      second = view(),
      { manager, adapter } = setup([first, second]);
    await manager.toggle(first);
    await settle();
    await draw(first);
    await manager.sync();
    await settle();
    expect(canvas(second)).not.toBeNull();
    await draw(second);
    expect(stored(adapter)?.objects).toHaveLength(2);
    await manager.toggle(first);
    await settle();
    expect(canvas(first)).toBeNull();
    expect(canvas(second)).not.toBeNull();
    await draw(second);
    expect(stored(adapter)?.objects).toHaveLength(3);
    expect(
      [...adapter.files.keys()].filter((path) =>
        /\/[^.]+\.board\.json$/.test(path),
      ),
    ).toHaveLength(1);
    expect(notice).not.toHaveBeenCalled();
  });

  it("saves source reflow in two splits with identical metadata and preserves drawing undo", async () => {
    const first = view(), second = view(), scenario = setup([first, second]);
    useSourceFile(scenario);
    await scenario.manager.toggle(first); await settle();
    await draw(first); await scenario.manager.sync(); await settle();
    const internals = scenario.manager as unknown as { registries: Map<string, BoardAnchorRegistry> };
    internals.registries.get(first.file!.path)!.reconcile(sourceText + "\n\nNew paragraph.");
    const left = boardLayer(scenario.manager, first) as LayerProbe & { invalidateSource(): void; save(): Promise<void> };
    const right = boardLayer(scenario.manager, second) as typeof left;
    left.invalidateSource();
    await vi.advanceTimersByTimeAsync(1);
    right.invalidateSource();
    await Promise.all([left.save(), right.save()]);
    expect(left.bundle().document).toEqual(right.bundle().document);
    expect([...scenario.adapter.files.keys()].some(path => path.includes(".conflict-"))).toBe(false);
    expect(left.history.canUndo).toBe(true);
    button(first, "undo").click(); await settle();
    expect(stored(scenario.adapter)?.objects).toHaveLength(0);
  });

  it("flushes old-root strokes before releasing controllers and opens a separate new-root board", async () => {
    const {
      manager,
      adapter,
      settings,
      views: [target],
    } = setup();
    await manager.toggle(target);
    await settle();
    await draw(target!);
    await manager.changeRoot();
    const old = [...adapter.files.entries()]
      .filter(([path]) => path.startsWith("Board Memory/"))
      .map(([path, value]) => [path, value]);
    settings.memoryRoot = "New Board Memory";
    manager.rootChanged();
    await settle();
    await manager.toggle(target);
    await settle();
    await draw(target!);
    expect(
      [...adapter.files.entries()]
        .filter(([path]) => path.startsWith("Board Memory/"))
        .map(([path, value]) => [path, value]),
    ).toEqual(old);
    expect(
      [...adapter.files.keys()].some(
        (path) =>
          path.startsWith("New Board Memory/boards/") &&
          path.endsWith(".board.json"),
      ),
    ).toBe(true);
    expect(notice).not.toHaveBeenCalled();
  });
});

describe("reference-image painting integration", () => {
  function referenceScenario() {
    vi.spyOn(HTMLImageElement.prototype,"decode").mockResolvedValue(undefined);
    vi.spyOn(HTMLImageElement.prototype,"naturalWidth","get").mockReturnValue(4);
    vi.spyOn(HTMLImageElement.prototype,"naturalHeight","get").mockReturnValue(4);
    vi.spyOn(window.URL,"createObjectURL").mockReturnValue("blob:reference");
    vi.spyOn(window.URL,"revokeObjectURL").mockImplementation(()=>{});
    const ctx=document.createElement("canvas").getContext("2d")!;
    ctx.getImageData=vi.fn(()=>({data:new Uint8ClampedArray(Array.from({length:64},(_,i)=>i%4===3?255:96)),width:4,height:4,colorSpace:"srgb" as const}));
    const provider={id:"test",availability:async()=>({available:true}),generate:vi.fn(async()=>[{
      id:"image",bytes:new Uint8Array([1,2]),mimeType:"image/png",width:4,height:4,model:"test-image",latencyMs:1,provenance:{provider:"test",generatedAt:"now"}
    }]),cancel:vi.fn()} as unknown as ImageGenerationProvider;
    const conversation=new TutorConversation({run:async()=>({text:"chat"})});
    const page=view();
    vi.mocked(page.containerEl.querySelector<HTMLElement>(".markdown-preview-section > div")!.getBoundingClientRect).mockReturnValue(new DOMRect(20,100,700,80));
    const scenario=setup([page],undefined,conversation,provider);
    return {...scenario,provider,conversation};
  }
  it("does not call image generation on a crowded page",async()=>{
    const s=referenceScenario(),target=s.views[0]!;
    vi.mocked(target.containerEl.querySelector<HTMLElement>(".markdown-preview-section > div")!.getBoundingClientRect).mockReturnValue(new DOMRect(0,0,800,600));
    await s.manager.toggle(target);await settle();await s.conversation.submit("画一个鲸鱼娘角色",{route:"board"});await settle();
    expect(s.provider.generate).not.toHaveBeenCalled();expect(s.conversation.state.error).toContain(t("upgrade.drawingSpaceChanged"));expect(stored(s.adapter)?.objects??[]).toHaveLength(0);
  });
  it("shows a content refusal without painting, and offers editing rather than a paid retry",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    vi.mocked(s.provider.generate).mockRejectedValueOnce(new ImageContentRefusal("ip","IPInfringementSuspect"));
    await s.conversation.submit("请你绘制一个二次元的米老鼠",{route:"board"});await settle();
    expect(s.conversation.state).toMatchObject({taskStatus:"blocked",canRetry:false});
    expect(stored(s.adapter)?.objects??[]).toHaveLength(0);
    expect([...s.adapter.files.keys()].some(p=>p.includes('/references/'))).toBe(false);
    expect(document.querySelector('.test-modal')).toBeNull();
    const edit=[...target.containerEl.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===t('board.editRequest'))!;
    expect(edit.hidden).toBe(false);edit.click();
    expect(target.containerEl.querySelector<HTMLInputElement>('.atl-board-quick-input input')?.value).toBe("请你绘制一个二次元的米老鼠");
    await s.conversation.retry();expect(s.provider.generate).toHaveBeenCalledOnce();
  });
  it("shows a saved original before committing native strokes and undoes the entire reconstruction",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("画一个鲸鱼娘角色",{route:"board"});await settle();
    expect(s.provider.generate).toHaveBeenCalledOnce();expect(s.agent.request).not.toHaveBeenCalled();
    expect([...s.adapter.files.keys()].some(p=>p.includes('/references/')&&p.endsWith('.png'))).toBe(true);
    expect(stored(s.adapter)?.objects??[]).toHaveLength(0);
    const instant=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.referenceInstant'))!;
    expect(s.conversation.state.error).toBeNull();expect(instant).toBeDefined();instant.click();await settle();await pending;
    const objects=stored(s.adapter)!.objects;expect(objects.length).toBeGreaterThan(0);expect(objects.every(o=>o.kind==='path')).toBe(true);expect(objects.some(o=>o.fill?.kind==='solid')).toBe(true);expect(objects.some(o=>o.brush?.kind==='pen')).toBe(true);
    expect(s.conversation.state.commit).toMatchObject({durability:"committed",createdIds:objects.map(object=>object.id),updatedIds:[],deletedIds:[]});
    expect((await s.transactions.journal.recordsForClient("obsidian"))[0]?.phase).toBe("committed");
    button(target,'undo').click();await settle();expect(stored(s.adapter)!.objects).toHaveLength(0);
  });
  it("keeps a semantic image-first garden request on the image pipeline despite the word 示意图", async () => {
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const instruction="我希望这个图画中增加颜色填充，并且你可以先生成示意图，再根据示意图来调整";
    const prompt="包豪斯抽象风格的法式花园，几何花坛和对称喷泉，鲜明的颜色填充";
    const pending=s.conversation.submit(instruction,{route:"board",requiresDrawing:true,drawingPlan:{mode:"reference",prompt}});await settle();
    expect(s.provider.generate).toHaveBeenCalledOnce();expect(s.agent.request).not.toHaveBeenCalled();
    const sent=vi.mocked(s.provider.generate).mock.calls[0]![0].prompt;
    expect(sent).toContain(prompt);expect(sent).not.toContain("finished character reference");
    expect(s.conversation.state.latestReply).toBe(t("board.referenceGenerating"));
    const instant=[...document.querySelectorAll<HTMLButtonElement>(".atl-reference-preview button")].find(b=>b.textContent===t("board.referenceInstant"))!;
    instant.click();await settle();await pending;
    expect(s.conversation.state.taskStatus).toBe("complete");expect(stored(s.adapter)!.objects.length).toBeGreaterThan(0);
  });
  it("persists Tutor annotations in an existing drawing slot after clearing the stream preview",async()=>{
    const s=referenceScenario(),target=s.views[0]!;useSourceFile(s,sourceText);await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as any,anchor=layer.surfaces[0].anchor;
    const object:BoardObject={id:'OBJ-tutor-reference',kind:'rect',anchor,x:20,y:220,width:320,height:200,color:'#000000',strokeWidth:2,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-reference'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(object),'tutor');layer.changed('tutor');await settle();layer.draw();
    const slot=layer.integration.layout.binding(object.id).slot.id;layer.active=layer.projections.get(slot);
    vi.mocked(s.agent.request).mockImplementation(async request=>({ok:true,requestId:request.requestId,baseRevision:request.baseRevision,description:'Circle',operations:[{type:'add',object:{...object,id:'OBJ-new-tutor-note',anchor:request.anchor,kind:'ellipse',x:32,y:32,width:40,height:40,groupId:'response'}}]}));
    await s.conversation.submit('在图上添加一个圈',{route:'board',requiresDrawing:true,drawingPlan:{mode:'native',placement:'annotation'}});await settle();
    const sent=vi.mocked(s.agent.request).mock.calls[0]![0];
    expect(sent.objects.find(o=>o.id===object.id)).toMatchObject({x:20,y:220,width:320,height:200});
    const mapping=sent.objectToImage?.[object.id];expect(mapping).toBeDefined();
    const imageToClient=multiplyBoardMatrices(layer.active.toClient(),sent.snapshot.imageToBoard);
    const mapped=multiplyBoardMatrices(imageToClient,mapping!);
    expect(mapped).toEqual(layer.objectSurface(object).toClient());
    expect(s.conversation.state.taskStatus).toBe('complete');const added=layer.history.document.objects.find((o:BoardObject)=>o.id!==object.id)!;
    expect(layer.integration.layout.binding(added.id)?.slot.id).toBe(slot);
    const saved=JSON.parse(s.adapter.files.get(layer.repository.layouts.path(layer.history.document.id))!);
    expect(saved.slots.find((s:any)=>s.id===slot).bindings.map((b:any)=>b.objectId)).toContain(added.id);
    const before=layer.objectSurface(added).project(added);await s.manager.toggle(target);await s.manager.toggle(target);await settle();
    const reopened=boardLayer(s.manager,target) as any;expect(reopened.objectSurface(added).project(added)).toEqual(before);
  });
  it("keeps confirmed annotation attachment in the same undo order as later drawing",async()=>{
    const s=referenceScenario(),target=s.views[0]!;useSourceFile(s,sourceText);await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as any,anchor=layer.surfaces[0].anchor;
    const figure:BoardObject={id:'OBJ-association-figure',kind:'rect',anchor,x:20,y:220,width:320,height:200,color:'#000000',strokeWidth:2,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-association'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(figure),'tutor');layer.changed('tutor');await settle();
    const note:BoardObject={...figure,id:'OBJ-legacy-note',groupId:'legacy-notes',x:70,y:240,createdBy:'human',editedBy:'human'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(note),'human');layer.changed();await settle();
    const original=layer.history.document.objects.find((o:BoardObject)=>o.id===note.id),slot=layer.integration.layout.binding(figure.id).slot.id;
    layer.together=true;const notify=vi.spyOn(layer.scheduler,'changed').mockImplementation(()=>{});
    layer.selection=new Set([figure.id,note.id]);await layer.options();
    [...document.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(b=>b.textContent===t('board.attachAnnotations'))!.click();await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(layer.integration.layout.binding(note.id)?.slot.id).toBe(slot);
    const extra={...note,id:'OBJ-after-association',groupId:'new-note'};
    layer.history.transact((doc:BoardDocument)=>doc.objects.push(extra),'human');layer.pendingBindings.set(extra.id,{slotId:slot,matrix:[1,0,0,1,0,0]});layer.changed();await settle();layer.pendingBindings.clear();
    button(target,'undo').click();await settle();expect(layer.history.document.objects.some((o:BoardObject)=>o.id===extra.id)).toBe(false);expect(layer.integration.layout.binding(note.id)).toBeDefined();
    notify.mockClear();
    button(target,'undo').click();await settle();expect(layer.integration.layout.binding(note.id)).toBeUndefined();expect(layer.history.document.objects.find((o:BoardObject)=>o.id===note.id)).toEqual(original);
    expect(notify).not.toHaveBeenCalled();
    button(target,'redo').click();await settle();expect(layer.integration.layout.binding(note.id)?.slot.id).toBe(slot);
    expect(notify).not.toHaveBeenCalled();
    button(target,'redo').click();await settle();expect(layer.integration.layout.binding(extra.id)?.slot.id).toBe(slot);
  });
  it("selects thin projected arrows with normal tolerance without rescanning a thousand-object scene",async()=>{
    const s=referenceScenario(),target=s.views[0]!;useSourceFile(s,sourceText);await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as any,anchor=layer.surfaces[0].anchor;
    const arrow:BoardObject={id:'OBJ-thin-arrow',kind:'arrow',points:[{x:0,y:0},{x:120,y:0}],anchor,x:200,y:80,width:120,height:0.5,color:'#000000',strokeWidth:2,createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'LAYOUT-thin-arrow'};
    layer.history.transact((doc:BoardDocument)=>{doc.objects.push(arrow);for(let i=0;i<999;i++)doc.objects.push({...arrow,id:`OBJ-dense-${i}`,x:500+i*20,y:500+i*20});},'tutor');layer.changed('tutor');await settle();layer.draw();
    const point=layer.objectSurface(arrow).project({x:arrow.x+40,y:arrow.y-2});expect(layer.hit(point)?.id).toBe(arrow.id);
    const scene=layer.history.renderDocument;
    const objects=new Proxy(scene.objects,{get(array,key,receiver){if(key===Symbol.iterator||['map','forEach','filter'].includes(String(key)))throw Error('pointer-full-scene-scan');return Reflect.get(array,key,receiver);}});
    vi.spyOn(layer.history,'renderDocument','get').mockReturnValue({...scene,objects});
    for(let i=0;i<10;i++)expect(layer.hit(point)?.id).toBe(arrow.id);
  });
  it("honors a native semantic decision even when old character keywords match", async () => {
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    await s.conversation.submit("画一个角色的轮廓，不要生图",{route:"board",requiresDrawing:true,drawingPlan:{mode:"native"}});
    expect(s.provider.generate).not.toHaveBeenCalled();expect(s.agent.request).toHaveBeenCalledOnce();
  });
  it("previews mixed materials without regenerating the image, and preserves the choice on retry",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("画一个角色",{route:"board"});await settle();
    const select=document.querySelector<HTMLSelectElement>('[data-reference-setting="preset"]')!;
    expect(select.value).toBe('illustration');select.value='crayon';select.dispatchEvent(new Event('change'));
    const outline=document.querySelector<HTMLSelectElement>('[data-reference-setting="outline"]')!;
    outline.value='pen';outline.dispatchEvent(new Event('change'));
    expect(document.querySelector<HTMLSelectElement>('[data-reference-setting="preset"]')!.value).toBe('custom');
    expect(s.provider.generate).toHaveBeenCalledOnce();expect(stored(s.adapter)?.objects??[]).toHaveLength(0);
    const cancel=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.cancel'))!;
    cancel.click();await pending;const retry=s.conversation.retry();await settle();
    expect(document.querySelector<HTMLSelectElement>('[data-reference-setting="outline"]')!.value).toBe('pen');
    expect(document.querySelector<HTMLSelectElement>('[data-reference-setting="colorBrush"]')!.value).toBe('crayon');
    const instant=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.referenceInstant'))!;
    instant.click();await settle();await retry;
    const objects=stored(s.adapter)!.objects;
    expect(objects.some(o=>o.fill?.kind==='brush'&&o.fill.brush?.kind==='crayon')).toBe(true);
    expect(objects.some(o=>o.brush?.kind==='pen')).toBe(true);expect(s.provider.generate).toHaveBeenCalledOnce();
    const metadata=[...s.adapter.files].filter(([path])=>path.includes('/references/')&&path.endsWith('.json')).map(([,value])=>JSON.parse(new TextDecoder().decode(new Uint8Array(value.split(",").map(Number)))));
    expect(metadata.some(m=>m.algorithm==='region-brush-v2'&&m.style.outlineBrush==='pen'&&m.style.colorBrush==='crayon')).toBe(true);
    button(target,'undo').click();await settle();expect(stored(s.adapter)!.objects).toHaveLength(0);
  });
  it("keeps reference style preview through temporary surface remeasurement but cancels a real source change",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("画一个角色",{route:"board"});await settle();
    const layer=boardLayer(s.manager,target);
    const unavailable=vi.spyOn(layer,'surfaceFor').mockReturnValue(undefined);
    const select=document.querySelector<HTMLSelectElement>('[data-reference-setting="preset"]')!;
    select.value='oil';select.dispatchEvent(new Event('change'));await settle();
    expect(s.conversation.state.busy).toBe(true);
    expect(document.querySelector('.atl-reference-preview')).not.toBeNull();
    expect([...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.referencePlay'))?.disabled).toBe(false);
    unavailable.mockRestore();
    await s.manager.changed(target.file!.path);await pending;await settle();
    expect(s.conversation.state.taskStatus).toBe('cancelled');
    expect(stored(s.adapter)?.objects??[]).toHaveLength(0);
    expect(document.querySelector('.atl-reference-preview')).toBeNull();
  });
  it("finishes a hidden window's reference animation without waiting for throttled frame timers",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("画一个角色",{route:"board"});await settle();
    vi.spyOn(document,'hidden','get').mockReturnValue(true);
    const play=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.referencePlay'))!;
    play.click();await settle();await pending;
    expect(s.conversation.state.taskStatus).toBe('complete');
    expect(stored(s.adapter)!.objects.length).toBeGreaterThan(0);
    button(target,'undo').click();await settle();expect(stored(s.adapter)!.objects).toHaveLength(0);
  });
  it("cancels midway without resurrecting preview strokes or deleting the saved reference",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("画一个鲸鱼娘角色",{route:"board"});await settle();
    const start=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.referencePlay'))!;
    expect(start).toBeDefined();start.click();
    target.containerEl.querySelector<HTMLButtonElement>('.atl-reference-play-controls button:last-child')!.click();
    await settle();await pending;await vi.advanceTimersByTimeAsync(4000);await settle();
    expect(stored(s.adapter)?.objects??[]).toHaveLength(0);
    expect([...s.adapter.files.keys()].some(p=>p.endsWith('.png'))).toBe(true);
    expect(target.containerEl.querySelector('.atl-reference-play-controls')).toBeNull();
  });
  it("retries a cancelled preview from the stored original without generating another image",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const first=s.conversation.submit("画一个鲸鱼娘角色",{route:"board"});await settle();
    const cancel=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.cancel'))!;
    cancel.click();await first;await settle();
    expect(s.conversation.state.canRetry).toBe(true);
    const retry=s.conversation.retry();await settle();
    expect(s.provider.generate).toHaveBeenCalledOnce();
    const instant=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.referenceInstant'))!;
    instant.click();await settle();await retry;
    expect(stored(s.adapter)!.objects.length).toBeGreaterThan(0);
    expect(s.conversation.state.taskStatus).toBe("complete");
  });
  it("reuses a saved reference offline through the same preview and commit flow",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    s.adapter.files.set("Board Memory/references/offline.png","1,2");
    const pending=s.conversation.submit("重绘旧参考图",{route:"board",referencePath:"Board Memory/references/offline.png"});await settle();
    expect(s.provider.generate).not.toHaveBeenCalled();
    const instant=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.referenceInstant'))!;
    instant.click();await settle();await pending;
    expect(stored(s.adapter)!.objects.length).toBeGreaterThan(0);
  });
  it("offers the saved reference picker without needing an image provider request",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    await s.adapter.mkdir("Board Memory/references");
    s.adapter.files.set("Board Memory/references/pick.png","1,2");
    s.adapter.files.set("Board Memory/references/pick.png.json",JSON.stringify({prompt:"Saved character"}));
    button(target,"reuseReference").click();await settle();
    const pick=[...document.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(b=>b.textContent==="Saved character")!;
    expect(pick).toBeDefined();pick.click();await settle();
    expect(s.provider.generate).not.toHaveBeenCalled();
    const cancel=[...document.querySelectorAll<HTMLButtonElement>('.atl-reference-preview button')].find(b=>b.textContent===t('board.cancel'))!;
    cancel.click();await settle();
    expect(s.conversation.state.taskStatus).toBe("cancelled");
  });
  it("reports a missing image provider without falling back to chat or claiming to draw",async()=>{
    const conversation=new TutorConversation({run:vi.fn(async()=>({text:'chat'}))});
    const s=setup([view()],undefined,conversation);await s.manager.toggle(s.views[0]);await settle();
    await conversation.submit("画一个鲸鱼娘角色",{route:'board'});
    expect(conversation.state.error).toBe(t('board.imageProviderRequired'));expect(s.agent.request).not.toHaveBeenCalled();
  });
  it("rejects a full board before invoking the paid image provider",async()=>{
    const s=referenceScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as LayerProbe & {receive(bundle:BoardBundle):void};
    const bundle=layer.bundle(),anchor=discoverBoardSurfaces(target,target.file!.path)[0]!.anchor;
    bundle.document.objects=Array.from({length:19970},(_,i)=>({id:`capacity-${i}`,kind:"ellipse" as const,
      anchor,x:0,y:0,width:1,height:1,color:"#000000",strokeWidth:1,createdBy:"human" as const,editedBy:"human" as const,revision:1,groupId:"capacity"}));
    layer.receive(bundle);
    await s.conversation.submit("画一个鲸鱼娘角色",{route:"board"});
    expect(s.conversation.state.error).toBe(t("board.referenceCapacity"));
    expect(s.provider.generate).not.toHaveBeenCalled();
  });
});

describe("board quick input source binding", () => {
  function scenario(targets=[view()], captureContext?: (view: TestView) => Promise<ChatContext>) {
    const prepare=vi.fn(async (_text:string, options:TutorSubmitOptions):Promise<TutorSubmitOptions>=>({...options,route:'chat'}));
    const run=vi.fn(async()=>({text:'已收到'}));
    const conversation=new TutorConversation({prepare,run});
    return {...setup(targets,undefined,conversation,undefined,captureContext),prepare,run,conversation};
  }
  function send(target:TestView,text='继续这道题'):HTMLInputElement {
    const input=target.containerEl.querySelector<HTMLInputElement>('.atl-board-quick-input input')!;
    input.value=text;
    button(target,'send').click();
    return input;
  }
  async function explicitEntry(s:ReturnType<typeof scenario>,target:TestView,kind:'selection'|'reference'|'transcript') {
    if(kind==='selection'){
      const range=document.createRange();range.selectNodeContents(target.containerEl.querySelector('p')!);
      document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range);
      button(target,'drawSelection').click();
    } else if(kind==='reference') {
      await s.adapter.mkdir('Board Memory/references');
      s.adapter.files.set('Board Memory/references/fixed.png','1,2');
      s.adapter.files.set('Board Memory/references/fixed.png.json',JSON.stringify({prompt:'Saved drawing'}));
      button(target,'reuseReference').click();await settle();
      [...document.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(item=>item.textContent==='Saved drawing')!.click();
    } else {
      await draw(target);
      const layer=boardLayer(s.manager,target) as unknown as {history:BoardHistory};
      const timestamp=new Date().toISOString();
      layer.history.transact(doc=>{doc.semanticGroups=[{id:'transcript-fixture',kind:'handwriting',objectIds:[doc.objects[0]!.id],confidence:1,
        recognition:{text:'用户校正后的转写',alternatives:[],language:'zh-CN',provider:'test',recognizedAt:timestamp,userCorrected:true},createdAt:timestamp,updatedAt:timestamp}];});
      button(target,'transcripts').click();
      [...document.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(item=>item.textContent===t('board.send'))!.click();
    }
  }
  it.each(['selection','reference','transcript'] as const)('binds the actual %s menu entry to its originating view and local identity',async kind=>{
    const original=view(),other=view('Other.md'),chat:ChatContext={notePath:'Physics.md',sourceBinding:'host-token',
      observation:{source:'Physics.md',version:contextVersion(sourceText),scope:'document-excerpt',hasImage:false}};
    const captureContext=vi.fn(async()=>chat),s=scenario([original,other],captureContext);
    const submit=vi.spyOn(s.conversation,'submit').mockResolvedValue(undefined);
    await s.manager.toggle(original);await settle();s.active.view=other;
    await explicitEntry(s,original,kind);await settle();
    expect(captureContext).toHaveBeenCalledExactlyOnceWith(original);expect(submit).toHaveBeenCalledOnce();
    const options=submit.mock.calls[0]![1]!;
    expect((options.context as {chat:ChatContext}).chat).toBe(chat);
    expect(options).toMatchObject({source:'board',boardId:expect.any(String),route:kind==='transcript'?'chat':'board',
      learningTurn:{entry:'board',kind:kind==='transcript'?'conversation':'drawing'}});
    expect(hasLocalLearnerAuthority(options.learningTurn!.authority)).toBe(true);
    if(kind==='reference')expect(options.referencePath).toBe('Board Memory/references/fixed.png');
    if(kind==='transcript')expect(submit.mock.calls[0]![0]).toBe('用户校正后的转写');
  });
  it.each(['selection','reference','transcript'] as const)('does not dispatch the %s entry after a delayed capture outlives its layer generation',async kind=>{
    const original=view();let release!:(chat:ChatContext)=>void;
    const captureContext=vi.fn(()=>new Promise<ChatContext>(resolve=>{release=resolve;})),s=scenario([original],captureContext);
    const submit=vi.spyOn(s.conversation,'submit').mockResolvedValue(undefined);
    await s.manager.toggle(original);await settle();await explicitEntry(s,original,kind);await settle();
    expect(captureContext).toHaveBeenCalledOnce();
    // A model/settings change invalidates the layer without detaching its DOM.
    s.manager.settingsChanged();
    release({notePath:'Physics.md',observation:{source:'Physics.md',version:'old',scope:'document-excerpt',hasImage:false}});
    await settle();expect(submit).not.toHaveBeenCalled();
  });
  it.each(['detached','changed-file','same-path-replacement'] as const)('does not dispatch a selected-text request after %s while context is loading',async kind=>{
    const original=view();let release!:(chat:ChatContext)=>void;
    const s=scenario([original],()=>new Promise<ChatContext>(resolve=>{release=resolve;}));
    const submit=vi.spyOn(s.conversation,'submit').mockResolvedValue(undefined);
    await s.manager.toggle(original);await settle();await explicitEntry(s,original,'selection');await settle();
    if(kind==='detached')original.containerEl.remove();
    else if(kind==='changed-file')original.file!.path='Elsewhere.md';
    else original.file={...original.file!};
    release({notePath:'Physics.md',observation:{source:'Physics.md',version:'old',scope:'document-excerpt',hasImage:false}});
    await settle();expect(submit).not.toHaveBeenCalled();
  });
  it('does not take selected text from another split as this board drawing instruction',async()=>{
    const original=view(),other=view('Other.md'),s=scenario([original,other]);
    const submit=vi.spyOn(s.conversation,'submit').mockResolvedValue(undefined);
    await s.manager.toggle(original);await settle();
    const range=document.createRange();range.selectNodeContents(other.containerEl.querySelector('p')!);
    document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range);
    button(original,'drawSelection').click();await settle();
    expect(submit).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledWith(t('board.selectDrawingText'));
  });
  it('sends user-corrected recognition from the actual save-and-ask action with its fixed source context',async()=>{
    const original=view(),other=view('Other.md'),chat:ChatContext={notePath:'Physics.md',sourceBinding:'recognized-source',
      observation:{source:'Physics.md',version:contextVersion(sourceText),scope:'document-excerpt',hasImage:false}};
    const captureContext=vi.fn(async()=>chat),s=scenario([original,other],captureContext);
    const submit=vi.spyOn(s.conversation,'submit').mockResolvedValue(undefined);
    s.settings.boardCloudRecognitionConsent=true;
    Object.assign(s.app.vault,{getName:()=> 'Test Vault'});
    (s.manager as unknown as {host:{createRecognitionProvider:()=>unknown}}).host.createRecognitionProvider=()=>({
      id:'test-provider',availability:async()=>({available:true}),
      recognize:async()=>({text:'recognition draft',alternatives:[],language:'zh-CN',provider:'test-provider',confidence:0.8}),
    });
    vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/png;base64,cGl4ZWxz');
    await s.manager.toggle(original);await settle();await draw(original);
    const layer=boardLayer(s.manager,original);layer.selection.add(layer.bundle().document.objects[0]!.id);
    button(original,'recognize').click();await settle();
    const editor=document.querySelector<HTMLTextAreaElement>('.test-modal textarea')!;
    expect(editor).not.toBeNull();editor.value='用户确认的正确转写';s.active.view=other;
    [...document.querySelectorAll<HTMLButtonElement>('.test-modal button')].find(item=>item.textContent===t('board.saveAndAsk'))!.click();
    await settle();
    expect(captureContext).toHaveBeenCalledExactlyOnceWith(original);
    expect(submit).toHaveBeenCalledExactlyOnceWith('用户确认的正确转写',expect.objectContaining({source:'board',route:'chat',resolveIntent:false,
      context:{chat},learningTurn:expect.objectContaining({entry:'board',kind:'conversation'})}));
    expect(layer.bundle().document.semanticGroups?.at(-1)?.recognition).toMatchObject({text:'用户确认的正确转写',userCorrected:true});
  });
  it('sends its reading view context before semantic resolution even after another document becomes active',async()=>{
    const original=view(), other=view('Other.md'), s=scenario([original,other]);
    original.getViewData=()=>sourceText;
    other.getViewData=()=>'Unrelated document';
    await s.manager.toggle(original);await settle();
    s.active.view=other;
    send(original);await settle();
    expect(s.prepare).toHaveBeenCalledOnce();
    const options=s.prepare.mock.calls[0]![1];
    expect(options).toMatchObject({source:'board',boardId:expect.any(String),learningTurn:{entry:'board',kind:'conversation'},
      context:{chat:{notePath:'Physics.md',observation:{source:'Physics.md',version:contextVersion(sourceText),hasImage:false}}}});
    expect((options.context as {chat:ChatContext}).chat.content).not.toContain('Unrelated');
    expect(s.run).toHaveBeenCalledOnce();
  });
  it.each([true,false])('uses its own unsaved CM6 buffer rather than another split (live preview=%s)',async live=>{
    const original=view(),other=view(),s=scenario([original,other]);
    useSourceFile(s);
    const own=attachEditor(s.manager,original,'原分栏尚未保存的题目',live);
    const foreign=attachEditor(s.manager,other,'另一个分栏的题目',live);
    await s.manager.toggle(original);await measureEditor(own);await measureEditor(foreign);
    s.active.view=other;
    send(original);await settle();
    const context=(s.prepare.mock.calls[0]![1].context as {chat:ChatContext}).chat;
    expect(context.observation?.version).toBe(contextVersion(own.state.doc.toString()));
    expect(context.content).toContain('原分栏');
    expect(context.content).not.toContain('另一个分栏');
  });
  it('passes the host source capability unchanged and calls capture with the exact originating view',async()=>{
    const original=view(),other=view(),chat:ChatContext={notePath:'Physics.md',content:'own context',sourceBinding:'host-capability',
      observation:{source:'Physics.md',version:'own-version',scope:'visible-text',hasImage:false}};
    const captureContext=vi.fn(async()=>chat),s=scenario([original,other],captureContext);
    await s.manager.toggle(original);await settle();s.active.view=other;
    send(original);await settle();
    expect(captureContext).toHaveBeenCalledExactlyOnceWith(original);
    expect((s.prepare.mock.calls[0]![1].context as {chat:ChatContext}).chat).toBe(chat);
  });
  it('waits for CM6 composition and final layout before acquiring the host source capability',async()=>{
    const original=view();let own:EditorView;
    const captureContext=vi.fn(async()=>({notePath:'Physics.md',content:own.state.doc.toString(),
      observation:{source:'Physics.md',version:contextVersion(own.state.doc.toString()),scope:'document-excerpt' as const,hasImage:false}}));
    const s=scenario([original],captureContext);useSourceFile(s);
    own=attachEditor(s.manager,original);
    await s.manager.toggle(original);await measureEditor(own);
    own.dom.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    send(original);await vi.advanceTimersByTimeAsync(1000);
    expect(captureContext).not.toHaveBeenCalled();expect(s.prepare).not.toHaveBeenCalled();
    own.dispatch({changes:{from:0,insert:'最终输入。'},annotations:Transaction.userEvent.of('input.type.compose')});
    own.dom.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    await measureEditor(own);await settle();
    expect(captureContext).toHaveBeenCalledOnce();
    expect((s.prepare.mock.calls[0]![1].context as {chat:ChatContext}).chat.content).toContain('最终输入。');
  });
  it.each(['changed-file','detached','changed-input'] as const)('does not dispatch a delayed context after %s',async reason=>{
    const original=view();let release!:(context:ChatContext)=>void;
    const captureContext=vi.fn(()=>new Promise<ChatContext>(resolve=>{release=resolve;}));
    const s=scenario([original],captureContext);
    await s.manager.toggle(original);await settle();
    const input=send(original);button(original,'send').click();await settle();
    expect(captureContext).toHaveBeenCalledOnce();
    if(reason==='changed-file')original.file!.path='Other.md';
    if(reason==='detached')original.containerEl.remove();
    if(reason==='changed-input')input.value='新的请求';
    release({notePath:'Physics.md',observation:{source:'Physics.md',version:'1',scope:'visible-text',hasImage:false}});
    await settle();
    expect(s.prepare).not.toHaveBeenCalled();expect(s.run).not.toHaveBeenCalled();
    expect(input.value).toBe(reason==='changed-input'?'新的请求':'继续这道题');
  });
});

describe("shared Tutor conversation on the board", () => {
  function streamingScenario(targets = [view()], options?: {
    captureContext?: (view:TestView)=>Promise<ChatContext>;
    prepare?: (text:string,options:TutorSubmitOptions)=>Promise<TutorSubmitOptions>;
  }) {
    const turns: Array<{ request: BoardAgentRequest; emit: (event: BoardAgentEvent) => void; finish: (result: BoardAgentResult) => void }> = [];
    const agent: BoardAgent = {
      request: vi.fn((request, onEvent) => new Promise<BoardAgentResult>(finish => {
        turns.push({ request, emit: event => onEvent?.(event), finish });
      })), cancel: vi.fn(), dispose: vi.fn(),
    };
    const chatRun = vi.fn(async () => ({ text: "Plain chat" }));
    const conversation = new TutorConversation({ run: chatRun, prepare: options?.prepare });
    const scenario = setup(targets, agent, conversation,undefined,options?.captureContext);
    return { ...scenario, turns, conversation, chatRun };
  }
  function complete(turn: ReturnType<typeof streamingScenario>["turns"][number], text: string, objects: BoardObject[] = []) {
    turn.finish({ ok: true, requestId: turn.request.requestId, baseRevision: turn.request.baseRevision,
      description: text, operations: objects.map(object => ({ type: "add", object })) });
  }
  function shape(turn: ReturnType<typeof streamingScenario>["turns"][number]): BoardObject {
    return { id: "streamed-shape", kind: "ellipse", anchor: turn.request.anchor, x: 20, y: 40,
      width: 50, height: 30, color: "#7062b5", strokeWidth: 2,
      createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "stream-turn" };
  }
  async function writeRequest(target: TestView, text: string) {
    button(target, "text").click(); pointer(target, "pointerdown", 100, 150);
    const editor = target.containerEl.querySelector<HTMLTextAreaElement>(".atl-board-text-editor")!;
    editor.value = text;
    editor.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",ctrlKey:true,bubbles:true}));
    await settle();
  }
  it.each(['pen','board-text'] as const)('binds real co-drawing %s input to its own source without granting conversational learning control',async kind=>{
    const original=view(),other=view('Other.md');
    const chat:ChatContext={notePath:'Physics.md',sourceBinding:'own-source-capability',content:sourceText,
      observation:{source:'Physics.md',version:contextVersion(sourceText),scope:'document-excerpt',hasImage:false}};
    const captureContext=vi.fn(async()=>chat),prepare=vi.fn(async(_text:string,options:TutorSubmitOptions):Promise<TutorSubmitOptions>=>({...options,resolveIntent:false,route:'board'}));
    const s=streamingScenario([original,other],{captureContext,prepare}),submit=vi.spyOn(s.conversation,'submit');
    await s.manager.toggle(original);await settle();button(original,'together').click();
    if(kind==='pen')await draw(original);else await writeRequest(original,'请你画一个圆');
    s.active.view=other;await vi.advanceTimersByTimeAsync(4000);
    expect(submit).toHaveBeenCalledOnce();expect(captureContext).toHaveBeenCalledExactlyOnceWith(original);
    const [text,options]=submit.mock.calls[0]!;
    expect(text).toBe(kind==='pen'?'':'请你画一个圆');
    expect((options!.context as {chat:ChatContext}).chat).toBe(chat);
    expect(options).toMatchObject({source:'board',boardId:expect.any(String),learningTurn:{entry:'board',kind:'drawing'}});
    expect(hasLocalLearnerAuthority(options!.learningTurn!.authority)).toBe(true);
    expect(permitsLearningControl(options!.learningTurn!)).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(kind==='pen'?0:1);
    expect(s.turns).toHaveLength(1);expect(s.turns[0]!.request.sourceFile).toBe('Physics.md');
    complete(s.turns[0]!,'observed');await settle();
  });
  it.each(['pause','changed-file','detached','new-observer'] as const)('cancels co-drawing context preparation after %s without sending it',async reason=>{
    const original=view(),other=view();let release!:(chat:ChatContext)=>void;
    const captureContext=vi.fn(()=>new Promise<ChatContext>(resolve=>{release=resolve;}));
    const s=streamingScenario([original,other],{captureContext}),submit=vi.spyOn(s.conversation,'submit');
    await s.manager.toggle(original);await s.manager.toggle(other);await settle();
    button(original,'together').click();await draw(original);await vi.advanceTimersByTimeAsync(1500);
    expect(captureContext).toHaveBeenCalledOnce();
    if(reason==='pause')button(original,'pause').click();
    if(reason==='changed-file')original.file!.path='Changed.md';
    if(reason==='detached')original.containerEl.remove();
    if(reason==='new-observer')button(other,'together').click();
    release({notePath:'Physics.md',observation:{source:'Physics.md',version:'fixed',scope:'document-excerpt',hasImage:false}});
    await settle();expect(submit).not.toHaveBeenCalled();expect(s.turns).toHaveLength(0);
  });
  it("commits native conversation drawing through durable metadata and a single undo",async()=>{
    const s=streamingScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("draw a circle",{route:"board"});await settle();
    complete(s.turns[0]!,"drawn",[shape(s.turns[0]!)]);await pending;
    expect(s.conversation.state).toMatchObject({taskStatus:"complete",commit:{durability:"committed",createdIds:["streamed-shape"],updatedIds:[],deletedIds:[]}});
    const records=await s.transactions.journal.recordsForClient("obsidian");expect(records).toHaveLength(1);expect(records[0]?.phase).toBe("committed");
    expect(records[0]?.receipt.requestId).toBe(s.conversation.state.taskId);
    button(target,"undo").click();await settle();expect(stored(s.adapter)!.objects).toHaveLength(0);
    expect((boardLayer(s.manager,target) as any).history.canUndo).toBe(false);
  });
  it("keeps a native drawing after disk failure and only retries its save",async()=>{
    const s=streamingScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("draw a circle",{route:"board"});await settle();s.adapter.failWrites=true;
    complete(s.turns[0]!,"drawn",[shape(s.turns[0]!)]);await pending;
    expect(s.conversation.state).toMatchObject({taskStatus:"reconciliation",canRetry:false,commit:{durability:"applied-not-durable",createdIds:["streamed-shape"]}});
    const receipt=s.conversation.state.commit!,surface=(boardLayer(s.manager,target) as any).toolSurface();s.adapter.failWrites=false;
    await s.conversation.retry();expect(s.agent.request).toHaveBeenCalledOnce();
    const recovered=await surface.recoverCommit(receipt.transactionId,{clientId:"obsidian",targets:[receipt.targetId],read:true,write:true,humanObjectIds:[],learningMemory:false},new AbortController().signal,"retry-save");
    s.conversation.applyRecoveredCommit(recovered.receipt);expect(s.conversation.state.taskStatus).toBe("complete");
    expect(stored(s.adapter)!.objects.map(object=>object.id)).toEqual(["streamed-shape"]);
    button(target,"undo").click();await settle();expect(stored(s.adapter)!.objects).toHaveLength(0);
    expect((boardLayer(s.manager,target) as any).history.canUndo).toBe(false);
  });
  it("reports native save completion after cancellation without drawing twice",async()=>{
    const s=streamingScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("draw a circle",{route:"board"});await settle();
    let entered!:()=>void,release!:()=>void;const saving=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const write=s.adapter.write.bind(s.adapter);vi.spyOn(s.adapter,"write").mockImplementation(async(path,contents)=>{if(path.endsWith(".board.json")){entered();await gate;}await write(path,contents);});
    complete(s.turns[0]!,"drawn",[shape(s.turns[0]!)]);await saving;s.conversation.cancel();release();await pending;
    expect(s.conversation.state).toMatchObject({taskStatus:"complete",canRetry:false,commit:{durability:"committed",createdIds:["streamed-shape"]}});
    expect(s.conversation.tasks.get(s.conversation.state.taskId!,"obsidian").phase).toBe("committed-after-cancel");
    expect(stored(s.adapter)!.objects.map(object=>object.id)).toEqual(["streamed-shape"]);expect(s.agent.request).toHaveBeenCalledOnce();
  });
  it("waits for a concurrent human snapshot to finish saving without claiming its object",async()=>{
    const s=streamingScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const pending=s.conversation.submit("draw a circle",{route:"board"});await settle();
    let firstEntered!:()=>void,secondEntered!:()=>void,releaseFirst!:()=>void,releaseSecond!:()=>void;
    const firstSaving=new Promise<void>(resolve=>firstEntered=resolve),secondSaving=new Promise<void>(resolve=>secondEntered=resolve);
    const firstGate=new Promise<void>(resolve=>releaseFirst=resolve),secondGate=new Promise<void>(resolve=>releaseSecond=resolve);
    let writes=0;const write=s.adapter.write.bind(s.adapter);vi.spyOn(s.adapter,"write").mockImplementation(async(path,contents)=>{
      if(path.endsWith(".board.json")){writes++;if(writes===1){firstEntered();await firstGate;}else if(writes===2){secondEntered();await secondGate;}}
      await write(path,contents);
    });
    complete(s.turns[0]!,"drawn",[shape(s.turns[0]!)]);await firstSaving;
    const layer=boardLayer(s.manager,target) as any;
    layer.history.transact((document:BoardDocument)=>document.objects.push({...shape(s.turns[0]!),id:"human-during-save",createdBy:"human",editedBy:"human"}));layer.changed("human");
    releaseFirst();await secondSaving;
    expect(s.conversation.state.commit?.durability).toBe("applied-not-durable");
    releaseSecond();await pending;
    expect(s.conversation.state.commit).toMatchObject({durability:"committed",createdIds:["streamed-shape"]});
    expect(stored(s.adapter)!.objects.map(object=>object.id)).toEqual(["streamed-shape","human-during-save"]);
  });
  it("waits for a newly opened view to measure instead of reporting empty model output",async()=>{
    const s=streamingScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target) as any;
    const surface=vi.spyOn(layer,'currentVisibleSurface').mockReturnValueOnce(undefined);
    const pending=s.conversation.submit('draw a circle',{route:'board'});await settle();
    await vi.advanceTimersByTimeAsync(40);await settle();expect(s.turns).toHaveLength(1);
    complete(s.turns[0]!,'drawn',[shape(s.turns[0]!)]);await pending;
    expect(s.conversation.state.taskStatus).toBe('complete');surface.mockRestore();
  });
  it("reports unavailable layout without blaming the model when the page never measures",async()=>{
    const s=streamingScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();
    const surface=vi.spyOn(boardLayer(s.manager,target) as any,'currentVisibleSurface').mockReturnValue(undefined);
    const pending=s.conversation.submit('draw a circle',{route:'board'});await settle();
    await vi.advanceTimersByTimeAsync(1100);await pending;
    expect(s.turns).toHaveLength(0);expect(s.conversation.state.error).toBe(t('board.unavailable'));surface.mockRestore();
  });
  it("releases the model session, clears previews and rejects late drawings after connection changes",async()=>{
    const s=streamingScenario(),target=s.views[0]!;await s.manager.toggle(target);await settle();await draw(target);
    const before=structuredClone(stored(s.adapter)!.objects);
    const pending=s.conversation.submit('draw a circle',{route:'board'});await settle();
    const turn=s.turns[0]!;turn.emit({type:'preview',operations:[{type:'add',object:shape(turn)}]});
    s.settings.boardConnectionMode='custom';s.settings.boardAgentModel='other';s.manager.settingsChanged();
    expect(s.agent.dispose).toHaveBeenCalledOnce();complete(turn,'late',[shape(turn)]);await pending;await settle();
    expect(s.conversation.state.taskStatus).toBe('cancelled');expect(stored(s.adapter)!.objects).toEqual(before);
    expect((boardLayer(s.manager,target) as any).tutorPreview).toHaveLength(0);
  });
  it.each([true, false])("submits learner board text as an instruction with co-drawing enabled before writing: %s", async enabledFirst => {
    const scenario=streamingScenario(), target=scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    if(enabledFirst) button(target,"together").click();
    await writeRequest(target,"请你画一个圆");
    if(!enabledFirst) button(target,"together").click();
    await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.turns).toHaveLength(1);
    expect(scenario.turns[0]!.request.instruction).toBe("请你画一个圆");
    expect(scenario.conversation.state.history.some(m=>m.role==="user" && m.text==="请你画一个圆")).toBe(true);
    complete(scenario.turns[0]!,"画好了",[shape(scenario.turns[0]!)]); await settle();
    await draw(target); await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.turns[1]!.request.instruction).toBe("");
    complete(scenario.turns[1]!,"观察笔迹"); await settle();
  });
  it("routes the screenshot's anime request into reference generation instead of an empty observation", async () => {
    const scenario=streamingScenario(), target=scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    await writeRequest(target,"请你绘制一个二次元的米老鼠");
    await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.conversation.state.history).toHaveLength(0);
    button(target,"together").click(); await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.conversation.state.history[0]?.text).toBe("请你绘制一个二次元的米老鼠");
    expect(scenario.conversation.state.error).toBe(t("board.imageProviderRequired"));
    expect(scenario.agent.request).not.toHaveBeenCalled();
  });
  it("prioritizes a newly edited older request over a newer consumed text object",async()=>{
    const scenario=streamingScenario(),target=scenario.views[0]!;await scenario.manager.toggle(target);await settle();
    await writeRequest(target,"请你画一个圆");
    const first=boardLayer(scenario.manager,target).bundle().document.objects[0]!;
    await writeRequest(target,"请你画一个方框");
    button(target,"together").click();await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.turns[0]!.request.instruction).toBe("请你画一个方框");
    complete(scenario.turns[0]!,"done",[shape(scenario.turns[0]!)]);await settle();
    const layer=boardLayer(scenario.manager,target) as LayerProbe & {beginText(object:BoardObject,existing:boolean):void};
    layer.beginText(first,true);
    const editor=target.containerEl.querySelector<HTMLTextAreaElement>(".atl-board-text-editor")!;
    editor.value="请你画两个圆";
    editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true}));
    await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.turns[1]!.request.instruction).toBe("请你画两个圆");
    complete(scenario.turns[1]!,"done",[{...shape(scenario.turns[1]!),id:"second-shape"}]);await settle();
  });
  it("does not execute Tutor-authored board text when co-drawing is enabled", async () => {
    const scenario=streamingScenario(), target=scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    await writeRequest(target,"请你画一个圆");
    const layer=boardLayer(scenario.manager,target) as LayerProbe & {receive(bundle:BoardBundle):void};
    const bundle=layer.bundle();
    bundle.document.objects[0]!.createdBy="tutor";
    bundle.document.objects[0]!.editedBy="tutor";
    layer.receive(bundle);
    button(target,"together").click(); await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.turns).toHaveLength(0);
  });
  it("has a vertical toolbar with no conversation controls and a keyboard-only transient composer", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    const toolbar = target.containerEl.querySelector('.atl-board-toolbar')!;
    expect(toolbar.getAttribute('aria-orientation')).toBe('vertical');
    expect(toolbar.querySelector('input[type=text]')).toBeNull();
    expect(toolbar.textContent).not.toContain(t('board.question'));
    const composer = target.containerEl.querySelector<HTMLElement>('.atl-board-quick-input')!;
    expect(composer.hidden).toBe(true);
    canvas(target).dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, altKey: true, bubbles: true }));
    expect(composer.hidden).toBe(false);
    const input = composer.querySelector('input')!;
    input.value = '画一个圆';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    await settle();
    expect(scenario.turns).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(scenario.turns).toHaveLength(1);
    expect(composer.hidden).toBe(true);
    expect(button(target, 'together').getAttribute('aria-pressed')).not.toBe('true');
    complete(scenario.turns[0]!, '来了'); await settle();
    await draw(target);
    await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.turns).toHaveLength(1); // A single instruction never turns observation on.
  });
  it("keeps canvas CSS pixels aligned with root coordinates when the toolbar adds padding", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    const root = target.containerEl.querySelector<HTMLElement>(".view-content")!;
    root.style.paddingInlineStart = "64px";
    await scenario.manager.toggle(target); await settle();
    expect(canvas(target).style.width).toBe("800px");
    expect(canvas(target).style.height).toBe("600px");
    expect(canvas(target).width).toBe(Math.round(800 * window.devicePixelRatio));
    expect(canvas(target).height).toBe(Math.round(600 * window.devicePixelRatio));
  });
  it.each(["metaKey", "ctrlKey"] as const)("opens quick input before CM swallows the %s shortcut and leaves native input keys alone", async modifier => {
    const target = view(), scenario = streamingScenario([target]);
    useSourceFile(scenario);
    const editor = attachEditor(scenario.manager, target);
    await scenario.manager.toggle(target); await measureEditor(editor);
    const stopChild = vi.fn((event: Event) => event.stopPropagation());
    editor.contentDOM.addEventListener("keydown", stopChild);
    const composer = target.containerEl.querySelector<HTMLElement>(".atl-board-quick-input")!;
    const annotationShortcut = new KeyboardEvent("keydown", {
      key: "L", code: "KeyL", [modifier]: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    editor.contentDOM.dispatchEvent(annotationShortcut);
    expect(composer.hidden).toBe(true);
    expect(annotationShortcut.defaultPrevented).toBe(false);
    expect(stopChild).toHaveBeenCalledOnce();
    const altGraph = new KeyboardEvent("keydown", {
      key: "ł", code: "KeyL", ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    });
    Object.defineProperty(altGraph, "getModifierState", { value: (key: string) => key === "AltGraph" });
    editor.contentDOM.dispatchEvent(altGraph);
    expect(composer.hidden).toBe(true);
    expect(altGraph.defaultPrevented).toBe(false);
    expect(stopChild).toHaveBeenCalledTimes(2);
    const composing = new KeyboardEvent("keydown", {
      key: "L", [modifier]: true, altKey: true, isComposing: true, bubbles: true, cancelable: true,
    });
    editor.contentDOM.dispatchEvent(composing);
    expect(composer.hidden).toBe(true);
    expect(composing.defaultPrevented).toBe(false);
    expect(stopChild).toHaveBeenCalledTimes(3);
    const shortcut = new KeyboardEvent("keydown", {
      // macOS Option can change event.key; the physical code stays KeyL.
      key: modifier === "metaKey" ? "¬" : "L", code: "KeyL", [modifier]: true, altKey: true, bubbles: true, cancelable: true,
    });
    editor.contentDOM.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(composer.hidden).toBe(false);
    expect(stopChild).toHaveBeenCalledTimes(3);
    const input = composer.querySelector<HTMLInputElement>("input")!;
    input.value = "正在输入";
    for (const key of ["z", "Backspace", "l"]) {
      const native = new KeyboardEvent("keydown", { key, [modifier]: key === "z", bubbles: true, cancelable: true });
      input.dispatchEvent(native);
      expect(native.defaultPrevented).toBe(false);
    }
    expect(input.value).toBe("正在输入");
    expect(scenario.turns).toHaveLength(0);
  });
  it.each([false, true])("waits for final font geometry before sampling while real edits still cancel=%s", async (editAgain) => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    let ready = false, release!: () => void;
    const fontsReady = new Promise<void>(resolve => { release = resolve; });
    const value = "字体就绪之后再解释这个问题";
    vi.mocked(boardFonts.ensureBoardFonts).mockImplementation(async (_doc, text) => {
      if (text?.includes(value)) await fontsReady;
    });
    vi.spyOn(boardFonts, "boardTextMeasurer").mockReturnValue(text => [...text].length * (ready ? 40 : 5));
    try {
      button(target, "text").click();
      pointer(target, "pointerdown", 100, 150);
      const editor = target.containerEl.querySelector<HTMLTextAreaElement>(".atl-board-text-editor")!;
      editor.value = value;
      editor.dispatchEvent(new Event("input"));
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      const preliminary = boardLayer(scenario.manager, target).bundle().document.objects[0]!;
      const pending = scenario.conversation.submit("解释刚写的问题", { route: "board" });
      await settle();
      expect(capture).not.toHaveBeenCalled();
      expect(scenario.conversation.state.busy).toBe(true);
      if (editAgain) await draw(target);
      ready = true; release(); await settle();
      if (editAgain) {
        await pending;
        expect(scenario.conversation.state.busy).toBe(false);
        expect(scenario.turns).toHaveLength(0);
        expect(capture).not.toHaveBeenCalled();
      } else {
        expect(scenario.turns).toHaveLength(1);
        const turn = scenario.turns[0]!;
        const finalText = boardLayer(scenario.manager, target).bundle().document.objects[0]!;
        expect(finalText.height).toBeGreaterThan(preliminary.height);
        expect(turn.request.baseRevision).toBe(boardLayer(scenario.manager, target).bundle().document.revision);
        expect(turn.request.objects.find(object => object.id === preliminary.id)?.height).toBe(finalText.height);
        complete(turn, "现在看到了"); await pending; await settle();
        button(target, "undo").click(); await settle();
        expect(boardLayer(scenario.manager, target).bundle().document.objects).toEqual([]);
      }
    } finally { release(); }
  });
  it("keeps a manual CM turn through measurements and captures the fresh surface after fonts settle", async () => {
    const target = view(), scenario = streamingScenario([target]);
    useSourceFile(scenario);
    const editor = attachEditor(scenario.manager, target);
    await scenario.manager.toggle(target); await measureEditor(editor);
    const layer = boardLayer(scenario.manager, target), original = layer.editorState()!.surfaces[0]!;
    let release!: () => void;
    const fontsReady = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(boardFonts.ensureBoardFonts).mockImplementationOnce(() => fontsReady);
    const pending = scenario.conversation.submit("请根据这里继续画", { route: "board" });
    await settle();
    expect(capture).not.toHaveBeenCalled();
    vi.spyOn(editor, "documentTop", "get").mockReturnValue(160);
    vi.mocked(editor.contentDOM.getBoundingClientRect).mockReturnValue(new DOMRect(80, 160, 620, 600));
    editor.dispatch({ selection: { anchor: 1 } });
    await measureEditor(editor);
    const measured = layer.editorState()!.surfaces[0]!;
    expect(measured).not.toBe(original);
    expect(scenario.conversation.state.busy).toBe(true);
    release(); await settle();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![0]).toBe(measured);
    expect(capture.mock.calls[0]![0].toClient().slice(4)).toEqual([80, 160]);
    expect(scenario.turns).toHaveLength(1);
    const turn = scenario.turns[0]!;
    expect(turn.request.bufferRevision).toBe(layer.editorState()!.bufferRevision);
    const cancels = vi.mocked(scenario.agent.cancel).mock.calls.length;
    editor.dispatch({ selection: { anchor: 2 } });
    await measureEditor(editor);
    expect(scenario.agent.cancel).toHaveBeenCalledTimes(cancels);
    turn.emit({ type: "reply", text: "继续观察这一段" });
    complete(turn, "继续观察这一段"); await pending; await settle();
    expect(scenario.conversation.state.latestReply).toBe("继续观察这一段");
  });
  it("loads received handwriting in the owning window without saving or observing it", async () => {
    const target = view(), frame = document.createElement("iframe");
    document.body.append(frame);
    const popout = frame.contentWindow as Window & typeof globalThis;
    vi.spyOn(popout, "requestAnimationFrame").mockImplementation(callback => window.setTimeout(() => callback(0), 16));
    vi.spyOn(popout, "cancelAnimationFrame").mockImplementation(handle => window.clearTimeout(handle));
    vi.spyOn(popout.HTMLCanvasElement.prototype, "getContext").mockReturnValue(document.createElement("canvas").getContext("2d"));
    popout.document.body.append(target.containerEl);
    const scenario = streamingScenario([target]);
    await scenario.manager.toggle(target); await settle();
    button(target, "together").click();
    const layer = boardLayer(scenario.manager, target) as LayerProbe & { receive(bundle: BoardBundle): void };
    const bundle = layer.bundle();
    const surface = discoverBoardSurfaces(target, target.file!.path)[0]!;
    bundle.document.objects.push({ id: "received-text", kind: "text", anchor: surface.anchor,
      x: 20, y: 30, width: 200, height: 30, text: "来自另一个窗口的字",
      textStyle: { font: "handwritten", size: 20, align: "left" }, color: "#222222", strokeWidth: 2,
      createdBy: "human", editedBy: "human", revision: 1, groupId: "shared-text" });
    bundle.document.revision++;
    const saved = [...scenario.adapter.files.entries()];
    vi.mocked(boardFonts.ensureBoardFonts).mockClear();
    layer.receive(bundle); await vi.advanceTimersByTimeAsync(4000);
    expect(boardFonts.ensureBoardFonts).toHaveBeenCalledWith(popout.document, "来自另一个窗口的字");
    expect([...scenario.adapter.files.entries()]).toEqual(saved);
    expect(scenario.turns).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });
  it("retains automatic pen observations until the shared plain-chat turn finishes", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    button(target, "together").click();
    let finishChat!: (result: { text: string }) => void;
    scenario.chatRun.mockImplementationOnce(() => new Promise(resolve => { finishChat = resolve; }));
    const chatting = scenario.conversation.submit("先回答这个问题", { route: "chat" });
    await settle(); await draw(target); await vi.advanceTimersByTimeAsync(4000);
    expect(scenario.conversation.state.busy).toBe(true);
    expect(scenario.turns).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
    finishChat({ text: "先回答完毕" }); await chatting; await settle();
    expect(scenario.turns).toHaveLength(1);
    expect(scenario.turns[0]!.request.objects.some(object => object.kind === "ink")).toBe(true);
    complete(scenario.turns[0]!, "再看你的新笔迹"); await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(scenario.turns).toHaveLength(1);
  });
  it("streams reply and previews before completion, then commits once and replaces only the next caption", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle(); await draw(target);
    const before = stored(scenario.adapter)!.objects[0]!;
    const first = scenario.conversation.submit('请画一个圆', { route: 'board' });
    await settle();
    const turn = scenario.turns[0]!, object = shape(turn);
    turn.emit({ type: 'reply', text: '先观察' });
    turn.emit({ type: 'preview', operations: [{ type: 'add', object }] });
    await settle();
    expect(target.containerEl.querySelector('.atl-board-reply-text')!.textContent).toBe('先观察');
    expect(stored(scenario.adapter)!.objects).toHaveLength(1);
    expect((boardLayer(scenario.manager, target) as unknown as { tutorPreview: unknown[] }).tutorPreview).toHaveLength(1);
    turn.emit({ type: 'reply', text: '这个圆。' });
    complete(turn, '先观察这个圆。', [object]); await first; await settle();
    expect(stored(scenario.adapter)!.objects).toHaveLength(2);
    const second = scenario.conversation.submit('然后呢', { route: 'board' }); await settle();
    scenario.turns[1]!.emit({ type: 'reply', text: '看它的半径。' }); await settle();
    expect(target.containerEl.querySelector('.atl-board-reply-text')!.textContent).toBe('看它的半径。');
    expect(stored(scenario.adapter)!.objects[0]!.id).toBe(before.id);
    expect(stored(scenario.adapter)!.objects[1]!.id).toBe(object.id);
    complete(scenario.turns[1]!, '看它的半径。'); await second; await settle();
    button(target, 'undo').click(); await settle();
    expect(stored(scenario.adapter)!.objects.map(item => item.id)).toEqual([before.id]);
    expect(scenario.conversation.state.history.filter(message => message.role === 'assistant').map(message => message.text))
      .toEqual(['先观察这个圆。', '看它的半径。']);
  });
  it("uses a visible fallback after committing drawing operations with an empty model description", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    const pending = scenario.conversation.submit("画一个圆", { route: "board" });
    await settle();
    const turn = scenario.turns[0]!, object = shape(turn);
    complete(turn, "", [object]);
    await pending; await settle();
    expect(stored(scenario.adapter)!.objects.map(item => item.id)).toContain(object.id);
    expect(scenario.conversation.state.latestReply).toBe(t("chat.boardUpdated"));
    expect(scenario.conversation.state.history.at(-1)?.text).toBe(t("chat.boardUpdated"));
  });
  it("reports an explicit board no-op instead of completing with an empty reply", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    const pending = scenario.conversation.submit("画一个笑脸", { route: "board" });
    await settle();
    complete(scenario.turns[0]!, "");
    await pending; await settle();
    expect(scenario.conversation.state.error).toBe(t("board.noDrawing"));
    expect(scenario.conversation.state.history.at(-1)?.role).toBe("user");
  });
  it("clears incomplete drawing previews and shows a localized retry message without saving", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle(); await draw(target);
    const before = structuredClone(stored(scenario.adapter)!.objects);
    const pending = scenario.conversation.submit("画一个圆", { route: "board" });
    await settle();
    const turn = scenario.turns[0]!;
    turn.emit({type:"reply",text:"正在绘制…"});
    turn.emit({ type: "preview", operations: [{ type: "add", object: shape(turn) }] });
    turn.finish({ ok: false, code: "incomplete-response", error: "incomplete-stream-response" });
    await pending; await settle();
    expect(scenario.conversation.state.error).toBe(t("board.incompleteReply"));
    expect(target.containerEl.querySelector('.atl-board-reply-text')!.textContent).toBe(t("board.incompleteReply"));
    expect(stored(scenario.adapter)!.objects).toEqual(before);
    expect((boardLayer(scenario.manager, target) as unknown as { tutorPreview: unknown[] }).tutorPreview).toHaveLength(0);
    button(target,"retryTask").click();await settle();
    expect(scenario.turns).toHaveLength(2);
    complete(scenario.turns[1]!,"重试完成",[shape(scenario.turns[1]!)]);await settle();
    expect(scenario.conversation.state.taskStatus).toBe("complete");
  });
  it.each([
    ["empty-drawing-response", "board.emptyDrawingReply", false],
    ["incomplete-drawing-json", "board.unfinishedDrawingReply", true],
    ["unfinished-drawing-path", "board.unfinishedDrawingReply", true],
    ["incomplete-api-response", "board.drawingConnectionEnded", false],
    ["incomplete-response: length", "board.drawingOutputLimit", false],
  ] as const)("preserves student ink and reports the specific failure: %s", async (error, messageKey, repair) => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle(); await draw(target);
    const before = structuredClone(stored(scenario.adapter)!.objects);
    const pending = scenario.conversation.submit("请画一个极限示意图", { route: "board" });
    await settle();
    const first = scenario.turns[0]!;
    first.emit({type:"preview",operations:[{type:"add",object:shape(first)}]});
    first.finish({ok:false,code:"incomplete-response",error});
    await settle();
    if (repair) {
      expect(scenario.turns).toHaveLength(2);
      expect((boardLayer(scenario.manager,target) as unknown as {tutorPreview:unknown[]}).tutorPreview).toHaveLength(0);
      scenario.turns[1]!.finish({ok:false,code:"incomplete-response",error});
    }
    await pending; await settle();
    expect(scenario.turns).toHaveLength(repair ? 2 : 1);
    expect(scenario.conversation.state.error).toBe(t(messageKey));
    expect(scenario.conversation.state.taskStatus).toBe("failed");
    expect(stored(scenario.adapter)!.objects).toEqual(before);
    expect((boardLayer(scenario.manager,target) as unknown as {tutorPreview:unknown[]}).tutorPreview).toHaveLength(0);
  });
  it("moves a running reply from sidebar to canvas without another request or cancellation", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle();
    scenario.conversation.setSidebarVisible('sidebar', true, document);
    const pending = scenario.conversation.submit('解释一下', { route: 'board' }); await settle();
    const turn = scenario.turns[0]!;
    turn.emit({ type: 'reply', text: '第一段' }); await settle();
    expect(target.containerEl.querySelector<HTMLElement>('.atl-board-reply')!.hidden).toBe(true);
    const cancels = vi.mocked(scenario.agent.cancel).mock.calls.length;
    scenario.conversation.setSidebarVisible('sidebar', false, document);
    window.dispatchEvent(new Event('resize'));
    await settle();
    turn.emit({ type: 'reply', text: '，继续。' }); await settle();
    expect(target.containerEl.querySelector<HTMLElement>('.atl-board-reply')!.hidden).toBe(false);
    expect(target.containerEl.querySelector('.atl-board-reply-text')!.textContent).toBe('第一段，继续。');
    expect(scenario.agent.cancel).toHaveBeenCalledTimes(cancels);
    complete(turn, '第一段，继续。'); await pending;
    expect(scenario.turns).toHaveLength(1);
  });
  it("stops preview immediately and never revives it after a late completed response", async () => {
    const scenario = streamingScenario(), target = scenario.views[0]!;
    await scenario.manager.toggle(target); await settle(); await draw(target);
    const pending = scenario.conversation.submit('画个表情', { route: 'board' }); await settle();
    const turn = scenario.turns[0]!, object = shape(turn);
    turn.emit({ type: 'reply', text: '画到一半' });
    turn.emit({ type: 'preview', operations: [{ type: 'add', object }] }); await settle();
    button(target, 'stopReply').click(); await settle();
    expect(scenario.conversation.state.busy).toBe(false);
    expect((boardLayer(scenario.manager, target) as unknown as { tutorPreview: unknown[] }).tutorPreview).toHaveLength(0);
    turn.emit({ type: 'reply', text: '过期文字' }); complete(turn, '过期文字', [object]); await pending; await settle();
    expect(stored(scenario.adapter)!.objects).toHaveLength(1);
    expect(target.containerEl.querySelector('.atl-board-reply-text')!.textContent).not.toContain('过期');
  });
  it("pins the completed caption as editable text and keeps other documents isolated", async () => {
    const first = view(), second = view('Other.md');
    const scenario = streamingScenario([first, second]);
    await scenario.manager.toggle(first); await scenario.manager.toggle(second); await settle();
    scenario.active.view = first; scenario.manager.activeViewChanged();
    const pending = scenario.conversation.submit('问个问题', { route: 'board' }); await settle();
    scenario.turns[0]!.emit({ type: 'reply', text: '能量去了哪里？' });
    complete(scenario.turns[0]!, '能量去了哪里？'); await pending; await settle();
    expect(second.containerEl.querySelector<HTMLElement>('.atl-board-reply')!.hidden).toBe(true);
    button(first, 'pinReply').click(); await settle();
    expect(stored(scenario.adapter)!.objects).toEqual([expect.objectContaining({ kind: 'text', text: '能量去了哪里？' })]);
    button(first, 'undo').click(); await settle();
    expect(stored(scenario.adapter)!.objects).toHaveLength(0);
    scenario.active.view = view('No board.md'); scenario.manager.activeViewChanged();
    expect(scenario.conversation.hasBoard()).toBe(false);
  });
});

class RenameDraftIO implements BoardDraftIO {
  files = new Map<string, string>();
  beforeWrite?: (path: string, raw: string) => void;
  async read(path: string) { return this.files.get(path) ?? null; }
  async compareWrite(path: string, expected: string | null, raw: string) {
    this.beforeWrite?.(path, raw);
    if (await this.read(path) !== expected) throw new Error("state-file-conflict");
    this.files.set(path, raw);
  }
}
function renamedView(target: TestView, path: string) {
  target.file!.path = path; // Obsidian retains the TFile object on rename.
  const section = target.containerEl.querySelector<HTMLElement>(".markdown-preview-section > div");
  if (section) registerMarkdownBoardSection(section, path, { lineStart: 0, lineEnd: 0, text: sourceText });
}
describe("source relocation through the actual document controller", () => {
  it("retains a held pen, both undo steps and raw IDs despite a failed primary save", async () => {
    const io = new RenameDraftIO(), drafts = new BoardDraftStore(io), target = view();
    const s = setup([target], undefined, undefined, undefined, undefined, drafts);
    await s.manager.toggle(target); await draw(target);
    const layer = boardLayer(s.manager, target), oldSurface = s.manager.toolSurfaces()[0]!;
    const initial = layer.bundle(), history = layer.history;
    s.adapter.failWrites = true;
    pointer(target, "pointerdown", 200, 150); pointer(target, "pointermove", 240, 180);
    renamedView(target, "Renamed.md"); await s.manager.changed("Renamed.md", "rename", "Physics.md");
    const next = boardLayer(s.manager, target);
    expect(next).toBe(layer); expect(next.history).toBe(history);
    expect(next.bundle().document).toMatchObject({ id: initial.document.id, sourceFile: "Renamed.md" });
    expect(next.bundle().document.objects).toHaveLength(2); expect(Object.keys(next.bundle().ink)).toHaveLength(2);
    await expect(oldSurface.read()).rejects.toThrow("surface-closed");
    expect(target.containerEl.querySelector<HTMLElement>(".view-content")!.inert).toBeFalsy();
    const restored = await new BoardRepository(s.adapter, s.settings.memoryRoot, new BoardDraftStore(io)).open("Renamed.md", "markdown");
    expect(restored.document.objects).toEqual(next.bundle().document.objects); expect(restored.ink).toEqual(next.bundle().ink);
    s.adapter.failWrites = false;
    button(target, "undo").click(); await settle(); expect(next.bundle().document.objects).toHaveLength(1);
    expect(next.bundle().document.sourceFile).toBe("Renamed.md");
    button(target, "undo").click(); await settle(); expect(next.bundle().document.objects).toHaveLength(0);
    button(target, "redo").click(); await settle(); expect(next.bundle().document.objects[0]!.inkId).toBe(initial.document.objects[0]!.inkId);
    expect(stored(s.adapter, "Physics.md")).toBeUndefined();
  });
  it("queues consecutive file events and blocks a layout from creating a competing destination", async () => {
    const io = new RenameDraftIO(), target = view(), s = setup([target], undefined, undefined, undefined, undefined, new BoardDraftStore(io));
    await s.manager.toggle(target); await draw(target);
    const layer = boardLayer(s.manager, target), boardId = layer.bundle().document.id;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), saving = new Promise<void>(resolve => { entered = resolve; });
    const write = s.adapter.write.bind(s.adapter); let blocked = false;
    vi.spyOn(s.adapter, "write").mockImplementation(async (path, raw) => {
      if (!blocked && path.endsWith(".board.json")) { blocked = true; entered(); await gate; }
      return write(path, raw);
    });
    renamedView(target, "B.md"); const first = s.manager.changed("B.md", "rename", "Physics.md");
    await saving; renamedView(target, "C.md");
    const second = s.manager.changed("C.md", "rename", "B.md"), layout = s.manager.sync();
    expect(boardLayer(s.manager, target)).toBe(layer); expect(stored(s.adapter, "C.md")).toBeUndefined();
    release(); await Promise.all([first, second, layout]);
    expect(boardLayer(s.manager, target)).toBe(layer);
    expect(layer.bundle().document).toMatchObject({ id: boardId, sourceFile: "C.md" });
    expect(stored(s.adapter, "C.md")!.objects).toHaveLength(1);
    expect(target.containerEl.querySelectorAll(".atl-board-layer")).toHaveLength(1);
  });
  it("does not discard the original loaded scene when recovery relocation fails", async () => {
    const io = new RenameDraftIO(), drafts = new BoardDraftStore(io), target = view();
    const s = setup([target], undefined, undefined, undefined, undefined, drafts);
    await s.manager.toggle(target); await draw(target); const layer = boardLayer(s.manager, target), before = layer.bundle();
    s.adapter.failWrites = true; const destination = await drafts.path(s.settings.memoryRoot, "NoSpace.md", "markdown");
    io.beforeWrite = path => { if (path === destination) throw new Error("recovery destination unavailable"); };
    renamedView(target, "NoSpace.md"); await expect(s.manager.changed("NoSpace.md", "rename", "Physics.md")).rejects.toThrow();
    expect(boardLayer(s.manager, target)).toBe(layer); expect(layer.bundle().document.objects).toEqual(before.document.objects);
    expect(layer.bundle().document.sourceFile).toBe("Physics.md");
    expect(target.containerEl.querySelector<HTMLElement>(".view-content")!.inert).toBeFalsy();
    io.beforeWrite = undefined; s.adapter.failWrites = false;
    await s.manager.changed("NoSpace.md", "rename", "Physics.md");
    expect(boardLayer(s.manager, target)).toBe(layer); expect(layer.bundle().document.sourceFile).toBe("NoSpace.md");
  });
  it("moves a hidden document's association without opening its toolbar", async () => {
    const target = view(), s = setup([target]); await s.manager.toggle(target); await draw(target); await s.manager.toggle(target);
    renamedView(target, "Hidden.md"); await s.manager.changed("Hidden.md", "rename", "Physics.md");
    expect(target.containerEl.querySelector(".atl-board-layer")).toBeNull();
    await s.manager.toggle(target); expect(boardLayer(s.manager, target).bundle().document.objects).toHaveLength(1);
  });
});
it("retains a failed rename through later layouts and repairs it before the next file event", async () => {
  const io = new RenameDraftIO(), drafts = new BoardDraftStore(io), target = view();
  const s = setup([target], undefined, undefined, undefined, undefined, drafts);
  await s.manager.toggle(target); await draw(target); const original = boardLayer(s.manager, target), id = original.bundle().document.id;
  const blocked = await drafts.path(s.settings.memoryRoot, "Blocked.md", "markdown");
  io.beforeWrite = path => { if (path === blocked) throw new Error("recovery-disk-full"); };
  renamedView(target, "Blocked.md"); await expect(s.manager.changed("Blocked.md", "rename", "Physics.md")).rejects.toThrow("recovery-disk-full");
  await s.manager.sync(); expect(boardLayer(s.manager, target)).toBe(original);
  expect(stored(s.adapter, "Blocked.md")).toBeUndefined();
  pointer(target, "pointerdown", 100, 150); pointer(target, "pointermove", 200, 200); pointer(target, "pointerup", 200, 200);
  expect(original.bundle().document.objects).toHaveLength(1);
  io.beforeWrite = undefined; renamedView(target, "Recovered.md");
  await s.manager.changed("Recovered.md", "rename", "Blocked.md");
  expect(boardLayer(s.manager, target)).toBe(original); expect(original.bundle().document).toMatchObject({ id, sourceFile: "Recovered.md" });
  expect(stored(s.adapter, "Recovered.md")!.objects).toHaveLength(1);
});
it("relocates a rotated PDF layer without resetting its page coordinates", async () => {
  const io = new RenameDraftIO(), target = pdfView(90), s = setup([target], undefined, undefined, undefined, undefined, new BoardDraftStore(io));
  await s.manager.toggle(target); await draw(target); const original = boardLayer(s.manager, target), object = original.bundle().document.objects[0]!, projected = original.surfaceFor(original.bundle().document.objects[0]!.anchor)!.project(original.bundle().document.objects[0]!);
  s.adapter.failWrites = true; target.file!.path = "Renamed.pdf";
  await s.manager.changed("Renamed.pdf", "rename", "Diagram.pdf");
  expect(boardLayer(s.manager, target)).toBe(original); expect(original.bundle().document.objects[0]).toEqual(object);
  expect(original.surfaceFor(object.anchor)!.project(object)).toEqual(projected);
  s.adapter.failWrites = false;
});
describe('explicit historical drawing choice', () => {
  async function ambiguous() {
    const target=view(),io=new RenameDraftIO(),s=setup([target],undefined,undefined,undefined,undefined,new BoardDraftStore(io));
    const {createBoardDocument}=await import('../src/board-model.js');
    await s.adapter.mkdir(s.settings.memoryRoot+'/boards');
    for (const id of ['BOARD-first','BOARD-second']) {
      const document=createBoardDocument('Physics.md','markdown',id);document.title=id;
      s.adapter.files.set(s.settings.memoryRoot+'/boards/'+id+'.board.json',JSON.stringify(document));
    }
    return {target,io,s};
  }
  it('does not open a choice during passive layout and preserves files on explicit cancel',async()=>{
    const {target,io,s}=await ambiguous(),before=new Map(s.adapter.files);
    await s.manager.sync();expect(document.querySelector('.test-modal')).toBeNull();
    const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());
    const modal=document.querySelector('.test-modal')!;expect(modal).not.toBeNull();
    const buttons=modal.querySelectorAll<HTMLButtonElement>('button');expect(buttons).toHaveLength(3);buttons[2]!.click();await opening;
    expect(target.containerEl.querySelector('.atl-board-layer')).toBeNull();expect(s.adapter.files).toEqual(before);expect(io.files.size).toBe(0);
  });
  it('opens only the selected historical drawing and does not combine versions',async()=>{
    const {target,s}=await ambiguous(),before=new Map(s.adapter.files);
    const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());
    const choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[1]!.disabled).toBe(false));choices[1]!.click();await opening;
    expect(boardLayer(s.manager,target).bundle().document.id).toBe('BOARD-second');expect(s.adapter.files).toEqual(before);expect(document.querySelector('.test-modal')).toBeNull();
  });
  it('can revisit another historical drawing from the existing saved-board action',async()=>{
    const {target,s}=await ambiguous();const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());
    let choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[1]!.disabled).toBe(false));choices[1]!.click();await opening;
    const oldSurface=s.manager.toolSurfaces()[0]!;
    button(target,'settings').click();await settle();
    const saved=[...document.querySelectorAll<HTMLButtonElement>('.atl-board-options button')].find(b=>b.textContent===t('board.export'))!;saved.click();
    await vi.waitFor(()=>expect(document.querySelector('.test-modal img')).not.toBeNull());
    choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[0]!.disabled).toBe(false));choices[0]!.click();
    await vi.waitFor(()=>expect(boardLayer(s.manager,target).bundle().document.id).toBe('BOARD-first'));
    await expect(oldSurface.read()).rejects.toThrow('surface-closed');expect(s.app.workspace.openLinkText).not.toHaveBeenCalled();
  });
  it('cancels a revisit without dropping the currently loaded scene or undo history',async()=>{
    const {target,s}=await ambiguous();const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());
    let choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[1]!.disabled).toBe(false));choices[1]!.click();await opening;
    const layer=boardLayer(s.manager,target),history=layer.history;
    button(target,'settings').click();await settle();[...document.querySelectorAll<HTMLButtonElement>('.atl-board-options button')].find(b=>b.textContent===t('board.export'))!.click();
    await vi.waitFor(()=>expect(document.querySelector('.test-modal img')).not.toBeNull());choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');choices[2]!.click();
    await settle();expect(boardLayer(s.manager,target)).toBe(layer);expect(layer.history).toBe(history);expect(target.containerEl.querySelector<HTMLElement>('.view-content')!.inert).toBeFalsy();
  });
  async function selectedSecond() {
    const fixture=await ambiguous(),{target,s}=fixture;
    const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());
    const choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[1]!.disabled).toBe(false));choices[1]!.click();await opening;
    return fixture;
  }
  async function revisit(target: TestView) {
    button(target,'settings').click();await settle();[...document.querySelectorAll<HTMLButtonElement>('.atl-board-options button')].find(b=>b.textContent===t('board.export'))!.click();
    await vi.waitFor(()=>expect(document.querySelector('.test-modal img')).not.toBeNull());
    const choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[0]!.disabled).toBe(false));return choices;
  }
  it('switches every open split bound to the same source and invalidates their old tools',async()=>{
    const {target,s}=await selectedSecond(),second=view();s.views.push(second);await s.manager.toggle(second);
    const handles=s.manager.toolSurfaces(),choices=await revisit(target);choices[0]!.click();
    await vi.waitFor(()=>expect(boardLayer(s.manager,second).bundle().document.id).toBe('BOARD-first'));
    expect(boardLayer(s.manager,target).bundle().document.id).toBe('BOARD-first');
    for(const handle of handles)await expect(handle.read()).rejects.toThrow('surface-closed');
    expect(target.containerEl.querySelectorAll('.atl-board-layer')).toHaveLength(1);expect(second.containerEl.querySelectorAll('.atl-board-layer')).toHaveLength(1);
  });
  it('retains ink and undo history when saving the current drawing before a revisit fails',async()=>{
    const {target,s}=await selectedSecond();await draw(target);const layer=boardLayer(s.manager,target),bundle=layer.bundle(),history=layer.history;s.adapter.failWrites=true;
    button(target,'settings').click();await settle();[...document.querySelectorAll<HTMLButtonElement>('.atl-board-options button')].find(b=>b.textContent===t('board.export'))!.click();
    await vi.waitFor(()=>expect(notice).toHaveBeenCalled());await settle();expect(document.querySelector('.test-modal')).toBeNull();
    expect(boardLayer(s.manager,target)).toBe(layer);expect(layer.history).toBe(history);expect(layer.bundle().document.objects).toEqual(bundle.document.objects);expect(layer.bundle().ink).toEqual(bundle.ink);
    expect(target.containerEl.querySelector<HTMLElement>('.view-content')!.inert).toBeFalsy();s.adapter.failWrites=false;
  });
  it('cancels during validation without changing the selection or dropping the current scene',async()=>{
    const {target,io,s}=await selectedSecond(),layer=boardLayer(s.manager,target),choices=await revisit(target),drafts=new BoardDraftStore(io);
    const path=await drafts.path(s.settings.memoryRoot,'Physics.md','markdown'),identity=await drafts.identities.get(s.settings.memoryRoot,'Physics.md','markdown');
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});const read=io.read.bind(io);let held=false;
    vi.spyOn(io,'read').mockImplementation(async p=>{if(p===path&&!held){held=true;enter();await gate;}return read(p);});
    choices[0]!.click();await entered;choices[2]!.click();release();await vi.waitFor(()=>expect(target.containerEl.querySelector<HTMLElement>('.view-content')!.inert).toBeFalsy());
    expect((await drafts.identities.get(s.settings.memoryRoot,'Physics.md','markdown'))!.boardId).toBe(identity!.boardId);expect(boardLayer(s.manager,target)).toBe(layer);
  });
  it('reports a committed choice if cancellation arrives after its commit boundary',async()=>{
    const {target,io,s}=await selectedSecond(),choices=await revisit(target),drafts=new BoardDraftStore(io),path=await drafts.identities.path(s.settings.memoryRoot,'Physics.md','markdown');
    io.beforeWrite=(p,raw)=>{if(p===path&&JSON.parse(raw).boardId==='BOARD-first')choices[2]!.click();};choices[0]!.click();
    await vi.waitFor(()=>expect(boardLayer(s.manager,target).bundle().document.id).toBe('BOARD-first'));expect(notice).toHaveBeenCalledWith(t('board.sourceBranchSelected'));
    expect((await drafts.identities.get(s.settings.memoryRoot,'Physics.md','markdown'))!.boardId).toBe('BOARD-first');
  });
  it('arranges different paragraph anchors in a derived preview without changing their objects',async()=>{
    const {target,s}=await ambiguous(),path=s.settings.memoryRoot+'/boards/BOARD-first.board.json',doc=JSON.parse(s.adapter.files.get(path)!);
    doc.objects=['a','b'].map((key,i)=>({id:'OBJ-'+key,kind:'rect',anchor:{kind:'markdown',key,quote:'Synthetic'},x:-50,y:-60,width:40,height:40,color:'#446677',strokeWidth:2,createdBy:'human',editedBy:'human',revision:1,groupId:'GROUP-'+i}));const raw=JSON.stringify(doc);s.adapter.files.set(path,raw);
    const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal img')?.getAttribute('src')).toBeTruthy());
    const src=document.querySelector<HTMLImageElement>('.test-modal img')!.getAttribute('src')!,svg=new DOMParser().parseFromString(decodeURIComponent(src.split(',')[1]!), 'image/svg+xml');
    const rects=[...svg.querySelectorAll('rect')];expect(rects).toHaveLength(2);expect(rects[0]!.closest('g[transform]')!.getAttribute('transform')).not.toBe(rects[1]!.closest('g[transform]')!.getAttribute('transform'));expect(s.adapter.files.get(path)).toBe(raw);
    const buttons=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');buttons[2]!.click();await opening;
  });
  it('skips a costly thumbnail while leaving a verified large drawing available to open',async()=>{
    const {target,s}=await ambiguous(),path=s.settings.memoryRoot+'/boards/BOARD-first.board.json',doc=JSON.parse(s.adapter.files.get(path)!);
    doc.objects=Array.from({length:1001},(_,i)=>({id:'OBJ-'+i,kind:'rect',anchor:{kind:'markdown',key:'p',quote:'Synthetic'},x:20,y:30,width:40,height:40,color:'#446677',strokeWidth:2,createdBy:'human',editedBy:'human',revision:1,groupId:'GROUP-'+i}));s.adapter.files.set(path,JSON.stringify(doc));
    const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());const buttons=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(buttons[0]!.disabled).toBe(false));
    const image=document.querySelector<HTMLImageElement>('.test-modal img')!;expect(image.hidden).toBe(true);expect(image.getAttribute('src')).toBeNull();expect(document.querySelector('.test-modal')!.textContent).toContain(t('board.sourceBranchPreviewLarge'));buttons[2]!.click();await opening;
  });
  it('keeps every verified alternative usable after a failed selection commit',async()=>{
    const {target,io,s}=await ambiguous(),drafts=new BoardDraftStore(io),path=await drafts.identities.path(s.settings.memoryRoot,'Physics.md','markdown');
    const opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());
    const choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect([choices[0]!.disabled,choices[1]!.disabled]).toEqual([false,false]));
    let failed=false;io.beforeWrite=p=>{if(p===path&&!failed){failed=true;throw new Error('synthetic-selection-write-failure');}};
    choices[0]!.click();await vi.waitFor(()=>expect(document.querySelector('.test-modal [role="status"]')!.textContent).toBe(t('board.sourceBranchStale')));
    expect(choices[0]!.disabled).toBe(false);expect(choices[1]!.disabled).toBe(false);choices[1]!.click();await opening;
    expect(boardLayer(s.manager,target).bundle().document.id).toBe('BOARD-second');
  });
  it('does not let a late preview start another selection while one commit is pending',async()=>{
    const {target,io,s}=await ambiguous(),repo=(s.manager as any).repository as BoardRepository,drafts=new BoardDraftStore(io),path=await drafts.identities.path(s.settings.memoryRoot,'Physics.md','markdown');
    let releasePreview!:()=>void,releaseCommit!:()=>void,enter!:()=>void,calls=0;
    const previewGate=new Promise<void>(r=>{releasePreview=r;}),commitGate=new Promise<void>(r=>{releaseCommit=r;}),entered=new Promise<void>(r=>{enter=r;});
    vi.spyOn(repo,'characters').mockImplementation(async()=>{if(++calls===2)await previewGate;return [];});
    const write=io.compareWrite.bind(io);vi.spyOn(io,'compareWrite').mockImplementation(async(p,expected,raw)=>{if(p===path){enter();await commitGate;}return write(p,expected,raw);});
    const selecting=vi.spyOn(repo,'selectSourceBranch'),opening=s.manager.toggle(target);await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());
    const choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[0]!.disabled).toBe(false));choices[0]!.click();await entered;
    releasePreview();await vi.waitFor(()=>expect(document.querySelectorAll('.test-modal img[src]')).toHaveLength(2));expect(choices[1]!.disabled).toBe(true);
    choices[1]!.onclick!(new PointerEvent('click'));expect(selecting).toHaveBeenCalledTimes(1);releaseCommit();await opening;
    expect(boardLayer(s.manager,target).bundle().document.id).toBe('BOARD-first');
  });
});

describe('Studio version choice through the shared manager',()=>{
  async function standalone() {
    const source='Studio.md',io=new RenameDraftIO(),participants:BoardSourceMoveParticipant[]=[],s=setup([view()],undefined,undefined,undefined,undefined,new BoardDraftStore(io),path=>path===source?participants:[]);
    await s.adapter.mkdir(s.settings.memoryRoot+'/boards');
    for(const id of ['BOARD-first','BOARD-second'])s.adapter.files.set(s.settings.memoryRoot+'/boards/'+id+'.board.json',JSON.stringify(createBoardDocument(source,'standalone',id)));
    const repo=(s.manager as any).repository as BoardRepository,choices=await repo.sourceBranchChoices(source,'standalone');
    const original=await repo.selectSourceBranch(source,'standalone','BOARD-second',choices!.branches,null);
    const participant=()=>({prepare:vi.fn(async()=>structuredClone(original)),accept:vi.fn(),replaceVersion:vi.fn(async()=>{}),release:vi.fn()});
    const left=participant(),right=participant();participants.push(left,right);return {source,s,left,right,repo};
  }
  it('saves and replaces every fixed-source participant with the same selected version',async()=>{
    const {source,s,left,right}=await standalone(),changing=s.manager.openSavedStandalone(source,'BOARD-second');
    await vi.waitFor(()=>expect(document.querySelector('.test-modal')).not.toBeNull());const choices=document.querySelector('.test-modal')!.querySelectorAll<HTMLButtonElement>('button');await vi.waitFor(()=>expect(choices[0]!.disabled).toBe(false));choices[0]!.click();await changing;
    for(const participant of [left,right]){expect(participant.prepare).toHaveBeenCalledWith(true);expect(participant.replaceVersion).toHaveBeenCalledWith(expect.objectContaining({document:expect.objectContaining({id:'BOARD-first',sourceFile:source})}));expect(participant.release).toHaveBeenCalledTimes(1);}
    expect(s.app.workspace.openLinkText).not.toHaveBeenCalled();
  });
  it('releases all participants and never opens a choice when one save fails',async()=>{
    const {source,s,left,right,repo}=await standalone(),choices=vi.spyOn(repo,'sourceBranchChoices');right.prepare.mockRejectedValueOnce(new Error('synthetic-studio-save-failure'));
    await expect(s.manager.openSavedStandalone(source,'BOARD-second')).rejects.toThrow('synthetic-studio-save-failure');expect(choices).not.toHaveBeenCalled();expect(document.querySelector('.test-modal')).toBeNull();
    for(const participant of [left,right]){expect(participant.replaceVersion).not.toHaveBeenCalled();expect(participant.release).toHaveBeenCalledTimes(1);}
  });
});
