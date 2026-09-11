/** Shared interaction policy, independent of skin CSS or hover media queries. */
export function installCardChrome(card: HTMLElement, head: HTMLElement): () => void {
  const doc = card.ownerDocument;
  let hovered = false;
  let touched = false;
  let disposed = false;
  const update = (): void => {
    if (disposed) return;
    const active = doc.activeElement;
    const keyboardAction = active && head.contains(active) && active.matches("button:focus-visible");
    const visible = hovered || touched || Boolean(card.dataset["dragging"]) || Boolean(keyboardAction);
    // Inline priority keeps even a custom skin's toolbar rules from making
    // controls permanently visible. Skins still own color, texture and shape.
    head.style.setProperty("opacity", visible ? "1" : "0", "important");
    head.style.setProperty("pointer-events", visible ? "auto" : "none", "important");
  };
  const enter = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    hovered = true;
    update();
  };
  const leave = (): void => { hovered = false; touched = false; update(); };
  const pointerDown = (event: PointerEvent): void => {
    if (!card.contains(event.target as Node)) { touched = false; update(); }
    else if (event.pointerType === "touch") { touched = true; update(); }
  };
  const settled = (): void => { queueMicrotask(update); };
  card.addEventListener("pointerenter", enter);
  card.addEventListener("pointerleave", leave);
  card.addEventListener("focusin", update);
  card.addEventListener("focusout", settled);
  doc.addEventListener("pointerdown", pointerDown, true);
  // Drag release clears data-dragging later in the same event dispatch.
  doc.addEventListener("pointerup", settled, true);
  doc.addEventListener("pointercancel", settled, true);
  update();
  return () => {
    disposed = true;
    card.removeEventListener("pointerenter", enter);
    card.removeEventListener("pointerleave", leave);
    card.removeEventListener("focusin", update);
    card.removeEventListener("focusout", settled);
    doc.removeEventListener("pointerdown", pointerDown, true);
    doc.removeEventListener("pointerup", settled, true);
    doc.removeEventListener("pointercancel", settled, true);
  };
}
