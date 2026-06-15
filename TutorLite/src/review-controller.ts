// Memory-cell creation, SM-2 spaced review, and the opt-in feedback commands —
// the "learning loop" domain — extracted from the plugin. Pure logic lives in
// srs.ts / learning.ts / cell-distill.ts; this is the command/flow layer with its
// shared services (store, index, engine turn, rebuild) injected.

import { Notice, type App } from "obsidian";
import { t } from "./i18n.js";
import { dueCells, initReviewState, scheduleNext } from "./srs.js";
import { classifyCells } from "./learning.js";
import {
  asCellType,
  asConfidence,
  asText,
  cellTypeForCorrectness,
  confidenceForCorrectness,
  parseJsonObject
} from "./cell-distill.js";
import { cellIdForAnnotation, nowIso } from "./ids.js";
import { memoryCellSchema } from "./schemas.js";
import { parseAgentReview } from "./markdown/review.js";
import { tutorSystemPrompt } from "./chat-prompt.js";
import { detectLanguageName } from "./lang.js";
import { ReviewModal, setDueBadge, type ReviewCard } from "./views/review-modal.js";
import type { ChatMessage } from "./api-runner.js";
import type { IndexRecord, MemoryCell } from "./model.js";
import type { MemoryCellRecord } from "./library-index.js";
import type { AnnotationTutorLiteSettings } from "./settings-config.js";
import type { VaultStore } from "./store.js";

export type ReviewDeps = {
  app: App;
  store: VaultStore;
  /** Status-bar element for the "N due" badge. */
  statusBar: HTMLElement;
  record: (id: string) => IndexRecord | undefined;
  cells: () => MemoryCellRecord[];
  settings: () => AnnotationTutorLiteSettings;
  rebuild: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  runTurn: (
    messages: ChatMessage[],
    openCodePrompt: string
  ) => Promise<{ ok: boolean; text: string; error?: string }>;
};

export class ReviewController {
  public constructor(private readonly deps: ReviewDeps) {}

  // --- memory cells ----------------------------------------------------------

  /**
   * Distill a durable memory cell from an annotation (note + review + dialogue),
   * write it, and refresh the auto-grouped scenes. The engine produces the cell
   * when reachable; otherwise we fall back to a cell built from the note so the
   * learning memory still grows. This is the path that populates Cells & Scenes.
   */
  public async createCellFromAnnotation(id: string): Promise<void> {
    const record = this.deps.record(id);
    if (!record) {
      new Notice(t("notice.placeCursor"));
      return;
    }
    const progress = new Notice(t("notice.cellDistilling"), 0);
    try {
      const cell = await this.distillCell(record);
      if (!cell) {
        new Notice(t("notice.cellFailed"));
        return;
      }
      await this.deps.store.createMemoryCell(cell);
      await this.deps.store.syncScenesFromCells();
      await this.deps.rebuild();
      new Notice(t("notice.cellDone", { concept: cell.concept }));
    } catch (error) {
      console.error("[Annotation Tutor Lite] cell creation failed", error);
      new Notice(t("notice.cellFailed"));
    } finally {
      progress.hide();
    }
  }

  /** Build a validated MemoryCell from an annotation, model-distilled if possible. */
  private async distillCell(record: IndexRecord): Promise<MemoryCell | null> {
    const lang =
      this.deps.settings().reviewLanguage.trim() || detectLanguageName(record.userNote ?? "");
    const dialogue = (record.dialogue ?? [])
      .map((turn) => `${turn.role === "agent" ? "Tutor" : "Learner"}: ${turn.text}`)
      .join("\n");
    const system = `${tutorSystemPrompt(lang)}\n\nDistill ONE durable learning-memory cell from this annotation. Reply with a single JSON object and nothing else.`;
    const user = [
      "JSON keys:",
      "- type: one of understanding | misconception | goal | difficulty | strategy | progress",
      "- concept: a short noun phrase naming the topic",
      `- summary: 1-3 sentences on what the learner now understands or struggles with (in ${lang})`,
      "- confidence: a number from 0 to 1",
      "",
      `Selected text: ${record.selectedText ?? ""}`,
      `Learner's note: ${record.userNote ?? record.userNoteSummary ?? ""}`,
      ...(record.reviewText ? [`Tutor review: ${record.reviewText}`] : []),
      ...(dialogue ? [`Dialogue:\n${dialogue}`] : [])
    ].join("\n");
    const turn = await this.deps.runTurn(
      [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      `${system}\n\n${user}`
    );
    const parsed = turn.ok ? parseJsonObject(turn.text) : null;

    const concept =
      asText(parsed?.["concept"]) ||
      record.concepts[0] ||
      (record.selectedText ?? "").slice(0, 40).trim() ||
      record.annotationId;
    const summary =
      asText(parsed?.["summary"]) ||
      (record.userNote ?? record.userNoteSummary ?? record.reviewText ?? "").trim();
    if (!summary) return null;
    const now = nowIso();
    const id = cellIdForAnnotation(record.annotationId);
    const existing = this.deps.cells().find((cell) => cell.id === id);
    const candidate: MemoryCell = {
      id,
      type: asCellType(parsed?.["type"]),
      concept,
      status: "new",
      summary,
      sourceAnnotations: [record.annotationId],
      tags: record.concepts,
      confidence: asConfidence(parsed?.["confidence"]),
      review: existing?.review ?? initReviewState(now),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const validated = memoryCellSchema.safeParse(candidate);
    return validated.success ? validated.data : null;
  }

  /**
   * After a review, capture a memory cell automatically (deterministically, no
   * extra model call) so the learning memory grows on its own. Create-once per
   * annotation, so a richer manually-saved cell is never clobbered by a re-review.
   */
  public async autoSaveCellFromReview(
    record: IndexRecord,
    reviewText: string
  ): Promise<void> {
    const id = cellIdForAnnotation(record.annotationId);
    if (this.deps.cells().some((cell) => cell.id === id)) return;
    const review = parseAgentReview(reviewText, nowIso());
    const summary = (review?.summary ?? reviewText).trim();
    const concept =
      record.concepts[0] ||
      (record.selectedText ?? "").slice(0, 40).trim() ||
      record.annotationId;
    if (!summary || !concept) return;
    const now = nowIso();
    const candidate: MemoryCell = {
      id,
      type: cellTypeForCorrectness(review?.correctness),
      concept,
      status: "new",
      summary,
      sourceAnnotations: [record.annotationId],
      tags: record.concepts,
      confidence: confidenceForCorrectness(review?.correctness),
      review: initReviewState(now),
      createdAt: now,
      updatedAt: now
    };
    const validated = memoryCellSchema.safeParse(candidate);
    if (!validated.success) return;
    await this.deps.store.createMemoryCell(validated.data);
    await this.deps.store.syncScenesFromCells();
  }

  // --- spaced repetition -----------------------------------------------------

  /**
   * Open the SM-2 review modal over the cells due now. Gated by the opt-in
   * `enableSpacedReview` setting; each grade reschedules the cell (srs.ts) and
   * the file + in-memory schedule are updated so the due counter falls live.
   */
  public async reviewDueCells(): Promise<void> {
    if (!this.deps.settings().enableSpacedReview) {
      new Notice(t("notice.reviewDisabled"));
      return;
    }
    const cells = this.deps.cells();
    const due = dueCells(cells, nowIso());
    if (due.length === 0) {
      new Notice(t("notice.reviewNoneDue"));
      return;
    }
    const cards: ReviewCard[] = due.map((cell) => ({
      cellId: cell.id,
      concept: cell.concept,
      summary: cell.summary,
      path: cell.path
    }));
    new ReviewModal(this.deps.app, cards, {
      open: (path) => this.deps.openPath(path),
      grade: async (card, grade) => {
        const cell = cells.find((c) => c.id === card.cellId);
        const next = scheduleNext(cell?.review ?? initReviewState(nowIso()), grade, nowIso());
        await this.deps.store.updateCellSchedule(card.cellId, next);
        if (cell) cell.review = next; // keep the snapshot in step so the badge falls
        this.refreshBadge();
      }
    }).open();
  }

  /** Refresh the status-bar "N due" badge (hidden unless spaced review is on). */
  public refreshBadge(): void {
    const count = this.deps.settings().enableSpacedReview
      ? dueCells(this.deps.cells(), nowIso()).length
      : 0;
    setDueBadge(this.deps.statusBar, count, () => void this.reviewDueCells());
  }

  // --- opt-in feedback mechanisms (off by default) ---------------------------

  /** Retrieval-practice questions targeting weak cells (active recall). */
  public async generateWeaknessTraining(): Promise<void> {
    await this.generateFeedback({
      enabled: this.deps.settings().enableWeaknessTraining,
      cells: classifyCells(this.deps.cells()).weaknesses,
      fileName: "Training/weakness-practice.md",
      title: t("feedback.weaknessTitle"),
      instruction:
        "Write 5 short retrieval-practice questions (active recall) targeting these weak points. Number them, then put concise answers under a final '### Answers' heading. Write everything in {lang}."
    });
  }

  /** A narrative summary of strengths, weaknesses, and methods + next steps. */
  public async refreshLearningSummary(): Promise<void> {
    await this.generateFeedback({
      enabled: this.deps.settings().enableLearningSummary,
      cells: this.deps.cells(),
      fileName: "Learning summary.md",
      title: t("feedback.summaryTitle"),
      instruction:
        "From the cells below, write a short narrative of the learner's strengths, weaknesses, and problem-solving methods (use those three headings), then 2-3 concrete next study steps. Write in {lang}."
    });
  }

  /** Next-step extensions that build on the learner's strengths. */
  public async generateStrengthReinforcement(): Promise<void> {
    await this.generateFeedback({
      enabled: this.deps.settings().enableStrengthReinforcement,
      cells: classifyCells(this.deps.cells()).strengths,
      fileName: "Training/next-steps.md",
      title: t("feedback.strengthTitle"),
      instruction:
        "For each strength below, suggest one concrete next-step extension or application that deepens mastery. Keep it brief. Write in {lang}."
    });
  }

  /**
   * Shared driver for the opt-in feedback commands: gate on the setting, bail if
   * there are no matching cells, ask the engine once, and write the result to a
   * dated file under the memory root (then open it).
   */
  private async generateFeedback(opts: {
    enabled: boolean;
    cells: MemoryCell[];
    fileName: string;
    title: string;
    instruction: string;
  }): Promise<void> {
    if (!opts.enabled) {
      new Notice(t("notice.feedbackDisabled"));
      return;
    }
    if (opts.cells.length === 0) {
      new Notice(t("notice.feedbackNone"));
      return;
    }
    const lang =
      this.deps.settings().reviewLanguage.trim() ||
      detectLanguageName(opts.cells.map((cell) => cell.summary).join(" "));
    const progress = new Notice(t("notice.feedbackGenerating"), 0);
    try {
      const items = opts.cells
        .slice(0, 12)
        .map((cell, index) => `(${index + 1}) [${cell.type}] ${cell.concept}: ${cell.summary}`)
        .join("\n");
      const system = `${tutorSystemPrompt(lang)}\n\n${opts.instruction.replace(/\{lang\}/g, lang)}`;
      const turn = await this.deps.runTurn(
        [
          { role: "system", content: system },
          { role: "user", content: items }
        ],
        `${system}\n\n${items}`
      );
      if (!turn.ok || !turn.text.trim()) {
        new Notice(t("notice.feedbackFailed"));
        return;
      }
      const body = `# ${opts.title}\n\n_${nowIso()}_\n\n${turn.text.trim()}\n`;
      const path = await this.deps.store.writeMemoryDoc(opts.fileName, body);
      await this.deps.openPath(path);
    } catch (error) {
      console.error("[Annotation Tutor Lite] feedback generation failed", error);
      new Notice(t("notice.feedbackFailed"));
    } finally {
      progress.hide();
    }
  }
}
