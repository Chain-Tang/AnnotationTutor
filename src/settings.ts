import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AnnotationTutorLitePlugin from "./main.js";
import { t } from "./i18n.js";
import { isFreeModel } from "./agent-models.js";
import { queryCells, queryScenes } from "./library-query.js";
import type { CellQuery, SceneQuery } from "./library-query.js";
import { calibrateProfileClaims } from "./learning.js";
import { dueCells } from "./srs.js";
import {
  SHORTCUT_COMMAND_IDS,
  SHORTCUT_NAME_KEYS,
  defaultHotkeys,
  formatHotkeys,
  type HotkeyDef,
  type ShortcutCommandId
} from "./hotkeys.js";
import { replaceListOptions } from "./list-select.js";
import { ListPagination, type ListPageState } from "./list-pagination.js";
import { bindCommittedInput, bindSearchInput, commitSettingsInputs } from "./committed-input.js";
import { AnnotationTable, type AnnotationTableState } from "./views/annotation-table.js";
import { ConfirmModal } from "./views/annotation-modal.js";
import { SceneCreateModal } from "./views/scene-modal.js";
import { parseMcpConfig } from "./mcp-config.js";
import { BUILD_ID, BUILD_TIME } from "./build-info.js";
import { credentialBinding, credentialStatusFor } from "./credential-session.js";
import type { CredentialSlot } from "./credential-types.js";
import { captureSettingsUi, prepareSettingsUi } from "./settings-ui-state.js";
import {
  DEFAULT_SETTINGS,
  MIN_AGENT_TIMEOUT_SECONDS,
  MIN_CHAT_LOG_KEEP_SESSIONS,
  MIN_PRETRANSLATE_CHUNK_CHARS,
  agentPermissionPolicies,
  boardImageProviders,
  isBoardImage1KSize,
  type AgentPermissionPolicy,
  type AnnotationTutorLiteSettings,
  type BoardImagePromptExtendMode,
  type BoardImageProviderKind,
  type HighlightStyle,
  type MemoryWriteMode,
  type PluginLanguage,
  type ReviewEngine
} from "./settings-config.js";

export {
  DEFAULT_SETTINGS,
  HIGHLIGHT_LABELS,
  highlightStyles,
  migrateSettings,
  normalizeMemoryRoot
} from "./settings-config.js";
export type {
  AnnotationTutorLiteSettings,
  HighlightStyle,
  MemoryWriteMode
} from "./settings-config.js";

type SettingsPage =
  | "general"
  | "annotations"
  | "cells"
  | "scenes"
  | "feedback"
  | "profile"
  | "proposals"
  | "web";

const PAGES: SettingsPage[] = [
  "general",
  "annotations",
  "cells",
  "scenes",
  "feedback",
  "profile",
  "proposals",
  "web"
];

export class AnnotationTutorLiteSettingTab extends PluginSettingTab {
  private activePage: SettingsPage = "general";
  private cellQuery: CellQuery = {};
  private sceneQuery: SceneQuery = {};
  private renderGeneration = 0;
  private boardBindingGeneration = 0;
  private ordinarySettingsQueue: Promise<void> = Promise.resolve();
  private readonly cellPage: ListPageState = { page: 0 };
  private readonly scenePage: ListPageState = { page: 0 };
  private readonly annotationState: AnnotationTableState = { filter: {}, pagination: { page: 0 } };
  private listRefresh: { page: SettingsPage; update: () => void } | undefined;
  private tagsSnapshot: unknown;
  private cachedTags = { cells: [] as string[], scenes: [] as string[] };
  private readonly tagVersions = new WeakMap<HTMLSelectElement, unknown>();

  public constructor(
    app: App,
    private readonly plugin: AnnotationTutorLitePlugin
  ) {
    super(app, plugin);
  }

  public refresh(): void {
    if (!this.containerEl.isConnected) return;
    if (this.listRefresh?.page === this.activePage) this.listRefresh.update();
    else this.render(true);
  }

  public override display(): void {
    this.render(false);
  }

  private render(preserveEditing: boolean): void {
    const { containerEl } = this;
    const state = preserveEditing ? captureSettingsUi(containerEl) : null;
    const generation = ++this.renderGeneration;
    this.listRefresh = undefined;
    const content = containerEl.ownerDocument.createElement("div");
    containerEl.addClass("atl-settings");
    content.createEl("h2", { text: t("settings.title") });
    const tabs = content.createDiv({
      cls: "atl-settings-tabs",
      attr: { role: "tablist" }
    });
    for (const page of PAGES) {
      const button = tabs.createEl("button", {
        text: t(`settings.tab.${page}`),
        cls:
          page === this.activePage
            ? "atl-settings-tab is-active"
            : "atl-settings-tab"
      });
      button.setAttr("role", "tab");
      button.setAttr("aria-selected", String(page === this.activePage));
      button.onclick = () => {
        this.activePage = page;
        this.display();
      };
    }
    const body = content.createDiv({ cls: "atl-settings-body" });
    if (this.activePage === "general") this.renderGeneral(body);
    if (this.activePage === "annotations") this.renderAnnotations(body);
    if (this.activePage === "cells") this.renderCells(body);
    if (this.activePage === "scenes") this.renderScenes(body);
    if (this.activePage === "feedback") this.renderFeedback(body);
    if (this.activePage === "profile") this.renderProfile(body);
    if (this.activePage === "proposals") void this.renderProposals(body, generation);
    if (this.activePage === "web") this.renderWeb(body);
    try {
      state?.reuse(content);
      containerEl.replaceChildren(...content.childNodes);
      prepareSettingsUi(containerEl);

    } finally { state?.restore(); }
  }

  private updateSection(container: HTMLElement, render: (content: HTMLElement) => void, reuseEditors = true): void {
    if (!this.containerEl.contains(container)) return;
    const state = captureSettingsUi(container);
    const content = container.ownerDocument.createElement("div");
    render(content);
    try {
      if (reuseEditors) state.reuse(content);
      container.replaceChildren(...content.childNodes);
      prepareSettingsUi(this.containerEl);
    } finally { state.restore(); }
  }

  private renderGeneral(container: HTMLElement): void {
    const snapshot = this.plugin.librarySnapshot;
    new Setting(container)
      .setName(`Annotation Tutor Lite ${this.plugin.manifest.version}`)
      .setDesc(`Build ${BUILD_ID} · ${BUILD_TIME}`);
    const credentials=credentialStatusFor(this.plugin.settings);
    if(credentials)new Setting(container).setName(t("set.credentialStorage")).setDesc(
      credentials.state==="migration-pending" ? t("set.credentialMigrationPending")
      : credentials.state==="reference-unavailable" ? t("set.credentialReferenceUnavailable")
      : credentials.state==="save-failed" ? t("set.credentialSaveFailed")
      : credentials.state==="session-only" ? t("set.credentialSessionOnly")
      : credentials.storage==="available" ? t("set.credentialEncrypted")
      : t("set.credentialStorageUnavailable")
    );
    new Setting(container)
      .setName(t("set.language"))
      .setDesc(t("set.languageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            auto: t("lang.auto"),
            en: t("lang.en"),
            "zh-cn": t("lang.zh-cn"),
            "zh-tw": t("lang.zh-tw"),
            ja: t("lang.ja")
          })
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as PluginLanguage;
            this.plugin.applyLocale();
            await this.plugin.persistSettings();
            this.display();
          })
      );

    new Setting(container)
      .setName(t("set.memoryFolder"))
      .setDesc(t("set.memoryFolderDesc"))
      .addText((text) => {
        text.setPlaceholder("Agent Memory").setValue(this.plugin.settings.memoryRoot);
        bindCommittedInput(text.inputEl, {
          read: () => this.plugin.settings.memoryRoot, parse: value => value.trim(),
          save: value => this.queueOrdinarySettings(async () => {
            if (value === this.plugin.settings.memoryRoot) return;
            const result = await this.plugin.changeMemoryRoot(value);
            if (!result.ok) throw new Error(result.message);
          }),
          onError: error => { new Notice(error instanceof Error ? error.message : t("notice.settingsSaveFailed")); }
        });
      });

    new Setting(container)
      .setName(t("set.writeMode"))
      .setDesc(t("set.writeModeDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            direct: t("set.writeMode.direct"),
            confirmation: t("set.writeMode.confirmation")
          })
          .setValue(this.plugin.settings.memoryWriteMode)
          .onChange(async (value) => {
            this.plugin.settings.memoryWriteMode = value as MemoryWriteMode;
            await this.plugin.persistSettings();
            this.plugin.applyDisplaySettings();
          })
      );

    this.addToggle(
      container,
      "set.allowPreferences",
      "allowPreferenceWrites"
    );
    this.addToggle(
      container,
      "set.injectSceneContext",
      "injectSceneContext"
    );
    new Setting(container)
      .setName(t("set.highlight"))
      .setDesc(t("set.highlightDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "dotted-underline": t("hl.dotted"),
            "wavy-underline": t("hl.wavy"),
            background: t("hl.bg"),
            bold: t("hl.bold"),
            none: t("hl.none")
          })
          .setValue(this.plugin.settings.highlightStyle)
          .onChange(async (value) => {
            this.plugin.settings.highlightStyle = value as HighlightStyle;
            await this.plugin.persistSettings();
            this.plugin.applyDisplaySettings();
          })
      );
    this.renderHighlightColor(container.createDiv({ cls: "atl-highlight-color-fields" }));
    this.addToggle(container, "set.showMarker", "showMarker");
    this.addToggle(container, "set.marginComments", "marginComments");
    new Setting(container)
      .setName(t("set.cardSkin"))
      .setDesc(t("set.cardSkinDesc"))
      .addDropdown((dropdown) => {
        for (const skin of this.plugin.allSkins()) {
          dropdown.addOption(
            skin.id,
            skin.builtin ? t(`skin.${skin.id}`) : skin.name
          );
        }
        dropdown
          .setValue(this.plugin.settings.cardSkin)
          .onChange(async (value) => {
            this.plugin.settings.cardSkin = value;
            await this.plugin.persistSettings();
            this.plugin.applySkinCss();
            this.plugin.applyDisplaySettings();
          });
      });
    this.renderSkinTools(container);
    this.addToggle(container, "set.marginHideLink", "marginHideLink");
    this.addToggle(container, "set.inlineReview", "inlineReview");
    this.addToggle(container, "set.watch", "watchMemoryFiles");
    this.addToggle(container, "set.autoRefresh", "autoRefreshOnAgentWrite");
    this.addToggle(container, "set.useBlockAnchors", "useBlockAnchors");
    this.addToggle(
      container,
      "set.createAgentInstructions",
      "createAgentInstructions"
    );

    this.addText(
      container,
      "set.reviewLanguage",
      "reviewLanguage",
      this.plugin.settings.reviewLanguage,
      t("set.reviewLanguagePlaceholder")
    );

    this.addText(
      container,
      "set.dictionaryLanguage",
      "dictionaryLanguage",
      this.plugin.settings.dictionaryLanguage,
      t("set.dictionaryLanguagePlaceholder")
    );

    this.addToggle(container, "set.pretranslate", "pretranslateOnOpen");

    new Setting(container)
      .setName(t("set.pretranslateChunk"))
      .setDesc(t("set.pretranslateChunkDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.pretranslateChunkChars));
        this.bindSettingInput(text.inputEl, "pretranslateChunkChars", value => {
          const parsed = Number.parseInt(value, 10);
          return Number.isFinite(parsed) && parsed >= MIN_PRETRANSLATE_CHUNK_CHARS ? parsed : DEFAULT_SETTINGS.pretranslateChunkChars;
        });
      });

    this.addToggle(container, "set.excalidrawAssist", "excalidrawAssist");

    this.addToggle(container, "set.persistChatLog", "persistChatLog");

    new Setting(container)
      .setName(t("set.chatLogKeep"))
      .setDesc(t("set.chatLogKeepDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.chatLogKeepSessions));
        this.bindSettingInput(text.inputEl, "chatLogKeepSessions", value => {
          const parsed = Number.parseInt(value, 10);
          return Number.isFinite(parsed) && parsed >= MIN_CHAT_LOG_KEEP_SESSIONS ? parsed : DEFAULT_SETTINGS.chatLogKeepSessions;
        });
      });

    this.renderShortcuts(container);

    this.renderAgentRunner(container);

    const stats = container.createDiv({ cls: "atl-library-stats" });
    stats.createEl("h3", { text: t("settings.libraryStats") });
    stats.createEl("p", {
      text: t("settings.counts", {
        annotations: snapshot.annotations.length,
        cells: snapshot.cells.length,
        scenes: snapshot.scenes.length,
        proposals: snapshot.proposals.length
      })
    });
    const paths = this.plugin.libraryPaths();
    this.actionRow(container, [
      [t("settings.openOverview"), () => this.plugin.openLibraryPath(paths.overview)],
      [t("settings.rebuild"), () => this.plugin.rebuildIndex(true)]
    ]);
    this.renderDiagnostics(container);
  }

  /**
   * Keyboard shortcuts: the commands users most often rebind (annotate,
   * translate, pre-translate), each showing its current binding plus a button
   * that jumps to Obsidian's Hotkeys pane (filtered to this plugin) so it can be
   * changed freely. Obsidian owns the actual binding; we only surface it.
   */
  private renderShortcuts(container: HTMLElement): void {
    container.createEl("h3", { text: t("set.shortcuts") });
    container.createEl("p", { cls: "atl-muted", text: t("set.shortcutsDesc") });
    for (const id of SHORTCUT_COMMAND_IDS) {
      new Setting(container)
        .setName(t(SHORTCUT_NAME_KEYS[id]))
        .setDesc(formatHotkeys(this.currentHotkeys(id)))
        .addButton((button) =>
          button.setButtonText(t("set.shortcutsEdit")).onClick(() =>
            this.openHotkeySettings()
          )
        );
    }
  }

  /** A command's live binding (custom, else default), via Obsidian's hotkey manager. */
  private currentHotkeys(id: ShortcutCommandId): HotkeyDef[] {
    const fullId = `${this.plugin.manifest.id}:${id}`;
    const manager = (
      this.app as unknown as {
        hotkeyManager?: {
          getHotkeys?: (id: string) => HotkeyDef[] | undefined;
          getDefaultHotkeys?: (id: string) => HotkeyDef[] | undefined;
        };
      }
    ).hotkeyManager;
    const custom = manager?.getHotkeys?.(fullId);
    if (custom && custom.length > 0) return custom;
    const def = manager?.getDefaultHotkeys?.(fullId);
    if (def && def.length > 0) return def;
    return defaultHotkeys(id);
  }

  /** Open Obsidian's Hotkeys settings, filtered to this plugin's commands. */
  private openHotkeySettings(): void {
    const setting = (
      this.app as unknown as {
        setting?: {
          open?: () => void;
          openTabById?: (id: string) => { setQuery?: (q: string) => void } | undefined;
        };
      }
    ).setting;
    try {
      setting?.open?.();
      setting?.openTabById?.("hotkeys")?.setQuery?.(t("settings.title"));
    } catch {
      new Notice(t("set.shortcutsOpenFailed"));
    }
  }

  /** Folder buttons under the Card skin picker: open, create starter, reload. */
  private renderSkinTools(container: HTMLElement): void {
    new Setting(container)
      .setName(t("skin.section"))
      .setDesc(t("skin.sectionDesc"))
      .addButton((button) =>
        button
          .setButtonText(t("skin.openFolder"))
          .onClick(() => void this.plugin.openSkinsFolder())
      )
      .addButton((button) =>
        button.setButtonText(t("skin.new")).onClick(async () => {
          const id = await this.plugin.createSkinFromTemplate();
          this.plugin.settings.cardSkin = id;
          await this.plugin.persistSettings();
          this.plugin.applySkinCss();
          this.plugin.applyDisplaySettings();
          new Notice(t("skin.created"));
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText(t("skin.reload")).onClick(async () => {
          await this.plugin.reloadSkins();
          new Notice(t("skin.reloaded"));
          this.display();
        })
      );
  }

  /** Keep the mounted section in handlers when rendering into a temporary fragment. */
  private renderHighlightColor(container: HTMLElement, section = container): void {
    const custom = this.plugin.settings.highlightColor !== "";
    new Setting(container)
      .setName(t("set.highlightColor"))
      .setDesc(t("set.highlightColorDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            theme: t("hlColor.theme"),
            custom: t("hlColor.custom")
          })
          .setValue(custom ? "custom" : "theme")
          .onChange(async (value) => {
            this.plugin.settings.highlightColor =
              value === "custom"
                ? this.plugin.settings.highlightColor || this.themeAccentHex()
                : "";
            await this.plugin.persistSettings();
            this.plugin.applyHighlightColor();
            this.updateSection(section, content => this.renderHighlightColor(content, section));
          })
      );
    if (!custom) return;
    new Setting(container)
      .setName(t("set.highlightCustomColor"))
      .setDesc(t("set.highlightCustomColorDesc"))
      .addColorPicker((picker) =>
        picker
          .setValue(this.plugin.settings.highlightColor || this.themeAccentHex())
          .onChange(async (value) => {
            this.plugin.settings.highlightColor = value;
            await this.plugin.persistSettings();
            // Repaint only the highlight; a full re-render would close the picker.
            this.plugin.applyHighlightColor();
          })
      );
  }

  /**
   * The theme's accent as a `#rrggbb` hex, used to seed the color picker the
   * first time the learner switches to a custom color. Resolves
   * `--interactive-accent` through a hidden probe (the variable itself may be
   * declared as `hsl(...)`, not a literal hex), falling back to the brand purple.
   */
  private themeAccentHex(): string {
    const probe = document.body.createDiv();
    probe.style.color = "var(--interactive-accent)";
    probe.style.display = "none";
    const color = getComputedStyle(probe).color;
    probe.remove();
    const match = /^rgba?\(([^)]+)\)/.exec(color);
    if (match?.[1]) {
      const [r, g, b] = match[1]
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10));
      if (
        r !== undefined &&
        g !== undefined &&
        b !== undefined &&
        Number.isFinite(r) &&
        Number.isFinite(g) &&
        Number.isFinite(b)
      ) {
        const hex = (n: number) => n.toString(16).padStart(2, "0");
        return `#${hex(r)}${hex(g)}${hex(b)}`;
      }
    }
    return "#7c3aed";
  }

  private renderAnnotations(container: HTMLElement): void {
    const paths = this.plugin.libraryPaths();
    this.actionRow(container, [
      [t("settings.openDashboard"), () => this.plugin.openDashboard()],
      [
        t("settings.openMarkdownIndex"),
        () => this.plugin.openLibraryPath(paths.annotationIndex)
      ],
      [t("settings.rebuild"), () => this.plugin.rebuildIndex(true)],
      [t("settings.cleanInbox"), () => this.plugin.cleanInbox()],
      [t("settings.migrate"), () => this.plugin.migrateLegacyAnnotations()]
    ]);
    const table = new AnnotationTable(container.createDiv({ cls: "atl-settings-annotations" }), this.plugin, this.annotationState);
    table.render();
    const diagnostics = container.createDiv();
    const refreshDiagnostics = () => { diagnostics.replaceChildren(); this.renderDiagnostics(diagnostics, "annotation"); };
    refreshDiagnostics();
    this.listRefresh = { page: "annotations", update: () => { table.refresh(); refreshDiagnostics(); } };
  }

  private renderCells(container: HTMLElement): void {
    const paths = this.plugin.libraryPaths();
    this.actionRow(container, [
      [
        t("settings.openMarkdownIndex"),
        () => this.plugin.openLibraryPath(paths.cellIndex)
      ]
    ]);
    const controls = container.createDiv({ cls: "atl-toolbar" });
    this.textFilter(controls, this.cellQuery.text ?? "", (value) => {
      this.cellQuery.text = value;
      this.cellPage.page = 0;
      updateRows();
    });
    this.selectFilter(
      controls,
      ["", "understanding", "misconception", "goal", "difficulty", "strategy", "progress"],
      this.cellQuery.type ?? "",
      t("settings.allTypes"),
      (value) => {
        this.cellQuery.type = value as CellQuery["type"];
        this.cellPage.page = 0;
        updateRows();
      }
    );
    const tags = this.selectFilter(
      controls,
      ["", ...this.tags("cells")],
      this.cellQuery.tag ?? "",
      t("settings.allTags"),
      (value) => {
        this.cellQuery.tag = value || undefined;
        this.cellPage.page = 0;
        updateRows();
      }
    );
    this.selectFilter(
      controls,
      ["", "new", "partially_understood", "stable", "needs_review", "draft", "active", "superseded", "archived"],
      this.cellQuery.status ?? "",
      t("dash.allStatuses"),
      (value) => {
        this.cellQuery.status = value as CellQuery["status"];
        this.cellPage.page = 0;
        updateRows();
      }
    );
    const table = this.table(container, [
      "ID",
      t("dash.col.concept"),
      t("settings.type"),
      t("dash.col.status"),
      t("settings.scenes"),
      t("dash.col.updated")
    ]);
    table.parentElement!.dataset["atlList"] = "cells";
    const pager = new ListPagination(container, this.cellPage, () => updateRows());
    const updateRows = (): void => {
      this.refreshTags(tags, "cells", this.cellQuery.tag);
      table.replaceChildren();
      const rows = queryCells(this.plugin.librarySnapshot.cells, this.cellQuery);
      for (const cell of pager.slice(rows)) {
        const row = table.createEl("tr");
        this.openCell(row, cell.id, cell.path);
        row.createEl("td", { text: cell.concept });
        row.createEl("td", { text: cell.type });
        row.createEl("td", { text: cell.status });
        row.createEl("td", { text: cell.sceneIds.join(", ") || "—" });
        row.createEl("td", { text: date(cell.updatedAt) });
      }
    };
    updateRows();
    const diagnostics = container.createDiv();
    const refreshDiagnostics = () => { diagnostics.replaceChildren(); this.renderDiagnostics(diagnostics, "memory-cell"); };
    refreshDiagnostics();
    this.listRefresh = { page: "cells", update: () => { updateRows(); refreshDiagnostics(); } };
  }

  private renderScenes(container: HTMLElement): void {
    const paths = this.plugin.libraryPaths();
    this.actionRow(container, [
      [
        t("settings.openMarkdownIndex"),
        () => this.plugin.openLibraryPath(paths.sceneIndex)
      ],
      [
        t("scene.create"),
        () => {
          new SceneCreateModal(
            this.app,
            async (input) => (await this.plugin.createScene(input)) !== null
          ).open();
        }
      ]
    ]);
    const controls = container.createDiv({ cls: "atl-toolbar" });
    this.textFilter(controls, this.sceneQuery.text ?? "", (value) => {
      this.sceneQuery.text = value;
      this.scenePage.page = 0;
      updateRows();
    });
    this.selectFilter(
      controls,
      ["", "topic", "course", "document", "project"],
      this.sceneQuery.type ?? "",
      t("settings.allTypes"),
      (value) => {
        this.sceneQuery.type = value as SceneQuery["type"];
        this.scenePage.page = 0;
        updateRows();
      }
    );
    this.selectFilter(
      controls,
      ["", "active", "archived"],
      this.sceneQuery.status ?? "",
      t("dash.allStatuses"),
      (value) => {
        this.sceneQuery.status = value as SceneQuery["status"];
        this.scenePage.page = 0;
        updateRows();
      }
    );
    const tags = this.selectFilter(
      controls,
      ["", ...this.tags("scenes")],
      this.sceneQuery.tag ?? "",
      t("settings.allTags"),
      (value) => {
        this.sceneQuery.tag = value || undefined;
        this.scenePage.page = 0;
        updateRows();
      }
    );
    const table = this.table(container, [
      "ID",
      t("settings.titleColumn"),
      t("settings.type"),
      t("dash.col.status"),
      t("settings.cells"),
      t("settings.sources"),
      t("dash.col.updated"),
      t("settings.actions")
    ]);
    table.parentElement!.dataset["atlList"] = "scenes";
    const pager = new ListPagination(container, this.scenePage, () => updateRows());
    const updateRows = (): void => {
      this.refreshTags(tags, "scenes", this.sceneQuery.tag);
      table.replaceChildren();
      const rows = queryScenes(this.plugin.librarySnapshot.scenes, this.sceneQuery);
      for (const scene of pager.slice(rows)) {
        const row = table.createEl("tr");
        this.openCell(row, scene.id, scene.path);
        row.createEl("td", { text: scene.title });
        row.createEl("td", { text: scene.type });
        row.createEl("td", { text: scene.status });
        row.createEl("td", { text: String(scene.cells.length) });
        row.createEl("td", { text: String(scene.sourceAnnotations.length) });
        row.createEl("td", { text: date(scene.updatedAt) });
        const actions = row.createEl("td");
        if (scene.status === "active") {
          const archive = actions.createEl("button", {
            text: t("settings.archive"),
            cls: "atl-link-button"
          });
          archive.onclick = () => {
            new ConfirmModal(this.app, {
              title: t("settings.archiveSceneTitle"),
              body: t("settings.archiveSceneBody", { title: scene.title }),
              confirmText: t("settings.archive"),
              warning: true,
              onConfirm: () => this.plugin.archiveScene(scene.id)
            }).open();
          };
        } else {
          actions.setText("—");
        }
      }
    };
    updateRows();
    const diagnostics = container.createDiv();
    const refreshDiagnostics = () => { diagnostics.replaceChildren(); this.renderDiagnostics(diagnostics, "scene"); };
    refreshDiagnostics();
    this.listRefresh = { page: "scenes", update: () => { updateRows(); refreshDiagnostics(); } };
  }

  private renderProfile(container: HTMLElement): void {
    const paths = this.plugin.libraryPaths();
    for (const kind of ["learner-profile", "preferences"] as const) {
      const profile = this.plugin.librarySnapshot.profiles.find(
        (item) => item.kind === kind
      );
      const card = container.createDiv({ cls: "atl-profile-card" });
      card.createEl("h3", {
        text:
          kind === "learner-profile"
            ? t("settings.learnerProfile")
            : t("settings.preferences")
      });
      if (kind === "preferences" && !this.plugin.settings.allowPreferenceWrites) {
        card.createEl("p", {
          cls: "atl-muted",
          text: t("settings.preferencesDisabled")
        });
      }
      card.createEl("p", { text: profile?.summary || t("detail.empty") });
      card.createEl("p", {
        cls: "atl-muted",
        text: t("settings.claimCount", {
          count: profile?.claims.length ?? 0
        })
      });
      if (profile) {
        // OLM calibration: flag claims whose evidence cites a concept the SRS now
        // measures as struggling, so the learner can reconcile the discrepancy.
        const calibration =
          kind === "learner-profile"
            ? calibrateProfileClaims(
                profile.claims,
                this.plugin.librarySnapshot.cells
              )
            : [];
        const claims = card.createEl("ul", { cls: "atl-profile-claims" });
        for (const [claimIndex, claim] of profile.claims.entries()) {
          const item = claims.createEl("li");
          item.createSpan({ text: `${claim.statement} ` });
          for (const [index, evidence] of claim.evidence.entries()) {
            const button = item.createEl("button", {
              text: evidence,
              cls: "atl-link-button"
            });
            button.onclick = () =>
              void this.plugin.openLibraryPath(
                evidence.startsWith("SCENE-")
                  ? `${this.plugin.settings.memoryRoot}/scenes/${evidence}.md`
                  : `${this.plugin.settings.memoryRoot}/memory-cells/${evidence}.md`
              );
            if (index < claim.evidence.length - 1) {
              item.createSpan({ text: ", " });
            }
          }
          const remove = item.createEl("button", {
            text: t("settings.deleteClaim"),
            cls: "atl-link-button mod-warning"
          });
          remove.onclick = () => {
            new ConfirmModal(this.app, {
              title: t("settings.deleteClaimTitle"),
              body: t("settings.deleteClaimBody", {
                statement: claim.statement
              }),
              confirmText: t("settings.deleteClaim"),
              warning: true,
              onConfirm: () => this.plugin.deleteProfileClaim(kind, claimIndex)
            }).open();
          };
          const conflict = calibration.find(
            (entry) => entry.claimIndex === claimIndex
          );
          if (conflict) {
            item.createDiv({
              cls: "atl-muted mod-warning",
              text: t("settings.claimConflict", {
                concepts: conflict.strugglingConcepts.join(", ")
              })
            });
          }
        }
      }
      const button = card.createEl("button", { text: t("dash.open") });
      button.onclick = () =>
        void this.plugin.openLibraryPath(
          kind === "learner-profile"
            ? paths.learnerProfile
            : paths.preferences
        );
    }
    this.renderDiagnostics(container, "profile");
  }

  private async renderProposals(container: HTMLElement, generation: number): Promise<void> {
    const proposals = this.plugin.librarySnapshot.proposals;
    if (proposals.length === 0) {
      container.createEl("p", {
        cls: "atl-muted",
        text: t("settings.noProposals")
      });
      this.renderDiagnostics(container, "proposal");
      return;
    }
    for (const proposal of proposals) {
      const card = container.createDiv({ cls: "atl-proposal-card" });
      card.createEl("h3", { text: proposal.id });
      card.createEl("p", {
        text: `${proposal.operation} · ${proposal.targetKind} · ${proposal.targetPath}`
      });
      const preview = card.createEl("pre", {
        cls: "atl-diff",
        text: t("settings.loadingDiff")
      });
      const diff = await this.plugin.proposalDiff(proposal);
      if (generation !== this.renderGeneration || this.activePage !== "proposals" ||
          !container.isConnected || !this.containerEl.contains(container)) return;
      preview.setText(diff);
      const actions = card.createDiv({ cls: "atl-actions" });
      const approve = actions.createEl("button", {
        text: t("settings.approve"),
        cls: "mod-cta"
      });
      approve.onclick = () => void this.plugin.approveProposal(proposal.id);
      const reject = actions.createEl("button", {
        text: t("settings.reject"),
        cls: "mod-warning"
      });
      reject.onclick = () => void this.plugin.rejectProposal(proposal.id);
    }
    this.renderDiagnostics(container, "proposal");
  }

  private renderDiagnostics(
    container: HTMLElement,
    kind?: string
  ): void {
    const diagnostics = this.plugin.librarySnapshot.diagnostics.filter(
      (item) => !kind || item.kind === kind
    );
    if (diagnostics.length === 0) return;
    const section = container.createDiv({ cls: "atl-diagnostics" });
    section.createEl("h3", { text: t("settings.diagnostics") });
    for (const diagnostic of diagnostics) {
      section.createEl("div", {
        text: `${diagnostic.path}: ${diagnostic.message}`
      });
    }
  }

  /** Connection profiles plus independent routing for every AI-powered surface. */
  private renderAgentRunner(container: HTMLElement): void {
    new Setting(container)
      .setName(t("set.autoRunAgent"))
      .setDesc(t("set.autoRunAgentDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoRunAgent)
          .onChange(async (value) => {
            this.plugin.settings.autoRunAgent = value;
            await this.plugin.persistSettings();
            this.plugin.applyDisplaySettings();
          })
      );
    container.createEl("h3", { text: t("set.connections") });
    container.createEl("h4", { text: t("set.connection.api") });
    this.renderApiEngine(container);
    container.createEl("h4", { text: t("set.connection.opencode") });
    this.renderOpenCodeEngine(container);
    container.createEl("h3", { text: t("set.image.section") });
    this.renderImageEngine(container);
    container.createEl("h3", { text: t("set.boardMcp.section") });
    this.renderBoardMcp(container);

    container.createEl("h3", { text: t("set.routes") });
    this.renderEngineRoute(container, "set.chatEngine", "chatEngine");
    this.renderEngineRoute(container, "set.reviewEngine", "reviewEngine");
    new Setting(container).setName(t("board.connectionMode")).setDesc(t("board.connectionModeDesc"))
      .addDropdown(dropdown => dropdown.addOptions({inherit:t("board.connectionInherit"),custom:t("board.connectionCustom")})
        .setValue(this.plugin.settings.boardConnectionMode).onChange(async value => {
          if (!await commitSettingsInputs(boardFields)) { dropdown.setValue(this.plugin.settings.boardConnectionMode); return; }
          try {
            await this.queueOrdinarySettings(async () => {
              const previous = this.plugin.settings.boardConnectionMode, generation = this.boardBindingGeneration;
              const next = value === "custom" ? "custom" : "inherit";
              if (next === previous) return;
              this.boardBindingGeneration++;
              this.plugin.settings.boardConnectionMode = next;
              try { await this.plugin.persistSettings(); }
              catch (error) {
                this.plugin.settings.boardConnectionMode = previous; this.boardBindingGeneration = generation;
                throw error;
              }
              this.updateSection(boardFields, content => this.renderBoardConnectionFields(content, boardFields));
            });
          } catch { dropdown.setValue(this.plugin.settings.boardConnectionMode); new Notice(t("notice.settingsSaveFailed")); }
        }));
    const boardFields = container.createDiv({ cls: "atl-board-connection-fields" });
    this.renderBoardConnectionFields(boardFields);
    this.renderEngineRoute(container, "set.web.engine", "webEngine");

    new Setting(container)
      .setName(t("set.agentTimeout"))
      .setDesc(t("set.agentTimeoutDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.agentTimeoutSeconds));
        this.bindSettingInput(text.inputEl, "agentTimeoutSeconds", value => {
          const parsed = Number.parseInt(value, 10);
          return Number.isFinite(parsed) && parsed >= MIN_AGENT_TIMEOUT_SECONDS ? parsed : DEFAULT_SETTINGS.agentTimeoutSeconds;
        });
      });
  }

  private renderBoardConnectionFields(container: HTMLElement, section = container): void {
    if (this.plugin.settings.boardConnectionMode !== "custom") return;
    this.renderEngineRoute(container, "set.boardEngine", "boardEngine", () => {
      // A different engine selects a different model setting and listener.
      this.updateSection(section, content => this.renderBoardConnectionFields(content, section), false);
    }, () => commitSettingsInputs(section));
    const key = this.plugin.settings.boardEngine === "api" ? "boardApiModel" : "boardAgentModel";
    new Setting(container).setName(t("board.connectionModel")).setDesc(t("board.connectionModelDesc"))
      .addText(text => {
        text.setValue(this.plugin.settings[key]);
        const engine = this.plugin.settings.boardEngine, generation = this.boardBindingGeneration;
        this.bindSettingInput(text.inputEl, key, value => value.trim(), {
          isCurrent: () => generation === this.boardBindingGeneration && this.plugin.settings.boardConnectionMode === "custom" && this.plugin.settings.boardEngine === engine
        });
      });
  }

  private renderEngineRoute(
    container: HTMLElement,
    i18nKey: string,
    key: "chatEngine" | "reviewEngine" | "boardEngine" | "webEngine",
    onChanged?: () => void,
    beforeChanged?: () => Promise<boolean>
  ): void {
    new Setting(container)
      .setName(t(i18nKey))
      .setDesc(t(`${i18nKey}Desc`))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ api: t("set.engine.api"), opencode: t("set.engine.opencode") })
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            if (beforeChanged && !await beforeChanged()) { dropdown.setValue(this.plugin.settings[key]); return; }
            try {
              await this.queueOrdinarySettings(async () => {
                const previous = this.plugin.settings[key], generation = this.boardBindingGeneration;
                if (value === previous) return;
                if (key === "boardEngine") this.boardBindingGeneration++;
                this.plugin.settings[key] = value as ReviewEngine;
                try { await this.plugin.persistSettings(); }
                catch (error) {
                  this.plugin.settings[key] = previous; this.boardBindingGeneration = generation;
                  throw error;
                }
                onChanged?.();
              });
            } catch { dropdown.setValue(this.plugin.settings[key]); new Notice(t("notice.settingsSaveFailed")); }
          })
      );
  }

  /** Direct-API engine fields: base URL, key, model picker, and a test button. */
  private renderApiEngine(container: HTMLElement): void {
    this.addApiText(
      container,
      "set.apiBaseUrl",
      "apiBaseUrl",
      this.plugin.settings.apiBaseUrl,
      "https://api.deepseek.com/v1"
    );
    // On committing a key, fetch the endpoint's models so the picker populates.
    this.addApiText(
      container,
      "set.apiKey",
      "apiKey",
      this.plugin.settings.apiKey,
      "sk-…",
      true,
      () => {
        if (this.plugin.settings.apiKey) {
          void this.plugin.refreshApiModels().then(() => this.refresh());
        }
      }
    );

    // First time the section opens with a key set, discover models in the
    // background, then re-render so the dropdown replaces the text field.
    if (
      this.plugin.settings.apiKey &&
      !this.plugin.apiModelsLoaded &&
      this.plugin.availableApiModels.length === 0
    ) {
      void this.plugin.refreshApiModels().then(() => this.refresh());
    }

    this.addApiModelField(container);

    this.actionRow(container, [
      [
        t("set.refreshModels"),
        () => this.plugin.refreshApiModels().then(() => this.refresh())
      ],
      [t("set.testConnection"), () => this.plugin.testApiConnection()]
    ]);
  }

  /** Frontend-owned image generation profile; independent from chat/review. */
  private renderImageEngine(container: HTMLElement): void {
    new Setting(container)
      .setName(t("set.image.provider"))
      .setDesc(t("set.image.providerDesc"))
      .addDropdown((dropdown) => {
        const options: Record<string, string> = {};
        for (const provider of boardImageProviders) options[provider] = t(`set.image.provider.${provider}`);
        dropdown.addOptions(options).setValue(this.plugin.settings.boardImageProvider).onChange(async (value) => {
          this.plugin.settings.boardImageProvider = value as BoardImageProviderKind;
          await this.plugin.persistSettings();
          this.updateSection(fields, content => this.renderImageFields(content));
        });
      });
    const fields = container.createDiv({ cls: "atl-image-profile-fields" });
    this.renderImageFields(fields);
  }

  private renderImageFields(container: HTMLElement): void {
    if (this.plugin.settings.boardImageProvider === "disabled") return;

    this.addImageText("set.image.baseUrl", "boardImageBaseUrl", "https://…/compatible-mode/v1", container);
    new Setting(container)
      .setName(t("set.image.useSharedKey"))
      .setDesc(t("set.image.useSharedKeyDesc"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.boardImageUseSharedApiKey).onChange(async (value) => {
        this.plugin.settings.boardImageUseSharedApiKey = value;
        await this.plugin.persistSettings();
        this.updateSection(keyFields, content => this.renderImageKey(content));
      }));
    const keyFields = container.createDiv({ cls: "atl-image-key-fields" });
    this.renderImageKey(keyFields);
    this.addImageText("set.image.model", "boardImageModel", "qwen-image-3.0", container);

    let widthInput: HTMLInputElement;
    let heightInput: HTMLInputElement;
    const size = new Setting(container).setName(t("set.image.size")).setDesc(t("set.image.sizeDesc"));
    const bindSize = (input: HTMLInputElement, dimension: 0 | 1): void => {
      bindCommittedInput(input, {
        read: () => JSON.stringify([this.plugin.settings.boardImageWidth, this.plugin.settings.boardImageHeight]),
        parse: () => {
          const width = Number.parseInt(widthInput.value, 10), height = Number.parseInt(heightInput.value, 10);
          if (!isBoardImage1KSize(width, height)) throw new Error(t("set.image.sizeInvalid"));
          return JSON.stringify([width, height]);
        },
        format: value => String((JSON.parse(value) as [number, number])[dimension]),
        save: value => this.queueOrdinarySettings(async () => {
          const previous = [this.plugin.settings.boardImageWidth, this.plugin.settings.boardImageHeight];
          const [width, height] = JSON.parse(value) as [number, number];
          if (previous[0] === width && previous[1] === height) return;
          this.plugin.settings.boardImageWidth = width; this.plugin.settings.boardImageHeight = height;
          try { await this.plugin.persistSettings(); } catch (error) {
            if (this.plugin.settings.boardImageWidth === width && this.plugin.settings.boardImageHeight === height) {
              this.plugin.settings.boardImageWidth = previous[0]!; this.plugin.settings.boardImageHeight = previous[1]!;
            }
            throw error;
          }
        }),
        onError: error => { new Notice(error instanceof Error ? error.message : t("notice.settingsSaveFailed")); }
      });
    };
    size.addText((text) => {
      widthInput = text.inputEl;
      widthInput.type = "number"; widthInput.min = "1"; widthInput.step = "1";
      text.setPlaceholder("1024").setValue(String(this.plugin.settings.boardImageWidth));
      widthInput.setAttribute("aria-label", t("set.image.width"));
      bindSize(widthInput, 0);
    }).addText((text) => {
      heightInput = text.inputEl;
      heightInput.type = "number"; heightInput.min = "1"; heightInput.step = "1";
      text.setPlaceholder("1024").setValue(String(this.plugin.settings.boardImageHeight));
      heightInput.setAttribute("aria-label", t("set.image.height"));
      bindSize(heightInput, 1);
    });

    new Setting(container)
      .setName(t("set.image.count"))
      .setDesc(t("set.image.countDesc"))
      .addDropdown((dropdown) => dropdown
        .addOptions(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1), String(index + 1)])))
        .setValue(String(this.plugin.settings.boardImageCount))
        .onChange(async (value) => {
          this.plugin.settings.boardImageCount = Number(value);
          await this.plugin.persistSettings();
        }));
    new Setting(container)
      .setName(t("set.image.negativePrompt"))
      .setDesc(t("set.image.negativePromptDesc"))
      .addTextArea((area) => {
        area.setValue(this.plugin.settings.boardImageNegativePrompt);
        area.inputEl.rows = 3;
        this.bindSettingInput(area.inputEl, "boardImageNegativePrompt", value => value.trim());
      });
    this.addImageText("set.image.seed", "boardImageSeed", t("set.image.seedPlaceholder"), container);
    new Setting(container)
      .setName(t("set.image.promptExtend"))
      .setDesc(t("set.image.promptExtendDesc"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.boardImagePromptExtend).onChange(async (value) => {
        this.plugin.settings.boardImagePromptExtend = value;
        await this.plugin.persistSettings();
        this.updateSection(promptFields, content => this.renderImagePromptExtension(content));
      }));
    const promptFields = container.createDiv({ cls: "atl-image-prompt-fields" });
    this.renderImagePromptExtension(promptFields);
    new Setting(container)
      .setName(t("set.image.watermark"))
      .setDesc(t("set.image.watermarkDesc"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.boardImageWatermark).onChange(async (value) => {
        this.plugin.settings.boardImageWatermark = value;
        await this.plugin.persistSettings();
      }));
  }

  private renderImageKey(container: HTMLElement): void {
    if (!this.plugin.settings.boardImageUseSharedApiKey) {
      this.addImageText("set.image.apiKey", "boardImageApiKey", "sk-…", container, true);
    }
  }

  private renderImagePromptExtension(container: HTMLElement): void {
    if (this.plugin.settings.boardImagePromptExtend) {
      new Setting(container)
        .setName(t("set.image.promptExtendMode"))
        .setDesc(t("set.image.promptExtendModeDesc"))
        .addDropdown((dropdown) => dropdown
          .addOptions({ direct: t("set.image.promptExtend.direct"), agent: t("set.image.promptExtend.agent") })
          .setValue(this.plugin.settings.boardImagePromptExtendMode)
          .onChange(async (value) => {
            this.plugin.settings.boardImagePromptExtendMode = value as BoardImagePromptExtendMode;
            await this.plugin.persistSettings();
          }));
      new Setting(container)
        .setName(t("set.image.thinking"))
        .setDesc(t("set.image.thinkingDesc"))
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.boardImageThinking).onChange(async (value) => {
          this.plugin.settings.boardImageThinking = value;
          await this.plugin.persistSettings();
        }));
    }
  }

  private renderBoardMcp(container: HTMLElement): void {
    for (const key of ["tutorRemoteName", "tutorRemoteUrl"] as const) new Setting(container)
      .setName(t(`board.${key}`)).setDesc(key === "tutorRemoteUrl" ? t("board.remoteScope") : "")
      .addText(text => { text.setValue(this.plugin.settings[key]); this.bindSettingInput(text.inputEl, key, value => value.trim()); });
    this.addCredentialInput(container,"board.tutorRemoteToken","tutorRemoteToken");
    new Setting(container).setName(t("board.codexCommand")).addText(text => {
      text.setValue(this.plugin.settings.tutorCodexCommand);
      this.bindSettingInput(text.inputEl, "tutorCodexCommand", value => value.trim() || "codex");
    });
    new Setting(container)
      .setName(t("set.boardMcp.enabled"))
      .setDesc(t("set.boardMcp.enabledDesc"))
      .addToggle(toggle => toggle.setValue(this.plugin.settings.boardMcpEnabled).onChange(async value => {
        this.plugin.settings.boardMcpEnabled = value;
        await this.plugin.persistSettings();
        this.updateSection(fields, content => this.renderBoardMcpFields(content));
      }));
    const fields = container.createDiv({ cls: "atl-board-mcp-fields" });
    this.renderBoardMcpFields(fields);
  }

  private renderBoardMcpFields(container: HTMLElement): void {
    if (!this.plugin.settings.boardMcpEnabled) return;
    new Setting(container)
      .setName(t("set.boardMcp.readOnly"))
      .setDesc(t("set.boardMcp.readOnlyDesc"))
      .addToggle(toggle => toggle.setValue(this.plugin.settings.boardMcpReadOnly).onChange(async value => {
        this.plugin.settings.boardMcpReadOnly = value;
        await this.plugin.persistSettings();
        this.updateSection(statusFields, content => this.renderBoardMcpStatus(content));
      }));
    const statusFields = container.createDiv({ cls: "atl-board-mcp-status" });
    this.renderBoardMcpStatus(statusFields);
  }

  private renderBoardMcpStatus(container: HTMLElement): void {
    for (const pairing of this.plugin.settings.tutorPairings) {
      const setting = new Setting(container).setName(pairing.grant.name).setDesc(pairing.grant.documents.join(" · "));
      setting.addButton(button => button.setButtonText(t("board.pairRevoke")).onClick(async () => {
        await this.plugin.revokeTutorClient(pairing.grant.clientId);
        const parent = setting.settingEl.parentElement;
        if (parent) this.updateSection(parent, content => this.renderBoardMcpStatus(content));
      }));
    }
    const connection = this.plugin.boardMcpConnection();
    const status = new Setting(container)
      .setName(t("set.boardMcp.status"))
      .setDesc(connection.running ? `http://127.0.0.1:${connection.port}/mcp · ${connection.recentCalls} calls` : t("set.boardMcp.stopped"));
    if (connection.running && connection.token) status.addButton(button => button
      .setButtonText(t("set.boardMcp.copy"))
      .onClick(async () => {
        await navigator.clipboard.writeText(JSON.stringify({
          url: `http://127.0.0.1:${connection.port}/mcp`,
          headers: { Authorization: `Bearer ${connection.token}` },
        }, null, 2));
        new Notice(t("set.boardMcp.copied"));
      }));
  }

  private addImageText(
    i18nKey: string,
    key: "boardImageBaseUrl" | "boardImageApiKey" | "boardImageModel" | "boardImageSeed",
    placeholder: string,
    container: HTMLElement,
    password = false,
  ): void {
    if(key==="boardImageApiKey") {this.addCredentialInput(container,i18nKey,key);return;}
    new Setting(container).setName(t(i18nKey)).setDesc(t(`${i18nKey}Desc`)).addText((text) => {
      if (password) text.inputEl.type = "password";
      text.setPlaceholder(placeholder).setValue(this.plugin.settings[key]);
      this.bindSettingInput(text.inputEl, key, value => value.trim());
    });
  }

  /**
   * API model picker backed by the endpoint's discovered models. Falls back to a
   * free text field until models are discovered (no key yet, or the endpoint has
   * no `/models`), so the user is never blocked.
   */
  private addApiModelField(container: HTMLElement): void {
    const models = this.plugin.availableApiModels;
    if (models.length === 0) {
      this.addApiText(
        container,
        "set.apiModel",
        "apiModel",
        this.plugin.settings.apiModel,
        "deepseek-chat"
      );
      return;
    }
    const current = this.plugin.settings.apiModel;
    const options: Record<string, string> = {};
    for (const id of models) options[id] = id;
    if (current && !(current in options)) {
      options[current] = `${current} · ${t("set.modelUnavailable")}`;
    }
    new Setting(container)
      .setName(t("set.apiModel"))
      .setDesc(t("set.apiModelDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(options)
          .setValue(current)
          .onChange(async (value) => {
            this.plugin.settings.apiModel = value;
            await this.plugin.persistSettings();
          })
      );
  }

  /** OpenCode CLI engine fields: command, model pickers, refresh/test. */
  private renderOpenCodeEngine(container: HTMLElement): void {
    this.addText(
      container,
      "set.agentCommand",
      "agentCommand",
      this.plugin.settings.agentCommand,
      "opencode"
    );

    // Discover the CLI's models once, in the background, then re-render so the
    // pickers populate. OpenCode's free models change, so we detect them live.
    if (!this.plugin.modelsLoaded && this.plugin.availableModels.length === 0) {
      void this.plugin.refreshAvailableModels().then(() => this.refresh());
    }

    this.addModelDropdown(container, "set.agentModel", "agentModel", false);

    this.actionRow(container, [
      [t("set.setupOpenCode"), () => this.plugin.setupOpenCode()],
      [
        t("set.refreshModels"),
        () => this.plugin.refreshAvailableModels().then(() => this.refresh())
      ],
      [t("set.testConnection"), () => this.plugin.testAgentConnection()]
    ]);

    new Setting(container)
      .setName(t("set.mcpServers"))
      .setDesc(`${t("set.mcpServersDesc")} ${t("set.mcpCredentialProtection")}`)
      .addTextArea((area) => {
        const binding=credentialBinding(this.plugin.settings,"mcpServersJson");
        area.setPlaceholder(
          '{ "mcpServers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } } }'
        );
        area.setValue(this.plugin.settings.mcpServersJson);
        area.inputEl.rows = 6;
        area.inputEl.addClass("atl-mcp-input");
        area.inputEl.addEventListener("blur", () => {
          const value = area.getValue().trim();
          if (value) {
            const parsed = parseMcpConfig(value);
            if (!parsed.ok) {
              // Keep the draft saved so nothing is lost; the chat warns again
              // when the session starts.
              new Notice(t("notice.mcpConfigError", { detail: parsed.error }));
            }
          }
          void this.commitCredential("mcpServersJson",value,binding);
        });
      });

    new Setting(container)
      .setName(t("set.permPolicy"))
      .setDesc(t("set.permPolicyDesc"))
      .addDropdown((dropdown) => {
        const options: Record<string, string> = {};
        for (const policy of agentPermissionPolicies) {
          options[policy] = t(`set.permPolicy.${policy}`);
        }
        dropdown
          .addOptions(options)
          .setValue(this.plugin.settings.agentPermissionPolicy)
          .onChange(async (value) => {
            this.plugin.settings.agentPermissionPolicy =
              value as AgentPermissionPolicy;
            await this.plugin.persistSettings();
          });
      });

    new Setting(container)
      .setName(t("set.alwaysAllowTools"))
      .setDesc(t("set.alwaysAllowToolsDesc"))
      .addText((text) => {
        text
          .setPlaceholder("read, search")
          .setValue(this.plugin.settings.alwaysAllowTools.join(", "));
        this.bindSettingInput(text.inputEl, "alwaysAllowTools", value => value.split(",").map(item => item.trim()).filter(Boolean), {
          format: value => value.join(", ")
        });
      });
  }

  /** A text field bound to one of the API engine's string settings. */
  private addApiText(
    container: HTMLElement,
    i18nKey: string,
    key: "apiBaseUrl" | "apiKey" | "apiModel",
    value: string,
    placeholder: string,
    password = false,
    onCommit?: () => void
  ): void {
    if(key==="apiKey") {this.addCredentialInput(container,i18nKey,key,onCommit);return;}
    new Setting(container)
      .setName(t(i18nKey))
      .setDesc(t(`${i18nKey}Desc`))
      .addText((text) => {
        if (password) text.inputEl.type = "password";
        text.setPlaceholder(placeholder).setValue(value);
        this.bindSettingInput(text.inputEl, key, value => value.trim(), { onCommit });
      });
  }

  private addCredentialInput(container:HTMLElement,label:string,slot:CredentialSlot,onCommit?:()=>void):void {
    let binding=credentialBinding(this.plugin.settings,slot);
    const hasReference=this.plugin.settings.credentialRefs.some(ref=>ref.slot===slot&&ref.binding===binding);
    const setting=new Setting(container).setName(t(label)).setDesc(t("set.credentialInputDesc"));
    setting.addText(text=>{
      text.inputEl.type="password";text.inputEl.autocomplete="new-password";
      text.setValue("").setPlaceholder(this.plugin.settings[slot]||hasReference?t("set.credentialConfigured"):t("set.credentialInput"));
      let edited=false;text.inputEl.addEventListener("input",()=>{edited=true;});
      text.inputEl.addEventListener("focus",()=>{if(!edited)binding=credentialBinding(this.plugin.settings,slot);});
      text.inputEl.addEventListener("blur",()=>{
        if(!edited)return;edited=false;
        const value=text.getValue().trim();text.setValue("");
        // Clearing is a separate explicit operation; an untouched password box
        // must not erase an unresolved or temporarily unavailable reference.
        if(value)void this.commitCredential(slot,value,binding,onCommit);
      });
    });
    if(this.plugin.settings[slot]||hasReference)setting.addButton(button=>button.setButtonText(t("set.credentialClear")).onClick(()=>this.commitCredential(slot,"",binding)));
  }

  private async commitCredential(slot:CredentialSlot,value:string,binding:string,onCommit?:()=>void):Promise<void> {
    if(!credentialStatusFor(this.plugin.settings)){new Notice(t("notice.credentialUninitialized"));return;}
    if(credentialBinding(this.plugin.settings,slot)!==binding){new Notice(t("notice.credentialConnectionChanged"));this.refresh();return;}
    this.plugin.settings[slot]=value;
    try {
      await this.plugin.persistSettings();
      if(credentialStatusFor(this.plugin.settings)?.state==="session-only")new Notice(t("notice.credentialSessionOnly"));
      onCommit?.();this.refresh();
    } catch {new Notice(t("notice.credentialSaveFailed"));}
  }

  /**
   * Model picker backed by the CLI's discovered catalog. Falls back to a free
   * text field when nothing has been discovered yet (CLI unreachable or
   * discovery still running), so the user is never blocked.
   */
  private addModelDropdown(
    container: HTMLElement,
    i18nKey: string,
    key: "agentModel" | "agentFallbackModel",
    includeNone: boolean
  ): void {
    const models = this.plugin.availableModels;
    if (models.length === 0) {
      this.addText(
        container,
        i18nKey,
        key,
        this.plugin.settings[key],
        includeNone ? "" : "opencode/mimo-v2.5-free"
      );
      return;
    }
    const current = this.plugin.settings[key];
    const options: Record<string, string> = {};
    if (includeNone) options[""] = t("set.modelNone");
    for (const id of models) {
      options[id] = isFreeModel(id) ? `${id} · ${t("set.modelFree")}` : id;
    }
    // Keep a configured-but-missing value selectable (e.g. a typo or a model
    // that has since been removed), flagged so it is obvious.
    if (current && !(current in options)) {
      options[current] = `${current} · ${t("set.modelUnavailable")}`;
    }
    new Setting(container)
      .setName(t(i18nKey))
      .setDesc(t(`${i18nKey}Desc`))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(options)
          .setValue(current)
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.persistSettings();
          })
      );
  }

  /** Include assignment and rollback in the queue, not only the disk write. */
  private queueOrdinarySettings(operation: () => Promise<void>): Promise<void> {
    const result = this.ordinarySettingsQueue.then(operation);
    this.ordinarySettingsQueue = result.catch(() => {});
    return result;
  }

  private bindSettingInput<Key extends keyof AnnotationTutorLiteSettings>(
    input: HTMLInputElement | HTMLTextAreaElement,
    key: Key,
    parse: (draft: string) => AnnotationTutorLiteSettings[Key],
    options: {
      format?: (value: AnnotationTutorLiteSettings[Key]) => string;
      isCurrent?: () => boolean; onCommit?: () => void;
      prepare?: () => () => void;
    } = {}
  ): void {
    bindCommittedInput(input, {
      read: () => this.plugin.settings[key], parse, ...options,
      equal: (left, right) => Array.isArray(left) && Array.isArray(right) ? JSON.stringify(left) === JSON.stringify(right) : Object.is(left, right),
      save: value => this.queueOrdinarySettings(async () => {
        if (options.isCurrent?.() === false) throw new Error("settings-binding-changed");
        const previous = this.plugin.settings[key];
        const equal = Array.isArray(previous) && Array.isArray(value) ? JSON.stringify(previous) === JSON.stringify(value) : Object.is(previous, value);
        if (equal) return;
        const rollback = options.prepare?.();
        this.plugin.settings[key] = value;
        try { await this.plugin.persistSettings(); options.onCommit?.(); }
        catch (error) {
          if (this.plugin.settings[key] === value) this.plugin.settings[key] = previous;
          rollback?.();
          throw error;
        }
      }),
      onError: () => { new Notice(t("notice.settingsSaveFailed")); }
    });
  }

  private addText(
    container: HTMLElement,
    i18nKey: string,
    key:
      | "agentCommand"
      | "agentModel"
      | "agentFallbackModel"
      | "reviewLanguage"
      | "dictionaryLanguage",
    value: string,
    placeholder: string
  ): void {
    new Setting(container)
      .setName(t(i18nKey))
      .setDesc(t(`${i18nKey}Desc`))
      .addText((text) => {
        text.setPlaceholder(placeholder).setValue(value);
        this.bindSettingInput(text.inputEl, key, value => value.trim());
      });
  }

  private addToggle(
    container: HTMLElement,
    i18nKey: string,
    key: keyof AnnotationTutorLiteSettings,
    rerender = false
  ): void {
    new Setting(container)
      .setName(t(i18nKey))
      .setDesc(t(`${i18nKey}Desc`))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings[key] as boolean)
          .onChange(async (value) => {
            (this.plugin.settings[key] as boolean) = value;
            await this.plugin.persistSettings();
            this.plugin.applyDisplaySettings();
            if (rerender) this.display();
          })
      );
  }

  private renderFeedback(container: HTMLElement): void {
    this.addToggle(container, "upgrade.learningFlowEnabled", "learningFlowEnabled");
    this.addToggle(container, "upgrade.supportCheckinEnabled", "supportCheckinEnabled");
    this.addToggle(container, "upgrade.learningExpertsEnabled", "learningExpertsEnabled");
    new Setting(container).setName(t("upgrade.supportRetentionDays")).addText(text => {
      text.setValue(String(this.plugin.settings.supportRetentionDays)); text.inputEl.type = "number";
      this.bindSettingInput(text.inputEl, "supportRetentionDays", value => {
        if (!/^\d+$/.test(value)) throw new Error("invalid-retention-days");
        return Math.max(1, Math.min(30, Number(value)));
      });
    });
    new Setting(container).setName(t("upgrade.dailyMinutes")).addText(text => {
      text.setValue(String(this.plugin.settings.learningDailyMinutes)); text.inputEl.type = "number";
      this.bindSettingInput(text.inputEl, "learningDailyMinutes", value => {
        if (!/^\d+$/.test(value)) throw new Error("invalid-daily-minutes");
        return Math.max(5, Math.min(180, Number(value)));
      });
    });
    new Setting(container).setName(t("upgrade.teachingMode")).addDropdown(drop=>{
      for(const mode of ["auto","answer","hint","coach","check"] as const)drop.addOption(mode,t(`upgrade.mode.${mode}`));
      drop.setValue(this.plugin.settings.teachingMode).onChange(async value=>{this.plugin.settings.teachingMode=value as typeof this.plugin.settings.teachingMode;await this.plugin.persistSettings();});
    });
    // Opt-in learning-feedback mechanisms — all OFF by default.
    this.addToggle(container, "set.enableSpacedReview", "enableSpacedReview", true);
    if (this.plugin.settings.enableSpacedReview) {
      const due = dueCells(
        this.plugin.librarySnapshot.cells,
        new Date().toISOString()
      );
      this.actionRow(container, [
        [t("review.start", { count: due.length }), () => this.plugin.review.reviewDueCells()]
      ]);
    }
    this.addToggle(container, "set.enableWeaknessTraining", "enableWeaknessTraining");
    this.addToggle(container, "set.enableLearningSummary", "enableLearningSummary");
    this.addToggle(
      container,
      "set.enableStrengthReinforcement",
      "enableStrengthReinforcement"
    );
    this.addToggle(container, "set.enableStudyPlan", "enableStudyPlan");
  }

  private renderWeb(container: HTMLElement): void {
    container.createEl("h3", { text: t("set.web.shared") });
    this.renderEngineRoute(container, "set.web.engine", "webEngine");
    this.addToggle(container, "set.web.autoAnalyze", "webAutoAnalyze");

    new Setting(container)
      .setName(t("set.web.captureDir"))
      .setDesc(t("set.web.captureDirDesc"))
      .addText((text) => {
        text.setPlaceholder(this.plugin.defaultCaptureDir()).setValue(this.plugin.settings.webCaptureDir);
        this.bindSettingInput(text.inputEl, "webCaptureDir", value => value.trim(), {
          prepare: () => {
            const previous = this.plugin.settings.webOfficialTemplateVersion;
            this.plugin.settings.webOfficialTemplateVersion = "";
            return () => { if (this.plugin.settings.webOfficialTemplateVersion === "") this.plugin.settings.webOfficialTemplateVersion = previous; };
          }
        });
      })
      .addExtraButton((button) => button.setIcon("folder-open").setTooltip(t("set.web.openCaptureDir"))
        .onClick(() => void this.plugin.openWebCaptureDir()));

    container.createEl("h3", { text: t("set.web.official") });
    new Setting(container)
      .setName(t("set.web.officialEnabled"))
      .setDesc(t("set.web.officialEnabledDesc"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.webOfficialIntegrationEnabled)
        .onChange(async (value) => {
          this.plugin.settings.webOfficialIntegrationEnabled = value;
          await this.plugin.persistSettings();
          this.updateSection(officialFields, content => {
            if (this.plugin.settings.webOfficialIntegrationEnabled) this.renderOfficialWebClipper(content);
          });
        }));
    const officialFields = container.createDiv({ cls: "atl-official-clipper-fields" });
    if (this.plugin.settings.webOfficialIntegrationEnabled) this.renderOfficialWebClipper(officialFields);

    container.createEl("h3", { text: t("set.web.advanced") });
    // This switch is intentionally only the legacy localhost bridge. The
    // official integration above remains independent and can coexist with it.
    new Setting(container)
      .setName(t("set.web.enabled"))
      .setDesc(t("set.web.enabledDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.webEnabled)
          .onChange(async (value) => {
            this.plugin.settings.webEnabled = value;
            await this.plugin.persistSettings();
            await this.plugin.applyWebBridge(true);
            this.display();
          })
      );
    this.renderWebInstall(container);
    for(const client of this.plugin.listClipperClients().filter(item=>!item.revokedAt))new Setting(container)
      .setName(client.name).setDesc(`${client.capabilities.join(" / ")} · ${client.targetDirectory}`)
      .addButton(button=>button.setButtonText(t("set.web.revokeConnection")).onClick(async()=>{button.setDisabled(true);try{await this.plugin.revokeClipperClient(client.clientId);this.display();}finally{button.setDisabled(false);}}));
    if (!this.plugin.settings.webEnabled) {
      this.renderWebStats(container);
      return;
    }

    this.addToggle(container, "set.web.autoConvert", "webAutoConvertMarkdown");
    this.addToggle(container, "set.web.saveRendered", "webSaveRenderedHtml");
    this.addToggle(container, "set.web.saveSource", "webSaveSourceHtml");

    new Setting(container)
      .setName(t("set.web.template"))
      .setDesc(t("set.web.templateDesc"))
      .addTextArea((area) => {
        area
          .setPlaceholder("{{content}}\n\n{{highlights}}")
          .setValue(this.plugin.settings.webPageTemplate);
        area.inputEl.rows = 4;
        area.inputEl.style.width = "100%";
        this.bindSettingInput(area.inputEl, "webPageTemplate", value => value);
      });

    this.renderWebStats(container);
  }

  private renderOfficialWebClipper(container: HTMLElement): void {
    const current = this.plugin.settings.webOfficialTemplateVersion === "official-v1";
    const install = new Setting(container)
      .setName(t("set.web.officialInstall"))
      .setDesc(t(current ? "set.web.officialCurrent" : "set.web.officialNeedsImport"))
      .addButton((button) => button.setButtonText(t("set.web.openStore")).setCta()
        .onClick(() => void this.plugin.openOfficialWebClipperStore()))
      .addButton((button) => button.setButtonText(t("set.web.copyOfficialTemplate"))
        .onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.officialWebClipperTemplateJson());
          await this.plugin.markOfficialTemplateExported();
          new Notice(t("notice.webOfficialTemplateCopied"));
          if (this.containerEl.contains(install.settingEl)) install.setDesc(t("set.web.officialCurrent"));
        }))
      .addButton((button) => button.setButtonText(t("set.web.downloadOfficialTemplate"))
        .onClick(async () => {
          const blob = new Blob([this.plugin.officialWebClipperTemplateJson()], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "tutor-web-capture.json";
          anchor.click();
          URL.revokeObjectURL(url);
          await this.plugin.markOfficialTemplateExported();
          if (this.containerEl.contains(install.settingEl)) install.setDesc(t("set.web.officialCurrent"));
        }));
  }

  /** The install-the-extension callout, shown whether or not the bridge is on. */
  private renderWebInstall(container: HTMLElement): void {
    const extDir = this.plugin.webClipperExtensionDir();

    // Header + two one-click helpers: open the bundled folder, and copy the
    // chrome://extensions URL (browsers block window.open on chrome:// pages,
    // so the best we can do is put it on the clipboard for a manual paste).
    new Setting(container)
      .setName(t("set.web.install"))
      .setDesc(t("set.web.installDesc"))
      .addButton((button) =>
        button
          .setButtonText(t("set.web.openFolder"))
          .setCta()
          .setDisabled(!extDir)
          .onClick(async () => {
            if (await this.plugin.openWebClipperExtensionDir()) return;
            new Notice(t("notice.webOpenFolderFailed"));
          })
      )
      .addExtraButton((button) =>
        button
          .setIcon("copy")
          .setTooltip(t("set.web.copyExtUrl"))
          .onClick(async () => {
            await navigator.clipboard.writeText("chrome://extensions");
            new Notice(t("notice.webExtUrlCopied"));
          })
      );

    // Numbered, do-this-then-that steps for loading the folder unpacked.
    const steps = container.createEl("ol", { cls: "atl-web-steps" });
    for (const key of [
      "set.web.step1",
      "set.web.step2",
      "set.web.step3",
      "set.web.step4",
      "set.web.step5"
    ]) {
      steps.createEl("li", { text: t(key) });
    }

    // The resolved folder path + copy button — the manual fallback when the
    // one-click open is blocked; or a "rebuild to bundle it" hint when absent.
    if (extDir) {
      new Setting(container)
        .setName(t("set.web.folderPath"))
        .setDesc(extDir)
        .addExtraButton((button) =>
          button
            .setIcon("copy")
            .setTooltip(t("set.web.copyFolderPath"))
            .onClick(async () => {
              await navigator.clipboard.writeText(extDir);
              new Notice(t("notice.webPathCopied"));
            })
        );
    } else {
      container.createEl("p", {
        text: t("set.web.notBundled"),
        cls: "atl-web-missing"
      });
    }
  }

  /** Read-only usage overview, aggregated from capture notes in the vault. */
  private renderWebStats(container: HTMLElement): void {
    const stats = this.plugin.webUsageStats();
    container.createEl("h3", { text: t("web.stats.title") });
    container.createEl("p", {
      text: t("web.stats.totalPages", { count: stats.totalPages })
    });
    if (stats.pages.length === 0) {
      container.createEl("p", { text: t("web.stats.empty") });
      return;
    }
    const body = this.table(container, [
      t("web.stats.colPage"),
      t("web.stats.colUrl"),
      t("web.stats.colSelections"),
      t("web.stats.colCaptured")
    ]);
    for (const page of stats.pages) {
      const row = body.createEl("tr");
      const stem = page.path.replace(/^.*\//, "").replace(/\.md$/, "");
      this.openCell(row, page.title ?? stem, page.path);
      const urlCell = row.createEl("td");
      if (page.url) {
        const link = urlCell.createEl("a", { text: page.url });
        link.setAttr("href", page.url);
        link.setAttr("target", "_blank");
      }
      row.createEl("td", { text: String(page.selections) });
      row.createEl("td", { text: page.capturedAt?.slice(0, 10) ?? "" });
    }
  }

  private actionRow(
    container: HTMLElement,
    actions: Array<[string, () => void | Promise<void>]>
  ): void {
    const row = container.createDiv({ cls: "atl-actions atl-settings-actions" });
    for (const [label, action] of actions) {
      const button = row.createEl("button", { text: label });
      button.onclick = () => void action();
    }
  }

  private table(container: HTMLElement, headings: string[]): HTMLElement {
    const table = container.createEl("table", { cls: "atl-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const heading of headings) head.createEl("th", { text: heading });
    return table.createEl("tbody");
  }

  private openCell(row: HTMLElement, label: string, path: string): void {
    const button = row.createEl("td").createEl("button", {
      text: label,
      cls: "atl-id-button"
    });
    button.onclick = () => void this.plugin.openLibraryPath(path);
  }

  private textFilter(
    container: HTMLElement,
    value: string,
    onChange: (value: string) => void
  ): void {
    const input = container.createEl("input", { type: "text" });
    input.placeholder = t("dash.search");
    input.value = value;
    bindSearchInput(input, onChange);
  }

  private selectFilter(
    container: HTMLElement,
    values: string[],
    selected: string,
    emptyLabel: string,
    onChange: (value: string) => void
  ): HTMLSelectElement {
    const select = container.createEl("select");
    replaceListOptions(select, values, emptyLabel, selected);
    select.onchange = () => onChange(select.value);
    return select;
  }

  private tags(kind: "cells" | "scenes"): string[] {
    if (this.tagsSnapshot !== this.plugin.librarySnapshot) {
      this.tagsSnapshot = this.plugin.librarySnapshot;
      for (const group of ["cells", "scenes"] as const) this.cachedTags[group] =
        [...new Set(this.plugin.librarySnapshot[group].flatMap(record => record.tags))].sort();
    }
    return this.cachedTags[kind];
  }
  private refreshTags(select: HTMLSelectElement, kind: "cells" | "scenes", selected?: string): void {
    if (this.tagVersions.get(select) === this.plugin.librarySnapshot) return;
    this.tagVersions.set(select, this.plugin.librarySnapshot);
    const values = ["", ...this.tags(kind)];
    if (selected && !values.includes(selected)) values.push(selected);
    replaceListOptions(select, values, t("settings.allTags"), selected);
  }

}

function date(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : value;
}
