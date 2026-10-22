import { z } from "zod";
import { boardVectorNodeSchema } from "./board-model.js";
import { DefaultBoardToolRuntime } from "./board-tools.js";
import type { BoardVectorAsset, BoardVectorNode } from "./board-types.js";

export type BoardArtworkModel = {
  complete(input: { prompt: string; imageDataUrl: string }, signal: AbortSignal): Promise<string>;
};
export type BoardArtworkRefinement = {
  asset: BoardVectorAsset;
  createdIds: string[];
  warnings: string[];
  latencyMs: number;
};

const responseSchema = z.object({
  description: z.string().max(1200),
  nodes: z.array(boardVectorNodeSchema).max(64),
}).strict();

function jsonFromReply(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start || end - start > 180_000) throw new Error("artwork-model-did-not-return-json");
  return JSON.parse(trimmed.slice(start, end + 1));
}
function parentOf(asset: BoardVectorAsset, node: BoardVectorNode): string | undefined {
  let cursor = node.parentId, depth = 0;
  while (cursor && depth++ < 20) {
    if (["crimson", "cobalt", "volt", "backdrop"].includes(cursor)) return cursor;
    cursor = asset.nodes.find(item => item.id === cursor)?.parentId;
  }
  return undefined;
}
function validateAdditions(asset: BoardVectorAsset, nodes: BoardVectorNode[]): void {
  const existing = new Set(asset.nodes.map(node => node.id));
  for (const node of nodes) {
    if (existing.has(node.id)) throw new Error(`Duplicate artwork node: ${node.id}`);
    if (!["path", "shape"].includes(node.kind)) throw new Error("AI refinement only accepts native paths and shapes");
    if (!node.parentId || !parentOf(asset, node)) throw new Error(`Node ${node.id} must belong to an existing character or backdrop`);
    if (!node.semanticRole || !node.name) throw new Error(`Node ${node.id} needs an editable name and semantic role`);
    for (const command of node.path ?? []) {
      const values = Object.entries(command).filter(([, value]) => typeof value === "number") as Array<[string, number]>;
      for (const [key, value] of values) if (key !== "rotation" && (value < -150 || value > 1350)) throw new Error(`Node ${node.id} has out-of-bounds geometry`);
    }
    existing.add(node.id);
  }
}

/** One visual feedback pass, kept in a draft transaction until the host accepts it. */
export async function refineComicCoverWithModel(input: {
  asset: BoardVectorAsset;
  model: BoardArtworkModel;
  imageDataUrl: string;
  signal: AbortSignal;
  onPreview?: (asset: BoardVectorAsset) => void;
}): Promise<BoardArtworkRefinement> {
  const started = performance.now(), runtime = new DefaultBoardToolRuntime();
  const { transactionId } = await runtime.beginTransaction({ artboardId: "comic-cover-refinement", baseRevision: 0, asset: input.asset });
  const existing = input.asset.nodes.filter(node => node.kind === "group").map(node => ({ id: node.id, parentId: node.parentId, role: node.semanticRole }));
  const prompt = [
    "You are adding hand-editable details to an ORIGINAL three-character 1990s comic-inspired cover.",
    "Return JSON only: {\"description\":string,\"nodes\":[BoardVectorNode,...]}. Add at most 64 nodes. Do not redraw the whole picture.",
    "Improve anatomy cues, expressive ink hatching and material details where the preview is weak. Keep all three characters recognizable.",
    "Each node must be a path or shape with a unique ID, name, semanticRole, existing parentId, transform:[1,0,0,1,0,0], opacity:1, blendMode:'normal', visible:true, locked:false.",
    "Path commands use objects M/L {x,y}, Q {x1,y1,x,y}, C {x1,y1,x2,y2,x,y}, and Z. Use flat sRGB solid fills; stroke has paint:{kind:'solid',color:'#RRGGBB',opacity:1},width>0,lineCap:'round',lineJoin:'round'.",
    "Coordinates are 800×1200. Do not use images, XML, SVG text, URLs, script, or known comic characters and logos.",
    `Existing parent groups: ${JSON.stringify(existing).slice(0,22_000)}`,
  ].join("\n");
  try {
    let parsed: z.infer<typeof responseSchema> | undefined, lastError = "";
    for (let attempt=0;attempt<2;attempt++) {
      if (input.signal.aborted) throw new DOMException("Artwork cancelled", "AbortError");
      const raw = await input.model.complete({ prompt: `${prompt}${lastError ? `\nHOST VALIDATION ERROR: ${lastError}. Correct the JSON once.` : ""}`, imageDataUrl: input.imageDataUrl }, input.signal);
      try {
        parsed = responseSchema.parse(jsonFromReply(raw));
        validateAdditions(input.asset, parsed.nodes);
        break;
      } catch (error) { lastError = error instanceof Error ? error.message.slice(0, 500) : String(error); if (attempt) throw error; }
    }
    if (!parsed?.nodes.length) throw new Error("AI returned no editable additions");
    for await (const event of runtime.call(transactionId, { name: "node.create", arguments: { nodes: parsed.nodes } })) if (event.type === "preview") input.onPreview?.(event.asset);
    const checkpoint = await runtime.checkpoint(transactionId);
    if (input.signal.aborted) throw new DOMException("Artwork cancelled", "AbortError");
    const result = await runtime.commit(transactionId);
    return { asset: result.asset, createdIds: parsed.nodes.map(node => node.id), warnings: checkpoint.warnings, latencyMs: Math.round(performance.now()-started) };
  } catch (error) { await runtime.rollback(transactionId); throw error; }
}
