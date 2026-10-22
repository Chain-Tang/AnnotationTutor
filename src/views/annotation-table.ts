import { setTooltip } from "obsidian";
import { ANNOTATION_REVIEW_ICON, setAnnotationIcon } from "../annotation-icons.js";
import type AnnotationTutorLitePlugin from "../main.js";
import type { IndexQuery } from "../index-table.js";
import { annotationStatuses, type IndexRecord } from "../model.js";
import { t } from "../i18n.js";
import { ListPagination, type ListPageState } from "../list-pagination.js";
import { replaceListOptions } from "../list-select.js";
import { bindSearchInput } from "../committed-input.js";

// Each annotation is a three-row record: a compact metadata row (these columns)
// plus full-width Note and Review bands rendered below it. The header and the
// empty-state cell span only these metadata columns.
const META_COLUMN_KEYS = [
  "dash.col.id",
  "dash.col.status",
  "dash.col.concept",
  "dash.col.source",
  "dash.col.updated",
  "dash.col.actions"
];

const COLSPAN = META_COLUMN_KEYS.length;

export type AnnotationTableState = { filter: IndexQuery; pagination: ListPageState };
export class AnnotationTable {
  private readonly filter: IndexQuery;
  private pager: ListPagination | undefined;
  private readonly facets = new Map<"sources" | "concepts", HTMLSelectElement>();
  private snapshot: unknown;
  private table: HTMLElement | null = null;

  public constructor(
    private readonly container: HTMLElement,
    private readonly plugin: AnnotationTutorLitePlugin,
    private readonly state: AnnotationTableState = { filter: {}, pagination: { page: 0 } }
  ) { this.filter = state.filter; }

  public render(): void {
    this.container.empty();
    this.snapshot = undefined;
    this.buildToolbar(this.container);
    const table = this.container.createEl("table", { cls: "atl-table" });
    const headRow = table.createEl("thead").createEl("tr");
    for (const key of META_COLUMN_KEYS) headRow.createEl("th", { text: t(key) });
    this.table = table;
    this.pager = new ListPagination(this.container, this.state.pagination, () => this.renderRows());
    this.refresh();
  }

  private buildToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "atl-toolbar" });
    const search = toolbar.createEl("input", { type: "text" });
    search.placeholder = t("dash.search");
    search.value = this.filter.text ?? "";
    bindSearchInput(search, value => {
      this.filter.text = value;
      this.filterChanged();
    });
    this.select(
      toolbar,
      ["", ...annotationStatuses],
      t("dash.allStatuses"),
      (value) => {
        this.filter.status = value as IndexQuery["status"];
        this.filterChanged();
      }, undefined, this.filter.status
    );
    this.facets.set("sources", this.select(
      toolbar,
      [""],
      t("dash.allSources"),
      (value) => {
        this.filter.sourceFile = value || undefined;
        this.filterChanged();
      }, undefined, this.filter.sourceFile
    ));
    this.facets.set("concepts", this.select(
      toolbar,
      [""],
      t("dash.allConcepts"),
      (value) => {
        this.filter.concept = value || undefined;
        this.filterChanged();
      }, undefined, this.filter.concept
    ));
    this.select(
      toolbar,
      ["", "reviewed", "unreviewed"],
      t("dash.anyReview"),
      (value) => {
        this.filter.reviewState = value as IndexQuery["reviewState"];
        this.filterChanged();
      },
      (value) =>
        value === "reviewed"
          ? t("dash.reviewed")
          : value === "unreviewed"
            ? t("dash.unreviewed")
            : value,
      this.filter.reviewState
    );
    this.select(
      toolbar,
      ["", "7", "30"],
      t("dash.anyTime"),
      (value) => {
        this.filter.withinDays = value ? Number(value) : undefined;
        this.filterChanged();
      },
      (value) =>
        value === "7" ? t("dash.last7") : value === "30" ? t("dash.last30") : value,
      this.filter.withinDays ? String(this.filter.withinDays) : ""
    );
  }

  private select(
    toolbar: HTMLElement,
    values: string[],
    allLabel: string,
    onChange: (value: string) => void,
    display: (value: string) => string = (value) => value,
    selected = ""
  ): HTMLSelectElement {
    const select = toolbar.createEl("select");
    replaceListOptions(select, values, allLabel, selected, display);
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  private filterChanged(): void { this.state.pagination.page = 0; this.renderRows(); }

  /** Refresh only rows/facets; keep search, focus and its IME buffer mounted. */
  public refresh(): void {
    const snapshot = this.plugin.librarySnapshot;
    if (this.snapshot !== snapshot) {
      this.snapshot = snapshot;
      for (const [kind, select] of this.facets) {
        const selected = kind === "sources" ? this.filter.sourceFile : this.filter.concept;
        const values = kind === "sources" ? this.plugin.indexTable.sources() : this.plugin.indexTable.concepts();
        const options = ["", ...values];
        if (selected && !options.includes(selected)) options.push(selected);
        replaceListOptions(select, options, t(kind === "sources" ? "dash.allSources" : "dash.allConcepts"), selected);
      }
    }
    this.renderRows();
  }

  private renderRows(): void {
    const table = this.table;
    if (!table) return;
    for (const tbody of Array.from(table.querySelectorAll("tbody"))) {
      tbody.remove();
    }
    const records = this.plugin.indexTable.query(this.filter);
    const page = this.pager?.slice(records) ?? records;
    if (records.length === 0) {
      const cell = table
        .createEl("tbody")
        .createEl("tr")
        .createEl("td", { text: t("dash.noAnnotations") });
      cell.colSpan = COLSPAN;
      cell.addClass("atl-muted");
      return;
    }
    for (const record of page) this.renderRecord(table, record);
  }

  // One annotation = one <tbody> grouping a metadata row and the two full-width
  // Note / Review bands, so CSS can hover and border the record as a unit.
  private renderRecord(table: HTMLElement, record: IndexRecord): void {
    const body = table.createEl("tbody", { cls: "atl-rec" });
    const meta = body.createEl("tr", { cls: "atl-rec-meta" });
    const idButton = meta.createEl("td").createEl("button", {
      text: record.annotationId,
      cls: "atl-id-button"
    });
    idButton.onclick = () => void this.plugin.openDetail(record);
    meta.createEl("td").createEl("span", {
      text: record.status,
      cls: `atl-status atl-status-${record.status}`
    });
    meta.createEl("td", { text: record.concepts.join(", ") || "—" });
    meta.createEl("td").createEl("span", {
      text: documentName(record.sourceFile),
      cls: "atl-rec-source",
      attr: { title: record.sourceFile }
    });
    meta.createEl("td", { text: formatDate(record.updatedAt) });
    const actions = meta.createEl("td").createDiv({ cls: "atl-row-actions" });
    this.action(actions, "corner-up-right", t("action.jump"), () =>
      this.plugin.openAnnotation(record)
    );
    this.action(actions, ANNOTATION_REVIEW_ICON, t("action.ask"), () =>
      this.plugin.askAgent(record)
    );
    this.action(actions, "clipboard-copy", t("action.copyPrompt"), () =>
      this.plugin.copyPrompt(record)
    );
    this.action(
      actions,
      "trash-2",
      t("action.delete"),
      () => this.plugin.confirmDelete(record),
      true
    );

    this.band(
      body,
      "atl-rec-note",
      t("dash.col.note"),
      record.userNote ?? record.userNoteSummary ?? "—"
    );
    this.band(
      body,
      "atl-rec-review",
      t("dash.col.review"),
      record.reviewSummary ?? "—"
    );
  }

  /** A full-width labelled band (Note or Review) spanning the metadata columns. */
  private band(
    body: HTMLElement,
    cls: string,
    label: string,
    text: string
  ): void {
    const cell = body.createEl("tr", { cls }).createEl("td");
    cell.colSpan = COLSPAN;
    cell.createEl("span", { text: label, cls: "atl-rec-label" });
    cell.createEl("div", { text, cls: "atl-rec-text" });
  }

  private action(
    container: HTMLElement,
    icon: string,
    tooltip: string,
    handler: () => void | Promise<void>,
    danger = false
  ): void {
    const button = container.createEl("button", {
      cls: danger ? "atl-iconbtn atl-iconbtn--danger" : "atl-iconbtn"
    });
    setAnnotationIcon(button, icon);
    setTooltip(button, tooltip);
    button.onclick = () => void handler();
  }
}

/** The bare document name (last path segment), e.g. "Paper.md" from "Papers/Paper.md". */
function documentName(sourceFile: string): string {
  return sourceFile.split("/").pop() || sourceFile;
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : value;
}
