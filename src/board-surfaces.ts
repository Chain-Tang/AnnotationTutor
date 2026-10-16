/** All coordinates stored on a board are independent of the screen and zoom. */
import type { BoardAnchor, BoardMatrix, BoardPoint, BoardRect } from "./board-types.js";
import { boardTextVersion, type BoardAnchorRegistry } from "./board-anchors.js";
export type { BoardMatrix, BoardPoint } from "./board-types.js";

export interface BoardSurface {
  id: string;
  kind: "markdown" | "pdf";
  element: HTMLElement;
  viewportElement: HTMLElement;
  anchor: BoardAnchor;
  width: number;
  height: number;
  text: string;
  anchorAliases?: readonly string[];
  /** Logical blocks in CM may span several line and widget DOM nodes. */
  getClientRect(): BoardRect;
  /** Buffer/measurement token for an asynchronous editor-backed surface. */
  getLayoutVersion?(): string;
  /** Recomputed at use time because scrolling changes the client translation. */
  toClient(): BoardMatrix;
  project(point: BoardPoint): BoardPoint;
  unproject(point: BoardPoint): BoardPoint;
}

export class BoardSurfaceError extends Error {
  constructor(
    public readonly code: "pdf-viewport-unavailable" | "singular-transform",
  ) {
    super(code);
    this.name = "BoardSurfaceError";
  }
}

export function transformBoardPoint(
  matrix: readonly number[],
  point: BoardPoint,
): BoardPoint {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

export function invertBoardMatrix(matrix: BoardMatrix): BoardMatrix {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new BoardSurfaceError("singular-transform");
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

export function multiplyBoardMatrices(
  left: BoardMatrix,
  right: BoardMatrix,
): BoardMatrix {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

type Section = {
  sourcePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
};
const markdownSections = new WeakMap<HTMLElement, Section>();

/** Called from Obsidian's Markdown postprocessor before annotation filtering. */
export function registerMarkdownBoardSection(
  element: HTMLElement,
  sourcePath: string,
  section: { lineStart: number; lineEnd: number; text: string },
): void {
  markdownSections.set(element, { sourcePath, ...section });
}

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sourceText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const item of copy.querySelectorAll(
    ".atl-board-slot, .atl-board-overlay, .atl-board-toolbar, .atl-board-selection, .atl-rail, .atl-reading-marker",
  ))
    item.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function discoverMarkdownBoardSurfaces(
  container: HTMLElement,
  sourcePath: string,
  registry?: BoardAnchorRegistry,
): BoardSurface[] {
  const preview = container.matches(".markdown-preview-view")
    ? container
    : container.querySelector<HTMLElement>(".markdown-preview-view");
  if (!preview) return [];
  let elements = [...preview.querySelectorAll<HTMLElement>("*")].filter(
    (el) => markdownSections.get(el)?.sourcePath === sourcePath,
  );
  // A postprocessor may register a wrapper and its children. Keep the most local
  // source blocks, otherwise every stroke could belong to two coordinate spaces.
  elements = elements.filter(
    (el) => !elements.some((child) => child !== el && el.contains(child)),
  );
  if (elements.length === 0)
    elements = [
      ...preview.querySelectorAll<HTMLElement>(
        ".markdown-preview-section > div",
      ),
    ].filter(
      (el) =>
        !el.matches(
          ".mod-header, .mod-footer, .atl-board-overlay, .atl-board-toolbar",
        ),
    );
  const records = elements.filter(el=>!el.closest(".atl-board-slot"))
    .map((element) => {
      const section = markdownSections.get(element);
      const text = section
        ? section.text
            .split("\n")
            .slice(section.lineStart, section.lineEnd + 1)
            .join("\n")
            .trim()
        : sourceText(element);
      const blockId = text.match(/(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/)?.[1];
      return {
        element,
        section,
        text,
        blockId,
        key: blockId ? `block:${blockId}` : `text:${fingerprint(text)}`,
      };
    })
    .filter((record) => record.text.length > 0);
  const counts = new Map<string, number>();
  for (const record of records)
    counts.set(record.key, (counts.get(record.key) ?? 0) + 1);
  return records.flatMap((record, index): BoardSurface[] => {
    const { element, section, text } = record;
    let key = record.key;
    // Repeated paragraphs need surrounding context. If that is also identical,
    // retain an occurrence suffix; callers must not fuzzy-rebind missing anchors.
    if ((counts.get(key) ?? 0) > 1)
      key += `:${fingerprint(`${records[index - 1]?.text ?? ""}|${records[index + 1]?.text ?? ""}`)}:${records.slice(0, index).filter((other) => other.key === record.key).length}`;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    const width = element.offsetWidth || rect.width;
    const height = element.offsetHeight || rect.height;
    const toClient = (): BoardMatrix => {
      const current = element.getBoundingClientRect();
      // A paragraph growing taller or narrower is reflow, not a transform.
      // Compare its current CSS layout size so drawings keep their shape.
      return [
        current.width / (element.offsetWidth || current.width),
        0,
        0,
        current.height / (element.offsetHeight || current.height),
        current.left,
        current.top,
      ];
    };
    let anchor: Extract<BoardAnchor, { kind: "markdown" }> = {
      kind: "markdown", key, quote: text,
      ...(section ? { sourceLine: section.lineStart } : {}),
    };
    if (registry) {
      // Another split can advance the unsaved buffer before this reading view
      // rerenders. Do not let its old screen create ink on a stale source range.
      let resolved = registry.resolve(key);
      if (section) {
        const lines = section.text.split("\n");
        const from = lines.slice(0, section.lineStart).reduce((sum, line) => sum + line.length + 1, 0);
        const to = from + lines.slice(section.lineStart, section.lineEnd + 1).join("\n").length;
        if (registry.version !== boardTextVersion(section.text)
          && !registry.isRenderedPrefixCurrent(section.text, to)) return [];
        const byRange = registry.anchorForRange(from, to);
        if (byRange) resolved = registry.resolve(byRange);
      }
      // Legacy keys are only a compatibility path when no registry exists.
      // Missing or unknown blocks must not offer an immediately invisible target.
      if (resolved?.status !== "located") return [];
      anchor = registry.anchor(resolved);
    }
    return [
      {
        id: `md:${anchor.key}`,
        kind: "markdown",
        element,
        viewportElement: preview,
        anchor,
        anchorAliases: registry?.resolve(anchor)?.aliases ?? [],
        width,
        height,
        text: sourceText(element),
        getClientRect: () => element.getBoundingClientRect(),
        getLayoutVersion: registry ? () => registry.version : undefined,
        toClient,
        project: (point) => transformBoardPoint(toClient(), point),
        unproject: (point) =>
          transformBoardPoint(invertBoardMatrix(toClient()), point),
      },
    ];
  });
}

type PdfViewport = {
  width: number;
  height: number;
  transform: number[];
  clone?(options: { scale: number; rotation: number }): PdfViewport;
};
type PdfPageView = {
  div?: HTMLElement;
  viewport?: PdfViewport;
  pdfPage?: {
    getViewport(options: { scale: number; rotation: number }): PdfViewport;
  } | null;
};
type PdfViewer = { getPageView(index: number): PdfPageView | undefined };
type PdfHostView = { containerEl: HTMLElement; viewer?: unknown };

/** This is the only place that knows Obsidian's private PDF host structure. */
function pdfViewerFor(view: PdfHostView): PdfViewer | null {
  const host = view.viewer as
    | { child?: { pdfViewer?: { pdfViewer?: PdfViewer } | PdfViewer } }
    | undefined;
  const child = host?.child?.pdfViewer;
  if (
    child &&
    "pdfViewer" in child &&
    typeof child.pdfViewer?.getPageView === "function"
  )
    return child.pdfViewer;
  if (
    child &&
    "getPageView" in child &&
    typeof child.getPageView === "function"
  )
    return child;
  return null;
}

export function discoverPdfBoardSurfaces(view: PdfHostView): BoardSurface[] {
  const viewer = pdfViewerFor(view);
  const pages = [
    ...view.containerEl.querySelectorAll<HTMLElement>(
      ".pdfViewer .page[data-page-number], .pdf-viewer-container [data-page-number]",
    ),
  ];
  if (pages.length > 0 && !viewer)
    throw new BoardSurfaceError("pdf-viewport-unavailable");
  return pages.flatMap((element): BoardSurface[] => {
    const page = Number(element.dataset["pageNumber"]);
    if (!Number.isInteger(page) || page < 1) return [];
    const pageView = viewer?.getPageView(page - 1);
    if (!pageView) return [];
    if (pageView.div && pageView.div !== element)
      throw new BoardSurfaceError("pdf-viewport-unavailable");
    // PDF.js constructs every page with page 1's defaultViewport before
    // loading that page. Its size, CropBox and intrinsic rotation are only
    // authoritative after setPdfPage. Skip placeholders without taking down
    // the loaded pages or allowing ink to attach to guessed dimensions.
    if (!pageView.pdfPage) return [];
    const viewport = pageView?.viewport;
    if (!viewport) return [];
    if (
      viewport.transform.length !== 6 ||
      !viewport.transform.every(Number.isFinite) ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    )
      throw new BoardSurfaceError("pdf-viewport-unavailable");
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    const canonical = pageView.pdfPage.getViewport?.({ scale: 1, rotation: 0 });
    if (
      !canonical ||
      canonical.transform.length !== 6 ||
      !canonical.transform.every(Number.isFinite) ||
      canonical.width <= 0 ||
      canonical.height <= 0
    )
      throw new BoardSurfaceError("pdf-viewport-unavailable");
    // Canonical space is the unrotated scale-1 viewport (top-left, y down).
    // Its inverse converts to PDF space; the final viewport handles crop and
    // rotation. Neither page rotations nor PDF's y-up axis mirror our glyphs.
    const matrix = multiplyBoardMatrices(
      viewport.transform as BoardMatrix,
      invertBoardMatrix(canonical.transform as BoardMatrix),
    );
    const width = canonical.width;
    const height = canonical.height;
    const toClient = (): BoardMatrix => {
      const current = (
        element.querySelector<HTMLElement>(".canvasWrapper") ?? element
      ).getBoundingClientRect();
      return multiplyBoardMatrices(
        [
          current.width / viewport.width,
          0,
          0,
          current.height / viewport.height,
          current.left,
          current.top,
        ],
        matrix,
      );
    };
    return [
      {
        id: `pdf:${page}`,
        kind: "pdf",
        element,
        viewportElement:
          view.containerEl.querySelector<HTMLElement>(
            ".pdf-viewer-container",
          ) ?? view.containerEl,
        anchor: { kind: "pdf", page },
        width,
        height,
        text: element.querySelector(".textLayer")?.textContent ?? "",
        getClientRect: () => element.getBoundingClientRect(),
        toClient,
        project: (point) => transformBoardPoint(toClient(), point),
        unproject: (point) =>
          transformBoardPoint(invertBoardMatrix(toClient()), point),
      },
    ];
  });
}

export function discoverBoardSurfaces(
  view: PdfHostView & { getViewType?(): string },
  sourcePath: string,
  registry?: BoardAnchorRegistry,
): BoardSurface[] {
  return view.getViewType?.() === "pdf" || /\.pdf$/i.test(sourcePath)
    ? discoverPdfBoardSurfaces(view)
    : discoverMarkdownBoardSurfaces(view.containerEl, sourcePath, registry);
}

export function boardSurfaceAtPoint(
  surfaces: readonly BoardSurface[],
  point: BoardPoint,
): BoardSurface | null {
  return (
    surfaces.find((surface) => {
      const bounds = surface.getClientRect();
      return (
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height
      );
    }) ?? null
  );
}

export function boardSurfaceLayoutRevision(surface: BoardSurface): string {
  const bounds = surface.viewportElement.getBoundingClientRect();
  const current = surface.getClientRect();
  return JSON.stringify(
    [
      surface.id,
      surface.getLayoutVersion?.() ?? "",
      surface.width,
      surface.height,
      current.width,
      current.height,
      ...surface.toClient(),
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
    ].map((value) =>
      typeof value === "number" ? Math.round(value * 1000) / 1000 : value,
    ),
  );
}
