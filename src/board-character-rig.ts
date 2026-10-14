import { boardCharacterDefinitionSchema, boardCharacterRecipeSchema, boardVectorAssetSchema } from "./board-model.js";
import type {
  BoardCharacterDefinition,
  BoardCharacterRecipe,
  BoardCharacterResolver,
  BoardVectorAsset,
  BoardVectorNode,
} from "./board-types.js";

type RecipeValidation = { valid: boolean; errors: string[]; warnings: string[] };

function presetMap(definition: BoardCharacterDefinition): Map<string, BoardCharacterDefinition["presets"][number]> {
  return new Map(definition.presets.map(preset => [preset.id, preset]));
}
function requestedPresets(recipe: BoardCharacterRecipe): string[] {
  return [recipe.pose, ...recipe.gestures, ...(recipe.outfit ? [recipe.outfit] : []), ...recipe.props];
}
function expressionEntries(recipe: BoardCharacterRecipe): Array<[keyof BoardCharacterRecipe["expression"], string, number]> {
  const result: Array<[keyof BoardCharacterRecipe["expression"], string, number]> = [];
  for (const channel of ["emotion", "mouth", "blink", "gaze", "micro"] as const)
    for (const [id, value] of Object.entries(recipe.expression[channel])) result.push([channel, id, value]);
  return result;
}

/** Resolves static character recipes without introducing a separate animation format. */
export class DefaultBoardCharacterResolver implements BoardCharacterResolver {
  public validateRecipe(definitionInput: BoardCharacterDefinition, recipeInput: BoardCharacterRecipe): RecipeValidation {
    const errors: string[] = [], warnings: string[] = [];
    const definitionResult = boardCharacterDefinitionSchema.safeParse(definitionInput);
    const recipeResult = boardCharacterRecipeSchema.safeParse(recipeInput);
    if (!definitionResult.success) errors.push(...definitionResult.error.issues.map(issue => issue.message));
    if (!recipeResult.success) errors.push(...recipeResult.error.issues.map(issue => issue.message));
    if (!definitionResult.success || !recipeResult.success) return { valid: false, errors, warnings };
    const definition = definitionResult.data, recipe = recipeResult.data;
    if (recipe.definitionId !== definition.id || recipe.definitionVersion !== definition.version)
      errors.push("Character recipe targets a different definition version");
    const presets = presetMap(definition);
    for (const id of requestedPresets(recipe)) if (!presets.has(id)) errors.push(`Unknown character preset: ${id}`);
    if (presets.get(recipe.pose)?.kind !== "pose") errors.push("Character pose must reference a pose preset");
    if (recipe.outfit && presets.get(recipe.outfit)?.kind !== "outfit") errors.push("Character outfit must reference an outfit preset");
    for (const id of recipe.gestures) if (presets.get(id)?.kind !== "gesture") errors.push(`Gesture references the wrong preset kind: ${id}`);
    for (const id of recipe.props) if (presets.get(id)?.kind !== "prop") errors.push(`Prop references the wrong preset kind: ${id}`);
    const occupied = new Map<"left" | "right", string>();
    for (const prop of recipe.props) {
      const rule = definition.rules.handOccupancy.find(item => item.presetId === prop);
      for (const hand of rule?.hands ?? []) {
        const previous = occupied.get(hand);
        if (previous) errors.push(`${hand} hand is occupied by both ${previous} and ${prop}`);
        else occupied.set(hand, prop);
      }
    }
    const controls = new Map(definition.faceControls.map(control => [control.id, control]));
    for (const [channel, id, value] of expressionEntries(recipe)) {
      const control = controls.get(id);
      if (!control) errors.push(`Unknown face control: ${id}`);
      else if (control.channel !== channel) errors.push(`Face control ${id} belongs to ${control.channel}, not ${channel}`);
      else if (value < control.min || value > control.max) errors.push(`Face control ${id} is outside its allowed range`);
    }
    if (!recipe.gestures.length) warnings.push("Character recipe contains no gesture overlay");
    return { valid: errors.length === 0, errors, warnings };
  }

  public resolve(definitionInput: BoardCharacterDefinition, recipeInput: BoardCharacterRecipe, sourceInput: BoardVectorAsset): BoardVectorAsset {
    const definition = boardCharacterDefinitionSchema.parse(definitionInput);
    const recipe = boardCharacterRecipeSchema.parse(recipeInput);
    const source = boardVectorAssetSchema.parse(sourceInput);
    const validation = this.validateRecipe(definition, recipe);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    if (source.id !== definition.vectorAssetId || source.version !== definition.vectorAssetVersion)
      throw new Error("Character definition does not match the source vector asset");
    const asset = structuredClone(source), nodes = new Map(asset.nodes.map(node => [node.id, node]));
    const presets = presetMap(definition);
    const applyValue = (key: string, value: number | string | boolean): void => {
      const match = key.match(/^node\.([A-Za-z0-9_-]+)\.(visible|opacity|translateX|translateY|rotate)$/);
      if (!match) return;
      const node = nodes.get(match[1]!); if (!node) return;
      const property = match[2]!;
      if (property === "visible" && typeof value === "boolean") node.visible = value;
      else if (property === "opacity" && typeof value === "number") node.opacity = Math.max(0, Math.min(1, value));
      else if (property === "translateX" && typeof value === "number") node.transform[4] += value;
      else if (property === "translateY" && typeof value === "number") node.transform[5] += value;
      else if (property === "rotate" && typeof value === "number") {
        const cos = Math.cos(value), sin = Math.sin(value), [a, b, c, d] = node.transform;
        node.transform[0] = a * cos + c * sin; node.transform[1] = b * cos + d * sin;
        node.transform[2] = c * cos - a * sin; node.transform[3] = d * cos - b * sin;
      }
    };
    for (const id of requestedPresets(recipe)) {
      const preset = presets.get(id);
      for (const [key, value] of Object.entries(preset?.values ?? {})) applyValue(key, value);
    }
    const selectedParts = new Set<string>();
    for (const id of requestedPresets(recipe)) {
      const preset = presets.get(id);
      for (const [key, value] of Object.entries(preset?.values ?? {})) if (value === true && definition.parts.some(part => part.id === key)) selectedParts.add(key);
    }
    for (const slot of definition.rules.exclusiveSlots) {
      const parts = definition.parts.filter(part => part.slot === slot);
      const active = parts.find(part => selectedParts.has(part.id));
      if (active) for (const part of parts) {
        const node = nodes.get(part.rootNodeId); if (node) node.visible = part.id === active.id;
      }
    }
    const controls = new Map(definition.faceControls.map(control => [control.id, control]));
    for (const [, id, value] of expressionEntries(recipe)) {
      const control = controls.get(id);
      for (const nodeId of control?.nodeIds ?? []) {
        const node = nodes.get(nodeId); if (node) node.opacity = Math.max(0, Math.min(1, value));
      }
    }
    asset.name = `${definition.name} · ${recipe.pose}`;
    return boardVectorAssetSchema.parse(asset);
  }

  public bakeToVectorAsset(definition: BoardCharacterDefinition, recipe: BoardCharacterRecipe, source: BoardVectorAsset): BoardVectorAsset {
    const resolved = this.resolve(definition, recipe, source);
    const visible = new Set(resolved.nodes.filter(node => node.visible).map(node => node.id));
    const descendantsVisible = (node: BoardVectorNode): boolean => !node.parentId || visible.has(node.parentId);
    resolved.nodes = resolved.nodes.filter(node => visible.has(node.id) && descendantsVisible(node));
    const nodeIds = new Set(resolved.nodes.map(node => node.id));
    resolved.rootIds = resolved.rootIds.filter(id => nodeIds.has(id));
    resolved.components = resolved.components?.filter(component => nodeIds.has(component.rootId));
    resolved.id = `${resolved.id}-baked`.slice(0, 160);
    resolved.version = 1;
    return boardVectorAssetSchema.parse(resolved);
  }
}
