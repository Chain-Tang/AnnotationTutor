// Parse and classify the `opencode models` catalog. Pure (no node/Obsidian
// imports) so it can be unit-tested. The runtime side that actually spawns the
// CLI lives in agent-runner.ts (`listModels`).

// A model id is `provider/model`, e.g. "opencode/mimo-v2.5-free".
const MODEL_ID = /^[\w.:-]+\/[\w.:+-]+$/;

/** Extract the unique, well-formed model ids from `opencode models` output. */
export function parseModelList(stdout: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.trim();
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

/**
 * Heuristic: a model is free when its id carries a standalone "free" token
 * (e.g. "…-free"), the OpenCode Zen naming convention. `\b` keeps it from
 * matching words like "freedom".
 */
export function isFreeModel(id: string): boolean {
  return /\bfree\b/i.test(id);
}

export function freeModels(models: string[]): string[] {
  return models.filter(isFreeModel);
}

/**
 * Choose a sensible model: keep the current one if it is still in the catalog,
 * otherwise prefer the first free model, then any model, then the current value.
 */
export function pickDefaultModel(models: string[], current: string): string {
  if (current && models.includes(current)) return current;
  return freeModels(models)[0] ?? models[0] ?? current;
}
