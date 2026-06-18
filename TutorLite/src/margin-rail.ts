// Word-style margin comments in the editor (Source / Live Preview). Cards are
// hidden by default; clicking an annotation marker toggles that annotation's
// card (decorations.ts owns the expanded-id StateField). An expanded card is an
// editable bar joined to its line by a dotted connector, draggable and
// resizable. A "paper" option drops the card chrome to feel like book margins.
// The card DOM and connector maths are shared with the Reading-view rail via
// margin-card.ts.

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import {
  marginExpandedField,
  markerConfigField,
  toggleMarginCard
} from "./decorations.js";
import { BLOCK_ID_SUFFIX } from "./decorations-plan.js";
import {
  buildMarginCard,
  clearChildren,
  drawConnector,
  lastLineRect,
  loadCardGeom,
  placeCards,
  updateConnector,
  type Geom,
  type PlacedCard,
  SVG_NS
} from "./margin-card.js";

export {
  setMarginCardHandlers,
  setCardGeomStore,
  type MarginCardHandlers,
  type DialogueReplyResult
} from "./margin-card.js";

class MarginRail {
  private readonly cardsEl: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly onScroll: () => void;
  private readonly geom = new Map<string, Geom>();
  private observers: ResizeObserver[] = [];
  private frame = 0;

  public constructor(private readonly view: EditorView) {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("atl-rail-svg");
    this.cardsEl = document.createElement("div");
    this.cardsEl.className = "atl-rail";
    view.dom.appendChild(this.svg);
    view.dom.appendChild(this.cardsEl);

    this.onScroll = () => this.schedule();
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.schedule();
  }

  public update(update: ViewUpdate): void {
    const configChanged =
      update.startState.field(markerConfigField) !==
      update.state.field(markerConfigField);
    const expandedChanged =
      update.startState.field(marginExpandedField) !==
      update.state.field(marginExpandedField);
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      configChanged ||
      expandedChanged
    ) {
      this.schedule();
    }
  }

  public destroy(): void {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.disconnectObservers();
    this.svg.remove();
    this.cardsEl.remove();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    this.disconnectObservers();
    clearChildren(this.cardsEl);
    clearChildren(this.svg);

    const config = this.view.state.field(markerConfigField);
    const expanded = this.view.state.field(marginExpandedField);
    if (!config.marginComments || expanded.size === 0) return;

    const doc = this.view.state.doc;
    const lineByBlock = new Map<string, number>();
    for (let i = 1; i <= doc.lines; i += 1) {
      const match = BLOCK_ID_SUFFIX.exec(doc.line(i).text);
      if (match?.[1]) lineByBlock.set(match[1], i);
    }

    const editorRect = this.view.dom.getBoundingClientRect();
    this.svg.setAttribute("width", `${editorRect.width}`);
    this.svg.setAttribute("height", `${editorRect.height}`);
    const railWidth = this.cardsEl.clientWidth;

    const placed: PlacedCard[] = [];
    for (const mark of config.marks) {
      if (!expanded.has(mark.id)) continue;
      const lineNumber = lineByBlock.get(mark.blockId);
      if (!lineNumber) continue;
      const anchor = this.anchorFor(mark.id, doc.line(lineNumber).to, editorRect);
      if (!anchor) continue; // off-screen — no card

      const geom = this.geom.get(mark.id) ?? loadCardGeom(mark.id) ?? { dx: 0, dy: 0 };
      this.geom.set(mark.id, geom);
      const { card, observer } = buildMarginCard(mark, {
        paper: config.marginPaper,
        geom,
        showReview: config.inlineReview,
        onCollapse: () =>
          this.view.dispatch({ effects: toggleMarginCard.of(mark.id) }),
        onDragMove: (el) => updateConnector(this.svg, el, this.editorRect())
      });
      this.observers.push(observer);
      this.cardsEl.appendChild(card);
      placed.push({
        card,
        anchorX: anchor.x,
        anchorMidY: anchor.midY,
        desiredY: anchor.top
      });
    }

    const hideLink = config.marginPaper && config.marginHideLink;
    placeCards(placed, railWidth, this.geom, (id, anchorX, anchorMidY) => {
      if (hideLink) return;
      drawConnector(this.svg, this.cardsEl, id, anchorX, anchorMidY, editorRect);
    });
  }

  private editorRect(): DOMRect {
    return this.view.dom.getBoundingClientRect();
  }

  /**
   * Where the dotted connector should meet the text: the very end of the
   * annotation's underlined span. A multi-line span is split by CodeMirror into
   * one element per line, so use the LAST one (and its last on-screen line) to
   * reach the end of the underline, not the end of its first line. Falls back to
   * the marker glyph, then the line end (`lineEndPos`). Null when off-screen.
   */
  private anchorFor(
    id: string,
    lineEndPos: number,
    editorRect: DOMRect
  ): { x: number; midY: number; top: number } | null {
    const content = this.view.contentDOM;
    const spans = content.querySelectorAll<HTMLElement>(
      `[data-atl-id="${id}"]:not(.atl-marker)`
    );
    const span = spans.item(spans.length - 1);
    const marker = content.querySelector<HTMLElement>(
      `.atl-marker[data-atl-id="${id}"]`
    );
    const el = span ?? marker;
    if (el) {
      const rect = lastLineRect(el);
      if (rect) {
        const x = (el === span ? rect.right : rect.left) - editorRect.left;
        return {
          x,
          midY: (rect.top + rect.bottom) / 2 - editorRect.top,
          top: rect.top - editorRect.top
        };
      }
    }
    const coords = this.view.coordsAtPos(lineEndPos);
    if (!coords) return null;
    return {
      x: coords.right - editorRect.left,
      midY: (coords.top + coords.bottom) / 2 - editorRect.top,
      top: coords.top - editorRect.top
    };
  }

  private disconnectObservers(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
  }
}

/** The margin comment rail editor extension. */
export const marginRailExtension = ViewPlugin.fromClass(MarginRail);
