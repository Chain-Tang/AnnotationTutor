import { captureTextTarget, resolveTextTarget, uniqueTextTarget, type TextTarget } from "./text-target.js";
// Inline translation + background pre-translation (Alt+T), extracted from the
// plugin so main.ts stays focused. Owns the per-file glossary cache and the
// status-bar progress counter; the engine call (`captureText`) and shared
// services are injected so this stays a cohesive unit.

import { type App, type Editor, Modal, Notice, setIcon, TFile } from "obsidian";
import { getLocale, t } from "./i18n.js";
import type { AnnotationTutorLiteSettings } from "./settings-config.js";
import type { ReviewOutcome } from "./review-outcome.js";
import { lineTextWithoutBlockId } from "./editor.js";
import { TranslationRequestQueue } from "./translation-request-queue.js";
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
  stripWrapper,
  type TranslateMode
} from "./translate.js";

/** Outcome of resolving a selection's gloss through a live model call. */
type LiveGloss =
  | { kind: "ok"; replacement: string; word?: GlossaryEntry }
  | { kind: "noop" }
  | { kind: "fail"; outcome: ReviewOutcome };

export type TranslationDeps = {
  activity?:()=>void;
  app: App;
  /** Status-bar element for the compact "done/total" pre-translation counter. */
  statusBar: HTMLElement;
  settings: () => AnnotationTutorLiteSettings;
  chatTimeoutMs: () => number;
  /** One one-shot generation through the configured review engine. */
  captureText: (prompt: string, timeoutMs: number, signal?: AbortSignal) => Promise<ReviewOutcome>;
  /** Independent API requests may overlap; shared ACP sessions must stay serial. */
  pretranslateConcurrency?: () => number;
};
type TranslationRun = {
  file: TFile | null; path: string | undefined; language: string;
  configuration: string; controller: AbortController;
};

export class TranslationController {
  // Per-file glossaries, keyed by Vault path, so Alt+T can gloss instantly.
  private readonly glossaryCache = new Map<string, FileGlossary>();
  // File paths with a pre-translation pass in flight, to avoid duplicate runs.
  private readonly pretranslating = new Set<string>();
  private readonly pretranslateRuns = new Map<string, TranslationRun>();
  private readonly glossaryLanguages = new Map<string, string>();
  private readonly runs = new Set<TranslationRun>();
  private readonly requests: TranslationRequestQueue;
  private configuration: string;
  private disposed = false;

  public constructor(private readonly deps: TranslationDeps) {
    this.configuration = this.configurationKey();
    this.requests = new TranslationRequestQueue(() => this.concurrency());
  }

  private concurrency(): number {
    const engine = this.deps.settings().reviewEngine;
    return engine === "opencode" ? 1 : this.deps.pretranslateConcurrency?.() ?? (engine === "api" ? 2 : 1);
  }

  /** Only compared in memory; never logged, serialized or used as a cache key. */
  private configurationKey(): string {
    const settings = this.deps.settings();
    return JSON.stringify([this.dictionaryLanguageName(), settings.reviewEngine,
      settings.apiBaseUrl, settings.apiModel, settings.apiKey, settings.agentCommand,
      settings.agentModel, settings.agentShellPath, settings.agentFallbackModel]);
  }

  public onSettingsChanged(): void {
    const configuration = this.configurationKey();
    if (configuration === this.configuration) return;
    this.configuration = configuration;
    for (const run of this.runs) run.controller.abort();
    this.pretranslateRuns.clear(); this.pretranslating.clear();
    this.glossaryCache.clear(); this.glossaryLanguages.clear();
    if (!this.disposed) this.clearPretranslateStatus();
  }

  public onFileChanged(path: string): void { this.onFileDeleted(path); }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const run of this.runs) run.controller.abort();
    this.requests.dispose(); this.runs.clear();
    this.pretranslateRuns.clear(); this.pretranslating.clear();
    this.glossaryCache.clear(); this.glossaryLanguages.clear();
    this.clearPretranslateStatus();
  }

  private beginRun(file: TFile | null): TranslationRun {
    this.onSettingsChanged();
    const run = { file, path: file?.path, language: this.dictionaryLanguageName(),
      configuration: this.configuration, controller: new AbortController() };
    if (this.disposed) run.controller.abort(); else this.runs.add(run);
    return run;
  }

  private current(run: TranslationRun): boolean {
    return !this.disposed && !run.controller.signal.aborted && run.configuration === this.configurationKey() &&
      (!run.file || this.deps.app.vault.getAbstractFileByPath(run.file.path) === run.file);
  }

  private capture(run: TranslationRun, prompt: string): Promise<ReviewOutcome> {
    return this.requests.run(run.controller.signal, () => {
      if (!this.current(run)) throw new DOMException("Translation changed", "AbortError");
      return this.deps.captureText(prompt, this.deps.chatTimeoutMs(), run.controller.signal);
    });
  }

  /** A renamed/moved file keeps its cached glossary; a deleted one drops it. */
  public onFileDeleted(path: string): void {
    for (const run of this.runs) if (run.path === path) run.controller.abort();
    this.glossaryCache.delete(path);
    this.glossaryLanguages.delete(path);
    this.pretranslateRuns.delete(path);
    this.pretranslating.delete(path);
    if (!this.disposed && !this.pretranslating.size) this.clearPretranslateStatus();
  }

  public onFileRenamed(oldPath: string, newPath: string): void {
    const moved = this.glossaryCache.get(oldPath);
    const language = this.glossaryLanguages.get(oldPath);
    this.onFileDeleted(oldPath);
    if (moved) this.glossaryCache.set(newPath, moved);
    if (language) this.glossaryLanguages.set(newPath, language);
  }

  private dictionaryLanguageName(): string {
    return this.deps.settings().dictionaryLanguage.trim() || nativeLanguageName(getLocale());
  }

  /**
   * The inline replacement for a selection from the active file's cached
   * pre-translation, or null when the cache does not cover it (so the caller
   * falls back to a live call). Pure: no editor/file/notice side effects, so the
   * editor and Reading-view paths can each apply it their own way.
   */
  private glossFromCache(selection: string, mode: TranslateMode, file: TFile | null): string | null {
    const glossary = file ? this.glossaryCache.get(file.path) : undefined;
    if (!glossary || this.glossaryLanguages.get(file!.path) !== this.dictionaryLanguageName()) return null;
    if (mode === "word") {
      const gloss = lookupGloss(glossary, selection);
      if (gloss) {
        const replacement = formatWordGloss(selection, gloss);
        return replacement === selection ? null : replacement;
      }
    }
    const glossed = applyGlossary(selection, glossary);
    return glossed !== selection ? glossed : null;
  }

  /**
   * Resolve a selection's gloss with one live model call, formatting it for the
   * mode (a single "word (meaning)" or a passage with inline glosses). Shared by
   * the editor and Reading-view paths; neither touches the document here.
   */
  private async liveGloss(
    selection: string,
    contextLine: string,
    mode: TranslateMode,
    target: string,
    run: TranslationRun
  ): Promise<LiveGloss> {
    const prompt =
      mode === "word"
        ? buildWordGlossPrompt(selection.trim(), contextLine, target)
        : buildPassageGlossPrompt(selection, target);
    const outcome = await this.capture(run, prompt);
    if (outcome.kind !== "ok") return { kind: "fail", outcome };
    const wordGloss = mode === "word" ? cleanGloss(outcome.reviewText) : "";
    const replacement =
      mode === "word"
        ? formatWordGloss(selection, wordGloss)
        : stripWrapper(outcome.reviewText);
    if (!replacement.trim() || replacement === selection) return { kind: "noop" };
    const word =
      mode === "word" && wordGloss
        ? { surface: selection.trim(), gloss: wordGloss }
        : undefined;
    return word ? { kind: "ok", replacement, word } : { kind: "ok", replacement };
  }

  /**
   * Add a live word gloss to the active file's cached glossary so a repeat Alt+T
   * on the same term answers from cache. No-op when the file has no glossary yet.
   */
  private cacheWordGloss(file: TFile | null, surface: string, gloss: string, target: string): void {
    if (!surface || !gloss) return;
    if (!file || this.deps.app.vault.getAbstractFileByPath(file.path) !== file) return;
    const glossary = this.glossaryCache.get(file.path);
    if (!glossary || this.glossaryLanguages.get(file.path) !== target || target !== this.dictionaryLanguageName()) return;
    this.glossaryCache.set(file.path, mergeGlossaryEntry(glossary, { surface, gloss }));
  }

  /** File-open hook: pre-translate the document when the feature is enabled. */
  public async maybePretranslate(file: TFile): Promise<void> {
    if (this.disposed) return;
    this.onSettingsChanged();
    if (!this.deps.settings().pretranslateOnOpen) return;
    // Don't auto-translate the plugin's own generated memory/library notes.
    const root = this.deps.settings().memoryRoot;
    if (root && (file.path === root || file.path.startsWith(`${root}/`))) return;
    await this.pretranslateFile(file, false);
  }

  /** Manual command: (re)build the pre-translation glossary for the active note. */
  public async pretranslateActiveFile(): Promise<void> {
    if (this.disposed) return;
    this.onSettingsChanged();
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
    const path = file.path;
    if (this.pretranslating.has(path)) {
      if (manual) new Notice(t("notice.pretranslateBusy"));
      return;
    }
    // Reserve before reading: two open/manual triggers may arrive in one tick.
    this.pretranslating.add(path);
    const run = this.beginRun(file);
    this.pretranslateRuns.set(path, run);
    const target = run.language;
    const current = () => this.current(run) && this.pretranslateRuns.get(path) === run && file.path === path;
    try {
      const content = await this.deps.app.vault.cachedRead(file);
      if (!current()) return;
      const hash = contentHash(content);
      const existing = this.glossaryCache.get(path);
      if (existing && existing.hash === hash && existing.complete && this.glossaryLanguages.get(path) === target) {
        if (manual) new Notice(t("notice.pretranslateUpToDate", { count: existing.entries.length }));
        return;
      }
      const batches = segmentDocument(content, this.deps.settings().pretranslateChunkChars).slice(0, MAX_PRETRANSLATE_BATCHES);
      if (this.glossaryLanguages.get(path) !== target) this.glossaryCache.delete(path);
      this.glossaryLanguages.set(path, target);
      if (batches.length === 0) {
        this.glossaryCache.set(path, buildFileGlossary(hash, []));
        if (manual) new Notice(t("notice.pretranslateEmpty"));
        return;
      }
      this.setPretranslateStatus(0, batches.length);
      const results: GlossaryEntry[][] = Array.from({ length: batches.length }, () => []);
      let done = 0, failed = 0, needsKey = false;
      const entries = () => results.flat();
      const translateBatch = async (index: number): Promise<void> => {
        let outcome: ReviewOutcome;
        try {
          outcome = await this.capture(run, buildGlossaryPrompt(batches[index]!, target));
        } catch (error) {
          if (!current()) return;
          console.error("[Annotation Tutor Lite] pre-translate batch error", error);
          outcome = { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
        }
        if (!current()) return;
        if (outcome.kind === "needs-key") { needsKey = true; return; }
        if (outcome.kind === "ok") results[index] = parseGlossary(outcome.reviewText);
        else failed += 1;
        done += 1;
        // Source order wins duplicate terms even when replies finish out of order.
        this.glossaryCache.set(path, buildFileGlossary(hash, entries(), false));
        this.setPretranslateStatus(done, batches.length);
      };
      // Probe once before overlapping calls, so missing credentials cost one call.
      await translateBatch(0);
      let next = 1;
      const configured = this.concurrency();
      const concurrency = Number.isFinite(configured) ? Math.max(1, Math.min(2, Math.floor(configured))) : 1;
      const worker = async () => {
        while (!needsKey && current() && next < batches.length) await translateBatch(next++);
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (!current()) return;
      // An edited source must not acquire a completed cache for the old text.
      if (contentHash(await this.deps.app.vault.cachedRead(file)) !== hash || !current()) {
        this.glossaryCache.delete(path);
        return;
      }
      const glossary = buildFileGlossary(hash, entries(), !needsKey && failed === 0 && done === batches.length);
      this.glossaryCache.set(path, glossary);
      if (!manual) return;
      if (needsKey) { new Notice(t("notice.apiKeyMissing")); return; }
      const count = glossary.entries.length;
      if (count > 0) new Notice(failed > 0 ? t("notice.pretranslatePartial", { count, failed }) : t("notice.pretranslateDone", { count }));
      else new Notice(t(failed > 0 ? "notice.pretranslateFailed" : "notice.pretranslateEmpty"));
    } catch (error) {
      if (!current()) return;
      console.error("[Annotation Tutor Lite] pre-translate error", error);
      if (manual) new Notice(t("notice.pretranslateFailed"));
    } finally {
      this.runs.delete(run);
      if (this.pretranslateRuns.get(path) === run) {
        this.pretranslateRuns.delete(path); this.pretranslating.delete(path);
      }
      if (!this.disposed && this.pretranslating.size === 0) this.clearPretranslateStatus();
    }
  }

  /** Show a compact "done/total" pre-translation counter in the status bar. */
  private setPretranslateStatus(done: number, total: number): void {
    if (this.disposed) return;
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
   * Alt+T in the editor (Live Preview / Source): gloss the selection inline for
   * immersive reading. A single word/term becomes "word (meaning)"; a passage
   * gets every foreign word glossed in place.
   */
  public async translateSelection(editor: Editor): Promise<void> {
    if (this.disposed) return;
    this.deps.activity?.();
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice(t("notice.translateSelect"));
      return;
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const mode = classifyTranslateSelection(selection);
    const file = this.editorFile(editor);
    const target = captureTextTarget(editor.getValue(), editor.posToOffset(from), editor.posToOffset(to));
    const run = this.beginRun(file), language = run.language;
    let progress: Notice | undefined;
    try {
      const cached = this.glossFromCache(selection, mode, file);
      if (cached && this.replaceSelection(editor, file, target, cached, run)) {
        new Notice(t("notice.translateDone"));
        return;
      }
      progress = new Notice(t("notice.translating"), 0);
      const result = await this.liveGloss(
        selection,
        lineTextWithoutBlockId(editor.getLine(from.line)),
        mode,
        language,
        run
      );
      if (!this.current(run)) return;
      if (!this.handleLiveOutcome(result)) return;
      if (!this.replaceSelection(editor, file, target, result.replacement, run)) {
        this.preserveResult(result.replacement);
        return;
      }
      // Self-healing cache: a missed word is glossed live once, then remembered.
      if (result.word) this.cacheWordGloss(file, result.word.surface, result.word.gloss, language);
      new Notice(t("notice.translateDone"));
    } catch (error) {
      if (!this.current(run)) return;
      new Notice(
        t("notice.translateFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      this.runs.delete(run); progress?.hide();
    }
  }

  /**
   * Alt+T in Reading view, where there is no editor: translate the rendered
   * selection and write the gloss back into the source file (the view then
   * re-renders with it). The first matching occurrence is glossed, mirroring how
   * Reading-view annotations locate their text.
   */
  public async translateReadingSelection(
    file: TFile,
    rawSelection: string
  ): Promise<void> {
    if (this.disposed) return;
    const selection = rawSelection.trim();
    if (!selection) {
      new Notice(t("notice.translateSelect"));
      return;
    }
    const mode = classifyTranslateSelection(selection);
    const run = this.beginRun(file), language = run.language;
    let progress: Notice | undefined;
    try {
      const original = await this.deps.app.vault.cachedRead(file);
      if (!this.current(run)) return;
      const target = uniqueTextTarget(original, selection);
      const cached = this.glossFromCache(selection, mode, file);
      if (cached && await this.replaceInFile(file, target, cached, run)) {
        if (this.current(run)) new Notice(t("notice.translateDone"));
        return;
      }
      if (!this.current(run)) return;
      progress = new Notice(t("notice.translating"), 0);
      const content = await this.deps.app.vault.cachedRead(file);
      if (!this.current(run)) return;
      const result = await this.liveGloss(
        selection,
        sourceLineContaining(content, selection) ?? selection,
        mode,
        language,
        run
      );
      if (!this.current(run)) return;
      if (!this.handleLiveOutcome(result)) return;
      const replaced = await this.replaceInFile(file, target, result.replacement, run);
      if (!this.current(run)) return;
      if (!replaced) {
        this.preserveResult(result.replacement);
        return;
      }
      if (result.word) this.cacheWordGloss(file, result.word.surface, result.word.gloss, language);
      new Notice(t("notice.translateDone"));
    } catch (error) {
      if (!this.current(run)) return;
      new Notice(
        t("notice.translateFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      this.runs.delete(run); progress?.hide();
    }
  }

  /**
   * Narrow a live-gloss outcome to the success case, showing the right notice for
   * a failure or an empty result. Returns true only when there is a replacement.
   */
  private handleLiveOutcome(
    result: LiveGloss
  ): result is Extract<LiveGloss, { kind: "ok" }> {
    if (result.kind === "fail") {
      this.noticeForTranslate(result.outcome);
      return false;
    }
    if (result.kind === "noop") {
      new Notice(t("notice.translateFailed", { detail: t("notice.translateEmpty") }));
      return false;
    }
    return true;
  }

  private editorFile(editor: Editor): TFile | null {
    for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as { editor?: Editor; file?: TFile };
      if (view.editor === editor) return view.file ?? null;
    }
    return null;
  }

  private preserveResult(text: string): void {
    if (this.disposed) return;
    const modal = new Modal(this.deps.app);
    modal.titleEl.setText(t("upgrade.translationPreserved"));
    const field = modal.contentEl.createEl("textarea", { attr: { readonly: "true", rows: "10" } });
    field.value = text; field.style.width = "100%";
    const copy = modal.contentEl.createEl("button", { text: t("chat.copy") });
    copy.onclick = () => { field.select(); void field.ownerDocument.defaultView?.navigator.clipboard.writeText(text); };
    modal.open();
  }

  private async replaceInFile(file: TFile, target: TextTarget | null, replacement: string, run: TranslationRun): Promise<boolean> {
    if (!this.current(run) || !target || this.deps.app.vault.getAbstractFileByPath(file.path) !== file) return false;
    let found = false;
    await this.deps.app.vault.process(file, data => {
      if (!this.current(run)) return data;
      const range = resolveTextTarget(target, data);
      if (!range) return data;
      found = true; return data.slice(0, range.start) + replacement + data.slice(range.end);
    });
    return found;
  }

  private replaceSelection(editor: Editor, file: TFile | null, target: TextTarget, replacement: string, run: TranslationRun): boolean {
    if (!this.current(run) || !file || this.editorFile(editor) !== file) return false;
    const range = resolveTextTarget(target, editor.getValue());
    if (!range) return false;
    editor.replaceRange(replacement, editor.offsetToPos(range.start), editor.offsetToPos(range.end));
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

/** The source line that contains `selection`, block id stripped, or null. */
function sourceLineContaining(content: string, selection: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (line.includes(selection)) return lineTextWithoutBlockId(line);
  }
  return null;
}
