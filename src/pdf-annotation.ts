// Helpers for annotations made in Obsidian's built-in PDF.js viewer. The DOM
// lookup stays defensive because PDF.js class names are not part of Obsidian's
// public plugin API, while the normalization/id helpers remain pure and tested.

export type PdfTextSelection = {
  text: string;
  /** One-based page number when PDF.js exposed it in the text-layer DOM. */
  page?: number;
};

export type PdfSelectionPoint = { x: number; y: number };

/** Keep the selection action inside the viewport and by the final text line. */
export function pdfSelectionActionPoint(
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  viewportWidth: number,
  viewportHeight: number
): PdfSelectionPoint {
  const width = 136;
  const height = 36;
  const gap = 8;
  const margin = 8;
  const x = Math.max(margin, Math.min(rect.right + gap, viewportWidth - width - margin));
  const below = rect.bottom + gap;
  const y =
    below + height <= viewportHeight - margin
      ? below
      : Math.max(margin, rect.top - height - gap);
  return { x, y };
}

/** Collapse PDF.js line-breaking whitespace into stable text for memory files. */
export function normalizePdfSelection(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

/** Parse the one-based page values used by PDF.js (`data-page-number`). */
export function parsePdfPageNumber(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

/** A stable synthetic id; unlike Markdown anchors it is not written into the PDF. */
export function pdfAnchorId(annotationId: string, page?: number): string {
  const suffix = annotationId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `pdf-page-${page ?? "unknown"}-${suffix}`;
}

/** Read a page number from a PDF.js selection node or right-click target. */
export function pageNumberForPdfNode(node: Node | null | undefined): number | undefined {
  const element =
    node && node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node?.parentElement;
  if (!element) return undefined;
  const page = element.closest<HTMLElement>("[data-page-number]");
  return parsePdfPageNumber(page?.dataset["pageNumber"]);
}

/** Capture the current selection if it belongs to a PDF view container. */
export function selectionFromPdfView(
  viewContainer: HTMLElement,
  selection: Selection | null,
  fallbackNode?: Node | null
): PdfTextSelection | null {
  if (!selection || selection.rangeCount === 0) return null;
  const text = normalizePdfSelection(selection.toString());
  if (!text) return null;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (
    (anchorNode && !viewContainer.contains(anchorNode)) ||
    (focusNode && !viewContainer.contains(focusNode))
  ) {
    return null;
  }
  const anchorPage = pageNumberForPdfNode(anchorNode);
  const focusPage = pageNumberForPdfNode(focusNode);
  const fallbackPage = pageNumberForPdfNode(fallbackNode);
  return { text, page: anchorPage ?? focusPage ?? fallbackPage };
}
