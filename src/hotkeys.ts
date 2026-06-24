// Default keyboard shortcuts and their display formatting. Pure (only a
// type-only Obsidian import) so it is unit-tested and shared by both the command
// registration (main.ts) and the Settings → shortcuts section (settings.ts):
// one source of truth keeps the displayed bindings in step with what we register.
//
// macOS note: Alt+<letter> is not a reliable shortcut on macOS — Option+T types a
// dead-key glyph ("†") instead of "t", so the event.key never matches and the
// hotkey silently never fires. We therefore ship Cmd+Shift defaults on macOS and
// keep the Alt defaults elsewhere. Either way the user can rebind any of them in
// Obsidian's Hotkeys pane (surfaced from the plugin's shortcuts section).

import type { Modifier } from "obsidian";

export type HotkeyDef = { modifiers: Modifier[]; key: string };

/** The commands surfaced (and rebindable) in the plugin's shortcuts section. */
export const SHORTCUT_COMMAND_IDS = [
  "add-learning-annotation",
  "translate-selection",
  "pretranslate-document"
] as const;
export type ShortcutCommandId = (typeof SHORTCUT_COMMAND_IDS)[number];

/** The i18n key for each command's display name. */
export const SHORTCUT_NAME_KEYS: Record<ShortcutCommandId, string> = {
  "add-learning-annotation": "cmd.addAnnotation",
  "translate-selection": "cmd.translate",
  "pretranslate-document": "cmd.pretranslate"
};

const MAC_DEFAULTS: Record<ShortcutCommandId, HotkeyDef[]> = {
  "add-learning-annotation": [{ modifiers: ["Mod", "Shift"], key: "l" }],
  "translate-selection": [{ modifiers: ["Mod", "Shift"], key: "t" }],
  "pretranslate-document": [{ modifiers: ["Mod", "Shift"], key: "y" }]
};

const OTHER_DEFAULTS: Record<ShortcutCommandId, HotkeyDef[]> = {
  "add-learning-annotation": [{ modifiers: ["Mod", "Shift"], key: "l" }],
  "translate-selection": [{ modifiers: ["Alt"], key: "t" }],
  "pretranslate-document": [{ modifiers: ["Mod", "Alt"], key: "t" }]
};

export function isMacPlatform(platform: string = process.platform): boolean {
  return platform === "darwin";
}

/** The default hotkeys we register for a command, per platform. */
export function defaultHotkeys(
  id: ShortcutCommandId,
  platform: string = process.platform
): HotkeyDef[] {
  return (isMacPlatform(platform) ? MAC_DEFAULTS : OTHER_DEFAULTS)[id];
}

const MAC_SYMBOL: Record<string, string> = {
  Mod: "⌘",
  Meta: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧"
};
const OTHER_LABEL: Record<string, string> = {
  Mod: "Ctrl",
  Meta: "Win",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift"
};

/** Format one hotkey for display, e.g. "⌘⇧T" (macOS) or "Ctrl+Shift+T". */
export function formatHotkey(
  hotkey: HotkeyDef,
  platform: string = process.platform
): string {
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;
  if (isMacPlatform(platform)) {
    return `${hotkey.modifiers.map((m) => MAC_SYMBOL[m] ?? m).join("")}${key}`;
  }
  return [...hotkey.modifiers.map((m) => OTHER_LABEL[m] ?? m), key].join("+");
}

/** Format a list of hotkeys, or a dash when nothing is bound. */
export function formatHotkeys(
  hotkeys: HotkeyDef[] | undefined | null,
  platform: string = process.platform
): string {
  if (!hotkeys || hotkeys.length === 0) return "—";
  return hotkeys.map((h) => formatHotkey(h, platform)).join(", ");
}
