// The study-notebook commands (build / enrich / open), extracted from the plugin
// so main.ts stays focused. The deterministic generation lives in
// markdown/notebook.ts + store.writeNotebook; this layer is the command flow.
// Shared services (store, index, engine turn) are injected.

import { Notice, TFile, type App } from "obsidian";
import { t } from "./i18n.js";
import { tutorSystemPrompt } from "./chat-prompt.js";
import { detectLanguageName } from "./lang.js";
import type { ChatMessage } from "./api-runner.js";
import type { IndexRecord, MemoryCell } from "./model.js";
import type { VaultStore } from "./store.js";

export type NotebookDeps = {
  app: App;
  store: VaultStore;
  records: () => IndexRecord[];
  cells: () => MemoryCell[];
  reviewLanguage: () => string;
  openPath: (path: string) => Promise<void>;
  runTurn: (
    messages: ChatMessage[],
    openCodePrompt: string
  ) => Promise<{ ok: boolean; text: string; error?: string }>;
};

export class NotebookController {
  public constructor(private readonly deps: NotebookDeps) {}

  /** Open the study notebook, building it first if it doesn't exist yet. */
  public async openNotebook(): Promise<void> {
    const path = this.deps.store.notebookIndexPath();
    if (this.deps.app.vault.getAbstractFileByPath(path) instanceof TFile) {
      await this.deps.openPath(path);
      return;
    }
    await this.buildNotebook();
  }

  /**
   * Build the per-Vault study notebook (index + per-document pages + related-
   * document chapters) from the current annotations and dialogue, then open it.
   * Deterministic and instant — no model calls (see {@link enrichNotebook}).
   */
  public async buildNotebook(): Promise<void> {
    const records = this.deps.records();
    if (records.length === 0) {
      new Notice(t("notice.notebookEmpty"));
      return;
    }
    const progress = new Notice(t("notice.notebookBuilding"), 0);
    try {
      const result = await this.deps.store.writeNotebook(records, this.deps.cells());
      progress.hide();
      new Notice(
        t("notice.notebookDone", { pages: result.pages, chapters: result.chapters })
      );
      await this.deps.openPath(result.path);
    } catch (error) {
      progress.hide();
      new Notice(
        t("notice.notebookFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  /**
   * Hybrid enrichment: build the notebook, but first ask the engine to write a
   * short synthesis for each studied document (sequential, free-model safe), so
   * the pages gain prose summaries on top of the deterministic structure.
   */
  public async enrichNotebook(): Promise<void> {
    const records = this.deps.records();
    if (records.length === 0) {
      new Notice(t("notice.notebookEmpty"));
      return;
    }
    const byDoc = new Map<string, IndexRecord[]>();
    for (const record of records) {
      const list = byDoc.get(record.sourceFile);
      if (list) list.push(record);
      else byDoc.set(record.sourceFile, [record]);
    }
    const docs = [...byDoc.entries()];
    const progress = new Notice(
      t("notice.notebookEnriching", { done: 0, total: docs.length }),
      0
    );
    const synthesis = new Map<string, string>();
    try {
      let done = 0;
      for (const [sourceFile, recs] of docs) {
        const text = await this.synthesizeDocument(sourceFile, recs);
        if (text) synthesis.set(sourceFile, text);
        done += 1;
        progress.setMessage(
          t("notice.notebookEnriching", { done, total: docs.length })
        );
      }
      const result = await this.deps.store.writeNotebook(
        records,
        this.deps.cells(),
        synthesis
      );
      progress.hide();
      new Notice(
        t("notice.notebookDone", { pages: result.pages, chapters: result.chapters })
      );
      await this.deps.openPath(result.path);
    } catch (error) {
      progress.hide();
      new Notice(
        t("notice.notebookFailed", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  /** One engine call: synthesize a learner's annotations on one document. */
  private async synthesizeDocument(
    sourceFile: string,
    records: IndexRecord[]
  ): Promise<string> {
    const title = sourceFile.split("/").pop()?.replace(/\.md$/i, "") ?? sourceFile;
    const lang =
      this.deps.reviewLanguage().trim() ||
      detectLanguageName(records.map((r) => r.userNote ?? "").join(" "));
    const items = records
      .map((record, index) => {
        const excerpt = (record.selectedText ?? "").replace(/\s+/g, " ").trim();
        const note = (record.userNote ?? record.userNoteSummary ?? "").trim();
        const review = (record.reviewSummary ?? record.reviewText ?? "").trim();
        return [
          `(${index + 1}) Excerpt: ${excerpt.slice(0, 200)}`,
          note ? `    Learner's note: ${note}` : "",
          review ? `    Your review: ${review}` : ""
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");
    const system = `${tutorSystemPrompt(lang)}\n\nYou are writing a short synthesis for the learner's study notebook page about "${title}".`;
    const user = `Below are the learner's annotations on ${sourceFile}. Write 2-4 sentences synthesizing what they engaged with and what to revisit. Plain prose — no headings, no lists.\n\n${items}`;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
    const turn = await this.deps.runTurn(messages, `${system}\n\n${user}`);
    return turn.ok ? turn.text.trim() : "";
  }
}
