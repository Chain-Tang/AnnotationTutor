import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AnnotationTutorLitePlugin from "./main.js";
import { t } from "./i18n.js";
import { isFreeModel } from "./agent-models.js";
import { queryCells, queryScenes } from "./library-query.js";
import type { CellQuery, SceneQuery } from "./library-query.js";
import { dueCells } from "./srs.js";
import { AnnotationTable } from "./views/annotation-table.js";
import {
  DEFAULT_SETTINGS,
  MIN_AGENT_TIMEOUT_SECONDS,
  MIN_PRETRANSLATE_CHUNK_CHARS,
  type AnnotationTutorLiteSettings,
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
  | "proposals";

const PAGES: SettingsPage[] = [
  "general",
  "annotations",
  "cells",
  "scenes",
  "feedback",
  "profile",
  "proposals"
];

export class AnnotationTutorLiteSettingTab extends PluginSettingTab {
  private activePage: SettingsPage = "general";
  private cellQuery: CellQuery = {};
  private sceneQuery: SceneQuery = {};

  public constructor(
    app: App,
    private readonly plugin: AnnotationTutorLitePlugin
  ) {
    super(app, plugin);
  }

  public refresh(): void {
    if (this.containerEl.isConnected) this.display();
  }

  public override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("atl-settings");
    containerEl.createEl("h2", { text: t("settings.title") });
    const tabs = containerEl.createDiv({
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
    const body = containerEl.createDiv({ cls: "atl-settings-body" });
    if (this.activePage === "general") this.renderGeneral(body);
    if (this.activePage === "annotations") this.renderAnnotations(body);
    if (this.activePage === "cells") this.renderCells(body);
    if (this.activePage === "scenes") this.renderScenes(body);
    if (this.activePage === "feedback") this.renderFeedback(body);
    if (this.activePage === "profile") this.renderProfile(body);
    if (this.activePage === "proposals") void this.renderProposals(body);
  }

  private renderGeneral(container: HTMLElement): void {
    const snapshot = this.plugin.librarySnapshot;
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
            await this.plugin.persistSettings();
            this.plugin.applyLocale();
            this.display();
          })
      );

    new Setting(container)
      .setName(t("set.memoryFolder"))
      .setDesc(t("set.memoryFolderDesc"))
      .addText((text) => {
        text.setPlaceholder("Agent Memory").setValue(this.plugin.settings.memoryRoot);
        text.inputEl.addEventListener("blur", () => {
          void this.plugin.changeMemoryRoot(text.getValue()).then((result) => {
            if (!result.ok) {
              new Notice(result.message);
              text.setValue(this.plugin.settings.memoryRoot);
            }
          });
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
    this.addToggle(container, "set.showMarker", "showMarker");
    this.addToggle(container, "set.marginComments", "marginComments");
    this.addToggle(container, "set.marginPaper", "marginPaper");
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
        text.inputEl.addEventListener("blur", () => {
          const parsed = Number.parseInt(text.getValue(), 10);
          const next =
            Number.isFinite(parsed) && parsed >= MIN_PRETRANSLATE_CHUNK_CHARS
              ? parsed
              : DEFAULT_SETTINGS.pretranslateChunkChars;
          this.plugin.settings.pretranslateChunkChars = next;
          text.setValue(String(next));
          void this.plugin.persistSettings();
        });
      });

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
    new AnnotationTable(container.createDiv(), this.plugin).render();
    this.renderDiagnostics(container, "annotation");
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
      this.renderCurrentPage();
    });
    this.selectFilter(
      controls,
      ["", "understanding", "misconception", "goal", "difficulty", "strategy", "progress"],
      this.cellQuery.type ?? "",
      t("settings.allTypes"),
      (value) => {
        this.cellQuery.type = value as CellQuery["type"];
        this.renderCurrentPage();
      }
    );
    this.selectFilter(
      controls,
      [
        "",
        ...new Set(
          this.plugin.librarySnapshot.cells.flatMap((cell) => cell.tags)
        )
      ].sort(),
      this.cellQuery.tag ?? "",
      t("settings.allTags"),
      (value) => {
        this.cellQuery.tag = value || undefined;
        this.renderCurrentPage();
      }
    );
    this.selectFilter(
      controls,
      ["", "new", "partially_understood", "stable", "needs_review", "draft", "active", "superseded", "archived"],
      this.cellQuery.status ?? "",
      t("dash.allStatuses"),
      (value) => {
        this.cellQuery.status = value as CellQuery["status"];
        this.renderCurrentPage();
      }
    );
    const rows = queryCells(this.plugin.librarySnapshot.cells, this.cellQuery);
    const table = this.table(container, [
      "ID",
      t("dash.col.concept"),
      t("settings.type"),
      t("dash.col.status"),
      t("settings.scenes"),
      t("dash.col.updated")
    ]);
    for (const cell of rows) {
      const row = table.createEl("tr");
      this.openCell(row, cell.id, cell.path);
      row.createEl("td", { text: cell.concept });
      row.createEl("td", { text: cell.type });
      row.createEl("td", { text: cell.status });
      row.createEl("td", { text: cell.sceneIds.join(", ") || "—" });
      row.createEl("td", { text: date(cell.updatedAt) });
    }
    this.renderDiagnostics(container, "memory-cell");
  }

  private renderScenes(container: HTMLElement): void {
    const paths = this.plugin.libraryPaths();
    this.actionRow(container, [
      [
        t("settings.openMarkdownIndex"),
        () => this.plugin.openLibraryPath(paths.sceneIndex)
      ]
    ]);
    const controls = container.createDiv({ cls: "atl-toolbar" });
    this.textFilter(controls, this.sceneQuery.text ?? "", (value) => {
      this.sceneQuery.text = value;
      this.renderCurrentPage();
    });
    this.selectFilter(
      controls,
      ["", "topic", "course", "document", "project"],
      this.sceneQuery.type ?? "",
      t("settings.allTypes"),
      (value) => {
        this.sceneQuery.type = value as SceneQuery["type"];
        this.renderCurrentPage();
      }
    );
    this.selectFilter(
      controls,
      ["", "active", "archived"],
      this.sceneQuery.status ?? "",
      t("dash.allStatuses"),
      (value) => {
        this.sceneQuery.status = value as SceneQuery["status"];
        this.renderCurrentPage();
      }
    );
    this.selectFilter(
      controls,
      [
        "",
        ...new Set(
          this.plugin.librarySnapshot.scenes.flatMap((scene) => scene.tags)
        )
      ].sort(),
      this.sceneQuery.tag ?? "",
      t("settings.allTags"),
      (value) => {
        this.sceneQuery.tag = value || undefined;
        this.renderCurrentPage();
      }
    );
    const rows = queryScenes(this.plugin.librarySnapshot.scenes, this.sceneQuery);
    const table = this.table(container, [
      "ID",
      t("settings.titleColumn"),
      t("settings.type"),
      t("dash.col.status"),
      t("settings.cells"),
      t("settings.sources"),
      t("dash.col.updated")
    ]);
    for (const scene of rows) {
      const row = table.createEl("tr");
      this.openCell(row, scene.id, scene.path);
      row.createEl("td", { text: scene.title });
      row.createEl("td", { text: scene.type });
      row.createEl("td", { text: scene.status });
      row.createEl("td", { text: String(scene.cells.length) });
      row.createEl("td", { text: String(scene.sourceAnnotations.length) });
      row.createEl("td", { text: date(scene.updatedAt) });
    }
    this.renderDiagnostics(container, "scene");
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
        const claims = card.createEl("ul", { cls: "atl-profile-claims" });
        for (const claim of profile.claims) {
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

  private async renderProposals(container: HTMLElement): Promise<void> {
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
      preview.setText(await this.plugin.proposalDiff(proposal));
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

  /**
   * Auto-run section: a toggle plus, when enabled, the engine selector, the
   * engine's own fields, and the shared timeout. The toggle/selector re-render
   * the page so the relevant fields appear/hide.
   */
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
            this.display();
          })
      );
    // The engine (OpenCode / Direct API), its key, and the model are always shown:
    // translation (Alt+T), the tutor chat, and manual reviews all need an engine,
    // not just auto-run. Gating these behind auto-run hid them on a fresh install.

    new Setting(container)
      .setName(t("set.reviewEngine"))
      .setDesc(t("set.reviewEngineDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            api: t("set.engine.api"),
            opencode: t("set.engine.opencode")
          })
          .setValue(this.plugin.settings.reviewEngine)
          .onChange(async (value) => {
            this.plugin.settings.reviewEngine = value as ReviewEngine;
            await this.plugin.persistSettings();
            this.display();
          })
      );

    if (this.plugin.settings.reviewEngine === "api") {
      this.renderApiEngine(container);
    } else {
      this.renderOpenCodeEngine(container);
    }

    new Setting(container)
      .setName(t("set.agentTimeout"))
      .setDesc(t("set.agentTimeoutDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.agentTimeoutSeconds));
        text.inputEl.addEventListener("blur", () => {
          const parsed = Number.parseInt(text.getValue(), 10);
          const next =
            Number.isFinite(parsed) && parsed >= MIN_AGENT_TIMEOUT_SECONDS
              ? parsed
              : DEFAULT_SETTINGS.agentTimeoutSeconds;
          this.plugin.settings.agentTimeoutSeconds = next;
          text.setValue(String(next));
          void this.plugin.persistSettings();
        });
      });
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
      [
        t("set.refreshModels"),
        () => this.plugin.refreshAvailableModels().then(() => this.refresh())
      ],
      [t("set.testConnection"), () => this.plugin.testAgentConnection()]
    ]);
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
    new Setting(container)
      .setName(t(i18nKey))
      .setDesc(t(`${i18nKey}Desc`))
      .addText((text) => {
        if (password) text.inputEl.type = "password";
        text.setPlaceholder(placeholder).setValue(value);
        text.inputEl.addEventListener("blur", () => {
          this.plugin.settings[key] = text.getValue().trim();
          void this.plugin.persistSettings().then(() => onCommit?.());
        });
      });
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
        text.inputEl.addEventListener("blur", () => {
          this.plugin.settings[key] = text.getValue().trim();
          void this.plugin.persistSettings();
        });
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
    input.onchange = () => onChange(input.value);
  }

  private selectFilter(
    container: HTMLElement,
    values: string[],
    selected: string,
    emptyLabel: string,
    onChange: (value: string) => void
  ): void {
    const select = container.createEl("select");
    for (const value of values) {
      select.createEl("option", {
        value,
        text: value || emptyLabel
      });
    }
    select.value = selected;
    select.onchange = () => onChange(select.value);
  }

  private renderCurrentPage(): void {
    this.display();
  }
}

function date(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : value;
}
