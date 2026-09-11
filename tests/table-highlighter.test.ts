// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableHighlighter } from "../src/table-highlighter.js";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe("table widget overlay", () => {
  it("matches the visible editor, not Obsidian's hidden duplicate cell preview", () => {
    const host = document.createElement("div"), content = document.createElement("div");
    host.append(content); document.body.append(host);
    content.innerHTML = '<table><tr><td><div style="display:none">same quote</div><div class="cm-content">same quote</div></td></tr></table>';
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function(this: Range) {
      return (this.startContainer.parentElement?.style.display === "none" ? [] : [new DOMRect(1, 1, 50, 20)]) as unknown as DOMRectList;
    });
    const hl = new TableHighlighter(host, content, () => {}, () => {});
    hl.setMarks([{ id: "ANN-1", blockId: "logical", selectedText: "same quote" }], "background", true); hl.render();
    expect(hl.overlay.children.length).toBe(1);
    hl.destroy();
  });
  it("does not mutate the widget, survives hydration, and preserves drag selection", () => {
    const host = document.createElement("div"), content = document.createElement("div");
    host.append(content); document.body.append(host);
    content.innerHTML = "<table><tr><td>alpha <b>beta</b></td><td>gamma</td></tr></table>";
    const original = content.innerHTML;
    const rect = new DOMRect(20, 30, 60, 18);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
    const toggle = vi.fn();
    const hl = new TableHighlighter(host, content, toggle, () => {});
    hl.setMarks([{ id: "ANN-1", blockId: "logical", selectedText: "alpha beta" }], "background", true); hl.render();
    expect(content.innerHTML).toBe(original);
    expect(hl.overlay.children.length).toBe(2);
    const strip = hl.overlay.firstElementChild!;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(rect);
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 25, clientY: 35 });
    content.querySelector("td")!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 70, clientY: 35 }));
    expect(toggle).not.toHaveBeenCalled();
    content.querySelector("td")!.dispatchEvent(down);
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 25, clientY: 35 }));
    expect(toggle).toHaveBeenCalledWith("ANN-1");
    content.innerHTML = original; hl.render();
    expect(hl.overlay.children.length).toBe(2);
    hl.setMarks([{ id: "ANN-2", blockId: "logical", selectedText: "beta gamma" }], "background", true); hl.render();
    expect(hl.overlay.children.length).toBe(0); // no false cross-cell quote
    hl.destroy(); expect(host.querySelector(".atl-table-hl")).toBeNull();
  });
});
