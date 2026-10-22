/** Keep a background settings refresh from discarding a form being edited. */
const initialValues = new WeakMap<HTMLInputElement | HTMLTextAreaElement, string>();
const refreshingEditors = new WeakSet<HTMLInputElement | HTMLTextAreaElement>();
type DisclosureState = { open: Map<string, boolean>; searching: boolean };
const disclosureStates = new WeakMap<HTMLElement, DisclosureState>();
const disclosureOwners = new WeakMap<HTMLDetailsElement, { root: HTMLElement; id: string }>();
const trackedDisclosures = new WeakSet<HTMLDetailsElement>();
const ROW_KEY = "atlSettingsRow";
const CONTROL_KEY = "atlSettingsControl";
const EXPLICIT_KEY = "atlSettingsId";
const DISCLOSURE_KEY = "atlSettingsDisclosure";
const controls = "input, textarea, select, button";

function isEditor(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element.tagName === "TEXTAREA" || (element.tagName === "INPUT" &&
    !["checkbox", "radio", "button", "submit", "color", "range"].includes((element as HTMLInputElement).type));
}

function explicitId(element: HTMLElement, key: string): string | undefined {
  const id = element.dataset[key];
  return id?.trim() ? id : undefined;
}

/** Duplicate business identities are ambiguous even if their order is stable. */
function uniqueDisclosures(root: HTMLElement): { elements: Map<string, HTMLDetailsElement>; duplicates: Set<string> } {
  const elements = new Map<string, HTMLDetailsElement>(), duplicates = new Set<string>();
  for (const details of root.querySelectorAll<HTMLDetailsElement>("details[data-atl-settings-disclosure]")) {
    const id = explicitId(details, DISCLOSURE_KEY);
    if (!id || duplicates.has(id)) continue;
    if (elements.has(id)) { elements.delete(id); duplicates.add(id); }
    else elements.set(id, details);
  }
  return { elements, duplicates };
}

/** Search temporarily reveals groups. Its expansion is not a user preference.
 * Call prepareSettingsUi after updating data-atl-settings-searching and filters. */
function prepareDisclosures(root: HTMLElement): void {
  const state = disclosureStates.get(root) ?? { open: new Map<string, boolean>(), searching: false };
  disclosureStates.set(root, state);
  const current = uniqueDisclosures(root), searching = root.dataset["atlSettingsSearching"] === "true";
  for (const id of current.duplicates) state.open.delete(id);
  for (const [id, details] of current.elements) {
    if (!searching) {
      const open = state.searching ? state.open.get(id) : undefined;
      if (open !== undefined) details.open = open;
      state.open.set(id, details.open);
    }
    disclosureOwners.set(details, { root, id });
    if (trackedDisclosures.has(details)) continue;
    trackedDisclosures.add(details);
    details.addEventListener("toggle", () => {
      const owner = disclosureOwners.get(details);
      if (!owner || !owner.root.contains(details) || owner.root.dataset["atlSettingsSearching"] === "true") return;
      const ownerState = disclosureStates.get(owner.root);
      if (!ownerState || ownerState.searching || uniqueDisclosures(owner.root).elements.get(owner.id) !== details) return;
      ownerState.open.set(owner.id, details.open);
    });
  }
  state.searching = searching;
}

/** Business IDs survive translation and regrouping. Legacy controls retain their
 * label/occurrence fallback; ambiguous explicit IDs never reuse another row. */
export function prepareSettingsUi(root: HTMLElement): void {
  prepareDisclosures(root);
  const rows = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
  const ids = new Map<string, number>();
  for (const row of rows) {
    const id = explicitId(row, EXPLICIT_KEY);
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  const names = new Map<string, number>();
  for (const row of rows) {
    const id = explicitId(row, EXPLICIT_KEY);
    if (id) {
      if (ids.get(id) === 1) row.dataset[ROW_KEY] = `id:${JSON.stringify(id)}`;
      else delete row.dataset[ROW_KEY];
      continue;
    }
    const name = row.querySelector(".setting-item-name")?.textContent ?? "";
    const occurrence = names.get(name) ?? 0;
    names.set(name, occurrence + 1);
    row.dataset[ROW_KEY] = `legacy:${JSON.stringify(name)}:${occurrence}`;
  }
  const loose = new Map<string, number>();
  for (const control of root.querySelectorAll<HTMLElement>(controls)) {
    const row = control.closest<HTMLElement>(".setting-item");
    if (row) {
      if (row.dataset[ROW_KEY]) control.dataset[CONTROL_KEY] = `${row.dataset[ROW_KEY]}:${Array.from(row.querySelectorAll(controls)).indexOf(control)}`;
      else delete control.dataset[CONTROL_KEY];
    } else {
      const name = `${control.tagName}:${control.getAttribute("type") ?? ""}:${control.getAttribute("placeholder") ?? (control.tagName === "BUTTON" ? control.textContent ?? "" : "")}`;
      const occurrence = loose.get(name) ?? 0;
      loose.set(name, occurrence + 1);
      control.dataset[CONTROL_KEY] = `loose:${JSON.stringify(name)}:${occurrence}`;
    }
    if (isEditor(control) && !initialValues.has(control)) {
      initialValues.set(control, control.value);
      // Browsers can blur a focused control when its row is reparented. Block
      // only that synchronous refresh blur, before any commit listener runs.
      control.addEventListener("blur", event => {
        if (refreshingEditors.has(control)) event.stopImmediatePropagation();
      }, true);
      // Existing blur handlers commit or reject the draft before this listener.
      control.addEventListener("blur", () => initialValues.set(control, control.value));
      control.addEventListener("atl-settings-committed", () => initialValues.set(control, control.value));
    }
  }
}

export function captureSettingsUi(root: HTMLElement): {
  reuse: (replacement: HTMLElement) => void;
  restore: () => void;
} {
  // A partial render may have introduced a duplicate ID since the last prepare.
  prepareSettingsUi(root);
  const active = root.ownerDocument.activeElement;
  const OwnerHTMLElement = root.ownerDocument.defaultView?.HTMLElement;
  const focused = OwnerHTMLElement && active instanceof OwnerHTMLElement && root.contains(active) ? active : null;
  const focusKey = focused?.dataset[CONTROL_KEY];
  const selection = focused && isEditor(focused)
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection }
    : null;
  const retained = new Map<string, HTMLElement>();
  const looseValues = new Map<string, string>();
  const protectedEditors = new Set<HTMLInputElement | HTMLTextAreaElement>();
  const disclosures = disclosureStates.get(root)!.open;
  for (const editor of root.querySelectorAll(controls)) {
    const row = editor.closest<HTMLElement>(".setting-item");
    if (!row && ["INPUT", "TEXTAREA", "SELECT"].includes(editor.tagName)) {
      const control = editor as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (control.dataset[CONTROL_KEY]) looseValues.set(control.dataset[CONTROL_KEY], control.value);
    }
    if (!isEditor(editor) || (editor !== focused && editor.value === initialValues.get(editor)
      && !editor.dataset["atlCommitState"] && editor.getAttribute("aria-invalid") !== "true")) continue;
    // Keep the original row and its closures, particularly credential bindings
    // and paired width/height inputs. Replaying input events could persist drafts.
    if (row?.dataset[ROW_KEY]) {
      retained.set(row.dataset[ROW_KEY], row);
      for (const control of row.querySelectorAll(controls)) if (isEditor(control)) protectedEditors.add(control);
    } else if (editor === focused) protectedEditors.add(editor);
  }
  const scroll: Array<{ element: HTMLElement; top: number; left: number }> = [];
  for (let element: HTMLElement | null = root; element; element = element.parentElement) {
    scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
  }
  return {
    reuse(replacement) {
      prepareSettingsUi(replacement);
      for (const editor of protectedEditors) refreshingEditors.add(editor);
      for (const row of replacement.querySelectorAll<HTMLElement>(".setting-item")) {
        const retainedRow = retained.get(row.dataset[ROW_KEY] ?? "");
        if (retainedRow) {
          // Refresh translated labels and descriptions without replacing bound
          // controls, their drafts, or the closures of the original row.
          const previousInfo = retainedRow.querySelector(".setting-item-info"), nextInfo = row.querySelector(".setting-item-info");
          if (previousInfo && nextInfo) previousInfo.replaceWith(nextInfo);
          row.replaceWith(retainedRow);
          retained.delete(row.dataset[ROW_KEY] ?? "");
        }
      }
      for (const control of replacement.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) {
        const value = looseValues.get(control.dataset[CONTROL_KEY] ?? "");
        if (value != null) control.value = value;
      }
      const nextDisclosures = uniqueDisclosures(replacement);
      for (const id of nextDisclosures.duplicates) disclosures.delete(id);
      if (root.dataset["atlSettingsSearching"] !== "true") for (const [id, details] of nextDisclosures.elements) {
        const open = disclosures.get(id);
        if (open !== undefined) details.open = open;
      }
    },
    restore() {
      const visible = (element: HTMLElement): boolean => element.isConnected && root.contains(element) && !element.closest("[hidden]");
      const target = focused && visible(focused) ? focused : focusKey
        ? Array.from(root.querySelectorAll<HTMLElement>(controls)).find(control => control.dataset[CONTROL_KEY] === focusKey && visible(control))
        : undefined;
      try {
        target?.focus({ preventScroll: true });
        if (target && isEditor(target) && selection?.start != null && selection.end != null) {
          try { target.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined); } catch { /* Number inputs have no text selection. */ }
        }
        for (const { element, top, left } of scroll) { element.scrollTop = top; element.scrollLeft = left; }
      } finally {
        for (const editor of protectedEditors) refreshingEditors.delete(editor);
      }
    }
  };
}
