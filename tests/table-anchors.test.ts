import { describe, expect, it } from "vitest";
import { cleanTableAnchors } from "../src/table-anchors.js";
import { Text } from "@codemirror/state";
import { planDecorations } from "../src/decorations-plan.js";

describe("non-invasive table anchors", () => {
  it("removes only owned in-row/standalone ids and preserves CRLF and user content", () => {
    const source = "A | B\r\n--- | ---\r\nformula x^2 [^1] | text ^ann-20260908-001 |\r\n^ann-20260908-002\r\n\r\nparagraph ^ann-20260908-001";
    const ids = new Set(["ann-20260908-001", "ann-20260908-002"]);
    const cleaned = cleanTableAnchors(source, ids);
    expect(cleaned).toBe("A | B\r\n--- | ---\r\nformula x^2 [^1] | text |\r\n\r\nparagraph ^ann-20260908-001");
    expect(cleanTableAnchors(cleaned, ids)).toBe(cleaned);
  });
  it("never strips a longer id, user-owned id or inline code example", () => {
    const source = "| A | B |\n| --- | --- |\n| text ^ann-0011 | ` ^ann-001` |\n^user-id";
    expect(cleanTableAnchors(source, new Set(["ann-001"]))).toBe(source);
  });
  it("finds a no-id table annotation without changing the document", () => {
    const source = "A | B\n--- | ---\nconcept | explanation";
    const doc = Text.of(source.split("\n"));
    const plans = planDecorations(doc, [{ id: "ANN-1", blockId: "ann-1", selectedText: "explanation" }], "background", true);
    expect(plans).toEqual([{ kind: "style", from: source.indexOf("explanation"), to: source.length, id: "ANN-1", className: "atl-hl-bg" }]);
    expect(doc.toString()).toBe(source);
  });
});
