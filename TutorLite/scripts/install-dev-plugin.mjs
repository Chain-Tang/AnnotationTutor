import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PLUGIN_ID = "annotation-tutor-lite";

const root = path.resolve(import.meta.dirname, "..");
const vaultFlagIndex = process.argv.indexOf("--vault");
const vaultArg =
  vaultFlagIndex >= 0 ? process.argv[vaultFlagIndex + 1] : undefined;
// Default to the repo's Tutor Vault; the distinct plugin id lets Lite install
// alongside the full Annotation Tutor plugin.
const vault = path.resolve(vaultArg ?? path.join(root, "..", "Tutor"));
const target = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);

// 1. Copy the built plugin into the Vault.
await mkdir(target, { recursive: true });
for (const file of ["dist/main.js", "manifest.json", "styles.css"]) {
  await cp(path.join(root, file), path.join(target, path.basename(file)));
}
console.log(`Installed ${PLUGIN_ID} to ${target}`);

// 2. Enable it by adding the id to the Vault's community-plugins list. Obsidian
//    reads this on startup, so a running Obsidian needs a reload to pick it up.
const enableListPath = path.join(vault, ".obsidian", "community-plugins.json");
const enabled = await readEnableList(enableListPath);
if (enabled === null) {
  console.warn(
    `Could not parse ${enableListPath}; left it unchanged. Enable "${PLUGIN_ID}" manually in Obsidian.`
  );
} else {
  if (!enabled.includes(PLUGIN_ID)) enabled.push(PLUGIN_ID);
  await writeFile(enableListPath, `${JSON.stringify(enabled, null, 2)}\n`, "utf8");
  console.log(`Enabled ${PLUGIN_ID} in ${enableListPath}`);
  console.log("Reload Obsidian (Ctrl/Cmd+R) or reopen the Vault to load it.");
}

async function readEnableList(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    return null; // Malformed: signal "leave it alone".
  }
}
