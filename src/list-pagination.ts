import { t } from "./i18n.js";

export const LIST_PAGE_SIZE = 100;
export type ListPageState = { page: number };

/** Keeps paging in memory; rendering and filtering always use the complete list. */
export class ListPagination {
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly label: HTMLElement;
  public constructor(root: HTMLElement, private readonly state: ListPageState, onChange: () => void) {
    const bar = root.createDiv({ cls: "atl-pagination" });
    bar.setAttribute("role", "navigation");
    bar.setAttribute("aria-label", t("list.pagination"));
    this.previous = bar.createEl("button", { text: t("list.previous"), cls: "atl-pagination-previous" });
    this.label = bar.createEl("span", { cls: "atl-pagination-count" });
    this.label.setAttribute("aria-live", "polite");
    this.next = bar.createEl("button", { text: t("list.next"), cls: "atl-pagination-next" });
    this.previous.onclick = () => { if (this.state.page > 0) { this.state.page--; onChange(); } };
    this.next.onclick = () => { if (!this.next.disabled) { this.state.page++; onChange(); } };
  }
  public slice<Value>(items: readonly Value[]): readonly Value[] {
    const pages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
    this.state.page = Math.max(0, Math.min(Math.floor(this.state.page), pages - 1));
    this.previous.disabled = this.state.page === 0;
    this.next.disabled = this.state.page >= pages - 1;
    this.label.textContent = t("list.pageCount", { page: this.state.page + 1, pages, total: items.length });
    return items.slice(this.state.page * LIST_PAGE_SIZE, (this.state.page + 1) * LIST_PAGE_SIZE);
  }
}
