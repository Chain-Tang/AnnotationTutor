import { describe, expect, it, vi } from "vitest";
import { applyBoardOperations, buildBoardArtistInstruction, createBoardArtistSession, routeBoardCreation } from "../src/board-ai.js";
import type { BoardAgent, BoardAgentRequest, BoardObject } from "../src/board-types.js";

const object = (id: string, createdBy: "human" | "tutor" = "tutor"): BoardObject => ({
  id, kind: "path", anchor: { kind: "canvas", pageId: "main" }, x: 10, y: 10, width: 40, height: 20,
  color: "#222222", strokeWidth: 3, points: [{ x: 0, y: 0 }, { x: 40, y: 20 }],
  createdBy, editedBy: createdBy, revision: 1, groupId: "g",
});
const request = (): BoardAgentRequest => ({
  boardId: "b", sessionId: "s", requestId: "r", baseRevision: 1, sourceRevision: "1", sourceFile: "art.md",
  anchor: { kind: "canvas", pageId: "main" },
  snapshot: { pngBase64: "aGVsbG8=", width: 400, height: 300, imageToBoard: [1, 0, 0, 1, 0, 0], anchor: { kind: "canvas", pageId: "main" }, layoutRevision: "1" },
  objects: [], instruction: "画一枝水墨竹子", context: "{}", character: null,
});

describe("board creation routing and transactions", () => {
  it("surfaces the selected specialist route", () => {
    expect(routeBoardCreation("画一榀门式刚架和荷载")).toBe("mechanics");
    expect(routeBoardCreation("画二次元人物全身插画")).toBe("illustration");
    expect(routeBoardCreation("用水墨毛笔画竹叶")).toBe("brush");
  });

  it("applies a batch without allowing human objects to be changed", () => {
    const human = object("human", "human"), tutor = object("tutor");
    expect(applyBoardOperations([human, tutor], [{ type: "remove", objectId: "tutor", expectedRevision: 1 }])).toEqual([human]);
    expect(() => applyBoardOperations([human], [{ type: "remove", objectId: "human", expectedRevision: 1 }])).toThrow("human-object");
    expect(() => applyBoardOperations([], [{ type: "add", object: object("wide") }], { x: 0, y: 0, width: 20, height: 20 })).toThrow("outside-artboard");
  });

  it("runs composition, large forms and details as bounded checkpoints", async () => {
    const calls: BoardAgentRequest[] = [];
    const agent: BoardAgent = {
      async request(input) {
        calls.push(input);
        return { ok: true, requestId: input.requestId, baseRevision: input.baseRevision, description: `stage-${calls.length}`,
          operations: [{ type: "add", object: object(`o${calls.length}`) }] };
      },
      cancel: vi.fn(), dispose: vi.fn(),
    };
    const checkpoints: string[] = [];
    const session = createBoardArtistSession({ agent, renderCheckpoint: async (_objects, stage) => ({ ...request().snapshot, layoutRevision: stage }) });
    const result = await session.run({ board: request(), maxFeedbackRounds: 3 }, undefined, (checkpoint) => checkpoints.push(checkpoint.stage));
    expect(result.kind).toBe("brush-group");
    if (result.kind !== "brush-group") return;
    expect(result.operations).toHaveLength(3);
    expect(checkpoints).toEqual(["composition", "large-forms", "details"]);
    expect(calls.map((call) => call.purpose)).toEqual(["artist", "artist", "artist"]);
    expect(calls.map((call) => call.feedbackRound)).toEqual([1, 2, 3]);
    expect(calls[2]!.objects.map((item) => item.id)).toEqual(["o1", "o2"]);
    expect(result.provenance).toMatchObject({ strategy: "planner-tools", feedbackRounds: 3 });
  });

  it("records first schema-valid preview latency without persisting transient operations", async () => {
    const agent: BoardAgent = {
      async request(input, onEvent) {
        onEvent?.({ type: "preview", operations: [{ type: "add", object: object("preview") }] });
        return { ok: true, requestId: input.requestId, baseRevision: input.baseRevision, description: "done", operations: [{ type: "add", object: object("final") }] };
      },
      cancel: vi.fn(), dispose: vi.fn(),
    };
    const result = await createBoardArtistSession({ agent }).run({ board: request(), strategy: "single-prompt" });
    if (result.kind !== "brush-group") throw new Error("expected brush result");
    expect(result.checkpoints[0]?.firstPreviewLatencyMs).toBeTypeOf("number");
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ type: "add", object: { id: "final" } });
  });

  it("runs single-prompt and few-shot as traceable one-pass strategies", async () => {
    for (const strategy of ["single-prompt", "few-shot"] as const) {
      const calls: BoardAgentRequest[] = [];
      const agent: BoardAgent = {
        async request(input) {
          calls.push(input);
          return { ok: true, requestId: input.requestId, baseRevision: input.baseRevision, description: strategy, operations: [] };
        },
        cancel: vi.fn(), dispose: vi.fn(),
      };
      const result = await createBoardArtistSession({ agent }).run({ board: request(), maxFeedbackRounds: 3, strategy });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.instruction).toContain("创作目标");
      expect(result.provenance).toMatchObject({ strategy, feedbackRounds: 1 });
    }
    expect(buildBoardArtistInstruction("few-shot", "composition", "画人物")).toContain("动作线");
    expect(buildBoardArtistInstruction("planner-tools", "details", "画人物")).toContain("现在完成细节");
    expect(buildBoardArtistInstruction("single-prompt", "composition", "画人物")).toContain("一次完成整幅作品");
  });
});
