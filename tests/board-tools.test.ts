import { describe, expect, it } from "vitest";
import { DefaultBoardToolRuntime } from "../src/board-tools.js";
import { builtInReferenceCharacter } from "../src/board-character-parts.js";
import type { BoardToolEvent, BoardVectorNode } from "../src/board-types.js";

const node = (id: string, parentId = "root"): BoardVectorNode => ({
  id, parentId, name: id, kind: "path", transform: [1, 0, 0, 1, 0, 0], opacity: 1,
  blendMode: "normal", visible: true, locked: false,
  path: [{ op: "M", x: 0, y: 0 }, { op: "C", x1: 5, y1: 0, x2: 5, y2: 10, x: 10, y: 10 }],
  fill: { kind: "none" }, stroke: { paint: { kind: "solid", color: "#111111", opacity: 1 }, width: 2, lineCap: "round", lineJoin: "round" },
});
async function events(iterable: AsyncIterable<BoardToolEvent>): Promise<BoardToolEvent[]> {
  const result: BoardToolEvent[] = []; for await (const event of iterable) result.push(event); return result;
}

describe("BoardToolRuntime", () => {
  it("validates draft batches, checkpoints and commits one native scene", async () => {
    const runtime = new DefaultBoardToolRuntime();
    const { transactionId } = await runtime.beginTransaction({ artboardId: "artboard-main", baseRevision: 7 });
    const output = await events(runtime.call(transactionId, { name: "node.create", arguments: { nodes: [node("hair-back"), node("face")] } }));
    expect(output[0]).toMatchObject({ type: "diff", created: ["hair-back", "face"] });
    await events(runtime.call(transactionId, { name: "node.transform", arguments: { ids: ["face"], matrix: [1, 0, 0, 1, 25, 30] } }));
    const checkpoint = await runtime.checkpoint(transactionId);
    expect(checkpoint.asset.nodes.find(item => item.id === "face")?.transform.slice(4)).toEqual([25, 30]);
    const committed = await runtime.commit(transactionId);
    expect(committed.revision).toBe(9);
    expect(committed.asset.nodes).toHaveLength(3);
    await expect(runtime.checkpoint(transactionId)).rejects.toThrow(/unavailable/);
  });

  it("keeps the prior draft intact when a call fails and rollback leaves no commit", async () => {
    const runtime = new DefaultBoardToolRuntime();
    const { transactionId } = await runtime.beginTransaction({ artboardId: "artboard-main", baseRevision: 0 });
    await events(runtime.call(transactionId, { name: "node.create", arguments: { nodes: [node("face")] } }));
    await expect(events(runtime.call(transactionId, { name: "node.create", arguments: { nodes: [node("face")] } }))).rejects.toThrow(/Duplicate/);
    expect((await runtime.checkpoint(transactionId)).asset.nodes.filter(item => item.id === "face")).toHaveLength(1);
    await runtime.rollback(transactionId);
    await expect(runtime.commit(transactionId)).rejects.toThrow(/unavailable/);
  });

  it("supports progressive tool discovery instead of exposing one giant catalog", () => {
    const runtime = new DefaultBoardToolRuntime();
    expect(runtime.searchTools("align")).toEqual([expect.objectContaining({ name: "layout.align" })]);
    expect(runtime.searchTools("", "vector").every(tool => tool.category === "vector")).toBe(true);
    expect(runtime.capabilities()).toMatchObject({ maxNodesPerCall: 256, maxSessionNodes: 5000, maxPathCommands: 50_000 });
  });

  it("applies typed character edits atomically and rejects hand conflicts", async () => {
    const runtime=new DefaultBoardToolRuntime(),reference=builtInReferenceCharacter();
    reference.definition.rules.handOccupancy.find(rule=>rule.presetId==="cup")!.hands=["left"];
    const {transactionId}=await runtime.beginTransaction({artboardId:"character",baseRevision:2,asset:reference.asset});
    await events(runtime.call(transactionId,{name:"character.instantiate",arguments:{definition:reference.definition,recipe:reference.recipe}}));
    await events(runtime.call(transactionId,{name:"character.apply_pose",arguments:{pose:"neutral",gestures:["wave-left"]}}));
    await events(runtime.call(transactionId,{name:"character.set_expression",arguments:{channel:"blink",controlId:"blink-both",value:1}}));
    await events(runtime.call(transactionId,{name:"character.change_outfit",arguments:{outfit:"uniform"}}));
    await events(runtime.call(transactionId,{name:"character.attach_prop",arguments:{prop:"book"}}));
    await expect(events(runtime.call(transactionId,{name:"character.attach_prop",arguments:{prop:"cup"}}))).rejects.toThrow(/left hand/);
    const checkpoint=await runtime.checkpoint(transactionId);
    expect(checkpoint.asset.nodes.find(item=>item.id==="uniform-top")?.visible).toBe(true);
    expect(checkpoint.asset.nodes.find(item=>item.id==="blink")?.opacity).toBe(1);
    await events(runtime.call(transactionId,{name:"character.detach_prop",arguments:{prop:"book"}}));
    const baked=await events(runtime.call(transactionId,{name:"character.bake",arguments:{}}));
    expect(baked.some(event=>event.type==="result"&&event.data.baked===true)).toBe(true);
    await expect(events(runtime.call(transactionId,{name:"character.change_outfit",arguments:{outfit:"casual"}}))).rejects.toThrow(/baked/);
  });

  it("loads and commits through the active-board host with optimistic revision checking", async () => {
    let committed = 0;
    const runtime = new DefaultBoardToolRuntime({
      load: async () => ({ revision: 12 }),
      commit: async input => { expect(input.baseRevision).toBe(12); expect(input.asset.nodes.some(item => item.id === "face")).toBe(true); committed++; },
    });
    const { transactionId } = await runtime.beginTransaction({ artboardId: "active", baseRevision: -1 });
    await events(runtime.call(transactionId, { name: "node.create", arguments: { nodes: [node("face")] } }));
    await runtime.commit(transactionId);
    expect(committed).toBe(1);
    await expect(runtime.beginTransaction({ artboardId: "active", baseRevision: 11 })).rejects.toThrow(/revision conflict/);
  });
});

it("binds the original host even when the caller provides an asset and changes focus", async () => {
  const committed: string[] = []; let active = "a";
  const seed = new DefaultBoardToolRuntime();
  const seeded = await seed.beginTransaction({artboardId:"active",baseRevision:1});
  const asset = (await seed.checkpoint(seeded.transactionId)).asset;
  const runtime = new DefaultBoardToolRuntime({
    load: async () => { const target = active; return {revision:1,commit:async()=>{committed.push(target);}}; },
    commit: async () => {throw new Error("must not resolve the current view again");},
  });
  const tx = await runtime.beginTransaction({artboardId:"active",baseRevision:1,asset});
  active="b"; await runtime.commit(tx.transactionId);
  expect(committed).toEqual(["a"]);
});
