// Inline translation + background pre-translation (Alt+T), extracted from the
// plugin so main.ts stays focused. Owns the per-file glossary cache and the
// status-bar progress counter; the engine call (`captureText`) and shared
// services are injected so this stays a cohesive unit.

import { type App, type Editor, type EditorPosition, Notice, setIcon, TFile } from "obsidian";
import { getLocale, t } from "./i18n.js";
import type { AnnotationTutorLiteSettings } from "./settings-config.js";
import type { ReviewOutcome } from "./review-outcome.js";
import { lineTextWithoutBlockId } from "./editor.js";
import {
  applyGlossary,
  buildFileGlossary,
  buildGlossaryPrompt,
  contentHash,
  lookupGloss,
  mergeGlossaryEntry,
  parseGlossary,
  segmentDocument,
  MAX_PRETRANSLATE_BATCHES,
  type FileGlossary,
  type GlossaryEntry
} from "./pretranslate.js";
import {
  buildPassageGlossPrompt,
  buildWordGlossPrompt,
  classifyTranslateSelection,
  cleanGloss,
  formatWordGloss,
  nativeLanguageName,
  stripWrapper
} from "./translate.js";

export type TranslationDeps = {
  app: App;
  /** Status-bar element for the compact "done/total" pre-translation counter. */
  statusBar: HTMLElement;
  settings: () => AnnotationTutorLiteSettings;
  chatTimeoutMs: () => number;
  /** One one-shot generation through the configured review engine. */
  captureText: (prompt: string, timeoutMs: number) => Promise<ReviewOutcome>;
};

export class TranslationController {
  // Per-file glossaries, keyed by Vault path, so Alt+T can gloss instantly.
  private readonly glossaryCache = new Map<string, FileGlossary>();
  // File paths with a pre-translation pass in flight, to avoid duplicate runs.
  private readonly pretranslating = new Set<string>();

  public constructor(private readonly deps: TranslationDeps) {}

  /** A renamed/moved file keeps its cached glossary; a deleted one drops it. */
  public onFileDeleted(path: string): void {
    this.glossaryCache.delete(path);
  }

  public onFileRenamed(oldPath: string, newPath: string): void {
    const moved = this.glossaryCache.get(oldPath);
    this.glossaryCache.delete(oldPath);
    if (moved) this.glossaryCache.set(newPath, moved);
  }

  private dictionaryLanguageName(): string {
    return this.deps.settings().dictionaryLanguage.trim() || nativeLanguageName(getLocale());
  }

  /**
   * Try to gloss the selection from the active file's cached pre-translation.
   * Returns true when it answered (cache hit); false to fall back to a live call.
   */
  private translateFromCache(
    editor: Editor,
    from: EditorPosition,
    to: EditorPosition,
    selection: string,
    mode: ReturnType<typeof classifyTranslateSelection>
  ): boolean {
    const file = this.deps.app.workspace.getActiveFile();
    const glossary = file ? this.glossaryCache.get(file.path) : undefined;
    if (!glossary) return false;
    let replacement: string | null = null;
    if (mode === "word") {
      const gloss = lookupGloss(glossary, selection);
      if (gloss) {
        replacement = formatWordGloss(selection, gloss);
      } else {
        const glossed = applyGlossary(selection, glossary);
        if (glossed !== selection) replacement = glossed;
      }
    } else {
      const glossed = applyGlossary(selection, glossary);
      if (glossed !== selection) replacement = glossed;
    }
    if (!replacement || replacement === selection) return false;
    if (!this.replaceSelection(editor, from, to, selection, replacement)) {
      return false;
    }
    new Notice(t("notice.translateDone"));
    return true;
  }

  /**
   * Add a live word gloss to the active file's cached glossary so a repeat Alt+T
   * on the same term answers from cache. No-op when the file has no glossary yet.
   */
  private cacheWordGloss(surface: string, gloss: string): void {
    if (!surface || !gloss) return;
    const file = this.deps.app.workspace.getActiveFile();
    if (!file) return;
    const glossary = this.glossaryCache.get(file.path);
    if (!glossary) return;
    this.glossaryCache.set(file.path, mergeGlossaryEntry(glossary, { surface, gloss }));
  }

  /** File-open hook: pre-translate the document when the feature is enabled. */
  public async maybePretranslate(file: TFile): Promise<void> {
    if (!this.deps.settings().pretranslateOnOpen) return;
    // Don't auto-translate the plugin's own generated memory/library notes.
    const root = this.deps.settings().memoryRoot;
    if (root && (file.path === root || file.path.startsWith(`${root}/`))) return;
    await this.pretranslateFile(file, false);
  }

  /** Manual command: (re)build the pre-translation glossary for the active note. */
  public async pretranslateActiveFile(): Promise<void> {
    const file = this.deps.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice(t("notice.openMdFirst"));
      return;
    }
    await this.pretranslateFile(file, true);
  }

  /**
   * Gloss a document in the background into a cached word→meaning glossary so
   * Alt+T can answer instantly. Skips work when the cache already matches the
   * file's content, and aborts quietly when the engine needs a key (unless the
   * user invoked it manually). The live Alt+T path covers anything this misses.
   */
  private async pretranslateFile(file: TFile, manual: boolean): Promise<void> {
    if (this.pretranslating.has(file.path)) {
      if (manual) new Notice(t("notice.pretranslateBusy"));
      return;
    }
    const content = await this.deps.app.vault.cachedRead(file);
    const hash = contentHash(content);
    const existing = this.glossaryCache.get(file.path);
    if (existing && existing.hash === hash && existing.complete) {
      if (manual) {
        new Notice(t("notice.pretranslateUpToDate", { count: existing.entries.length }));
      }
      return;
    }
    const batches = segmentDocument(
      content,
      this.deps.settings().pretranslateChunkChars
    ).slice(0, MAX_PRETRANSLATE_BATCHES);
    if (batches.length === 0) {
      this.glossaryCache.set(file.path, buildFileGlossary(hash, []));
      if (manual) new Notice(t("notice.pretranslateEmpty"));
      return;
    }
    this.pretranslating.add(file.path);
    const target = this.dictionaryLanguageName();
    this.setPretranslateStatus(0, batches.length);
    const entries: GlossaryEntry[] = [];
    let done = 0;
    let failed = 0;
    let needsKey = false;
    try {
      for (const batch of batches) {
        let outcome: ReviewOutcome;
        try {
          outcome = await this.deps.captureText(
            buildGlossaryPrompt(batch, target),
            this.deps.chatTimeoutMs()
          );
        } catch (error) {
          console.error("[Annotation Tutor Lite] pre-translate batch error", error);
          outcome = {
            kind: "failed",
            detail: error instanceof Error ? error.message : String(error)
          };
        }
        if (outcome.kind === "needs-key") {
          needsKey = true;
          break;
        }
        if (outcome.kind === "ok") {
          entries.push(...parseGlossary(outcome.reviewText));
        } else {
          failed += 1;
        }
        done += 1;
        // Publish progress so far so Alt+T can already use the terms found.
        this.glossaryCache.set(file.path, buildFileGlossary(hash, entries, false));
        this.setPretranslateStatus(done, batches.length);
      }
    } finally {
      this.pretranslating.delete(file.path);
      if (this.pretranslating.size === 0) this.clearPretranslateStatus();
    }
    if (needsKey) {
      this.glossaryCache.set(file.path, buildFileGlossary(hash, entries));
      if (manual) new Notice(t("notice.apiKeyMissing"));
      return;
    }
    const glossary = buildFileGlossary(hash, entries);
    this.glossaryCache.set(file.path, glossary);
    const count = glossary.entries.length;
    // Auto runs stay silent — the status-bar counter was the only hint needed.
    if (!manual) return;
    if (count > 0) {
      new Notice(
        failed > 0
          ? t("notice.pretranslatePartial", { count, failed })
          : t("notice.pretranslateDone", { count })
      );
    } else if (failed > 0) {
      new Notice(t("notice.pretranslateFailed"));
    } else {
      new Notice(t("notice.pretranslateEmpty"));
    }
  }

  /** Show a compact "done/total" pre-translation counter in the status bar. */
  private setPretranslateStatus(done: number, total: number): void {
    const el = this.deps.statusBar;
    el.empty();
    if (total <= 0) return;
    setIcon(el.createSpan({ cls: "atl-pretranslate-status-icon" }), "languages");
    el.createSpan({ text: ` ${done}/${total}` });
    el.setAttribute("aria-label", t("status.pretranslate"));
  }

  private clearPretranslateStatus(): void {
    this.deps.statusBar.empty();
  }

  /**
   * Alt+T: gloss the selection inline for immersive reading. A single word/term
   * becomes "word (meaning)"; a passage gets every foreign word glossed in place.
   */
  public async translateSelection(editor: Editor): Promise<void> {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice(t("notice.translateSelect"));
      return;
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const target = this.dictionaryLanguageName();
    const mode = classifyTranslateSelection(selection);

    // Fast path: answer from the pre-translation cache when it covers the
    // selection. Otherwise fall through to a live model call.
    if (this.translateFromCache(editor, from, to, selection, mode)) return;

    const progress = new Notice(t("notice.translating"), 0);
    try {
      const prompt =
        mode === "word"
          ? buildWordGlossPrompt(
              selection.trim(),
              lineTextWithoutBlockId(editor.getLine(from.line)),
              target
            )
          : buildPassageGlossPrompt(selection, target);
      const outcome = await this.deps.captureText(prompt, this.deps.chatTimeoutMs());
      if (outcome.kind !== "ok") {
        this.noticeForTranslate(outcome);
        return;
      }
      const wordGloss = mode === "word" ? cleanGloss(outcome.reviewText) : "";
      const replacement =
        mode === "word"
          ? formatWordGloss(selection, wordGloss)
          : stripWrapper(outcome.reviewText);
      if (!replacement.trim() || replacement === selection) {
        new Notice(t("notice.translateFailed", { detail: t("notice.translateEmpty") }));
        return;
      }
      if (!this.replaceSelection(editor, from, to, selection, replacement)) {
        new Notice(t("notice.translateFailed", { detail: t("chat.edit.notLocated") }));
        return;
      }
      // Self-healing cache: a missed word is glossed live once, then remembered.
      if (mode === "word" && wordGloss) {
        this.cacheWordGloss(selection.trim(), wordGloss);
      }
      new Notice(t("notice.translateDone"));
    } catch (error) {
      new Notice(
        t("notice.translateFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      progress.hide();
    }
  }

  /** Replace `original` at the captured range, re-locating it by text if it shifted. */
  private replaceSelection(
    editor: Editor,
    from: EditorPosition,
    to: EditorPosition,
    original: string,
    replacement: string
  ): boolean {
    if (editor.getRange(from, to) === original) {
      editor.replaceRange(replacement, from, to);
      return true;
    }
    const idx = editor.getValue().indexOf(original);
    if (idx === -1) return false;
    editor.replaceRange(
      replacement,
      editor.offsetToPos(idx),
      editor.offsetToPos(idx + original.length)
    );
    return true;
  }

  private noticeForTranslate(outcome: ReviewOutcome): void {
    switch (outcome.kind) {
      case "needs-key":
        new Notice(t("notice.apiKeyMissing"));
        return;
      case "timeout":
        new Notice(t("notice.translateFailed", { detail: t("notice.translateTimeout") }));
        return;
      case "failed":
        new Notice(t("notice.translateFailed", { detail: outcome.detail }));
        return;
      case "empty":
        new Notice(t("notice.translateFailed", { detail: t("notice.translateEmpty") }));
        return;
    }
  }
}
