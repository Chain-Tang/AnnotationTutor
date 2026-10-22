// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownView } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
vi.mock("obsidian", () => ({ Notice: class {}, addIcon: vi.fn(), setIcon: vi.fn(), setTooltip: vi.fn() }));
import { ReadingRail } from "../src/reading-rail.js";
import { PdfRail } from "../src/pdf-rail.js";
import { marginRailExtension } from "../src/margin-rail.js";
import { annotationDecorations, markerConfigField, marginExpandedField, setMarkerClickHandler, toggleMarginCard } from "../src/decorations.js";
import { setMarginCardHandlers } from "../src/margin-card.js";
import type { AnchorMark } from "../src/decorations-plan.js";

const root: AnchorMark = { id: "rail-A", blockId: "block", selectedText: "Original text", note: "A question", review: "A reply" };
function child(id: string, parentId: string): AnchorMark {
  return { ...root, id, note: `${id} question`, review: `${id} reply`, branch: {
    rootAnnotationId: root.id, parentAnnotationId: parentId, sourceVersion: "v1",
    parentReply: { id: "review", kind: "review", version: "v1", text: "Parent reply" }
  }, request: { id: `request-${id}`, question: `${id} question`, status: "completed", updatedAt: "2026-10-20" } };
}
const marks = [root, child("rail-B", root.id), child("rail-C", root.id), child("rail-D", "rail-B")];
let graphMarks: AnchorMark[] = marks;
const attached: Array<{ detach(): void }> = [];
const skin = { id: "flat", quiet: false, tilt: null } as const;

beforeEach(() => {
  graphMarks = marks;
  Object.defineProperty(HTMLElement.prototype, "createEl", { configurable: true, value(tag: string, options: { cls?: string } = {}) {
    const element = document.createElement(tag); element.className = options.cls ?? ""; this.append(element); return element;
  } });
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([new DOMRect(100, 100, 200, 20)] as unknown as DOMRectList);
  setMarginCardHandlers({ save: vi.fn(), ask: vi.fn(), discuss: vi.fn(), reply: vi.fn(async () => ({ ok: true })),
    render: (element, markdown) => { element.textContent = markdown; }, saveCell: vi.fn(), remove: vi.fn(), settings: vi.fn(),
    graphCards: () => graphMarks, createConversation: vi.fn(async () => undefined),
    continueDialogue: vi.fn(async () => ({ ok: true })), saveDialogueDraft: vi.fn(async () => {}) });
});
afterEach(() => {
  for (const rail of attached.splice(0)) rail.detach();
  setMarginCardHandlers(null); setMarkerClickHandler(null); document.body.replaceChildren(); vi.restoreAllMocks();
});

function fixture(kind: "reading" | "pdf") {
  const container = document.createElement("div");
  container.innerHTML = kind === "reading"
    ? '<div class="reading-host"><div class="markdown-preview-view"><span data-atl-id="rail-A">Original text</span></div></div>'
    : '<div class="pdf-container"><div class="pdf-viewer-container"><span class="atl-pdf-highlight" data-atl-id="rail-A">Original text</span></div></div>';
  document.body.append(container);
  const host = container.firstElementChild as HTMLElement;
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
  Object.defineProperty(host, "clientWidth", { configurable: true, value: 1000 });
  const source = container.querySelector<HTMLElement>("[data-atl-id]")!;
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 20));
  const rail = kind === "reading" ? new ReadingRail() : new PdfRail();
  if (rail instanceof ReadingRail) rail.attach({ contentEl: container } as unknown as MarkdownView);
  else rail.attach(container);
  attached.push(rail);
  rail.setMarks([root], skin, false, true);
  rail.toggle(root.id);
  const flush = (): void => (rail as unknown as { render(): void }).render();
  flush();
  const visibleCards = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(".atl-rail-card")].filter(card => !card.hidden);
  return { container, host, source, rail, flush, visibleCards };
}

describe.each(["reading", "pdf"] as const)("inline workflow in the %s source rail", kind => {
  it("keeps descendants beside the source while the header toggles only local conversation", () => {
    const { container, source, flush, visibleCards } = fixture(kind);
    expect(visibleCards().map(card => card.dataset["atlId"]).sort()).toEqual(marks.map(mark=>mark.id).sort());
    const card = visibleCards()[0]!;
    const toggle = card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    toggle.click(); flush();
    expect(visibleCards().map(card => card.dataset["atlId"]).sort()).toEqual(marks.map(mark => mark.id).sort());
    expect(container.querySelector(".atl-branches, .atl-branch-provenance, .atl-graph-details")).toBeNull();
    expect(source.textContent).toBe("Original text");
    expect(container.querySelectorAll('[data-atl-id="rail-A"]:not(.atl-rail-card):not(path)')).not.toHaveLength(0);
    toggle.click(); flush();
    expect(visibleCards().map(element => element.dataset["atlId"]).sort()).toEqual(marks.map(mark=>mark.id).sort());
  });

  it("removes descendant cards and connections when the source card closes", () => {
    const { container, rail, flush, visibleCards } = fixture(kind);
    visibleCards()[0]!.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click(); flush();
    expect(visibleCards()).toHaveLength(4);
    rail.toggle(root.id); flush();
    expect(visibleCards()).toHaveLength(0);
    expect(container.querySelector(".atl-rail-svg path")).toBeNull();
    rail.detach();
    expect(container.querySelector(".atl-rail, .atl-rail-svg")).toBeNull();
  });

  it("restores committed root dialogue and its draft after reopening without reconfiguring source anchors", () => {
    const { container, rail, flush, source, visibleCards } = fixture(kind);
    const old = visibleCards().find(card => card.dataset["atlId"] === root.id)!;
    old.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    rail.toggle(root.id); flush();
    graphMarks = [{ ...root, blockId: "index-block-does-not-reanchor-source", selectedText: "Index summary",
      dialogue: [{ id: "depth-u", role: "user", text: "Go deeper", at: "2026-10-20" }, { id: "depth-a", role: "agent", text: "Committed depth answer", at: "2026-10-20" }],
      dialogueRequest: { id: "draft-depth", status: "draft", question: "Next unsent question", updatedAt: "2026-10-20" }
    }, ...marks.slice(1)];
    rail.toggle(root.id); flush();
    const reopened = visibleCards().find(card => card.dataset["atlId"] === root.id)!;
    expect(reopened).not.toBe(old);
    expect(reopened.querySelector(".atl-rail-thread")!.textContent).toContain("Committed depth answer");
    expect(reopened.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!.value).toBe("Next unsent question");
    expect(reopened.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(false);
    expect(source.textContent).toBe("Original text");
    expect(source.dataset["atlId"]).toBe(root.id);
    expect(container.querySelectorAll(kind === "reading" ? '.markdown-preview-view [data-atl-id]' : '.pdf-viewer-container [data-atl-id]')).toHaveLength(1);
    expect(visibleCards()).toHaveLength(4);
  });

  it("preserves focused ongoing input while the committed graph snapshot advances", () => {
    const { flush, visibleCards } = fixture(kind);
    const card = visibleCards().find(card => card.dataset["atlId"] === root.id)!;
    card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const input = card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    input.focus(); input.value = "Local question still being typed";
    graphMarks = [{ ...root, dialogueRequest: { id: "draft-new", status: "draft", question: "Earlier saved content", updatedAt: "2026-10-20" } }, ...marks.slice(1)];
    flush();
    expect(visibleCards().find(element => element.dataset["atlId"] === root.id)).toBe(card);
    expect(input.value).toBe("Local question still being typed");
    expect(document.activeElement).toBe(input);
  });
});


describe("inline workflow in the original CodeMirror source", () => {
  it("reopens the current committed root thread and preserves live input without changing editor decorations", () => {
    const container = document.createElement("div"); document.body.append(container);
    const source = "Original text ^block";
    const state = EditorState.create({ doc: source, extensions: [
      annotationDecorations,
      markerConfigField.init(() => ({ marks: [root], style: "dotted-underline", showMarker: true,
        marginComments: true, skin, marginHideLink: false, inlineReview: true })),
      marginExpandedField.init(() => new Set([root.id])), marginRailExtension
    ] });
    const view = new EditorView({ state, parent: container });
    attached.push({ detach: () => view.destroy() });
    vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 100, right: 300, top: 100, bottom: 120 });
    const rail = view.plugin(marginRailExtension) as unknown as { render(): void };
    const flush = (): void => rail.render();
    const rootCard = (): HTMLElement => container.querySelector<HTMLElement>(`.atl-rail-card[data-atl-id="${root.id}"]`)!;
    flush();
    const original = rootCard();
    original.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const originalDecorations = view.contentDOM.innerHTML;
    const configuredMarks = view.state.field(markerConfigField).marks;
    view.dispatch({ effects: toggleMarginCard.of(root.id) }); flush();
    graphMarks = [{ ...root, blockId: "different-index-block", selectedText: "Index-only summary",
      dialogue: [{ id: "depth-u", role: "user", text: "Deeper question", at: "2026-10-20" }, { id: "depth-a", role: "agent", text: "Updated durable answer", at: "2026-10-20" }],
      dialogueRequest: { id: "draft", status: "draft", question: "Saved unfinished continuation", updatedAt: "2026-10-20" }
    }, ...marks.slice(1)];
    view.dispatch({ effects: toggleMarginCard.of(root.id) }); flush();
    const reopened = rootCard();
    expect(reopened).not.toBe(original);
    expect(reopened.querySelector(".atl-rail-thread")!.textContent).toContain("Updated durable answer");
    const input = reopened.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    expect(input.value).toBe("Saved unfinished continuation");
    expect(reopened.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(false);
    input.focus(); input.value = "Current local reasoning";
    graphMarks = [{ ...graphMarks[0]!, dialogueRequest: { id: "draft-next", status: "draft", question: "Previous saved value", updatedAt: "2026-10-20" } }, ...marks.slice(1)];
    flush();
    expect(rootCard()).toBe(reopened);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Current local reasoning");
    expect(view.state.doc.toString()).toBe(source);
    expect(view.state.field(markerConfigField).marks).toBe(configuredMarks);
    expect(view.contentDOM.innerHTML).toBe(originalDecorations);
  });

  it("keeps branch cards in the editor overlay while the header opens only card-local conversation", () => {
    const container = document.createElement("div"); document.body.append(container);
    const source = "Original text ^block";
    const state = EditorState.create({ doc: source, extensions: [
      annotationDecorations,
      markerConfigField.init(() => ({ marks: [root], style: "dotted-underline", showMarker: true,
        marginComments: true, skin, marginHideLink: false, inlineReview: true })),
      marginExpandedField.init(() => new Set([root.id])), marginRailExtension
    ] });
    const view = new EditorView({ state, parent: container });
    attached.push({ detach: () => view.destroy() });
    vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 100, right: 300, top: 100, bottom: 120 });
    const rail = view.plugin(marginRailExtension) as unknown as { render(): void };
    const flush = (): void => rail.render();
    const visible = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(".atl-rail-card")].filter(card => !card.hidden);
    flush(); expect(visible()).toHaveLength(4);
    const markerClick = vi.fn(); setMarkerClickHandler(markerClick);
    visible()[0]!.querySelector(".atl-rail-review")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(markerClick).not.toHaveBeenCalled();
    const toggle = visible()[0]!.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    toggle.click(); flush();
    expect(visible().map(card => card.dataset["atlId"]).sort()).toEqual(marks.map(mark => mark.id).sort());
    expect(view.state.doc.toString()).toBe(source);
    expect(container.querySelector(".atl-branches, .atl-branch-provenance")).toBeNull();
    view.dispatch({ effects: toggleMarginCard.of(root.id) }); flush();
    expect(visible()).toHaveLength(0);
    expect(container.querySelector(".atl-rail-svg path")).toBeNull();
  });
});
