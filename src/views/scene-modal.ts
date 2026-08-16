import { type App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n.js";
import type { SceneType } from "../model.js";

export type SceneInput = {
  title: string;
  type: SceneType;
  summary: string;
  cells: string[];
};

// Only well-formed cell ids are kept, so a hand-authored scene always parses
// back (the scene schema rejects any other cell reference).
const CELL_ID = /^(?:CELL|MEM)-[A-Za-z0-9_-]+$/;

/**
 * Lightweight form for creating a typed scene by hand (topic/course/document/
 * project). The caller performs the actual write and returns whether it
 * succeeded, so validation errors (duplicate id, empty fields) keep the modal
 * open instead of closing on a no-op.
 */
export class SceneCreateModal extends Modal {
  private title = "";
  private type: SceneType = "topic";
  private summary = "";
  private cells = "";

  public constructor(
    app: App,
    private readonly onSubmit: (input: SceneInput) => Promise<boolean>
  ) {
    super(app);
  }

  public override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: t("scene.createTitle") });

    new Setting(contentEl)
      .setName(t("scene.fieldTitle"))
      .addText((text) => text.onChange((value) => (this.title = value)));

    new Setting(contentEl)
      .setName(t("scene.fieldType"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            topic: t("scene.type.topic"),
            course: t("scene.type.course"),
            document: t("scene.type.document"),
            project: t("scene.type.project")
          })
          .setValue(this.type)
          .onChange((value) => (this.type = value as SceneType))
      );

    new Setting(contentEl)
      .setName(t("scene.fieldSummary"))
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area.onChange((value) => (this.summary = value));
      });

    new Setting(contentEl)
      .setName(t("scene.fieldCells"))
      .setDesc(t("scene.fieldCellsDesc"))
      .addText((text) => text.onChange((value) => (this.cells = value)));

    const actions = contentEl.createDiv({ cls: "atl-actions" });
    const cancel = actions.createEl("button", { text: t("common.cancel") });
    cancel.onclick = () => this.close();
    const create = actions.createEl("button", {
      text: t("scene.create"),
      cls: "mod-cta"
    });
    create.onclick = () => {
      const cells = this.cells
        .split(",")
        .map((id) => id.trim())
        .filter((id) => CELL_ID.test(id));
      void this.onSubmit({
        title: this.title,
        type: this.type,
        summary: this.summary,
        cells
      }).then((ok) => {
        if (ok) this.close();
        else new Notice(t("scene.createFailed"));
      });
    };
  }

  public override onClose(): void {
    this.contentEl.empty();
  }
}
