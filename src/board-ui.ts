/** Small, consistent outline icons for the board. All paths are static. */
const paths: Record<string, string[]> = {
  read: [
    "M3 5h6a3 3 0 0 1 3 3v13a4 4 0 0 0-4-3H3z",
    "M21 5h-6a3 3 0 0 0-3 3v13a4 4 0 0 1 4-3h5z",
  ],
  edit: ["M4 20h4L20 8l-4-4L4 16z", "m13 7 4 4"],
  pen: ["m4 20 2-6L17 3l4 4L10 18z", "m14 6 4 4", "m6 14 4 4"],
  erase: [
    "m4 13 9-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L12 21H7l-3-3a3 3 0 0 1 0-5Z",
    "m9 8 9 9",
    "M12 21h9",
  ],
  partialErase: [
    "m4 13 9-10a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L12 21H7l-3-3a3 3 0 0 1 0-5Z",
    "m9 8 9 9",
    "M15 21h2M19 21h2",
  ],
  select: ["m5 3 14 9-7 1-3 7z"],
  pan: ["M7 11V7a2 2 0 0 1 4 0v3", "M11 10V5a2 2 0 0 1 4 0v5", "M15 10V7a2 2 0 0 1 4 0v7c0 5-3 8-8 8-3 0-5-7-5l-2-4a2 2 0 0 1 3-2l2 2"],
  lasso: ["M5 7c3-5 12-5 15 0 3 6-3 11-10 11S1 15 3 10", "M10 18c0 3-2 4-4 3"],
  text: ["M4 5h16", "M12 5v15", "M8 20h8", "M4 5v3", "M20 5v3"],
  line: ["M4 20 20 4"],
  arrow: ["M4 19 20 4", "M10 4h10v10"],
  rect: ["M4 4h16v16H4z"],
  ellipse: ["M21 12a9 8 0 1 1-18 0 9 8 0 1 1 18 0"],
  diamond: ["M12 3 21 12 12 21 3 12Z"],
  connector: ["M5 6h4v4H5z", "M15 14h4v4h-4z", "M9 8c6 0 0 8 6 8"],
  fill: ["M4 14 13 5l6 6-9 9H4Z", "m13 5-2-2", "M19 16c2 2 2 3 0 5-2-2-2-3 0-5Z"],
  gradient: ["M3 5h18v14H3Z", "M8 5v14", "M13 5v14", "M18 5v14"],
  eyedropper: ["m19 3 2 2-9 9-3 1-2 2-3 1 1-3 2-2 1-3Z", "m13 7 4 4"],
  transform: ["M12 2v20M2 12h20", "m8-6 4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4"],
  crop: ["M6 2v16a2 2 0 0 0 2 2h14", "M2 6h16a2 2 0 0 1 2 2v14"],
  undo: ["M9 5 3 10l6 5", "M3 10h11a6 6 0 0 1 0 12"],
  redo: ["m15 5 6 5-6 5", "M21 10H10a6 6 0 0 0 0 12"],
  fitContent: ["M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"],
  origin: ["M12 3a9 9 0 1 1-9 9 9 9 0 1 1 9-9", "M12 8a4 4 0 1 1-4 4 4 4 0 1 1 4-4", "M12 11v2"],
  addArtboard: ["M4 4h12v16H4Z", "M19 8v8M15 12h8"],
  export: ["M12 3v12", "m7 10 5 5 5-5", "M4 19v2h16v-2"],
  share: ["M18 8a3 3 0 1 0 0-6 3 3 0 1 0 0 6", "M6 15a3 3 0 1 0 0-6 3 3 0 1 0 0 6", "M18 22a3 3 0 1 0 0-6 3 3 0 1 0 0 6", "m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"],
  immersive: ["M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5", "M9 9h6v6H9Z"],
  rotate: ["M20 7V3l-3 3", "M20 3a9 9 0 1 1-2-1"],
  mirror: ["M12 3v18", "M10 5 3 12H3Z", "M14 5l7 12h-7Z"],
  symmetry: ["M12 2v20", "M10 5c-5 1-7 5-7 7s2 6 7 7", "M14 5c5 1 7 5 7 7s-2 6-7 7"],
  visible: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z", "M12 9a3 3 0 1 1-3 3 3 3 0 1 1 3-3"],
  hidden: ["M3 3l18 18", "M10.6 5.2Q11.3 5 12 5c6 0 10 7 10 7a18 18 0 0 1-2.2 3", "M6.3 6.3C3.6 8.3 2 12 2 12s4 7 10 7c1.4 0 2.7-.4 3.8-1"],
  lock: ["M5 10h14v11H5Z", "M8 10V7a4 4 0 0 1 8 0v3"],
  unlock: ["M5 10h14v11H5Z", "M8 10V7a4 4 0 0 1 7-2"],
  alphaLock: ["M5 19 11 5h2l6 14", "M7 15h10", "M17 8h5v5"],
  clip: ["M8 7H5a3 3 0 0 0 0 6h3", "M16 11h3a3 3 0 0 1 0 6h-3", "M8 12h8"],
  together: [
    "M8 11a4 4 0 1 0 0-8 4 4 0 1 0 0 8",
    "M16 10a3 3 0 1 0 0-6",
    "M2 21v-2a6 6 0 0 1 12 0v2",
    "M14 15a5 5 0 0 1 8 4v2",
  ],
  sticker: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0",
    "M8 9v1",
    "M16 9v1",
    "M8 14q4 5 8 0",
  ],
  character: [
    "M6 8q-4-1-3 4l2 2q0 6 7 6t7-6l2-2q1-5-3-4",
    "M6 8q0-6 6-6t6 6",
    "M9 11v1",
    "M15 11v1",
    "M10 16h4",
  ],
  remove: [
    "M3 6h18",
    "M9 6V3h6v3",
    "M5 6l1 15h12l1-15",
    "M10 10v7",
    "M14 10v7",
  ],
  group: [
    "M3 8V3h5",
    "M16 3h5v5",
    "M21 16v5h-5",
    "M8 21H3v-5",
    "M7 7h10v10H7z",
  ],
  ungroup: ["M3 3h7v7H3z", "M14 14h7v7h-7z", "M14 3h7v7", "M3 14v7h7"],
  settings: ["M4 6h16", "M4 12h16", "M4 18h16", "M8 3v6", "M16 9v6", "M9 15v6"],
  close: ["m6 6 12 12", "M18 6 6 18"],
  sparkles: ["m12 3 1.4 4.1L17.5 8.5 13.4 10 12 14l-1.4-4L6.5 8.5l4.1-1.4Z", "m19 15 .7 2.3L22 18l-2.3.7L19 22l-.7-2.3L16 18l2.3-.7Z", "M5 15v3M3.5 16.5h3"],
  more: ["M5 11v2", "M12 11v2", "M19 11v2"],
};

export function decorateBoardButton(
  button: HTMLButtonElement,
  key: string,
): void {
  const iconPaths = paths[key];
  if (!iconPaths) return;
  const doc = button.ownerDocument;
  const label = button.textContent ?? "";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.dataset.boardAction = key;
  button.classList.add("atl-board-icon-button");
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(name, value);
  for (const d of iconPaths) {
    const path = doc.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  const text = doc.createElement("span");
  text.className = "atl-board-sr-only";
  text.textContent = label;
  button.replaceChildren(svg, text);
}
