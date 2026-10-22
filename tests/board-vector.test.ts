// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { boardVectorAssetSchema } from "../src/board-model.js";
import { exportVectorAssetSvg, importSafeSvg, parseSvgPathData, parseSvgTransform, renderVectorAssetCanvas } from "../src/board-vector.js";
import { renderBoardSvg } from "../src/board-renderer.js";
import type { BoardObject } from "../src/board-types.js";

describe("safe structured vector scenes", () => {
  it("normalizes relative, shorthand, curve and arc commands", () => {
    const commands = parseSvgPathData("M10 10 h20 v20 q10 10 20 0 t20 0 c1 2 3 4 5 6 s7 8 9 10 a5 6 30 0 1 10 10z");
    expect(commands.map(command => command.op)).toEqual(["M", "L", "L", "Q", "Q", "C", "C", "A", "Z"]);
    expect(commands[1]).toEqual({ op: "L", x: 30, y: 10 });
    expect(commands.at(-2)).toMatchObject({ op: "A", rx: 5, ry: 6, largeArc: false, sweep: true });
    expect(parseSvgPathData("M0 0L1 1M10 10L11 11").map(command => command.op)).toEqual(["M", "L", "M", "L"]);
  });

  it("imports a safe subset, expands internal use and round-trips named curves", () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
      <defs><linearGradient id="skin"><stop offset="0" stop-color="#ffd5c2"/><stop offset="1" stop-color="#ef9f89"/></linearGradient>
      <g id="eye"><path id="lid" data-tutor-role="eye" d="M0 5 Q10 0 20 5" fill="none" stroke="#222" stroke-width="2"/></g></defs>
      <g id="face" data-name="Face"><ellipse id="head" cx="60" cy="40" rx="30" ry="35" fill="url(#skin)"/><use href="#eye" x="35" y="30"/></g>
    </svg>`;
    const imported = importSafeSvg(source, { id: "anime-face", name: "Anime face" });
    expect(imported.asset.nodes.some(node => node.semanticRole === "eye")).toBe(true);
    expect(imported.asset.nodes.some(node => node.fill?.kind === "linear-gradient")).toBe(true);
    expect(boardVectorAssetSchema.safeParse(imported.asset).success).toBe(true);
    const exported = exportVectorAssetSvg(imported.asset);
    expect(exported).toContain("<linearGradient");
    expect(exported).toContain("Q10 0 20 5");
    const reopened = importSafeSvg(exported, { id: "anime-face-copy" });
    expect(reopened.asset.nodes.length).toBe(imported.asset.nodes.length);
    expect(reopened.asset.nodes.some(node => node.semanticRole === "eye")).toBe(true);
  });

  it("rejects executable, external, filtered and over-complex input", () => {
    expect(() => importSafeSvg(`<svg><script>alert(1)</script></svg>`, { id: "unsafe" })).toThrow(/Unsafe SVG element/);
    expect(() => importSafeSvg(`<svg><use href="https://evil.example/a.svg#x"/></svg>`, { id: "unsafe" })).toThrow(/External SVG/);
    expect(() => importSafeSvg(`<svg><path style="fill:red" d="M0 0L1 1"/></svg>`, { id: "unsafe" })).toThrow(/Unsafe SVG attribute/);
    expect(() => importSafeSvg(`<svg><filter id="x"/></svg>`, { id: "unsafe" })).toThrow(/Unsafe SVG element/);
  });

  it("preserves internal clip paths without allowing external references", () => {
    const source = `<svg viewBox="0 0 100 100"><defs><clipPath id="face-clip"><circle id="clip-circle" cx="50" cy="50" r="40"/></clipPath></defs><rect id="skin" x="0" y="0" width="100" height="100" fill="#ffd5c2" clip-path="url(#face-clip)"/></svg>`;
    const asset = importSafeSvg(source, { id: "clipped-face" }).asset;
    expect(asset.nodes.find(node => node.id === "skin")?.clipPathId).toBe("face-clip");
    expect(asset.nodes.find(node => node.id === "face-clip")?.semanticRole).toBe("clip-path");
    const svg = exportVectorAssetSvg(asset);
    expect(svg).toContain('<clipPath id="face-clip">');
    expect(svg).toContain('clip-path="url(#face-clip)"');
    expect(importSafeSvg(svg, { id: "clipped-face-copy" }).asset.nodes.find(node => node.id === "skin")?.clipPathId).toBe("face-clip");
  });

  it("renders a versioned vector asset inside an ordinary board object", () => {
    const asset = importSafeSvg(`<svg viewBox="0 0 10 10"><path id="curve" d="M0 10 C2 0 8 0 10 10" fill="none" stroke="#7257d8" stroke-width="1"/></svg>`, { id: "curve" }).asset;
    const object: BoardObject = {
      id: "vector-object", kind: "vector", vectorAssetId: "curve", vectorAssetVersion: 1,
      anchor: { kind: "canvas", pageId: "page" }, x: 20, y: 30, width: 200, height: 100,
      color: "#7257d8", strokeWidth: 1, createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "ai-vector",
    };
    const svg = renderBoardSvg([object], { width: 400, height: 300, ink: {}, characters: [], vectorAssets: [asset] });
    expect(svg).toContain('transform="matrix(1 0 0 1 20 30)"');
    expect(svg).toContain('width="200" height="100" viewBox="0 0 10 10"');
    expect(svg).toContain("C2 0 8 0 10 10");
  });

  it("parses transform lists deterministically", () => {
    expect(parseSvgTransform("translate(10 20) scale(2)")).toEqual([2, 0, 0, 2, 10, 20]);
  });

  it("clips Canvas rendering to the same vector viewport as SVG export", () => {
    const asset = importSafeSvg('<svg viewBox="0 0 10 10"><g id="root"/></svg>', { id: "clipped-canvas" }).asset;
    const calls: string[] = [];
    const context = {
      globalAlpha: 1, globalCompositeOperation: "source-over",
      save: () => calls.push("save"), beginPath: () => calls.push("begin"),
      rect: (x: number, y: number, width: number, height: number) => calls.push(`rect:${x},${y},${width},${height}`),
      clip: () => calls.push("clip"), scale: () => calls.push("scale"),
      transform: () => calls.push("transform"), fill: () => calls.push("fill"), restore: () => calls.push("restore"),
    } as unknown as CanvasRenderingContext2D;
    renderVectorAssetCanvas(context, asset, 200, 100);
    expect(calls.slice(0, 5)).toEqual(["save", "begin", "rect:0,0,200,100", "clip", "scale"]);
  });
});
