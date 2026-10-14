// Independent extension build — deliberately isolated from the plugin's
// scripts/build.mjs (separate release channel, browser target, no Obsidian
// externals). Bundles each MV3 entry point with esbuild and copies the static
// manifest + HTML/CSS into dist/, which is the loadable unpacked extension.

import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { collectLicenses } from "../scripts/collect-licenses.mjs";

const root = path.resolve(import.meta.dirname);
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");
const src = (p) => path.join(root, "src", p);
const out = (p) => path.join(dist, p);

// Content/offscreen/popup run as classic scripts (iife); the service worker is a
// module worker (esm). All bundled, browser-targeted, no external packages.
const bundles = [
  { entry: src("background.ts"), outfile: out("background.js"), format: "esm" },
  { entry: src("content.ts"), outfile: out("content.js"), format: "iife" },
  { entry: src("offscreen.ts"), outfile: out("offscreen.js"), format: "iife" },
  { entry: src("popup/popup.ts"), outfile: out("popup.js"), format: "iife" }
];

/** @type {import("esbuild").BuildOptions} */
const shared = {
  absWorkingDir: root,
  metafile: true,
  bundle: true,
  platform: "browser",
  target: "chrome116",
  sourcemap: true,
  minify: !watch,
  logLevel: "info"
};

const assets = [
  { from: path.join(root, "manifest.json"), to: out("manifest.json"), recursive: false },
  { from: path.join(root, "offscreen.html"), to: out("offscreen.html"), recursive: false },
  { from: src("popup/popup.html"), to: out("popup.html"), recursive: false },
  { from: src("popup/popup.css"), to: out("popup.css"), recursive: false },
  ...[16, 32, 48, 128].map((size) => ({
    from: path.join(root, "icons", `icon-${size}.png`),
    to: out(`icon-${size}.png`),
    recursive: false
  })),
  {
    from: path.join(root, "icons", "empty-highlights.png"),
    to: out("empty-highlights.png"),
    recursive: false
  },
  // Chrome's manifest i18n (extension name / description per UI language).
  { from: path.join(root, "_locales"), to: out("_locales"), recursive: true }
];

async function copyAssets() {
  for (const { from, to, recursive } of assets) await cp(from, to, { recursive });
}

await mkdir(dist, { recursive: true });

if (watch) {
  const builders = await Promise.all(
    bundles.map((b) =>
      context({ ...shared, entryPoints: [b.entry], outfile: b.outfile, format: b.format })
    )
  );
  await Promise.all(builders.map((builder) => builder.watch()));
  await copyAssets();
  console.log("Watching Web Clipper extension build...");
} else {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  // Packaging awaits this module under its artifact lock. Wait for every
  // builder even after a failure so no peer can keep writing after unlock.
  const results = await Promise.allSettled(
    bundles.map((b) =>
      build({ ...shared, entryPoints: [b.entry], outfile: b.outfile, format: b.format })
    )
  );
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  await collectLicenses(results.map(result => result.value.metafile), out("licenses"), { absWorkingDir: root });
  await copyAssets();
  console.log("Web Clipper extension built to dist/.");
}
