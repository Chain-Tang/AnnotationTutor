/** Build large facet catalogs outside the live select to avoid repeated option
 * collection/selected-index updates while thousands of options are appended. */
export function replaceListOptions(
  select: HTMLSelectElement,
  values: readonly string[],
  emptyLabel: string,
  selected = "",
  display: (value: string) => string = value => value
): void {
  const doc = select.ownerDocument;
  const empty = doc.createElement("option"); empty.value = ""; empty.textContent = emptyLabel;
  const group = doc.createElement("optgroup"); group.label = emptyLabel;
  for (const value of values) {
    if (!value) continue;
    const option = doc.createElement("option"); option.value = value; option.textContent = display(value);
    group.append(option);
  }
  select.replaceChildren(empty, group);
  select.value = selected;
}
