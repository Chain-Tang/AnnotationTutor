// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AnchorMark } from "../src/decorations-plan.js";

const { menus } = vi.hoisted(() => ({ menus: [] as Array<{ title?: string; copy?: () => void; event?: MouseEvent }> }));
vi.mock("obsidian", () => ({
  Notice: class {}, addIcon: vi.fn(), setIcon: vi.fn(), setTooltip: vi.fn(),
  Menu: class {
    record: (typeof menus)[number] = {};
    constructor() { menus.push(this.record); }
    addItem(configure: (item: { setTitle(title: string): unknown; setIcon(icon: string): unknown; onClick(callback: () => void): unknown }) => unknown): void {
      const item = {
        setTitle: (title: string) => { this.record.title = title; return item; },
        setIcon: (_icon: string) => item,
        onClick: (callback: () => void) => { this.record.copy = callback; return item; }
      };
      configure(item);
    }
    showAtMouseEvent(event: MouseEvent): void { this.record.event = event; }
  }
}));
import { buildMarginCard, disposeMarginCard, setMarginCardHandlers } from "../src/margin-card.js";

const root: AnchorMark = {
  id: "selection-A", blockId: "block", selectedText: "Original source", note: "Learner question",
  review: "Tutor reviewed text", dialogue: [
    { id: "question-1", role: "user", text: "Learner follow-up", at: "2026-10-20" },
    { id: "answer-1", role: "agent", text: "Tutor follow-up answer", at: "2026-10-20" }
  ]
};
const cards: HTMLElement[] = [];
const views: EditorView[] = [];

beforeEach(() => {
  menus.length = 0;
  Object.defineProperty(HTMLElement.prototype, "createEl", { configurable: true, value(tag: string, options: { cls?: string } = {}) {
    const element = document.createElement(tag); element.className = options.cls ?? ""; this.append(element); return element;
  } });
  setMarginCardHandlers({ save: vi.fn(), ask: vi.fn(), discuss: vi.fn(), reply: vi.fn(async () => ({ ok: true })),
    render: async (el, text) => { await Promise.resolve(); el.replaceChildren(document.createTextNode(text)); },
    saveCell: vi.fn(), remove: vi.fn(), settings: vi.fn() });
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  for (const card of cards.splice(0)) disposeMarginCard(card);
  for (const view of views.splice(0)) view.destroy();
  setMarginCardHandlers(null); document.body.replaceChildren(); vi.restoreAllMocks();
});

async function fixture(branch: boolean = false) {
  const container = document.createElement("div"); document.body.append(container);
  const view = new EditorView({ state: EditorState.create({ doc: "Original source note", selection: { anchor: 0, head: 8 } }), parent: container });
  views.push(view);
  const overlay = document.createElement("div"); overlay.className = "atl-rail"; view.dom.append(overlay);
  const mark: AnchorMark = branch ? { ...root, id: "selection-B", branch: {
    parentAnnotationId: root.id, rootAnnotationId: root.id, sourceVersion: "v1",
    parentReply: { id: "review", kind: "review", version: "v1", text: root.review! }
  }, request: { id: "request-B", status: "completed", question: root.note!, updatedAt: "2026-10-20" } } : root;
  const { card } = buildMarginCard(mark, { skin: { id: "flat", quiet: false, tilt: null }, geom: { dx: 0, dy: 0 },
    showReview: true, inlineWorkflow: true, onCollapse: vi.fn(), onDragMove: vi.fn() });
  cards.push(card); overlay.append(card);
  await Promise.resolve(); await Promise.resolve();
  return { view, card };
}

function selectText(el: HTMLElement): string {
  const range = document.createRange(); range.selectNodeContents(el);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  return selection.toString();
}

describe("annotation card native selection and copy inside the source editor", () => {
  it.each([false, true])("keeps root/child text selection focused on the card (branch=%s)", async branch => {
    const { view, card } = await fixture(branch);
    view.focus();
    const text = card.querySelector<HTMLElement>(".atl-rail-review")!;
    const mouse = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    const sourceMouse = vi.fn(); view.dom.addEventListener("mousedown", sourceMouse);
    text.dispatchEvent(mouse);
    expect(mouse.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(card);
    expect(card.contentEditable).toBe("false");
    expect(selectText(text)).toBe(root.review);
    expect(sourceMouse).not.toHaveBeenCalled();
    const originalSelection = view.state.selection.toJSON();
    const sourceCopy = vi.fn((event: Event) => event.preventDefault()); view.dom.addEventListener("copy", sourceCopy);
    const copy = new Event("copy", { bubbles: true, cancelable: true }); card.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(sourceCopy).not.toHaveBeenCalled();
    expect(document.getSelection()?.toString()).toBe(root.review);
    expect(view.state.selection.toJSON()).toEqual(originalSelection);
    // The same source handler still receives events from the original note.
    view.contentDOM.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    expect(sourceCopy).toHaveBeenCalledOnce();
  });

  it("preserves native selection/editing keys for the question and continuation fields", async () => {
    const { view, card } = await fixture();
    const sourceKeys = vi.fn(); view.dom.addEventListener("keydown", sourceKeys);
    for (const selector of [".atl-rail-edit", ".atl-rail-reply"]) {
      const field = card.querySelector<HTMLTextAreaElement>(selector)!;
      field.focus(); field.value = "A selectable question"; field.setSelectionRange(2, 12);
      const mouse = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }); field.dispatchEvent(mouse);
      expect(document.activeElement).toBe(field); expect(mouse.defaultPrevented).toBe(false);
      const key = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }); field.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false); expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("selectable");
    }
    expect(sourceKeys).not.toHaveBeenCalled();
  });

  it("copies exactly the selected rendered text through the card's context menu", async () => {
    const { card } = await fixture();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const reply = card.querySelector<HTMLElement>(".atl-rail-review")!;
    selectText(reply);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); reply.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(menus).toHaveLength(1); expect(menus[0]!.event).toBe(event);
    // Native menus can move focus and clear the selection; the text is captured.
    document.getSelection()?.removeAllRanges(); menus[0]!.copy!(); await Promise.resolve();
    expect(write).toHaveBeenCalledWith(root.review);
  });

  it("copies only the selected question substring and leaves empty context menus to the host", async () => {
    const { card } = await fixture(true);
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const field = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    field.setSelectionRange(8, 16);
    field.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    menus[0]!.copy!(); await Promise.resolve();
    expect(write).toHaveBeenCalledWith("question");
    field.setSelectionRange(0, 0);
    const empty = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); field.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(false); expect(menus).toHaveLength(1);
  });

  it("keeps user/Tutor dialogue selectable and retains async rendered copy-whole controls", async () => {
    const { card } = await fixture();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const user = card.querySelector<HTMLElement>(".atl-rail-turn--user")!;
    const agent = card.querySelector<HTMLElement>(".atl-rail-turn--agent")!;
    for (const turn of [user, agent]) {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }); turn.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false); expect(document.activeElement).toBe(card);
      expect(selectText(turn)).toContain(turn === user ? "Learner follow-up" : "Tutor follow-up answer");
    }
    const copy = agent.querySelector<HTMLButtonElement>(".atl-rail-copy")!;
    expect(copy).not.toBeNull(); copy.click(); await Promise.resolve();
    expect(write).toHaveBeenCalledWith("Tutor follow-up answer");
  });
});
