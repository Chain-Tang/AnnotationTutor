// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfHighlighter } from "../src/pdf-highlighter.js";
import { PdfSelectionController } from "../src/pdf-selection.js";

beforeEach(() => {
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([new DOMRect(20, 30, 120, 18)] as unknown as DOMRectList);
});
afterEach(() => { document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
  const root = document.createElement("div");
  root.innerHTML = '<div class="pdf-viewer-container"><div class="pdfViewer"><div data-page-number="2"><div class="textLayer"><span>Quoted PDF text</span></div></div></div></div>';
  document.body.append(root); return root;
}
describe("PDF event routing", () => {
  it("claims a selected-text context menu before the native bubble listener", () => {
    const root = fixture(), span = root.querySelector("span")!;
    const range = document.createRange(); range.selectNodeContents(span);
    document.getSelection()!.addRange(range);
    const context = vi.fn(), native = vi.fn();
    root.querySelector(".pdf-viewer-container")!.addEventListener("contextmenu", native);
    const controller = new PdfSelectionController();
    controller.attach(root, { label: "添加批注", onAdd: () => {}, onContextMenu: context });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    span.dispatchEvent(event);
    expect(context).toHaveBeenCalledWith(event, { text: "Quoted PDF text", page: 2 }, { x: 0, y: 0 });
    expect(event.defaultPrevented).toBe(true); expect(native).not.toHaveBeenCalled();
    controller.detach();
  });
  it("opens on a click, not a selection drag, and keeps unchanged text-layer nodes", () => {
    const root = fixture(), activate = vi.fn();
    const highlighter = new PdfHighlighter(); highlighter.attach(root, activate);
    const marks = [{ id: "ANN-1", selectedText: "Quoted PDF text", page: 2 }];
    highlighter.setMarks(marks, "background");
    (highlighter as unknown as { render(): void }).render();
    const highlight = root.querySelector(".atl-pdf-highlight")!;
    highlight.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    highlight.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 10 }));
    expect(activate).not.toHaveBeenCalled();
    highlight.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    highlight.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    expect(activate).toHaveBeenCalledWith("ANN-1", highlight);
    highlighter.setMarks([...marks], "background");
    expect(root.querySelector(".atl-pdf-highlight")).toBe(highlight);
    highlighter.detach();
    expect(root.querySelector(".atl-pdf-highlight")).toBeNull();
    expect(root.textContent).toBe("Quoted PDF text");
  });

  it("paints outside the translucent text layer and clicks through native PDF layers", () => {
    const root = fixture(), activate = vi.fn();
    const layer = root.querySelector<HTMLElement>(".textLayer")!;
    layer.style.opacity = "0.2";
    const source = layer.innerHTML;
    const selectedNode = layer.querySelector("span")!.firstChild!;
    const range = document.createRange(); range.selectNodeContents(selectedNode);
    document.getSelection()!.addRange(range);
    const highlighter = new PdfHighlighter(); highlighter.attach(root, activate);
    highlighter.setMarks([{ id: "ANN-1", selectedText: "Quoted PDF text", page: 2 }], "background");
    const highlight = root.querySelector<HTMLElement>(".atl-pdf-highlight")!;
    expect(highlight.classList.contains("atl-hl-bg")).toBe(true);
    expect(layer.contains(highlight)).toBe(false);
    expect(layer.innerHTML).toBe(source);
    expect(document.getSelection()!.anchorNode).toBe(selectedNode);
    expect(document.getSelection()!.toString()).toBe("Quoted PDF text");
    vi.spyOn(highlight, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 30, 120, 18));
    const native = document.createElement("div"); native.className = "annotationLayer";
    layer.parentElement!.append(native);
    native.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 80, clientY: 40 }));
    native.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 80, clientY: 40 }));
    expect(activate).toHaveBeenCalledWith("ANN-1", highlight);
    activate.mockClear();
    native.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 150, clientY: 40 }));
    expect(activate).not.toHaveBeenCalled();
    highlighter.detach();
  });

  it("switches styles immediately, with no compulsory background, and honors hide markers", () => {
    const root = fixture(), h = new PdfHighlighter(); h.attach(root, () => {});
    const marks = [{ id: "ANN-1", selectedText: "Quoted PDF text", page: 2 }];
    for (const [style, cls] of [["background", "atl-hl-bg"], ["dotted-underline", "atl-hl-dotted"], ["wavy-underline", "atl-hl-wavy"], ["bold", "atl-hl-bold"]] as const) {
      h.setMarks(marks, style);
      const highlight = root.querySelector(".atl-pdf-highlight")!;
      expect(highlight.classList.contains(cls)).toBe(true);
      expect(highlight.classList.contains("atl-hl-bg")).toBe(style === "background");
      expect(root.querySelectorAll(".atl-pdf-highlights")).toHaveLength(1);
    }
    h.setMarks(marks, "none", false);
    expect(root.querySelector(".atl-pdf-highlight")).toBeNull();
    h.setMarks(marks, "none", true);
    expect(root.querySelectorAll(".atl-pdf-marker")).toHaveLength(1);
    h.detach();
  });

  it("recomputes geometry after page replacement and never hits a removed annotation", () => {
    const root = fixture(), activate = vi.fn(), h = new PdfHighlighter(); h.attach(root, activate);
    const marks = [{ id: "ANN-1", selectedText: "Quoted PDF text", page: 2 }];
    h.setMarks(marks, "background");
    root.querySelector(".pdfViewer")!.innerHTML = '<div data-page-number="2"><div class="textLayer"><span>Quoted PDF text</span></div></div>';
    (h as unknown as { render(): void }).render();
    expect(root.querySelectorAll(".atl-pdf-highlight")).toHaveLength(1);
    h.setMarks([], "background");
    expect(root.querySelectorAll(".atl-pdf-highlight")).toHaveLength(0);
    h.detach();
  });
  it("converts text rectangles into scaled page coordinates, accounting for borders", () => {
    const root = fixture(), h = new PdfHighlighter();
    const page = root.querySelector<HTMLElement>("[data-page-number]")!;
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 800, 1200));
    vi.spyOn(page, "offsetWidth", "get").mockReturnValue(400);
    vi.spyOn(page, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(page, "clientLeft", "get").mockReturnValue(1);
    vi.spyOn(page, "clientTop", "get").mockReturnValue(1);
    h.attach(root, () => {});
    h.setMarks([{ id: "ANN-1", selectedText: "Quoted PDF text", page: 2 }], "background");
    const mark = root.querySelector<HTMLElement>(".atl-pdf-highlight")!;
    expect(mark.style.left).toBe("4px");
    expect(mark.style.top).toBe("9px");
    expect(mark.style.width).toBe("60px");
    expect(mark.style.height).toBe("9px");
    h.detach();
  });
});
