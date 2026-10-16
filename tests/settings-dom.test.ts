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
    PluginSettingTab: class { containerEl = document.createElement("div"); constructor(readonly app: unknown) {} },
    Modal: class {},
    Notice: class { constructor(_text: string) {} },
    setIcon: () => {}, setTooltip: () => {}
  };
});

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
  const session = new CredentialSettingsSession(settings, { available: () => false } as unknown as CredentialStore, { write: vi.fn(async () => {}) });
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
  return { tab, plugin, session, scroll };
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

  it("restores annotation filters onto the new table and keeps subsequent input connected to it", async () => {
    const { tab, plugin } = await fixture(); page(tab, "annotations");
    const editor = tab.containerEl.querySelector<HTMLInputElement>(".atl-toolbar input")!;
    const status = tab.containerEl.querySelector<HTMLSelectElement>(".atl-toolbar select")!;
    draft(editor, "existing filter"); change(status, "reviewed"); editor.focus();
    tab.refresh();
    const replacement = tab.containerEl.querySelector<HTMLInputElement>(".atl-toolbar input")!;
    expect(replacement).not.toBe(editor); expect(replacement.value).toBe("existing filter");
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
