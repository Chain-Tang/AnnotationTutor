import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { sealRelease } from "./release-transaction.mjs";
import { verifyPackage } from "./verify-package.mjs";
import { collectLicenses } from "./collect-licenses.mjs";

const id = "annotation-tutor-lite", version = "0.0.1";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-package-verification-"));
  const plugin = path.join(root, "dist", "release", id);
  const manifest = { id, version };
  const extension = { version: "0.2.0", background: { service_worker: "background.js" },
    action: { default_popup: "popup.html" }, icons: { 16: "icon.png" }, content_scripts: [{ js: ["content.js"] }] };
  const extensionNotices = ["@mozilla/readability", "turndown", "turndown-plugin-gfm"].map(name => ({
    name, version: "1.0.0", files: [`${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}/LICENSE`]
  }));
  const files = {
    "main.js": "fixture main", "desktop.js": "fixture desktop", "mobile.js": "fixture mobile",
    "styles.css": "/* fixture */", "manifest.json": JSON.stringify(manifest),
    "credential-compatibility.json": "{}", "assets/fonts/manifest.json": "{}", "assets/fonts/OFL.txt": "fixture license",
    "licenses/dependencies.json": JSON.stringify([{ name: "fixture", version: "1.0.0", files: ["fixture/LICENSE"] }, ...extensionNotices]),
    "web-clipper/licenses/dependencies.json": JSON.stringify(extensionNotices),
    ...Object.fromEntries(extensionNotices.flatMap(notice => notice.files.flatMap(file => [
      [`licenses/${file}`, "fixture extension license"], [`web-clipper/licenses/${file}`, "fixture extension license"]
    ]))),
    "licenses/fixture/LICENSE": "fixture license", "web-clipper/manifest.json": JSON.stringify(extension),
    "web-clipper/background.js": "", "web-clipper/popup.html": "", "web-clipper/icon.png": "fixture icon", "web-clipper/content.js": "",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(plugin, file)), { recursive: true });
    await writeFile(path.join(plugin, file), content);
  }
  await mkdir(path.join(root, "extension"));
  await writeFile(path.join(root, "extension", "manifest.json"), JSON.stringify(extension));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  const archive = path.join(root, "dist", `${id}-${version}.zip`);
  async function pack(change = entries => entries) {
    const receipt = await sealRelease(plugin);
    const entries = {};
    for (const file of [...Object.keys(receipt.files), "release-files.json"]) entries[`${id}/${file}`] = await readFile(path.join(plugin, file));
    await writeFile(archive, zipSync(change(entries)));
  }
  await pack();
  return { root, plugin, pack };
}

test("package verification records a matching sealed archive", async () => {
  const f = await fixture();
  try {
    const report = await verifyPackage(f.root);
    assert.equal(report.passed, true);
    assert.equal(report.version, version);
    assert.equal(report.extensionVersion, "0.2.0");
    assert.equal(report.extensionBundledDependencies, 3);
    assert.equal(report.sha256.length, 64);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.root, "dist", "package-verification.json"), "utf8")), report);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("package verification rejects archive tampering and unlisted files", async () => {
  const f = await fixture();
  try {
    await f.pack(entries => ({ ...entries, [`${id}/main.js`]: Buffer.from("tampered") }));
    await assert.rejects(verifyPackage(f.root), /Archive bytes differ: main.js/);
    await f.pack(entries => ({ ...entries, [`${id}/data.json`]: Buffer.from("private settings") }));
    await assert.rejects(verifyPackage(f.root), /Archive differs from sealed release/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("package verification rejects a missing extension asset even if the archive is sealed", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.plugin, "web-clipper", "icon.png")); await f.pack();
    await assert.rejects(verifyPackage(f.root), /Extension asset missing: icon.png/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("package verification rejects missing license files referenced by metadata", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.plugin, "licenses", "fixture", "LICENSE")); await f.pack();
    await assert.rejects(verifyPackage(f.root), /Dependency notice missing: fixture\/LICENSE/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("package verification rejects missing extension notices and incomplete bundled metadata", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.plugin, "web-clipper/licenses/turndown/LICENSE")); await f.pack();
    await assert.rejects(verifyPackage(f.root), /Extension dependency notice missing: turndown\/LICENSE/);
    await writeFile(path.join(f.plugin, "web-clipper/licenses/turndown/LICENSE"), "fixture license");
    const metadataPath = path.join(f.plugin, "web-clipper/licenses/dependencies.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, JSON.stringify(metadata.filter(dep => dep.name !== "@mozilla/readability"))); await f.pack();
    await assert.rejects(verifyPackage(f.root), /Extension dependency metadata missing: @mozilla\/readability/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("package verification requires extension dependencies in the combined release inventory", async () => {
  const f = await fixture();
  try {
    const metadataPath = path.join(f.plugin, "licenses/dependencies.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, JSON.stringify(metadata.filter(dep => dep.name !== "turndown"))); await f.pack();
    await assert.rejects(verifyPackage(f.root), /Release dependency metadata missing: turndown/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("license collection resolves the esbuild working directory and only includes bundled dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tutor-license-collection-"));
  try {
    const extension = path.join(root, "extension"), bundled = path.join(extension, "node_modules/bundled"), unused = path.join(extension, "node_modules/unused");
    await mkdir(bundled, { recursive: true }); await mkdir(unused, { recursive: true });
    await writeFile(path.join(bundled, "package.json"), JSON.stringify({ name: "bundled", version: "1.0.0", license: "MIT" }));
    await writeFile(path.join(bundled, "LICENSE"), "upstream bundled license");
    await writeFile(path.join(unused, "package.json"), JSON.stringify({ name: "unused", version: "1.0.0", license: "MIT" }));
    const destination = path.join(extension, "dist/licenses");
    await collectLicenses([{ inputs: { "node_modules/bundled/index.js": {}, "src/app.ts": {} } }], destination, { absWorkingDir: extension });
    const notices = JSON.parse(await readFile(path.join(destination, "dependencies.json"), "utf8"));
    assert.deepEqual(notices.map(dep => dep.name), ["bundled"]);
    assert.equal(await readFile(path.join(destination, notices[0].files[0]), "utf8"), "upstream bundled license");
    await rm(path.join(bundled, "LICENSE"));
    await collectLicenses([{ inputs: { "node_modules/bundled/index.js": {} } }], destination, { absWorkingDir: extension });
    const fallback = JSON.parse(await readFile(path.join(destination, "dependencies.json"), "utf8"));
    assert.equal(fallback[0].files[0], "bundled_1.0.0/NOTICE.txt");
    assert.match(await readFile(path.join(destination, fallback[0].files[0]), "utf8"), /MIT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
