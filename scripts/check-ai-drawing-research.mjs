import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const benchmark = JSON.parse(await readFile(new URL("../research/ai-drawing/benchmark-v1.json", import.meta.url), "utf8"));
if (benchmark.format !== "tutor-ai-drawing-benchmark-v1") throw new Error("Unexpected benchmark format");
if (!Array.isArray(benchmark.tasks) || benchmark.tasks.length !== 60) throw new Error(`Expected 60 tasks, got ${benchmark.tasks?.length ?? 0}`);
const counts = { anime: 0, mechanics: 0, general: 0 };
const ids = new Set();
for (const task of benchmark.tasks) {
  if (!/^((anime|mech|general)-\d{2})$/.test(task.id)) throw new Error(`Invalid task id: ${task.id}`);
  if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
  ids.add(task.id);
  if (!(task.domain in counts)) throw new Error(`Unknown domain: ${task.domain}`);
  counts[task.domain]++;
  for (const key of ["title", "prompt"]) if (typeof task[key] !== "string" || !task[key].trim()) throw new Error(`${task.id} missing ${key}`);
  for (const key of ["references", "expected", "forbidden"]) if (!Array.isArray(task[key])) throw new Error(`${task.id} missing ${key}`);
}
if (counts.anime !== 24 || counts.mechanics !== 24 || counts.general !== 12)
  throw new Error(`Unexpected domain counts: ${JSON.stringify(counts)}`);

const runsRoot = new URL("../research/ai-drawing/runs/", import.meta.url);
let records = [];
try {
  const entries = await readdir(runsRoot, { recursive: true });
  records = entries.filter(entry => entry.endsWith("record.json"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const allowedStatuses = new Set(["generated", "accepted", "rejected", "failed", "cancelled"]);
for (const relative of records) {
  const file = new URL(relative, runsRoot);
  const raw = await readFile(file, "utf8");
  if (/sk-[A-Za-z\d_.-]{8,}/.test(raw)) throw new Error(`Credential-like value found in ${relative}`);
  const record = JSON.parse(raw);
  if (record.format !== "tutor-ai-drawing-experiment-v1") throw new Error(`Unexpected run format: ${relative}`);
  if (!ids.has(record.taskId)) throw new Error(`Unknown task in ${relative}: ${record.taskId}`);
  if (!allowedStatuses.has(record.status)) throw new Error(`Invalid status in ${relative}`);
  if (!Number.isFinite(record.latencyMs) || record.latencyMs < 0) throw new Error(`Invalid latency in ${relative}`);
  for (const score of Object.values(record.scores ?? {})) if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error(`Invalid score in ${relative}`);
  if (["generated", "accepted", "rejected"].includes(record.status) && !record.outputs?.length) throw new Error(`Successful run has no output: ${relative}`);
  for (const output of record.outputs ?? []) {
    if (path.basename(output) !== output) throw new Error(`Run output must be a local basename: ${relative}`);
    await access(new URL(output, file));
  }
}
const mechanicsFixture = JSON.parse(await readFile(new URL("../research/ai-drawing/mechanics-core-v1.json", import.meta.url), "utf8"));
if (mechanicsFixture.format !== "tutor-mechanics-benchmark-core-v1" || !Array.isArray(mechanicsFixture.cases) || mechanicsFixture.cases.length < 6)
  throw new Error("Mechanics core fixture must contain at least six cases");
for (const item of mechanicsFixture.cases) {
  if (!ids.has(item.taskId) || !item.taskId.startsWith("mech-")) throw new Error(`Invalid mechanics fixture task: ${item.taskId}`);
  const allowedOutcomes = new Set(["clarification", "needs-reference", "needs-context", "rejected"]);
  if (item.expectedOutcome) {
    if (!allowedOutcomes.has(item.expectedOutcome) || item.diagram) throw new Error(`Invalid mechanics outcome fixture: ${item.taskId}`);
  } else if (item.diagram?.format !== "tutor-mechanics-v1") throw new Error(`Invalid mechanics diagram format: ${item.taskId}`);
}
const mechanicsReport = JSON.parse(await readFile(new URL("../research/ai-drawing/mechanics-baseline-latest.json", import.meta.url), "utf8"));
if (mechanicsReport.format !== "tutor-mechanics-baseline-v1" || mechanicsReport.coverage?.evaluated !== mechanicsFixture.cases.length)
  throw new Error("Mechanics baseline report is missing or stale");
if (!Number.isFinite(mechanicsReport.averageF1) || mechanicsReport.averageF1 < 0 || mechanicsReport.averageF1 > 1)
  throw new Error("Mechanics baseline F1 is invalid");
const artistProtocol = JSON.parse(await readFile(new URL("../research/ai-drawing/artist-strategy-v1.json", import.meta.url), "utf8"));
const artistReport = JSON.parse(await readFile(new URL("../research/ai-drawing/artist-strategy-baseline-latest.json", import.meta.url), "utf8"));
if (artistProtocol.format !== "tutor-board-artist-strategy-v1" || artistProtocol.taskIds?.length !== 6 || artistProtocol.strategies?.length !== 3)
  throw new Error("Artist strategy benchmark must define six tasks and three strategies");
if (artistReport.format !== "tutor-board-artist-strategy-baseline-v1" || artistReport.coverage?.cells !== 18 || artistReport.phase !== "protocol-readiness")
  throw new Error("Artist strategy protocol report is missing or stale");
if (artistReport.rows.some((row) => row.protocolReady !== true)) throw new Error("Artist strategy protocol has an unready cell");
for (const strategy of ["single-prompt", "few-shot", "planner-tools"]) {
  const raw = await readFile(new URL(`../research/ai-drawing/artist-provider-probe-${strategy}-latest.json`, import.meta.url), "utf8");
  if (/sk-[A-Za-z\d_.-]{8,}/.test(raw)) throw new Error(`Credential-like value found in ${strategy} artist probe`);
  const probe = JSON.parse(raw);
  if (probe.format !== "tutor-board-artist-provider-probe-v1" || probe.ok !== true || probe.provenance?.strategy !== strategy)
    throw new Error(`Artist provider probe failed or is stale: ${strategy}`);
  if (!Number.isFinite(probe.latencyMs) || probe.operationCount < 1 || probe.objectKinds?.some((kind) => kind !== "path"))
    throw new Error(`Artist provider probe has invalid operations: ${strategy}`);
}
const liveRoot = new URL("../research/ai-drawing/artist-live-v1/", import.meta.url);
const expectedLiveCells = new Set(artistProtocol.taskIds.flatMap((taskId) => artistProtocol.strategies.map((strategy) => `${taskId}-${strategy}`)));
const liveDirectories = (await readdir(liveRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && expectedLiveCells.has(entry.name));
if (liveDirectories.length !== expectedLiveCells.size)
  throw new Error(`Expected ${expectedLiveCells.size} live artist cells, got ${liveDirectories.length}`);
const seenLiveCells = new Set();
for (const directory of liveDirectories) {
  const raw = await readFile(new URL(`${directory.name}/record.json`, liveRoot), "utf8");
  if (/sk-[A-Za-z\d_.-]{8,}/.test(raw)) throw new Error(`Credential-like value found in live artist cell ${directory.name}`);
  const record = JSON.parse(raw);
  const cell = `${record.taskId}-${record.strategy}`;
  if (record.format !== "tutor-board-artist-live-cell-v1" || cell !== directory.name || !expectedLiveCells.has(cell))
    throw new Error(`Invalid live artist cell: ${directory.name}`);
  if (seenLiveCells.has(cell)) throw new Error(`Duplicate live artist cell: ${cell}`);
  seenLiveCells.add(cell);
  if (typeof record.ok !== "boolean" || !Number.isFinite(record.latencyMs) || record.latencyMs < 0)
    throw new Error(`Invalid live artist outcome: ${cell}`);
  if (record.authorizedForTraining !== false) throw new Error(`Live artist cell must not default to training authorization: ${cell}`);
  if (record.ok) {
    if (!Number.isInteger(record.operationCount) || record.operationCount < 1 || !record.finalFile)
      throw new Error(`Successful live artist cell is incomplete: ${cell}`);
    await access(new URL(`${directory.name}/${record.finalFile}`, liveRoot));
    for (const score of Object.values(record.scores ?? {}))
      if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error(`Invalid live artist score: ${cell}`);
  } else if (typeof record.error !== "string" || !record.error.trim()) throw new Error(`Failed live artist cell has no error: ${cell}`);
}
const liveSummary = JSON.parse(await readFile(new URL("../research/ai-drawing/artist-live-summary-latest.json", import.meta.url), "utf8"));
if (liveSummary.format !== "tutor-board-artist-live-summary-v1" || liveSummary.coverage?.cells !== expectedLiveCells.size)
  throw new Error("Artist live summary is missing or stale");
if (liveSummary.coverage.successful + liveSummary.coverage.failed !== expectedLiveCells.size || liveSummary.decision !== "reject-production-default")
  throw new Error("Artist live summary has an invalid decision or coverage");
for (const relative of ["provider-evidence-2026-09-16.md", "user-study-pack-v1.md", "final-decision-2026-09-16.md"])
  await access(new URL(`../research/ai-drawing/${relative}`, import.meta.url));
process.stdout.write(`Tutor AI drawing benchmark OK: ${counts.anime} anime, ${counts.mechanics} mechanics, ${counts.general} general; ${records.length} local run records; ${mechanicsFixture.cases.length}/24 mechanics baselines; ${artistReport.coverage.cells} protocol cells, 3 live probes and ${seenLiveCells.size} scored live cells validated.\n`);
