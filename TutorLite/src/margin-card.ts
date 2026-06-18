// Shared building blocks for the Word-style margin comment cards, used by both
// the CodeMirror editor rail (margin-rail.ts) and the Reading-view rail
// (reading-rail.ts). Each rail owns its own coordinate system and re-render
// loop; everything that is identical between them lives here: the editable card
// DOM, the dotted connector geometry, drag, vertical stacking, and the handler
// registry the plugin wires once on load.

import { setIcon, setTooltip } from "obsidian";
import { t } from "./i18n.js";
import type { AnchorMark } from "./decorations-plan.js";
import type { DialogueTurn } from "./model.js";
import { diffLineClass } from "./line-diff.js";

/**
 * The outcome of one in-card dialogue turn. `edit` is present only when the
 * tutor proposed a change to the source text (Phase 3): `diff` is the rendered
 * before/after and `apply` writes it into the note, returning whether it landed.
 */
export type DialogueReplyResult = {
  ok: boolean;
  agentText?: string;
  error?: string;
  edit?: { diff: string; apply: () => boolean };
};

export type MarginCardHandlers = {
  save: (id: string, note: string) => void;
  /** Review this annotation, or route to a Build-mode edit if the note asks for one. */
  ask: (id: string, note: string) => void;
  /** Open the sidebar chat seeded with this annotation as context. */
  discuss: (id: string) => void;
  /** Send one in-card dialogue turn; resolves with the tutor's reply (+ any edit). */
  reply: (id: string, message: string) => Promise<DialogueReplyResult>;
  /** Render Markdown into an element (so tutor replies aren't shown as raw text). */
  render: (el: HTMLElement, markdown: string) => void | Promise<void>;
  /** Distill a memory cell from this annotation's note + review + dialogue. */
  saveCell: (id: string) => void | Promise<void>;
  remove: (id: string) => void;
  settings: () => void;
};

let handlers: MarginCardHandlers | null = null;

// Which annotations have their dialogue revealed. The rail rebuilds cards from
// scratch on scroll/geometry changes, so this session-level set keeps a card's
// dialogue open across those rebuilds (otherwise a toggle would be undone on the
// next re-render, which read as "needs two clicks").
const openDialogues = new Set<string>();

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

  // Assigned once the dialogue area is built; the header button toggles it.
  let toggleDialogue = (): void => {};

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
  // Keeps reading immersive: the dialogue input stays hidden until requested.
  headButton(head, "message-circle", t("card.dialogue"), () => toggleDialogue());
  headButton(head, "brain", t("card.saveCell"), () =>
    getMarginCardHandlers()?.saveCell(mark.id)
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

  // A continuous dialogue: hidden until the learner clicks the dialogue button,
  // then the tutor remembers the thread (persisted in the annotation file) and a
  // "rewrite the original" request surfaces a diff.
  toggleDialogue = renderDialogue(card, mark).toggle;

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

/**
 * Build the dialogue thread + reply input, hidden until toggled (so reading
 * stays immersive). Returns a `toggle` the header button calls to reveal it.
 */
function renderDialogue(card: HTMLElement, mark: AnchorMark): { toggle: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "atl-rail-dialogue";
  wrap.style.display = openDialogues.has(mark.id) ? "flex" : "none";

  const thread = document.createElement("div");
  thread.className = "atl-rail-thread";
  for (const turn of mark.dialogue ?? []) appendTurn(thread, turn.role, turn.text);
  wrap.appendChild(thread);

  const row = document.createElement("div");
  row.className = "atl-rail-reply-row";
  const input = document.createElement("textarea");
  input.className = "atl-rail-reply";
  input.placeholder = t("card.reply.placeholder");
  input.rows = 1;
  input.addEventListener("mousedown", (event) => event.stopPropagation());
  const send = document.createElement("button");
  send.className = "atl-iconbtn atl-rail-reply-send";
  setIcon(send, "send-horizontal");
  setTooltip(send, t("card.reply.send"));
  row.appendChild(input);
  row.appendChild(send);
  wrap.appendChild(row);

  const submit = async (): Promise<void> => {
    const message = input.value.trim();
    const cardHandlers = getMarginCardHandlers();
    if (!message || !cardHandlers) return;
    input.value = "";
    appendTurn(thread, "user", message);
    const thinking = appendNotice(thread, t("card.reply.thinking"));
    send.disabled = true;
    input.disabled = true;
    try {
      const result = await cardHandlers.reply(mark.id, message);
      thinking.remove();
      if (!result.ok) {
        appendNotice(thread, result.error ?? t("card.reply.error"));
      } else {
        appendTurn(thread, "agent", result.agentText || t("card.reply.empty"));
        if (result.edit) appendEditCard(thread, result.edit);
      }
    } catch (error) {
      thinking.remove();
      appendNotice(thread, error instanceof Error ? error.message : String(error));
    } finally {
      send.disabled = false;
      input.disabled = false;
      input.focus();
    }
  };
  send.onclick = () => void submit();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  card.appendChild(wrap);
  return {
    toggle: () => {
      const opening = !openDialogues.has(mark.id);
      if (opening) openDialogues.add(mark.id);
      else openDialogues.delete(mark.id);
      wrap.style.display = opening ? "flex" : "none";
      if (opening) {
        input.focus();
        thread.scrollTop = thread.scrollHeight;
      }
    }
  };
}

function appendTurn(
  thread: HTMLElement,
  role: DialogueTurn["role"],
  text: string
): void {
  const el = document.createElement("div");
  el.className = `atl-rail-turn atl-rail-turn--${role}`;
  // Render the tutor's reply as Markdown; the learner's own line stays plain.
  const render = getMarginCardHandlers()?.render;
  if (role === "agent" && render) {
    el.classList.add("atl-rail-md");
    void render(el, text);
  } else {
    el.textContent = text;
  }
  thread.appendChild(el);
}

function appendNotice(thread: HTMLElement, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "atl-rail-turn atl-rail-turn--notice";
  el.textContent = text;
  thread.appendChild(el);
  return el;
}

/** A diff preview + Apply/Dismiss for a tutor-proposed change to the source. */
function appendEditCard(
  thread: HTMLElement,
  edit: { diff: string; apply: () => boolean }
): void {
  const card = document.createElement("div");
  card.className = "atl-rail-editcard";
  const title = document.createElement("div");
  title.className = "atl-rail-editcard-title";
  title.textContent = t("chat.edit.title");
  card.appendChild(title);

  const pre = document.createElement("pre");
  pre.className = "atl-diff";
  for (const line of edit.diff.split("\n")) {
    const div = document.createElement("div");
    div.className = diffLineClass(line);
    div.textContent = line;
    pre.appendChild(div);
  }
  card.appendChild(pre);

  const actions = document.createElement("div");
  actions.className = "atl-actions";
  const apply = document.createElement("button");
  apply.className = "mod-cta";
  apply.textContent = t("chat.edit.apply");
  apply.onclick = () => {
    if (edit.apply()) {
      apply.disabled = true;
      apply.textContent = t("chat.edit.applied");
    }
  };
  const dismiss = document.createElement("button");
  dismiss.textContent = t("chat.edit.dismiss");
  dismiss.onclick = () => card.remove();
  actions.appendChild(apply);
  actions.appendChild(dismiss);
  card.appendChild(actions);

  thread.appendChild(card);
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

/**
 * The rect of an element's last on-screen line. An inline highlight that wraps
 * across visual lines reports one client rect per line; the connector should meet
 * the end of the underline, so anchor it to that final rect (not the bounding box,
 * whose right edge is the widest line). Null when the element has no box.
 */
export function lastLineRect(el: Element): DOMRect | null {
  const rects = el.getClientRects();
  const last = rects.item(rects.length - 1);
  if (last) return last;
  const box = el.getBoundingClientRect();
  return box.width || box.height ? box : null;
}
