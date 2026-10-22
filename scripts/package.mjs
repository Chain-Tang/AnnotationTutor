import { sealRelease } from "./release-transaction.mjs";
import { withBuiltArtifacts } from "./build.mjs";
// Package the built plugin into release-ready artifacts:
//   dist/release/annotation-tutor-lite/{main.js,manifest.json,styles.css,assets/fonts/}
//   dist/annotation-tutor-lite-<version>.zip  (the folder, ready to unzip into
//                                              <Vault>/.obsidian/plugins/)
// Install the complete folder/ZIP: offline board fonts in assets/fonts are
// required in addition to the three conventional Obsidian plugin files.

import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const PLUGIN_ID = "annotation-tutor-lite";
const root = path.resolve(import.meta.dirname, "..");

// Build once and keep the artifact lock through staging and archive creation.
await withBuiltArtifacts(async () => {

// Refresh the independent browser build under the package's artifact lock so
// a same-version extension/dist from an earlier edit cannot enter the release.
await import("../extension/build.mjs");

// 2. Stage the plugin files into dist/release/<id>/.
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const version = manifest.version ?? "0.0.0";
const releaseDir = path.join(root, "dist", "release");
const pluginDir = path.join(releaseDir, PLUGIN_ID);
await rm(releaseDir, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });
const files = ["main.js", "desktop.js", "mobile.js", "manifest.json", "styles.css", "credential-compatibility.json"];
for (const [from, to] of [
  ["dist/main.js", "main.js"],
  ["dist/desktop.js", "desktop.js"],
  ["dist/mobile.js", "mobile.js"],
  ["dist/credential-compatibility.json", "credential-compatibility.json"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"],
]) {
  await cp(path.join(root, from), path.join(pluginDir, to));
}
console.log(`Staged ${PLUGIN_ID} v${version} -> ${pluginDir}`);

// 2a. The hand-drawn board has offline font subsets and their license notices.
const fontDir = path.join(root, "dist/assets/fonts");
await cp(fontDir, path.join(pluginDir, "assets/fonts"), { recursive: true });
for (const rel of await readdir(fontDir, { recursive: true })) {
  if (statSync(path.join(fontDir, rel)).isFile())
    files.push(`assets/fonts/${rel.split(path.sep).join("/")}`);
}

const officialTemplateDir = path.join(root, "dist/assets/web-clipper");
await cp(officialTemplateDir, path.join(pluginDir, "assets/web-clipper"), { recursive: true });
for (const rel of await readdir(officialTemplateDir, { recursive: true })) {
  if (statSync(path.join(officialTemplateDir, rel)).isFile())
    files.push(`assets/web-clipper/${rel.split(path.sep).join("/")}`);
}

const licenses=path.join(root,"dist/licenses");
await cp(licenses,path.join(pluginDir,"licenses"),{recursive:true});
// The release includes both plugin and extension bundles. Keep a complete
// top-level dependency inventory as well as the extension's standalone notices.
const extensionLicenses=path.join(root,"extension/dist/licenses");
const licenseNotices=new Map();
for(const source of [licenses,extensionLicenses]){
  const dependencies=JSON.parse(await readFile(path.join(source,"dependencies.json"),"utf8"));
  await cp(source,path.join(pluginDir,"licenses"),{recursive:true});
  for(const dependency of dependencies)licenseNotices.set(`${dependency.name}@${dependency.version}`,dependency);
}
await writeFile(path.join(pluginDir,"licenses/dependencies.json"),JSON.stringify([...licenseNotices.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version)),null,2)+"\n");
for(const rel of await readdir(path.join(pluginDir,"licenses"),{recursive:true}))if(statSync(path.join(pluginDir,"licenses",rel)).isFile())files.push(`licenses/${rel.split(path.sep).join("/")}`);

// 2b. Bundle the Web Clipper extension (loaded unpacked until it's in a store).
//     Collect its files so they also land inside the release zip.
const extDist = path.join(root, "extension", "dist");
const webClipperEntries = [];
if (existsSync(extDist)) {
  await cp(extDist, path.join(pluginDir, "web-clipper"), {
    recursive: true,
    filter: source => !source.endsWith(".map"),
  });
  for (const rel of await readdir(extDist, { recursive: true })) {
    const abs = path.join(extDist, rel);
    if (!statSync(abs).isFile() || rel.endsWith(".map")) continue;
    webClipperEntries.push({
      name: `web-clipper/${rel.split(path.sep).join("/")}`,
      data: await readFile(abs),
    });
  }
  console.log(
    `Bundled Web Clipper extension (${webClipperEntries.length} files)`,
  );
} else {
  console.warn("No extension/dist found — skipping Web Clipper bundle.");
}

await cp(path.join(root,"docs/tutor-learning-upgrade.md"),path.join(pluginDir,"UPGRADE.md"));
await cp(path.join(root,"docs/private-storage-recovery.md"),path.join(pluginDir,"PRIVATE-STORAGE.md"));
await writeFile(path.join(pluginDir,"compatibility.json"),JSON.stringify({format:1,version,channel:"commercial-s2-internal-candidate",boardFormat:5,vectorAssetFormat:"board-vector-v1",learningRecordFormat:3,readableLearningFormats:[1,2,3],restrictedEvidenceFormat:3,naturalLearning:"v3-candidate-awaiting-real-acceptance",automaticFreeTextEvidence:false,credentialReferences:1,surfaceTransactions:1,clipperAuthorization:2,legacyRecords:"preserved",defaultOff:["learningFlowEnabled","supportCheckinEnabled","learningExpertsEnabled"],rollback:"managed program rollback; reference recovery required for legacy programs",verification:"See the validation report adjacent to the sealed milestone package; candidate is not commercial acceptance",unverified:["S2 full real interaction matrix","S3 desktop matrix","professional mental-health review","minors","longitudinal benefit","Android device","remote multi-agent"]},null,2)+"\n");
files.push("UPGRADE.md","PRIVATE-STORAGE.md","compatibility.json");
await sealRelease(pluginDir);
files.push("release-files.json");

// 3. Zip the folder into a single ready-to-unzip plugin directory. Written in
//    pure Node so the archive is identical on every OS — crucially using ZIP's
//    mandatory forward-slash separators. (Windows `Compress-Archive` writes
//    backslash entry names, which macOS/Linux unzip treat as literal filenames,
//    so `main.js` never lands in a folder and the plugin fails to load there.)
const entries = [];
for (const file of files) {
  entries.push({
    name: `${PLUGIN_ID}/${file}`,
    data: await readFile(path.join(pluginDir, file)),
  });
}
for (const { name, data } of webClipperEntries) {
  entries.push({ name: `${PLUGIN_ID}/${name}`, data });
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
});
