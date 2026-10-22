import { setIcon } from "obsidian";

export const ANNOTATION_REVIEW_ICON = "tutor-annotation-review";
export const ANNOTATION_BRANCH_ICON = "tutor-annotation-branches";

/** Review keeps its existing identifier; the brain now denotes Tutor review. */
export function setAnnotationIcon(element: HTMLElement, name: string): void {
  if (name !== ANNOTATION_BRANCH_ICON) {
    setIcon(element, name === ANNOTATION_REVIEW_ICON ? "brain" : name);
    return;
  }

  const doc = element.ownerDocument;
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24", width: "24", height: "24", fill: "none",
    stroke: "currentColor", "stroke-width": "1.85",
    "stroke-linecap": "round", "stroke-linejoin": "round",
    class: "svg-icon atl-annotation-branches-icon",
    "aria-hidden": "true", focusable: "false"
  })) svg.setAttribute(key, value);

  // Concept 09: four open nodes, joined with flowing branches. Paths end at
  // the rings rather than their centres, so transparent node interiors stay clear.
  for (const d of [
    "M5.6 11.4C8.7 10.9 10.4 7.6 12.1 5.5",
    "M5.6 12.6C8.7 13.5 10.1 16.6 11.7 18.7",
    "M13.6 18.4C15.2 13.5 16.7 11.4 18.3 11.9"
  ]) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  for (const [cx, cy] of [[3.5, 12], [12.9, 3.5], [12.9, 20.5], [20.5, 12]]) {
    const circle = doc.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", "2.2");
    svg.appendChild(circle);
  }
  element.replaceChildren(svg);
}
