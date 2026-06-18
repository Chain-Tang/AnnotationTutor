// Word-style margin comments for Obsidian Reading view. The editor rail is a
// CodeMirror ViewPlugin and so cannot run here; this is the parallel controller
// for rendered preview. It overlays the same editable cards and dotted
// connectors (shared via margin-card.ts) on the non-scrolling reading container,
// re-rendering on scroll/reflow so cards track their markers. Cards are hidden
// until a marker is clicked (the plugin calls `toggle`).

import type { MarkdownView } from "obsidian";
import type { AnchorMark } from "./decorations-plan.js";
import {
  buildMarginCard,
  clearChildren,
  drawConnector,
  lastLineRect,
  loadCardGeom,
  placeCards,
  updateConnector,
  SVG_NS,
  type Geom,
  type PlacedCard
} from "./margin-card.js";

export class ReadingRail {
  private host: HTMLElement | null = null; // stable, non-scrolling container
  private scroller: HTMLElement | null = null; // .markdown-preview-view
  private overlay: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private readonly expanded = new Set<string>();
  private readonly geom = new Map<string, Geom>();
  private observers: ResizeObserver[] = [];
  private hostObserver: ResizeObserver | null = null;
  private marks: AnchorMark[] = [];
  private paper = false;
  private hideLink = false;
  private showReview = true;
  private frame = 0;
  private readonly onScroll = (): void => this.schedule();

  /** Attach to a view's reading container. Idempotent for the same container. */
  public attach(view: MarkdownView): void {
    const scroller = view.contentEl.querySelector<HTMLElement>(
      ".markdown-preview-view"
    );
    const host = scroller?.parentElement ?? null;
    if (!scroller || !host) {
      this.detach();
      return;
    }
    if (this.scroller === scroller) return;
    this.detach();

    this.scroller = scroller;
    this.host = host;
    host.classList.add("atl-reading-host");
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("atl-rail-svg");
    this.overlay = document.createElement("div");
    this.overlay.className = "atl-rail atl-rail--reading";
    host.appendChild(this.svg);
    host.appendChild(this.overlay);
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.hostObserver = new ResizeObserver(() => this.schedule());
    this.hostObserver.observe(host);
    this.schedule();
  }

  public detach(): void {
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.host?.classList.remove("atl-reading-host");
    this.hostObserver?.disconnect();
    this.hostObserver = null;
    this.disconnectObservers();
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.overlay?.remove();
    this.svg?.remove();
    this.overlay = null;
    this.svg = null;
    this.scroller = null;
    this.host = null;
    this.expanded.clear();
  }

  public setMarks(
    marks: AnchorMark[],
    paper: boolean,
    hideLink: boolean,
    showReview: boolean
  ): void {
    this.marks = marks;
    this.paper = paper;
    this.hideLink = hideLink;
    this.showReview = showReview;
    const ids = new Set(marks.map((mark) => mark.id));
    for (const id of [...this.expanded]) {
      if (!ids.has(id)) this.expanded.delete(id);
    }
    this.schedule();
  }

  /** Show/hide a single annotation's margin card. */
  public toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.schedule();
  }

  private schedule(): void {
    if (this.frame || !this.host) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const { host, scroller, overlay, svg } = this;
    if (!host || !scroller || !overlay || !svg) return;
    if (!overlay.isConnected) host.appendChild(overlay);
    if (!svg.isConnected) host.appendChild(svg);
    this.disconnectObservers();
    clearChildren(overlay);
    clearChildren(svg);
    if (this.expanded.size === 0) return;

    const hostRect = host.getBoundingClientRect();
    svg.setAttribute("width", `${hostRect.width}`);
    svg.setAttribute("height", `${hostRect.height}`);
    const railWidth = host.clientWidth;

    const byId = new Map(this.marks.map((mark) => [mark.id, mark]));
    const placed: PlacedCard[] = [];
    for (const id of this.expanded) {
      const mark = byId.get(id);
      if (!mark) continue;
      // Prefer the underlined span (so the connector meets the end of the
      // underlined text); fall back to the marker glyph when styling is off.
      const span = scroller.querySelector<HTMLElement>(
        `[data-atl-id="${id}"]:not(.atl-marker)`
      );
      const marker = scroller.querySelector<HTMLElement>(
        `.atl-marker[data-atl-id="${id}"]`
      );
      const anchorEl = span ?? marker;
      if (!anchorEl) continue; // not rendered (collapsed/virtualised section)
      // Anchor to the end of the underline: its last on-screen line when the span
      // wraps across two lines, so the connector meets the very end of the text.
      const rect =
        anchorEl === span ? lastLineRect(anchorEl) : anchorEl.getBoundingClientRect();
      if (!rect) continue;
      if (rect.bottom < hostRect.top || rect.top > hostRect.bottom) continue;
      const anchorRight = anchorEl === span ? rect.right : rect.left;

      const geom = this.geom.get(id) ?? loadCardGeom(id) ?? { dx: 0, dy: 0 };
      this.geom.set(id, geom);
      const { card, observer } = buildMarginCard(mark, {
        paper: this.paper,
        geom,
        showReview: this.showReview,
        onCollapse: () => this.toggle(id),
        onDragMove: (el) =>
          updateConnector(svg, el, host.getBoundingClientRect())
      });
      this.observers.push(observer);
      overlay.appendChild(card);
      placed.push({
        card,
        anchorX: anchorRight - hostRect.left,
        anchorMidY: (rect.top + rect.bottom) / 2 - hostRect.top,
        desiredY: rect.top - hostRect.top
      });
    }

    const hideLink = this.paper && this.hideLink;
    placeCards(placed, railWidth, this.geom, (id, anchorX, anchorMidY) => {
      if (hideLink) return;
      drawConnector(svg, overlay, id, anchorX, anchorMidY, hostRect);
    });
  }

  private disconnectObservers(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
  }
}
