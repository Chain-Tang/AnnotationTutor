// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ ItemView: class { contentEl = document.createElement("div"); }, Notice: class {}, addIcon: vi.fn(), setIcon: vi.fn(), setTooltip: vi.fn() }));
import { AnnotationGraphView } from "../src/views/annotation-graph.js";
import { setMarginCardHandlers } from "../src/margin-card.js";
import type { AnchorMark } from "../src/decorations-plan.js";
import type { WorkspaceLeaf } from "obsidian";
const root: AnchorMark = { id: "A", blockId: "source-block", selectedText: "source", note: "Original note", review: "Original reply" };
const child: AnchorMark = { id: "B", blockId: "source-block", selectedText: "source", note: "", branch: {
  parentAnnotationId: "A", rootAnnotationId: "A", sourceVersion: "v1", parentReply: { id: "review", kind: "review", version: "v1", text: "Original reply" }
}, request: { id: "request-B", status: "draft", question: "", updatedAt: "2026-10-20" } };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const views: AnnotationGraphView[] = [];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "createEl", { configurable: true, value(tag: string, options: { cls?: string }) {
    const el = document.createElement(tag); el.className = options.cls ?? ""; this.append(el); return el;
  } });
});
afterEach(async () => { for (const view of views.splice(0)) await view.onClose(); setMarginCardHandlers(null); document.body.replaceChildren(); });
function fixture(initial: AnchorMark[] = [root, child]) {
  let marks: AnchorMark[] = [...initial];
  let listener: (() => void) | undefined;
  const saveDraft = vi.fn(async (id: string, note: string) => { marks = marks.map(mark => mark.id === id ? { ...mark, note } : mark); listener?.(); });
  const reply = vi.fn(async (id: string) => {
    marks = marks.map(mark => mark.id === id ? { ...mark, review: "New Tutor reply", request: { ...mark.request!, status: "completed" } } : mark);
    listener?.(); return { ok: true, agentText: "New Tutor reply" };
  });
  const createConversation = vi.fn(async (id: string) => {
    marks.push({ ...child, id: "D", branch: { ...child.branch!, parentAnnotationId: id } }); listener?.(); return { id: "D" };
  });
  setMarginCardHandlers({ save: vi.fn(), ask: vi.fn(), discuss: vi.fn(), reply, render: (el, text) => { el.textContent = text; }, saveCell: vi.fn(), remove: vi.fn(), settings: vi.fn(),
    saveDraft, createConversation, graphCards: () => marks });
  const locateSource = vi.fn();
  const view = new AnnotationGraphView({} as WorkspaceLeaf, { snapshot: () => marks, locateSource, openAnnotation: vi.fn(), subscribe: handler => { listener = handler; return () => { listener = undefined; }; } });
  views.push(view); document.body.appendChild(view.contentEl); return { view, saveDraft, reply, createConversation, locateSource };
}
describe("annotation graph interaction", () => {
  it("offers an edge port only on an answered node and creates a draft without sending", async () => {
    const { view, createConversation, reply } = fixture(); await view.onOpen();
    const answered = view.contentEl.querySelector<HTMLElement>('.atl-graph-node[data-annotation-id="A"]')!;
    const draft = view.contentEl.querySelector<HTMLElement>('.atl-graph-node[data-annotation-id="B"]')!;
    const port = answered.querySelector<HTMLButtonElement>(".atl-branch-port")!;
    expect(port.getAttribute("aria-label")).toBe("创建分支");
    expect(port.textContent).toBe("+");
    expect(answered.classList.contains("atl-has-branch-port")).toBe(true);
    expect(draft.querySelector(".atl-branch-port")).toBeNull();
    answered.dispatchEvent(new Event("pointerenter")); port.focus();
    expect(createConversation).not.toHaveBeenCalled();
    port.click(); await flush();
    expect(createConversation).toHaveBeenCalledExactlyOnceWith("A", { kind: "review" });
    expect(reply).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector<HTMLElement>(".atl-graph-details .atl-rail-card")?.dataset["atlId"]).toBe("D");
  });
  it("derives from the primary review shown on a node even when old dialogue exists", async () => {
    const { view, createConversation } = fixture([{ ...root, dialogue: [{ id: "turn-later", role: "agent", text: "Later dialogue answer", at: "2026-10-20" }] }, child]);
    await view.onOpen();
    const node = view.contentEl.querySelector<HTMLElement>('.atl-graph-node[data-annotation-id="A"]')!;
    expect(node.querySelector(".atl-graph-node-reply")?.textContent).toBe("Original reply");
    node.querySelector<HTMLButtonElement>(".atl-branch-port")!.click(); await flush();
    expect(createConversation).toHaveBeenCalledExactlyOnceWith("A", { kind: "review" });
  });
  it("falls back to the latest visible Tutor dialogue reply and keeps the port until saving completes", async () => {
    const answered = { ...root, review: undefined, dialogue: [{ id: "turn-old", role: "agent" as const, text: "Earlier answer", at: "2026-10-19" },
      { id: "turn-question", role: "user" as const, text: "Follow-up", at: "2026-10-20" },
      { id: "turn-latest", role: "agent" as const, text: "Latest answer", at: "2026-10-20" }] };
    const { view, createConversation } = fixture([answered, child]); await view.onOpen();
    const original = createConversation.getMockImplementation()!;
    let release: (() => void) | undefined;
    createConversation.mockImplementation(async (id: string) => {
      await new Promise<void>(resolve => { release = resolve; });
      return original(id);
    });
    const port = view.contentEl.querySelector<HTMLButtonElement>('.atl-graph-node[data-annotation-id="A"] .atl-branch-port')!;
    expect(port.parentElement!.querySelector(".atl-graph-node-reply")?.textContent).toBe("Latest answer");
    port.click(); port.click(); view.refresh();
    expect(createConversation).toHaveBeenCalledExactlyOnceWith("A", { kind: "dialogue", turnId: "turn-latest", turnIndex: 2 });
    expect(port.disabled).toBe(true);
    expect(view.contentEl.contains(port)).toBe(true);
    release!(); await flush();
    expect(view.contentEl.querySelector<HTMLElement>(".atl-graph-details .atl-rail-card")?.dataset["atlId"]).toBe("D");
  });
  it("does not offer creation on archived nodes or missing-parent placeholders", async () => {
    const { view } = fixture([{ ...root, status: "archived" }, { ...child, branch: { ...child.branch!, parentAnnotationId: "missing" } }]);
    await view.onOpen();
    expect(view.contentEl.querySelector(".atl-graph-node .atl-branch-port")).toBeNull();
    expect(view.contentEl.querySelector(".atl-graph-node.is-placeholder")).not.toBeNull();
  });
  it("edits and answers a graph card, then selects an explicitly created child", async () => {
    const { view, saveDraft, reply, createConversation, locateSource } = fixture();
    await view.onOpen(); view.setFocus("B");
    const editor = view.contentEl.querySelector<HTMLTextAreaElement>(".atl-graph-details .atl-rail-edit")!;
    editor.focus(); editor.value = "Explain the relation"; editor.dispatchEvent(new Event("input"));
    view.contentEl.querySelector<HTMLButtonElement>(".atl-branch-send")!.click(); await flush();
    expect(saveDraft).toHaveBeenCalledWith("B", "Explain the relation");
    expect(reply).toHaveBeenCalledWith("B", "Explain the relation", expect.any(Function));
    expect(view.contentEl.querySelector(".atl-graph-details .atl-rail-review")?.textContent).toBe("New Tutor reply");
    view.contentEl.querySelector<HTMLButtonElement>(".atl-graph-detail-actions button")!.click();
    expect(locateSource).toHaveBeenCalledWith("B");
    view.contentEl.querySelector<HTMLButtonElement>(".atl-graph-details .atl-branch-create")!.click(); await flush();
    expect(createConversation).toHaveBeenCalledWith("B", { kind: "review" });
    expect(view.contentEl.querySelector<HTMLElement>(".atl-graph-details .atl-rail-card")!.dataset["atlId"]).toBe("D");
    expect(view.contentEl.querySelector<HTMLTextAreaElement>(".atl-graph-details .atl-rail-edit")!.readOnly).toBe(false);
  });
  it("preserves a focused draft on unrelated graph refresh and supports zoom", async () => {
    const { view } = fixture(); await view.onOpen(); view.setFocus("B");
    const editor = view.contentEl.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    editor.focus(); editor.value = "Unsaved local input";
    view.refresh();
    expect(view.contentEl.querySelector(".atl-rail-edit")).toBe(editor);
    expect(editor.value).toBe("Unsaved local input");
    const zoomIn = [...view.contentEl.querySelectorAll<HTMLButtonElement>(".atl-graph-toolbar button")].find(button => button.textContent === "＋")!;
    zoomIn.click();
    expect(view.contentEl.querySelector<HTMLElement>(".atl-graph-scene")!.style.transform).not.toContain("scale(1)");
  });
});
