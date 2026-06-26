// Card skin registry: the visual themes a margin annotation card can wear, plus
// the string handling for user-added skins. Pure (no `obsidian` import) so it is
// unit-testable per the project convention; the Obsidian-bound file loading and
// <style> injection live in skin-loader.ts.

/**
 * A GPU 3D tilt (via vanilla-tilt): the card rotates toward the pointer with an
 * optional moving glare, so a textured skin catches light like a physical object.
 */
export type TiltSpec = { max: number; glare: boolean; maxGlare: number };

/**
 * One selectable card look. `quiet` skins use the chrome-less, scrollbar-hidden
 * base (the behaviour the old "paper" toggle gave the card); `css` is present
 * only for user skins loaded from a `.css` file in the plugin's skins folder;
 * `tilt` opts the skin into the 3D tilt effect.
 */
export type SkinDef = {
  id: string;
  name: string;
  builtin: boolean;
  quiet: boolean;
  css?: string;
  tilt?: TiltSpec;
};

/** The minimal skin shape threaded down to the rails and the card builder. */
export type RailSkin = { id: string; quiet: boolean; tilt: TiltSpec | null };

/** The classic bordered card; also the fallback when an id can't be resolved. */
export const DEFAULT_SKIN_ID = "flat";

/**
 * Built-in skins, in display order. `flat` is the classic bordered card; the
 * rest are "quiet" (chrome-less, like the old paper mode). Their CSS lives in
 * styles.css under `.atl-skin-<id>`; the `name` here is an English fallback (the
 * settings UI localises built-ins by id via `t("skin.<id>")`).
 */
export const BUILTIN_SKINS: readonly SkinDef[] = [
  { id: "flat", name: "Flat", builtin: true, quiet: false },
  { id: "paper", name: "Paper", builtin: true, quiet: true },
  {
    id: "sticky",
    name: "Sticky note",
    builtin: true,
    quiet: true,
    tilt: { max: 6, glare: true, maxGlare: 0.28 }
  },
  {
    id: "leaf",
    name: "Leaf",
    builtin: true,
    quiet: true,
    tilt: { max: 6, glare: false, maxGlare: 0 }
  }
];

/**
 * Lowercase, drop a trailing `.css`, keep `[a-z0-9-]`, collapse and trim dashes.
 * Used for both the CSS class and custom-skin ids so a filename can never inject
 * CSS through the class name.
 */
export function sanitizeSkinId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.css$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The body class for a skin id (always sanitized). */
export function skinClass(id: string): string {
  return `atl-skin-${sanitizeSkinId(id) || DEFAULT_SKIN_ID}`;
}

/** "my-skin" -> "My skin": a readable fallback label for a custom skin. */
export function humanizeSkinId(id: string): string {
  const spaced = id.replace(/-+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : id;
}

/**
 * Read an optional leading `/* @name Foo *​/` banner from a skin's CSS for its
 * display label; fall back to the supplied name when absent.
 */
export function parseSkinName(css: string, fallback: string): string {
  const match = css.match(/\/\*\s*@name\s+(.+?)\s*\*\//);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : fallback;
}

/** Combine built-ins with user skins, de-duping by id (built-ins win). */
export function mergeSkins(
  builtin: readonly SkinDef[],
  custom: readonly SkinDef[]
): SkinDef[] {
  const seen = new Set(builtin.map((skin) => skin.id));
  return [...builtin, ...custom.filter((skin) => !seen.has(skin.id))];
}

/** Resolve an id to the RailSkin to render, falling back to flat when unknown. */
export function resolveRailSkin(id: string, all: readonly SkinDef[]): RailSkin {
  const found = all.find((skin) => skin.id === id);
  if (found) return { id: found.id, quiet: found.quiet, tilt: found.tilt ?? null };
  return { id: DEFAULT_SKIN_ID, quiet: false, tilt: null };
}

/**
 * A non-empty string id, or the default. Registry-aware validation (is this id
 * actually installed?) happens at the call site, since this module has no
 * filesystem access.
 */
export function normalizeSkinId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : DEFAULT_SKIN_ID;
}
