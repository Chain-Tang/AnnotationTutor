import { describe, expect, it } from "vitest";
import { lineDiff } from "../src/line-diff.js";

describe("lineDiff", () => {
  it("shows a compact changed middle with context", () => {
    expect(lineDiff("a\nold\nz", "a\nnew\nz")).toBe(
      "  a\n- old\n+ new\n  z"
    );
  });
});
