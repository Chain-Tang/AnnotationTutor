import { describe, expect, it } from "vitest";
import { BOARD_ARTWORK_STAGES, compileThreeCharacterCover, createThreeCharacterCoverSession, defaultThreeCharacterArtworkPlan, inspectThreeCharacterCover } from "../src/board-comic-cover.js";
import { DefaultBoardToolRuntime } from "../src/board-tools.js";

describe("three-character native cover", () => {
  it("builds three independent original characters with editable anatomy", async () => {
    const plan = defaultThreeCharacterArtworkPlan();
    const stages: string[] = [];
    const asset = await createThreeCharacterCoverSession(plan, { onStage: event => { stages.push(event.stage); expect(event.asset.nodes.length).toBeGreaterThan(0); } });
    const inspection = inspectThreeCharacterCover(asset, plan);
    expect(stages).toEqual(BOARD_ARTWORK_STAGES);
    expect(inspection).toEqual({ valid: true, warnings: [], editablePartRatio: 1 });
    expect(asset.nodes.filter(node => node.semanticRole?.startsWith("character:"))).toHaveLength(3);
    expect(asset.nodes.some(node => node.kind === "image")).toBe(false);
    expect(asset.nodes.filter(node => node.semanticRole === "print-halftone").length).toBeGreaterThan(300);
    expect(asset.nodes.length).toBeGreaterThan(500);
    expect(compileThreeCharacterCover(plan).nodes).toHaveLength(asset.nodes.length);
  });

  it("cancels before formal commit and preserves deterministic geometry", async () => {
    const plan = defaultThreeCharacterArtworkPlan(1994), controller = new AbortController();
    await expect(createThreeCharacterCoverSession(plan, { signal: controller.signal, onStage: event => { if (event.stage === "large-forms") controller.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
    const first = compileThreeCharacterCover(plan), second = compileThreeCharacterCover(plan);
    expect(first).toEqual(second);
    expect(compileThreeCharacterCover(defaultThreeCharacterArtworkPlan(1995)).nodes.filter(node => node.semanticRole === "print-halftone"))
      .not.toEqual(first.nodes.filter(node => node.semanticRole === "print-halftone"));
  });

  it("reorders siblings without changing identities or violating the transaction", async () => {
    const runtime = new DefaultBoardToolRuntime();
    const asset = compileThreeCharacterCover(defaultThreeCharacterArtworkPlan(), "composition");
    const { transactionId } = await runtime.beginTransaction({ artboardId: "cover", baseRevision: 0, asset });
    const roots = asset.nodes.filter(node => node.parentId === "scene").map(node => node.id);
    const reversed = [...roots].reverse();
    for await (const _event of runtime.call(transactionId, { name: "node.reorder", arguments: { parentId: "scene", ids: reversed } })) { /* consume */ }
    const saved = await runtime.commit(transactionId);
    expect(saved.asset.nodes.filter(node => node.parentId === "scene").map(node => node.id)).toEqual(reversed);
    expect(saved.asset.nodes).toHaveLength(asset.nodes.length);
  });

  it("changes one character group without touching the other two", async () => {
    const runtime = new DefaultBoardToolRuntime();
    const asset = compileThreeCharacterCover(defaultThreeCharacterArtworkPlan());
    const characters = asset.nodes.filter(node => node.semanticRole?.startsWith("character:"));
    const moving = characters.find(node => node.semanticRole === "character:crimson")!;
    const untouched = characters.filter(node => node.id !== moving.id).map(node => structuredClone(node));
    const { transactionId } = await runtime.beginTransaction({ artboardId: "cover", baseRevision: 0, asset });
    for await (const _event of runtime.call(transactionId, { name: "node.transform", arguments: { ids: [moving.id], matrix: [1, 0, 0, 1, 24, -12], mode: "replace" } })) { /* consume */ }
    const saved = await runtime.commit(transactionId);
    expect(saved.asset.nodes.find(node => node.id === moving.id)?.transform).toEqual([1, 0, 0, 1, 24, -12]);
    expect(saved.asset.nodes.filter(node => untouched.some(other => other.id === node.id))).toEqual(untouched);
  });
});
