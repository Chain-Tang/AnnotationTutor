import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("Pass the absolute plugin data.json path");
const requestedTask = process.argv[3];
const requestedStrategy = process.argv[4];
const settings = JSON.parse(await readFile(path.resolve(settingsPath), "utf8"));
const benchmark = JSON.parse(await readFile(path.join(root, "research/ai-drawing/benchmark-v1.json"), "utf8"));
const protocol = JSON.parse(await readFile(path.join(root, "research/ai-drawing/artist-strategy-v1.json"), "utf8"));
const outRoot = path.join(root, "research/ai-drawing/artist-live-v1");
await mkdir(outRoot, { recursive: true });

const bundled = await build({
  stdin: {
    contents: [
      'export { createBoardAgent } from "./src/board-agent.ts";',
      'export { createBoardArtistSession } from "./src/board-ai.ts";',
      'export { renderBoardSvg } from "./src/board-renderer.ts";',
    ].join("\n"),
    resolveDir: root, sourcefile: "board-artist-live-entry.ts", loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const engine = settings.boardEngine === "api" ? "api" : "opencode";
const model = engine === "api" ? String(settings.boardApiModel || settings.apiModel || "") : String(settings.boardAgentModel || settings.agentModel || "");
const tasks = protocol.taskIds.filter((id) => !requestedTask || id === requestedTask).map((id) => benchmark.tasks.find((item) => item.id === id));
const strategies = protocol.strategies.filter((strategy) => !requestedStrategy || strategy === requestedStrategy);
if (!tasks.length || !strategies.length) throw new Error("Requested task or strategy is not in artist-strategy-v1");

async function rasterize(objects, destination, underlay) {
  const svg = module.renderBoardSvg(objects, {
    ink: {}, characters: [], width: 1024, height: 1024,
    background: { kind: "plain", color: "#fdfcf9", opacity: 1, spacing: 24 },
    ...(underlay ? { rasterUnderlay: { url: `data:image/png;base64,${underlay}`, x: 0, y: 0, width: 1024, height: 1024 } } : {}),
  });
  const svgPath = destination.replace(/\.png$/, ".svg");
  await writeFile(svgPath, svg);
  await execFileAsync("sips", ["-s", "format", "png", svgPath, "--out", destination], { timeout: 30_000 });
  return readFile(destination);
}

const blankPath = path.join(outRoot, `blank-${process.pid}.png`);
const blank = await rasterize([], blankPath);
for (const task of tasks) for (const strategy of strategies) {
  const cellDir = path.join(outRoot, `${task.id}-${strategy}`);
  const recordPath = path.join(cellDir, "record.json");
  await mkdir(cellDir, { recursive: true });
  try {
    const old = JSON.parse(await readFile(recordPath, "utf8"));
    if (old.ok && ["artist-material-example-v2", "artist-json-hygiene-v3"].includes(old.promptRevision)) {
      process.stdout.write(`SKIP ${task.id} ${strategy}\n`);
      continue;
    }
  } catch { /* no completed record */ }
  // Research runs allow slow complex-figure turns; the interactive Studio keeps its shorter product timeout.
  const agent = module.createBoardAgent({ engine, model, baseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, command: settings.agentCommand, cwd: root, timeoutMs: 300_000 });
  const anchor = { kind: "canvas", pageId: `${task.id}-${strategy}` };
  const board = {
    boardId: `${task.id}-${strategy}`, sessionId: `${task.id}-${strategy}`, requestId: `${task.id}-${strategy}-${Date.now()}`,
    baseRevision: 0, sourceRevision: "artist-live-v1", sourceFile: `${task.id}.board.json`, anchor,
    snapshot: { pngBase64: blank.toString("base64"), width: 1024, height: 1024, imageToBoard: [1, 0, 0, 1, 0, 0], anchor, layoutRevision: "blank-v1" },
    objects: [], instruction: task.prompt, context: JSON.stringify({ artboard: { x: 0, y: 0, width: 1024, height: 1024 }, expected: task.expected, forbidden: task.forbidden }), character: null, purpose: "artist",
  };
  const startedAt = new Date().toISOString(), started = performance.now();
  const checkpointFiles = [];
  try {
    const session = module.createBoardArtistSession({
      agent,
      renderCheckpoint: async (objects, stage) => {
        const file = `checkpoint-${checkpointFiles.length + 1}-${stage}.png`;
        const bytes = await rasterize(objects, path.join(cellDir, file));
        checkpointFiles.push(file);
        return { ...board.snapshot, pngBase64: bytes.toString("base64"), layoutRevision: `${stage}-${checkpointFiles.length}` };
      },
    });
    const result = await session.run({ board, strategy, maxFeedbackRounds: 3 });
    const finalFile = "final.png";
    if (result.kind !== "brush-group") throw new Error("Unexpected result kind");
    const finalBytes = await rasterize(result.operations.filter((operation) => operation.type === "add").map((operation) => operation.object), path.join(cellDir, finalFile));
    const record = {
      format: "tutor-board-artist-live-cell-v1", promptRevision: "artist-json-hygiene-v3",
      taskId: task.id, strategy, engine, model, startedAt, latencyMs: Math.round(performance.now() - started), ok: true,
      operationCount: result.operations.length, checkpointCount: result.checkpoints.length,
      firstPreviewLatencyMs: result.checkpoints.map((checkpoint) => checkpoint.firstPreviewLatencyMs).filter(Number.isFinite),
      nativeEditableCount: result.operations.filter((operation) => operation.type === "add" && operation.object.kind === "path" && operation.object.brush).length,
      objectKinds: result.operations.filter((operation) => operation.type === "add").map((operation) => operation.object.kind),
      brushKinds: result.operations.filter((operation) => operation.type === "add").map((operation) => operation.object.brush?.kind).filter(Boolean),
      checkpointFiles, finalFile, finalBytes: finalBytes.byteLength, provenance: result.provenance,
      scores: {}, reviewerNotes: "待人工视觉评分", authorizedForTraining: false,
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`PASS ${task.id} ${strategy} ${record.latencyMs}ms ${record.operationCount}ops\n`);
  } catch (error) {
    const record = { format: "tutor-board-artist-live-cell-v1", promptRevision: "artist-json-hygiene-v3", taskId: task.id, strategy, engine, model, startedAt, latencyMs: Math.round(performance.now() - started), ok: false, error: String(error).slice(0, 800), checkpointFiles, scores: {}, authorizedForTraining: false };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`FAIL ${task.id} ${strategy} ${record.latencyMs}ms ${record.error}\n`);
  } finally { agent.dispose(); }
}
