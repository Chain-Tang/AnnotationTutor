// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  builtInTutorCharacters,
  tutorCharacterExpressions,
  tutorCharacterPrimitives,
} from "../src/board-characters.js";
import {
  materialRasterBudget,
  materialRasterScale,
  normalizedBoardPoints,
  prepareBoardCanvas,
  renderBoardCanvas,
  renderBoardSvg,
} from "../src/board-renderer.js";
import { defaultBoardBrush } from "../src/board-brushes.js";
import { configureBoardFonts, ensureBoardFonts } from "../src/board-fonts.js";
import type { BoardMatrix, BoardObject, TutorCharacterProfile } from "../src/board-types.js";

it("matches textured raster resolution to device zoom without overfilling the cache", () => {
  expect(materialRasterScale({ a: .82, b: 0, c: 0, d: .82 })).toBe(1);
  expect(materialRasterScale({ a: 2, b: 0, c: 0, d: 2 })).toBe(2);
  expect(materialRasterScale({ a: .2, b: 0, c: 0, d: .2 })).toBe(.5);
});

it("bounds material cache memory while retaining enough strokes for a large viewport", () => {
  expect(materialRasterBudget(1154, 1396)).toBe(12_000_000);
  expect(materialRasterBudget(2400, 1800)).toBe(25_920_000);
  expect(materialRasterBudget(8000, 8000)).toBe(32_000_000);
});

function object(overrides: Partial<BoardObject> = {}): BoardObject {
  return {
    id: "object-1",
    kind: "rect",
    anchor: { kind: "pdf", page: 1 },
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    color: "#45404b",
    strokeWidth: 2,
    createdBy: "human",
    editedBy: "human",
    revision: 1,
    groupId: "group-1",
    ...overrides,
  };
}
const defaults = {
  width: 600,
  height: 800,
  ink: {},
  characters: builtInTutorCharacters(),
};

describe("portable board rendering", () => {
  it("reuses renderer lookup tables across interleaved surfaces and preserves wrapper output order", () => {
    const layers = [{ id: "front", name: "Front", order: 1, visible: true, locked: false, opacity: 0.4, blendMode: "multiply" as const },
      { id: "hidden", name: "Hidden", order: 0, visible: false, locked: false, opacity: 1, blendMode: "normal" as const }];
    const iterations = vi.fn(layers.map.bind(layers));
    const observed = new Proxy(layers, { get(target, key, receiver) { return key === "map" ? iterations : Reflect.get(target, key, receiver); } });
    const objects = [object({ id: "first", color: "#110000", layerId: "front" }), object({ id: "second", color: "#220000" }),
      object({ id: "hidden", layerId: "hidden" }), object({ id: "third", color: "#330000", layerId: "front" })];
    const record = () => {
      const calls: unknown[] = [];
      const context = new Proxy({ canvas: document.createElement("canvas"), globalAlpha: 1 } as unknown as CanvasRenderingContext2D, {
        get(target, key, receiver) { return Reflect.get(target, key, receiver) ?? ((...args: unknown[]) => calls.push([key, ...args])); },
        set(target, key, value) { calls.push([key, value]); return Reflect.set(target, key, value); },
      });
      return { context, calls };
    };
    const baseline = record(), prepared = record();
    const options = { ...defaults, layers: observed };
    const draw = prepareBoardCanvas(prepared.context, options);
    expect(iterations).toHaveBeenCalledOnce();
    const transforms: BoardMatrix[] = [[1, 0, 0, 1, 20, 40], [0, 2, -2, 0, 300, 50]];
    objects.forEach((item, index) => {
      const matrix = transforms[index % 2]!;
      prepared.context.transform(...matrix); draw([item]);
    });
    expect(iterations).toHaveBeenCalledOnce();
    objects.forEach((item, index) => {
      baseline.context.transform(...transforms[index % 2]!); renderBoardCanvas(baseline.context, [item], options);
    });
    expect(prepared.calls).toEqual(baseline.calls);
    expect(prepared.calls.filter(call => Array.isArray(call) && call[0] === "strokeStyle").map(call => (call as unknown[])[1]))
      .toEqual(["#110000", "#220000", "#330000"]);
  });
  it("renders solid fill as a colour, without allocating a paper/grain pattern",()=>{
    const fillStyles:string[]=[];
    const createPattern=vi.fn();
    const context=new Proxy({globalAlpha:1,createPattern} as unknown as CanvasRenderingContext2D,{
      get:(target,key)=>Reflect.get(target,key)??(()=>{}),
      set:(target,key,value)=>{if(key==='fillStyle')fillStyles.push(String(value));return Reflect.set(target,key,value);},
    });
    renderBoardCanvas(context,[object({fill:{kind:'solid',color:'#ff0000',opacity:1,seed:1}})],defaults);
    expect(fillStyles).toContain('#ff0000');expect(createPattern).not.toHaveBeenCalled();
  });
  it("exports material-filled paths through clipped native dabs and preserves inner holes",()=>{
    const shape=object({kind:'path',points:[{x:0,y:0},{x:100,y:0},{x:100,y:50},{x:0,y:50},{x:0,y:0},
      {x:30,y:10},{x:30,y:40},{x:70,y:40},{x:70,y:10},{x:30,y:10},{x:0,y:0}],
      fill:{kind:'brush',color:'#dd3344',opacity:.8,seed:7,brush:defaultBoardBrush('crayon',7)}});
    const first=renderBoardSvg([shape],defaults);
    expect(first).toContain('<clipPath');expect(first).toContain('clip-rule="nonzero"');expect(first).toContain('clip-path="url(#brush-region-0)"');
    expect(first).toContain('#dd3344');expect(first).not.toContain('<image');
    expect(renderBoardSvg([shape],defaults)).toBe(first);
  });
  it("keeps thin pencil contours vector-based without expanding into thousands of grains",()=>{
    const contour=object({kind:'path',strokeWidth:1,brush:defaultBoardBrush('pencil',7),
      points:[{x:0,y:0},{x:100,y:0},{x:100,y:50},{x:0,y:50},{x:0,y:0}]});
    const svg=renderBoardSvg([contour],defaults);
    expect(svg).toContain('<path');expect(svg).toContain('<pattern');expect(svg).not.toContain('<image');
    expect(svg.length).toBeLessThan(40000);
    expect(renderBoardSvg([contour],defaults)).toBe(svg);
  });
  it("resizes stable ink from its own bounds and leaves original pressure/time samples untouched", () => {
    const points = [
      { x: 20, y: 30, pressure: 0.4, t: 10 },
      { x: 70, y: 130, pressure: 0.8, t: 20 },
    ];
    expect(normalizedBoardPoints(points, 100, 50)).toEqual([
      { x: 0, y: 0, pressure: 0.4, t: 10 },
      { x: 100, y: 50, pressure: 0.8, t: 20 },
    ]);
    expect(points[0]!.x).toBe(20);
    const svg = renderBoardSvg([object({ kind: "ink", inkId: "stroke-1" })], {
      ...defaults,
      ink: { "stroke-1": { id: "stroke-1", createdAt: "today", points } },
    });
    expect(svg).toContain('d="M0 0 L100 50"');
    expect(svg).toContain('transform="matrix(1 0 0 1 10 20)"');
  });

  it("exports a highlighter stroke as one opacity group so self-overlap does not darken", () => {
    const svg = renderBoardSvg([object({
      kind: "ink", inkId: "highlight", brush: defaultBoardBrush("highlighter", 7), strokeWidth: 18,
    })], {
      ...defaults,
      ink: { highlight: { id: "highlight", createdAt: "today", points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 20, y: 0 }] } },
    });
    expect(svg).toMatch(/<g opacity="0\.[0-9]+"><rect/);
  });

  it("keeps all six original vector expressions distinct for both built-in characters", () => {
    for (const profile of defaults.characters) {
      const expressions = tutorCharacterExpressions.map((expression) =>
        JSON.stringify(
          tutorCharacterPrimitives(
            profile.style === "book" ? "book" : "round",
            expression,
          ),
        ),
      );
      expect(new Set(expressions).size).toBe(6);
      for (const expression of tutorCharacterExpressions) {
        const svg = renderBoardSvg(
          [
            object({
              kind: "character",
              characterId: profile.id,
              characterVersion: 1,
              expression,
            }),
          ],
          defaults,
        );
        expect(svg).toContain("<ellipse");
        expect(svg).toContain("<path");
        expect(svg).not.toContain("<image");
      }
    }
  });

  it("uses the referenced historical character version and prevents recursive co-created profiles", () => {
    const old: TutorCharacterProfile = {
      id: "custom",
      version: 1,
      name: "Old",
      origin: "co_created",
      style: "custom",
      width: 100,
      height: 50,
      createdAt: "today",
      objects: [object({ kind: "ellipse" })],
    };
    const newer: TutorCharacterProfile = {
      ...old,
      version: 2,
      objects: [object({ kind: "text", text: "new version" })],
    };
    const recursive: TutorCharacterProfile = {
      ...old,
      id: "recursive",
      objects: [
        object({
          kind: "character",
          characterId: "recursive",
          characterVersion: 1,
        }),
      ],
    };
    const svg = renderBoardSvg(
      [
        object({
          kind: "character",
          characterId: "custom",
          characterVersion: 1,
        }),
        object({
          kind: "character",
          characterId: "recursive",
          characterVersion: 1,
        }),
      ],
      { ...defaults, characters: [old, newer, recursive] },
    );
    expect(svg).toContain("<ellipse");
    expect(svg).not.toContain("new version");
    expect(svg.length).toBeLessThan(1000);
  });

  it("escapes text and image URLs and refuses executable references", () => {
    const profile: TutorCharacterProfile = {
      id: "upload",
      version: 1,
      name: "My character",
      origin: "uploaded",
      style: "custom",
      width: 100,
      height: 100,
      assetPath: "characters/asset.png",
      createdAt: "today",
    };
    const objects = [
      object({ kind: "text", text: '<script>alert("x")</script>&' }),
      object({
        kind: "character",
        characterId: profile.id,
        characterVersion: 1,
      }),
    ];
    const svg = renderBoardSvg(objects, {
      ...defaults,
      characters: [profile],
      resolveAsset: () => "javascript:alert(1)",
    });
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(parsed.querySelector("script")).toBeNull();
    expect(parsed.querySelector("image")).toBeNull();
    expect(
      [...parsed.querySelectorAll("text")]
        .map((node) => node.textContent)
        .join(""),
    ).toBe('<script>alert("x")</script>&');
    const image = renderBoardSvg(objects.slice(1), {
      ...defaults,
      characters: [profile],
      resolveAsset: () => "data:image/png;base64,AAAA",
    });
    expect(image).toContain('href="data:image/png;base64,AAAA"');
  });
});

function canvasRecorder() {
  const paths: string[] = [];
  let path = "";
  const command = (op: string, values: number[]) => {
    path += `${path ? " " : ""}${op}${values.map((n) => Math.round(n * 10000) / 10000).join(" ")}`;
  };
  const context = {
    canvas: { ownerDocument: document },
    save: vi.fn(),
    restore: vi.fn(),
    transform: vi.fn(),
    beginPath: () => {
      path = "";
    },
    moveTo: (...values: number[]) => command("M", values),
    lineTo: (...values: number[]) => command("L", values),
    bezierCurveTo: (...values: number[]) => command("C", values),
    closePath: () => {
      path += " Z";
    },
    rect: vi.fn(),
    ellipse: vi.fn(),
    stroke: () => paths.push(path),
    fill: () => paths.push(path),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: [...text].length * 10 })),
    font: "",
    fillStyle: "",
    textBaseline: "",
    textAlign: "",
  };
  return {
    context: context as unknown as CanvasRenderingContext2D,
    paths,
    fillText: context.fillText,
    measureText: context.measureText,
  };
}

describe("editable handwriting and sketch rendering", () => {
  it("reuses text layout when moving or redrawing and remeasures when text geometry changes", () => {
    const { context, measureText, fillText } = canvasRecorder();
    const item = object({
      kind: "text", text: "为什么", width: 25,
      textStyle: { font: "handwritten", size: 20, align: "left" },
    });
    renderBoardCanvas(context, [item], defaults);
    const initialMeasurements = measureText.mock.calls.length;
    renderBoardCanvas(context, [{ ...item, x: 40, y: 80, color: "#f00" }], defaults);
    expect(measureText).toHaveBeenCalledTimes(initialMeasurements);
    expect(fillText.mock.calls.slice(-2)).toEqual([["为什", 0, 20], ["么", 0, 45]]);
    renderBoardCanvas(context, [{ ...item, width: 100 }], defaults);
    expect(measureText.mock.calls.length).toBeGreaterThan(initialMeasurements);
    expect(fillText.mock.calls.at(-1)).toEqual(["为什么", 0, 20]);
    const widthMeasurements = measureText.mock.calls.length;
    renderBoardCanvas(context, [{ ...item, text: "继续" }], defaults);
    expect(measureText.mock.calls.length).toBeGreaterThan(widthMeasurements);
    expect(fillText.mock.calls.at(-1)).toEqual(["继续", 0, 20]);
  });

  it("refreshes cached layout after the target window finishes loading handwriting fonts", async () => {
    const { context, measureText, fillText } = canvasRecorder();
    class Face { async load() { return this; } }
    const doc = {
      defaultView: { FontFace: Face },
      fonts: { add: vi.fn(), ready: Promise.resolve() },
    } as unknown as Document;
    Object.assign(context.canvas, { ownerDocument: doc });
    configureBoardFonts({ readBinary: async () => new Uint8Array([119, 79, 70, 50]) });
    const item = object({
      kind: "text", text: "ABC", width: 25,
      textStyle: { font: "handwritten", size: 20, align: "left" },
    });
    renderBoardCanvas(context, [item], defaults);
    expect(fillText.mock.calls).toEqual([["AB", 0, 20], ["C", 0, 45]]);
    measureText.mockImplementation((text) => ({ width: [...text].length * 8 }));
    await ensureBoardFonts(doc, "ABC");
    fillText.mockClear();
    renderBoardCanvas(context, [item], defaults);
    expect(fillText.mock.calls).toEqual([["ABC", 0, 20]]);
  });

  it("does not cache caller-supplied measurements whose external state can change", () => {
    const { context, fillText } = canvasRecorder();
    let glyphWidth = 10;
    const measureText = (text: string) => [...text].length * glyphWidth;
    const item = object({ kind: "text", text: "ABC", width: 25 });
    renderBoardCanvas(context, [item], { ...defaults, measureText });
    glyphWidth = 8;
    fillText.mockClear();
    renderBoardCanvas(context, [item], { ...defaults, measureText });
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(["ABC"]);
  });

  it("resolves nested asset ink with local precedence without traversing unrelated strokes", () => {
    const item = object({ kind: "ink", inkId: "shared" });
    const parentInk = { shared: { id: "shared", createdAt: "today", points: [{ x: 0, y: 0 }, { x: 0, y: 50 }] } };
    const childInk = { shared: { id: "shared", createdAt: "today", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } };
    const base: TutorCharacterProfile = {
      id: "parent", version: 1, name: "parent", origin: "co_created", style: "custom",
      width: 100, height: 50, createdAt: "today",
    };
    const child = { ...base, id: "child", objects: [item], ink: childInk };
    const parent = { ...base, objects: [item, object({ kind: "sticker", assetId: "child", assetVersion: 1 })], ink: parentInk };
    const rootInk = {};
    Object.defineProperty(rootInk, "unrelated", {
      enumerable: true, get: () => { throw new Error("Unrelated ink was copied"); },
    });
    const svg = renderBoardSvg([object({ kind: "sticker", assetId: "parent", assetVersion: 1 })], {
      ...defaults, ink: rootInk, characters: [parent, child],
    });
    expect(svg).toContain('d="M50 0 L50 50"');
    expect(svg).toContain('d="M0 25 L100 25"');
  });

  it("uses actual canvas text measurements to wrap instead of fillText maxWidth compression", () => {
    const { context, fillText } = canvasRecorder();
    renderBoardCanvas(
      context,
      [
        object({
          kind: "text",
          text: "为什么会这样？",
          width: 35,
          textStyle: { font: "handwritten", size: 20, align: "center" },
        }),
      ],
      defaults,
    );
    expect(fillText.mock.calls).toEqual([
      ["为什么", 2.5, 20],
      ["会这样", 2.5, 45],
      ["？", 12.5, 70],
    ]);
    expect(context.font).toContain('"Tutor Excalifont"');
    const svg = renderBoardSvg(
      [
        object({
          kind: "text",
          text: "为什么会这样？",
          width: 35,
          textStyle: { font: "handwritten", size: 20, align: "center" },
        }),
      ],
      {
        ...defaults,
        measureText: (text) => [...text].length * 10,
        fontCss:
          '@font-face{font-family:"Tutor Xiaolai";src:url(data:font/woff2;base64,d09GMg==)}',
      },
    );
    expect(svg).not.toMatch(/textLength|lengthAdjust/);
    expect(svg).toContain("data:font/woff2;base64,d09GMg==");
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(
      [...parsed.querySelectorAll("text")].map((node) => [
        node.textContent,
        node.getAttribute("x"),
        node.getAttribute("y"),
      ]),
    ).toEqual([
      ["为什么", "2.5", "20"],
      ["会这样", "2.5", "45"],
      ["？", "12.5", "70"],
    ]);
  });

  it("draws exactly the same seeded rough curves in canvas and SVG, across redraws and positions", () => {
    for (const kind of ["rect", "ellipse", "path", "arrow"] as const) {
      const item = object({
        kind,
        points: [
          { x: 0, y: 0 },
          { x: 30, y: 40 },
          { x: 100, y: 50 },
        ],
        drawingStyle: { kind: "sketch", seed: 71 },
      });
      const { context, paths } = canvasRecorder();
      renderBoardCanvas(context, [item], defaults);
      const svg = renderBoardSvg([item], defaults);
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(
        [...parsed.querySelectorAll("path")].map((node) =>
          node.getAttribute("d"),
        ),
      ).toEqual(paths);
      expect(renderBoardSvg([item], defaults)).toBe(svg);
      expect(
        renderBoardSvg(
          [{ ...item, drawingStyle: { kind: "sketch", seed: 72 } }],
          defaults,
        ),
      ).not.toBe(svg);
      const moved = new DOMParser().parseFromString(
        renderBoardSvg([{ ...item, x: 44, y: 77 }], defaults),
        "image/svg+xml",
      );
      expect(
        [...moved.querySelectorAll("path")].map((node) =>
          node.getAttribute("d"),
        ),
      ).toEqual(paths);
    }
  });

  it("keeps original handwriting exact even if an ink object carries a sketch property", () => {
    const item = object({
      kind: "ink",
      inkId: "raw",
      drawingStyle: { kind: "sketch", seed: 71 },
    });
    const svg = renderBoardSvg([item], {
      ...defaults,
      ink: {
        raw: {
          id: "raw",
          createdAt: "today",
          points: [
            { x: 0, y: 0 },
            { x: 30, y: 40 },
          ],
        },
      },
    });
    expect(svg).toContain('d="M0 0 L100 50"');
    expect(svg).not.toMatch(/d="[^"]*C/);
  });

  it("places a versioned sticker independently from the current Tutor character", () => {
    const profile: TutorCharacterProfile = {
      id: "expression",
      version: 1,
      name: "颜文字",
      origin: "co_created",
      style: "custom",
      width: 100,
      height: 50,
      createdAt: "today",
      usage: "sticker",
      objects: [
        object({
          kind: "text",
          text: "(^_^)",
          textStyle: { font: "handwritten", size: 16, align: "left" },
        }),
      ],
    };
    const svg = renderBoardSvg(
      [object({ kind: "sticker", assetId: "expression", assetVersion: 1 })],
      {
        ...defaults,
        characters: [profile, { ...profile, version: 2, objects: [] }],
      },
    );
    expect(svg).toContain("(^_^)");
    expect(svg).toContain("Tutor Excalifont");
  });
});
