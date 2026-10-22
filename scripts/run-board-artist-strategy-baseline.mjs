import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const benchmark = JSON.parse(await readFile(new URL("research/ai-drawing/benchmark-v1.json", root), "utf8"));
const protocol = JSON.parse(await readFile(new URL("research/ai-drawing/artist-strategy-v1.json", root), "utf8"));
if (protocol.format !== "tutor-board-artist-strategy-v1") throw new Error("Unexpected artist strategy format");
const bundled = await build({ entryPoints: [new URL("src/board-ai.ts", root).pathname], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const tasks = protocol.taskIds.map((id) => {
  const task = benchmark.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown artist strategy task: ${id}`);
  return task;
});
const rows = [];
for (const task of tasks) for (const strategy of protocol.strategies) {
  const stages = strategy === "planner-tools" ? ["composition", "large-forms", "details"] : ["composition"];
  const instructions = stages.map((stage) => module.buildBoardArtistInstruction(strategy, stage, task.prompt));
  rows.push({ taskId: task.id, strategy, rounds: stages.length, instructionChars: instructions.reduce((sum, value) => sum + value.length, 0), stageMarkers: stages, protocolReady: instructions.every((value) => value.includes(task.prompt)) });
}
const report = {
  format: "tutor-board-artist-strategy-baseline-v1",
  generatedAt: new Date().toISOString(),
  phase: "protocol-readiness",
  warning: "This report validates comparable strategy wiring only; it contains no model output or visual-quality claim.",
  coverage: { tasks: tasks.length, strategies: protocol.strategies.length, cells: rows.length },
  hardGates: protocol.hardGates,
  rows,
};
await writeFile(new URL("research/ai-drawing/artist-strategy-baseline-latest.json", root), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Board artist strategy protocol: ${rows.length} cells (${tasks.length} tasks × ${protocol.strategies.length} strategies) ready; visual scoring pending.\n`);
