import { type App, Modal, setIcon, setTooltip } from "obsidian";
import { t } from "../i18n.js";
import type { Annotation } from "../model.js";

type ConfirmOptions = {
  title: string;
  body: string;
  confirmText: string;
  warning?: boolean;
  onConfirm: () => void | Promise<void>;
};

export class ConfirmModal extends Modal {
  public constructor(
    app: App,
    private readonly options: ConfirmOptions
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.options.title });
    contentEl.createEl("p", { text: this.options.body });
    const actions = contentEl.createDiv({ cls: "atl-actions" });
    const cancel = actions.createEl("button", { text: t("common.cancel") });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl("button", {
      text: this.options.confirmText,
      cls: this.options.warning ? "mod-warning" : "mod-cta"
    });
    confirm.onclick = () => {
      void Promise.resolve(this.options.onConfirm()).then(() => this.close());
    };
  }

  public override onClose(): void {
    this.contentEl.empty();
  }
}

export type DetailHandlers = {
  jump: () => void | Promise<void>;
  ask: () => void | Promise<void>;
  copyPrompt: () => void | Promise<void>;
  openFile: () => void | Promise<void>;
  edit: () => void | Promise<void>;
  remove: () => void | Promise<void>;
};

/** Read-only detail view of one annotation with icon actions (spec §13.4). */
export class DetailModal extends Modal {
  public constructor(
    app: App,
    private readonly annotation: Annotation,
    private readonly handlers: DetailHandlers
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { contentEl } = this;
    const annotation = this.annotation;
    contentEl.createEl("h3", { text: annotation.id });
    contentEl.createEl("p", {
      cls: "atl-muted",
      text: `${annotation.sourceFile} · ${annotation.status}`
    });

    section(contentEl, t("detail.selectedText")).createEl("blockquote", {
      text: annotation.anchor.selectedText || t("detail.none")
    });
    section(contentEl, t("detail.userNote")).createEl("p", {
      text: annotation.userNote || t("detail.empty")
    });

    const review = section(contentEl, t("detail.agentReview"));
    if (annotation.reviewText) {
      review.createEl("pre", { text: annotation.reviewText });
    } else {
      review.createEl("p", { cls: "atl-muted", text: t("detail.noReview") });
    }

    const actions = contentEl.createDiv({ cls: "atl-iconbar" });
    this.button(actions, "corner-up-right", t("action.jump"), this.handlers.jump);
    this.button(actions, "pencil", t("action.edit"), this.handlers.edit);
    this.button(actions, "sparkles", t("action.ask"), this.handlers.ask);
    this.button(
      actions,
      "clipboard-copy",
      t("action.copyPrompt"),
      this.handlers.copyPrompt
    );
    this.button(actions, "file-text", t("action.openMemory"), this.handlers.openFile);
    this.button(actions, "trash-2", t("action.delete"), this.handlers.remove, true);
  }

  private button(
    container: HTMLElement,
    icon: string,
    tooltip: string,
    handler: () => void | Promise<void>,
    danger = false
  ): void {
    const button = container.createEl("button", {
      cls: danger ? "atl-iconbtn atl-iconbtn--danger" : "atl-iconbtn"
    });
    setIcon(button, icon);
    setTooltip(button, tooltip);
    button.onclick = () => {
      void Promise.resolve(handler()).then(() => this.close());
    };
  }

  public override onClose(): void {
    this.contentEl.empty();
  }
}

function section(parent: HTMLElement, title: string): HTMLElement {
  const wrapper = parent.createDiv({ cls: "atl-section" });
  wrapper.createEl("h4", { text: title });
  return wrapper;
}
