// Draggable PDF annotation cards. This is the PDF counterpart to ReadingRail:
// it reuses the exact same margin-card builder, handlers, skins, drag/resize
// geometry, dialogue and persistence instead of falling back to NotePopover.

import type { AnchorMark } from "./decorations-plan.js";
import { CardPool } from "./card-pool.js";
import {
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
import type { RailSkin } from "./skins.js";

export class PdfRail {
  private container: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private readonly expanded = new Set<string>();
  private readonly anchorIndex = new Map<string, number>();
  private readonly geom = new Map<string, Geom>();
  private readonly cards = new CardPool();
  private hostObserver: ResizeObserver | null = null;
  private pageObserver: MutationObserver | null = null;
  private marks: AnchorMark[] = [];
  private skin: RailSkin = { id: "flat", quiet: false, tilt: null };
  private hideLink = false;
  private showReview = true;
  private frame = 0;
  private readonly onScroll = (): void => this.schedule();

  public attach(container: HTMLElement): void {
    const host = container.querySelector<HTMLElement>(".pdf-container");
    const scroller = container.querySelector<HTMLElement>(".pdf-viewer-container");
    if (!host || !scroller) {
      this.detach();
      return;
    }
    if (this.container === container && this.host === host && this.scroller === scroller) {
      return;
    }
    this.detach();

    this.container = container;
    this.host = host;
    this.scroller = scroller;
    host.classList.add("atl-pdf-rail-host");
    const doc = host.ownerDocument;
    this.svg = doc.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("atl-rail-svg", "atl-rail-svg--pdf");
    this.overlay = doc.createElement("div");
    this.overlay.className = "atl-rail atl-rail--reading atl-rail--pdf";
    host.append(this.svg, this.overlay);

    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    const win = doc.defaultView;
    if (win?.ResizeObserver) {
      this.hostObserver = new win.ResizeObserver(() => this.schedule());
      this.hostObserver.observe(host);
    }
    if (win?.MutationObserver) {
      this.pageObserver = new win.MutationObserver(() => this.schedule());
      this.pageObserver.observe(scroller, { childList: true, subtree: true });
    }
    this.schedule();
  }

  public detach(): void {
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.host?.classList.remove("atl-pdf-rail-host");
    this.hostObserver?.disconnect();
    this.hostObserver = null;
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    this.cards.clear();
    if (this.frame) {
      const win = this.host?.ownerDocument.defaultView ?? window;
      win.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.overlay?.remove();
    this.svg?.remove();
    this.overlay = null;
    this.svg = null;
    this.scroller = null;
    this.host = null;
    this.container = null;
    this.expanded.clear();
    this.anchorIndex.clear();
  }

  public setMarks(
    marks: AnchorMark[],
    skin: RailSkin,
    hideLink: boolean,
    showReview: boolean
  ): void {
    this.marks = marks;
    this.skin = skin;
    this.hideLink = hideLink;
    this.showReview = showReview;
    const ids = new Set(marks.map((mark) => mark.id));
    for (const id of [...this.expanded]) {
      if (!ids.has(id)) this.expanded.delete(id);
    }
    this.schedule();
  }

  public toggle(id: string, anchor?: HTMLElement): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else {
      this.expanded.add(id);
      if (anchor && this.scroller) {
        const spans = [...this.scroller.querySelectorAll<HTMLElement>(`.atl-pdf-highlight[data-atl-id="${CSS.escape(id)}"]`)];
        this.anchorIndex.set(id, spans.indexOf(anchor));
      }
    }
    // A user click must respond immediately. PDF.js can keep the animation-frame
    // queue busy while rendering/zooming pages, which previously left the card
    // toggle waiting long enough to look broken. Scroll/mutation updates remain
    // frame-throttled via schedule().
    const win = this.host?.ownerDocument.defaultView;
    if (this.frame && win) win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.render();
  }

  private schedule(): void {
    const win = this.host?.ownerDocument.defaultView;
    if (this.frame || !this.host || !win) return;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const { host, scroller, overlay, svg } = this;
    if (!host || !scroller || !overlay || !svg) return;
    if (!overlay.isConnected) host.appendChild(overlay);
    if (!svg.isConnected) host.appendChild(svg);
    this.cards.retain(this.expanded);
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
      // PDF.js may replace text-layer nodes during zoom/lazy rendering, so find
      // the current highlight by id on every render instead of retaining a node.
      const spans = scroller.querySelectorAll<HTMLElement>(
        `.atl-pdf-highlight[data-atl-id="${CSS.escape(id)}"]`
      );
      const visible = (span: HTMLElement): boolean => {
        const rect = span.getBoundingClientRect();
        return rect.height > 0 && rect.bottom >= hostRect.top && rect.top <= hostRect.bottom;
      };
      let anchor = spans.item(this.anchorIndex.get(id) ?? spans.length - 1);
      if (!anchor || !visible(anchor)) anchor = [...spans].reverse().find(visible) ?? anchor;
      if (!anchor) continue;
      const geom = this.geom.get(id) ?? loadCardGeom(id) ?? { dx: 0, dy: 0 };
      this.geom.set(id, geom);
      const card = this.cards.get(mark, {
        skin: this.skin,
        geom,
        showReview: this.showReview,
        onCollapse: () => this.toggle(id),
        onDragMove: (element) =>
          updateConnector(svg, element, host.getBoundingClientRect())
      });
      if (card.parentElement !== overlay) overlay.appendChild(card);
      const rect = anchor ? lastLineRect(anchor) : null;
      // A transient PDF.js text-layer replacement must not destroy a live card.
      if (!rect) continue;
      card.hidden = !card.dataset["dragging"] &&
        (rect.bottom < hostRect.top || rect.top > hostRect.bottom);
      if (card.hidden) continue;
      placed.push({
        card,
        anchorX: rect.right - hostRect.left,
        anchorMidY: (rect.top + rect.bottom) / 2 - hostRect.top,
        desiredY: rect.top - hostRect.top
      });
    }

    const hideLink = this.skin.quiet && this.hideLink;
    placeCards(placed, railWidth, this.geom, (id, anchorX, anchorMidY) => {
      if (!hideLink) drawConnector(svg, overlay, id, anchorX, anchorMidY, hostRect);
    });
  }

}
