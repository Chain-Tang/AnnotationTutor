// Opt-in live check: existing owned rectangles must be updated, not duplicated.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const arg = key => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined;
if (!arg('--config')) throw new Error('Supply --config PATH to make live requests.');
const config = JSON.parse(await readFile(arg('--config'), 'utf8'));
const engine = arg('--engine') || 'api';
if (!['api', 'opencode'].includes(engine)) throw new Error('Invalid engine');
const out = path.resolve(arg('--out') || 'docs/qa/reference-routing-2026-09-16');
await mkdir(out,{recursive:true});
const material=arg('--material');
if(material&&!['oil','crayon'].includes(material))throw new Error('Invalid material');
await mkdir('dist/qa', { recursive: true });
const bundle = path.resolve(`dist/qa/board-fill-${engine}.mjs`);
await build({ stdin: { contents: 'export * from "./src/board-agent.ts";', resolveDir: process.cwd() }, bundle: true,
  outfile: bundle, platform: 'node', format: 'esm', packages: 'external' });
const { createBoardAgent, requestBoardWithRepair } = await import(pathToFileURL(bundle).href);
const { requestCommon } = JSON.parse(await readFile('docs/qa/board-v2/input.json', 'utf8'));
const objects = [0, 1, 2].map(i => ({ id: `bed-${i}`, kind: 'rect', anchor: requestCommon.anchor,
  x: 30 + i * 190, y: 80, width: 150, height: 120, color: '#333333', strokeWidth: 2,
  createdBy: 'tutor', editedBy: 'tutor', revision: 1 }));
const request = { ...requestCommon, boardId: 'fill-live', requestId: `fill-${engine}`, sessionId: `fill-${engine}`,
  bufferRevision: 'fill-1', objects, requiresDrawing: true,
  snapshot: { ...requestCommon.snapshot, width: 600, height: 300,
    pngBase64: (await readFile(path.resolve('docs/qa/reference-routing-2026-09-16/fill-input.png'))).toString('base64') },
  context: 'Synthetic fixture: three empty rectangular flower beds, already drawn by Tutor.',
  instruction: material ? `不要调用生图。使用${material==='oil'?'油画笔':'蜡笔'}给已有的三个花坛铺色，从左到右是红色 #ff0000、黄色 #ffff00、蓝色 #0000ff，填充整体不透明度为 1。保留位置、大小和边框，不新增对象。` : '不要调用生图。直接给已有的三个花坛从左到右填充红色 #ff0000、黄色 #ffff00、蓝色 #0000ff，使用不透明纯色填充。保留位置、大小和边框，不新增对象。',
};
const agent = createBoardAgent({ engine, model: engine === 'api' ? config.apiModel : config.agentModel,
  baseUrl: config.apiBaseUrl, apiKey: config.apiKey, command: config.agentCommand, cwd: path.resolve('dist/qa'), timeoutMs: 90000 });
const started = performance.now();
try {
  const attempts = [];
  const run = agent.request.bind(agent);
  agent.request = async (...args) => { const result = await run(...args); attempts.push({ ok: result.ok, ...(result.ok ? {} : { error: result.error }) }); return result; };
  const result = await requestBoardWithRepair(agent, request);
  const expected = ['#ff0000', '#ffff00', '#0000ff'];
  const passed = result.ok && result.operations.length === 3 && objects.every((object, i) => {
    const update = result.operations.find(op => op.type === 'update' && op.object.id === object.id);
    return update && ['x', 'y', 'width', 'height', 'color', 'strokeWidth'].every(k => update.object[k] === object[k]) &&
      update.object.fill?.kind === (material?'brush':'solid') && (!material||update.object.fill.brush?.kind===material) && update.object.fill.color.toLowerCase() === expected[i] && update.object.fill.opacity === 1;
  });
  const report = { engine, material, ms: Math.round(performance.now() - started), passed, attempts, result };
  await writeFile(path.join(out, `fill-${engine}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (!passed) process.exitCode = 1;
} finally { agent.dispose(); }
