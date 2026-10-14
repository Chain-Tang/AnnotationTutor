import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

// JavaScript scripts have no common TypeScript runtime configuration. Parse
// every entry without executing installers, research runs or recovery commands.
const root = path.resolve(import.meta.dirname, "..");
const entries = (await readdir(import.meta.dirname))
  .filter(file => file.endsWith(".mjs"))
  .map(file => path.join("scripts", file));
entries.push(path.join("extension", "build.mjs"));
for (const file of entries.sort()) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr || result.stdout}`);
}
console.log(`Syntax checked ${entries.length} JavaScript build and verification scripts.`);
