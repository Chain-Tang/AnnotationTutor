// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import type AnnotationTutorLitePlugin from "../src/main.js";
import type { ChatLog, ChatLogHead } from "../src/model.js";
const { workspace } = vi.hoisted(() => ({ workspace: { on: vi.fn((_event: string, _callback: (...args: unknown[]) => unknown) => ({})) } }));
vi.mock("obsidian", () => ({
  ItemView: class {
    app = { workspace };
    contentEl = document.createElement("div");
    registerEvent() {}
    register() {}
  },
  Modal: class {
    modalEl = document.createElement("div");
    titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    open() { document.body.append(this.modalEl); (this as { onOpen?: () => void }).onOpen?.(); }
    close() { (this as { onClose?: () => void }).onClose?.(); this.modalEl.remove(); }
  },
  Menu: class {
    root=document.createElement('div');
    addItem(build:(item:unknown)=>void) {
      const button=document.createElement('button');button.setAttribute('role','menuitem');this.root.append(button);
      const item={setTitle:(text:string)=>{button.textContent=text;return item;},setIcon:()=>item,onClick:(fn:()=>void)=>{button.onclick=()=>{this.root.remove();fn();};return item;}};
      build(item);return this;
    }
    addSeparator(){return this;}
    showAtPosition(){document.body.append(this.root);}
  },
  MarkdownRenderer: { render: async (_app: unknown, text: string, element: HTMLElement) => { element.textContent = text; } },
  setIcon: (element: HTMLElement, icon: string) => { element.dataset.icon = icon; },
  setTooltip: (element: HTMLElement, label: string) => { element.setAttribute("aria-label", label); }
}));
import { ChatView } from "../src/views/chat-view.js";
import { TutorConversation, type TutorRunnerInput } from "../src/tutor-conversation.js";
import { setLocale } from "../src/i18n.js";
import { SupportSession } from "../src/support-session.js";

const conversations: TutorConversation[] = [];
const views: ChatView[] = [];
beforeEach(() => {
  setLocale("en");
  const create = function(this: HTMLElement, tag: string, options?: { cls?: string; text?: string }) {
    const el = this.ownerDocument.createElement(tag);
    if (options?.cls) el.className = options.cls;
    if (options?.text) el.textContent = options.text;
    this.append(el); return el;
  };
  const methods = {
    createEl: create,
    createDiv(this: HTMLElement, opts?: { cls?: string; text?: string }) { return create.call(this, "div", opts); },
    createSpan(this: HTMLElement, opts?: { cls?: string; text?: string }) { return create.call(this, "span", opts); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
    hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
    toggleClass(this: HTMLElement, cls: string, on: boolean) { this.classList.toggle(cls, on); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    getText(this: HTMLElement) { return this.textContent ?? ""; },
    hide(this: HTMLElement) { this.hidden = true; },
    show(this: HTMLElement) { this.hidden = false; }
  };
  for (const [name, method] of Object.entries(methods)) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: method });
});
afterEach(async () => {
  for (const view of views.splice(0)) await view.onClose();
  for (const conversation of conversations.splice(0)) conversation.dispose();
  document.body.replaceChildren(); vi.restoreAllMocks();
});
async function open(conversation: TutorConversation,support?:SupportSession) {
  const plugin = {
    tutorConversation: conversation,
    settings: { persistChatLog: false, chatEngine: "api", apiModel: "test", reviewLanguage: "",supportRetentionDays:7 },
    support,
    supportQuiet:()=>true,
    chatContext: async () => ({ notePath: "Note.md", content: "Physics" }),
    tutorContext:vi.fn(async(path:string,_start?:number,_length?:number)=>({source:path,text:"Pinned material",revision:"pinned-v1",sourceBinding:"host-issued-pinned-lease"})),
    captureEditTarget: vi.fn(() => null),
    chatLocate: vi.fn(() => null),
    learnerProfileSummary: () => "",
    openSettings: vi.fn(),
    store: {
      listChatLogs: vi.fn<() => Promise<ChatLogHead[]>>(async () => []),
      loadChatLog: vi.fn<(id: string) => Promise<ChatLog | null>>(async () => null),
      deleteChatLog: vi.fn(async () => undefined),
      clearChatLogs: vi.fn(async () => undefined),
    }
  };
  const view = new ChatView({} as WorkspaceLeaf, plugin as unknown as AnnotationTutorLitePlugin);
  views.push(view); document.body.append(view.contentEl);
  vi.spyOn(view.contentEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 350, 800));
  await view.onOpen(); return { view, plugin };
}
function conversation(run: (input: TutorRunnerInput) => Promise<{ text: string }>) {
  const result = new TutorConversation({ run }); conversations.push(result); return result;
}

describe("ChatView as a shared conversation renderer", () => {
  it('submits a selected conditional mathematical question as conversation without capturing a document edit',async()=>{
    const run=vi.fn(async(_input:TutorRunnerInput)=>({text:'极限是4，函数值7使它不连续。'})),{view,plugin}=await open(conversation(run));
    view.seedSelection({notePath:'A.md',selection:'f(x)=x²',content:'数学材料'});
    const input=view.contentEl.querySelector('textarea')!;input.value='原函数f(x)=x²在2处连续。如果仅改成f(2)=7而其他点不变，会破坏连续性吗？';
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));await vi.waitFor(()=>expect(run).toHaveBeenCalledOnce());
    expect(run.mock.calls[0]![0].options.learningTurn?.kind).toBe('conversation');expect(plugin.captureEditTarget).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![0].options.context).toMatchObject({chat:{notePath:'A.md',selectionBound:true}});
  });
  it('prepares a typed drawing request over selected material before edit guards when no board is open',async()=>{
    const draw=vi.fn(async()=>({text:'diagram'})),prepare=vi.fn(async(_text:string,options:import('../src/tutor-conversation.js').TutorSubmitOptions)=>{service.registerBoard({id:'A',sourcePath:'A.md',run:draw});return {...options,route:'board' as const,boardId:'A'};});
    const service=new TutorConversation({prepare,run:async()=>({text:'answer'})});conversations.push(service);
    const {view,plugin}=await open(service);view.seedSelection({notePath:'A.md',selection:'limit',content:'数学材料'});
    const input=view.contentEl.querySelector('textarea')!;input.value='请画一个示意图表示极限。请在本页空白处画，不修改正文。';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));
    await vi.waitFor(()=>expect(draw).toHaveBeenCalledOnce());expect(prepare).toHaveBeenCalledOnce();expect(plugin.captureEditTarget).not.toHaveBeenCalled();
    expect(prepare.mock.calls[0]![1]).toMatchObject({resolveIntent:true,context:{chat:{notePath:'A.md',selectionBound:true}}});
  });
  it("keeps one default composer and opens an isolated optional conversation without losing the normal draft", async () => {
    const save=vi.fn(async()=>{}),run=vi.fn(async()=>"private answer");
    const support=new SupportSession({available:()=>true,load:async()=>[],save,readDay:async()=>'',writeDay:async()=>{}},run);
    const ordinary=vi.fn(async()=>({text:"ordinary answer"}));
    const {view}=await open(conversation(ordinary),support);
    try {
      expect(view.contentEl.querySelectorAll('textarea')).toHaveLength(1);
      expect((view.contentEl.querySelector('.atl-support-checkin') as HTMLElement).hidden).toBe(true);
      const input=view.contentEl.querySelector('textarea')!;input.value='unsent study draft';
      const launch=()=>{view.contentEl.querySelector<HTMLButtonElement>('[aria-label="More options"]')!.click();[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b=>b.textContent==='Chat without saving')!.click();};
      launch();launch();expect(document.querySelectorAll('.atl-support-modal')).toHaveLength(1);
      const privateInput=document.querySelector<HTMLTextAreaElement>('.atl-support-modal textarea')!;privateInput.value='private fixture';
      privateInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true}));await Promise.resolve();expect(run).not.toHaveBeenCalled();
      privateInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));await vi.waitFor(()=>expect(run).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(support.busy).toBe(false));
      expect(ordinary).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(input.value).toBe('unsent study draft');
      [...document.querySelectorAll<HTMLButtonElement>('.atl-support-modal button')].find(b=>b.textContent==='Close and clear conversation')!.click();
      expect(document.querySelector('.atl-support-modal')).toBeNull();expect(support.messages).toHaveLength(0);expect(input.value).toBe('unsent study draft');
    } finally {support.dispose();}
  });

  it("keeps selected material and the existing draft when the user switches documents", async () => {
    const plain=vi.fn(async (_input:TutorRunnerInput)=>({text:"answer"}));
    const {view,plugin}=await open(conversation(plain));
    view.contentEl.querySelector('textarea')!.value='my draft';
    view.seedSelection({notePath:'A.md',selection:'f(x)=x²',content:'original material',sourceBinding:'selected-buffer-lease',observation:{source:'A.md',version:'v1',scope:'selection',hasImage:false}});
    plugin.chatContext=async()=>({notePath:'B.md',content:'unrelated'});
    view.refresh();await Promise.resolve();
    expect(view.contentEl.querySelectorAll('textarea')).toHaveLength(1);
    expect(view.contentEl.querySelector('textarea')!.value).toBe('my draft');
    expect(view.contentEl.querySelector('.atl-chat-context')?.textContent).toContain('A.md');
    const explain=view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-chat-board-actions button')[0]!;
    expect(explain.textContent).toBe('Explain selection');explain.click();
    await vi.waitFor(()=>expect(plain).toHaveBeenCalledOnce());
    expect(plain.mock.calls[0]![0].options.context).toMatchObject({chat:{notePath:'A.md',selection:'f(x)=x²',content:'original material',selectionBound:true,sourceBinding:'selected-buffer-lease'}});
    expect(plugin.captureEditTarget).not.toHaveBeenCalled();
    view.renameSelectionSource('A.md','Renamed.md');await Promise.resolve();
    expect(view.contentEl.querySelector('.atl-chat-context')?.textContent).toContain('Renamed.md');
    view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Follow the active document again"]')!.click();await Promise.resolve();
    expect(view.contentEl.querySelector('.atl-chat-context')?.textContent).toBe('📄 B.md');
  });

  it("captures a pinned annotation's source lease and identity in the submitted turn",async()=>{
    const run=vi.fn(async(_input:TutorRunnerInput)=>({text:'reply'})),{view,plugin}=await open(conversation(run));
    view.seedAnnotation({annotationId:'ANN-A',sourceFile:'A.md',selectedText:'selected A'} as never);
    const input=view.contentEl.querySelector('textarea')!;input.value='continue this question';
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));
    await vi.waitFor(()=>expect(run).toHaveBeenCalledOnce());
    expect(plugin.tutorContext).toHaveBeenCalledWith('A.md',0,6000);
    expect(run.mock.calls[0]![0].options).toMatchObject({metadata:{annotationId:'ANN-A'},context:{chat:{notePath:'A.md',sourceBinding:'host-issued-pinned-lease',content:'Pinned material',observation:{source:'A.md',version:'pinned-v1',scope:'selection',hasImage:false}}}});
  });

  it("does not submit a delayed pinned-source read into a replacement conversation",async()=>{
    const run=vi.fn(async(_input:TutorRunnerInput)=>({text:'wrong target'})),{view,plugin}=await open(conversation(run));
    let release!:(value:Awaited<ReturnType<typeof plugin.tutorContext>>)=>void;
    plugin.tutorContext.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    view.seedAnnotation({annotationId:'ANN-A',sourceFile:'A.md',selectedText:'selected A'} as never);
    const input=view.contentEl.querySelector('textarea')!;input.value='continue this question';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));
    await vi.waitFor(()=>expect(plugin.tutorContext).toHaveBeenCalledOnce());
    view.seedAnnotation({annotationId:'ANN-B',sourceFile:'B.md',selectedText:'selected B'} as never);
    release({source:'A.md',text:'Pinned material',revision:'pinned-v1',sourceBinding:'host-issued-pinned-lease'});
    await vi.waitFor(()=>expect(view.contentEl.querySelector('.atl-chat-notice')?.textContent).toContain("The conversation's material changed"));
    expect(run).not.toHaveBeenCalled();
  });

  it("selected diagram requests run semantic preparation before choosing a drawing target", async () => {
    const draw=vi.fn(async(_text:string)=>({text:'diagram'}));
    const prepare=vi.fn(async(_text:string,options:import('../src/tutor-conversation.js').TutorSubmitOptions)=>({...options,route:'board' as const,boardId:'A',boardInstruction:'draw selected A'}));
    const service=new TutorConversation({prepare,run:async()=>({text:'answer'})});conversations.push(service);
    service.registerBoard({id:'A',sourcePath:'A.md',canAuto:()=>false,run:draw});
    const other=vi.fn(async()=>({text:'wrong target'}));service.registerBoard({id:'B',sourcePath:'B.md',canAuto:()=>false,run:other});
    const {view}=await open(service);view.seedSelection({notePath:'A.md',selection:'limit'});
    view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-chat-board-actions button')[1]!.click();
    await vi.waitFor(()=>expect(draw).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledOnce();expect(other).not.toHaveBeenCalled();
    expect(draw.mock.calls[0]?.[0]).toBe('draw selected A');
    expect(service.state.history[0]?.text).toBe('Draw a diagram');
  });

  it("renders a searchable, grouped history browser with the current session highlighted", async () => {
    const service = conversation(async () => ({ text: "answer" }));
    const current = { id: "CHAT-1", title: "Whale character study", engine: "api" as const,
      mode: "ask" as const, status: "active" as const, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), turns: [{ role: "user" as const, text: "Draw a whale character", at: new Date().toISOString() }] };
    service.log = current;
    const { view, plugin } = await open(service);
    plugin.store.listChatLogs.mockResolvedValue([{ ...current, turns: 1 }]);
    plugin.store.loadChatLog.mockResolvedValue(current);
    view.contentEl.querySelector<HTMLButtonElement>('[aria-label="More options"]')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b=>b.textContent==='Chat history')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll(".atl-chat-history-item")).toHaveLength(1));
    expect(document.querySelector(".atl-chat-history-search-input")).not.toBeNull();
    expect(document.querySelector(".atl-chat-history-item")?.classList.contains("is-current")).toBe(true);
    expect(document.querySelector(".atl-chat-history-count")?.textContent).toContain("1");
    const search = document.querySelector<HTMLInputElement>(".atl-chat-history-search-input")!;
    search.value = "missing"; search.dispatchEvent(new Event("input"));
    expect(document.querySelector(".atl-chat-history-empty-title")?.textContent).toBe("No matching conversations");
  });

  it("closes and reopens during a live reply without cancelling generation or dropping history", async () => {
    let input!: TutorRunnerInput;
    let finish!: (value: { text: string }) => void;
    const service = conversation(next => { input = next; return new Promise(resolve => { finish = resolve; }); });
    const { view } = await open(service);
    const turn = service.submit("hello"); input.onReply("first");
    await view.onClose(); view.contentEl.remove();
    expect(input.signal.aborted).toBe(false);
    input.onReply(" second");
    const reopened = await open(service);
    finish({ text: "first second" }); await turn;
    await Promise.resolve();
    expect(reopened.view.contentEl.querySelectorAll(".atl-chat-msg--user")).toHaveLength(1);
    expect(reopened.view.contentEl.querySelector(".atl-chat-md")?.textContent).toContain("first second");
    expect(service.isSidebarVisible(document)).toBe(true);
  });

  it("does not submit Enter while an IME composition is active", async () => {
    const run = vi.fn(async () => ({ text: "answer" }));
    const { view } = await open(conversation(run));
    const textarea = view.contentEl.querySelector("textarea")!;
    textarea.value = "中文";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    await Promise.resolve(); expect(run).not.toHaveBeenCalled();
    expect(textarea.value).toBe("中文");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  });

  it("routes visual shortcuts to a paused board without turning on automatic observation", async () => {
    const plain = vi.fn(async () => ({ text: "plain" }));
    const draw = vi.fn(async () => ({ text: "drawing" }));
    const service = conversation(plain);
    service.registerBoard({ id: "board", sourcePath: "Note.md", canAuto: () => false, run: draw });
    const { view } = await open(service);
    const button = view.contentEl.querySelectorAll<HTMLButtonElement>(".atl-chat-board-actions button")[1]!;
    button.click();
    await vi.waitFor(() => expect(draw).toHaveBeenCalledOnce());
    expect(plain).not.toHaveBeenCalled();
    expect(service.state.history[0]?.text).toBe("Draw a diagram");
  });

  it("keeps note edits in the ordinary chat protocol even with a board open", async () => {
    const plain = vi.fn(async (_input: TutorRunnerInput) => ({ text: "proposal" }));
    const draw = vi.fn(async () => ({ text: "drawing" }));
    const service = conversation(plain);
    service.registerBoard({ id: "board", sourcePath: "Note.md", canAuto: () => true, run: draw });
    const { view, plugin } = await open(service);
    const textarea = view.contentEl.querySelector("textarea")!;
    textarea.value = "Insert a diagram into the note";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(plain).toHaveBeenCalledOnce());
    expect(draw).not.toHaveBeenCalled();
    expect(plugin.captureEditTarget).toHaveBeenCalledOnce();
    expect(plugin.captureEditTarget).toHaveBeenCalledWith(undefined,"Note.md");
    expect(plain.mock.calls[0]?.[0].options.context).toMatchObject({ engineText: expect.stringContaining("Insert a diagram") });
  });

  it("does not capture a new document target when a generated block arrives without one", async()=>{
    let finish!:(value:{text:string})=>void;
    const plain=vi.fn(async()=>new Promise<{text:string}>(resolve=>{finish=resolve;}));
    const service=conversation(plain);service.mode="build";
    const {view,plugin}=await open(service);
    const textarea=view.contentEl.querySelector("textarea")!;
    textarea.value="Insert a diagram into the note";
    textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
    await vi.waitFor(()=>expect(plain).toHaveBeenCalledOnce());
    plugin.chatContext=async()=>({notePath:"Other.md",content:"unrelated"});
    finish({text:"```mermaid\ngraph TD\nA-->B\n```"});
    await vi.waitFor(()=>expect(view.contentEl.querySelector(".atl-chat-edit")).not.toBeNull());
    expect(plugin.captureEditTarget).toHaveBeenCalledOnce();
    expect(plugin.captureEditTarget).toHaveBeenCalledWith(undefined,"Note.md");
  });

  it("ignores older context reads after a layout rebuild and overlapping leaf updates", async () => {
    const service = conversation(async () => ({ text: "answer" }));
    const { view, plugin } = await open(service);
    const reads: Array<(context: { notePath: string; content: string }) => void> = [];
    plugin.chatContext = () => new Promise(resolve => { reads.push(resolve); });
    view.refresh(); // A render that will finish after the next layout replaces it.
    view.refresh();
    reads[1]!({ notePath: "Current.md", content: "current" });
    await Promise.resolve();
    reads[0]!({ notePath: "Old.md", content: "old" });
    await Promise.resolve();
    expect(view.contentEl.querySelector(".atl-chat-context")?.textContent).toBe("📄 Current.md");
    const leafChanged = workspace.on.mock.calls.filter(([name]) => name === "active-leaf-change").at(-1)?.[1];
    leafChanged?.(); leafChanged?.(); // Both reads target the same live container.
    reads[3]!({ notePath: "Board QA.md", content: "current" });
    await Promise.resolve();
    reads[2]!({ notePath: "Board QA.md", content: "current" });
    await Promise.resolve();
    expect(view.contentEl.querySelectorAll(".atl-chat-context .atl-chat-chip")).toHaveLength(1);
    expect(view.contentEl.querySelector(".atl-chat-context")?.textContent).toBe("📄 Board QA.md");
  });

  it("settings refresh retains the shared transcript exactly once", async () => {
    const service = conversation(async () => ({ text: "answer" }));
    const { view } = await open(service);
    await service.submit("question"); view.refreshSettings(); await Promise.resolve();
    expect(view.contentEl.querySelectorAll(".atl-chat-msg--user")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".atl-chat-md")).toHaveLength(1);
  });

  it("preserves a thousand-turn transcript, composer, focus and scroll for ordinary settings changes", async () => {
    const service = conversation(async () => ({ text: "answer" }));
    const at = new Date().toISOString();
    service.restore({ id: "large", title: "Large history", engine: "api", mode: "ask", status: "active", createdAt: at, updatedAt: at,
      turns: Array.from({ length: 1000 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, text: `message ${i}`, at })) });
    const { view, plugin } = await open(service);
    const messages = view.contentEl.querySelector<HTMLElement>(".atl-chat-messages")!;
    const children = [...messages.children];
    const input = view.contentEl.querySelector("textarea")!;
    input.value = "未提交的草稿"; input.focus(); input.setSelectionRange(2, 5); messages.scrollTop = 123;
    const readContext = vi.fn(plugin.chatContext); plugin.chatContext = readContext;
    for (let i = 0; i < 10; i++) {
      plugin.settings.supportRetentionDays = i + 1;
      view.refreshSettings();
    }
    plugin.settings.apiModel = "new-model"; view.refreshSettings();
    expect(view.contentEl.querySelector(".atl-chat-messages")).toBe(messages);
    expect([...messages.children]).toEqual(children);
    expect(children).toHaveLength(1000);
    expect(view.contentEl.querySelector("textarea")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.value, input.selectionStart, input.selectionEnd, messages.scrollTop]).toEqual(["未提交的草稿", 2, 5, 123]);
    expect(readContext).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector(".atl-chat-badge")?.textContent).toContain("new-model");
  });

  it("retranslates after a locale change while preserving the draft and rendering each turn once", async () => {
    const service = conversation(async () => ({ text: "answer" }));
    const { view } = await open(service);
    await service.submit("question");
    const input = view.contentEl.querySelector("textarea")!; input.value = "draft";
    setLocale("zh-cn"); view.refreshSettings();
    expect(view.contentEl.querySelector("textarea")!.value).toBe("draft");
    expect(view.contentEl.querySelectorAll(".atl-chat-msg--user")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".atl-chat-md")).toHaveLength(1);
    expect(view.contentEl.querySelector("textarea")!.placeholder).not.toBe(input.placeholder);
  });

  it("keeps an active streamed reply attached across settings saves", async () => {
    let input!: TutorRunnerInput, finish!: (value: { text: string }) => void;
    const service = conversation(next => { input = next; return new Promise(resolve => { finish = resolve; }); });
    const { view, plugin } = await open(service);
    const turn = service.submit("hello"); input.onReply("first");
    const messages = view.contentEl.querySelector(".atl-chat-messages");
    plugin.settings.apiModel = "changed"; view.refreshSettings(); input.onReply(" second");
    finish({ text: "first second" }); await turn; await Promise.resolve();
    expect(view.contentEl.querySelector(".atl-chat-messages")).toBe(messages);
    expect(view.contentEl.querySelectorAll(".atl-chat-msg--user")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".atl-chat-md")).toHaveLength(1);
    expect(view.contentEl.querySelector(".atl-chat-md")?.textContent).toBe("first second");
  });
});
