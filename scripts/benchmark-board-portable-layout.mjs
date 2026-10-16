// Compare preview layout preparation with the pre-upgrade implementation.
// This microbenchmark does not measure rendering, disk writes or whole saves.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { transform } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const baselineRef = process.argv[2] ?? "22a7a7a";
const original = execFileSync("git", ["show", `${baselineRef}:src/board-controller.ts`], { cwd: root, encoding: "utf8" });
function section(start, end) {
  const from = original.indexOf(start), to = original.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Baseline ${baselineRef} does not contain ${start}`);
  return original.slice(from, to);
}
const sections = [
  section("const anchorKey =", "const now ="),
  section("function bounds(", "function clientBounds("),
  section("function objectCorners(", "function supported("),
  section("function portableObjects(", "/** Per-view lifecycle;"),
];
async function load(source) {
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const before = (await load(`${sections.join("\n")}\nexport { portableObjects };`)).portableObjects;
const after = (await load(await readFile(path.join(root, "src/board-portable-layout.ts"), "utf8"))).portableBoardObjects;
const objects = Array.from({ length: 5_000 }, (_, index) => ({
  id: `object-${index}`, kind: "path", anchor: { kind: "markdown", key: `anchor-${index}`, quote: "Fixture" },
  x: 100, y: 80, width: 30, height: 10, color: "#123456", strokeWidth: 2,
  createdBy: "human", editedBy: "human", revision: 1, groupId: `group-${index}`,
  points: Array.from({ length: 100 }, (_, point) => ({ x: point, y: point / 2 })),
}));
const oldRun = () => before(structuredClone(objects));
const newRun = () => after(objects);
if (JSON.stringify(oldRun()) !== JSON.stringify(newRun())) throw new Error("Changed preview geometry");
for (let index = 0; index < 2; index++) { oldRun(); newRun(); }
const baselineMs = [], optimizedMs = [];
function sample(run, output) {
  const start = performance.now(); run(); output.push(performance.now() - start);
}
for (let index = 0; index < 5; index++) {
  if (index % 2) { sample(newRun, optimizedMs); sample(oldRun, baselineMs); }
  else { sample(oldRun, baselineMs); sample(newRun, optimizedMs); }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
  scope: "portable preview layout preparation only; not whole saves", baselineRef,
  objects: objects.length, samples: objects.reduce((count, object) => count + object.points.length, 0),
  anchors: 5_000, warmupRunsPerImplementation: 2, measuredRunsPerImplementation: 5,
  baselineMs, optimizedMs, baselineMedianMs: median(baselineMs), optimizedMedianMs: median(optimizedMs), geometryEqual: true,
}, null, 2));
