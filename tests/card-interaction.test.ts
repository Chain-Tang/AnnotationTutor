// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Notice: class {}, setIcon: () => {}, setTooltip: () => {} }));
import { PdfRail } from "../src/pdf-rail.js";
import { setCardGeomStore, setMarginCardHandlers } from "../src/margin-card.js";
import { enableCardDrag } from "../src/card-drag.js";

const box = (x: number, y: number, width = 800, height = 600) => new DOMRect(x, y, width, height);
const mark = { id: "ANN-test", blockId: "pdf-test", selectedText: "quoted", note: "saved note" };
const skin = { id: "flat", quiet: false, tilt: null } as const;
const event = (type: string, x: number, y: number, id = 1) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: id, clientX: x, clientY: y });

beforeEach(() => {
  // Obsidian's small DOM helper; the production card builder remains real.
  Object.defineProperty(HTMLElement.prototype, "createEl", { configurable: true, value(tag: string, options: { cls?: string }) {
    const el = document.createElement(tag); el.className = options.cls ?? ""; this.append(el); return el;
  }});
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function(this: HTMLElement) { return parseFloat(this.style.left) || 0; });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function(this: HTMLElement) { return parseFloat(this.style.top) || 0; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(224);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
});
afterEach(() => { setCardGeomStore(null); setMarginCardHandlers(null); document.body.replaceChildren(); vi.restoreAllMocks(); });

function pdfFixture() {
  const root = document.createElement("div");
  root.innerHTML = '<div class="pdf-container"><div class="pdf-viewer-container"><mark class="atl-pdf-highlight" data-atl-id="ANN-test">quoted</mark></div></div>';
  document.body.append(root);
  const host = root.firstElementChild as HTMLElement;
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(box(0, 0));
  vi.spyOn(host, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(root.querySelector("mark")!, "getBoundingClientRect").mockReturnValue(box(100, 100, 60, 20));
  const rail = new PdfRail(); rail.attach(root); rail.setMarks([mark], skin, false, true); rail.toggle(mark.id);
  return { root, rail, render: () => (rail as unknown as { render(): void }).render(), card: root.querySelector<HTMLElement>(".atl-rail-card")! };
}

describe("PDF card interaction lifecycle", () => {
  it("anchors to the clicked visible segment when the last line is off screen", () => {
    const { root, rail } = pdfFixture();
    rail.toggle(mark.id); // close the initial card
    const first = root.querySelector<HTMLElement>(".atl-pdf-highlight")!;
    const last = first.cloneNode(true) as HTMLElement;
    first.parentElement!.append(last);
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue(box(100, 1000, 60, 20));
    rail.toggle(mark.id, first);
    expect(root.querySelector<HTMLElement>(".atl-rail-card")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".atl-rail-card")!.dataset["anchorMidY"]).toBe("110");
    rail.detach();
  });
  it("keeps the actual dragged card through page/mark refresh and persists the final offset", () => {
    const save = vi.fn(); setCardGeomStore({ get: () => undefined, set: save });
    const { rail, card, root, render } = pdfFixture();
    const startLeft = card.offsetLeft, startTop = card.offsetTop;
    card.querySelector(".atl-rail-grip")!.dispatchEvent(event("pointerdown", 100, 100));
    document.dispatchEvent(event("pointermove", 160, 140));
    rail.setMarks([{ ...mark }], skin, false, true); render();
    expect(root.querySelector(".atl-rail-card")).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(card.offsetLeft).toBe(startLeft + 60);
    expect(card.offsetTop).toBe(startTop + 40);
    document.dispatchEvent(event("pointermove", 180, 150));
    document.dispatchEvent(event("pointerup", 180, 150)); render();
    expect(card.offsetLeft).toBe(startLeft + 80);
    expect(card.offsetTop).toBe(startTop + 50);
    expect(save).toHaveBeenLastCalledWith(mark.id, expect.objectContaining({ dx: 80, dy: 50 }));
    rail.detach();
  });

  it("retains focused unsaved note and dialogue drafts on refresh", () => {
    const { rail, card, render } = pdfFixture();
    const editor = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    editor.focus(); editor.value = "unsaved draft";
    rail.setMarks([{ ...mark, review: "new review" }], skin, false, true); render();
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("unsaved draft"); expect(card.isConnected).toBe(true);
    rail.detach();
  });

  it("does not start dragging from action buttons or right click; cleans document listeners on detach", () => {
    const { rail, card } = pdfFixture();
    card.querySelector("button")!.dispatchEvent(event("pointerdown", 0, 0));
    expect(card.dataset["dragging"]).toBeUndefined();
    card.querySelector(".atl-rail-grip")!.dispatchEvent(event("pointerdown", 0, 0));
    rail.detach();
    const left = card.style.left;
    document.dispatchEvent(event("pointermove", 100, 100));
    expect(card.style.left).toBe(left);
    expect(card.dataset["dragging"]).toBeUndefined();
  });

  it("accounts for scaled parent coordinates and ignores other pointers", () => {
    const parent = document.createElement("div"), card = document.createElement("div"), head = document.createElement("div");
    document.body.append(parent); parent.append(card); card.append(head);
    Object.defineProperty(card, "offsetParent", { value: parent });
    vi.spyOn(parent, "getBoundingClientRect").mockReturnValue(box(0, 0, 448, 240));
    const geom = { dx: 0, dy: 0 }, end = vi.fn();
    const stop = enableCardDrag(card, head, geom, () => {}, end);
    head.dispatchEvent(event("pointerdown", 0, 0));
    document.dispatchEvent(event("pointermove", 200, 100, 2));
    expect(geom.dx).toBe(0);
    document.dispatchEvent(event("pointermove", 200, 100));
    expect(geom).toEqual({ dx: 100, dy: 50 });
    document.dispatchEvent(event("pointercancel", 200, 100));
    expect(end).toHaveBeenCalledOnce(); stop();
  });
});
