// Temporary parity check: all four i18n dictionaries must share one key set.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
const lines = src.split(/\r?\n/);
let dict = null;
const dicts = {};
for (const line of lines) {
  const dm = /^(?:export )?const (\w+)\s*[=:]/.exec(line);
  if (dm) dict = dm[1];
  const km = /^\s*"([\w.-]+)"\s*:/.exec(line);
  if (km && dict) (dicts[dict] ??= new Set()).add(km[1]);
}
const names = Object.keys(dicts).filter((k) => dicts[k].size > 50);
console.log("dictionaries:", names.map((n) => `${n}=${dicts[n].size}`).join(" "));
let problems = 0;
const base = dicts[names[0]];
for (const n of names.slice(1)) {
  const missing = [...base].filter((k) => !dicts[n].has(k));
  const extra = [...dicts[n]].filter((k) => !base.has(k));
  if (missing.length || extra.length) {
    problems += 1;
    console.log(
      `${n}: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`
    );
  }
}
console.log(problems === 0 ? "PARITY OK" : `PARITY FAILURES: ${problems}`);
process.exit(problems === 0 ? 0 : 1);
