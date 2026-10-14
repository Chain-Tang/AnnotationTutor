import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { verifyRelease } from "./release-transaction.mjs";

export async function verifyPackage(root = path.resolve(import.meta.dirname, "..")) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "Package and plugin manifest versions differ");
  const pluginDir = path.join(root, "dist", "release", manifest.id);
  const receipt = await verifyRelease(pluginDir);
  assert.equal(receipt.version, manifest.version, "Staged release version differs");

  const zipFile = `${manifest.id}-${manifest.version}.zip`;
  const zip = await readFile(path.join(root, "dist", zipFile));
  const entries = unzipSync(zip);
  const expected = [...Object.keys(receipt.files), "release-files.json"]
    .map(file => `${manifest.id}/${file}`).sort();
  assert.deepEqual(Object.keys(entries).sort(), expected, "Archive differs from sealed release");
  for (const [name, bytes] of Object.entries(entries)) {
    assert(!name.includes("\\") && !name.startsWith("/") && !name.split("/").includes(".."), `Nonportable archive path: ${name}`);
    assert(!/(^|\/)data\.json$|\.map$/.test(name), `Private settings or source map in release: ${name}`);
    const rel = name.slice(manifest.id.length + 1);
    assert(Buffer.from(bytes).equals(await readFile(path.join(pluginDir, rel))), `Archive bytes differ: ${rel}`);
  }
  for (const file of ["main.js", "desktop.js", "mobile.js", "styles.css", "manifest.json", "credential-compatibility.json", "assets/fonts/manifest.json", "assets/fonts/OFL.txt", "licenses/dependencies.json", "web-clipper/manifest.json", "web-clipper/licenses/dependencies.json"]) {
    assert(receipt.files[file], `Required release asset is missing: ${file}`);
  }
  const dependencies = JSON.parse(await readFile(path.join(pluginDir, "licenses", "dependencies.json"), "utf8"));
  assert(dependencies.length > 0 && dependencies.every(dep => dep.files?.length > 0), "Bundled dependency notices are incomplete");
  for (const dependency of dependencies) for (const file of dependency.files) {
    assert(receipt.files[`licenses/${file}`], `Dependency notice missing: ${file}`);
  }
  const extensionDependencies = JSON.parse(await readFile(path.join(pluginDir, "web-clipper/licenses/dependencies.json"), "utf8"));
  assert(extensionDependencies.length > 0 && extensionDependencies.every(dep => dep.files?.length > 0), "Extension dependency notices are incomplete");
  for (const name of ["@mozilla/readability", "turndown", "turndown-plugin-gfm"]) {
    assert(extensionDependencies.some(dep => dep.name === name), `Extension dependency metadata missing: ${name}`);
  }
  for (const dependency of extensionDependencies) {
    assert(dependencies.some(dep => dep.name === dependency.name && dep.version === dependency.version), `Release dependency metadata missing: ${dependency.name}`);
    for (const file of dependency.files) assert(receipt.files[`web-clipper/licenses/${file}`], `Extension dependency notice missing: ${file}`);
  }

  const extensionManifest = JSON.parse(await readFile(path.join(pluginDir, "web-clipper", "manifest.json"), "utf8"));
  const extensionSource = JSON.parse(await readFile(path.join(root, "extension", "manifest.json"), "utf8"));
  assert.deepEqual(extensionManifest, extensionSource, "Packaged extension manifest is stale");
  const extensionAssets = [extensionManifest.background.service_worker, extensionManifest.action.default_popup,
    ...Object.values(extensionManifest.icons), ...extensionManifest.content_scripts.flatMap(script => script.js)];
  for (const file of extensionAssets) assert(receipt.files[`web-clipper/${file}`], `Extension asset missing: ${file}`);

  const bundleBytes = {};
  for (const file of ["main.js", "desktop.js", "mobile.js"]) bundleBytes[file] = (await stat(path.join(pluginDir, file))).size;
  const report = { passed: true, version: manifest.version, archive: zipFile, archiveBytes: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"), sealedFiles: expected.length, bundleBytes,
    bundledDependencies: dependencies.length, extensionBundledDependencies: extensionDependencies.length, extensionVersion: extensionManifest.version,
    portablePaths: true, archiveMatchesStagedRelease: true, checkedAt: new Date().toISOString() };
  await writeFile(path.join(root, "dist", "package-verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await verifyPackage(), null, 2));
}
