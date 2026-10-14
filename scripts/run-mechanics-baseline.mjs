import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const benchmark = JSON.parse(await readFile(new URL("research/ai-drawing/benchmark-v1.json", root), "utf8"));
const fixture = JSON.parse(await readFile(new URL("research/ai-drawing/mechanics-core-v1.json", root), "utf8"));
if (fixture.format !== "tutor-mechanics-benchmark-core-v1") throw new Error("Unexpected mechanics fixture format");

const bundled = await build({
  entryPoints: [new URL("src/board-mechanics.ts", root).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const taskById = new Map(benchmark.tasks.map((task) => [task.id, task]));
const rows = [];
for (const item of fixture.cases) {
  const task = taskById.get(item.taskId);
  if (!task) throw new Error(`Unknown task ${item.taskId}`);
  const expectedKind = item.expectedOutcome ?? "diagram";
  const outcome = module.mechanicsBaselineOutcomeFromInstruction(task.prompt);
  if (expectedKind !== "diagram") {
    const matched = outcome.kind === expectedKind;
    rows.push({ taskId: item.taskId, title: task.title, expectedKind, actualKind: outcome.kind, valid: matched, warnings: [], truePositive: matched ? 1 : 0, predicted: 1, expected: 1, precision: matched ? 1 : 0, recall: matched ? 1 : 0, f1: matched ? 1 : 0 });
    continue;
  }
  if (outcome.kind !== "diagram") {
    rows.push({ taskId: item.taskId, title: task.title, expectedKind, actualKind: outcome.kind, valid: false, warnings: [outcome.reason], truePositive: 0, predicted: 1, expected: 1, precision: 0, recall: 0, f1: 0 });
    continue;
  }
  const expected = module.parseMechanicsDiagram(item.diagram);
  const validation = module.validateMechanicsDiagram(outcome.diagram);
  const score = module.scoreMechanicsRelations(outcome.diagram, expected);
  rows.push({ taskId: item.taskId, title: task.title, expectedKind, actualKind: outcome.kind, valid: validation.valid, warnings: validation.warnings, ...score });
}
const averageF1 = rows.reduce((sum, row) => sum + row.f1, 0) / rows.length;
const report = {
  format: "tutor-mechanics-baseline-v1",
  generatedAt: new Date().toISOString(),
  implementation: "mechanicsTemplateFromInstruction",
  coverage: { evaluated: rows.length, planned: 24 },
  averageF1,
  rows,
};
await writeFile(new URL("research/ai-drawing/mechanics-baseline-latest.json", root), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Mechanics baseline: ${rows.length}/24 core tasks, mean relation F1 ${(averageF1 * 100).toFixed(1)}%\n`);
for (const row of rows) process.stdout.write(`${row.taskId}\t${(row.f1 * 100).toFixed(1)}%\tP ${(row.precision * 100).toFixed(1)}%\tR ${(row.recall * 100).toFixed(1)}%\n`);
