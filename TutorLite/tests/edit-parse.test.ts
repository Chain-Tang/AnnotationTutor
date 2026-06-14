import { describe, expect, it } from "vitest";
import {
  buildEditInstruction,
  EDIT_END,
  EDIT_START,
  extractEdit
} from "../src/edit-parse.js";

describe("extractEdit", () => {
  it("returns no edit when the markers are absent", () => {
    const out = extractEdit("Just a plain answer about projection.");
    expect(out.edit).toBe(null);
    expect(out.explanation).toBe("Just a plain answer about projection.");
  });

  it("pulls the body between the markers and keeps the prose as explanation", () => {
    const reply = [
      "I tightened the wording.",
      EDIT_START,
      "Projection externalizes a feeling onto another.",
      EDIT_END,
      "Let me know if you want it shorter."
    ].join("\n");
    const out = extractEdit(reply);
    expect(out.edit).toBe("Projection externalizes a feeling onto another.");
    expect(out.explanation).toContain("I tightened the wording.");
    expect(out.explanation).toContain("Let me know if you want it shorter.");
    expect(out.explanation).not.toContain(EDIT_START);
  });

  it("preserves a body that itself contains code fences and tables", () => {
    const body = ["| a | b |", "| - | - |", "", "```mermaid", "graph TD; A-->B", "```"].join("\n");
    const reply = `Here is the table.\n${EDIT_START}\n${body}\n${EDIT_END}`;
    const out = extractEdit(reply);
    expect(out.edit).toBe(body);
  });

  it("treats an empty marker body as no edit", () => {
    const reply = `${EDIT_START}\n\n${EDIT_END}`;
    expect(extractEdit(reply).edit).toBe(null);
  });

  it("ignores an unterminated start marker", () => {
    expect(extractEdit(`${EDIT_START}\nhalf an edit`).edit).toBe(null);
  });
});

describe("buildEditInstruction", () => {
  it("names the markers and adapts to whether there is a selection", () => {
    const sel = buildEditInstruction(true);
    expect(sel).toContain(EDIT_START);
    expect(sel).toContain(EDIT_END);
    expect(sel).toContain("rewrite the selected text");
    expect(buildEditInstruction(false)).toContain("insert at the cursor");
  });
});
