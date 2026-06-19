// Package the built plugin into release-ready artifacts:
//   dist/release/annotation-tutor-lite/{main.js,manifest.json,styles.css}
//   dist/annotation-tutor-lite-<version>.zip  (the folder, ready to unzip into
//                                              <Vault>/.obsidian/plugins/)
// The loose three files are what Obsidian (and BRAT) expect as release assets;
// the zip is a convenience for manual installers.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const PLUGIN_ID = "annotation-tutor-lite";
const root = path.resolve(import.meta.dirname, "..");

// 1. Build a fresh dist/main.js (build.mjs runs its one-shot build on import).
await import("./build.mjs");

// 2. Stage the three shippable files into dist/release/<id>/.
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version ?? "0.0.0";
const releaseDir = path.join(root, "dist", "release");
const pluginDir = path.join(releaseDir, PLUGIN_ID);
await rm(releaseDir, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });
const files = ["main.js", "manifest.json", "styles.css"];
for (const [from, to] of [
  ["dist/main.js", "main.js"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"]
]) {
  await cp(path.join(root, from), path.join(pluginDir, to));
}
console.log(`Staged ${PLUGIN_ID} v${version} -> ${pluginDir}`);

// 3. Zip the folder into a single ready-to-unzip plugin directory. Written in
//    pure Node so the archive is identical on every OS — crucially using ZIP's
//    mandatory forward-slash separators. (Windows `Compress-Archive` writes
//    backslash entry names, which macOS/Linux unzip treat as literal filenames,
//    so `main.js` never lands in a folder and the plugin fails to load there.)
const entries = [];
for (const file of files) {
  entries.push({
    name: `${PLUGIN_ID}/${file}`,
    data: await readFile(path.join(pluginDir, file))
  });
}
const zipPath = path.join(root, "dist", `${PLUGIN_ID}-${version}.zip`);
await writeFile(zipPath, buildZip(entries));
console.log(`Wrote ${zipPath}`);

/** Build a ZIP (deflate) buffer from `{ name, data }` entries, names as given. */
function buildZip(entries) {
  const DOS_DATE = 0x21; // 1980-01-01; a zero date trips some unzip tools.
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(DOS_DATE, 12); // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra length
    local.push(lh, nameBuf, compressed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory header signature
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(8, 10); // method: deflate
    ch.writeUInt16LE(0, 12); // mod time
    ch.writeUInt16LE(DOS_DATE, 14); // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra length
    ch.writeUInt16LE(0, 32); // comment length
    ch.writeUInt16LE(0, 34); // disk number start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...local, centralBuf, eocd]);
}
