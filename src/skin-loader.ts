// Loads user-authored card skins from the plugin's `skins/` folder and injects
// the active one's CSS, mirroring Obsidian's CSS-snippets model. This is the
// Obsidian-bound half of the skin system; the pure registry lives in skins.ts.

import { type App, FileSystemAdapter, normalizePath } from "obsidian";
import {
  humanizeSkinId,
  parseSkinName,
  sanitizeSkinId,
  type SkinDef
} from "./skins.js";

const STYLE_EL_ID = "atl-skin-custom";

/**
 * Starter skin written by "New skin from template": scoped to its own class and
 * commented so a user can edit it and reload. The `my-skin` token is rewritten
 * to the actual id when the file name has to be deduped.
 */
const TEMPLATE_CSS = `/* @name My skin */
/* A custom Annotation Tutor Lite card skin. Edit freely, then run
   Settings -> Card skin -> Reload skins. Keep every rule scoped to
   .atl-skin-my-skin so it only styles cards wearing this skin. The file name
   (my-skin.css) is the skin id; rename the file and the @name above to taste. */

.atl-skin-my-skin {
  background: linear-gradient(160deg, #fffdf5, #fff7df);
  color: #3a3320;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
  padding: 10px 12px;
}
`;

/** Manages the plugin's `skins/` folder and the injected custom-skin <style>. */
export class SkinLoader {
  private styleEl: HTMLStyleElement | null = null;

  public constructor(
    private readonly app: App,
    private readonly pluginDir: string
  ) {}

  private get dir(): string {
    return normalizePath(`${this.pluginDir}/skins`);
  }

  /** Scan the skins folder; each `.css` file becomes a user SkinDef. */
  public async loadCustomSkins(): Promise<SkinDef[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.dir))) return [];
    let files: string[];
    try {
      files = (await adapter.list(this.dir)).files;
    } catch {
      return [];
    }
    const skins: SkinDef[] = [];
    const seen = new Set<string>();
    for (const path of files) {
      if (!path.toLowerCase().endsWith(".css")) continue;
      const base = path.slice(path.lastIndexOf("/") + 1);
      const id = sanitizeSkinId(base);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let css: string;
      try {
        css = await adapter.read(path);
      } catch {
        continue;
      }
      skins.push({
        id,
        name: parseSkinName(css, humanizeSkinId(id)),
        builtin: false,
        quiet: true,
        css
      });
    }
    skins.sort((a, b) => a.name.localeCompare(b.name));
    return skins;
  }

  /** Inject the active skin's CSS. Built-ins carry none, so this clears it. */
  public applyCss(skin: SkinDef | undefined): void {
    const css = skin && !skin.builtin ? skin.css ?? "" : "";
    if (!css) {
      this.styleEl?.remove();
      this.styleEl = null;
      return;
    }
    if (!this.styleEl) {
      this.styleEl = document.createElement("style");
      this.styleEl.id = STYLE_EL_ID;
      document.head.appendChild(this.styleEl);
    }
    this.styleEl.textContent = css;
  }

  /** Create `skins/<id>.css` from the template and return its id. */
  public async createFromTemplate(): Promise<string> {
    const adapter = this.app.vault.adapter;
    await this.ensureDir();
    let id = "my-skin";
    let n = 2;
    while (await adapter.exists(this.filePath(id))) {
      id = `my-skin-${n}`;
      n += 1;
    }
    const css = TEMPLATE_CSS.replace(/my-skin/g, id).replace(
      "@name My skin",
      `@name ${humanizeSkinId(id)}`
    );
    await adapter.write(this.filePath(id), css);
    return id;
  }

  /** Open the skins folder in the OS file manager (desktop only). */
  public async openFolder(): Promise<void> {
    await this.ensureDir();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const full = adapter.getFullPath(this.dir);
    const electron = require("electron") as {
      shell?: { openPath?: (p: string) => Promise<string> };
    };
    await electron.shell?.openPath?.(full);
  }

  public unload(): void {
    this.styleEl?.remove();
    this.styleEl = null;
  }

  private filePath(id: string): string {
    return normalizePath(`${this.dir}/${id}.css`);
  }

  private async ensureDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
  }
}
