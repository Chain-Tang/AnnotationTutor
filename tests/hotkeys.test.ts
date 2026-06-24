import { describe, expect, it } from "vitest";
import {
  SHORTCUT_COMMAND_IDS,
  SHORTCUT_NAME_KEYS,
  defaultHotkeys,
  formatHotkey,
  formatHotkeys,
  isMacPlatform
} from "../src/hotkeys.js";

describe("isMacPlatform", () => {
  it("is true only for darwin", () => {
    expect(isMacPlatform("darwin")).toBe(true);
    expect(isMacPlatform("win32")).toBe(false);
    expect(isMacPlatform("linux")).toBe(false);
  });
});

describe("defaultHotkeys", () => {
  it("uses Cmd+Shift (not Alt) for translation on macOS", () => {
    expect(defaultHotkeys("translate-selection", "darwin")).toEqual([
      { modifiers: ["Mod", "Shift"], key: "t" }
    ]);
    expect(defaultHotkeys("pretranslate-document", "darwin")).toEqual([
      { modifiers: ["Mod", "Shift"], key: "y" }
    ]);
  });

  it("keeps the Alt-based defaults on other platforms", () => {
    expect(defaultHotkeys("translate-selection", "win32")).toEqual([
      { modifiers: ["Alt"], key: "t" }
    ]);
    expect(defaultHotkeys("pretranslate-document", "linux")).toEqual([
      { modifiers: ["Mod", "Alt"], key: "t" }
    ]);
  });

  it("uses Mod+Shift+L for annotation on every platform", () => {
    const expected = [{ modifiers: ["Mod", "Shift"], key: "l" }];
    expect(defaultHotkeys("add-learning-annotation", "darwin")).toEqual(expected);
    expect(defaultHotkeys("add-learning-annotation", "win32")).toEqual(expected);
  });

  it("defines a default and a name key for every surfaced command", () => {
    for (const id of SHORTCUT_COMMAND_IDS) {
      expect(defaultHotkeys(id, "darwin").length).toBeGreaterThan(0);
      expect(defaultHotkeys(id, "win32").length).toBeGreaterThan(0);
      expect(SHORTCUT_NAME_KEYS[id]).toBeTruthy();
    }
  });
});

describe("formatHotkey", () => {
  it("renders mac symbols with no separators and an uppercase key", () => {
    expect(formatHotkey({ modifiers: ["Mod", "Shift"], key: "t" }, "darwin")).toBe("⌘⇧T");
    expect(formatHotkey({ modifiers: ["Alt"], key: "t" }, "darwin")).toBe("⌥T");
  });

  it("renders Ctrl/Alt words joined with '+' on other platforms", () => {
    expect(formatHotkey({ modifiers: ["Mod", "Shift"], key: "t" }, "win32")).toBe(
      "Ctrl+Shift+T"
    );
    expect(formatHotkey({ modifiers: ["Alt"], key: "t" }, "linux")).toBe("Alt+T");
  });
});

describe("formatHotkeys", () => {
  it("joins multiple bindings and shows a dash when none are bound", () => {
    expect(
      formatHotkeys(
        [
          { modifiers: ["Mod"], key: "t" },
          { modifiers: ["Alt"], key: "t" }
        ],
        "win32"
      )
    ).toBe("Ctrl+T, Alt+T");
    expect(formatHotkeys([], "win32")).toBe("—");
    expect(formatHotkeys(undefined, "darwin")).toBe("—");
  });
});
