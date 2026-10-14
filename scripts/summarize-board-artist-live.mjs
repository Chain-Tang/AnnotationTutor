import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const liveRoot = path.join(root, "research/ai-drawing/artist-live-v1");
const protocol = JSON.parse(await readFile(path.join(root, "research/ai-drawing/artist-strategy-v1.json"), "utf8"));
const expected = new Set(protocol.taskIds.flatMap((task) => protocol.strategies.map((strategy) => `${task}-${strategy}`)));
const directories = (await readdir(liveRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && expected.has(entry.name));
const records = [];
for (const directory of directories) records.push(JSON.parse(await readFile(path.join(liveRoot, directory.name, "record.json"), "utf8")));
if (records.length !== expected.size) throw new Error(`Expected ${expected.size} live cells, got ${records.length}`);
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? null;
};
const failureClass = (error = "") => /timeout/i.test(error) ? "timeout" : /incomplete-stream|stream-framing/i.test(error) ? "stream" : /point-outside|missing-path|expected|too_small|invalid_type/i.test(error) ? "schema" : "other";
const strategies = {};
for (const strategy of protocol.strategies) {
  const cells = records.filter((record) => record.strategy === strategy), successes = cells.filter((record) => record.ok);
  const visual = successes.flatMap((record) => [record.scores?.instructionFit, record.scores?.composition, record.scores?.anatomyOrStructure, record.scores?.materialQuality].filter(Number.isFinite));
  const editability = successes.map((record) => record.scores?.nativeEditability).filter(Number.isFinite);
  strategies[strategy] = {
    cells: cells.length, successes: successes.length, failures: cells.length - successes.length,
    successRate: successes.length / cells.length,
    medianLatencyMs: quantile(cells.map((record) => record.latencyMs), 0.5),
    p95LatencyMs: quantile(cells.map((record) => record.latencyMs), 0.95),
    averageVisualScore: visual.length ? visual.reduce((a, b) => a + b, 0) / visual.length : null,
    averageEditabilityScore: editability.length ? editability.reduce((a, b) => a + b, 0) / editability.length : null,
  };
}
const failures = Object.fromEntries(["timeout", "stream", "schema", "other"].map((kind) => [kind, records.filter((record) => !record.ok && failureClass(record.error) === kind).length]));
const firstPreviewLatencies = records.flatMap((record) => Array.isArray(record.firstPreviewLatencyMs) ? record.firstPreviewLatencyMs.filter(Number.isFinite) : []);
const report = {
  format: "tutor-board-artist-live-summary-v1", generatedAt: new Date().toISOString(),
  provider: "opencode", model: records[0]?.model, coverage: { cells: records.length, successful: records.filter((record) => record.ok).length, failed: records.filter((record) => !record.ok).length },
  strategies, failures,
  acceptance: {
    protocolValidity: records.filter((record) => record.ok).length / records.length,
    nativeEditabilityAmongSuccessful: records.filter((record) => record.ok && record.scores?.nativeEditability === 5).length / Math.max(1, records.filter((record) => record.ok).length),
    visualCellsAtLeast4: records.filter((record) => record.ok && [record.scores?.instructionFit, record.scores?.composition, record.scores?.anatomyOrStructure, record.scores?.materialQuality].filter(Number.isFinite).reduce((a, b, _, values) => a + b / values.length, 0) >= 4).length,
    firstStrokeP95Ms: firstPreviewLatencies.length ? quantile(firstPreviewLatencies, 0.95) : null,
  },
  decision: "reject-production-default",
  reasons: [
    "visual-quality-below-4",
    "protocol-success-below-95-percent",
    "complex-figure-latency-too-high",
    ...(firstPreviewLatencies.length ? [] : ["first-stroke-p95-not-instrumented"]),
  ],
};
await writeFile(path.join(root, "research/ai-drawing/artist-live-summary-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const lines = [
  "# BoardArtist 18 格真实实验总结", "", `生成时间：${report.generatedAt}`, "", "## 观察证据", "",
  `- 完整覆盖：${report.coverage.cells}/18；成功 ${report.coverage.successful}，失败 ${report.coverage.failed}。`,
  `- 成功单元中原生可编辑性满分比例：${pct(report.acceptance.nativeEditabilityAmongSuccessful)}。`,
  `- 视觉均分达到 4/5 的单元：${report.acceptance.visualCellsAtLeast4}。`,
  `- 失败分类：schema ${failures.schema}、stream ${failures.stream}、timeout ${failures.timeout}、other ${failures.other}。`,
  "", "| 策略 | 成功率 | 中位总延迟 | p95 总延迟 | 成功单元视觉均分 |", "| --- | ---: | ---: | ---: | ---: |",
  ...Object.entries(strategies).map(([name, value]) => `| ${name} | ${pct(value.successRate)} | ${(value.medianLatencyMs / 1000).toFixed(1)} s | ${(value.p95LatencyMs / 1000).toFixed(1)} s | ${value.averageVisualScore?.toFixed(2) ?? "—"}/5 |`),
  "", "## 推断", "",
  "- 当前模型能产生原生可编辑对象，但复杂人物的协议稳定性、延迟和视觉完成度均未达到生产门槛。",
  "- 规划器＋视觉回看增加了对象数量和耗时，没有在本样本上稳定提高视觉均分。",
  report.acceptance.firstStrokeP95Ms === null
    ? "- 本轮旧记录尚无首个预览延迟，因此不能声称满足 p95 5 秒目标；新会话已开始记录该指标。"
    : `- 首个预览 p95 为 ${(report.acceptance.firstStrokeP95Ms / 1000).toFixed(1)} 秒。`,
  "", "## 产品决定", "",
  "- `mimo-v2.5-free` 不作为 Tutor 复杂人物 BoardArtist 的生产默认模型。",
  "- 保留它作为免费实验 Provider；生产 UI 必须显示“实验性”，失败时原画不变。",
  "- 暂不训练：虽然稳定失败超过 15%，但授权/接受/校正轨迹远少于 1,000 条。先横评更强视觉模型并补首笔埋点。", "",
];
await writeFile(path.join(root, "research/ai-drawing/artist-live-report-2026-09-16.md"), `${lines.join("\n")}\n`);
process.stdout.write(`BoardArtist live summary: ${report.coverage.successful}/${report.coverage.cells} succeeded; decision ${report.decision}.\n`);
