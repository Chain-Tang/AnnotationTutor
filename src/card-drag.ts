const DRAG_THRESHOLD = 4;
const RESIZE_HANDLE_SIZE = 16;
const INTERACTIVE = "button, textarea, input, select, option, a, summary, [role=button], [contenteditable=true], [contenteditable=plaintext-only]";

function localPoint(card: HTMLElement, event: PointerEvent): { x: number; y: number } | undefined {
  const rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height || !card.offsetWidth || !card.offsetHeight) return;
  return {
    x: (event.clientX - rect.left) * card.offsetWidth / rect.width,
    y: (event.clientY - rect.top) * card.offsetHeight / rect.height
  };
}

/** Leave the browser's bottom-right resize affordance available on every skin. */
export function isCardResizeHandle(card: HTMLElement, event: PointerEvent): boolean {
  const point = localPoint(card, event);
  return Boolean(point && point.x >= Math.max(0, card.offsetWidth - RESIZE_HANDLE_SIZE)
    && point.y >= Math.max(0, card.offsetHeight - RESIZE_HANDLE_SIZE)
    && point.x <= card.offsetWidth && point.y <= card.offsetHeight);
}

function isScrollbar(card: HTMLElement, event: PointerEvent): boolean {
  const point = localPoint(card, event);
  if (!point) return false;
  const style = card.ownerDocument.defaultView?.getComputedStyle(card);
  const rightBorder = parseFloat(style?.borderRightWidth ?? "0") || 0;
  const bottomBorder = parseFloat(style?.borderBottomWidth ?? "0") || 0;
  const vertical = card.clientWidth > 0 && card.offsetWidth - card.clientWidth - card.clientLeft > rightBorder + 1;
  const horizontal = card.clientHeight > 0 && card.offsetHeight - card.clientHeight - card.clientTop > bottomBorder + 1;
  return (vertical && point.x >= card.clientLeft + card.clientWidth)
    || (horizontal && point.y >= card.clientTop + card.clientHeight);
}

/** A drag owns only its card; layout refreshes must not replace it until release. */
export function enableCardDrag(
  card: HTMLElement,
  head: HTMLElement,
  geom: { dx: number; dy: number },
  onMove: () => void,
  onEnd: () => void
): () => void {
  const doc = card.ownerDocument;
  let finish: (() => void) | undefined;
  const down = (event: PointerEvent): void => {
    const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
    if (event.button !== 0 || !target) return;
    const control = target.closest(INTERACTIVE);
    // CodeMirror's editable source ancestor sits outside this independent card.
    if (control && card.contains(control)) return;
    // A card's own surface is its blank padding/border. Descendant content is
    // deliberately excluded so a normal drag across replies selects text.
    if (target !== card && !head.contains(target)) return;
    if (target === card && (isCardResizeHandle(card, event) || isScrollbar(card, event))) return;
    finish?.();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const left = card.offsetLeft;
    const top = card.offsetTop;
    const parent = card.offsetParent as HTMLElement | null;
    const scaleX = parent?.offsetWidth ? parent.getBoundingClientRect().width / parent.offsetWidth : 1;
    const scaleY = parent?.offsetHeight ? parent.getBoundingClientRect().height / parent.offsetHeight : 1;
    let dragging = false;
    const previousSelect = card.style.getPropertyValue("user-select");
    const previousSelectPriority = card.style.getPropertyPriority("user-select");
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== event.pointerId) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        card.dataset["dragging"] = "true";
        card.style.setProperty("user-select", "none", "important");
      }
      e.preventDefault();
      e.stopPropagation();
      card.style.left = `${left + (e.clientX - startX) / (scaleX || 1)}px`;
      card.style.top = `${top + (e.clientY - startY) / (scaleY || 1)}px`;
      geom.dx = parseFloat(card.style.left) - Number(card.dataset["baseLeft"] ?? 0);
      geom.dy = parseFloat(card.style.top) - Number(card.dataset["baseTop"] ?? 0);
      onMove();
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId === event.pointerId) finish?.();
    };
    const end = (): void => {
      doc.removeEventListener("pointermove", move, true);
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", up, true);
      doc.defaultView?.removeEventListener("blur", end);
      delete card.dataset["dragging"];
      if (dragging) {
        if (previousSelect) card.style.setProperty("user-select", previousSelect, previousSelectPriority);
        else card.style.removeProperty("user-select");
      }
      finish = undefined;
      if (dragging) onEnd();
    };
    finish = end;
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", up, true);
    doc.defaultView?.addEventListener("blur", end);
  };
  card.addEventListener("pointerdown", down);
  return () => {
    finish?.();
    card.removeEventListener("pointerdown", down);
  };
}
