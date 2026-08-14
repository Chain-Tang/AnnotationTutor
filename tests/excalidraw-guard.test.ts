import { describe, expect, it } from "vitest";
import {
  isExcalidrawDoc,
  repairExcalidrawElement,
  sanitizeExcalidrawDoc
} from "../src/excalidraw-guard.js";

const HEADER = `---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠ Switch to EXCALIDRAW VIEW ⚠==

# Excalidraw Data

## Text Elements
%%
## Drawing
`;

function docWith(json: string): string {
  return `${HEADER}\`\`\`json
${json}
\`\`\`
%%
`;
}

describe("isExcalidrawDoc", () => {
  it("matches the parsed frontmatter marker", () => {
    expect(isExcalidrawDoc(HEADER)).toBe(true);
  });

  it("ignores plain markdown and other plugin markers", () => {
    expect(isExcalidrawDoc("# A note\nhello")).toBe(false);
    expect(
      isExcalidrawDoc("---\nexcalidraw-plugin: raw\n---\n")
    ).toBe(false);
  });
});

describe("repairExcalidrawElement", () => {
  it("strips forbidden fields", () => {
    const element: Record<string, unknown> = {
      id: "a",
      frameId: "f1",
      index: "a0",
      versionNonce: 9,
      rawText: "x"
    };
    const { changed } = repairExcalidrawElement(element);
    expect(changed).toBe(true);
    expect(element).toEqual({ id: "a" });
  });

  it("normalizes boundElements [] and timestamp updated", () => {
    const element: Record<string, unknown> = {
      id: "a",
      boundElements: [],
      updated: 1723500000000
    };
    repairExcalidrawElement(element);
    expect(element.boundElements).toBeNull();
    expect(element.updated).toBe(1);
  });

  it("fills text element typography defaults", () => {
    const element: Record<string, unknown> = { id: "t", type: "text", text: "概念" };
    repairExcalidrawElement(element);
    expect(element.fontFamily).toBe(5);
    expect(element.lineHeight).toBe(1.25);
    expect(element.originalText).toBe("概念");
  });

  it("reports no change for a compliant element", () => {
    const element: Record<string, unknown> = {
      id: "ok",
      boundElements: null,
      updated: 1
    };
    expect(repairExcalidrawElement(element).changed).toBe(false);
  });
});

describe("sanitizeExcalidrawDoc", () => {
  it("repairs the drawing JSON and splices it back in place", () => {
    const json = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "r", type: "rectangle", boundElements: [], updated: 1723500000000 }
      ]
    });
    const result = sanitizeExcalidrawDoc(docWith(json));
    expect(result).not.toBeNull();
    expect(result?.repaired).toBe(true);
    const block = /```json\n([\s\S]*?)\n```/.exec(result!.content);
    const parsed = JSON.parse(block![1]!) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(parsed.elements[0]!.boundElements).toBeNull();
    expect(parsed.elements[0]!.updated).toBe(1);
    // The surrounding markers survive the splice.
    expect(result!.content).toContain("%%");
    expect(result!.content).toContain("excalidraw-plugin: parsed");
  });

  it("leaves compliant documents untouched", () => {
    const json = JSON.stringify({
      elements: [{ id: "ok", boundElements: null, updated: 1 }]
    });
    const doc = docWith(json);
    const result = sanitizeExcalidrawDoc(doc);
    expect(result).toEqual({ content: doc, repaired: false });
  });

  it("returns null when there is no drawing block or no elements array", () => {
    expect(sanitizeExcalidrawDoc(HEADER)).toBeNull();
    expect(sanitizeExcalidrawDoc(docWith('{"elements": "nope"}'))).toBeNull();
    expect(sanitizeExcalidrawDoc(docWith("not json at all"))).toBeNull();
  });

  it("never touches a ```json block sitting before the %% data region", () => {
    // User Markdown ahead of the drawing region may legitimately contain
    // JSON code blocks; repairing those would corrupt note content.
    const userBlock = '```json\n{"elements": [{"id": "user", "frameId": "x"}]}\n```';
    const doc = HEADER.replace("%%", `${userBlock}\n%%`);
    expect(sanitizeExcalidrawDoc(doc)).toBeNull();
  });
});
