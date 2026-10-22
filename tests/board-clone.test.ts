import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneBoardValue } from "../src/board-clone.js";

afterEach(() => vi.unstubAllGlobals());

describe("board snapshot cloning", () => {
  it.each([true, false])("isolates nested scene and ink data with native cloning available=%s", native => {
    if (!native) vi.stubGlobal("structuredClone", undefined);
    const original = { objects: [{ anchor: { kind: "markdown", key: "block", quote: "Text" } }], ink: { points: [{ x: 2, y: 3, pressure: 0.5 }] } };
    const copy = cloneBoardValue(original);
    expect(copy).toEqual(original);
    copy.objects[0]!.anchor.quote = "Changed";
    copy.ink.points[0]!.x = 99;
    expect(original.objects[0]!.anchor.quote).toBe("Text");
    expect(original.ink.points[0]!.x).toBe(2);
  });
});
