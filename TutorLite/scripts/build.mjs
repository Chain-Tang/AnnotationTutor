import { build, context } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
const outfile = path.join(root, "dist/main.js");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [path.join(root, "src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  // Obsidian provides these at runtime; never bundle them.
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"]
};

await mkdir(path.dirname(outfile), { recursive: true });

if (watch) {
  const builder = await context(options);
  await builder.watch();
  console.log("Watching Annotation Tutor Lite build...");
} else {
  await rm(outfile, { force: true });
  await build(options);
}
