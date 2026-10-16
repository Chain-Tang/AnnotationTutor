import { bindSearchInput } from "./committed-input.js";
import { t } from "./i18n.js";

/** Large catalogs stay searchable without attaching thousands of native options. */
export const LIST_FACET_OPTION_LIMIT = 100;
type Catalog = {
  values: readonly string[];
  emptyLabel: string;
  display: (value: string) => string;
  query: string;
  search?: HTMLInputElement;
  count?: HTMLElement;
};
const catalogs = new WeakMap<HTMLSelectElement, Catalog>();

function renderOptions(select: HTMLSelectElement, catalog: Catalog, selected: string): void {
  const entered = catalog.query, trimmed = entered.trim(), query = trimmed.toLowerCase();
  let matches: readonly string[] = catalog.values;
  if (entered) {
    const ranked: string[][] = [[], [], [], [], []];
    for (const value of catalog.values) {
      const raw = value.toLowerCase(), label = catalog.display(value).toLowerCase();
      if (!raw.includes(query) && !label.includes(query)) continue;
      // A complete original value must always be reachable, even when hundreds
      // of labels contain it or differ only in case. Display text is optional.
      const priority = value === entered ? 0 : value === trimmed ? 1 : raw === query ? 2 : label.trim() === query ? 3 : 4;
      ranked[priority]!.push(value);
    }
    matches = ranked.flat();
  }
  const visible = matches.slice(0, LIST_FACET_OPTION_LIMIT);
  // Refining suggestions must not clear the active record filter. A selected
  // value outside the suggestion window remains selectable until changed.
  if (selected && !visible.includes(selected)) visible.push(selected);
  const doc = select.ownerDocument;
  const empty = doc.createElement("option"); empty.value = ""; empty.textContent = catalog.emptyLabel;
  const group = doc.createElement("optgroup"); group.label = catalog.emptyLabel;
  for (const value of visible) {
    const option = doc.createElement("option"); option.value = value; option.textContent = catalog.display(value);
    group.append(option);
  }
  select.replaceChildren(empty, group);
  select.value = selected;
  if (catalog.count) catalog.count.textContent = t("list.optionCount", { shown: Math.min(matches.length, LIST_FACET_OPTION_LIMIT), total: matches.length });
}

/** Preserve the native select for small facets. A large catalog gets a local
 * search over every value, with a bounded suggestion list. The source catalog
 * remains cached separately from DOM and record filtering remains exact. */
export function replaceListOptions(
  select: HTMLSelectElement,
  values: readonly string[],
  emptyLabel: string,
  selected = "",
  display: (value: string) => string = value => value
): void {
  let catalog = catalogs.get(select);
  if (!catalog) {
    catalog = { values: [], emptyLabel, display, query: "" };
    catalogs.set(select, catalog);
  }
  catalog.values = values.filter(Boolean);
  catalog.emptyLabel = emptyLabel;
  catalog.display = display;
  select.setAttribute("aria-label", emptyLabel);
  if (catalog.values.length <= LIST_FACET_OPTION_LIMIT && catalog.search) {
    catalog.search.remove(); catalog.count?.remove();
    delete catalog.search; delete catalog.count; catalog.query = "";
  }
  if (catalog.values.length > LIST_FACET_OPTION_LIMIT && !catalog.search) {
    const input = select.ownerDocument.createElement("input"); input.type = "search";
    input.className = "atl-facet-search";
    input.placeholder = t("list.searchOptions", { label: emptyLabel });
    input.setAttribute("aria-label", input.placeholder);
    const count = select.ownerDocument.createElement("span"); count.className = "atl-facet-count atl-muted";
    count.setAttribute("aria-live", "polite");
    select.before(input, count);
    catalog.search = input; catalog.count = count;
    const current = catalog;
    bindSearchInput(input, query => {
      if (current.search !== input) return;
      current.query = query; renderOptions(select, current, select.value);
    });
  }
  renderOptions(select, catalog, selected);
}
