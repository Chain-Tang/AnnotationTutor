import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("Pass the absolute plugin data.json path");
const strategy = process.argv[3] ?? "single-prompt";
if (!["single-prompt", "few-shot", "planner-tools"].includes(strategy)) throw new Error("Strategy must be single-prompt, few-shot or planner-tools");
const settings = JSON.parse(await readFile(path.resolve(settingsPath), "utf8"));
const runsRoot = path.join(root, "research/ai-drawing/runs");
const entries = await readdir(runsRoot, { recursive: true });
const candidate = entries.filter((entry) => /anime-01-1024x1024\/candidate-1\.png$/.test(entry)).sort().at(-1);
if (!candidate) throw new Error("No accepted anime-01 checkpoint is available");
const png = await readFile(path.join(runsRoot, candidate));
const bundled = await build({
  stdin: {
    contents: 'export { createBoardAgent } from "./src/board-agent.ts"; export { createBoardArtistSession } from "./src/board-ai.ts";',
    resolveDir: root,
    sourcefile: "board-artist-probe-entry.ts",
    loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const engine = settings.boardEngine === "api" ? "api" : "opencode";
const model = engine === "api" ? String(settings.boardApiModel || settings.apiModel || "") : String(settings.boardAgentModel || settings.agentModel || "");
const agent = module.createBoardAgent({
  engine, model,
  baseUrl: settings.apiBaseUrl,
  apiKey: settings.apiKey,
  command: settings.agentCommand,
  cwd: root,
  timeoutMs: 120_000,
});
const anchor = { kind: "canvas", pageId: "probe" };
const board = {
  boardId: "artist-probe", sessionId: "artist-probe", requestId: `probe-${Date.now()}`,
  baseRevision: 0, sourceRevision: "probe-v1", sourceFile: "research-probe.board.json", anchor,
  snapshot: { pngBase64: png.toString("base64"), width: 1024, height: 1024, imageToBoard: [1, 0, 0, 1, 0, 0], anchor, layoutRevision: "probe-v1" },
  objects: [], instruction: "观察参考头像，用铅笔添加少量可编辑的结构辅助线，保持五官和人物身份，不添加文字。", context: "Provider compatibility probe; preserve the image and emit native editable paths only.", character: null, purpose: "artist",
};
const started = performance.now();
let record;
try {
  const result = await module.createBoardArtistSession({ agent }).run({ board, strategy, maxFeedbackRounds: 1 });
  record = {
    format: "tutor-board-artist-provider-probe-v1", generatedAt: new Date().toISOString(), engine, model,
    ok: true, latencyMs: Math.round(performance.now() - started), resultKind: result.kind,
    operationCount: result.kind === "brush-group" ? result.operations.length : 0,
    operations: result.kind === "brush-group" ? result.operations : [],
    objectKinds: result.kind === "brush-group" ? result.operations.filter((operation) => operation.type === "add").map((operation) => operation.object.kind) : [],
    brushKinds: result.kind === "brush-group" ? result.operations.filter((operation) => operation.type === "add").map((operation) => operation.object.brush?.kind).filter(Boolean) : [],
    provenance: result.provenance,
  };
} catch (error) {
  record = { format: "tutor-board-artist-provider-probe-v1", generatedAt: new Date().toISOString(), engine, model, ok: false, latencyMs: Math.round(performance.now() - started), error: String(error).slice(0, 500) };
} finally {
  agent.dispose();
}
const out = path.join(root, `research/ai-drawing/artist-provider-probe-${strategy}-latest.json`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(record)}\n`);
if (!record.ok) process.exitCode = 1;
