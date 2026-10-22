// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLanguage, setLocale } from "../src/i18n.js";

const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8").replace(/\r\n?/g, "\n");
const start = source.indexOf("  public applyLocale(): void"), end = source.indexOf("\n  public async changeMemoryRoot(", start);
if (start < 0 || end < 0) throw new Error("Locale host fixture boundaries changed");
const code = transformSync(`class Host { ${source.slice(start, end)} }; module.exports = Host;`, { loader: "ts", format: "cjs" }).code;
function fixture(ready = true) {
  const module = { exports: {} };
  new Function("module", "getLocale", "setLanguage", code)(module, getLocale, setLanguage);
  const Host = module.exports as new () => { applyLocale(): void };
  const host = new Host(), settings = { language: "zh-cn" }, refreshDashboard = vi.fn();
  Object.assign(host, { settings, refreshDashboard, tutorConversation: ready ? {} : undefined, pluginUnloaded: false });
  return { host, settings, refreshDashboard };
}
afterEach(() => { setLocale("en"); localStorage.clear(); });

describe("language changes refresh existing library views", () => {
  it("refreshes an open dashboard once for a new locale and skips unchanged locales", () => {
    setLocale("en"); const f = fixture();
    f.host.applyLocale(); expect(getLocale()).toBe("zh-cn"); expect(f.refreshDashboard).toHaveBeenCalledOnce();
    f.host.applyLocale(); expect(f.refreshDashboard).toHaveBeenCalledOnce();
  });
  it("keeps startup and unloaded views outside locale publication", () => {
    setLocale("en"); const f = fixture(false); f.host.applyLocale(); expect(f.refreshDashboard).not.toHaveBeenCalled();
    setLocale("en"); Object.assign(f.host, { tutorConversation: {}, pluginUnloaded: true });
    f.host.applyLocale(); expect(f.refreshDashboard).not.toHaveBeenCalled();
  });
});
