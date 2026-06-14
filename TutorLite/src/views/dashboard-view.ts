import { ItemView, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type AnnotationTutorLitePlugin from "../main.js";
import { t } from "../i18n.js";
import { AnnotationTable } from "./annotation-table.js";

export const DASHBOARD_VIEW_TYPE = "annotation-tutor-lite-dashboard";

export class DashboardView extends ItemView {
  public constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AnnotationTutorLitePlugin
  ) {
    super(leaf);
  }

  public override getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  public override getDisplayText(): string {
    return t("dash.title");
  }

  public override getIcon(): string {
    return "graduation-cap";
  }

  public override async onOpen(): Promise<void> {
    this.render();
  }

  public refresh(): void {
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "atl-root" });
    const header = root.createDiv({ cls: "atl-dash-header" });
    header.createEl("h3", { text: t("dash.title") });
    const gear = header.createEl("button", { cls: "atl-iconbtn" });
    setIcon(gear, "settings");
    setTooltip(gear, t("panel.settings"));
    gear.onclick = () => this.plugin.openSettings();
    new AnnotationTable(root.createDiv(), this.plugin).render();
  }

  public override async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
