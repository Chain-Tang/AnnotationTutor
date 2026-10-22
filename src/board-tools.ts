import {assertVectorUnlocked} from "./board-vector-edit.js";
import { boardCharacterDefinitionSchema, boardCharacterRecipeSchema, boardVectorAssetSchema, boardVectorNodeSchema } from "./board-model.js";
import { DefaultBoardCharacterResolver } from "./board-character-rig.js";
import type {
  BoardCharacterDefinition,
  BoardCharacterRecipe,
  BoardMatrix,
  BoardToolCall,
  BoardToolDescriptor,
  BoardToolEvent,
  BoardToolRuntime,
  BoardVectorAsset,
  BoardVectorNode,
} from "./board-types.js";

const LIMITS = { maxNodesPerCall: 256, maxSessionNodes: 5000, maxPathCommands: 50_000 } as const;
const TOOLS: BoardToolDescriptor[] = [
  { name: "scene.describe", category: "scene", description: "Describe the current vector scene and its limits.", write: false },
  { name: "scene.read_nodes", category: "scene", description: "Read selected nodes by stable ID.", write: false },
  { name: "scene.validate", category: "validation", description: "Validate hierarchy, paths, references and complexity.", write: false },
  { name: "node.create", category: "node", description: "Create up to 256 typed scene nodes.", write: true },
  { name: "node.update", category: "node", description: "Patch typed scene nodes without changing their IDs.", write: true },
  { name: "node.delete", category: "node", description: "Delete nodes and their descendants.", write: true },
  { name: "node.group", category: "node", description: "Create a group and reparent nodes into it.", write: true },
  { name: "node.reparent", category: "node", description: "Move nodes under another group or to the root.", write: true },
  { name: "node.reorder", category: "node", description: "Set the exact back-to-front order of one group's children.", write: true },
  { name: "node.transform", category: "node", description: "Apply or replace local transforms in a batch.", write: true },
  { name: "vector.set_style", category: "vector", description: "Set fill, stroke, opacity or blend mode on nodes.", write: true },
  { name: "layout.align", category: "layout", description: "Align node origins on an axis.", write: true },
  { name: "layout.distribute", category: "layout", description: "Distribute node origins evenly on an axis.", write: true },
  { name: "layout.mirror", category: "layout", description: "Mirror nodes around an axis coordinate.", write: true },
  { name: "character.instantiate", category: "character", description: "Instantiate a versioned character definition and recipe in the draft scene.", write: true },
  { name: "character.apply_pose", category: "character", description: "Apply one pose and optional gesture overlays to the selected character.", write: true },
  { name: "character.set_expression", category: "character", description: "Set one of the emotion, mouth, blink, gaze or micro expression channels.", write: true },
  { name: "character.change_outfit", category: "character", description: "Replace the mutually exclusive outfit preset.", write: true },
  { name: "character.attach_prop", category: "character", description: "Attach a prop after validating left/right hand occupancy.", write: true },
  { name: "character.detach_prop", category: "character", description: "Detach one prop from the character recipe.", write: true },
  { name: "character.bake", category: "character", description: "Bake the resolved character into ordinary editable vector nodes.", write: true },
];

type CharacterDraft = { definition: BoardCharacterDefinition; recipe: BoardCharacterRecipe; source: BoardVectorAsset; baked?: boolean };

type Transaction = {
  id: string;
  artboardId: string;
  baseRevision: number;
  revision: number;
  asset: BoardVectorAsset;
  checkpoints: Array<{ id: string; asset: BoardVectorAsset; warnings: string[] }>;
  character?: CharacterDraft;
  closed: boolean;
  commit?: (input: { baseRevision: number; asset: BoardVectorAsset }) => Promise<void>;
};
export type BoardToolRuntimeHost = {
  load(artboardId: string): Promise<{ asset?: BoardVectorAsset; revision: number; commit?: Transaction["commit"] }>;
  commit(input: { artboardId: string; baseRevision: number; asset: BoardVectorAsset }): Promise<void>;
};

function clone<T>(value: T): T { return structuredClone(value); }
function ids(value: unknown, key = "ids"): string[] {
  if (!value || typeof value !== "object") throw new Error("Tool arguments must be an object");
  const result = (value as Record<string, unknown>)[key];
  if (!Array.isArray(result) || result.some(item => typeof item !== "string")) throw new Error(`${key} must be an array of node IDs`);
  if (result.length > LIMITS.maxNodesPerCall) throw new Error(`A call can target at most ${LIMITS.maxNodesPerCall} nodes`);
  return result;
}
function multiply(a: BoardMatrix, b: BoardMatrix): BoardMatrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function warnings(asset: BoardVectorAsset): string[] {
  const result: string[] = [];
  for (const node of asset.nodes) {
    if (node.kind === "path" && (node.path?.length ?? 0) < 2) result.push(`Path ${node.id} is empty or has no drawable segment`);
    const [a, b, c, d, e, f] = node.transform;
    if (Math.abs(a * d - b * c) < 1e-9) result.push(`Node ${node.id} has a singular transform`);
    if (Math.abs(e) > asset.width * 4 || Math.abs(f) > asset.height * 4) result.push(`Node ${node.id} is far outside the asset bounds`);
  }
  return result;
}
function defaultAsset(artboardId: string): BoardVectorAsset {
  const now = new Date().toISOString();
  return {
    format: "board-vector-v1", id: `vector-${artboardId}`.slice(0, 160), version: 1,
    name: "AI vector scene", width: 1024, height: 1024, rootIds: ["root"], createdAt: now,
    nodes: [{
      id: "root", name: "Scene", kind: "group", transform: [1, 0, 0, 1, 0, 0], opacity: 1,
      blendMode: "normal", visible: true, locked: false,
    }],
  };
}
function calculateDiff(before: BoardVectorAsset, after: BoardVectorAsset): Extract<BoardToolEvent, { type: "diff" }> {
  const old = new Map(before.nodes.map(node => [node.id, node])), next = new Map(after.nodes.map(node => [node.id, node]));
  return {
    type: "diff",
    created: [...next.keys()].filter(id => !old.has(id)),
    updated: [...next.keys()].filter(id => old.has(id) && JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id))),
    removed: [...old.keys()].filter(id => !next.has(id)),
  };
}

/** In-memory, host-independent runtime shared by Tutor's AI and the optional MCP adapter. */
export class DefaultBoardToolRuntime implements BoardToolRuntime {
  private readonly transactions = new Map<string, Transaction>();
  private readonly characterResolver = new DefaultBoardCharacterResolver();
  private sequence = 0;
  public constructor(private readonly host?: BoardToolRuntimeHost) {}

  public capabilities(): ReturnType<BoardToolRuntime["capabilities"]> {
    return { ...LIMITS, categories: ["scene", "transaction", "node", "vector", "layout", "character", "validation"] };
  }
  public searchTools(query = "", category?: BoardToolDescriptor["category"]): BoardToolDescriptor[] {
    const needle = query.trim().toLowerCase();
    return TOOLS.filter(tool => (!category || tool.category === category) && (!needle || `${tool.name} ${tool.description}`.toLowerCase().includes(needle)));
  }
  public async beginTransaction(input: { artboardId: string; baseRevision: number; asset?: BoardVectorAsset }): Promise<{ transactionId: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(input.artboardId)) throw new Error("Invalid Artboard ID");
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < -1) throw new Error("Invalid base revision");
    const loaded = this.host ? await this.host.load(input.artboardId) : undefined;
    const baseRevision = input.baseRevision === -1 ? loaded?.revision : input.baseRevision;
    if (baseRevision === undefined || baseRevision < 0) throw new Error("Unable to resolve the active board revision");
    if (loaded && input.baseRevision >= 0 && loaded.revision !== input.baseRevision) throw new Error(`Board revision conflict: expected ${input.baseRevision}, found ${loaded.revision}`);
    const asset = boardVectorAssetSchema.parse(input.asset ?? loaded?.asset ?? defaultAsset(input.artboardId));
    const id = `board-tool-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    this.transactions.set(id, { id, artboardId: input.artboardId, baseRevision, revision: baseRevision, asset: clone(asset), checkpoints: [], closed: false, commit: loaded?.commit });
    return { transactionId: id };
  }
  public async *call(transactionId: string, call: BoardToolCall): AsyncIterable<BoardToolEvent> {
    const transaction = this.require(transactionId);
    const descriptor = TOOLS.find(tool => tool.name === call.name);
    if (!descriptor) throw new Error(`Unknown board tool: ${call.name}`);
    if (!descriptor.write) {
      if (call.name === "scene.describe") {
        yield { type: "result", data: { artboardId: transaction.artboardId, revision: transaction.revision, assetId: transaction.asset.id, nodeCount: transaction.asset.nodes.length, pathCommandCount: transaction.asset.nodes.reduce((sum, node) => sum + (node.path?.length ?? 0), 0), rootIds: transaction.asset.rootIds, limits: LIMITS } };
      } else if (call.name === "scene.read_nodes") {
        const requested = ids(call.arguments);
        yield { type: "result", data: { nodes: transaction.asset.nodes.filter(node => requested.includes(node.id)) } };
      } else {
        const found = warnings(transaction.asset);
        yield { type: "result", data: { valid: true, warnings: found } };
        for (const message of found) yield { type: "warning", code: "scene-warning", message };
      }
      yield { type: "complete", revision: transaction.revision };
      return;
    }
    const before = clone(transaction.asset), draft = clone(transaction.asset), character = transaction.character ? clone(transaction.character) : undefined;
    const characterResult = call.name.startsWith("character.") ? this.applyCharacter(draft, call, character) : undefined;
    if (!characterResult) this.apply(draft, call);
    const validated = boardVectorAssetSchema.parse(characterResult?.asset ?? draft);
    this.assertLimits(validated);
    transaction.asset = validated;
    transaction.character = characterResult?.character ?? character;
    transaction.revision += 1;
    yield calculateDiff(before, validated);
    if(characterResult)yield {type:"result",data:{recipe:clone(characterResult.character.recipe),baked:!!characterResult.character.baked}};
    for (const message of warnings(validated)) yield { type: "warning", code: "scene-warning", message };
    yield { type: "preview", asset: clone(validated) };
    yield { type: "complete", revision: transaction.revision };
  }
  public async checkpoint(transactionId: string): Promise<{ id: string; asset: BoardVectorAsset; warnings: string[] }> {
    const transaction = this.require(transactionId), result = { id: `checkpoint-${transaction.checkpoints.length + 1}`, asset: clone(transaction.asset), warnings: warnings(transaction.asset) };
    transaction.checkpoints.push(clone(result));
    return result;
  }
  public async commit(transactionId: string): Promise<{ asset: BoardVectorAsset; revision: number }> {
    const transaction = this.require(transactionId);
    const asset = boardVectorAssetSchema.parse(transaction.asset);
    if (transaction.commit) await transaction.commit({ baseRevision: transaction.baseRevision, asset });
    else await this.host?.commit({ artboardId: transaction.artboardId, baseRevision: transaction.baseRevision, asset });
    transaction.closed = true; this.transactions.delete(transactionId);
    return { asset: clone(asset), revision: transaction.revision };
  }
  public async rollback(transactionId: string): Promise<void> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) return;
    transaction.closed = true; this.transactions.delete(transactionId);
  }
  private require(id: string): Transaction {
    const transaction = this.transactions.get(id);
    if (!transaction || transaction.closed) throw new Error("Board tool transaction is unavailable");
    return transaction;
  }
  private assertLimits(asset: BoardVectorAsset): void {
    if (asset.nodes.length > LIMITS.maxSessionNodes) throw new Error(`Session exceeds ${LIMITS.maxSessionNodes} nodes`);
    const commands = asset.nodes.reduce((sum, node) => sum + (node.path?.length ?? 0), 0);
    if (commands > LIMITS.maxPathCommands) throw new Error(`Session exceeds ${LIMITS.maxPathCommands} path commands`);
  }
  private applyCharacter(asset:BoardVectorAsset,call:BoardToolCall,current?:CharacterDraft):{asset:BoardVectorAsset;character:CharacterDraft}{
    const args=call.arguments;
    if(call.name==="character.instantiate"){
      const definition=boardCharacterDefinitionSchema.parse(args.definition),recipe=boardCharacterRecipeSchema.parse(args.recipe),source=boardVectorAssetSchema.parse(args.source??asset);
      const validation=this.characterResolver.validateRecipe(definition,recipe);if(!validation.valid)throw new Error(validation.errors.join("; "));
      return {asset:this.characterResolver.resolve(definition,recipe,source),character:{definition,recipe,source}};
    }
    if(!current)throw new Error("Character tools require character.instantiate in the current draft transaction");
    if(current.baked)throw new Error("The character has been baked and no longer has live character controls");
    const next=clone(current),recipe=next.recipe;
    if(call.name==="character.apply_pose"){
      if(typeof args.pose!=="string")throw new Error("pose must be a preset ID");recipe.pose=args.pose;
      if(args.gestures!==undefined){if(!Array.isArray(args.gestures)||args.gestures.some(value=>typeof value!=="string"))throw new Error("gestures must be preset IDs");recipe.gestures=[...args.gestures] as string[];}
    }else if(call.name==="character.set_expression"){
      const channel=args.channel;if(!["emotion","mouth","blink","gaze","micro"].includes(String(channel)))throw new Error("Invalid expression channel");
      if(args.values!==undefined){if(!args.values||typeof args.values!=="object"||Array.isArray(args.values))throw new Error("values must be a control map");recipe.expression[channel as keyof typeof recipe.expression]={...(args.values as Record<string,number>)};}
      else {if(typeof args.controlId!=="string"||typeof args.value!=="number")throw new Error("controlId and numeric value are required");recipe.expression[channel as keyof typeof recipe.expression][args.controlId]=args.value;}
    }else if(call.name==="character.change_outfit"){
      if(args.outfit!==undefined&&typeof args.outfit!=="string")throw new Error("outfit must be a preset ID");recipe.outfit=args.outfit as string|undefined;
    }else if(call.name==="character.attach_prop"){
      if(typeof args.prop!=="string")throw new Error("prop must be a preset ID");if(!recipe.props.includes(args.prop))recipe.props.push(args.prop);
    }else if(call.name==="character.detach_prop"){
      if(typeof args.prop!=="string")throw new Error("prop must be a preset ID");recipe.props=recipe.props.filter(id=>id!==args.prop);
    }else if(call.name==="character.bake"){
      next.baked=true;return {asset:this.characterResolver.bakeToVectorAsset(next.definition,recipe,next.source),character:next};
    }else throw new Error(`Unsupported character tool: ${call.name}`);
    const validation=this.characterResolver.validateRecipe(next.definition,recipe);if(!validation.valid)throw new Error(validation.errors.join("; "));
    return {asset:this.characterResolver.resolve(next.definition,recipe,next.source),character:next};
  }
  private apply(asset: BoardVectorAsset, call: BoardToolCall): void {
    const args = call.arguments, nodes = new Map(asset.nodes.map(node => [node.id, node]));
    const requireNode = (id: string): BoardVectorNode => {
      assertVectorUnlocked(asset.nodes,id);const node = nodes.get(id); if (!node) throw new Error(`Unknown vector node: ${id}`); return node;
    };
    if (call.name === "node.create") {
      const input = args.nodes;
      if (!Array.isArray(input) || input.length > LIMITS.maxNodesPerCall) throw new Error(`nodes must contain at most ${LIMITS.maxNodesPerCall} items`);
      for (const raw of input) {
        const node = boardVectorNodeSchema.parse(raw);
        if (nodes.has(node.id)) throw new Error(`Duplicate vector node: ${node.id}`);
        if (node.parentId) { const parent = requireNode(node.parentId); if (parent.kind !== "group") throw new Error("Vector parents must be groups"); }
        asset.nodes.push(node); nodes.set(node.id, node); if (!node.parentId) asset.rootIds.push(node.id);
      }
    } else if (call.name === "node.update") {
      const updates = args.updates;
      if (!Array.isArray(updates) || updates.length > LIMITS.maxNodesPerCall) throw new Error(`updates must contain at most ${LIMITS.maxNodesPerCall} items`);
      for (const raw of updates) {
        if (!raw || typeof raw !== "object" || typeof (raw as { id?: unknown }).id !== "string") throw new Error("Each update requires an ID");
        const { id, ...patch } = raw as { id: string } & Record<string, unknown>;
        if ("kind" in patch || "parentId" in patch) throw new Error("Use typed create or reparent tools to change node structure");
        const current = requireNode(id), next = boardVectorNodeSchema.parse({ ...current, ...patch, id });
        Object.assign(current, next);
      }
    } else if (call.name === "node.delete") {
      const requested = new Set(ids(args)), remove = new Set(requested);
      let changed = true;
      while (changed) { changed = false; for (const node of asset.nodes) if (node.parentId && remove.has(node.parentId) && !remove.has(node.id)) { remove.add(node.id); changed = true; } }
      for(const id of remove)requireNode(id);
      asset.nodes = asset.nodes.filter(node => !remove.has(node.id)); asset.rootIds = asset.rootIds.filter(id => !remove.has(id));
      asset.components = asset.components?.filter(component => !remove.has(component.rootId));
    } else if (call.name === "node.group") {
      const requested = ids(args), group = boardVectorNodeSchema.parse(args.group);
      if (group.kind !== "group") throw new Error("group must be a group node");
      if (nodes.has(group.id)) throw new Error(`Duplicate vector node: ${group.id}`);
      for (const id of requested) requireNode(id);
      asset.nodes.push(group); nodes.set(group.id, group);
      if (!group.parentId) asset.rootIds.push(group.id);
      for (const id of requested) { const node = requireNode(id); asset.rootIds = asset.rootIds.filter(root => root !== id); node.parentId = group.id; }
    } else if (call.name === "node.reparent") {
      const requested = ids(args), parentId = typeof args.parentId === "string" ? args.parentId : undefined;
      if (parentId && requireNode(parentId).kind !== "group") throw new Error("Vector parents must be groups");
      for (const id of requested) {
        const node = requireNode(id); if (id === parentId) throw new Error("A node cannot parent itself");
        node.parentId = parentId; asset.rootIds = asset.rootIds.filter(root => root !== id); if (!parentId) asset.rootIds.push(id);
      }
    } else if (call.name === "node.reorder") {
      const requested = ids(args), parentId = typeof args.parentId === "string" ? args.parentId : undefined;
      if (parentId && requireNode(parentId).kind !== "group") throw new Error("Vector parent must be a group");
      const siblings = asset.nodes.filter(node => node.parentId === parentId);
      if (requested.length !== siblings.length || new Set(requested).size !== requested.length || requested.some(id => !siblings.some(node => node.id === id)))
        throw new Error("node.reorder requires every sibling ID exactly once");
      const ordered = requested.map(id => siblings.find(node => node.id === id)!);
      let index = 0;
      asset.nodes = asset.nodes.map(node => node.parentId === parentId ? ordered[index++]! : node);
      if (!parentId) asset.rootIds = [...requested];
    } else if (call.name === "node.transform") {
      const requested = ids(args), matrix = args.matrix;
      if (!Array.isArray(matrix) || matrix.length !== 6 || matrix.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("matrix must contain six finite numbers");
      const typed = matrix as BoardMatrix, mode = args.mode === "replace" ? "replace" : "multiply";
      for (const id of requested) { const node = requireNode(id); node.transform = mode === "replace" ? typed : multiply(node.transform, typed); }
    } else if (call.name === "vector.set_style") {
      const requested = ids(args), style = args.style;
      if (!style || typeof style !== "object") throw new Error("style must be an object");
      for (const id of requested) {
        const node = requireNode(id), candidate = boardVectorNodeSchema.parse({ ...node, ...(style as Record<string, unknown>) });
        Object.assign(node, candidate);
      }
    } else if (call.name === "layout.align") {
      const requested = ids(args), axis = args.axis === "y" ? 5 : 4, value = typeof args.value === "number" ? args.value : requireNode(requested[0]!).transform[axis];
      for (const id of requested) requireNode(id).transform[axis] = value;
    } else if (call.name === "layout.distribute") {
      const requested = ids(args), axis = args.axis === "y" ? 5 : 4;
      if (requested.length < 3) throw new Error("Distribution requires at least three nodes");
      const ordered = requested.map(requireNode).sort((a, b) => a.transform[axis] - b.transform[axis]);
      const start = ordered[0]!.transform[axis], step = (ordered.at(-1)!.transform[axis] - start) / (ordered.length - 1);
      ordered.forEach((node, index) => { node.transform[axis] = start + step * index; });
    } else if (call.name === "layout.mirror") {
      const requested = ids(args), vertical = args.axis !== "horizontal", origin = typeof args.origin === "number" ? args.origin : 0;
      for (const id of requested) {
        const node = requireNode(id), mirror: BoardMatrix = vertical ? [-1, 0, 0, 1, origin * 2, 0] : [1, 0, 0, -1, 0, origin * 2];
        node.transform = multiply(mirror, node.transform);
      }
    } else throw new Error(`Unsupported write tool: ${call.name}`);
  }
}
