/** Keep a background settings refresh from discarding a form being edited. */
const initialValues = new WeakMap<HTMLInputElement | HTMLTextAreaElement, string>();
const refreshingEditors = new WeakSet<HTMLInputElement | HTMLTextAreaElement>();
const ROW_KEY = "atlSettingsRow";
const CONTROL_KEY = "atlSettingsControl";
const controls = "input, textarea, select, button";

function isEditor(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element.tagName === "TEXTAREA" || (element.tagName === "INPUT" &&
    !["checkbox", "radio", "button", "submit", "color", "range"].includes((element as HTMLInputElement).type));
}

/** Keys use setting labels, so revealing a conditional field does not shift unrelated controls. */
export function prepareSettingsUi(root: HTMLElement): void {
  const names = new Map<string, number>();
  for (const row of root.querySelectorAll<HTMLElement>(".setting-item")) {
    const name = row.querySelector(".setting-item-name")?.textContent ?? "";
    const occurrence = names.get(name) ?? 0;
    names.set(name, occurrence + 1);
    row.dataset[ROW_KEY] = `${name}:${occurrence}`;
  }
  const loose = new Map<string, number>();
  for (const control of root.querySelectorAll<HTMLElement>(controls)) {
    const row = control.closest<HTMLElement>(".setting-item");
    if (row) {
      control.dataset[CONTROL_KEY] = `${row.dataset[ROW_KEY]}:${Array.from(row.querySelectorAll(controls)).indexOf(control)}`;
    } else {
      const name = `${control.tagName}:${control.getAttribute("type") ?? ""}:${control.getAttribute("placeholder") ?? (control.tagName === "BUTTON" ? control.textContent ?? "" : "")}`;
      const occurrence = loose.get(name) ?? 0;
      loose.set(name, occurrence + 1);
      control.dataset[CONTROL_KEY] = `${name}:${occurrence}`;
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
  const active = root.ownerDocument.activeElement;
  const focused = active instanceof HTMLElement && root.contains(active) ? active : null;
  const focusKey = focused?.dataset[CONTROL_KEY];
  const selection = focused && isEditor(focused)
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection }
    : null;
  const retained = new Map<string, HTMLElement>();
  const looseValues = new Map<string, string>();
  const protectedEditors = new Set<HTMLInputElement | HTMLTextAreaElement>();
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
        if (retainedRow) row.replaceWith(retainedRow);
      }
      for (const control of replacement.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) {
        const value = looseValues.get(control.dataset[CONTROL_KEY] ?? "");
        if (value != null) control.value = value;
      }
    },
    restore() {
      const target = focused?.isConnected ? focused : focusKey
        ? Array.from(root.querySelectorAll<HTMLElement>(controls)).find(control => control.dataset[CONTROL_KEY] === focusKey)
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
