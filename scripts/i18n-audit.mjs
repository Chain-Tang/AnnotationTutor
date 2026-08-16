// Deeper i18n audit beyond key parity: key ORDER drift between dictionaries
// (a strong smell for a translation pasted onto the wrong key), values that are
// byte-identical to English (untranslated), and placeholder mismatches
// ({name} vars present in en but missing in a translation).
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");

/** Extract `const NAME: ... = { ... };` bodies for the four dictionaries. */
function dict(name) {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`dictionary ${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  const entries = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(body))) entries.push([m[1], JSON.parse(m[2])]);
  return entries;
}

const names = ["en", "zhCn", "zhTw", "ja"];
const dicts = Object.fromEntries(names.map((n) => [n, dict(n)]));
const en = dicts.en;
const enMap = new Map(en);

let problems = 0;
for (const name of names.slice(1)) {
  const entries = dicts[name];
  const map = new Map(entries);
  // 1. order drift
  const orderDrift = [];
  for (let i = 0; i < Math.min(en.length, entries.length); i++) {
    if (en[i][0] !== entries[i][0]) orderDrift.push(`#${i} en=${en[i][0]} ${name}=${entries[i][0]}`);
  }
  if (orderDrift.length) {
    problems++;
    console.log(`\n[${name}] key ORDER differs from EN at ${orderDrift.length} positions:`);
    for (const line of orderDrift.slice(0, 8)) console.log(`  ${line}`);
  }
  // 2. untranslated (identical to en, ignoring pure-symbol/short values)
  const same = [];
  for (const [key, value] of entries) {
    const enValue = enMap.get(key);
    if (enValue === undefined) continue;
    if (enValue === value && /[A-Za-z]{4}/.test(value)) same.push(`${key} = ${value}`);
  }
  if (same.length) {
    console.log(`\n[${name}] ${same.length} values identical to EN (possibly untranslated):`);
    for (const line of same.slice(0, 20)) console.log(`  ${line}`);
  }
  // 3. placeholder mismatch
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
  const badVars = [];
  for (const [key, value] of entries) {
    const enValue = enMap.get(key);
    if (enValue === undefined) continue;
    if (vars(enValue) !== vars(value)) {
      badVars.push(`${key}: en{${vars(enValue)}} vs ${name}{${vars(value)}}`);
    }
  }
  if (badVars.length) {
    problems++;
    console.log(`\n[${name}] ${badVars.length} placeholder mismatches:`);
    for (const line of badVars) console.log(`  ${line}`);
  }
}

// 4. duplicate keys inside one dictionary (later silently wins)
for (const name of names) {
  const seen = new Set();
  const dupes = [];
  for (const [key] of dicts[name]) {
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  if (dupes.length) {
    problems++;
    console.log(`\n[${name}] duplicate keys: ${dupes.join(", ")}`);
  }
}

console.log(
  `\ncounts: ${names.map((n) => `${n}=${dicts[n].length}`).join(" ")}\n${
    problems === 0 ? "AUDIT CLEAN (order/placeholders/duplicates)" : `AUDIT FOUND ${problems} problem groups`
  }`
);
