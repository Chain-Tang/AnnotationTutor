import { describe, expect, it } from "vitest";
import { annotationNeighborhood, planAnnotationGraph } from "../src/annotation-graph-layout.js";
import type { AnchorMark } from "../src/decorations-plan.js";
const root = (id: string): AnchorMark => ({ id, blockId: "block", selectedText: "source", note: id });
const child = (id: string, parent: string, rootId = "A"): AnchorMark => ({ ...root(id), branch: {
  parentAnnotationId: parent, rootAnnotationId: rootId, sourceVersion: "source-v1",
  parentReply: { id: "review", kind: "review", version: "v1", text: "parent response" }
} });

describe("annotation graph projection", () => {
  const marks = [root("A"), child("B", "A"), child("C", "A"), child("D", "B"), root("unrelated")];
  it("keeps siblings at the same depth and focuses on the root component", () => {
    const nodes = planAnnotationGraph(marks, "D");
    expect(nodes.map(node => node.id)).toEqual(["A", "B", "C", "D"]);
    expect(nodes.find(node => node.id === "B")!.x).toBe(nodes.find(node => node.id === "C")!.x);
    expect(nodes.find(node => node.id === "D")!.x).toBeGreaterThan(nodes.find(node => node.id === "B")!.x);
  });
  it("folds descendants without modifying the source relationships", () => {
    expect(planAnnotationGraph(marks, "A", new Set(["B"])).map(node => node.id)).toEqual(["A", "B", "C"]);
    expect(marks[3]!.branch!.parentAnnotationId).toBe("B");
  });
  it("retains missing parents and survives cycles", () => {
    const missing = planAnnotationGraph([child("B", "gone")]);
    expect(missing.find(node => node.id === "gone")?.missing).toBe(true);
    const circular = [child("B", "C"), child("C", "B")];
    const nodes = planAnnotationGraph(circular);
    expect(nodes).toHaveLength(2);
    expect(nodes.some(node => node.cycle)).toBe(true);
    expect(circular[0]!.branch!.parentAnnotationId).toBe("C");
  });
  it("returns only the current path, siblings and immediate children", () => {
    expect(annotationNeighborhood(marks, "B").map(node => node.id)).toEqual(["A", "B", "C", "D"]);
    expect(annotationNeighborhood(marks, "D").map(node => node.id)).toEqual(["A", "B", "D"]);
  });
  it("handles deep paths iteratively", () => {
    const deep = [root("A"), ...Array.from({ length: 2000 }, (_, i) => child(`N${i}`, i === 0 ? "A" : `N${i - 1}`))];
    expect(annotationNeighborhood(deep, "N1999")).toHaveLength(2001);
    expect(planAnnotationGraph(deep, "A")).toHaveLength(2001);
  });
});
