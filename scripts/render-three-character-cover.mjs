import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(process.argv[2] ?? path.join(root, "research/ai-drawing/three-character-cover"));
const compiledPath = path.join(root, "node_modules/.cache/tutor-three-character-cover.mjs");
await mkdir(path.dirname(compiledPath), { recursive: true });
await build({ stdin: {
  contents: [
    'export * from "./src/board-comic-cover.ts";',
    'export {renderBoardSvg} from "./src/board-renderer.ts";',
    'export {buildTutorBoardArchive} from "./src/board-share.ts";',
    'export {validateBoardDocument} from "./src/board-model.ts";',
  ].join("\n"),
  resolveDir: root, sourcefile: "three-character-cover-entry.ts", loader: "ts",
}, bundle: true, platform: "node", format: "esm", outfile: compiledPath, logLevel: "silent" });
const source = await import(compiledPath);
const plan = source.defaultThreeCharacterArtworkPlan();
const stages = [];
const asset = await source.createThreeCharacterCoverSession(plan, { onStage: event => stages.push({ stage: event.stage, asset: event.asset, elapsedMs: event.elapsedMs, created: event.created.length, warnings: event.warnings }) });
const inspection = source.inspectThreeCharacterCover(asset, plan);
if (!inspection.valid || inspection.editablePartRatio < .9) throw new Error(`Cover failed native-art checks: ${inspection.warnings.join("; ")}`);
await mkdir(output, { recursive: true });
const stageDir = path.join(output, "stages");
await mkdir(stageDir, { recursive: true });
for (const [index, stage] of stages.entries()) {
  const name = `${String(index + 1).padStart(2, "0")}-${stage.stage}`;
  const svgPath = path.join(stageDir, `${name}.svg`);
  await writeFile(svgPath, source.renderBoardSvg([{ id: `stage-${index}`, kind: "vector", vectorAssetId: stage.asset.id, vectorAssetVersion: 1, anchor: { kind: "canvas", pageId: "main" }, x: 0, y: 0, width: 800, height: 1200, color: "#151321", strokeWidth: 1, layerId: "stage", createdBy: "tutor", editedBy: "tutor", revision: 1, groupId: "stage" }], { width: 800, height: 1200, ink: {}, characters: [], vectorAssets: [stage.asset], layers: [{ id: "stage", name: "Stage", order: 0, visible: true, locked: false, opacity: 1, blendMode: "normal" }] }));
  await run("sips", ["-s", "format", "png", svgPath, "--out", path.join(stageDir, `${name}.png`)], { timeout: 120_000 });
}

const anchor = { kind: "canvas", pageId: "main" };
const now = new Date().toISOString();
const referenceAsset = structuredClone(stages.find(stage => stage.stage === "composition").asset);
referenceAsset.id = "three-way-collision-composition-reference";
const document = source.validateBoardDocument({
  schemaVersion: 5, id: "BOARD-NOVA-COLLISION-1994", sourceFile: "Agent Memory/standalone/Nova-Collision.tutorboard.md", sourceType: "standalone", sourceRevision: "",
  revision: 1, createdAt: now, updatedAt: now, characterId: "tutor-round", characterVersion: 1,
  objects: [{ id: "composition-reference-object", kind: "vector", vectorAssetId: referenceAsset.id, vectorAssetVersion: referenceAsset.version, anchor,
    x: 0, y: 0, width: 2048, height: 3072, color: "#151321", strokeWidth: 1, layerId: "composition-reference", groupId: "composition-reference-group", createdBy: "tutor", editedBy: "tutor", revision: 1 },
  { id: "cover-vector-object", kind: "vector", vectorAssetId: asset.id, vectorAssetVersion: asset.version, anchor,
    x: 0, y: 0, width: 2048, height: 3072, color: "#151321", strokeWidth: 1, layerId: "cover-vector", groupId: "cover-group", createdBy: "tutor", editedBy: "tutor", revision: 1 }],
  vectorAssets: [asset, referenceAsset], artboards: [{ id: "artboard-main", name: "NOVA COLLISION", x: 0, y: 0, width: 2048, height: 3072, dpi: 300, background: plan.palette.paper, exportPreset: "print" }],
  layers: [{ id: "composition-reference", name: "Composition reference · hidden", order: 0, visible: false, locked: true, opacity: 1, blendMode: "normal", kind: "vector", alphaLocked: false, clippedToBelow: false },
    { id: "cover-vector", name: "Editable comic cover", order: 1, visible: true, locked: false, opacity: 1, blendMode: "normal", kind: "vector", alphaLocked: false, clippedToBelow: false }],
  background: { kind: "plain", color: plan.palette.paper, opacity: 1, spacing: 24 }, palette: Object.values(plan.palette),
  semanticGroups: [], inkManifest: { format: "ink-pack-v1", packs: [] },
});
const svg = source.renderBoardSvg(document.objects, { width: 2048, height: 3072, viewport: { x: 0, y: 0, width: 2048, height: 3072 }, ink: {}, characters: [], layers: document.layers, background: document.background, vectorAssets: document.vectorAssets });
await writeFile(path.join(output, "Nova-Collision.svg"), svg);
await run("sips", ["-s", "format", "png", path.join(output, "Nova-Collision.svg"), "--out", path.join(output, "Nova-Collision.png")], { timeout: 120_000 });
const png = new Uint8Array(await readFile(path.join(output, "Nova-Collision.png")));
await writeFile(path.join(output, "Nova-Collision.board.json"), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(path.join(output, "Nova-Collision.tutorboard"), await source.buildTutorBoardArchive({ document, ink: {}, previewPng: png, includeHidden: true, includePrivateMetadata: false }));
await writeFile(path.join(output, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
await writeFile(path.join(output, "inspection.json"), `${JSON.stringify({ ...inspection, nodeCount: asset.nodes.length, pathCommands: asset.nodes.reduce((sum, node) => sum + (node.path?.length ?? 0), 0), characters: plan.characters.map(character => character.name), nativeArtwork: true, imageLayers: 0 }, null, 2)}\n`);
await writeFile(path.join(output, "stages.json"), `${JSON.stringify(stages.map(({ stage, elapsedMs, created, warnings, asset }) => ({ stage, elapsedMs, created, warnings, nodeCount: asset.nodes.length })), null, 2)}\n`);
process.stdout.write(`Rendered ${output}: ${asset.nodes.length} native nodes, editable ratio ${inspection.editablePartRatio.toFixed(3)}\n`);
