// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { replaceListOptions, LIST_FACET_OPTION_LIMIT } from "../src/list-select.js";
import { setLocale, t } from "../src/i18n.js";

afterEach(() => { document.body.replaceChildren(); setLocale("en"); });
function fixture(values: string[], selected = "") {
  const host = document.createElement("div"), select = document.createElement("select");
  host.append(select); document.body.append(host);
  replaceListOptions(select, values, "All concepts", selected);
  return { host, select };
}
function draft(input: HTMLInputElement, value: string) { input.value = value; input.dispatchEvent(new Event("input")); }
const values = () => Array.from({ length: 10000 }, (_, index) => `unique-${String(index).padStart(5, "0")}`);

describe("bounded facet catalogs", () => {
  it("renders at most one page of ten thousand options and reaches the final value", () => {
    const { host, select } = fixture(values());
    const search = host.querySelector<HTMLInputElement>("input")!;
    expect(select.options.length).toBe(LIST_FACET_OPTION_LIMIT + 1);
    expect(host.querySelector(".atl-facet-count")!.textContent).toContain("10000");
    draft(search, "unique-09999");
    expect(select.options.length).toBe(2); expect(select.options[1]!.value).toBe("unique-09999");
    select.value = "unique-09999";
    draft(search, "unique-00001");
    expect(select.value).toBe("unique-09999");
    expect([...select.options].map(option => option.value)).toEqual(["", "unique-00001", "unique-09999"]);
  });
  it("preserves the option-search DOM and IME buffer through catalog replacement", () => {
    const catalog = values(), { host, select } = fixture(catalog);
    const search = host.querySelector<HTMLInputElement>("input")!;
    search.focus(); search.dispatchEvent(new CompositionEvent("compositionstart")); draft(search, "unique-09999");
    replaceListOptions(select, [...catalog, "later"], "All concepts");
    expect(host.querySelector("input")).toBe(search); expect(document.activeElement).toBe(search);
    expect(search.value).toBe("unique-09999"); expect(select.options.length).toBe(101);
    search.dispatchEvent(new CompositionEvent("compositionend"));
    expect(select.options.length).toBe(2); expect(select.options[1]!.value).toBe("unique-09999");
  });
  it("removes the extra search after contraction and preserves a valid chosen option", () => {
    const { host, select } = fixture(values(), "unique-09999");
    const obsoleteSearch = host.querySelector<HTMLInputElement>("input")!;
    replaceListOptions(select, ["first", "unique-09999"], "All concepts", "unique-09999");
    expect(host.querySelector("input")).toBeNull(); expect(host.querySelector(".atl-facet-count")).toBeNull();
    expect(select.value).toBe("unique-09999");
    expect([...select.options].map(option => option.value)).toEqual(["", "first", "unique-09999"]);
    draft(obsoleteSearch, "missing");
    expect([...select.options].map(option => option.value)).toEqual(["", "first", "unique-09999"]);
  });
  it("keeps small facet ordering and translates every search aria label", () => {
    const { host, select } = fixture(["third", "first", "second"], "first");
    expect(host.querySelector("input")).toBeNull(); expect(select.value).toBe("first");
    expect([...select.options].map(option => option.value)).toEqual(["", "third", "first", "second"]);
    for (const locale of ["en", "zh-cn", "zh-tw", "ja"] as const) {
      setLocale(locale); const other = fixture(values()).host.querySelector<HTMLInputElement>("input")!;
      expect(other.getAttribute("aria-label")).toBe(t("list.searchOptions", { label: "All concepts" }));
    }
  });
});


it("prioritizes the exact original value over hundreds of substring matches", () => {
  const catalog = [...Array.from({ length: 200 }, (_, index) => `aaa-${index}-needle`), "needle"].sort();
  const { host, select } = fixture(catalog);
  draft(host.querySelector<HTMLInputElement>("input")!, "needle");
  expect(select.options.length).toBeLessThanOrEqual(LIST_FACET_OPTION_LIMIT + 2);
  expect(select.options[1]!.value).toBe("needle");
  select.value = "needle"; expect(select.value).toBe("needle");
});

it("searches original values when custom display labels omit them", () => {
  const { host, select } = fixture([]);
  const catalog = Array.from({ length: 200 }, (_, index) => `internal-${index}`);
  replaceListOptions(select, catalog, "All concepts", "", () => "Friendly name");
  draft(host.querySelector<HTMLInputElement>("input")!, "internal-199");
  expect(select.options.length).toBe(2);
  expect(select.options[1]!.value).toBe("internal-199"); expect(select.options[1]!.textContent).toBe("Friendly name");
  select.value = "internal-199"; expect(select.value).toBe("internal-199");
});

it("keeps a case-sensitive exact value reachable among more than one hundred folded equivalents", () => {
  const catalog = Array.from({ length: 128 }, (_, index) => [..."needles"].map((character, bit) => index & (1 << bit) ? character.toUpperCase() : character).join(""));
  const target = catalog.at(-1)!;
  const { host, select } = fixture(catalog);
  draft(host.querySelector<HTMLInputElement>("input")!, target);
  expect(select.options[1]!.value).toBe(target);
  expect(select.options.length).toBeLessThanOrEqual(LIST_FACET_OPTION_LIMIT + 2);
  select.value = target; expect(select.value).toBe(target);
});
