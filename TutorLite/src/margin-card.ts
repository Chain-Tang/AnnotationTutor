// Shared building blocks for the Word-style margin comment cards, used by both
// the CodeMirror editor rail (margin-rail.ts) and the Reading-view rail
// (reading-rail.ts). Each rail owns its own coordinate system and re-render
// loop; everything that is identical between them lives here: the editable card
// DOM, the dotted connector geometry, drag, vertical stacking, and the handler
// registry the plugin wires once on load.

import { setIcon, setTooltip } from "obsidian";
import { t } from "./i18n.js";
import type { AnchorMark } from "./decorations-plan.js";

export type MarginCardHandlers = {
  save: (id: string, note: string) => void;
  /** Review this annotation, or route to a Build-mode edit if the note asks for one. */
  ask: (id: string, note: string) => void;
  /** Open the sidebar chat seeded with this annotation as context. */
  discuss: (id: string) => void;
  remove: (id: string) => void;
  settings: () => void;
};

let handlers: MarginCardHandlers | null = null;

export function setMarginCardHandlers(value: MarginCardHandlers | null): void {
  handlers = value;
}

export function getMarginCardHandlers(): MarginCardHandlers | null {
  return handlers;
}

/** Per-card offset (drag) and size (resize), persisted across re-renders. */
export type Geom = { dx: number; dy: number; w?: number; h?: number };

/**
 * Durable storage for card geometry, wired by the plugin so a card's size/place
 * survives re-renders, agent writes, and reloads — and so every card keeps its
 * own size independently. `get` seeds a card; `set` is called only on a real
 * user drag/resize.
 */
export type CardGeomStore = {
  get(id: string): Geom | undefined;
  set(id: string, geom: Geom): void;
};

let geomStore: CardGeomStore | null = null;

export function setCardGeomStore(store: CardGeomStore | null): void {
  geomStore = store;
}

/** The persisted geometry for a card, if any (used to seed a fresh rail). */
export function loadCardGeom(id: string): Geom | undefined {
  return geomStore?.get(id);
}

function persistCardGeom(id: string, geom: Geom): void {
  geomStore?.set(id, geom);
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export const CARD_GAP = 8;

type BuildOptions = {
  paper: boolean;
  geom: Geom;
  /** Show the agent review (if any) inside the card, below the note. */
  showReview: boolean;
  onCollapse: () => void;
  /** Called continuously while the card is dragged, to redraw its connector. */
  onDragMove: (card: HTMLElement) => void;
};

/** Build one editable margin card. Returns the element and its size observer. */
export function buildMarginCard(
  mark: AnchorMark,
  options: BuildOptions
): { card: HTMLElement; observer: ResizeObserver } {
  const card = document.createElement("div");
  card.className = options.paper
    ? "atl-rail-card atl-rail-card--paper"
    : "atl-rail-card";
  card.dataset["atlId"] = mark.id;

  const head = document.createElement("div");
  head.className = "atl-rail-card-head";
  const grip = document.createElement("span");
  grip.className = "atl-rail-grip";
  head.appendChild(grip);
  head.appendChild(spacer());
  headButton(head, "settings", t("panel.settings"), () =>
    getMarginCardHandlers()?.settings()
  );
  headButton(head, "sparkles", t("card.ask"), () =>
    getMarginCardHandlers()?.ask(mark.id, editor.value)
  );
  headButton(head, "message-circle", t("card.discuss"), () =>
    getMarginCardHandlers()?.discuss(mark.id)
  );
  headButton(head, "trash-2", t("card.delete"), () =>
    getMarginCardHandlers()?.remove(mark.id)
  );
  headButton(head, "x", t("card.collapse"), options.onCollapse);
  card.appendChild(head);
  enableDrag(card, head, options.geom, () => options.onDragMove(card));

  const editor = document.createElement("textarea");
  editor.className = "atl-rail-edit";
  editor.value = mark.note ?? "";
  editor.placeholder = t("panel.placeholder");
  editor.addEventListener("mousedown", (event) => event.stopPropagation());
  editor.addEventListener("blur", () =>
    getMarginCardHandlers()?.save(mark.id, editor.value)
  );
  card.appendChild(editor);

  // The agent review sits quietly under the note, inside the same card, so the
  // feedback reads as part of the comment rather than a separate labelled block.
  if (options.showReview && (mark.review || mark.reviewQuestion)) {
    const divider = document.createElement("div");
    divider.className = "atl-rail-divider";
    card.appendChild(divider);
    if (mark.review) {
      const review = document.createElement("div");
      review.className = "atl-rail-review";
      review.textContent = mark.review;
      card.appendChild(review);
    }
    // The Socratic question reads as a gentle prompt below the comment.
    if (mark.reviewQuestion) {
      const question = document.createElement("div");
      question.className = "atl-rail-question";
      question.textContent = mark.reviewQuestion;
      card.appendChild(question);
    }
  }

  // Apply remembered size, then ignore the resize events that applying it fires.
  let applying = true;
  if (options.geom.w) card.style.width = `${options.geom.w}px`;
  if (options.geom.h) card.style.height = `${options.geom.h}px`;
  requestAnimationFrame(() => {
    applying = false;
  });

  // Only a deliberate resize gesture should change a card's remembered size.
  // Content changes (a review arriving, the textarea reflowing) must not, or one
  // card's size would silently follow another card's edits. A size change counts
  // as user-driven only while a pointer is held down on this card.
  let resizing = false;
  const endResize = (): void => {
    resizing = false;
    document.removeEventListener("pointerup", endResize, true);
    document.removeEventListener("pointercancel", endResize, true);
  };
  card.addEventListener("pointerdown", () => {
    resizing = true;
    document.addEventListener("pointerup", endResize, true);
    document.addEventListener("pointercancel", endResize, true);
  });
  const observer = new ResizeObserver(() => {
    if (applying || !resizing) return;
    options.geom.w = card.offsetWidth;
    options.geom.h = card.offsetHeight;
    persistCardGeom(mark.id, options.geom);
  });
  observer.observe(card);

  return { card, observer };
}

function headButton(
  container: HTMLElement,
  icon: string,
  tooltip: string,
  handler: () => void
): void {
  const button = container.createEl("button", { cls: "atl-iconbtn" });
  setIcon(button, icon);
  setTooltip(button, tooltip);
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.onclick = () => handler();
}

/** Drag a card by its head; persists the offset from its computed base into geom. */
function enableDrag(
  card: HTMLElement,
  head: HTMLElement,
  geom: Geom,
  onMove: () => void
): void {
  head.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement).closest("button, textarea")) return;
    event.preventDefault();
    const baseLeft = Number(card.dataset["baseLeft"] ?? "0");
    const baseTop = Number(card.dataset["baseTop"] ?? "0");
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = card.offsetLeft;
    const startTop = card.offsetTop;

    const move = (e: MouseEvent): void => {
      card.style.left = `${startLeft + (e.clientX - startX)}px`;
      card.style.top = `${startTop + (e.clientY - startY)}px`;
      onMove();
    };
    const up = (): void => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      geom.dx = card.offsetLeft - baseLeft;
      geom.dy = card.offsetTop - baseTop;
      const id = card.dataset["atlId"];
      if (id) persistCardGeom(id, geom);
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  });
}

export type PlacedCard = {
  card: HTMLElement;
  anchorX: number;
  anchorMidY: number;
  desiredY: number;
};

/**
 * Stack cards top to bottom against the right edge of a rail of `railWidth`,
 * honouring each card's remembered drag offset and never overlapping. Calls
 * `draw` with the final geometry so the caller can render the connector.
 */
export function placeCards(
  cards: PlacedCard[],
  railWidth: number,
  geomByID: Map<string, Geom>,
  draw: (id: string, anchorX: number, anchorMidY: number) => void
): void {
  cards.sort((a, b) => a.desiredY - b.desiredY);
  let cursorY = 0;
  for (const item of cards) {
    const id = item.card.dataset["atlId"] ?? "";
    const geom = geomByID.get(id) ?? { dx: 0, dy: 0 };
    const baseTop = Math.max(item.desiredY, cursorY);
    const baseLeft = Math.max(0, railWidth - item.card.offsetWidth - CARD_GAP);
    item.card.dataset["baseLeft"] = `${baseLeft}`;
    item.card.dataset["baseTop"] = `${baseTop}`;
    item.card.dataset["anchorX"] = `${item.anchorX}`;
    item.card.dataset["anchorMidY"] = `${item.anchorMidY}`;
    item.card.style.left = `${baseLeft + geom.dx}px`;
    item.card.style.top = `${baseTop + geom.dy}px`;
    cursorY = baseTop + geom.dy + item.card.offsetHeight + CARD_GAP;
    draw(id, item.anchorX, item.anchorMidY);
  }
}

/** Draw the dotted connector from an anchor point to a card's left-middle. */
export function drawConnector(
  svg: SVGSVGElement,
  cardsEl: HTMLElement,
  id: string,
  anchorX: number,
  anchorMidY: number,
  originRect: DOMRect
): void {
  const card = cardsEl.querySelector<HTMLElement>(
    `.atl-rail-card[data-atl-id="${id}"]`
  );
  if (!card) return;
  const cardRect = card.getBoundingClientRect();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "atl-rail-link");
  path.setAttribute("data-atl-id", id);
  path.setAttribute(
    "d",
    connectorD(
      anchorX,
      anchorMidY,
      cardRect.left - originRect.left,
      cardRect.top - originRect.top + cardRect.height / 2
    )
  );
  svg.appendChild(path);
}

/** Live-update a single card's connector while it is dragged. */
export function updateConnector(
  svg: SVGSVGElement,
  card: HTMLElement,
  originRect: DOMRect
): void {
  const id = card.dataset["atlId"];
  if (!id) return;
  const path = svg.querySelector<SVGPathElement>(`path[data-atl-id="${id}"]`);
  if (!path) return;
  const cardRect = card.getBoundingClientRect();
  path.setAttribute(
    "d",
    connectorD(
      Number(card.dataset["anchorX"] ?? "0"),
      Number(card.dataset["anchorMidY"] ?? "0"),
      cardRect.left - originRect.left,
      cardRect.top - originRect.top + cardRect.height / 2
    )
  );
}

function connectorD(x1: number, y1: number, x2: number, y2: number): string {
  const midX = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function spacer(): HTMLElement {
  const el = document.createElement("span");
  el.className = "atl-spacer";
  return el;
}

export function clearChildren(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
