// Opt-in live vision check. Reads the existing connection; never prints credentials.
// Usage: node scripts/verify-board-stream.mjs --config /vault/.obsidian/plugins/annotation-tutor-lite/data.json --engine api
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const arg = key => process.argv[process.argv.indexOf(key) + 1];
if (!process.argv.includes('--config')) throw new Error('Provide --config; this command makes one live model request.');
const config = JSON.parse(await readFile(arg('--config'), 'utf8'));
const engine = process.argv.includes('--engine') ? arg('--engine') : 'api';
if (!['api', 'opencode'].includes(engine)) throw new Error('Choose api or opencode');
await mkdir(path.join(root, 'dist/qa'), { recursive: true });
const compiled = path.join(root, `dist/qa/board-live-${engine}.mjs`);
await build({ stdin: { contents: `export * from './src/board-agent.ts'; export {nodeHttpStream} from './src/api-stream.ts'; export {startAcpSession} from './src/acp-session.ts';`, resolveDir: root }, outfile: compiled,
  bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external' });
const { createBoardAgent, nodeHttpStream, startAcpSession } = await import(pathToFileURL(compiled).href);
const input = JSON.parse(await readFile(path.join(root, 'docs/qa/board-v2/input.json'), 'utf8'));
const pngBase64 = (await readFile(path.join(root, 'docs/qa/board-v2/synthetic-vision.png'))).toString('base64');
const request = { ...input.requestCommon, boardId: 'BOARD-v3-live-check',
  sessionId: `SESSION-v3-${engine}`, requestId: `REQUEST-v3-${engine}`, sourceRevision: 'fixture-v3', bufferRevision: 'buffer-v3',
  snapshot: { ...input.requestCommon.snapshot, pngBase64 },
  instruction: '只根据截图，用中文短语流式说出原图的形状和颜色，以及学生添画的形状和颜色。然后用手写文字问一个短问题，画一支箭头，并放置一个可用颜文字。请使用紧凑流式事件协议。原图与笔迹的视觉信息只在截图里。',
};
const model = engine === 'api' ? config.apiModel : config.agentModel;
const started = performance.now();
// Keep timing/size metadata only. Never retain provider reasoning or raw SSE.
const transport = { protocol: engine === 'api' ? 'sse' : 'acp',
  firstChunkMs: null, lastChunkMs: null, chunkCount: 0, byteCount: 0 };
const elapsed = () => Math.round(performance.now() - started);
const observeChunk = text => {
  const ms = elapsed();
  transport.firstChunkMs ??= ms;
  transport.lastChunkMs = ms;
  transport.chunkCount++;
  transport.byteCount += Buffer.byteLength(text, 'utf8');
};
const agent = createBoardAgent({ engine, model,
  httpStream: async input => nodeHttpStream({ ...input,
    onResponse: response => { transport.response = { ms: elapsed(), status: response.status, contentType: response.contentType }; input.onResponse(response); },
    onChunk: chunk => { observeChunk(chunk); input.onChunk(chunk); },
  }),
  startSession: async options => {
    transport.sessionStartMs = elapsed();
    const session = await startAcpSession({ ...options, onUpdate: event => {
      if (event.type === 'message') observeChunk(event.text);
      options.onUpdate?.(event);
    }});
    transport.sessionReadyMs = elapsed();
    return session;
  }, baseUrl: config.apiBaseUrl, apiKey: config.apiKey,
  command: config.agentCommand || 'opencode', cwd: path.join(root, 'dist/qa'), timeoutMs: 90000 });
const events = [];
try {
  const result = await agent.request(request, event => {
    events.push({ ms: Math.round(performance.now() - started), ...event });
    console.log(JSON.stringify({ event: event.type, ms: events.at(-1).ms,
      ...(event.type === 'preview' ? { objects: event.operations.length } : { characters: event.text.length }) }));
  });
  const record = { recordedAt: new Date().toISOString(), engine, model,
    firstReplyMs: events.find(e => e.type === 'reply')?.ms ?? null,
    firstPreviewMs: events.find(e => e.type === 'preview')?.ms ?? null,
    totalMs: Math.round(performance.now() - started), events, transport, result };
  await mkdir(path.join(root, 'docs/qa/board-v3'), { recursive: true });
  await writeFile(path.join(root, `docs/qa/board-v3/${engine}-stream.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ engine, model, ok: result.ok, firstReplyMs: record.firstReplyMs,
    firstPreviewMs: record.firstPreviewMs, totalMs: record.totalMs,
    ...(!result.ok ? { error: result.error } : { reply: result.description, objects: result.operations.length }) }));
  if (!result.ok) process.exitCode = 1;
} finally { agent.dispose(); }
