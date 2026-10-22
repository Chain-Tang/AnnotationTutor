// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { captureSettingsUi, prepareSettingsUi } from "../src/settings-ui-state.js";

afterEach(() => document.body.replaceChildren());

function root() {
  const outer = document.createElement("div"), element = document.createElement("div");
  outer.append(element); document.body.append(outer);
  return { element, outer };
}

function setting(parent: HTMLElement, options: { id?: string; label: string; value?: string; type?: string }) {
  const ownerDocument = parent.ownerDocument;
  const row = ownerDocument.createElement("div"); row.className = "setting-item";
  if (options.id !== undefined) row.dataset.atlSettingsId = options.id;
  const info = ownerDocument.createElement("div"); info.className = "setting-item-info";
  const name = ownerDocument.createElement("div"); name.className = "setting-item-name"; name.textContent = options.label;
  const desc = ownerDocument.createElement("div"); desc.className = "setting-item-description"; desc.textContent = `${options.label} description`;
  info.append(name, desc);
  const control = ownerDocument.createElement("div"); control.className = "setting-item-control";
  const input = ownerDocument.createElement("input"); input.type = options.type ?? "text"; input.value = options.value ?? "";
  control.append(input); row.append(info, control); parent.append(row);
  return { row, input };
}

function disclosure(parent: HTMLElement, id: string, open: boolean, label = id) {
  const details = document.createElement("details"); details.dataset.atlSettingsDisclosure = id; details.open = open;
  const summary = document.createElement("summary"); summary.textContent = label; details.append(summary); parent.append(details);
  return details;
}

function refresh(current: HTMLElement, replacement: HTMLElement, whileRefreshing?: () => void) {
  const state = captureSettingsUi(current);
  try {
    state.reuse(replacement);
    whileRefreshing?.();
    current.replaceChildren(...replacement.childNodes);
    prepareSettingsUi(current);
  } finally { state.restore(); }
}

describe("stable settings identities", () => {
  it.each([false, true])("retains the owner-window editor and selection in a separate DOM realm (edited: %s)", edited => {
    const popout = new Window();
    try {
      const ownerDocument = popout.document as unknown as Document, view = ownerDocument.defaultView!;
      const element = ownerDocument.createElement("div"); ownerDocument.body.append(element);
      const original = setting(element, { id: "setting:apiModel", label: "Model", value: "saved-model" });
      // Happy DOM's distinct windows share DOM constructors. Give the main
      // realm a different brand to reproduce a real Obsidian popout boundary;
      // the owner window's real document, editor and focus behavior stay intact.
      vi.stubGlobal("HTMLElement", class MainWindowHTMLElement {});
      expect(original.input).not.toBeInstanceOf(HTMLElement);
      expect(original.input).toBeInstanceOf(view.HTMLElement);
      const commit = vi.fn(); original.input.addEventListener("blur", commit);
      prepareSettingsUi(element); original.input.focus();
      if (edited) original.input.value = "custom-model";
      original.input.setSelectionRange(2, 7, "backward");
      const next = ownerDocument.createElement("div");
      setting(next, { id: "setting:apiModel", label: "模型", value: "saved-model" });

      refresh(element, next, () => original.input.dispatchEvent(new view.Event("blur")));

      expect(element.querySelector("input")).toBe(original.input);
      expect(ownerDocument.activeElement).toBe(original.input);
      expect(original.input.value).toBe(edited ? "custom-model" : "saved-model");
      expect([original.input.selectionStart, original.input.selectionEnd, original.input.selectionDirection]).toEqual([2, 7, "backward"]);
      expect(commit).not.toHaveBeenCalled();
      original.input.blur(); expect(commit).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); popout.close(); }
  });

  it("retains the original bound row, draft, focus and selection across translated labels and regrouping", () => {
    const { element, outer } = root(), previousGroup = document.createElement("section"); element.append(previousGroup);
    const original = setting(previousGroup, { id: "setting:apiBaseUrl", label: "API endpoint", value: "saved endpoint" });
    const originalBlur = vi.fn(), replacementBlur = vi.fn(); original.input.addEventListener("blur", originalBlur);
    prepareSettingsUi(element); original.input.value = "draft endpoint"; original.input.focus(); original.input.setSelectionRange(2, 8, "backward");
    element.scrollTop = 120; outer.scrollTop = 400;
    const next = document.createElement("div"), group = document.createElement("section"); next.append(group);
    setting(next, { id: "setting:language", label: "界面语言", value: "zh-cn" });
    const replacement = setting(group, { id: "setting:apiBaseUrl", label: "服务地址", value: "server value" });
    replacement.input.addEventListener("blur", replacementBlur);

    refresh(element, next, () => original.input.dispatchEvent(new Event("blur")));

    expect(element.querySelector('[data-atl-settings-id="setting:apiBaseUrl"]')).toBe(original.row);
    expect(original.row.parentElement).toBe(group); expect(original.input.value).toBe("draft endpoint");
    expect(original.row.querySelector(".setting-item-name")?.textContent).toBe("服务地址");
    expect(original.row.querySelector(".setting-item-description")?.textContent).toBe("服务地址 description");
    expect(document.activeElement).toBe(original.input);
    expect([original.input.selectionStart, original.input.selectionEnd, original.input.selectionDirection]).toEqual([2, 8, "backward"]);
    expect([element.scrollTop, outer.scrollTop]).toEqual([120, 400]);
    expect(originalBlur).not.toHaveBeenCalled(); expect(replacementBlur).not.toHaveBeenCalled();
    original.input.blur(); expect(originalBlur).toHaveBeenCalledOnce(); expect(replacementBlur).not.toHaveBeenCalled();
  });

  it("never transfers a credential draft or old binding closure to a different endpoint identity", () => {
    const { element } = root();
    const original = setting(element, { id: "credential:apiKey:endpoint-a", label: "API key", type: "password" });
    const oldCommit = vi.fn(), newCommit = vi.fn(); original.input.addEventListener("blur", oldCommit);
    prepareSettingsUi(element); original.input.value = "private draft for A"; original.input.focus();
    const next = document.createElement("div");
    const replacement = setting(next, { id: "credential:apiKey:endpoint-b", label: "API key", type: "password" });
    replacement.input.addEventListener("blur", newCommit);

    refresh(element, next);

    expect(element.querySelector("input")).toBe(replacement.input); expect(replacement.input.value).toBe("");
    expect(original.row.isConnected).toBe(false); expect(document.activeElement).not.toBe(replacement.input);
    expect(oldCommit).not.toHaveBeenCalled(); expect(newCommit).not.toHaveBeenCalled();
    replacement.input.value = "explicit draft for B"; replacement.input.dispatchEvent(new Event("blur"));
    expect(newCommit).toHaveBeenCalledOnce(); expect(oldCommit).not.toHaveBeenCalled();
  });

  it.each(["old", "new", "both"])("refuses ambiguous explicit IDs in the %s tree instead of matching by order", ambiguous => {
    const { element } = root();
    const original = setting(element, { id: "credential:apiKey:same", label: "First", type: "password" });
    if (ambiguous !== "new") setting(element, { id: "credential:apiKey:same", label: "Second", type: "password" });
    prepareSettingsUi(element); original.input.value = "do not copy"; original.input.focus();
    const next = document.createElement("div"), replacements = [setting(next, { id: "credential:apiKey:same", label: "Renamed", type: "password" })];
    if (ambiguous !== "old") replacements.push(setting(next, { id: "credential:apiKey:same", label: "Another", type: "password" }));

    refresh(element, next);

    expect(original.row.isConnected).toBe(false);
    for (const replacement of replacements) expect(replacement.input.value).toBe("");
    expect(replacements.map(item => item.input)).not.toContain(document.activeElement);
  });

  it("keeps legacy label matching without allowing an explicit identity to collide with it", () => {
    const { element } = root();
    const legacy = setting(element, { label: "API endpoint", value: "saved" });
    const explicit = setting(element, { id: "API endpoint:0", label: "API endpoint", value: "saved" });
    prepareSettingsUi(element); legacy.input.value = "legacy draft"; explicit.input.value = "explicit draft";
    const next = document.createElement("div");
    setting(next, { id: "API endpoint:0", label: "Translated explicit label", value: "new" });
    setting(next, { label: "New conditional field", value: "new" });
    setting(next, { label: "API endpoint", value: "new" });

    refresh(element, next);

    const inputs = Array.from(element.querySelectorAll("input"));
    expect(inputs).toContain(legacy.input); expect(inputs).toContain(explicit.input);
    expect(legacy.input.value).toBe("legacy draft"); expect(explicit.input.value).toBe("explicit draft");
    expect(legacy.input.dataset.atlSettingsControl).not.toBe(explicit.input.dataset.atlSettingsControl);
  });

  it("uses newly rendered values for unedited bound controls instead of copying every old input", () => {
    const { element } = root(); setting(element, { id: "setting:apiModel", label: "Model", value: "previous" });
    prepareSettingsUi(element);
    const next = document.createElement("div"), replacement = setting(next, { id: "setting:apiModel", label: "Model", value: "current" });
    refresh(element, next);
    expect(element.querySelector("input")).toBe(replacement.input); expect(replacement.input.value).toBe("current");
  });

  it("does not restore focus into a page hidden by navigation", () => {
    const { element } = root(), original = setting(element, { id: "setting:apiBaseUrl", label: "Endpoint", value: "saved" });
    prepareSettingsUi(element); original.input.focus(); original.input.value = "draft";
    const state = captureSettingsUi(element), next = document.createElement("div"), page = document.createElement("section");
    page.hidden = true; next.append(page); setting(page, { id: "setting:apiBaseUrl", label: "Endpoint", value: "saved" });
    const navigation = document.createElement("button"); navigation.textContent = "Selected page"; next.append(navigation);
    state.reuse(next); element.replaceChildren(...next.childNodes); prepareSettingsUi(element); navigation.focus();
    const focus = vi.spyOn(original.input, "focus"); state.restore();
    expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(navigation);
    expect(page.querySelector("input")).toBe(original.input); expect(original.input.value).toBe("draft");
  });
});

describe("stable settings disclosures", () => {
  it("does not record forced search expansion and restores the user's state when searching ends", () => {
    const { element } = root(), api = disclosure(element, "api", false), advanced = disclosure(element, "advanced", false);
    prepareSettingsUi(element);
    api.open = true; api.dispatchEvent(new Event("toggle"));
    element.dataset.atlSettingsSearching = "true"; advanced.open = true; prepareSettingsUi(element);
    const next = document.createElement("div"), matchingAdvanced = disclosure(next, "advanced", true), matchingApi = disclosure(next, "api", true);
    refresh(element, next);
    expect(matchingAdvanced.open).toBe(true); expect(matchingApi.open).toBe(true);
    // The real search handler only toggles visibility and calls prepare; no
    // rerender or copying of an input's value is required to restore groups.
    element.dataset.atlSettingsSearching = "false"; prepareSettingsUi(element);
    expect(matchingAdvanced.open).toBe(false); expect(matchingApi.open).toBe(true);
  });

  it("preserves each disclosure's open state across renamed labels, reordered groups and temporary filtering", () => {
    const { element } = root(); disclosure(element, "api", false); disclosure(element, "tools", true); prepareSettingsUi(element);
    const next = document.createElement("div"), tools = disclosure(next, "tools", false, "工具"), api = disclosure(next, "api", true, "API连接");
    refresh(element, next); expect(tools.open).toBe(true); expect(api.open).toBe(false);

    const filtered = document.createElement("div"); disclosure(filtered, "api", true); refresh(element, filtered);
    const unfiltered = document.createElement("div"), restoredTools = disclosure(unfiltered, "tools", false);
    refresh(element, unfiltered); expect(restoredTools.open).toBe(true);
  });

  it("keeps a loose search query and its selection without dispatching edits during refresh", () => {
    const { element } = root(), input = document.createElement("input"); input.type = "search"; input.placeholder = "Search settings";
    element.append(input); disclosure(element, "advanced", false); prepareSettingsUi(element);
    input.value = "DeepSeek"; input.focus(); input.setSelectionRange(1, 5);
    const next = document.createElement("div"), replacement = document.createElement("input");
    replacement.type = "search"; replacement.placeholder = "Search settings";
    const edit = vi.fn(); replacement.addEventListener("input", edit); replacement.addEventListener("change", edit); next.append(replacement);
    disclosure(next, "advanced", true);

    refresh(element, next);

    expect(replacement.value).toBe("DeepSeek"); expect(document.activeElement).toBe(replacement);
    expect([replacement.selectionStart, replacement.selectionEnd]).toEqual([1, 5]);
    expect(edit).not.toHaveBeenCalled(); expect(element.querySelector("details")?.open).toBe(false);
  });

  it("does not apply a remembered state to duplicate disclosure IDs or share states across roots", () => {
    const first = root().element, second = root().element;
    disclosure(first, "advanced", true); disclosure(second, "advanced", false);
    const firstNext = document.createElement("div"), duplicateA = disclosure(firstNext, "advanced", false), duplicateB = disclosure(firstNext, "advanced", false);
    refresh(first, firstNext); expect(duplicateA.open).toBe(false); expect(duplicateB.open).toBe(false);
    const firstAgain = document.createElement("div"), defaultOpen = disclosure(firstAgain, "advanced", true);
    refresh(first, firstAgain); expect(defaultOpen.open).toBe(true);
    const secondNext = document.createElement("div"), independent = disclosure(secondNext, "advanced", true);
    refresh(second, secondNext); expect(independent.open).toBe(false);
  });
});
