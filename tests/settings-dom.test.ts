// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type AnnotationTutorLitePlugin from "../src/main.js";
import type { CredentialStore } from "../src/credential-store.js";

// Only Obsidian's host controls are stubbed. The settings renderer, DOM state
// preservation, event handlers and credential session run unchanged.
vi.mock("obsidian", () => {
  class Text {
    constructor(readonly inputEl: HTMLInputElement | HTMLTextAreaElement) {}
    setValue(value: string) { this.inputEl.value = value; return this; }
    getValue() { return this.inputEl.value; }
    setPlaceholder(value: string) { this.inputEl.placeholder = value; return this; }
    onChange(callback: (value: string) => unknown) { this.inputEl.addEventListener("input", () => { void callback(this.inputEl.value); }); return this; }
  }
  class Dropdown {
    constructor(readonly selectEl: HTMLSelectElement) {}
    addOption(value: string, text: string) { const option = document.createElement("option"); option.value = value; option.textContent = text; this.selectEl.append(option); return this; }
    addOptions(options: Record<string, string>) { for (const [value, text] of Object.entries(options)) this.addOption(value, text); return this; }
    setValue(value: string) { this.selectEl.value = value; return this; }
    onChange(callback: (value: string) => unknown) { this.selectEl.addEventListener("change", () => { void callback(this.selectEl.value); }); return this; }
  }
  class Toggle {
    constructor(readonly toggleEl: HTMLInputElement) { toggleEl.type = "checkbox"; }
    setValue(value: boolean) { this.toggleEl.checked = value; return this; }
    onChange(callback: (value: boolean) => unknown) { this.toggleEl.addEventListener("change", () => { void callback(this.toggleEl.checked); }); return this; }
  }
  class Button {
    constructor(readonly buttonEl: HTMLButtonElement) {}
    setButtonText(value: string) { this.buttonEl.textContent = value; return this; }
    setTooltip(value: string) { this.buttonEl.title = value; return this; }
    setIcon(value: string) { this.buttonEl.dataset.icon = value; return this; }
    setCta() { return this; }
    setDisabled(value: boolean) { this.buttonEl.disabled = value; return this; }
    onClick(callback: () => unknown) { this.buttonEl.addEventListener("click", () => { void callback(); }); return this; }
  }
  class Setting {
    settingEl: HTMLElement; nameEl: HTMLElement; descEl: HTMLElement; controlEl: HTMLElement;
    constructor(container: HTMLElement) {
      this.settingEl = container.createDiv({ cls: "setting-item" });
      const info = this.settingEl.createDiv({ cls: "setting-item-info" });
      this.nameEl = info.createDiv({ cls: "setting-item-name" });
      this.descEl = info.createDiv({ cls: "setting-item-description" });
      this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
    }
    setName(value: string) { this.nameEl.textContent = value; return this; }
    setDesc(value: string) { this.descEl.textContent = value; return this; }
    addText(build: (component: Text) => void) { build(new Text(this.controlEl.createEl("input"))); return this; }
    addTextArea(build: (component: Text) => void) { build(new Text(this.controlEl.createEl("textarea"))); return this; }
    addDropdown(build: (component: Dropdown) => void) { build(new Dropdown(this.controlEl.createEl("select"))); return this; }
    addToggle(build: (component: Toggle) => void) { build(new Toggle(this.controlEl.createEl("input"))); return this; }
    addButton(build: (component: Button) => void) { build(new Button(this.controlEl.createEl("button"))); return this; }
    addExtraButton(build: (component: Button) => void) { return this.addButton(build); }
    addColorPicker(build: (component: Text) => void) { const input = this.controlEl.createEl("input"); input.type = "color"; build(new Text(input)); return this; }
  }
  return {
    Setting,
    ItemView: class { contentEl = document.createElement("div"); constructor(_leaf: unknown) {} },
    PluginSettingTab: class { containerEl = document.createElement("div"); constructor(readonly app: unknown) {} },
    Modal: class {},
    Notice: class { constructor(_text: string) {} },
    setIcon: () => {}, setTooltip: () => {}
  };
});

import { DashboardView } from "../src/views/dashboard-view.js";
import { AnnotationTutorLiteSettingTab } from "../src/settings.js";
import { migrateSettings } from "../src/settings-config.js";
import { CredentialSettingsSession } from "../src/credential-session.js";
import { setLocale, t } from "../src/i18n.js";

beforeEach(() => {
  setLocale("en");
  const create = function(this: HTMLElement, tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string }) {
    const element = document.createElement(tag);
    if (options?.cls) element.className = options.cls;
    if (options?.text) element.textContent = options.text;
    for (const [key, value] of Object.entries(options?.attr ?? {})) element.setAttribute(key, value);
    if (options?.type) element.setAttribute("type", options.type);
    if (options?.value != null) element.setAttribute("value", options.value);
    this.append(element); return element;
  };
  const methods = {
    createEl: create,
    createDiv(this: HTMLElement, options?: { cls?: string; text?: string }) { return create.call(this, "div", options); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, value: string) { this.classList.add(value); },
    setText(this: HTMLElement, value: string) { this.textContent = value; },
    setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
  };
  for (const [name, value] of Object.entries(methods)) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

async function fixture(overrides: Record<string, unknown> = {}) {
  const settings = migrateSettings({ language: "en", ...overrides });
  const write = vi.fn(async (_value: Record<string, unknown>) => {});
  const session = new CredentialSettingsSession(settings, { available: () => false } as unknown as CredentialStore, { write });
  await session.initialize();
  const plugin = {
    settings, manifest: { id: "annotation-tutor-lite", version: "test" },
    librarySnapshot: { annotations: [], cells: [], scenes: [], proposals: [], diagnostics: [] },
    availableApiModels: [] as string[], apiModelsLoaded: true,
    availableModels: [] as Array<{ id: string; name: string }>, modelsLoaded: true,
    allSkins: vi.fn(() => [{ id: "flat", builtin: true, name: "Flat" }]),
    libraryPaths: () => ({ overview: "Overview.md" }),
    persistSettings: vi.fn(async () => { await session.save(); }),
    applyDisplaySettings: vi.fn(), applyHighlightColor: vi.fn(), applyLocale: () => setLocale(settings.language),
    changeMemoryRoot: vi.fn(async (value: string) => { settings.memoryRoot = value; return { ok: true }; }),
    refreshApiModels: vi.fn(async () => {}), refreshAvailableModels: vi.fn(async () => {}),
    boardMcpConnection: () => ({ running: settings.boardMcpEnabled, port: 51257, recentCalls: 0, token: "" }),
    indexTable: { sources: () => [], concepts: () => [], query: vi.fn((_query: unknown) => []) },
    defaultCaptureDir: () => "Clips/Web", webClipperExtensionDir: () => "", listClipperClients: () => [],
    webUsageStats: () => ({ totalPages: 0, pages: [] }),
    officialWebClipperTemplateJson: () => "{}",
    markOfficialTemplateExported: vi.fn(async () => { settings.webOfficialTemplateVersion = "official-v1"; }),
    proposalDiff: vi.fn(async (_proposal: unknown) => "difference"),
  };
  const tab = new AnnotationTutorLiteSettingTab({} as App, plugin as unknown as AnnotationTutorLitePlugin);
  const scroll = document.createElement("div"); scroll.append(tab.containerEl); document.body.append(scroll);
  tab.display();
  return { tab, plugin, session, scroll, write };
}

function row(tab: AnnotationTutorLiteSettingTab, key: string) {
  const result = Array.from(tab.containerEl.querySelectorAll<HTMLElement>(".setting-item"))
    .find(element => element.querySelector(".setting-item-name")?.textContent === t(key));
  if (!result) throw new Error(`Missing setting ${key}`);
  return result;
}
function input(tab: AnnotationTutorLiteSettingTab, key: string) { return row(tab, key).querySelector<HTMLInputElement>("input")!; }
function select(tab: AnnotationTutorLiteSettingTab, key: string) { return row(tab, key).querySelector<HTMLSelectElement>("select")!; }
function draft(element: HTMLInputElement | HTMLTextAreaElement, value: string) { element.value = value; element.dispatchEvent(new Event("input")); }
function change(element: HTMLSelectElement, value: string) { element.value = value; element.dispatchEvent(new Event("change")); }
function toggle(element: HTMLInputElement, value: boolean) { element.checked = value; element.dispatchEvent(new Event("change")); }
function page(tab: AnnotationTutorLiteSettingTab, name: string) {
  Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("[role=tab]")).find(button => button.textContent === t(`settings.tab.${name}`))!.click();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("settings DOM updates", () => {
  it("limits highlight and board mode changes to their dependent rows", async () => {
    const { tab, plugin, scroll } = await fixture({ boardConnectionMode: "inherit" });
    const memory = input(tab, "set.memoryFolder"), apiKey = input(tab, "set.apiKey");
    draft(memory, "Pending folder"); memory.focus(); memory.setSelectionRange(2, 6);
    tab.containerEl.scrollTop = 300; scroll.scrollTop = 620;
    const totalRows = tab.containerEl.querySelectorAll(".setting-item").length;
    const create = vi.spyOn(HTMLElement.prototype, "createDiv");
    const newRows = () => create.mock.calls.filter(([options]) => typeof options === "object" && options?.cls === "setting-item").length;
    change(select(tab, "set.highlightColor"), "custom");
    await vi.waitFor(() => expect(tab.containerEl.querySelector('.atl-highlight-color-fields input[type="color"]')).not.toBeNull());
    expect(newRows()).toBe(2); expect(totalRows).toBeGreaterThan(40);
    create.mockClear();
    change(select(tab, "set.highlightColor"), "theme");
    await vi.waitFor(() => expect(tab.containerEl.querySelector('.atl-highlight-color-fields input[type="color"]')).toBeNull());
    expect(newRows()).toBe(1);
    create.mockClear();
    const mode = select(tab, "board.connectionMode"); change(mode, "custom");
    await vi.waitFor(() => expect(tab.containerEl.querySelector(".atl-board-connection-fields input")).not.toBeNull());
    expect(newRows()).toBe(2);
    create.mockClear(); change(mode, "inherit");
    await vi.waitFor(() => expect(tab.containerEl.querySelector(".atl-board-connection-fields input")).toBeNull());
    expect(newRows()).toBe(0);
    expect(input(tab, "set.memoryFolder")).toBe(memory); expect(input(tab, "set.apiKey")).toBe(apiKey);
    expect(memory.value).toBe("Pending folder"); expect(document.activeElement).toBe(memory);
    expect([memory.selectionStart, memory.selectionEnd]).toEqual([2, 6]);
    expect([tab.containerEl.scrollTop, scroll.scrollTop]).toEqual([300, 620]);
    expect(plugin.changeMemoryRoot).not.toHaveBeenCalled();
    expect(plugin.refreshApiModels).not.toHaveBeenCalled(); expect(plugin.refreshAvailableModels).not.toHaveBeenCalled();
  });

  it("keeps unrelated controls mounted for toggles with no conditional settings", async () => {
    const { tab, plugin } = await fixture();
    const memory = input(tab, "set.memoryFolder"), autoRun = input(tab, "set.autoRunAgent");
    toggle(autoRun, !plugin.settings.autoRunAgent);
    await vi.waitFor(() => expect(plugin.applyDisplaySettings).toHaveBeenCalled());
    expect(input(tab, "set.memoryFolder")).toBe(memory); expect(input(tab, "set.autoRunAgent")).toBe(autoRun);
    page(tab, "feedback");
    const duration = input(tab, "upgrade.dailyMinutes");
    const create = vi.spyOn(HTMLElement.prototype, "createDiv");
    for (const [label, key] of [["upgrade.learningFlowEnabled", "learningFlowEnabled"], ["upgrade.supportCheckinEnabled", "supportCheckinEnabled"], ["upgrade.learningExpertsEnabled", "learningExpertsEnabled"]] as const) {
      const control = input(tab, label), value = !plugin.settings[key];
      const calls = plugin.applyDisplaySettings.mock.calls.length;
      toggle(control, value);
      await vi.waitFor(() => expect(plugin.applyDisplaySettings.mock.calls.length).toBeGreaterThan(calls));
      expect(plugin.settings[key]).toBe(value); expect(input(tab, label)).toBe(control);
      expect(input(tab, "upgrade.dailyMinutes")).toBe(duration);
    }
    expect(create.mock.calls.filter(([options]) => typeof options === "object" && options?.cls === "setting-item")).toHaveLength(0);
  });

  it.each(["custom", "inherit"])("rebinds the board model editor from %s mode without replacing other drafts", async mode => {
    const { tab, plugin } = await fixture({ boardConnectionMode: mode, boardEngine: "api", boardApiModel: "api-model", boardAgentModel: "agent-model" });
    const memory = input(tab, "set.memoryFolder"); draft(memory, "Pending memory folder");
    if (mode === "inherit") {
      change(select(tab, "board.connectionMode"), "custom");
      await vi.waitFor(() => expect(tab.containerEl.querySelector(".atl-board-connection-fields input")).not.toBeNull());
    }
    const api = input(tab, "board.connectionModel"); draft(api, "edited-api-model");
    change(select(tab, "set.boardEngine"), "opencode");
    await vi.waitFor(() => expect(input(tab, "board.connectionModel").value).toBe("agent-model"));
    const agent = input(tab, "board.connectionModel"); expect(agent).not.toBe(api);
    draft(agent, "edited-agent-model");
    change(select(tab, "set.boardEngine"), "api");
    await vi.waitFor(() => expect(input(tab, "board.connectionModel").value).toBe("edited-api-model"));
    expect(plugin.settings.boardAgentModel).toBe("edited-agent-model");
    expect(input(tab, "set.memoryFolder")).toBe(memory); expect(memory.value).toBe("Pending memory folder");
    expect(plugin.changeMemoryRoot).not.toHaveBeenCalled();
  });

  it("keeps an uncommitted editor, focus, caret and ancestor scroll during model/skin refresh", async () => {
    const { tab, plugin, scroll } = await fixture();
    const editor = input(tab, "set.memoryFolder");
    draft(editor, "Uncommitted/Notes"); editor.focus(); editor.setSelectionRange(4, 12, "backward");
    tab.containerEl.scrollTop = 300; scroll.scrollTop = 620;
    plugin.availableApiModels = ["new-api-model"];
    plugin.allSkins.mockReturnValue([{ id: "flat", builtin: true, name: "Flat" }, { id: "new-skin", builtin: false, name: "New skin" }]);
    tab.refresh();
    expect(input(tab, "set.memoryFolder")).toBe(editor);
    expect(editor.value).toBe("Uncommitted/Notes");
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([4, 12, "backward"]);
    expect([tab.containerEl.scrollTop, scroll.scrollTop]).toEqual([300, 620]);
    expect(plugin.changeMemoryRoot).not.toHaveBeenCalled();
    expect(select(tab, "set.apiModel").querySelector('option[value="new-api-model"]')).not.toBeNull();
    expect(select(tab, "set.cardSkin").querySelector('option[value="new-skin"]')).not.toBeNull();
    editor.blur(); await vi.waitFor(() => expect(plugin.changeMemoryRoot).toHaveBeenCalledWith("Uncommitted/Notes"));
  });

  it("retains credential draft listeners and their original endpoint binding", async () => {
    const { tab, plugin } = await fixture();
    let editor = input(tab, "set.apiKey");
    editor.focus(); draft(editor, "pending-key"); tab.refresh();
    expect(input(tab, "set.apiKey")).toBe(editor);
    expect(plugin.settings.apiKey).toBe("");
    editor.blur(); await vi.waitFor(() => expect(plugin.settings.apiKey).toBe("pending-key"));
    editor = input(tab, "set.apiKey"); editor.focus(); draft(editor, "other-endpoint-key");
    plugin.settings.apiBaseUrl = "https://different.example/v1"; tab.refresh();
    expect(input(tab, "set.apiKey")).toBe(editor);
    editor.blur(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(plugin.settings.apiKey).toBe("");
  });

  it("suppresses relocation blur but commits on the next user blur, including after a failed DOM replacement", async () => {
    const { tab, plugin } = await fixture();
    const editor = input(tab, "set.memoryFolder"); editor.focus(); draft(editor, "Pending folder");
    const replace = HTMLElement.prototype.replaceWith;
    vi.spyOn(HTMLElement.prototype, "replaceWith").mockImplementation(function(this: HTMLElement, ...nodes) {
      // Happy DOM does not model every browser's reparent blur. Force the host
      // event before moving a focused retained row to exercise the real guard.
      for (const node of nodes) if (node instanceof HTMLElement && node.contains(document.activeElement)) {
        document.activeElement!.dispatchEvent(new FocusEvent("blur"));
      }
      replace.apply(this, nodes);
    });
    tab.refresh(); expect(plugin.changeMemoryRoot).not.toHaveBeenCalled();
    vi.spyOn(tab.containerEl, "replaceChildren").mockImplementationOnce(() => { throw new Error("host replacement failed"); });
    expect(() => tab.refresh()).toThrow("host replacement failed");
    expect(plugin.changeMemoryRoot).not.toHaveBeenCalled();
    editor.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(plugin.changeMemoryRoot).toHaveBeenCalledWith("Pending folder"));
  });

  it("preserves annotation filters, toolbar identity and connected handlers during snapshot refresh", async () => {
    const { tab, plugin } = await fixture(); page(tab, "annotations");
    const editor = tab.containerEl.querySelector<HTMLInputElement>(".atl-toolbar input")!;
    const status = tab.containerEl.querySelector<HTMLSelectElement>(".atl-toolbar select")!;
    draft(editor, "existing filter"); change(status, "reviewed"); editor.focus();
    tab.refresh();
    const replacement = tab.containerEl.querySelector<HTMLInputElement>(".atl-toolbar input")!;
    expect(replacement).toBe(editor); expect(replacement.value).toBe("existing filter");
    expect(document.activeElement).toBe(replacement);
    expect(plugin.indexTable.query).toHaveBeenLastCalledWith(expect.objectContaining({ text: "existing filter", status: "reviewed" }));
    const body = tab.containerEl.querySelector("table tbody")!;
    draft(replacement, "new filter");
    expect(plugin.indexTable.query).toHaveBeenLastCalledWith(expect.objectContaining({ text: "new filter", status: "reviewed" }));
    expect(tab.containerEl.querySelector("table tbody")).not.toBe(body);
  });

  it("reveals image and MCP fields without rebuilding unrelated settings or model discovery", async () => {
    const { tab, plugin } = await fixture();
    const memory = input(tab, "set.memoryFolder"), remote = input(tab, "board.tutorRemoteUrl");
    const provider = select(tab, "set.image.provider");
    draft(memory, "Still editing");
    change(provider, "disabled");
    await vi.waitFor(() => expect(tab.containerEl.querySelector(".atl-image-profile-fields input")).toBeNull());
    expect(input(tab, "set.memoryFolder")).toBe(memory); expect(select(tab, "set.image.provider")).toBe(provider);
    change(provider, "qwen-compatible");
    await vi.waitFor(() => expect(input(tab, "set.image.model")).toBeTruthy());
    const model = input(tab, "set.image.model");
    toggle(input(tab, "set.image.useSharedKey"), true);
    await vi.waitFor(() => expect(tab.containerEl.querySelector(".atl-image-key-fields input")).toBeNull());
    toggle(input(tab, "set.image.promptExtend"), true);
    await vi.waitFor(() => expect(select(tab, "set.image.promptExtendMode")).toBeTruthy());
    expect(input(tab, "set.image.model")).toBe(model);
    const enabled = input(tab, "set.boardMcp.enabled"); toggle(enabled, true);
    await vi.waitFor(() => expect(input(tab, "set.boardMcp.readOnly")).toBeTruthy());
    toggle(input(tab, "set.boardMcp.readOnly"), false);
    await vi.waitFor(() => expect(plugin.settings.boardMcpReadOnly).toBe(false));
    expect(input(tab, "set.boardMcp.enabled")).toBe(enabled);
    expect(input(tab, "board.tutorRemoteUrl")).toBe(remote);
    expect(input(tab, "set.memoryFolder")).toBe(memory); expect(memory.value).toBe("Still editing");
    expect(plugin.refreshApiModels).not.toHaveBeenCalled(); expect(plugin.refreshAvailableModels).not.toHaveBeenCalled();
  });

  it("toggles and exports the official Clipper locally while retaining the capture/template editors", async () => {
    const { tab, plugin } = await fixture({ webEnabled: true }); page(tab, "web");
    const capture = input(tab, "set.web.captureDir");
    const template = row(tab, "set.web.template").querySelector<HTMLTextAreaElement>("textarea")!;
    draft(capture, "Uncommitted capture dir"); draft(template, "{{content}} draft");
    const official = input(tab, "set.web.officialEnabled"); toggle(official, false);
    await vi.waitFor(() => expect(tab.containerEl.querySelector(".atl-official-clipper-fields button")).toBeNull());
    toggle(official, true);
    await vi.waitFor(() => expect(row(tab, "set.web.officialInstall")).toBeTruthy());
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    Array.from(row(tab, "set.web.officialInstall").querySelectorAll("button")).find(button => button.textContent === t("set.web.copyOfficialTemplate"))!.click();
    await vi.waitFor(() => expect(row(tab, "set.web.officialInstall").querySelector(".setting-item-description")?.textContent).toBe(t("set.web.officialCurrent")));
    expect(input(tab, "set.web.captureDir")).toBe(capture);
    expect(row(tab, "set.web.template").querySelector("textarea")).toBe(template);
    expect(template.value).toBe("{{content}} draft"); expect(plugin.settings.webPageTemplate).not.toBe(template.value);
  });

  it("does not finish an obsolete proposals render after refresh or navigation", async () => {
    const { tab, plugin } = await fixture();
    const old = deferred<string>(), latest = deferred<string>();
    plugin.librarySnapshot.proposals = [{ id: "P-1", operation: "replace", targetKind: "cell", targetPath: "cell.md" }] as never[];
    plugin.proposalDiff.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    page(tab, "proposals"); const oldPreview = tab.containerEl.querySelector("pre")!;
    tab.refresh(); const latestPreview = tab.containerEl.querySelector("pre")!;
    old.resolve("stale diff"); await new Promise(resolve => setTimeout(resolve, 0));
    expect(oldPreview.textContent).toBe(t("settings.loadingDiff"));
    expect(oldPreview.parentElement?.querySelector("button")).toBeNull();
    page(tab, "web"); latest.resolve("another stale diff"); await new Promise(resolve => setTimeout(resolve, 0));
    expect(latestPreview.textContent).toBe(t("settings.loadingDiff"));
    expect(latestPreview.parentElement?.querySelector("button")).toBeNull();
    expect(tab.containerEl.querySelector(".atl-proposal-card")).toBeNull();
    page(tab, "proposals");
    await vi.waitFor(() => expect(tab.containerEl.querySelector("pre")?.textContent).toBe("difference"));
    expect(tab.containerEl.querySelectorAll(".atl-proposal-card button")).toHaveLength(2);
  });

  it("fully translates the page on explicit language change", async () => {
    const { tab } = await fixture(); const editor = input(tab, "set.memoryFolder");
    draft(editor, "Unsaved locale draft"); change(select(tab, "set.language"), "zh-cn");
    await vi.waitFor(() => expect(input(tab, "set.memoryFolder")).not.toBe(editor));
    expect(row(tab, "set.language").querySelector(".setting-item-name")?.textContent).toBe("语言");
    expect(input(tab, "set.memoryFolder")).not.toBe(editor);
    expect(Array.from(tab.containerEl.querySelectorAll("[role=tab]")).some(button => button.textContent === "General")).toBe(false);
  });
});

describe("bounded settings lists and drafts", () => {
  function records(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `ID-${String(index).padStart(5, "0")}`, concept: index === count - 1 ? "中文目标" : `Concept ${index}`,
      title: index === count - 1 ? "中文目标" : `Scene ${index}`, type: "topic", status: "active", summary: "summary",
      tags: ["shared"], sourceAnnotations: [], sceneIds: [], cells: [], path: `Memory/${index}.md`,
      updatedAt: "2026-10-16T00:00:00Z", createdAt: "2026-10-16T00:00:00Z"
    }));
  }
  async function library(kind: "annotations" | "cells" | "scenes", count: number) {
    const result = await fixture();
    const items = records(count);
    result.plugin.librarySnapshot = { ...result.plugin.librarySnapshot, [kind]: items } as typeof result.plugin.librarySnapshot;
    if (kind === "annotations") {
      const { IndexTable } = await import("../src/index-table.js");
      const annotationRows = items.map(item => ({
        annotationId: item.id, memoryFile: item.path, sourceFile: "Source.md", anchor: "^id", anchorOrigin: "generated",
        selectedText: item.title, status: "reviewed", concepts: [item.concept], relatedMemoryCells: [],
        updatedAt: item.updatedAt, createdAt: item.createdAt
      }));
      const table = new IndexTable(annotationRows as never[]);
      (result.plugin as unknown as { indexTable: typeof table }).indexTable = table;
    }
    page(result.tab, kind);
    return { ...result, items };
  }
  function next(tab: AnnotationTutorLiteSettingTab) { tab.containerEl.querySelector<HTMLButtonElement>(".atl-pagination-next")!.click(); }
  function previous(tab: AnnotationTutorLiteSettingTab) { return tab.containerEl.querySelector<HTMLButtonElement>(".atl-pagination-previous")!; }
  function groups(tab: AnnotationTutorLiteSettingTab, kind: string) {
    return tab.containerEl.querySelectorAll(kind === "annotations" ? "tbody.atl-rec" : "table tbody tr");
  }

  // Count/identity assertions are the performance gate. Large DOM construction
  // gets a bounded CI budget for coverage instrumentation and Windows runners.
  it.each(["annotations", "cells", "scenes"] as const)("renders at most 100 %s record groups from ten thousand and searches the complete list with IME", async kind => {
    const { tab, plugin, scroll } = await library(kind, 10000);
    expect(groups(tab, kind)).toHaveLength(100);
    for (const facet of tab.containerEl.querySelectorAll<HTMLSelectElement>(".atl-toolbar select")) expect(facet.options.length).toBeLessThanOrEqual(102);
    expect(tab.containerEl.querySelector(".atl-pagination-count")!.textContent).toContain("10000");
    next(tab); expect(groups(tab, kind)).toHaveLength(100); expect(previous(tab).disabled).toBe(false);
    const toolbar = tab.containerEl.querySelector(".atl-toolbar")!;
    const search = toolbar.querySelector<HTMLInputElement>("input")!;
    search.focus(); search.setSelectionRange(0, 0); tab.containerEl.scrollTop = 155; scroll.scrollTop = 455;
    search.dispatchEvent(new CompositionEvent("compositionstart")); draft(search, "中文目标");
    expect(groups(tab, kind)).toHaveLength(100);
    tab.refresh();
    expect(tab.containerEl.querySelector(".atl-toolbar")).toBe(toolbar); expect(document.activeElement).toBe(search);
    expect(search.value).toBe("中文目标"); expect([tab.containerEl.scrollTop, scroll.scrollTop]).toEqual([155, 455]);
    search.dispatchEvent(new CompositionEvent("compositionend")); search.dispatchEvent(new Event("input"));
    expect(groups(tab, kind)).toHaveLength(1);
    expect(groups(tab, kind)[0]!.textContent).toContain("ID-09999");
    expect(previous(tab).disabled).toBe(true);
    // Each list retains its own filter/page through tab navigation.
    page(tab, "feedback"); page(tab, kind);
    expect(tab.containerEl.querySelector<HTMLInputElement>(".atl-toolbar input")!.value).toBe("中文目标");
    expect(groups(tab, kind)).toHaveLength(1);
    expect(plugin.persistSettings).not.toHaveBeenCalled();
  }, 20000);

  it("searches and selects the final unique concept without materializing its whole catalog", async () => {
    const { tab, plugin } = await library("annotations", 10000);
    const search = tab.containerEl.querySelector<HTMLInputElement>(".atl-facet-search")!;
    const concept = tab.containerEl.querySelectorAll<HTMLSelectElement>(".atl-toolbar select")[2]!;
    expect(search.getAttribute("aria-label")).toBe(t("list.searchOptions", { label: t("dash.allConcepts") }));
    search.focus(); search.dispatchEvent(new CompositionEvent("compositionstart")); draft(search, "中文目标");
    plugin.librarySnapshot = { ...plugin.librarySnapshot }; tab.refresh();
    expect(tab.containerEl.querySelector(".atl-facet-search")).toBe(search); expect(document.activeElement).toBe(search);
    expect(search.value).toBe("中文目标"); expect(concept.options.length).toBeLessThanOrEqual(102);
    search.dispatchEvent(new CompositionEvent("compositionend"));
    expect(concept.querySelector('option[value="中文目标"]')).not.toBeNull();
    change(concept, "中文目标");
    expect(groups(tab, "annotations")).toHaveLength(1);
    expect(groups(tab, "annotations")[0]!.textContent).toContain("ID-09999");
    // Keep the chosen exact filter when its suggestion search changes.
    draft(search, "Concept 1"); expect(concept.value).toBe("中文目标");
    expect(concept.options.length).toBeLessThanOrEqual(102); expect(groups(tab, "annotations")).toHaveLength(1);
  }, 20000);

  it.each(["annotations", "cells", "scenes"] as const)("clamps %s after the final page is removed or archived", async kind => {
    const { tab, plugin, items } = await library(kind, 101);
    if (kind === "scenes") {
      const status = tab.containerEl.querySelectorAll<HTMLSelectElement>(".atl-toolbar select")[1]!;
      change(status, "active");
    }
    next(tab); expect(groups(tab, kind)).toHaveLength(1);
    if (kind === "annotations") {
      (plugin.indexTable as unknown as { remove: (id: string) => void }).remove(items.at(-1)!.id);
      plugin.librarySnapshot = { ...plugin.librarySnapshot };
    } else if (kind === "scenes") {
      plugin.librarySnapshot = { ...plugin.librarySnapshot, scenes: items.map((item, index) => ({ ...item, status: index === 100 ? "archived" : "active" })) as never[] };
    } else plugin.librarySnapshot = { ...plugin.librarySnapshot, cells: items.slice(0, 100) as never[] };
    const toolbar = tab.containerEl.querySelector(".atl-toolbar"); tab.refresh();
    expect(groups(tab, kind)).toHaveLength(100); expect(previous(tab).disabled).toBe(true);
    expect(tab.containerEl.querySelector(".atl-toolbar")).toBe(toolbar);
  });

  it("retains failed ordinary drafts through background refresh and retries without an input event", async () => {
    const { tab, plugin } = await fixture();
    const model = input(tab, "set.apiModel"); model.focus(); draft(model, "draft-model");
    plugin.persistSettings.mockRejectedValueOnce(new Error("disk busy")); model.blur();
    await vi.waitFor(() => expect(model.getAttribute("aria-invalid")).toBe("true"));
    expect(plugin.settings.apiModel).not.toBe("draft-model"); tab.refresh();
    expect(input(tab, "set.apiModel")).toBe(model); expect(model.value).toBe("draft-model");
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(plugin.settings.apiModel).toBe("draft-model"));
    await vi.waitFor(() => expect(model.hasAttribute("aria-invalid")).toBe(false));
    expect(plugin.persistSettings).toHaveBeenCalledTimes(2);
  });

  it("commits ordinary model, command and numeric fields once, while unchanged blur saves nothing", async () => {
    const { tab, plugin } = await fixture();
    const model = input(tab, "set.apiModel"), command = input(tab, "board.codexCommand");
    model.dispatchEvent(new FocusEvent("blur")); command.dispatchEvent(new FocusEvent("blur"));
    expect(plugin.persistSettings).not.toHaveBeenCalled();
    for (let count = 1; count <= 20; count++) draft(command, "c".repeat(count));
    expect(plugin.persistSettings).not.toHaveBeenCalled();
    command.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); command.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(plugin.persistSettings).toHaveBeenCalledTimes(1));
    expect(plugin.settings.tutorCodexCommand).toBe("c".repeat(20));
    page(tab, "feedback"); const duration = input(tab, "upgrade.dailyMinutes");
    draft(duration, "120"); expect(plugin.persistSettings).toHaveBeenCalledTimes(1);
    duration.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); duration.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(plugin.persistSettings).toHaveBeenCalledTimes(2));
    expect(plugin.settings.learningDailyMinutes).toBe(120);
  });

  it("rejects events from a model control whose engine binding has been replaced", async () => {
    const { tab, plugin } = await fixture({ boardConnectionMode: "custom", boardEngine: "api", boardApiModel: "first" });
    const obsolete = input(tab, "board.connectionModel"); draft(obsolete, "saved-before-switch");
    change(select(tab, "set.boardEngine"), "opencode");
    await vi.waitFor(() => expect(select(tab, "set.boardEngine").value).toBe("opencode"));
    await vi.waitFor(() => expect(input(tab, "board.connectionModel")).not.toBe(obsolete));
    change(select(tab, "set.boardEngine"), "api");
    await vi.waitFor(() => expect(input(tab, "board.connectionModel").value).toBe("saved-before-switch"));
    const calls = plugin.persistSettings.mock.calls.length;
    draft(obsolete, "late-stale-model"); obsolete.dispatchEvent(new FocusEvent("blur")); await Promise.resolve();
    expect(plugin.settings.boardApiModel).toBe("saved-before-switch"); expect(plugin.persistSettings).toHaveBeenCalledTimes(calls);
  });
});


it("applies the new locale before persistence refreshes dependent views", async () => {
  const { tab, plugin } = await fixture();
  const order: string[] = [];
  const apply = plugin.applyLocale;
  plugin.applyLocale = () => { order.push("locale"); apply(); };
  plugin.persistSettings.mockImplementation(async () => { order.push("persist"); expect(t("list.next")).toBe("下一页"); });
  change(select(tab, "set.language"), "zh-cn");
  await vi.waitFor(() => expect(order).toEqual(["locale", "persist"]));
  expect(tab.containerEl.querySelector("h2")!.textContent).toBe(t("settings.title"));
});


it("preserves dashboard paging and filters on snapshot refresh and retranslation", async () => {
  const { plugin } = await fixture();
  const { IndexTable } = await import("../src/index-table.js");
  const records = Array.from({ length: 250 }, (_, index) => ({ annotationId: `ANN-${index}`, memoryFile: `${index}.md`,
    sourceFile: "Source.md", anchor: "^id", selectedText: "Text", status: "reviewed", concepts: ["Shared"],
    relatedMemoryCells: [], updatedAt: "2026-10-16T00:00:00Z", createdAt: "2026-10-16T00:00:00Z" }));
  const table = new IndexTable(records as never[]);
  (plugin as unknown as { indexTable: typeof table }).indexTable = table;
  (plugin as unknown as { maybeShowWebInstallPrompt: () => void }).maybeShowWebInstallPrompt = () => {};
  const dashboard = new DashboardView({} as never, plugin as unknown as AnnotationTutorLitePlugin);
  document.body.append(dashboard.contentEl); await dashboard.onOpen();
  dashboard.contentEl.querySelector<HTMLButtonElement>(".atl-pagination-next")!.click();
  const search = dashboard.contentEl.querySelector<HTMLInputElement>(".atl-toolbar input")!;
  const status = dashboard.contentEl.querySelector<HTMLSelectElement>(".atl-toolbar select")!;
  const first = dashboard.contentEl.querySelector("tbody.atl-rec")!.textContent;
  search.focus(); dashboard.refresh();
  expect(dashboard.contentEl.querySelector(".atl-toolbar input")).toBe(search);
  expect(dashboard.contentEl.querySelector("tbody.atl-rec")!.textContent).toBe(first);
  change(status, "reviewed"); dashboard.contentEl.querySelector<HTMLButtonElement>(".atl-pagination-next")!.click();
  setLocale("zh-cn"); dashboard.refresh();
  expect(dashboard.contentEl.querySelector(".atl-pagination-next")!.textContent).toBe("下一页");
  expect(dashboard.contentEl.querySelector<HTMLSelectElement>(".atl-toolbar select")!.value).toBe("reviewed");
  expect(dashboard.contentEl.querySelector(".atl-pagination-count")!.textContent).toContain("2 / 3");
  await dashboard.onClose(); expect(dashboard.contentEl.children).toHaveLength(0);
});

it("caches tag catalogs for one snapshot and refreshes them on replacement", async () => {
  const { tab, plugin } = await fixture();
  const cells = [{ id: "C-1", concept: "Concept", summary: "Summary", tags: ["old"], sourceAnnotations: [], sceneIds: [],
    type: "understanding", status: "active", path: "cell.md", updatedAt: "2026-10-16" }] as never[];
  plugin.librarySnapshot = { ...plugin.librarySnapshot, cells };
  const scans = vi.spyOn(cells, "flatMap");
  page(tab, "cells"); const initial = scans.mock.calls.length;
  const search = tab.containerEl.querySelector<HTMLInputElement>(".atl-toolbar input")!;
  draft(search, "Concept"); tab.refresh(); tab.refresh();
  expect(scans).toHaveBeenCalledTimes(initial);
  plugin.librarySnapshot = { ...plugin.librarySnapshot, cells: [{ ...(cells[0] as unknown as Record<string, unknown>), tags: ["new"] }] as never[] };
  tab.refresh();
  const tags = tab.containerEl.querySelectorAll<HTMLSelectElement>(".atl-toolbar select")[1]!;
  expect(tags.querySelector('option[value="new"]')).not.toBeNull();
  expect(tags.querySelector('option[value="old"]')).toBeNull();
  expect(tab.containerEl.querySelector(".atl-toolbar input")).toBe(search);
});


describe("ordinary settings transaction ordering", () => {
  it("serializes independent blurs through real credential-backed writes including rollback", async () => {
    const { tab, plugin, write } = await fixture({ apiModel: "oldA", agentModel: "oldB" });
    const payloads: Array<{ apiModel: unknown; agentModel: unknown }> = [];
    write.mockImplementation(async payload => {
      payloads.push({ apiModel: payload.apiModel, agentModel: payload.agentModel });
      if (payloads.length === 1) throw new Error("disk busy");
    });
    const api = input(tab, "set.apiModel"), agent = input(tab, "set.agentModel");
    draft(api, "newA"); draft(agent, "newB");
    api.dispatchEvent(new FocusEvent("blur")); agent.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(payloads).toHaveLength(2));
    await vi.waitFor(() => expect(api.getAttribute("aria-invalid")).toBe("true"));
    expect(payloads).toEqual([{ apiModel: "newA", agentModel: "oldB" }, { apiModel: "oldA", agentModel: "newB" }]);
    expect({ apiModel: plugin.settings.apiModel, agentModel: plugin.settings.agentModel }).toEqual(payloads.at(-1));
    expect(api.value).toBe("newA"); expect(agent.value).toBe("newB");
    api.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(payloads).toHaveLength(3));
    expect(payloads.at(-1)).toEqual({ apiModel: "newA", agentModel: "newB" });
  });

  it("stops a multi-field flush at the first failed real writer and leaves later drafts untouched", async () => {
    const { commitSettingsInputs } = await import("../src/committed-input.js");
    const { tab, plugin, write } = await fixture({ apiModel: "oldA", agentModel: "oldB" });
    write.mockRejectedValueOnce(new Error("disk busy"));
    const api = input(tab, "set.apiModel"), agent = input(tab, "set.agentModel");
    draft(api, "newA"); draft(agent, "newB");
    expect(await commitSettingsInputs(tab.containerEl)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(plugin.settings.apiModel).toBe("oldA"); expect(plugin.settings.agentModel).toBe("oldB");
    expect(api.value).toBe("newA"); expect(agent.value).toBe("newB");
    expect(await commitSettingsInputs(tab.containerEl)).toBe(true);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.at(-1)![0]).toMatchObject({ apiModel: "newA", agentModel: "newB" });
  });

  it("restores the visible board mode when a model draft fails to flush", async () => {
    const { tab, plugin, write } = await fixture({ boardConnectionMode: "custom", boardEngine: "api", boardApiModel: "old" });
    const model = input(tab, "board.connectionModel"), mode = select(tab, "board.connectionMode");
    draft(model, "new"); write.mockRejectedValueOnce(new Error("disk busy")); change(mode, "inherit");
    await vi.waitFor(() => expect(model.getAttribute("aria-invalid")).toBe("true"));
    await vi.waitFor(() => expect(mode.value).toBe("custom"));
    expect(plugin.settings.boardConnectionMode).toBe("custom"); expect(model.value).toBe("new");
    expect(input(tab, "board.connectionModel")).toBe(model);
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(plugin.settings.boardApiModel).toBe("new"));
    await vi.waitFor(() => expect(model.hasAttribute("aria-invalid")).toBe(false));
    change(mode, "inherit"); await vi.waitFor(() => expect(plugin.settings.boardConnectionMode).toBe("inherit"));
  });

  it.each(["engine", "mode"] as const)("restores the previous board %s binding after its own persistence fails", async kind => {
    const { tab, plugin, write } = await fixture({ boardConnectionMode: "custom", boardEngine: "api", boardApiModel: "old" });
    const model = input(tab, "board.connectionModel");
    const route = select(tab, kind === "engine" ? "set.boardEngine" : "board.connectionMode");
    write.mockRejectedValueOnce(new Error("disk busy")); change(route, kind === "engine" ? "opencode" : "inherit");
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(route.value).toBe(kind === "engine" ? "api" : "custom"));
    expect(plugin.settings.boardEngine).toBe("api"); expect(plugin.settings.boardConnectionMode).toBe("custom");
    expect(input(tab, "board.connectionModel")).toBe(model);
    draft(model, "retry-model"); model.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(plugin.settings.boardApiModel).toBe("retry-model"));
    expect(write).toHaveBeenCalledTimes(2);
  });
});
