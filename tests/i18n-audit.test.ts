import { describe, expect, it } from "vitest";
import { localeTables } from "../src/i18n.js";
const { auditI18n, auditTranslationCalls, validateLocaleTables } = await import(new URL("../scripts/i18n-check.mjs", import.meta.url).href);

describe("runtime dictionary and call-site audit", () => {
  it("checks the complete real source tree and merged runtime tables", async () => {
    const result = await auditI18n();
    expect(result.errors).toEqual([]);
    expect(result.locales).toBe(4);
    expect(result.keys).toBe(Object.keys(localeTables.en).length);
    expect(result.literalCalls).toBeGreaterThan(1000);
  });
  it("rejects missing merged keys and placeholder drift", () => {
    const tables = { en: { "board.preview": "Preview {name}" }, ja: { "board.preview": "プレビュー {other}" } };
    expect(validateLocaleTables(tables)).toContain("ja: placeholder mismatch in board.preview");
    expect(validateLocaleTables({ ...tables, ja: {} })).toContain("ja: locale keys differ from English");
  });
  it("checks aliased and namespace imports without inspecting comments or dynamic keys", () => {
    const result = auditTranslationCalls('import {t as translate} from "./i18n.js"; import * as lang from "./i18n.js";\ntranslate("board.preview"); lang.t("missing"); translate(`board.${key}`); // translate("comment")', "synthetic.ts", new Set(["board.preview"]));
    expect(result.errors).toEqual(["synthetic.ts:2: missing translation missing"]);
    expect(result.literalCalls).toBe(2);
    expect(result.dynamicCalls).toBe(1);
    expect(auditTranslationCalls('const t = x => x; t("unrelated");', "unrelated.ts", new Set()).errors).toEqual([]);
  });
});
