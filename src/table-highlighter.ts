import { locateInRaw } from "./reading-highlight.js";
import { styleClass, type AnchorMark } from "./decorations-plan.js";
import type { HighlightStyle } from "./settings.js";

/** Range geometry without modifying CodeMirror-owned table widget DOM. */
export function tableTextRects(cell: HTMLElement, text: string): DOMRect[] {
  const doc = cell.ownerDocument;
  const walker = doc.createTreeWalker(cell, 4);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Obsidian keeps a display:none preview beside the active cell editor.
    // Matching that first copy succeeds textually but yields zero rectangles.
    let visible = true;
    for (let parent = node.parentElement; parent && parent !== cell; parent = parent.parentElement) {
      const style = doc.defaultView?.getComputedStyle(parent);
      if (style?.display === "none" || style?.visibility === "hidden" ||
        parent.classList.contains("cm-announced")) { visible = false; break; }
    }
    if (visible) nodes.push(node as Text);
  }
  const match = locateInRaw(nodes.map(n => n.data).join(""), text);
  if (!match) return [];
  const rects: DOMRect[] = [];
  let offset = 0;
  for (const node of nodes) {
    const from = Math.max(0, match.start - offset);
    const to = Math.min(node.length, match.end - offset);
    offset += node.length;
    if (from >= to) continue;
    const range = doc.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
  }
  return rects;
}

export class TableHighlighter {
  public readonly overlay: HTMLElement;
  private observer: MutationObserver;
  private resize: ResizeObserver;
  private frame = 0;
  private fallback = 0;
  private retry = 0;
  private retries = 0;
  private marks: AnchorMark[] = [];
  private style: HighlightStyle = "background";
  private showMarker = true;
  private press: { id: string; x: number; y: number; pointer: number } | null = null;
  private suppressClick = false;
  private clickTimer = 0;

  public constructor(
    private host: HTMLElement,
    private content: HTMLElement,
    private onToggle: (id: string) => void,
    private onLayout: () => void
  ) {
    const doc = host.ownerDocument;
    this.overlay = doc.createElement("div");
    this.overlay.className = "atl-table-hl";
    host.appendChild(this.overlay);
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(content, { childList: true, characterData: true, subtree: true });
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(content);
    content.addEventListener("pointerdown", this.down, true);
    doc.addEventListener("pointerup", this.up, true);
    doc.addEventListener("pointercancel", this.cancel, true);
    doc.addEventListener("click", this.click, true);
    content.addEventListener("scroll", this.schedule, true);
  }

  private down = (event: PointerEvent): void => {
    this.press = null;
    if (event.button !== 0) return;
    for (const strip of this.overlay.children) {
      const rect = strip.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom) {
        this.press = { id: (strip as HTMLElement).dataset["atlId"]!,
          x: event.clientX, y: event.clientY, pointer: event.pointerId };
        return;
      }
    }
  };

  private cancel = (): void => { this.press = null; };
  private click = (event: MouseEvent): void => {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private up = (event: PointerEvent): void => {
    const press = this.press;
    this.press = null;
    if (!press || press.pointer !== event.pointerId ||
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return;
    // Don't cancel mousedown: table text must remain selectable/copyable.
    this.suppressClick = true;
    clearTimeout(this.clickTimer);
    this.clickTimer = window.setTimeout(() => { this.suppressClick = false; }, 0);
    this.onToggle(press.id);
  };

  public setMarks(marks: AnchorMark[], style: HighlightStyle, showMarker: boolean): void {
    this.marks = marks;
    this.style = style;
    this.showMarker = showMarker;
    this.retries = 0;
    this.schedule();
  }

  public schedule = (): void => {
    if (this.frame) return;
    const flush = (): void => {
      cancelAnimationFrame(this.frame);
      clearTimeout(this.fallback);
      this.frame = 0;
      this.fallback = 0;
      this.render();
      this.onLayout();
    };
    this.frame = requestAnimationFrame(flush);
    // Electron can throttle animation frames when focus moves to another pane.
    this.fallback = window.setTimeout(flush, 100);
  };

  public render(): void {
    this.overlay.replaceChildren();
    if (this.style === "none" && !this.showMarker) return;
    const origin = this.host.getBoundingClientRect();
    const sx = this.host.offsetWidth ? origin.width / this.host.offsetWidth : 1;
    const sy = this.host.offsetHeight ? origin.height / this.host.offsetHeight : 1;
    // Match within a cell, never concatenate unrelated cells into a false quote.
    const cells = [...this.content.querySelectorAll<HTMLElement>("td, th")];
    const used = new Map<string, Set<HTMLElement>>();
    let missing = false;
    for (const mark of this.marks) {
      const occupied = used.get(mark.selectedText) ?? new Set<HTMLElement>();
      let found = false;
      for (const cell of cells) {
        if (occupied.has(cell)) continue;
        const rects = tableTextRects(cell, mark.selectedText);
        if (!rects.length) continue;
        occupied.add(cell);
        used.set(mark.selectedText, occupied);
        for (const rect of rects) {
          const strip = this.host.ownerDocument.createElement("span");
          strip.className = `atl-table-hl-strip ${styleClass(this.style) ?? "atl-hl-dotted"}`;
          strip.dataset["atlId"] = mark.id;
          Object.assign(strip.style, {
            left: `${(rect.left - origin.left) / (sx || 1)}px`,
            top: `${(rect.top - origin.top) / (sy || 1)}px`,
            width: `${rect.width / (sx || 1)}px`, height: `${rect.height / (sy || 1)}px`
          });
          this.overlay.appendChild(strip);
        }
        found = true;
        break;
      }
      missing ||= !found;
    }
    // PDF/table widgets hydrate asynchronously. Retry only briefly; no stale
    // rectangles are held at old coordinates and no unbounded polling loop.
    if (missing && cells.length && this.retries++ < 8 && !this.retry) {
      this.retry = window.setTimeout(() => { this.retry = 0; this.schedule(); }, 150);
    }
  }

  public destroy(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.fallback);
    clearTimeout(this.retry);
    clearTimeout(this.clickTimer);
    this.observer.disconnect();
    this.resize.disconnect();
    this.content.removeEventListener("pointerdown", this.down, true);
    this.content.removeEventListener("scroll", this.schedule, true);
    this.host.ownerDocument.removeEventListener("pointerup", this.up, true);
    this.host.ownerDocument.removeEventListener("pointercancel", this.cancel, true);
    this.host.ownerDocument.removeEventListener("click", this.click, true);
    this.overlay.remove();
  }
}
