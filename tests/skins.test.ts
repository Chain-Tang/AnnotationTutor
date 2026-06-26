import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  humanizeSkinId,
  mergeSkins,
  normalizeSkinId,
  parseSkinName,
  resolveRailSkin,
  sanitizeSkinId,
  skinClass,
  type SkinDef
} from "../src/skins.js";

describe("BUILTIN_SKINS", () => {
  it("has the four expected ids; only flat is non-quiet", () => {
    expect(BUILTIN_SKINS.map((s) => s.id)).toEqual([
      "flat",
      "paper",
      "sticky",
      "leaf"
    ]);
    expect(BUILTIN_SKINS.find((s) => s.id === "flat")?.quiet).toBe(false);
    for (const id of ["paper", "sticky", "leaf"]) {
      expect(BUILTIN_SKINS.find((s) => s.id === id)?.quiet).toBe(true);
    }
    expect(BUILTIN_SKINS.every((s) => s.builtin)).toBe(true);
  });
});

describe("sanitizeSkinId", () => {
  it("lowercases, strips .css, and keeps only [a-z0-9-]", () => {
    expect(sanitizeSkinId("My Skin.css")).toBe("my-skin");
    expect(sanitizeSkinId("autumn_leaf 2")).toBe("autumn-leaf-2");
    expect(sanitizeSkinId("  Café Brûlé  ")).toBe("caf-br-l");
  });

  it("collapses and trims dashes; junk-only input becomes empty", () => {
    expect(sanitizeSkinId("--a--b--")).toBe("a-b");
    expect(sanitizeSkinId("***")).toBe("");
  });
});

describe("skinClass", () => {
  it("prefixes and sanitizes; never emits a class that can break out", () => {
    expect(skinClass("sticky")).toBe("atl-skin-sticky");
    expect(skinClass("My Skin")).toBe("atl-skin-my-skin");
    expect(skinClass("} body {")).toBe("atl-skin-body");
    expect(skinClass("***")).toBe(`atl-skin-${DEFAULT_SKIN_ID}`);
  });
});

describe("humanizeSkinId", () => {
  it("turns an id into a readable label", () => {
    expect(humanizeSkinId("my-skin")).toBe("My skin");
    expect(humanizeSkinId("autumn-leaf-2")).toBe("Autumn leaf 2");
  });
});

describe("parseSkinName", () => {
  it("reads a leading @name banner, else uses the fallback", () => {
    expect(parseSkinName("/* @name Sunset */\n.x{}", "fallback")).toBe("Sunset");
    expect(parseSkinName(".x{}", "fallback")).toBe("fallback");
    expect(parseSkinName("/* @name    */\n.x{}", "fallback")).toBe("fallback");
  });
});

describe("mergeSkins", () => {
  it("appends custom skins, de-duping by id with built-ins winning", () => {
    const custom: SkinDef[] = [
      { id: "leaf", name: "Hijacked", builtin: false, quiet: true, css: ".x{}" },
      { id: "sunset", name: "Sunset", builtin: false, quiet: true, css: ".y{}" }
    ];
    const merged = mergeSkins(BUILTIN_SKINS, custom);
    expect(merged.map((s) => s.id)).toEqual([
      "flat",
      "paper",
      "sticky",
      "leaf",
      "sunset"
    ]);
    // The built-in leaf is kept, not the custom one that reused its id.
    expect(merged.find((s) => s.id === "leaf")?.builtin).toBe(true);
  });
});

describe("resolveRailSkin", () => {
  const all = mergeSkins(BUILTIN_SKINS, [
    { id: "sunset", name: "Sunset", builtin: false, quiet: true, css: ".y{}" }
  ]);

  it("resolves a known id to its id + quiet flag", () => {
    expect(resolveRailSkin("sticky", all)).toEqual({ id: "sticky", quiet: true });
    expect(resolveRailSkin("flat", all)).toEqual({ id: "flat", quiet: false });
    expect(resolveRailSkin("sunset", all)).toEqual({ id: "sunset", quiet: true });
  });

  it("falls back to flat for an unknown id", () => {
    expect(resolveRailSkin("ghost", all)).toEqual({ id: "flat", quiet: false });
  });
});

describe("normalizeSkinId", () => {
  it("keeps a non-empty string, else returns the default", () => {
    expect(normalizeSkinId("leaf")).toBe("leaf");
    expect(normalizeSkinId("")).toBe(DEFAULT_SKIN_ID);
    expect(normalizeSkinId("   ")).toBe(DEFAULT_SKIN_ID);
    expect(normalizeSkinId(42)).toBe(DEFAULT_SKIN_ID);
    expect(normalizeSkinId(undefined)).toBe(DEFAULT_SKIN_ID);
  });
});
