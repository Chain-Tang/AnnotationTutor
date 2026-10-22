import {collectLicenses} from "./collect-licenses.mjs";
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withReleaseLock } from "./release-transaction.mjs";
import { writeCredentialCompatibility } from "./release-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
const outfile = path.join(root, "dist/desktop.js");
const builtAt = new Date().toISOString();
let buildId = process.env.ATL_BUILD_ID;
if (!buildId) {
  try { buildId = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { buildId = "local"; }
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: [path.join(root, "src/main.ts")],
  outfile,
  bundle: true,
  metafile:true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // Production artifacts stay compact; watch builds retain readable code.
  minify: !watch,
  logLevel: "info",
  plugins: [{
    name: "offline-board-outline-worker",
    setup(builder) {
      builder.onLoad({filter: /board-outline-worker-source\.ts$/}, async () => {
        const worker = await build({
          absWorkingDir: root,
          entryPoints: [path.join(root, "src/board-outline-worker.ts")],
          bundle: true, platform: "browser", target: "es2022", format: "iife",
          minify: !watch,
          write: false, metafile: true, logLevel: "silent",
        });
        return {contents: `export const boardOutlineWorkerSource = ${JSON.stringify(worker.outputFiles[0].text)};`,
          loader: "js", watchFiles: Object.keys(worker.metafile.inputs).map(file => path.resolve(root, file))};
      });
    },
  }],
  define: {
    __ATL_BUILD_ID__: JSON.stringify(buildId),
    __ATL_BUILD_TIME__: JSON.stringify(builtAt),
  },
  // Obsidian provides these at runtime; never bundle them.
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
  ],
};

async function buildOutputs() {
await mkdir(path.dirname(outfile), { recursive: true });
// Font binaries and OFL notices remain offline beside the installed plugin.
await cp(
  path.join(root, "assets/fonts"),
  path.join(root, "dist/assets/fonts"),
  { recursive: true },
);
await cp(
  path.join(root, "assets/web-clipper"),
  path.join(root, "dist/assets/web-clipper"),
  { recursive: true },
);

const mobileOptions={...options,entryPoints:[path.join(root,"src/mobile/main.ts")],outfile:path.join(root,"dist/mobile.js"),platform:"browser",target:"es2022"};
const entryOptions={...options,entryPoints:[path.join(root,"src/platform-entry.ts")],outfile:path.join(root,"dist/main.js"),external:options.external};
if (watch) {
  const builders=[];
  try {
    for(const item of [options,mobileOptions,entryOptions]){const builder=await context(item);builders.push(builder);await builder.watch();}
    console.log("Watching Annotation Tutor Lite build...");
    await new Promise(resolve=>{const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};process.once('SIGINT',stop);process.once('SIGTERM',stop);});
  } finally { await Promise.all(builders.map(builder=>builder.dispose())); }
} else {
  await rm(outfile, { force: true });
  // A rejected build must not release the lock while its peers still write.
  const builds=await Promise.allSettled([build(options),build(mobileOptions),build(entryOptions)]);
  const failed=builds.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
  await collectLicenses(builds.map(result=>result.value.metafile),path.join(root,"dist/licenses"),{absWorkingDir:root});
  await writeCredentialCompatibility(path.join(root, "dist"));
}
}

/** Packaging consumes these exact outputs while other builders remain excluded. */
export async function withBuiltArtifacts(consume = async () => {}) {
  return withReleaseLock(path.join(root, 'dist', 'artifacts'), async () => {
    await buildOutputs();
    return consume();
  });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await withBuiltArtifacts();
