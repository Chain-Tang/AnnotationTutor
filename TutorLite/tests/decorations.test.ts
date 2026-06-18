import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { planDecorations, type AnchorMark } from "../src/decorations-plan.js";

const LINE = "Multi-head attention is useful. ^ann-20260606-001";

function doc(text = LINE): Text {
  return Text.of([text]);
}

const mark: AnchorMark = {
  id: "ANN-20260606-001",
  blockId: "ann-20260606-001",
  selectedText: "Multi-head attention is useful."
};

describe("planDecorations", () => {
  it("plans a marker at the end of the span and hides the ^id token", () => {
    const plans = planDecorations(doc(), [mark], "none", true);
    const marker = plans.find((p) => p.kind === "marker");
    expect(marker).toBeDefined();
    if (marker?.kind === "marker") {
      // The marker sits at the end of the underlined text (here the whole
      // sentence), clamped to the ^id start and ordered before the hidden token.
      expect(marker.pos).toBe(mark.selectedText.length);
      expect(marker.side).toBe(-1);
      expect(marker.id).toBe("ANN-20260606-001");
    }
    const hide = plans.find((p) => p.kind === "hide");
    expect(hide).toBeDefined();
    if (hide?.kind === "hide") {
      expect(hide.from).toBe(LINE.indexOf(" ^ann"));
      expect(hide.to).toBe(LINE.length);
    }
  });

  it("plans an inline style hugging the selected span", () => {
    const plans = planDecorations(doc(), [mark], "dotted-underline", false);
    expect(plans).toHaveLength(1);
    const style = plans[0];
    expect(style?.kind).toBe("style");
    if (style?.kind === "style") {
      expect(style.className).toBe("atl-hl-dotted");
      expect(style.from).toBe(0);
      expect(style.to).toBe(mark.selectedText.length);
    }
  });

  it("maps each style to its class", () => {
    const className = (style: Parameters<typeof planDecorations>[2]) =>
      planDecorations(doc(), [mark], style, false).find((p) => p.kind === "style");
    expect(className("wavy-underline")).toMatchObject({ className: "atl-hl-wavy" });
    expect(className("background")).toMatchObject({ className: "atl-hl-bg" });
    expect(className("bold")).toMatchObject({ className: "atl-hl-bold" });
  });

  it("emits no style range when style is none", () => {
    const plans = planDecorations(doc(), [mark], "none", true);
    expect(plans.some((p) => p.kind === "style")).toBe(false);
  });

  it("emits no marker when showMarker is false", () => {
    const plans = planDecorations(doc(), [mark], "dotted-underline", false);
    expect(plans.some((p) => p.kind === "marker")).toBe(false);
  });

  it("ignores lines whose block id is not a known annotation", () => {
    const plans = planDecorations(doc(), [], "dotted-underline", true);
    expect(plans).toEqual([]);
  });

  it("underlines every annotation that shares one paragraph block id", () => {
    const text = "Alpha beta gamma delta. ^ann-20260606-001";
    const a: AnchorMark = { id: "ANN-1", blockId: "ann-20260606-001", selectedText: "Alpha" };
    const b: AnchorMark = { id: "ANN-2", blockId: "ann-20260606-001", selectedText: "gamma" };
    const plans = planDecorations(doc(text), [a, b], "dotted-underline", true);
    const styles = plans.filter((p) => p.kind === "style");
    expect(styles).toHaveLength(2);
    const ids = styles.map((p) => (p.kind === "style" ? p.id : undefined));
    expect(ids).toContain("ANN-1");
    expect(ids).toContain("ANN-2");
    // Each underline hugs its own span, not the first occurrence for both.
    const byId = new Map(styles.map((p) => [p.kind === "style" ? p.id : "", p]));
    expect(byId.get("ANN-1")?.from).toBe(text.indexOf("Alpha"));
    expect(byId.get("ANN-2")?.from).toBe(text.indexOf("gamma"));
  });

  it("emits one marker per annotation sharing a paragraph (no-highlight mode)", () => {
    const text = "Alpha beta gamma delta. ^ann-20260606-001";
    const a: AnchorMark = { id: "ANN-1", blockId: "ann-20260606-001", selectedText: "Alpha" };
    const b: AnchorMark = { id: "ANN-2", blockId: "ann-20260606-001", selectedText: "gamma" };
    // Glyph markers only appear when there is no highlight to click.
    const markers = planDecorations(doc(text), [a, b], "none", true).filter(
      (p) => p.kind === "marker"
    );
    expect(markers).toHaveLength(2);
    const byId = new Map(
      markers.map((p) => [p.kind === "marker" ? p.id : "", p])
    );
    expect(byId.has("ANN-1")).toBe(true);
    expect(byId.has("ANN-2")).toBe(true);
    // Each marker sits at the end of its own span (mid-paragraph), not the line end.
    const aMark = byId.get("ANN-1");
    if (aMark?.kind === "marker") {
      expect(aMark.pos).toBe(text.indexOf("Alpha") + "Alpha".length);
    }
    const bMark = byId.get("ANN-2");
    if (bMark?.kind === "marker") {
      expect(bMark.pos).toBe(text.indexOf("gamma") + "gamma".length);
    }
  });

  it("gives repeated identical selections distinct, non-overlapping spans", () => {
    const text = "ego and ego. ^ann-20260606-001";
    const a: AnchorMark = { id: "ANN-1", blockId: "ann-20260606-001", selectedText: "ego" };
    const b: AnchorMark = { id: "ANN-2", blockId: "ann-20260606-001", selectedText: "ego" };
    const styles = planDecorations(doc(text), [a, b], "dotted-underline", false).filter(
      (p) => p.kind === "style"
    );
    expect(styles).toHaveLength(2);
    expect(styles[0]?.from).toBe(text.indexOf("ego"));
    expect(styles[1]?.from).toBe(text.indexOf("ego", 4));
    expect(styles[0]?.from).not.toBe(styles[1]?.from);
  });

  it("underlines a selection on an earlier line of a multi-line block", () => {
    // The block id lands on the LAST line, but the selection is on the first.
    const first = "Cognitive dissonance is the tension";
    const second = "between belief and action. ^ann-20260606-001";
    const doc2 = Text.of([first, second]);
    const onFirstLine: AnchorMark = {
      id: "ANN-1",
      blockId: "ann-20260606-001",
      selectedText: "Cognitive dissonance"
    };
    const styles = planDecorations(doc2, [onFirstLine], "dotted-underline", false).filter(
      (p) => p.kind === "style"
    );
    expect(styles).toHaveLength(1);
    // It hugs the phrase on line 1, not a whole-line fallback on line 2.
    expect(styles[0]?.from).toBe(first.indexOf("Cognitive dissonance"));
    expect(styles[0]?.to).toBe("Cognitive dissonance".length);
  });

  it("underlines a selection spanning two soft-broken lines as one span", () => {
    // Two sentences on consecutive lines (no blank line between them, so they
    // are one Markdown block). The block id sits on the last line.
    const first = "Multi-head attention is useful.";
    const second = "It scales to long sequences. ^ann-20260606-001";
    const doc2 = Text.of([first, second]);
    const m: AnchorMark = {
      id: "ANN-1",
      blockId: "ann-20260606-001",
      selectedText: "Multi-head attention is useful.\nIt scales to long sequences."
    };
    const plans = planDecorations(doc2, [m], "dotted-underline", true);
    const styles = plans.filter((p) => p.kind === "style");
    expect(styles).toHaveLength(1);
    const line2From = first.length + 1; // +1 for the newline between the lines
    if (styles[0]?.kind === "style") {
      expect(styles[0].from).toBe(0); // start of the first line
      expect(styles[0].to).toBe(line2From + "It scales to long sequences.".length);
      expect(styles[0].id).toBe("ANN-1");
    }
    // With a highlight on, the underline is the toggle — no glyph marker.
    expect(plans.some((p) => p.kind === "marker")).toBe(false);
    // In no-highlight mode the glyph clamps to the ^id start (span runs up to it).
    const marker = planDecorations(doc2, [m], "none", true).find(
      (p) => p.kind === "marker"
    );
    expect(marker?.kind).toBe("marker");
    if (marker?.kind === "marker") {
      expect(marker.pos).toBe(line2From + second.indexOf(" ^ann"));
      expect(marker.side).toBe(-1);
    }
  });

  it("underlines a selection spanning three lines (partial first and last)", () => {
    const l1 = "Alpha beta";
    const l2 = "gamma delta";
    const l3 = "epsilon zeta. ^ann-20260606-001";
    const doc3 = Text.of([l1, l2, l3]);
    const m: AnchorMark = {
      id: "ANN-1",
      blockId: "ann-20260606-001",
      // tail of l1, whole l2, head of l3
      selectedText: "beta\ngamma delta\nepsilon"
    };
    const styles = planDecorations(doc3, [m], "dotted-underline", false).filter(
      (p) => p.kind === "style"
    );
    expect(styles).toHaveLength(1);
    const l3From = l1.length + 1 + l2.length + 1;
    if (styles[0]?.kind === "style") {
      expect(styles[0].from).toBe(l1.indexOf("beta"));
      expect(styles[0].to).toBe(l3From + "epsilon".length);
    }
  });

  it("underlines a multi-line selection inside a blockquote (markup-tolerant)", () => {
    // Live Preview hides the "> " markers, so the captured selection omits them;
    // the continuation line must still match by its bare content, not fall back
    // to underlining the block-id line several lines down.
    const l1 = "> The mind is its own place";
    const l2 = "> and can make a heaven. ^ann-1";
    const doc2 = Text.of([l1, l2]);
    const m: AnchorMark = {
      id: "ANN-1",
      blockId: "ann-1",
      selectedText: "mind is its own place\nand can make a heaven."
    };
    const styles = planDecorations(doc2, [m], "dotted-underline", false).filter(
      (p) => p.kind === "style"
    );
    expect(styles).toHaveLength(1);
    const last = "and can make a heaven.";
    if (styles[0]?.kind === "style") {
      expect(styles[0].from).toBe(l1.indexOf("mind"));
      // The end hugs the sentence (past the "> " markup), before the trailing ^id.
      expect(styles[0].to).toBe(l1.length + 1 + l2.indexOf(last) + last.length);
    }
  });

  it("underlines a multi-line selection inside an indented list item", () => {
    // The wrapped continuation line is indented in source; the selection omits it.
    const l1 = "- First point that is";
    const l2 = "  long and wraps over. ^ann-1";
    const doc2 = Text.of([l1, l2]);
    const m: AnchorMark = {
      id: "ANN-1",
      blockId: "ann-1",
      selectedText: "point that is\nlong and wraps over."
    };
    const styles = planDecorations(doc2, [m], "dotted-underline", false).filter(
      (p) => p.kind === "style"
    );
    expect(styles).toHaveLength(1);
    if (styles[0]?.kind === "style") {
      expect(styles[0].from).toBe(l1.indexOf("point that is"));
      expect(styles[0].to).toBe(l1.length + 1 + l2.indexOf("long and wraps over.") + "long and wraps over.".length);
    }
  });

  it("matches a continuation line literally when its content really starts with a marker", () => {
    // If the user selected a line whose content genuinely begins with "- ", the
    // exact match wins over markup-stripping, so nothing is over-consumed.
    const l1 = "Alpha beta";
    const l2 = "- not a list, just text. ^ann-1";
    const doc2 = Text.of([l1, l2]);
    const m: AnchorMark = {
      id: "ANN-1",
      blockId: "ann-1",
      selectedText: "beta\n- not a list, just text."
    };
    const styles = planDecorations(doc2, [m], "dotted-underline", false).filter(
      (p) => p.kind === "style"
    );
    expect(styles).toHaveLength(1);
    if (styles[0]?.kind === "style") {
      expect(styles[0].from).toBe(l1.indexOf("beta"));
      expect(styles[0].to).toBe(l1.length + 1 + "- not a list, just text.".length);
    }
  });

  it("falls back to a whole-line underline (carrying the id) when the text drifts", () => {
    const plans = planDecorations(
      doc(),
      [{ ...mark, selectedText: "not present here" }],
      "dotted-underline",
      true
    );
    const style = plans.find((p) => p.kind === "style");
    expect(style).toBeDefined();
    if (style?.kind === "style") {
      expect(style.from).toBe(0);
      // Up to the space before the block id, not the whole line.
      expect(style.to).toBe(LINE.indexOf(" ^ann"));
      // The fallback underline is the toggle, so it must carry the annotation id.
      expect(style.id).toBe(mark.id);
    }
    // With a highlight on, the underline is the toggle — no glyph is drawn.
    expect(plans.some((p) => p.kind === "marker")).toBe(false);
  });

  it("draws no glyph marker when a highlight style is active (underline is the toggle)", () => {
    const plans = planDecorations(doc(), [mark], "dotted-underline", true);
    expect(plans.some((p) => p.kind === "marker")).toBe(false);
    // The underlined span carries the id so clicking it can toggle the comment.
    const style = plans.find((p) => p.kind === "style");
    expect(style?.kind === "style" && style.id).toBe(mark.id);
    // The raw ^id token is still hidden.
    expect(plans.some((p) => p.kind === "hide")).toBe(true);
  });

  it("draws a glyph marker only when there is no highlight to click", () => {
    const withGlyph = planDecorations(doc(), [mark], "none", true);
    expect(withGlyph.some((p) => p.kind === "marker")).toBe(true);
    // Disabling the marker in no-highlight mode leaves nothing clickable inline.
    const hidden = planDecorations(doc(), [mark], "none", false);
    expect(hidden.some((p) => p.kind === "marker")).toBe(false);
  });
});
