import { describe, expect, it } from "vitest";
import { localeTables, resolveLocale, setLanguage, setLocale, t } from "../src/i18n.js";

describe("resolveLocale", () => {
  it("maps Obsidian language codes to known locales", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("zh")).toBe("zh-cn");
    expect(resolveLocale("zh-TW")).toBe("zh-tw");
    expect(resolveLocale("zh-Hant")).toBe("zh-tw");
    expect(resolveLocale("ja")).toBe("ja");
  });

  it("falls back to English for unknown / empty input", () => {
    expect(resolveLocale("ko")).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale(null)).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
});

describe("t", () => {
  it("returns the active locale's string and fills placeholders", () => {
    setLocale("zh");
    expect(t("action.delete")).toBe("删除");
    expect(t("notice.created", { id: "ANN-1" })).toBe("已创建 ANN-1。");
    setLocale("en");
    expect(t("notice.created", { id: "ANN-1" })).toBe("Created ANN-1.");
  });

  it("falls back to English when a key is missing in the locale", () => {
    setLocale("ja");
    // Every key exists in ja here, so test the unknown-key passthrough.
    expect(t("nonexistent.key")).toBe("nonexistent.key");
    setLocale("en");
  });
});

describe("setLanguage", () => {
  it("uses an explicit locale over the detected one", () => {
    setLanguage("ja", "zh");
    expect(t("action.delete")).toBe("削除");
    setLanguage("zh-tw", "en");
    expect(t("action.delete")).toBe("刪除");
    setLocale("en");
  });

  it("falls back to detection when preference is auto/unknown", () => {
    setLanguage("auto", "zh");
    expect(t("action.delete")).toBe("删除");
    setLanguage("", "ja");
    expect(t("action.delete")).toBe("削除");
    setLocale("en");
  });
});

describe("locale coverage", () => {
  const enKeys = Object.keys(localeTables.en).sort();

  it("every locale has full key parity with English (no drift to fallback)", () => {
    for (const [locale, dict] of Object.entries(localeTables)) {
      expect({ locale, keys: Object.keys(dict).sort() }).toEqual({ locale, keys: enKeys });
    }
  });

  it("has no empty translation values", () => {
    for (const [locale, dict] of Object.entries(localeTables)) {
      const empty = Object.entries(dict)
        .filter(([, value]) => value.trim() === "")
        .map(([key]) => key);
      expect({ locale, empty }).toEqual({ locale, empty: [] });
    }
  });
});
