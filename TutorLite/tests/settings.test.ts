import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  normalizeMemoryRoot
} from "../src/settings-config.js";

describe("migrateSettings", () => {
  it("returns defaults for empty / non-object input", () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates the old highlightAnnotations boolean to highlightStyle", () => {
    expect(migrateSettings({ highlightAnnotations: false }).highlightStyle).toBe(
      "none"
    );
    expect(migrateSettings({ highlightAnnotations: true }).highlightStyle).toBe(
      "dotted-underline"
    );
  });

  it("drops the legacy key so it is not re-persisted", () => {
    const migrated = migrateSettings({ highlightAnnotations: true });
    expect("highlightAnnotations" in migrated).toBe(false);
  });

  it("keeps an explicit highlightStyle over the legacy boolean", () => {
    const migrated = migrateSettings({
      highlightAnnotations: false,
      highlightStyle: "background"
    });
    expect(migrated.highlightStyle).toBe("background");
  });

  it("falls back to the default for an unknown style value", () => {
    expect(migrateSettings({ highlightStyle: "rainbow" }).highlightStyle).toBe(
      DEFAULT_SETTINGS.highlightStyle
    );
  });

  it("passes through known fields and fills missing ones", () => {
    const migrated = migrateSettings({ memoryRoot: "Notes", showMarker: false });
    expect(migrated.memoryRoot).toBe("Notes");
    expect(migrated.showMarker).toBe(false);
    expect(migrated.watchMemoryFiles).toBe(DEFAULT_SETTINGS.watchMemoryFiles);
    expect(migrated.memoryWriteMode).toBe("direct");
    expect(migrated.allowPreferenceWrites).toBe(false);
  });

  it("normalizes unknown memory write modes", () => {
    expect(migrateSettings({ memoryWriteMode: "anything" }).memoryWriteMode).toBe(
      "direct"
    );
    expect(
      migrateSettings({ memoryWriteMode: "confirmation" }).memoryWriteMode
    ).toBe("confirmation");
  });

  it("preserves persisted card geometry and isolates it from the defaults", () => {
    const geom = { "ANN-1": { dx: 5, dy: 10, w: 280, h: 200 } };
    const migrated = migrateSettings({ cardGeom: geom });
    expect(migrated.cardGeom).toEqual(geom);
    // A fresh object, not an alias of DEFAULT_SETTINGS.cardGeom or the input.
    expect(migrated.cardGeom).not.toBe(geom);
    migrated.cardGeom["ANN-2"] = { dx: 0, dy: 0 };
    expect(DEFAULT_SETTINGS.cardGeom).toEqual({});
  });

  it("coerces a non-string dictionary language to empty, keeping a valid one", () => {
    expect(migrateSettings({ dictionaryLanguage: 42 }).dictionaryLanguage).toBe("");
    expect(
      migrateSettings({ dictionaryLanguage: "Chinese" }).dictionaryLanguage
    ).toBe("Chinese");
  });

  it("coerces a non-boolean pretranslateOnOpen to the default, keeping a valid one", () => {
    expect(migrateSettings({ pretranslateOnOpen: "yes" }).pretranslateOnOpen).toBe(
      DEFAULT_SETTINGS.pretranslateOnOpen
    );
    expect(migrateSettings({ pretranslateOnOpen: false }).pretranslateOnOpen).toBe(
      false
    );
  });

  it("validates pretranslateChunkChars: default for invalid/too-small, floors a valid one", () => {
    const def = DEFAULT_SETTINGS.pretranslateChunkChars;
    expect(migrateSettings({ pretranslateChunkChars: "big" }).pretranslateChunkChars).toBe(def);
    expect(migrateSettings({ pretranslateChunkChars: 10 }).pretranslateChunkChars).toBe(def);
    expect(migrateSettings({ pretranslateChunkChars: 12000 }).pretranslateChunkChars).toBe(12000);
    expect(migrateSettings({ pretranslateChunkChars: 5000.7 }).pretranslateChunkChars).toBe(5000);
  });

  it("defaults card geometry to an empty object for bad input", () => {
    expect(migrateSettings({ cardGeom: "nope" }).cardGeom).toEqual({});
    expect(migrateSettings({ cardGeom: [1, 2] }).cardGeom).toEqual({});
    expect(migrateSettings({}).cardGeom).toEqual({});
  });

  it("keeps the memory root inside a visible Vault folder", () => {
    expect(normalizeMemoryRoot("Learning/Agent Memory")).toBe(
      "Learning/Agent Memory"
    );
    expect(normalizeMemoryRoot("../outside")).toBe("Agent Memory");
    expect(normalizeMemoryRoot("C:\\Private")).toBe("Agent Memory");
    expect(normalizeMemoryRoot(".obsidian/private")).toBe("Agent Memory");
    expect(migrateSettings({ memoryRoot: "../outside" }).memoryRoot).toBe(
      "Agent Memory"
    );
  });
});
