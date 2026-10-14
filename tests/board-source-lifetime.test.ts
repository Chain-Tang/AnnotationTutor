// @vitest-environment happy-dom
// Independent lifetime/transaction tests. The host harness mirrors board-controller.test
// while that suite is edited separately; model and pixels are deterministic fixtures.
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
import { DEFAULT_SETTINGS } from "../src/settings-config.js";
import {
  discoverBoardSurfaces,
  registerMarkdownBoardSection,
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
} from "../src/board-store.js";
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

beforeEach(() => {
  vi.useFakeTimers();
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
  captureConversationContext?: (view: TestView) => Promise<ChatContext>) {
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
    app,
    conversation,
    captureConversationContext,
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
function boardLayer(manager: InspirationBoards, target: TestView): any {
  return (manager as unknown as {layers:Map<TestView,unknown>}).layers.get(target);
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


describe("board source identity before deferred commits",()=>{
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

  it("does not commit into the old board while another closing layer blocks syncViews",async()=>{
    const first=view("First.md"),target=view("Target.md"),s=streamingScenario([first,target]);useSourceFile(s);
    await s.manager.toggle(first);await s.manager.toggle(target);await settle();
    const firstLayer=boardLayer(s.manager,first),layer=boardLayer(s.manager,target),before=structuredClone(layer.bundle().document.objects);
    const pending=s.conversation.submit("draw a circle",{source:"board",boardId:layer.conversationId,route:"board"});await settle();
    expect(s.turns).toHaveLength(1);
    let release!:()=>void;firstLayer.savePromise=new Promise<void>(resolve=>{release=resolve;});
    first.file={...first.file!,path:"First replacement.md"};target.file={...target.file!,path:"Target replacement.md"};
    const syncing=s.manager.sync();await settle();
    try{
      // syncViews is still waiting for First; it has not detached Target.
      expect(boardLayer(s.manager,target)).toBe(layer);expect(layer.disposed).toBe(false);
      expect(layer.toolSurface().capabilities().available).toBe(false);
      complete(s.turns[0]!,"late",[shape(s.turns[0]!)]);await pending;await settle();
      expect(layer.bundle().document.objects).toEqual(before);
      expect(s.conversation.state.commit).toBeUndefined();
      expect((await s.transactions.journal.recordsForClient("obsidian")).some(r=>r.phase==="committed")).toBe(false);
    }finally{release();await syncing;}
    expect(layer.disposed).toBe(true);
    expect(boardLayer(s.manager,target)).not.toBe(layer);
  });
  it("rejects a replacement TFile with the same path and remounts its layer",async()=>{
    const target=view(),s=streamingScenario([target]);useSourceFile(s);await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target),pending=s.conversation.submit("draw a circle",{source:"board",boardId:layer.conversationId,route:"board"});await settle();
    const oldFile=target.file;target.file={...target.file!};expect(target.file!.path).toBe(oldFile!.path);
    expect(layer.toolSurface().capabilities().available).toBe(false);
    complete(s.turns[0]!,"late",[shape(s.turns[0]!)]);await pending;await settle();
    expect(layer.bundle().document.objects).toHaveLength(0);expect(s.conversation.state.commit).toBeUndefined();
    await s.manager.sync();await settle();expect(boardLayer(s.manager,target)).not.toBe(layer);
    expect(boardLayer(s.manager,target).toolSurface().capabilities().available).toBe(true);
  });
  it("rechecks source identity after the transaction journal await and before apply",async()=>{
    const target=view(),s=streamingScenario([target]);useSourceFile(s);await s.manager.toggle(target);await settle();
    const layer=boardLayer(s.manager,target),pending=s.conversation.submit("draw a circle",{source:"board",boardId:layer.conversationId,route:"board"});await settle();
    let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const transition=s.transactions.journal.transition.bind(s.transactions.journal);
    vi.spyOn(s.transactions.journal,"transition").mockImplementation(async(...args)=>{const result=await transition(...args);if(args[1]==="applying"){entered();await gate;}return result;});
    complete(s.turns[0]!,"drawn",[shape(s.turns[0]!)]);await settle();await reached;
    try{target.file={...target.file!};expect(layer.toolSurface().capabilities().available).toBe(false);}finally{release();}
    await pending;await settle();
    expect(layer.bundle().document.objects).toHaveLength(0);
    const records=await s.transactions.journal.recordsForClient("obsidian");
    expect(records).toHaveLength(1);expect(records[0]?.receipt.durability).toBe("not-applied");
  });
  it("still saves old student work while closing a retargeted view",async()=>{
    const target=view(),s=streamingScenario([target]);useSourceFile(s);await s.manager.toggle(target);await settle();
    await draw(target);const layer=boardLayer(s.manager,target),before=structuredClone(layer.bundle().document.objects);expect(before).toHaveLength(1);
    target.file={...target.file!,path:"New.md"};await s.manager.sync();await settle();
    expect(stored(s.adapter,"Physics.md")!.objects).toEqual(before);expect(layer.disposed).toBe(true);
  });
});
