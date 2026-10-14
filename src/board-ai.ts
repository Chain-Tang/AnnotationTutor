import type {
  BoardAgent,
  BoardAgentRequest,
  BoardArtistCheckpoint,
  BoardArtistSession,
  BoardArtistSessionRequest,
  BoardArtistStrategy,
  BoardCreationMode,
  BoardCreationResult,
  BoardObject,
  BoardOperation,
  BoardRect,
  BoardSnapshot,
} from "./board-types.js";

const STAGES = ["composition", "large-forms", "details"] as const;

export type BoardArtistSessionOptions = {
  agent: BoardAgent;
  /** Produces a new low-resolution visual checkpoint after transient operations. */
  renderCheckpoint?: (
    objects: readonly BoardObject[],
    stage: (typeof STAGES)[number],
  ) => Promise<BoardSnapshot>;
  maxOperationsPerStage?: number;
};

function inside(object: BoardObject, bounds: BoardRect): boolean {
  return object.x >= bounds.x - 0.01 && object.y >= bounds.y - 0.01 &&
    object.x + object.width <= bounds.x + bounds.width + 0.01 &&
    object.y + object.height <= bounds.y + bounds.height + 0.01;
}

/** Applies already validated agent operations to an isolated preview scene. */
export function applyBoardOperations(
  source: readonly BoardObject[],
  operations: readonly BoardOperation[],
  bounds?: BoardRect,
): BoardObject[] {
  const objects = structuredClone(source) as BoardObject[];
  const byId = new Map(objects.map((object) => [object.id, object]));
  for (const operation of operations) {
    if (operation.type === "add") {
      if (byId.has(operation.object.id)) throw new Error("duplicate-ai-object-id");
      if (bounds && !inside(operation.object, bounds)) throw new Error("ai-object-outside-artboard");
      const object = structuredClone(operation.object);
      byId.set(object.id, object);
      objects.push(object);
      continue;
    }
    const previous = byId.get(operation.objectId);
    if (!previous || previous.createdBy !== "tutor" || previous.editedBy !== "tutor")
      throw new Error("ai-cannot-change-human-object");
    if (previous.revision !== operation.expectedRevision)
      throw new Error("stale-ai-object-operation");
    const index = objects.findIndex((object) => object.id === previous.id);
    if (operation.type === "remove") {
      objects.splice(index, 1);
      byId.delete(previous.id);
      continue;
    }
    if (bounds && !inside(operation.object, bounds)) throw new Error("ai-object-outside-artboard");
    const object = structuredClone(operation.object);
    objects[index] = object;
    byId.set(object.id, object);
  }
  return objects;
}

export function buildBoardArtistInstruction(strategy: BoardArtistStrategy, stage: (typeof STAGES)[number], user: string): string {
  if (strategy === "single-prompt") return [
    `创作目标：${user}`,
    "一次完成整幅作品。先在内部确定构图，再用原生笔触完成主要轮廓、体块、明暗与必要细节。",
    "保持对象数量克制、轮廓连贯、画面层次明确；不要输出计划文字，不要修改人类对象。",
  ].join("\n");
  if (strategy === "few-shot") return [
    `创作目标：${user}`,
    "按照以下经过验证的范式一次完成：角色草图使用动作线→头胸骨盆大形→四肢轮廓→五官与衣褶；设计草图使用外轮廓→主分区→材质重点；教学插图使用主体→关系箭头→最少标签。",
    "示例原则：钢笔/铅笔承担结构线，马克笔/水彩承担大色块，粉笔/油画只用于材质重点；长笔触优先，避免用大量短线堆砌轮廓。",
    "只采用与当前目标匹配的范式，不要照抄示例内容，不要修改人类对象。",
  ].join("\n");
  if (stage === "composition")
    return `创作目标：${user}\n只完成构图规划：用少量轻线标出主体边界、动作线、重心和大块构图，不画细节。`;
  if (stage === "large-forms")
    return `创作目标：${user}\n现在完成大形铺设：在现有构图上补充主要轮廓、体块、明暗或主色。不要推翻已确认的构图，不画琐碎纹理。`;
  return `创作目标：${user}\n现在完成细节：修整线稿、材质、五官或关键说明，并检查遮挡、越界与层次。保留已有结构。`;
}

/**
 * A bounded visual-feedback loop. It batches native operations by stage and
 * returns one result so the host can commit the whole creation as one undo step.
 */
export function createBoardArtistSession(options: BoardArtistSessionOptions): BoardArtistSession {
  let cancelled = false;
  const maxPerStage = Math.max(1, Math.min(40, options.maxOperationsPerStage ?? 40));
  return {
    async run(request: BoardArtistSessionRequest, signal?: AbortSignal, onCheckpoint?: (checkpoint: BoardArtistCheckpoint) => void): Promise<BoardCreationResult> {
      cancelled = false;
      const strategy = request.strategy ?? "planner-tools";
      const rounds = strategy === "planner-tools" ? Math.max(1, Math.min(3, request.maxFeedbackRounds ?? 3)) : 1;
      let scene = structuredClone(request.board.objects) as BoardObject[];
      let snapshot = structuredClone(request.board.snapshot);
      const all: BoardOperation[] = [];
      const checkpoints: BoardArtistCheckpoint[] = [];
      const abort = () => { cancelled = true; options.agent.cancel(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        for (let index = 0; index < rounds; index++) {
          if (cancelled || signal?.aborted) throw new DOMException("AI creation cancelled", "AbortError");
          const stage = STAGES[index]!;
          const stageRequest: BoardAgentRequest = {
            ...structuredClone(request.board),
            requestId: `${request.board.requestId}-${index + 1}`,
            baseRevision: request.board.baseRevision + index,
            purpose: "artist",
            feedbackRound: index + 1,
            snapshot,
            objects: scene,
            instruction: buildBoardArtistInstruction(strategy, stage, request.board.instruction),
          };
          const stageStarted = performance.now();
          let firstPreviewLatencyMs: number | undefined;
          const result = await options.agent.request(stageRequest, (event) => {
            if (event.type === "preview" && event.operations.length && firstPreviewLatencyMs === undefined)
              firstPreviewLatencyMs = Math.round(performance.now() - stageStarted);
          });
          if (!result.ok) throw new Error(`${result.code ?? "artist-failed"}: ${result.error}`);
          if (result.operations.length > maxPerStage) throw new Error("too-many-artist-operations");
          scene = applyBoardOperations(scene, result.operations);
          all.push(...result.operations);
          const checkpoint: BoardArtistCheckpoint = {
            stage,
            round: index + 1,
            operations: structuredClone(result.operations),
            description: result.description,
            ...(firstPreviewLatencyMs === undefined ? {} : { firstPreviewLatencyMs }),
          };
          if (options.renderCheckpoint) {
            snapshot = await options.renderCheckpoint(scene, stage);
            checkpoint.snapshot = structuredClone(snapshot);
          }
          checkpoints.push(checkpoint);
          onCheckpoint?.(structuredClone(checkpoint));
        }
        return {
          kind: "brush-group",
          mode: "brush",
          operations: all,
          checkpoints,
          editable: "native-brushes",
          provenance: {
            protocol: "board-artist-v1",
            strategy,
            feedbackRounds: rounds,
            createdAt: new Date().toISOString(),
          },
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    cancel() { cancelled = true; options.agent.cancel(); },
    dispose() { cancelled = true; options.agent.dispose(); },
  };
}

/** Explicit routing is always surfaced to the user; auto is only a suggestion. */
export function routeBoardCreation(instruction: string): Exclude<BoardCreationMode, "auto"> {
  if (/(梁|桁架|刚架|支座|荷载|集中力|分布力|力矩|结构力学|beam|truss|frame|support|load|moment)/i.test(instruction))
    return "mechanics";
  if (/(二次元|人物|角色|插画|头像|全身|背景|anime|character|illustration|portrait)/i.test(instruction))
    return "illustration";
  return "brush";
}
