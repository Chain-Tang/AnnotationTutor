// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boardSurfaceLayoutRevision,
  discoverMarkdownBoardSurfaces,
  discoverPdfBoardSurfaces,
  invertBoardMatrix,
  registerMarkdownBoardSection,
  transformBoardPoint,
} from "../src/board-surfaces.js";
import type { BoardMatrix } from "../src/board-types.js";
import { BoardAnchorRegistry } from "../src/board-anchors.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function bounds(
  element: Element,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(x, y, width, height),
  );
}

describe("board Markdown anchors", () => {
  it("reuses source registry IDs in reading mode and exposes old keys as aliases", () => {
    const text = "# Intro\n\nEnergy stays constant. ^energy";
    const registry = new BoardAnchorRegistry(text, undefined, [{ kind: "markdown", key: "legacy-energy", quote: "Energy stays constant. ^energy", sourceLine: 2 }]);
    const root = document.createElement("div");
    root.innerHTML = '<div class="markdown-preview-view"><div class="markdown-preview-section"><div><p>Energy stays constant.</p></div></div></div>';
    document.body.append(root);
    const block = root.querySelector<HTMLElement>(".markdown-preview-section > div")!;
    registerMarkdownBoardSection(block, "Physics.md", { lineStart: 2, lineEnd: 2, text });
    bounds(block, 20, 100, 700, 40);
    const surface = discoverMarkdownBoardSurfaces(root, "Physics.md", registry)[0]!;
    expect(surface.anchor).toEqual(registry.anchorForRange(text.indexOf("Energy"), text.length));
    expect(surface.anchorAliases).toContain("legacy-energy");
    expect(surface.anchorAliases).toContain("block:energy");
    expect(surface.getClientRect()).toMatchObject({ x: 20, y: 100, width: 700, height: 40 });
  });
  it("hides stale reading blocks until the renderer catches up with an unsaved shared registry", () => {
    const before = "Energy stays constant. ^energy", after = "Energy is conserved. ^energy";
    const registry = new BoardAnchorRegistry(before);
    const root = document.createElement("div");
    root.innerHTML = '<div class="markdown-preview-view"><div class="markdown-preview-section"><div><p>Energy stays constant.</p></div></div></div>';
    document.body.append(root);
    const block = root.querySelector<HTMLElement>(".markdown-preview-section > div")!;
    bounds(block, 20, 100, 700, 40);
    registerMarkdownBoardSection(block, "Physics.md", { lineStart: 0, lineEnd: 0, text: before });
    const original = discoverMarkdownBoardSurfaces(root, "Physics.md", registry)[0]!;
    const capturedLayout = boardSurfaceLayoutRevision(original);
    registry.reconcile(after);
    expect(registry.resolve(original.anchor)!.status).toBe("located");
    expect(boardSurfaceLayoutRevision(original)).not.toBe(capturedLayout);
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)).toEqual([]);
    block.textContent = "Energy is conserved.";
    registerMarkdownBoardSection(block, "Physics.md", { lineStart: 0, lineEnd: 0, text: after });
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)[0]!.id).toBe(original.id);
  });

  it("never exposes unknown or missing legacy targets when a source registry exists", () => {
    const registry = new BoardAnchorRegistry("Removed paragraph.");
    const root = document.createElement("div");
    root.innerHTML = '<div class="markdown-preview-view"><div class="markdown-preview-section"><div>Removed paragraph.</div><div>Unknown paragraph.</div></div></div>';
    document.body.append(root);
    for (const [index, block] of [...root.querySelectorAll(".markdown-preview-section > div")].entries()) bounds(block, 20, 100 + index * 50, 700, 40);
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)).toHaveLength(1);
    const removed = registry.entries[0]!.id;
    registry.reconcile("Current paragraph.");
    expect(registry.resolve(removed)!.status).toBe("missing");
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)).toEqual([]);
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md")).toHaveLength(2);
  });
  it("retains unchanged sections after partial reading renders without rebinding shifted or extended paragraphs", () => {
    const before = "# Intro\n\nStable paragraph.";
    const registry = new BoardAnchorRegistry(before);
    const root = document.createElement("div");
    root.innerHTML = '<div class="markdown-preview-view"><div class="markdown-preview-section"><div><p>Stable paragraph.</p></div></div></div>';
    document.body.append(root);
    const block = root.querySelector<HTMLElement>(".markdown-preview-section > div")!;
    bounds(block, 20, 100, 700, 40);
    registerMarkdownBoardSection(block, "Physics.md", { lineStart: 2, lineEnd: 2, text: before });
    const original = discoverMarkdownBoardSurfaces(root, "Physics.md", registry)[0]!;
    registry.reconcile(before + "\n\nA new paragraph.");
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)[0]!.id).toBe(original.id);
    registry.reconcile("# Other\n\nStable paragraph.");
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)).toEqual([]);
    registry.reconcile(before + " Extended.");
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)).toEqual([]);
    registry.reconcile(before + "\nStill the same paragraph.");
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md", registry)).toEqual([]);
  });
  it("invalidates a captured layout when an anchored image expands without changing the block origin or scale", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="markdown-preview-view"><div class="markdown-preview-section"><div><img alt="Diagram"></div></div></div>';
    document.body.append(root);
    const block = root.querySelector<HTMLElement>(".markdown-preview-section > div")!;
    registerMarkdownBoardSection(block, "Diagram.md", { lineStart: 0, lineEnd: 0, text: "![[diagram.png]]" });
    bounds(block, 20, 100, 700, 40);
    Object.defineProperties(block, {
      offsetWidth: { value: 700, configurable: true },
      offsetHeight: { value: 40, configurable: true },
    });
    const surface = discoverMarkdownBoardSurfaces(root, "Diagram.md")[0]!;
    const matrix = surface.toClient(), revision = boardSurfaceLayoutRevision(surface);
    bounds(block, 20, 100, 700, 240);
    Object.defineProperty(block, "offsetHeight", { value: 240, configurable: true });
    expect(surface.toClient()).toEqual(matrix);
    expect(boardSurfaceLayoutRevision(surface)).not.toBe(revision);
  });

  it("keeps a block's identity and ink shape through reflow and source line movement", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="markdown-preview-view"><div class="markdown-preview-section"><div><p>Energy stays constant.</p></div></div></div>';
    document.body.append(root);
    const block = root.querySelector<HTMLElement>(
      ".markdown-preview-section > div",
    )!;
    registerMarkdownBoardSection(block, "Physics.md", {
      lineStart: 0,
      lineEnd: 0,
      text: "Energy stays constant. ^energy",
    });
    bounds(block, 100, 200, 400, 40);
    Object.defineProperties(block, {
      offsetWidth: { value: 400, configurable: true },
      offsetHeight: { value: 40, configurable: true },
    });
    const surface = discoverMarkdownBoardSurfaces(root, "Physics.md")[0]!;
    expect(surface.id).toBe("md:block:energy");
    expect(surface.project({ x: 30, y: 50 })).toEqual({ x: 130, y: 250 });
    const revision = boardSurfaceLayoutRevision(surface);
    bounds(block, 70, 400, 200, 100);
    Object.defineProperties(block, {
      offsetWidth: { value: 200, configurable: true },
      offsetHeight: { value: 100, configurable: true },
    });
    expect(surface.project({ x: 30, y: 50 })).toEqual({ x: 100, y: 450 });
    expect(boardSurfaceLayoutRevision(surface)).not.toBe(revision);
    registerMarkdownBoardSection(block, "Physics.md", {
      lineStart: 2,
      lineEnd: 2,
      text: "Inserted paragraph.\n\nEnergy stays constant. ^energy",
    });
    expect(discoverMarkdownBoardSurfaces(root, "Physics.md")[0]!.id).toBe(
      surface.id,
    );
  });

  it("uses separate anchors for repeated paragraphs and excludes nested wrappers", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="markdown-preview-view"><div class="markdown-preview-section"><div><p>Again.</p><p>Again.</p></div></div></div>';
    document.body.append(root);
    const wrapper = root.querySelector<HTMLElement>(
      ".markdown-preview-section > div",
    )!;
    registerMarkdownBoardSection(wrapper, "Note.md", {
      lineStart: 0,
      lineEnd: 2,
      text: "Again.\n\nAgain.",
    });
    for (const [index, paragraph] of [
      ...wrapper.querySelectorAll("p"),
    ].entries()) {
      bounds(paragraph, 0, index * 30, 100, 20);
      registerMarkdownBoardSection(paragraph, "Note.md", {
        lineStart: index * 2,
        lineEnd: index * 2,
        text: "Again.\n\nAgain.",
      });
    }
    const surfaces = discoverMarkdownBoardSurfaces(root, "Note.md");
    expect(surfaces).toHaveLength(2);
    expect(new Set(surfaces.map((surface) => surface.id)).size).toBe(2);
    expect(surfaces.every((surface) => surface.element.tagName === "P")).toBe(
      true,
    );
  });
});

const rotations: Array<{
  angle: number;
  matrix: BoardMatrix;
  width: number;
  height: number;
  expected: { x: number; y: number };
}> = [
  {
    angle: 0,
    matrix: [2, 0, 0, -2, -40, 1640],
    width: 1200,
    height: 1600,
    expected: { x: 120, y: 240 },
  },
  {
    angle: 90,
    matrix: [0, 2, 2, 0, -40, -40],
    width: 1600,
    height: 1200,
    expected: { x: 860, y: 220 },
  },
  {
    angle: 180,
    matrix: [-2, 0, 0, 2, 1240, -40],
    width: 1200,
    height: 1600,
    expected: { x: 680, y: 960 },
  },
  {
    angle: 270,
    matrix: [0, -2, -2, 0, 1640, 1240],
    width: 1600,
    height: 1200,
    expected: { x: 140, y: 780 },
  },
];

describe("PDF board coordinate host adapter", () => {
  it("skips unhydrated page placeholders and restores them using their own viewport after loading", () => {
    const containerEl = document.createElement("div");
    containerEl.innerHTML =
      '<div class="pdf-viewer-container"><div class="pdfViewer"><div class="page" data-page-number="1"></div><div class="page" data-page-number="2"></div><div class="page" data-page-number="3"></div></div></div>';
    document.body.append(containerEl);
    const pages = [...containerEl.querySelectorAll<HTMLElement>(".page")];
    for (const [index, page] of pages.entries())
      bounds(page, 0, index * 850, 600, 800);
    const portrait = {
      width: 600,
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    };
    const pageViews: Array<{
      div: HTMLElement;
      viewport?: typeof portrait;
      pdfPage: { getViewport(): typeof portrait } | null;
    }> = [
      {
        div: pages[0]!,
        viewport: portrait,
        pdfPage: { getViewport: () => portrait },
      },
      { div: pages[1]!, viewport: portrait, pdfPage: null },
      { div: pages[2]!, pdfPage: null },
    ];
    const view = {
      containerEl,
      viewer: {
        child: {
          pdfViewer: {
            pdfViewer: { getPageView: (index: number) => pageViews[index] },
          },
        },
      },
    };
    expect(discoverPdfBoardSurfaces(view).map((surface) => surface.id)).toEqual(
      ["pdf:1"],
    );
    const landscape = {
      width: 800,
      height: 400,
      transform: [1, 0, 0, -1, 0, 400],
    };
    pageViews[1] = {
      div: pages[1]!,
      viewport: landscape,
      pdfPage: { getViewport: () => landscape },
    };
    bounds(pages[1]!, 0, 850, 800, 400);
    const loaded = discoverPdfBoardSurfaces(view);
    expect(loaded.map((surface) => surface.id)).toEqual(["pdf:1", "pdf:2"]);
    expect(loaded[1]!.width).toBe(800);
    expect(loaded[1]!.height).toBe(400);
    expect(loaded[1]!.project({ x: 800, y: 400 })).toEqual({ x: 800, y: 1250 });
  });

  for (const test of rotations)
    it(`maps cropped scale-1 y-down coordinates through ${test.angle}° final viewport and CSS scale`, () => {
      const containerEl = document.createElement("div");
      containerEl.innerHTML =
        '<div class="pdf-viewer-container"><div class="pdfViewer"><div class="page" data-page-number="1"><div class="textLayer">Force diagram</div></div></div></div>';
      document.body.append(containerEl);
      const page = containerEl.querySelector<HTMLElement>(".page")!;
      bounds(page, 100, 200, test.width / 2, test.height / 2);
      const getViewport = vi
        .fn()
        .mockReturnValue({
          width: 600,
          height: 800,
          transform: [1, 0, 0, -1, -20, 820],
        });
      const getPageView = vi
        .fn()
        .mockReturnValue({
          div: page,
          viewport: {
            width: test.width,
            height: test.height,
            transform: test.matrix,
          },
          pdfPage: { getViewport },
        });
      const surface = discoverPdfBoardSurfaces({
        containerEl,
        viewer: { child: { pdfViewer: { pdfViewer: { getPageView } } } },
      })[0]!;
      expect(getViewport).toHaveBeenCalledWith({ scale: 1, rotation: 0 });
      expect(surface.width).toBe(600);
      expect(surface.height).toBe(800);
      expect(surface.project({ x: 20, y: 40 })).toEqual(test.expected);
      expect(surface.unproject(test.expected)).toEqual({ x: 20, y: 40 });
      const [a, b, c, d] = surface.toClient();
      expect(a * d - b * c).toBeGreaterThan(0);
      expect(surface.text).toBe("Force diagram");
    });

  it("refuses to use another split's page view or guess when PDF viewport access is missing", () => {
    const containerEl = document.createElement("div");
    containerEl.innerHTML =
      '<div class="pdf-viewer-container"><div class="page" data-page-number="1"></div></div>';
    expect(() => discoverPdfBoardSurfaces({ containerEl })).toThrow(
      "pdf-viewport-unavailable",
    );
    const getPageView = () => ({
      div: document.createElement("div"),
      viewport: { width: 20, height: 30, transform: [1, 0, 0, 1, 0, 0] },
    });
    expect(() =>
      discoverPdfBoardSurfaces({
        containerEl,
        viewer: { child: { pdfViewer: { getPageView } } },
      }),
    ).toThrow("pdf-viewport-unavailable");
  });

  it("inverts a rotated matrix without losing translation and rejects singular transforms", () => {
    const matrix: BoardMatrix = [0, 2, -3, 0, 800, 45];
    const point = { x: -20, y: 15 };
    const roundTrip = transformBoardPoint(
      invertBoardMatrix(matrix),
      transformBoardPoint(matrix, point),
    );
    expect(roundTrip.x).toBeCloseTo(point.x);
    expect(roundTrip.y).toBeCloseTo(point.y);
    expect(() => invertBoardMatrix([1, 1, 1, 1, 0, 0])).toThrow(
      "singular-transform",
    );
  });
});
