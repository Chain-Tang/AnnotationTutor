// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import {
  BOARD_FONT_FILES,
  boardFontCss,
  boardFontSubsets,
  boardFontSvgCss,
  boardHandwrittenText,
  boardTextMeasurer,
  configureBoardFonts,
  ensureBoardFonts,
  layoutBoardText,
  resolvedBoardTextStyle,
} from "../src/board-fonts.js";
import type {
  BoardTextStyle,
  BoardObject,
  TutorCharacterProfile,
} from "../src/board-types.js";

const handwritten: BoardTextStyle = {
  font: "handwritten",
  size: 20,
  align: "left",
};
const width = (text: string): number =>
  [...text].reduce(
    (n, ch) => n + (/\s/.test(ch) ? 5 : /[A-Z]/.test(ch) ? 14 : 10),
    0,
  );
const fakeSource = () => {
  const readBinary = vi.fn(async () => new Uint8Array([119, 79, 70, 50]));
  configureBoardFonts({ readBinary });
  return readBinary;
};
function fontDocument() {
  const added: unknown[] = [];
  class Face {
    constructor(
      readonly family: string,
      readonly bytes: ArrayBuffer,
      readonly descriptors: unknown,
    ) {}
    async load() {
      return this;
    }
  }
  return {
    doc: {
      defaultView: { FontFace: Face },
      fonts: {
        add: (face: unknown) => added.push(face),
        ready: Promise.resolve(),
      },
    } as unknown as Document,
    added,
  };
}

describe("offline board fonts", () => {
  beforeEach(() => fakeSource());
  it("ships every declared font subset with an actual WOFF2 header and both license notices", () => {
    expect(BOARD_FONT_FILES.length).toBe(216);
    for (const entry of BOARD_FONT_FILES)
      expect(readFileSync(entry.file).subarray(0, 4).toString()).toBe("wOF2");
    for (const file of [
      "OFL.txt",
      "Excalifont-NOTICE.txt",
      "Xiaolai-NOTICE.txt",
    ])
      expect(readFileSync(`assets/fonts/${file}`, "utf8")).toMatch(
        /SIL Open Font License|SIL OPEN FONT LICENSE/,
      );
  });
  it("loads matching Latin and Chinese subsets for each owner document while sharing only font bytes", async () => {
    const read = fakeSource(),
      one = fontDocument(),
      two = fontDocument();
    const needed = boardFontSubsets("A为什么？");
    expect(new Set(needed.map((item) => item.family))).toEqual(
      new Set(["Excalifont", "Xiaolai"]),
    );
    expect(needed.length).toBeLessThan(20);
    await Promise.all([
      ensureBoardFonts(one.doc, "A为什么？"),
      ensureBoardFonts(one.doc, "A为什么？"),
    ]);
    await ensureBoardFonts(two.doc, "A为什么？");
    expect(read).toHaveBeenCalledTimes(needed.length);
    expect(one.added.length).toBe(needed.length);
    expect(two.added.length).toBe(needed.length);
    expect(one.added[0]).not.toBe(two.added[0]);
  });
  it("opens a board without handwriting without loading fonts or waiting on the host font set", async () => {
    const read = fakeSource();
    await ensureBoardFonts({ defaultView: null } as Document, "");
    expect(read).not.toHaveBeenCalled();
  });
  it("embeds only needed local data with Unicode ranges, without CDN or vault references", async () => {
    const css = await boardFontSvgCss("Why？");
    expect(css).toContain('font-family:"Tutor Excalifont"');
    expect(css).toContain('font-family:"Tutor Xiaolai"');
    expect(css).toContain("data:font/woff2;base64,d09GMg==");
    expect(css).toContain("unicode-range:U+");
    expect(css).not.toMatch(/https?:|app:/);
    expect(css.split("@font-face").length - 1).toBe(
      boardFontSubsets("Why？").length,
    );
  });
  it("retries failed file reads and fails explicitly when the target window cannot load fonts", async () => {
    const readBinary = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing-font"))
      .mockResolvedValue(new Uint8Array([119, 79, 70, 50]));
    configureBoardFonts({ readBinary });
    const { doc } = fontDocument();
    await expect(ensureBoardFonts(doc, "A")).rejects.toThrow("missing-font");
    await ensureBoardFonts(doc, "A");
    expect(readBinary).toHaveBeenCalledTimes(2);
    await expect(
      ensureBoardFonts({ defaultView: {} } as Document, "A"),
    ).rejects.toThrow("board-fonts-unavailable");
  });
  it("reuses embedded subset encoding across edits and clears it after source replacement", async () => {
    const encode = vi.spyOn(globalThis, "btoa");
    try {
      const first = await boardFontSvgCss("A");
      const encoded = encode.mock.calls.length;
      expect(encoded).toBeGreaterThan(0);
      expect(await boardFontSvgCss("AAA")).toBe(first);
      await boardFontSvgCss("A为什么");
      expect(await boardFontSvgCss("A")).toBe(first);
      expect(encode.mock.calls.length)
        .toBe(boardFontSubsets("A为什么").length);
      configureBoardFonts({ readBinary: async () => new Uint8Array([1, 2, 3]) });
      expect(await boardFontSvgCss("A")).not.toBe(first);
    } finally {
      encode.mockRestore();
    }
  });
  it("retries an unsuccessful SVG font export without retaining a rejected encoding", async () => {
    const readBinary = vi.fn()
      .mockRejectedValueOnce(new Error("font-offline"))
      .mockResolvedValue(new Uint8Array([119, 79, 70, 50]));
    configureBoardFonts({ readBinary });
    await expect(boardFontSvgCss("A")).rejects.toThrow("font-offline");
    expect(await boardFontSvgCss("A")).toContain("d09GMg==");
    expect(readBinary).toHaveBeenCalledTimes(2);
  });
  it("reuses measured widths per window and remeasures after local fonts load or their source changes", async () => {
    const one = fontDocument(), two = fontDocument();
    const measureText = vi.fn().mockReturnValue({ width: 10 });
    const context = { font: "", measureText };
    Object.assign(one.doc, { createElement: () => ({ getContext: () => context }) });
    const measure = boardTextMeasurer(one.doc);
    expect(boardTextMeasurer(one.doc)).toBe(measure);
    expect(measure("A", handwritten)).toBe(10);
    expect(measure("A", { ...handwritten, align: "right" })).toBe(10);
    expect(measureText).toHaveBeenCalledTimes(1);
    measureText.mockReturnValue({ width: 17 });
    await ensureBoardFonts(one.doc, "A");
    expect(measure("A", handwritten)).toBe(17);
    expect(measureText).toHaveBeenCalledTimes(2);
    await ensureBoardFonts(two.doc, "A");
    expect(measure("A", handwritten)).toBe(17);
    expect(measureText).toHaveBeenCalledTimes(2);
    fakeSource();
    expect(measure("A", handwritten)).toBe(17);
    expect(measureText).toHaveBeenCalledTimes(3);
  });
  it("collects nested handwritten text through versioned stickers and terminates cycles", () => {
    const text = {
      kind: "text",
      text: "为什么",
      textStyle: handwritten,
    } as BoardObject;
    const sticker = {
      kind: "sticker",
      assetId: "custom",
      assetVersion: 1,
    } as BoardObject;
    const profile = {
      id: "custom",
      version: 1,
      objects: [text, sticker],
    } as TutorCharacterProfile;
    expect(boardHandwrittenText([sticker], [profile]).trim()).toBe("为什么");
    expect(boardHandwrittenText([{ ...text, textStyle: undefined }])).toBe("");
  });
});

describe("measured board text", () => {
  it("wraps using supplied glyph widths, preserving Chinese clusters and explicit line breaks", () => {
    const layout = layoutBoardText("ABC为什么\n\n继续", handwritten, 32, width);
    expect(layout.lines.map((line) => line.text)).toEqual([
      "AB",
      "C为",
      "什么",
      "",
      "继续",
    ]);
    expect(layout.lines.every((line) => line.width <= 32)).toBe(true);
    expect(layout.height).toBe(125);
    expect(layout.lines[4]!.y).toBe(120);
  });
  it("wraps Latin words without splitting an emoji grapheme, and aligns each measured line", () => {
    const layout = layoutBoardText(
      "one two",
      { ...handwritten, align: "right" },
      50,
      width,
    );
    expect(layout.lines.map((line) => line.text)).toEqual(["one", "two"]);
    expect(layout.lines.map((line) => line.x)).toEqual([20, 20]);
    const emoji = "👨‍👩‍👧‍👦";
    const result = layoutBoardText(`${emoji}好`, handwritten, 20, () => 21);
    expect(result.lines.map((line) => line.text)).toEqual([emoji, "好"]);
  });
  it("preserves the legacy sans face/size default and chooses the offline stack only for new handwriting", () => {
    expect(resolvedBoardTextStyle({ text: "old", height: 24 })).toEqual({
      font: "sans",
      size: 20,
      align: "left",
    });
    expect(boardFontCss(handwritten)).toContain(
      '20px "Tutor Excalifont", "Tutor Xiaolai"',
    );
  });
});
