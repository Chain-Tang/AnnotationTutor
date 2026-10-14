import manifest from "../assets/fonts/manifest.json" with { type: "json" };
import type {
  BoardObject,
  BoardTextStyle,
  TutorCharacterProfile,
} from "./board-types.js";

/** Bundled, unmodified upstream WOFF2 subsets; no network fonts are used. */
export const BOARD_FONT_FAMILY =
  '"Tutor Excalifont", "Tutor Xiaolai", sans-serif';
export const BOARD_FONT_FILES: readonly {
  family: string;
  file: string;
  unicodeRange: string;
}[] = manifest;
export type BoardFontSource = {
  resolveUrl?: (path: string) => string;
  readBinary: (path: string) => Promise<ArrayBuffer | Uint8Array>;
};
let source: BoardFontSource | undefined;
let binaries = new Map<string, Promise<ArrayBuffer>>();
let documents = new WeakMap<Document, Map<string, Promise<void>>>();
let svgFaces = new Map<string, Promise<string>>();
let lastSvgCss: { key: string; pending: Promise<string> } | undefined;
let revision = 0;
let sourceRevision = 0;
let documentRevisions = new WeakMap<Document, number>();

/** Call once for the installed plugin directory; font state is per ownerDocument. */
export function configureBoardFonts(value: BoardFontSource): void {
  source = value;
  binaries = new Map();
  documents = new WeakMap();
  svgFaces = new Map();
  lastSvgCss = undefined;
  sourceRevision = ++revision;
  documentRevisions = new WeakMap();
}

/** Local text caches must be refreshed when a window receives new font metrics. */
export function boardFontRevision(doc: Document): number {
  return documentRevisions.get(doc) ?? sourceRevision;
}

const ranges = new Map<string, readonly [number, number][]>();
const subsetsByCode = new Map<number, typeof BOARD_FONT_FILES>();
function matches(range: string, code: number): boolean {
  let parsed = ranges.get(range);
  if (!parsed) {
    parsed = range.split(",").map((item) => {
      const [start, end] = item.replace(/^U\+/i, "").split("-");
      return [parseInt(start!, 16), parseInt(end ?? start!, 16)] as [
        number,
        number,
      ];
    });
    ranges.set(range, parsed);
  }
  return parsed.some(([from, to]) => code >= from && code <= to);
}
export function boardFontSubsets(text?: string): typeof BOARD_FONT_FILES {
  if (text === undefined) return BOARD_FONT_FILES;
  const needed = new Set<(typeof BOARD_FONT_FILES)[number]>();
  for (const code of new Set([...text].map((char) => char.codePointAt(0)!))) {
    let subsets = subsetsByCode.get(code);
    if (!subsets) {
      subsets = BOARD_FONT_FILES.filter((entry) => matches(entry.unicodeRange, code));
      subsetsByCode.set(code, subsets);
      if (subsetsByCode.size > 4096)
        subsetsByCode.delete(subsetsByCode.keys().next().value!);
    }
    for (const entry of subsets) needed.add(entry);
  }
  return BOARD_FONT_FILES.filter((entry) => needed.has(entry));
}
function binary(path: string): Promise<ArrayBuffer> {
  let pending = binaries.get(path);
  if (!pending) {
    if (!source) return Promise.reject(new Error("board-fonts-unavailable"));
    pending = source
      .readBinary(path)
      .then((value) => {
        const bytes =
          value instanceof ArrayBuffer ? new Uint8Array(value) : value;
        // Own the complete buffer: adapters and Buffer may expose larger backing storage.
        return Uint8Array.from(bytes).buffer;
      })
      .catch((error: unknown) => {
        binaries.delete(path);
        throw error;
      });
    binaries.set(path, pending);
  }
  return pending;
}

/** Wait before measuring, capture or SVG export. Failures are retryable, never silently visual. */
export async function ensureBoardFonts(
  doc: Document,
  text?: string,
): Promise<void> {
  const needed = boardFontSubsets(text);
  if (!needed.length) return;
  const FontFaceCtor = (
    doc.defaultView as (Window & { FontFace?: typeof FontFace }) | null
  )?.FontFace;
  if (!FontFaceCtor || !doc.fonts) throw new Error("board-fonts-unavailable");
  let faces = documents.get(doc);
  if (!faces) {
    faces = new Map();
    documents.set(doc, faces);
  }
  await Promise.all(
    needed.map((entry) => {
      let pending = faces.get(entry.file);
      if (!pending) {
        pending = (async () => {
          const face = new FontFaceCtor(
            `Tutor ${entry.family}`,
            await binary(entry.file),
            {
              unicodeRange: entry.unicodeRange,
              style: "normal",
              weight: "400",
            },
          );
          await face.load();
          doc.fonts.add(face);
          documentRevisions.set(doc, ++revision);
        })().catch((error: unknown) => {
          faces.delete(entry.file);
          throw error;
        });
        faces.set(entry.file, pending);
      }
      return pending;
    }),
  );
  await doc.fonts.ready;
}

/** Portable preview CSS embeds only the subsets needed by the exported objects. */
export async function boardFontSvgCss(text: string): Promise<string> {
  const needed = boardFontSubsets(text);
  const key = needed.map((entry) => entry.file).join("\n");
  if (lastSvgCss?.key === key) return lastSvgCss.pending;
  const pending = Promise.all(
    needed.map((entry) => {
      let css = svgFaces.get(entry.file);
      if (!css) {
        css = binary(entry.file)
          .then((bytes) => {
            const raw=new Uint8Array(bytes);let text="";for(let i=0;i<raw.length;i+=8192)text+=String.fromCharCode(...raw.subarray(i,i+8192));const data=btoa(text);
            return `@font-face{font-family:"Tutor ${entry.family}";src:url("data:font/woff2;base64,${data}") format("woff2");font-style:normal;font-weight:400;unicode-range:${entry.unicodeRange}}`;
          })
          .catch((error: unknown) => {
            svgFaces.delete(entry.file);
            throw error;
          });
        svgFaces.set(entry.file, css);
      }
      return css;
    }),
  ).then((faces) => faces.join("\n"));
  lastSvgCss = { key, pending };
  try {
    return await pending;
  } catch (error) {
    if (lastSvgCss?.pending === pending) lastSvgCss = undefined;
    throw error;
  }
}

/** Include nested co-created text while avoiding recursive asset graphs. */
export function boardHandwrittenText(
  objects: readonly BoardObject[],
  profiles: readonly TutorCharacterProfile[] = [],
  seen = new Set<string>(),
): string {
  return objects
    .map((object) => {
      if (object.kind === "text" && object.textStyle?.font === "handwritten")
        return object.text ?? "";
      if (object.kind !== "character" && object.kind !== "sticker") return "";
      const id =
        object.kind === "sticker" ? object.assetId : object.characterId;
      const version =
        object.kind === "sticker"
          ? object.assetVersion
          : object.characterVersion;
      const key = `${id}:${version}`;
      if (seen.has(key) || seen.size >= 8) return "";
      const profile = profiles.find(
        (entry) => entry.id === id && entry.version === version,
      );
      return boardHandwrittenText(
        profile?.objects ?? [],
        profiles,
        new Set([...seen, key]),
      );
    })
    .join("\n");
}

export type BoardTextMeasure = (text: string, style: BoardTextStyle) => number;
export type BoardTextLayout = {
  lines: { text: string; x: number; y: number; width: number }[];
  width: number;
  height: number;
  lineHeight: number;
};
export function boardFontCss(style: BoardTextStyle): string {
  return `${style.size}px ${style.font === "handwritten" ? BOARD_FONT_FAMILY : "sans-serif"}`;
}
export function resolvedBoardTextStyle(
  object: Pick<BoardObject, "textStyle" | "text" | "height">,
): BoardTextStyle {
  return (
    object.textStyle ?? {
      font: "sans",
      align: "left",
      size: Math.max(
        1,
        Math.min(
          48,
          object.height /
            Math.max(1, (object.text ?? "").split("\n").length) /
            1.2,
        ),
      ),
    }
  );
}
const measurers = new WeakMap<Document, BoardTextMeasure>();
export function boardTextMeasurer(doc: Document): BoardTextMeasure {
  const existing = measurers.get(doc);
  if (existing) return existing;
  const context = doc.createElement("canvas").getContext("2d");
  let measuredRevision = boardFontRevision(doc);
  const widths = new Map<string, number>();
  const measure: BoardTextMeasure = (text, style) => {
    const currentRevision = boardFontRevision(doc);
    if (measuredRevision !== currentRevision) {
      widths.clear();
      measuredRevision = currentRevision;
    }
    if (!context) return fallbackMeasure(text, style);
    const font = boardFontCss(style);
    const key = `${font}\n${text}`;
    const existingWidth = widths.get(key);
    if (existingWidth !== undefined) return existingWidth;
    if (context.font !== font) context.font = font;
    const width = context.measureText(text).width;
    widths.set(key, width);
    if (widths.size > 2048) widths.delete(widths.keys().next().value!);
    return width;
  };
  measurers.set(doc, measure);
  return measure;
}
function fallbackMeasure(text: string, style: BoardTextStyle): number {
  return (
    [...text].reduce(
      (sum, char) =>
        sum +
        (/[^\u0000-\u00ff]/.test(char) ? 1 : /\s/.test(char) ? 0.32 : 0.6),
      0,
    ) * style.size
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Wraps grapheme clusters and word boundaries at measured widths; never stretches glyphs. */
export function layoutBoardText(
  text: string,
  style: BoardTextStyle,
  maxWidth: number,
  measure: BoardTextMeasure = fallbackMeasure,
): BoardTextLayout {
  const limit = Math.max(1, maxWidth),
    lineHeight = style.size * 1.25;
  const strings: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    const clusters = [...graphemes.segment(paragraph)].map(
      (item) => item.segment,
    );
    if (!clusters.length) {
      strings.push("");
      continue;
    }
    let line = "";
    for (const cluster of clusters) {
      const candidate = line + cluster;
      if (line && measure(candidate, style) > limit) {
        // Keep ordinary Latin words together when an earlier break exists. CJK
        // naturally wraps per grapheme; a long URL/word can also break safely.
        const breakAt = line.search(/\s+\S*$/u);
        if (
          breakAt > 0 &&
          !/^\s$/u.test(cluster) &&
          !/[^\u0000-\u024f]/u.test(line.slice(breakAt))
        ) {
          const prefix = line.slice(0, breakAt),
            remainder = line.slice(breakAt).trimStart() + cluster;
          if (measure(remainder, style) <= limit) {
            strings.push(prefix);
            line = remainder;
            continue;
          }
        }
        strings.push(line.trimEnd());
        line = /^\s$/u.test(cluster) ? "" : cluster;
      } else line = candidate;
    }
    strings.push(line);
  }
  const lines = strings.map((value, index) => {
    const width = measure(value, style);
    const x =
      style.align === "center"
        ? (limit - width) / 2
        : style.align === "right"
          ? limit - width
          : 0;
    return {
      text: value,
      x: Math.max(0, x),
      y: style.size + index * lineHeight,
      width,
    };
  });
  return {
    lines,
    width: Math.max(0, ...lines.map((line) => line.width)),
    height: Math.max(1, lines.length) * lineHeight,
    lineHeight,
  };
}
