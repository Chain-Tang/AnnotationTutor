import { describe, expect, it } from "vitest";
import {
  blockIdForAnnotation,
  dateStamp,
  makeId,
  nextSequence
} from "../src/ids.js";

describe("ids", () => {
  it("formats a date stamp", () => {
    expect(dateStamp(new Date("2026-06-06T10:00:00Z"))).toMatch(/^2026060[56]$/);
  });

  it("computes the next daily sequence", () => {
    const ids = ["ANN-20260606-001", "ANN-20260606-003", "MEM-20260606-009"];
    expect(nextSequence(ids, "ANN", "20260606")).toBe(4);
    expect(nextSequence(ids, "ANN", "20260607")).toBe(1);
  });

  it("zero-pads generated ids", () => {
    const id = makeId("ANN", [], new Date("2026-06-06T10:00:00Z"));
    expect(id).toMatch(/^ANN-2026060[56]-001$/);
  });

  it("derives a lower-case block id", () => {
    expect(blockIdForAnnotation("ANN-20260606-001")).toBe("ann-20260606-001");
  });
});
