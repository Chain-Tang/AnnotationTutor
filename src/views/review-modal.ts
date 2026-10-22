// Spaced-repetition review modal: shows each due memory cell as a prompt (its
// concept), reveals the answer (its summary) on demand, then takes a grade that
// drives the SM-2 scheduler (see srs.ts). Pure UI — the plugin supplies the cards
// and handles grading/persistence via the handlers.

import { type App, Modal, Notice, setIcon } from "obsidian";
import { t } from "../i18n.js";
import type { ReviewGrade } from "../srs.js";

export type ReviewCard = {
  cellId: string;
  concept: string;
  summary: string;
  path: string;
};

export type ReviewModalHandlers = {
  grade: (card: ReviewCard, grade: ReviewGrade) => void | Promise<void>;
  open: (path: string) => void | Promise<void>;
};

const GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];

export class ReviewModal extends Modal {
  private index = 0;
  private reviewed = 0;
  private grading = false;
  private closed = false;
  private readonly completed = new Set<string>();

  public constructor(
    app: App,
    private readonly cards: ReviewCard[],
    private readonly handlers: ReviewModalHandlers
  ) {
    super(app);
  }

  public override onOpen(): void {
    this.modalEl.addClass("atl-review-modal");
    this.renderCurrent();
  }

  private renderCurrent(): void {
    const { contentEl } = this;
    contentEl.empty();
    const card = this.cards[this.index];
    if (!card) {
      contentEl.createEl("h3", { text: t("review.doneTitle") });
      contentEl.createEl("p", {
        text: t("review.done", { count: this.reviewed })
      });
      const close = contentEl.createDiv({ cls: "atl-actions" }).createEl("button", {
        text: t("common.close"),
        cls: "mod-cta"
      });
      close.onclick = () => this.close();
      return;
    }

    contentEl.createEl("div", {
      cls: "atl-muted atl-review-progress",
      text: t("review.progress", { done: this.index + 1, total: this.cards.length })
    });
    contentEl.createEl("h3", { text: card.concept, cls: "atl-review-concept" });

    const answer = contentEl.createEl("blockquote", {
      cls: "atl-review-answer",
      text: card.summary || t("review.noAnswer")
    });
    answer.hide();

    const open = contentEl.createEl("button", {
      cls: "atl-link-button atl-review-open",
      text: t("review.open")
    });
    open.onclick = () => void this.handlers.open(card.path);
    open.hide();

    const actions = contentEl.createDiv({ cls: "atl-actions atl-review-actions" });
    const reveal = actions.createEl("button", {
      text: t("review.show"),
      cls: "mod-cta"
    });
    reveal.onclick = () => {
      answer.show();
      open.show();
      actions.empty();
      for (const grade of GRADES) {
        const button = actions.createEl("button", { text: t(`review.grade.${grade}`) });
        if (grade === "good") button.addClass("mod-cta");
        button.onclick = () => void this.gradeAndAdvance(card, grade);
      }
    };
  }

  private async gradeAndAdvance(card: ReviewCard, grade: ReviewGrade): Promise<void> {
    if (this.closed || this.grading || this.completed.has(card.cellId)) return;
    this.grading = true;
    this.contentEl.querySelectorAll("button").forEach(button => button.disabled = true);
    try {
      await this.handlers.grade(card, grade);
      this.completed.add(card.cellId); this.reviewed += 1; this.index += 1;
      if (!this.closed) this.renderCurrent();
    } catch {
      if (!this.closed) new Notice(t("upgrade.reviewSaveFailed"));
    } finally {
      this.grading = false;
      this.contentEl.querySelectorAll("button").forEach(button => button.disabled = false);
    }
  }

  public override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}

/** A small status-bar element factory for the "N due" indicator. */
export function setDueBadge(el: HTMLElement, count: number, onClick: () => void): void {
  el.empty();
  if (count <= 0) return;
  setIcon(el.createSpan({ cls: "atl-due-icon" }), "alarm-clock");
  el.createSpan({ text: ` ${count}` });
  el.onclick = onClick;
}
