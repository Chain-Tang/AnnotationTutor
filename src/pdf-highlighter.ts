// PDF highlights in a page overlay outside Obsidian's translucent text layer.
// PDF bytes and PDF.js text nodes stay untouched; the same rectangles drive
// both painting and click hit-testing through the viewer's native layers.

import type { HighlightStyle } from "./settings.js";
import { normalizePdfSelection, parsePdfPageNumber } from "./pdf-annotation.js";
import { styleClass } from "./decorations-plan.js";

export type PdfHighlightMark = {
  id: string;
  selectedText: string;
  page?: number;
};

export type SegmentRange = { segment: number; from: number; to: number };

type CharPoint = { segment: number; offset: number } | null;

/**
 * Locate the Nth whitespace-normalized query across PDF.js text-node segments.
 * Returned offsets refer to the original segment strings and can be converted
 * directly to DOM Ranges. A boundary-space retry handles PDFs that split words
 * into positioned spans without storing a literal space between them.
 */
export function locatePdfText(
  segments: readonly string[],
  query: string,
  occurrence = 0
): SegmentRange[] | null {
  const wanted = normalizePdfSelection(query);
  if (!wanted) return null;
  for (const boundarySpaces of [false, true]) {
    const document = normalizedSegments(segments, boundarySpaces);
    let from = 0;
    let found = -1;
    for (let index = 0; index <= occurrence; index += 1) {
      found = document.text.indexOf(wanted, from);
      if (found < 0) break;
      from = found + Math.max(1, wanted.length);
    }
    if (found < 0) continue;
    const ranges = rangesForMatch(document.map, found, found + wanted.length);
    if (ranges.length > 0) return ranges;
  }
  return null;
}

function normalizedSegments(
  segments: readonly string[],
  boundarySpaces: boolean
): { text: string; map: CharPoint[] } {
  let text = "";
  const map: CharPoint[] = [];
  let pendingSpace = false;
  let previousHadText = false;
  for (const [segment, raw] of segments.entries()) {
    if (boundarySpaces && previousHadText && raw && !/^\s/.test(raw)) {
      pendingSpace = true;
    }
    let segmentHadText = false;
    for (let offset = 0; offset < raw.length; offset += 1) {
      const char = raw[offset] ?? "";
      if (/\s/.test(char)) {
        pendingSpace = text.length > 0;
        continue;
      }
      if (pendingSpace && text && !text.endsWith(" ")) {
        text += " ";
        map.push(null);
      }
      pendingSpace = false;
      text += char;
      map.push({ segment, offset });
      segmentHadText = true;
    }
    previousHadText ||= segmentHadText;
  }
  return { text, map };
}

function rangesForMatch(map: CharPoint[], from: number, to: number): SegmentRange[] {
  const ranges = new Map<number, SegmentRange>();
  for (let index = from; index < to; index += 1) {
    const point = map[index];
    if (!point) continue;
    const range = ranges.get(point.segment);
    if (range) {
      range.from = Math.min(range.from, point.offset);
      range.to = Math.max(range.to, point.offset + 1);
    } else {
      ranges.set(point.segment, {
        segment: point.segment,
        from: point.offset,
        to: point.offset + 1
      });
    }
  }
  return [...ranges.values()].sort((left, right) => left.segment - right.segment);
}

export class PdfHighlighter {
  private container: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private marks: PdfHighlightMark[] = [];
  private style: HighlightStyle = "dotted-underline";
  private onActivate: ((id: string, anchor: HTMLElement) => void) | null = null;
  private timer: number | null = null;
  private resize: ResizeObserver | null = null;
  private showMarker = true;
  private readonly overlays = new Set<HTMLElement>();
  private press: { x: number; y: number } | null = null;
  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.press = { x: event.clientX, y: event.clientY };
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const press = this.press;
    this.press = null;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return;
    const highlight = this.hitTest(event);
    if (!highlight || !this.container?.contains(highlight)) return;
    const id = highlight.dataset["atlId"];
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.onActivate?.(id, highlight);
  };

  /** PDF.js may deliver the click to canvas, a text span, or a native link
   * annotation above it. Hit-test the same rectangles used to paint the mark. */
  private hitTest(event: MouseEvent): HTMLElement | null {
    const container = this.container;
    const ctor = container?.ownerDocument.defaultView?.HTMLElement;
    if (!container || !ctor) return null;
    const target = event.composedPath().find((node): node is HTMLElement => node instanceof ctor);
    if (!target || target.closest(".atl-rail-card, .pdf-toolbar, button, input, textarea")) return null;
    const direct = target.closest<HTMLElement>(".atl-pdf-highlight");
    if (direct && container.contains(direct)) return direct;
    const page = target.closest(".page, [data-page-number]");
    if (!page || !container.contains(page)) return null;
    for (const strip of page.querySelectorAll<HTMLElement>(".atl-pdf-highlight")) {
      const rect = strip.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && event.clientX >= rect.left &&
        event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return strip;
    }
    return null;
  }

  public attach(
    container: HTMLElement,
    onActivate: (id: string, anchor: HTMLElement) => void
  ): void {
    if (this.container === container) {
      this.onActivate = onActivate;
      return;
    }
    this.detach();
    this.container = container;
    this.onActivate = onActivate;
    container.addEventListener("click", this.handleClick, true);
    container.addEventListener("pointerdown", this.handlePointerDown, true);
    const MutationObserverCtor = container.ownerDocument.defaultView?.MutationObserver;
    if (MutationObserverCtor) {
      this.observer = new MutationObserverCtor((records) => {
        // Ignore changes made by our own geometry layer (including hover).
        if (records.some(record => !(record.target as Element).closest?.(".atl-pdf-highlights"))) this.schedule();
      });
      this.observe();
    }
    const Resize = container.ownerDocument.defaultView?.ResizeObserver;
    if (Resize) {
      this.resize = new Resize(() => this.schedule(0));
      this.resize.observe(container);
    }
    this.schedule(0);
  }

  public setMarks(marks: PdfHighlightMark[], style: HighlightStyle, showMarker = true): void {
    if (this.style === style && this.showMarker === showMarker && JSON.stringify(this.marks) === JSON.stringify(marks)) return;
    this.marks = marks;
    this.style = style;
    this.showMarker = showMarker;
    // Display settings should take effect immediately, not after the next PDF
    // page load or selection. No PDF.js text/selection nodes are changed.
    this.render();
  }

  public detach(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.resize?.disconnect();
    this.resize = null;
    if (this.container) {
      this.container.removeEventListener("click", this.handleClick, true);
      this.container.removeEventListener("pointerdown", this.handlePointerDown, true);
      this.clearOverlays();
    }
    this.container = null;
    this.onActivate = null;
    this.press = null;
  }

  private schedule(delay = 60): void {
    if (!this.container || this.timer !== null) return;
    const win = this.container.ownerDocument.defaultView ?? window;
    this.timer = win.setTimeout(() => {
      this.timer = null;
      this.render();
    }, delay);
  }

  private render(): void {
    const container = this.container;
    if (!container) return;
    this.observer?.disconnect();
    this.clearOverlays();

    if (this.style === "none" && !this.showMarker) {
      this.observe();
      return;
    }

    const occurrence = new Map<string, number>();
    const layers = [...container.querySelectorAll<HTMLElement>(".textLayer")];
    for (const mark of this.marks) {
      const candidateLayers = mark.page
        ? layers.filter((layer) => this.pageForLayer(layer) === mark.page)
        : layers;
      for (const layer of candidateLayers) {
        const nodes = this.textNodes(layer);
        const key = `${mark.page ?? "any"}\u0000${mark.selectedText}`;
        const nth = occurrence.get(key) ?? 0;
        const ranges = locatePdfText(
          nodes.map((node) => node.data),
          mark.selectedText,
          nth
        );
        if (!ranges) continue;
        occurrence.set(key, nth + 1);
        this.paintRanges(layer, nodes, ranges, mark.id);
        break;
      }
    }
    this.observe();
  }

  private observe(): void {
    if (!this.observer || !this.container) return;
    // Watch the stable scroller, including replacement of .pdfViewer itself.
    // TutorLite cards are siblings outside it and cannot trigger repaint loops.
    const root =
      this.container.querySelector<HTMLElement>(".pdf-viewer-container") ?? this.container;
    this.observer.observe(root, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-page-number"],
      subtree: true
    });
  }

  private pageForLayer(layer: HTMLElement): number | undefined {
    const page = layer.closest<HTMLElement>("[data-page-number]");
    return parsePdfPageNumber(page?.dataset["pageNumber"]);
  }

  private textNodes(root: HTMLElement): Text[] {
    const result: Text[] = [];
    const view = root.ownerDocument.defaultView;
    const walker = root.ownerDocument.createTreeWalker(
      root,
      view?.NodeFilter.SHOW_TEXT ?? 4
    );
    let node = walker.nextNode();
    while (node) {
      if (node instanceof (view?.Text ?? Text) && node.data) result.push(node as Text);
      node = walker.nextNode();
    }
    return result;
  }

  private paintRanges(layer: HTMLElement, nodes: Text[], ranges: SegmentRange[], id: string): void {
    const page = layer.closest<HTMLElement>(".page, [data-page-number]");
    if (!page) return;
    const doc = page.ownerDocument;
    const origin = page.getBoundingClientRect();
    const scaleX = page.offsetWidth ? origin.width / page.offsetWidth : 1;
    const scaleY = page.offsetHeight ? origin.height / page.offsetHeight : 1;
    let overlay = page.querySelector<HTMLElement>(":scope > .atl-pdf-highlights");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.className = "atl-pdf-highlights";
      overlay.setAttribute("aria-hidden", "true");
      page.appendChild(overlay);
      this.overlays.add(overlay);
    }
    const rects: DOMRect[] = [];
    for (const segmentRange of ranges) {
      const node = nodes[segmentRange.segment];
      if (!node || segmentRange.from >= segmentRange.to) continue;
      const range = node.ownerDocument.createRange();
      range.setStart(node, segmentRange.from);
      range.setEnd(node, segmentRange.to);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) rects.push(rect);
      }
    }
    const visibleRects = this.style === "none" ? rects.slice(-1) : rects;
    for (const rect of visibleRects) {
      const highlight = doc.createElement("span");
      highlight.className = `atl-pdf-highlight atl-pdf-${this.style} ${styleClass(this.style) ?? "atl-pdf-marker"}`;
      highlight.dataset["atlId"] = id;
      // Page coordinates (not scroll coordinates), corrected for CSS zoom and
      // the page border so the mark follows scroll/zoom without drift.
      const marker = this.style === "none";
      Object.assign(highlight.style, {
        left: `${((marker ? rect.right : rect.left) - origin.left) / (scaleX || 1) - page.clientLeft}px`,
        top: `${(rect.top - origin.top) / (scaleY || 1) - page.clientTop}px`,
        width: `${marker ? 14 : rect.width / (scaleX || 1)}px`,
        height: `${rect.height / (scaleY || 1)}px`
      });
      if (marker) { highlight.textContent = "●"; highlight.style.pointerEvents = "auto"; }
      overlay.appendChild(highlight);
    }
  }

  private clearOverlays(): void {
    for (const overlay of this.overlays) overlay.remove();
    this.overlays.clear();
  }
}
