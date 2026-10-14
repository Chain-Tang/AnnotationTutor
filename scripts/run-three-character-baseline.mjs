import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const settingsPath = path.resolve(process.argv[2] ?? "/Users/mac/Documents/.obsidian/plugins/annotation-tutor-lite/data.json");
const output = path.join(root, "research/ai-drawing/three-character-cover/baseline");
await mkdir(output, { recursive: true });
const entry = path.join(root, "node_modules/.cache/tutor-three-character-baseline.mjs");
await mkdir(path.dirname(entry), { recursive: true });
await build({ stdin: { contents: [
  'export {createBoardAgent} from "./src/board-agent.ts";',
  'export {createBoardArtistSession} from "./src/board-ai.ts";',
  'export {renderBoardSvg} from "./src/board-renderer.ts";',
].join("\n"), resolveDir: root, sourcefile: "comic-baseline-entry.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: entry, logLevel: "silent" });
const tutor = await import(entry), settings = JSON.parse(await readFile(settingsPath, "utf8"));
const engine = settings.boardEngine === "api" ? "api" : "opencode";
const model = engine === "api" ? String(settings.boardApiModel || settings.apiModel || "") : String(settings.boardAgentModel || settings.agentModel || "");
const prompt = "创作一幅原创八九十年代美式超级英雄漫画感觉的竖版封面：中央红衣短发女侠空中突进，左侧蓝色能量角色，右侧黄黑机械角色，三人激战，动作与肢体归属清楚；粗黑墨线、夸张透视、网点、速度线、城市背景。不得出现蜘蛛侠、漫威标志或已有角色。每个人都要有头、身、双臂、双腿，保留可编辑原生笔触。";
const anchor = { kind: "canvas", pageId: "main" };
const render = async (objects, name) => {
  const svg = tutor.renderBoardSvg(objects, { ink: {}, characters: [], width: 800, height: 1200, background: { kind: "plain", color: "#f7ebd2", opacity: 1, spacing: 24 } });
  const svgPath = path.join(output, `${name}.svg`), pngPath = path.join(output, `${name}.png`);
  await writeFile(svgPath, svg);
  await exec("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { timeout: 120_000 });
  return readFile(pngPath);
};
const blank = await render([], "blank");
const agent = tutor.createBoardAgent({ engine, model, baseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, command: settings.agentCommand, cwd: root, timeoutMs: 300_000 });
const request = { boardId: "comic-cover-baseline", sessionId: "comic-cover-baseline", requestId: `comic-${Date.now()}`, baseRevision: 0, sourceRevision: "challenge-v1", sourceFile: "benchmark.board.json", anchor,
  snapshot: { pngBase64: blank.toString("base64"), width: 800, height: 1200, imageToBoard: [1,0,0,1,0,0], anchor, layoutRevision: "blank" }, objects: [], instruction: prompt,
  context: JSON.stringify({ artboard: { x: 0, y: 0, width: 800, height: 1200 }, evaluation: "three recognizable fighters, anatomy, strong composition, native editability" }), character: null, purpose: "artist" };
const started = performance.now();
try {
  const session = tutor.createBoardArtistSession({ agent, renderCheckpoint: async (objects, stage) => ({ ...request.snapshot, pngBase64: (await render(objects, `stage-${stage}`)).toString("base64"), layoutRevision: stage }) });
  const result = await session.run({ board: request, strategy: "planner-tools", maxFeedbackRounds: 3 });
  if (result.kind !== "brush-group") throw new Error(`Unexpected result: ${result.kind}`);
  const objects = result.operations.filter(operation => operation.type === "add").map(operation => operation.object);
  await render(objects, "final");
  await writeFile(path.join(output, "record.json"), `${JSON.stringify({ format: "tutor-comic-baseline-v1", ok: true, engine, model, durationMs: Math.round(performance.now()-started), objectCount: objects.length, checkpoints: result.checkpoints.map(checkpoint => ({ stage: checkpoint.stage, firstPreviewLatencyMs: checkpoint.firstPreviewLatencyMs })), prompt, visualScores: null, authorizedForTraining: false }, null, 2)}\n`);
  process.stdout.write(`Baseline complete: ${objects.length} native objects in ${Math.round(performance.now()-started)}ms\n`);
} catch(error) {
  await writeFile(path.join(output, "record.json"), `${JSON.stringify({ format: "tutor-comic-baseline-v1", ok: false, engine, model, durationMs: Math.round(performance.now()-started), error: String(error).slice(0,800), prompt, visualScores: null, authorizedForTraining: false }, null, 2)}\n`);
  process.stdout.write(`Baseline failed after ${Math.round(performance.now()-started)}ms: ${String(error).slice(0,250)}\n`);
} finally { agent.dispose(); }
