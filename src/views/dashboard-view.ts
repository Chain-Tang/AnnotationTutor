import { ItemView, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type AnnotationTutorLitePlugin from "../main.js";
import { getLocale, t } from "../i18n.js";
import { AnnotationTable, type AnnotationTableState } from "./annotation-table.js";

export const DASHBOARD_VIEW_TYPE = "annotation-tutor-lite-dashboard";

export class DashboardView extends ItemView {
  private table: AnnotationTable | undefined;
  private readonly tableState: AnnotationTableState = { filter: {}, pagination: { page: 0 } };
  private locale = getLocale();
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
    // First sidebar open of the session offers to install the Web Clipper
    // (no-op once enabled or dismissed).
    this.plugin.maybeShowWebInstallPrompt();
  }

  public refresh(): void {
    if (this.table && this.locale === getLocale()) this.table.refresh();
    else this.render();
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
    this.locale = getLocale();
    this.table = new AnnotationTable(root.createDiv(), this.plugin, this.tableState);
    this.table.render();
  }

  public override async onClose(): Promise<void> {
    this.table = undefined;
    this.contentEl.empty();
  }
}
