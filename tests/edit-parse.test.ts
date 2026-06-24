import { describe, expect, it } from "vitest";
import {
  buildEditInstruction,
  EDIT_END,
  EDIT_START,
  extractEdit,
  extractInsertableBlock,
  isBlockContent,
  padBlockInsertion,
  resolveEdit
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

describe("extractInsertableBlock", () => {
  it("pulls a fenced Mermaid block out of a prose reply", () => {
    const reply = "Here is a diagram of the flow:\n\n```mermaid\ngraph TD; A-->B\n```\n\nHope that helps.";
    expect(extractInsertableBlock(reply)).toBe("```mermaid\ngraph TD; A-->B\n```");
  });

  it("pulls a Markdown table out of a prose reply", () => {
    const reply = [
      "Sure, here's a comparison:",
      "",
      "| Term | Meaning |",
      "| --- | --- |",
      "| Projection | Externalizing a feeling |",
      "",
      "Let me know."
    ].join("\n");
    expect(extractInsertableBlock(reply)).toBe(
      "| Term | Meaning |\n| --- | --- |\n| Projection | Externalizing a feeling |"
    );
  });

  it("prefers a fenced block over a table when both are present", () => {
    const reply = "```js\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    expect(extractInsertableBlock(reply)).toBe("```js\nconst x = 1;\n```");
  });

  it("returns null for plain prose", () => {
    expect(extractInsertableBlock("Projection is a defense mechanism.")).toBe(null);
  });

  it("does not treat a single piped line without a separator as a table", () => {
    expect(extractInsertableBlock("Use the | operator to pipe output.")).toBe(null);
  });
});

describe("resolveEdit", () => {
  it("uses the marker body as a replacement (not an insert)", () => {
    const reply = `Tightened it.\n${EDIT_START}\nProjection externalizes a feeling.\n${EDIT_END}`;
    const out = resolveEdit(reply);
    expect(out.edit).toBe("Projection externalizes a feeling.");
    expect(out.isInsert).toBe(false);
    expect(out.explanation).toContain("Tightened it.");
  });

  it("falls back to an insertable block when the markers are absent", () => {
    const reply = "Here's a table:\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    const out = resolveEdit(reply);
    expect(out.edit).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(out.isInsert).toBe(true);
    expect(out.explanation).toBe(reply.trim());
  });

  it("proposes nothing for plain prose", () => {
    const out = resolveEdit("Projection is a defense mechanism.");
    expect(out.edit).toBe(null);
    expect(out.isInsert).toBe(false);
  });
});

describe("isBlockContent", () => {
  it("flags multi-line, fenced, table, quote, and heading content", () => {
    expect(isBlockContent("line one\nline two")).toBe(true);
    expect(isBlockContent("```js\n```")).toBe(true);
    expect(isBlockContent("| a |")).toBe(true);
    expect(isBlockContent("> quote")).toBe(true);
    expect(isBlockContent("# Heading")).toBe(true);
  });

  it("does not flag a short inline string", () => {
    expect(isBlockContent("a clearer phrase")).toBe(false);
  });
});

describe("padBlockInsertion", () => {
  it("adds a blank line before and after a block jammed against text", () => {
    const out = padBlockInsertion("Some prose.", "More prose.", "| a |\n| - |");
    expect(out).toBe("\n\n| a |\n| - |\n\n");
  });

  it("only tops up the newlines that are missing", () => {
    expect(padBlockInsertion("text\n", "\nmore", "| a |\n| - |")).toBe("\n| a |\n| - |\n");
  });

  it("does not pad at the document edges", () => {
    expect(padBlockInsertion("", "", "| a |\n| - |")).toBe("| a |\n| - |");
  });

  it("leaves inline (single-line) content unchanged", () => {
    expect(padBlockInsertion("before ", " after", "a phrase")).toBe("a phrase");
  });
});
