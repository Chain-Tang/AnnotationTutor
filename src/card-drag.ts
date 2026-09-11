/** A drag owns its card until release; layout refreshes must not replace it. */
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
    if (event.button !== 0 || (event.target as Element).closest("button, textarea, input, a")) return;
    finish?.();
    event.preventDefault();
    event.stopPropagation();
    card.dataset["dragging"] = "true";
    const startX = event.clientX;
    const startY = event.clientY;
    const left = card.offsetLeft;
    const top = card.offsetTop;
    const parent = card.offsetParent as HTMLElement | null;
    const scaleX = parent?.offsetWidth ? parent.getBoundingClientRect().width / parent.offsetWidth : 1;
    const scaleY = parent?.offsetHeight ? parent.getBoundingClientRect().height / parent.offsetHeight : 1;
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== event.pointerId) return;
      card.style.left = `${left + (e.clientX - startX) / (scaleX || 1)}px`;
      card.style.top = `${top + (e.clientY - startY) / (scaleY || 1)}px`;
      geom.dx = parseFloat(card.style.left) - Number(card.dataset["baseLeft"] ?? 0);
      geom.dy = parseFloat(card.style.top) - Number(card.dataset["baseTop"] ?? 0);
      onMove();
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId === event.pointerId) finish?.();
    };
    finish = () => {
      doc.removeEventListener("pointermove", move, true);
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", up, true);
      doc.defaultView?.removeEventListener("blur", finish!);
      delete card.dataset["dragging"];
      finish = undefined;
      onEnd();
    };
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", up, true);
    doc.defaultView?.addEventListener("blur", finish);
  };
  head.addEventListener("pointerdown", down);
  return () => {
    finish?.();
    head.removeEventListener("pointerdown", down);
  };
}
