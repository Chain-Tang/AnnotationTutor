import { mountSupportCheckin } from "../support-panel.js";
import { openSupportDialog } from "../support-modal.js";
import { mountLearningPanel } from "../learning-panel.js";
// The Claudian-style tutor chat: the plugin's right-leaf sidebar. A multi-turn
// conversation with contextual memory that can answer questions about what the
// learner is reading, read the whole note on demand (OpenCode), and jump to a
// specific annotation. The dashboard table now lives in Settings → Annotations.
//
// The plugin-owned TutorConversation keeps history and generation alive while
// this sidebar is hidden or closed. The view renders its stream and retains the
// existing Ask / Plan / Build and editable-note proposal UI.

import {
  ItemView,
  MarkdownRenderer,
  Modal,
  Menu,
  Notice,
  setIcon,
  setTooltip,
  type WorkspaceLeaf
} from "obsidian";
import type AnnotationTutorLitePlugin from "../main.js";
import type { EditTarget } from "../main.js";
import type { ChatLog, ChatLogHead, IndexRecord } from "../model.js";
import { t } from "../i18n.js";
import { classifyIntent } from "../intent.js";
import { localLearnerAuthority } from "../learning-control-v3.js";
import { shouldResolveTutorAction } from "../tutor-intent.js";
import { diffLineClass, lineDiff } from "../line-diff.js";
import { buildEditInstruction, EDIT_START, resolveEdit } from "../edit-parse.js";
import type { ChatContext } from "../chat-prompt.js";
import { tutorRouteForText, type TutorConversationState, type TutorMessage } from "../tutor-conversation.js";
import type {
  AcpCommand,
  AcpStreamEvent
} from "../acp-session.js";
import {
  createFrameBatcher,
  foldStreamSegments,
  type ChatSegment
} from "../chat-stream.js";
import { ConfirmModal } from "./annotation-modal.js";

/** An annotation pinned as the conversation's context (from a margin card). */
type PinnedAnnotation = {
  annotationId: string;
  notePath: string;
  noteTitle: string;
  selection: string;
};

export const CHAT_VIEW_TYPE = "annotation-tutor-lite-chat";

export type ChatMode = "ask" | "plan" | "build";
const MODES: ChatMode[] = ["ask", "plan", "build"];
// Ask is conversational read-only; Plan is OpenCode's read-only planning mode.

export class ChatView extends ItemView {
  private get mode(): ChatMode { return this.plugin.tutorConversation.mode; }
  private set mode(mode: ChatMode) { this.plugin.tutorConversation.mode = mode; }
  private busy = false;
  private stopLearning:(()=>void)|undefined;
  private stopSupport:(()=>void)|undefined;
  private lastSentNotePath = ""; // so we can re-index OpenCode when the note changes
  private pinned: PinnedAnnotation | null = null;
  private selectionContext: ChatContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly sidebarId = `tutor-sidebar-${Math.random().toString(36).slice(2)}`;
  private renderedHistory: readonly TutorMessage[] | null = null;
  private rendered = new Map<string, { el: HTMLElement; status: TutorMessage["status"]; events: number; stream?: ReturnType<ChatView["addStreamingAssistant"]> }>();
  /** Slash commands the live OpenCode session has advertised (empty for API). */
  private get commands(): readonly AcpCommand[] { return this.plugin.tutorConversation.state.commands; }
  /** The saved session this conversation persists into (null until the first turn). */
  private get currentLog(): ChatLog | null { return this.plugin.tutorConversation.log; }
  private set currentLog(log: ChatLog | null) { this.plugin.tutorConversation.log = log; }

  private messagesEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private contextRenderVersion = 0;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private commandPopupEl!: HTMLElement;

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AnnotationTutorLitePlugin
  ) {
    super(leaf);
  }

  public override getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  public override getDisplayText(): string {
    return t("chat.title");
  }

  public override getIcon(): string {
    return "graduation-cap";
  }

  public override async onOpen(): Promise<void> {
    this.render();
    this.unsubscribe = this.plugin.tutorConversation.subscribe(state => this.renderConversation(state));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      void this.renderContext(); this.updateVisibility();
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateVisibility()));
    const win = this.contentEl.ownerDocument.defaultView;
    const Resize = (win as Window & { ResizeObserver?: typeof ResizeObserver } | null)?.ResizeObserver;
    if (Resize) {
      const observer = new Resize(() => this.updateVisibility());
      observer.observe(this.contentEl); this.register(() => observer.disconnect());
    }
    this.updateVisibility();
    void this.restoreLatestSession();
  }

  public override async onClose(): Promise<void> {
    this.stopSupport?.(); this.stopSupport=undefined;
    this.stopLearning?.(); this.stopLearning=undefined;
    this.contextRenderVersion++;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.plugin.tutorConversation.setSidebarVisible(this.sidebarId, false, this.contentEl.ownerDocument);
    this.contentEl.empty();
  }

  private updateVisibility(): void {
    const rect = this.contentEl.getBoundingClientRect();
    const collapsed = this.contentEl.closest(".is-sidedock-collapsed");
    const visible = this.contentEl.isConnected && !collapsed && rect.width > 0 && rect.height > 0;
    this.plugin.tutorConversation.setSidebarVisible(this.sidebarId, visible, this.contentEl.ownerDocument);
  }

  /** Re-read settings-derived chrome (model badge) when settings change. */
  public refresh(): void {
    if (this.contentEl.isConnected) this.render();
  }

  // --- layout ---------------------------------------------------------------

  private render(): void {
    const draft = this.inputEl?.value ?? "";
    this.stopSupport?.();
    this.stopLearning?.();
    this.contentEl.empty();
    this.rendered.clear();
    this.renderedHistory = null;
    const root = this.contentEl.createDiv({ cls: "atl-chat" });

    const header = root.createDiv({ cls: "atl-chat-header" });
    header.createEl("h3", { text: t("chat.title") });
    const badge = header.createEl("button", {
      cls: "atl-chat-badge",
      text: this.engineLabel()
    });
    setTooltip(badge, t("chat.engineTip"));
    badge.onclick = () => void this.toggleEngine();
    const spacer = header.createSpan({ cls: "atl-spacer" });
    spacer.style.flex = "1";
    this.iconButton(header, "plus", t("chat.new"), () => this.newChat());
    const more=this.iconButton(header, "ellipsis", t("upgrade.chatMore"), () => {
      const menu=new Menu();
      menu.addItem(item=>item.setTitle(t("chat.history")).setIcon("history").onClick(()=>void this.showHistory()));
      if(this.plugin.support)menu.addItem(item=>item.setTitle(t("upgrade.supportOpen")).setIcon("message-circle-off").onClick(()=>openSupportDialog(this.app,this.plugin.support!,()=>this.plugin.settings.supportRetentionDays)));
      menu.addSeparator();
      menu.addItem(item=>item.setTitle(t("panel.settings")).setIcon("settings").onClick(()=>this.plugin.openSettings()));
      const rect=more.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.bottom});
    });

    const modeRow = root.createDiv({ cls: "atl-chat-mode" });
    for (const mode of MODES) {
      const button = modeRow.createEl("button", {
        text: t(`chat.mode.${mode}`),
        cls: this.mode === mode ? "atl-chat-mode-btn is-active" : "atl-chat-mode-btn"
      });
      setTooltip(button, t(`chat.mode.${mode}.tip`));
      button.onclick = () => {
        this.mode = mode;
        this.render();
      };
    }

    if(this.plugin.support)this.stopSupport=mountSupportCheckin(root,this.plugin.support,{quiet:()=>this.plugin.supportQuiet(),open:draft=>openSupportDialog(this.app,this.plugin.support!,()=>this.plugin.settings.supportRetentionDays,draft)});
    if(this.plugin.settings.learningFlowEnabled && this.plugin.learningCard){
      this.stopLearning=mountLearningPanel(root,{activity:()=>this.plugin.learningActivity(),card:this.plugin.learningCard,minutes:()=>this.plugin.settings.learningDailyMinutes,
        run:async(action,present,options)=>{
          const selection=this.selectionContext,pinned=this.pinned?{...this.pinned}:undefined;
          const pinnedSource=options?.newRecord&&!selection?.notePath&&pinned?await this.plugin.tutorContext(pinned.notePath,0,1):undefined;
          const source=options?.newRecord?(selection?.notePath?{path:selection.notePath,version:selection.observation!.version}:pinned&&pinnedSource?{path:pinned.notePath,version:pinnedSource.revision,annotationId:pinned.annotationId}:undefined):undefined;
          const sourceBinding=selection?.sourceBinding??pinnedSource?.sourceBinding;
          return this.plugin.runLearningCard(action,present,{...options,...(source?{source}:{}),...(sourceBinding?{sourceBinding}:{})});
        },
        help:async(mode,text)=>{await this.plugin.learningHelp(mode,text);},draw:()=>this.plugin.learningDraw(),explain:answer=>this.plugin.checkLearningExplanation(answer),...(this.plugin.settings.learningExpertsEnabled?{expert:async(kind:import("../learning-experts.js").LearningExpertKind)=>this.plugin.openLearningExpert(kind)}:{})});
    }
    this.messagesEl = root.createDiv({ cls: "atl-chat-messages" });
    if (this.plugin.tutorConversation.state.history.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: "atl-chat-empty" });
      setIcon(empty.createDiv({ cls: "atl-chat-empty-icon" }), "graduation-cap");
      empty.createDiv({ cls: "atl-chat-empty-text", text: t("chat.welcome") });
      // One-tap starters: they send immediately, so the surface never sits
      // blank waiting for the learner to think of a first question.
      const suggest = empty.createDiv({ cls: "atl-chat-suggest" });
      suggest.hidden=!!this.selectionContext;
      const prompts: Array<[string, string]> = [
        ["pen-line", t("chat.suggest.review")],
        ["book-open", t("chat.suggest.summarize")],
        ["network", t("chat.suggest.diagram")]
      ];
      for (const [icon, label] of prompts) {
        const chip = suggest.createEl("button", { cls: "atl-chat-suggest-btn" });
        setIcon(chip.createSpan({ cls: "atl-chat-suggest-icon" }), icon);
        chip.createSpan({ cls: "atl-chat-suggest-label", text: label });
        chip.onclick = () => {
          this.inputEl.value = label;
          void this.send();
        };
      }
    }

    const boardActions = root.createDiv({ cls: "atl-chat-board-actions" });
    for (const [icon, key] of [["circle-help", "chat.board.question"], ["workflow", "chat.board.diagram"], ["smile", "chat.board.expression"]]) {
      const button = boardActions.createEl("button", { cls: "atl-chat-suggest-btn" });
      const explain = !!this.selectionContext && key === "chat.board.question";
      const label = t(explain ? "upgrade.selectionExplain" : key!);
      setIcon(button.createSpan(), icon!); button.createSpan({ text: label });
      setTooltip(button, label);
      button.onclick = () => { this.inputEl.value = label; void this.send(explain ? undefined : "board"); };
    }
    this.contextEl = root.createDiv({ cls: "atl-chat-context" });
    void this.renderContext();

    const inputRow = root.createDiv({ cls: "atl-chat-input-row" });
    // The `/` command popup renders in-flow just above the input row; it is
    // collapsed (hidden) until a slash query matches advertised commands.
    inputRow.insertAdjacentElement(
      "beforebegin",
      (this.commandPopupEl = root.createDiv({ cls: "atl-chat-commands" }))
    );
    this.inputEl = inputRow.createEl("textarea", { cls: "atl-chat-input" });
    this.inputEl.placeholder = t("chat.placeholder");
    this.inputEl.rows = 2;
    this.inputEl.value = draft;
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (this.navigateCommandPopup(event)) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });
    this.inputEl.addEventListener("input", () => this.updateCommandPopup());
    this.inputEl.addEventListener("blur", () => {
      // Delay so a click inside the popup still lands before it hides.
      window.setTimeout(() => this.hideCommandPopup(), 150);
    });
    this.sendBtn = inputRow.createEl("button", { cls: "atl-chat-send mod-cta" });
    setIcon(this.sendBtn, "send-horizontal");
    setTooltip(this.sendBtn, t("chat.send"));
    // Dual-purpose: send when idle, stop the in-flight turn while generating.
    this.sendBtn.onclick = () => {
      if (this.busy) this.stop();
      else void this.send();
    };
    this.renderConversation(this.plugin.tutorConversation.state);
  }

  private async renderContext(): Promise<void> {
    const version = ++this.contextRenderVersion;
    const target = this.contextEl;
    if (!target?.isConnected) return;
    target.empty();
    if (this.pinned) {
      target.createSpan({
        cls: "atl-chat-chip atl-chat-chip--pinned",
        text: `💬 ${this.pinned.annotationId}`
      });
      this.addSelectionChip(this.pinned.selection, target);
      return;
    }
    const ctx = this.selectionContext ?? await this.plugin.chatContext();
    // A layout rebuild may have replaced the target while an older Vault read
    // was pending. Only the latest request may populate its original container.
    if (version !== this.contextRenderVersion || target !== this.contextEl || !target.isConnected) return;
    if (!ctx?.notePath) {
      target.createSpan({ cls: "atl-chat-chip atl-muted", text: t("chat.context.none") });
      return;
    }
    target.createSpan({
      cls: "atl-chat-chip",
      text: `📄 ${ctx.noteTitle ?? ctx.notePath}`
    });
    const selectionRow=this.selectionContext ? target.createDiv({cls:"atl-chat-selection-preview"}) : target;
    this.addSelectionChip(ctx.selection, selectionRow);
    if (this.selectionContext) this.iconButton(selectionRow,"x",t("upgrade.selectionRelease"),()=>{
      this.selectionContext=null; this.render(); this.inputEl.focus();
    });
  }

  private addSelectionChip(selection?: string, target = this.contextEl): void {
    const sel = selection?.trim();
    if (!sel) return;
    target.createSpan({
      cls: "atl-chat-chip",
      text: `✦ ${sel.length > 30 ? `${sel.slice(0, 30)}…` : sel}`
    });
  }

  // --- conversation ---------------------------------------------------------

  private newChat(): void {
    this.plugin.tutorConversation.reset();
    this.lastSentNotePath = "";
    this.pinned = null;
    this.selectionContext = null;
    this.inputEl.value = "";
    this.render();
  }

  public seedSelection(context: ChatContext): void {
    this.pinned = null;
    this.selectionContext = structuredClone({...context,selectionBound:true});
    this.mode = "ask";
    this.render(); this.inputEl.focus();
  }
  public renameSelectionSource(oldPath: string, newPath: string): void {
    const context=this.selectionContext;
    if (context?.notePath !== oldPath) return;
    context.notePath=newPath; context.noteTitle=newPath.split("/").pop();
    if(context.observation)context.observation.source=newPath;
    void this.renderContext();
  }

  /**
   * Pin an annotation as the conversation's context (from a margin card).
   * `opts.mode` switches the chat mode (e.g. Build for a polish request) and
   * `opts.send` queues a first message to send automatically.
   */
  public seedAnnotation(
    record: IndexRecord,
    opts?: { mode?: ChatMode; send?: string }
  ): void {
    this.plugin.tutorConversation.reset();
    this.lastSentNotePath = "";
    this.selectionContext = null;
    this.inputEl.value = "";
    this.pinned = {
      annotationId: record.annotationId,
      notePath: record.sourceFile,
      noteTitle: record.sourceFile.split("/").pop()?.replace(/\.md$/i, "") ?? record.sourceFile,
      selection: record.selectedText ?? ""
    };
    if (opts?.mode) this.mode = opts.mode;
    this.render();
    this.inputEl?.focus();
    const send = opts?.send?.trim();
    if (send) {
      this.inputEl.value = send;
      void this.send();
    }
  }

  // --- session persistence ----------------------------------------------------

  private loadSession(log: ChatLog): void {
    this.pinned = null; this.selectionContext = null;
    this.inputEl.value = "";
    this.plugin.tutorConversation.restore(log);
    this.render();
  }

  /** After a restart, reload the newest saved session so the chat survives. */
  private async restoreLatestSession(): Promise<void> {
    if (!this.plugin.settings.persistChatLog) return;
    if (
      this.currentLog ||
      this.plugin.tutorConversation.state.history.length > 0 ||
      this.plugin.tutorConversation.state.busy
    ) {
      return;
    }
    try {
      const [latest] = await this.plugin.store.listChatLogs();
      if (!latest) return;
      const log = await this.plugin.store.loadChatLog(latest.id);
      if (log && log.turns.length > 0 && !this.selectionContext && !this.pinned && !this.plugin.tutorConversation.state.busy && this.plugin.tutorConversation.state.history.length === 0) this.loadSession(log);
    } catch {
      /* history is best-effort: a read failure must not break the chat */
    }
  }

  /** A modal listing saved sessions on a timeline: click to reopen, trash to delete. */
  private async showHistory(): Promise<void> {
    const modal = new Modal(this.app);
    modal.titleEl.setText(t("chat.history"));
    modal.modalEl.addClass("atl-history-modal");
    const intro = modal.contentEl.createDiv({ cls: "atl-chat-history-intro" });
    setIcon(intro.createDiv({ cls: "atl-chat-history-intro-icon" }), "history");
    const introCopy = intro.createDiv({ cls: "atl-chat-history-intro-copy" });
    introCopy.createDiv({ cls: "atl-chat-history-heading", text: t("chat.history") });
    introCopy.createDiv({ cls: "atl-chat-history-subtitle", text: t("chat.historySubtitle") });
    const search = modal.contentEl.createDiv({ cls: "atl-chat-history-search" });
    setIcon(search.createSpan({ cls: "atl-chat-history-search-icon" }), "search");
    const searchInput = search.createEl("input", {
      cls: "atl-chat-history-search-input",
      attr: { type: "search", placeholder: t("chat.historySearch"), "aria-label": t("chat.historySearch") }
    });
    const list = modal.contentEl.createDiv({ cls: "atl-chat-history" });
    const footer = modal.contentEl.createDiv({ cls: "atl-chat-history-footer" });
    const count = footer.createSpan({ cls: "atl-chat-history-count" });
    const clearAll = footer.createEl("button", {
      cls: "atl-chat-history-clear"
    });
    setIcon(clearAll.createSpan(), "trash-2");
    clearAll.createSpan({ text: t("chat.deleteAllSessions") });
    clearAll.onclick = () => {
      new ConfirmModal(this.app, {
        title: t("chat.deleteAllSessions"),
        body: t("chat.deleteAllBody"),
        confirmText: t("chat.deleteAllSessions"),
        warning: true,
        onConfirm: async () => {
          await this.plugin.store.clearChatLogs();
          this.currentLog = null;
          modal.close();
          this.newChat();
        }
      }).open();
    };
    modal.open();
    list.setAttribute("aria-busy", "true");
    const loading = list.createDiv({ cls: "atl-chat-history-loading" });
    for (let i = 0; i < 3; i++) loading.createDiv({ cls: "atl-chat-history-skeleton" });
    let heads: ChatLogHead[] = [];
    try {
      heads = await this.plugin.store.listChatLogs();
    } catch {
      /* fall through to the empty list */
    }
    if (!modal.contentEl.isConnected) return;
    // Load full logs for previews. The modal is on-demand and sessions are
    // capped (chatLogKeepSessions), so a handful of small file reads is fine.
    const loaded = await Promise.all(
      heads.map(async head => [head.id, await this.plugin.store.loadChatLog(head.id).catch(() => null)] as const)
    );
    const logs = new Map(loaded);
    const renderList = (): void => {
      list.empty(); list.setAttribute("aria-busy", "false");
      const query = searchInput.value.trim().toLocaleLowerCase();
      const visible = heads.filter(head => {
        const preview = this.previewOf(logs.get(head.id) ?? null);
        return !query || `${head.title} ${preview}`.toLocaleLowerCase().includes(query);
      });
      count.textContent = t("chat.historySessionCount", { count: heads.length });
      clearAll.hidden = heads.length === 0;
      if (visible.length === 0) {
        const empty = list.createDiv({ cls: "atl-chat-history-empty" });
        setIcon(empty.createDiv({ cls: "atl-chat-history-empty-icon" }), query ? "search-x" : "messages-square");
        empty.createDiv({ cls: "atl-chat-history-empty-title", text: query ? t("chat.historyNoResults") : t("chat.historyEmpty") });
        if (!query) empty.createDiv({ cls: "atl-chat-history-empty-hint", text: t("chat.historyEmptyHint") });
        return;
      }
      let lastBucket = "";
      for (const head of visible) {
        const bucket = this.historyBucket(head.updatedAt);
        if (bucket !== lastBucket) {
          list.createDiv({ cls: "atl-chat-history-group", text: bucket });
          lastBucket = bucket;
        }
        const active = this.currentLog?.id === head.id;
        const row = list.createDiv({ cls: `atl-chat-history-item${active ? " is-current" : ""}` });
        const open = row.createEl("button", { cls: "atl-chat-history-open" });
        if (active) open.setAttribute("aria-current", "true");
        setIcon(open.createSpan({ cls: "atl-chat-history-row-icon" }), active ? "message-circle-more" : "message-circle");
        const content = open.createDiv({ cls: "atl-chat-history-content" });
        const titleRow = content.createDiv({ cls: "atl-chat-history-titlerow" });
        titleRow.createSpan({ cls: "atl-chat-history-title", text: head.title });
        titleRow.createSpan({ cls: "atl-chat-history-time", text: this.historyTime(head.updatedAt) });
        const preview = this.previewOf(logs.get(head.id) ?? null);
        if (preview && preview !== head.title) content.createDiv({ cls: "atl-chat-history-preview", text: preview });
        const meta = content.createDiv({ cls: "atl-chat-history-meta" });
        if (active) meta.createSpan({ cls: "atl-chat-history-current", text: t("chat.historyCurrent") });
        meta.createSpan({ cls: "atl-chat-history-badge", text: head.engine === "api" ? "API" : "OpenCode" });
        meta.createSpan({ cls: "atl-chat-history-badge atl-chat-history-badge--mode", text: t(`chat.mode.${head.mode}`) });
        meta.createSpan({ cls: "atl-chat-history-turns", text: t("chat.turnsCount", { count: head.turns }) });
        open.onclick = () => {
          void this.plugin.store.loadChatLog(head.id).then(log => { if (log) this.loadSession(log); });
          modal.close();
        };
        const del = row.createEl("button", { cls: "atl-iconbtn atl-chat-history-del" });
        setIcon(del, "trash-2"); setTooltip(del, t("chat.deleteSession"));
        del.onclick = event => {
          event.stopPropagation();
          new ConfirmModal(this.app, {
            title: t("chat.deleteSession"), body: t("chat.deleteSessionBody", { title: head.title }),
            confirmText: t("chat.deleteSession"), warning: true,
            onConfirm: async () => {
              await this.plugin.store.deleteChatLog(head.id);
              heads = heads.filter(item => item.id !== head.id); logs.delete(head.id);
              if (this.currentLog?.id === head.id) this.currentLog = null;
              renderList();
            }
          }).open();
        };
      }
    };
    searchInput.addEventListener("input", renderList);
    renderList();
  }

  /** Group a session into a human date bucket for the history timeline. */
  private historyBucket(iso: string): string {
    const days = this.daysAgo(iso);
    if (days <= 0) return t("chat.history.today");
    if (days === 1) return t("chat.history.yesterday");
    if (days < 7) return t("chat.history.week");
    return t("chat.history.older");
  }

  /** Time-of-day for recent sessions, a calendar date for older ones. */
  private historyTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
    if (this.daysAgo(iso) < 2) {
      return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  /** Whole calendar days between `iso` and today (0 = today, 1 = yesterday). */
  private daysAgo(iso: string): number {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return Number.POSITIVE_INFINITY;
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    then.setHours(0, 0, 0, 0);
    return Math.round((startToday.getTime() - then.getTime()) / 86_400_000);
  }

  /** A one-line preview from the first user message of a saved session. */
  private previewOf(log: ChatLog | null): string {
    if (!log) return "";
    const first = log.turns.find((turn) => turn.role === "user") ?? log.turns[0];
    if (!first) return "";
    const oneLine = first.text.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 119)}\u2026` : oneLine;
  }

  private async toggleEngine(): Promise<void> {
    this.plugin.settings.chatEngine =
      this.plugin.settings.chatEngine === "opencode" ? "api" : "opencode";
    await this.plugin.persistSettings();
    this.render();
  }

  /** The note context for this turn: the pinned annotation, else the active note. */
  private async resolveContext(): Promise<ChatContext> {
    if(this.selectionContext)return structuredClone(this.selectionContext);
    const pinned=this.pinned?{...this.pinned}:null;
    if (pinned) {
      const profileSummary = this.plugin.learnerProfileSummary();
      const source=await this.plugin.tutorContext(pinned.notePath,0,6000);
      return {
        notePath: pinned.notePath,
        noteTitle: pinned.noteTitle,
        selection: pinned.selection,
        content: source.text,
        sourceBinding:source.sourceBinding,
        observation:{source:pinned.notePath,version:source.revision,scope:"selection",hasImage:false},
        ...(profileSummary ? { profileSummary } : {})
      };
    }
    return (await this.plugin.chatContext()) ?? {};
  }

  private async send(forcedRoute?: "board"): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) return;
    const conversation = this.plugin.tutorConversation;
    const conversationId=conversation.conversationId,selection=this.selectionContext,pinned=this.pinned,mode=this.mode;
    this.inputEl.value = "";
    const intent = classifyIntent(text);
    if (intent === "locate" && this.tryLocate(text)) return;
    try {
      const route = forcedRoute ?? tutorRouteForText(text, {
        mode, pinned: !!pinned, hasBoard: conversation.hasBoard()
      });
      const ctx = await this.resolveContext();
      if(conversation.conversationId!==conversationId||this.selectionContext!==selection||this.pinned!==pinned)
        throw new DOMException(t("upgrade.conversationSourceChanged"), "AbortError");
      const resolveIntent=route !== "chat" && mode === "ask" && !pinned && (!!forcedRoute || shouldResolveTutorAction(text, conversation.hasBoard()));
      // Semantic visual preparation must precede edit guards or target tools.
      // A selected drawing request without an open board otherwise looks like
      // an edit to this heuristic and is rejected before preparation can run.
      const wantsEdit = route !== "board" && (mode === "build" || intent === "write"&&!resolveIntent);
      if (wantsEdit && ctx.selectionBound) throw new Error(t("upgrade.selectionEditSource"));
      const target = wantsEdit ? this.plugin.captureEditTarget(pinned?.selection, ctx.notePath) : null;
      const engineText = wantsEdit ? `${buildEditInstruction(target?.hasSelection ?? false)}\n\n${text}` : text;
      this.lastSentNotePath = ctx.notePath ?? "";
      await conversation.submit(text, { source: "chat", route, mode,
        learningTurn: {entry:"sidebar",kind:wantsEdit?"document-edit":"conversation",authority:localLearnerAuthority()},
        resolveIntent,
        context: { chat: ctx, engineText }, metadata: { target, mode,...(pinned?{annotationId:pinned.annotationId}:{}) } });
    } catch (error) {
      if (!this.inputEl.value) this.inputEl.value=text;
      this.addNotice(t("chat.error", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  private renderConversation(state: TutorConversationState): void {
    if (!this.messagesEl?.isConnected) return;
    if (this.renderedHistory !== state.history && this.rendered.size) {
      this.messagesEl.empty(); this.rendered.clear();
    }
    this.renderedHistory = state.history;
    if (state.history.length) this.clearEmpty();
    // Only the tail can change during a turn. Long transcripts must not be
    // traversed or rendered again for every token arriving from the model.
    for (const message of state.history.slice(Math.max(0, this.rendered.size - 1))) {
      let rendered = this.rendered.get(message.id);
      if (!rendered) {
        if (message.role === "user") {
          rendered = { el: this.addMessage("user", message.text), status: message.status, events: 0 };
        } else {
          const stream = this.addStreamingAssistant();
          rendered = { el: stream.el, status: "streaming", events: 0, stream };
        }
        this.rendered.set(message.id, rendered);
      }
      if (message.role === "assistant" && rendered.stream) {
        rendered.stream.appendRaw(message.text);
        for (const event of message.events.slice(rendered.events)) rendered.stream.addEvent(event);
        rendered.events = message.events.length;
        if (message.status !== "streaming") {
          rendered.stream.finalize(); rendered.stream = undefined;
          const meta = message.metadata as { target?: EditTarget | null; locate?: IndexRecord } | undefined;
          if (meta?.locate) {
            rendered.el.createDiv({ cls: "atl-chat-locate", text: message.text });
            if (meta.locate.userNoteSummary) rendered.el.createDiv({ cls: "atl-muted", text: meta.locate.userNoteSummary });
            const open = rendered.el.createEl("button", { cls: "mod-cta", text: t("chat.locate.open") });
            open.onclick = () => this.plugin.chatJump(meta.locate!);
          } else void this.presentReply(message.text, rendered.el, meta?.target ?? null);
        }
      }
      if (message.execution) {
        const badge=rendered.el.querySelector<HTMLElement>(".atl-chat-execution") ?? rendered.el.createDiv({cls:"atl-chat-execution atl-muted"});
        badge.textContent=t("board.executionModel",{model:message.execution.model,engine:message.execution.engine})+(message.execution.mode === "custom" ? ` · ${t("board.connectionCustom")}` : "");
        badge.dataset.engine=message.execution.engine;badge.dataset.model=message.execution.model;
      }
      rendered.status = message.status;
    }
    this.setBusy(state.busy);
    this.updateCommandPopup();
    let error = this.messagesEl.querySelector<HTMLElement>(".atl-chat-current-error");
    if (state.error && state.taskStatus !== "blocked") {
      error ??= this.messagesEl.createDiv({ cls: "atl-chat-msg atl-chat-notice atl-chat-current-error" });
      error.textContent = state.error === "board-unavailable" ? t("chat.board.openFirst") : /^teaching-(?:envelope|control|reply|stream)-[a-z-]+$/.test(state.error) ? t("chat.learningProtocolError") : t("chat.error", { detail: state.error });
    } else error?.remove();
    let task = this.messagesEl.querySelector<HTMLElement>(".atl-chat-task-status");
    if (state.taskStatus) {
      task ??= this.messagesEl.createDiv({cls:"atl-chat-task-status"});
      task.setAttribute("role","status");task.empty();
      task.createSpan({text:t(`board.task${state.taskStatus[0]!.toUpperCase()}${state.taskStatus.slice(1)}`)});
      if (state.failure && state.execution) task.createSpan({cls:"atl-chat-execution atl-muted",text:t("board.executionModel",{model:state.execution.model,engine:state.execution.engine})+(state.execution.mode === "custom" ? ` · ${t("board.connectionCustom")}` : "")});
      if(state.taskStatus!=="reconciliation"&&state.failure?.recovery === "connection") {
        task.createEl("button",{text:t("board.checkConnection")}).onclick=()=>this.plugin.tutorConversation.openConnectionSettings();
        if(state.execution?.mode === "custom") task.createEl("button",{text:t("board.followAndRetry")}).onclick=()=>{void this.plugin.tutorConversation.useChatConnectionAndRetry();};
      }
      if(state.taskStatus==="reconciliation"&&state.taskId&&state.commit){
        for(const action of ["inspect",...(state.commit.durability==="applied-not-durable"?["retry-save"]:[])] as Array<"inspect"|"retry-save">){
          const button=task.createEl("button",{text:t(action==="inspect"?"board.inspectSavedDrawing":"board.retryDrawingSave")});
          button.onclick=()=>{button.disabled=true;void this.plugin.recoverLocalDrawing(state.taskId!,action).catch(error=>new Notice(error instanceof Error?error.message:"Drawing recovery unavailable")).finally(()=>button.disabled=false);};
        }
      }
      if(state.canRetry) task.createEl("button",{text:t("board.retryTask")}).onclick=()=>{void this.plugin.tutorConversation.retry();};
      if(state.requestToEdit) task.createEl("button",{text:t("board.editRequest")}).onclick=()=>{
        this.inputEl.value=state.requestToEdit!;this.inputEl.focus();
      };
      this.messagesEl.append(task);
    } else task?.remove();
    this.scrollToBottom();
  }

  /**
   * Render an assistant reply. In Build mode, if it contains a proposed edit,
   * show the explanation plus a diff card the user can apply; otherwise render
   * the reply as Markdown.
   */
  private async presentReply(
    text: string,
    container: HTMLElement | null,
    target: EditTarget | null
  ): Promise<void> {
    // `target` is non-null exactly when this turn asked the agent to write; also
    // handle a reply that carries edit markers even if there's no note to apply
    // to, so the raw markers are never shown as text.
    if (this.mode === "build" || target || text.includes(EDIT_START)) {
      const { explanation, edit, isInsert } = resolveEdit(text);
      if (edit) {
        // A fallback block (the model skipped the edit markers) is always an
        // insert; show the full reply so its table/diagram previews, then offer
        // to drop just that block in at the cursor.
        const editTarget = isInsert ? this.insertTarget(target) : target;
        const message = isInsert ? text : explanation || t("chat.edit.proposed");
        if (container) await this.renderInto(container, message);
        else await this.renderAssistant(message);
        this.renderEditCard(edit, editTarget);
        return;
      }
    }
    if (container) await this.renderInto(container, text);
    else await this.renderAssistant(text);
  }

  /** Coerce a captured target into an insert-at-cursor target for a generated block. */
  private insertTarget(target: EditTarget | null): EditTarget | null {
    return target ? { ...target, hasSelection: false, original: "" } : null;
  }

  /** A preview card for a proposed edit: a diff plus Apply / Dismiss. */
  private renderEditCard(edit: string, target: EditTarget | null): void {
    const card = this.messagesEl.createDiv({
      cls: "atl-chat-msg atl-chat-msg--assistant atl-chat-edit"
    });
    card.createDiv({ cls: "atl-chat-edit-title", text: t("chat.edit.title") });
    const pre = card.createEl("pre", { cls: "atl-diff" });
    this.renderDiff(pre, target?.hasSelection ? target.original : "", edit);
    const actions = card.createDiv({ cls: "atl-actions" });
    const apply = actions.createEl("button", { cls: "mod-cta", text: t("chat.edit.apply") });
    apply.onclick = () => {
      if (!target) {
        this.addNotice(t("chat.edit.noTarget"));
        return;
      }
      if (this.plugin.applyNoteEdit(target, edit)) {
        apply.disabled = true;
        apply.setText(t("chat.edit.applied"));
      }
    };
    const copy = actions.createEl("button", { text: t("chat.copy") });
    copy.onclick = () => void this.copyToClipboard(edit, copy, t("chat.copy"));
    const dismiss = actions.createEl("button", { text: t("chat.edit.dismiss") });
    dismiss.onclick = () => card.remove();
    this.scrollToBottom();
  }

  private renderDiff(pre: HTMLElement, before: string, after: string): void {
    const diff = before
      ? lineDiff(before, after)
      : after.split(/\r?\n/).map((line) => `+ ${line}`).join("\n");
    for (const line of diff.split("\n")) {
      pre.createDiv({ cls: diffLineClass(line), text: line });
    }
  }

  // --- slash command popup ---------------------------------------------------

  /** The `/`-prefixed fragment being typed, when the popup should be visible. */
  private commandQuery(): string | null {
    const value = this.inputEl?.value ?? "";
    if (!value.startsWith("/")) return null;
    const firstSpace = value.indexOf(" ");
    if (firstSpace >= 0) return null; // command chosen; args being typed
    return value.slice(1).toLowerCase();
  }

  private updateCommandPopup(): void {
    if (!this.commandPopupEl?.isConnected) return;
    const query = this.commandQuery();
    if (query === null || this.commands.length === 0) {
      this.hideCommandPopup();
      return;
    }
    const matches = this.commands.filter(
      (command) =>
        command.name.toLowerCase().includes(query) ||
        (command.description ?? "").toLowerCase().includes(query)
    );
    if (matches.length === 0) {
      this.hideCommandPopup();
      return;
    }
    this.commandPopupEl.empty();
    for (const [index, command] of matches.entries()) {
      const item = this.commandPopupEl.createDiv({
        cls: index === 0 ? "atl-chat-command is-active" : "atl-chat-command"
      });
      item.createSpan({ cls: "atl-chat-command-name", text: `/${command.name}` });
      if (command.description) {
        item.createSpan({ cls: "atl-chat-command-desc", text: command.description });
      }
      item.onmousedown = (event) => {
        event.preventDefault(); // keep the textarea focused
        this.chooseCommand(command);
      };
    }
    this.commandPopupEl.show();
  }

  private chooseCommand(command: AcpCommand): void {
    this.inputEl.value = `/${command.name} `;
    this.hideCommandPopup();
    this.inputEl.focus();
  }

  /** Arrow/Enter/Escape navigation while the popup is open. True = handled. */
  private navigateCommandPopup(event: KeyboardEvent): boolean {
    if (!this.commandPopupEl?.isConnected || this.commandPopupEl.hidden) return false;
    const items = Array.from(
      this.commandPopupEl.querySelectorAll<HTMLElement>(".atl-chat-command")
    );
    if (items.length === 0) return false;
    const active = items.findIndex((item) => item.hasClass("is-active"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? (active + 1) % items.length
          : (active - 1 + items.length) % items.length;
      items.forEach((item, index) =>
        item.toggleClass("is-active", index === next)
      );
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.hideCommandPopup();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && active >= 0) {
      event.preventDefault();
      const name = items[active]!
        .querySelector(".atl-chat-command-name")
        ?.getText();
      if (name) {
        this.inputEl.value = `${name} `;
        this.hideCommandPopup();
      }
      return true;
    }
    return false;
  }

  private hideCommandPopup(): void {
    if (!this.commandPopupEl?.isConnected) return;
    this.commandPopupEl.empty();
    this.commandPopupEl.hide();
  }

  private tryLocate(text: string): boolean {
    const record = this.plugin.chatLocate(text);
    if (!record) return false;
    this.plugin.tutorConversation.recordLocal(text, t("chat.locate.found", { id: record.annotationId }), { locate: record });
    return true;
  }

  // --- message rendering ----------------------------------------------------

  private addMessage(role: "user" | "assistant", text: string): HTMLElement {
    const el = this.messagesEl.createDiv({
      cls: `atl-chat-msg atl-chat-msg--${role}`
    });
    el.textContent = text;
    this.scrollToBottom();
    return el;
  }

  private addNotice(text: string): void {
    this.messagesEl.createDiv({ cls: "atl-chat-msg atl-chat-notice", text });
    this.scrollToBottom();
  }

  private addThinking(): HTMLElement {
    const el = this.messagesEl.createDiv({
      cls: "atl-chat-msg atl-chat-msg--assistant atl-chat-thinking",
      text: t("chat.thinking")
    });
    this.scrollToBottom();
    return el;
  }

  private addStreamingAssistant(): {
    el: HTMLElement;
    appendRaw: (text: string) => void;
    addEvent: (event: AcpStreamEvent) => void;
    finalize: () => void;
    onUpdate: ((event: AcpStreamEvent) => void) | null;
  } {
    const el = this.messagesEl.createDiv({
      cls: "atl-chat-msg atl-chat-msg--assistant"
    });
    const segmentsEl = el.createDiv({ cls: "atl-chat-segments" });
    const status = el.createDiv({ cls: "atl-chat-status", text: t("chat.thinking") });
    const body = el.createDiv({ cls: "atl-chat-body" });

    // Message chunks arrive in bursts; coalesce them into one DOM write per
    // animation frame instead of re-rendering per chunk.
    let pendingText = "";
    const batcher = createFrameBatcher(() => {
      body.textContent = pendingText;
    }, (callback) => (this.contentEl.ownerDocument.defaultView ?? window).requestAnimationFrame(callback));

    // Thought/tool events fold into the segment blocks above the reply text.
    // Each block keeps its own updater so a re-render touches only what moved:
    // rebuilding the list wholesale collapsed every <details> the learner had
    // expanded, and cost O(segments) DOM writes per streamed chunk.
    type SegmentNode = {
      kind: ChatSegment["kind"];
      el: HTMLElement;
      update: (segment: ChatSegment) => void;
    };
    const createThoughtNode = (): SegmentNode => {
      const details = segmentsEl.createEl("details", { cls: "atl-chat-thought" });
      details.createEl("summary", { text: t("chat.thought") });
      const thoughtBody = details.createDiv({ cls: "atl-chat-thought-body" });
      return {
        kind: "thought",
        el: details,
        update: (segment): void => {
          if (segment.kind !== "thought") return;
          if (thoughtBody.textContent !== segment.text) {
            thoughtBody.textContent = segment.text;
          }
        }
      };
    };
    const createToolNode = (): SegmentNode => {
      const card = segmentsEl.createDiv({ cls: "atl-chat-tool" });
      setIcon(card.createSpan({ cls: "atl-chat-tool-icon" }), "wrench");
      const titleEl = card.createSpan({ cls: "atl-chat-tool-title" });
      let statusEl: HTMLElement | null = null;
      return {
        kind: "tool",
        el: card,
        update: (segment): void => {
          if (segment.kind !== "tool") return;
          if (titleEl.textContent !== segment.title) titleEl.textContent = segment.title;
          if (!segment.status) {
            statusEl?.remove();
            statusEl = null;
            return;
          }
          statusEl ??= card.createSpan({});
          statusEl.className = `atl-chat-tool-status atl-chat-tool-status--${segment.status}`;
          if (statusEl.textContent !== segment.status) statusEl.textContent = segment.status;
        }
      };
    };

    const events: AcpStreamEvent[] = [];
    const nodes: SegmentNode[] = [];
    const renderSegments = (): void => {
      const segments = foldStreamSegments(events);
      for (const [index, segment] of segments.entries()) {
        let node: SegmentNode | undefined = nodes[index];
        if (node && node.kind !== segment.kind) {
          // The fold only ever appends or updates its tail, so this cannot happen
          // today; drop the tail rather than append out of order if it ever does.
          for (const stale of nodes.splice(index)) stale.el.remove();
          node = undefined;
        }
        if (!node) {
          node = segment.kind === "thought" ? createThoughtNode() : createToolNode();
          nodes.push(node);
        }
        node.update(segment);
      }
      for (const stale of nodes.splice(segments.length)) stale.el.remove();
    };
    const segmentBatcher = createFrameBatcher(renderSegments, (callback) =>
      (this.contentEl.ownerDocument.defaultView ?? window).requestAnimationFrame(callback)
    );

    const handle = {
      el,
      appendRaw: (text: string): void => {
        status.hide();
        pendingText = text;
        batcher.dirty();
      },
      addEvent: (event: AcpStreamEvent): void => {
        events.push(event);
        segmentBatcher.dirty();
      },
      /** Drop the live status/body so the final Markdown render replaces them. */
      finalize: (): void => {
        // Land any batched segment state now: the turn may end inside the same
        // frame as its last tool update, and segmentsEl outlives this bubble.
        renderSegments();
        status.remove();
        body.remove();
      },
      onUpdate: null as ((event: AcpStreamEvent) => void) | null
    };
    return handle;
  }

  private async renderAssistant(text: string): Promise<void> {
    const el = this.messagesEl.createDiv({
      cls: "atl-chat-msg atl-chat-msg--assistant"
    });
    await this.renderInto(el, text);
  }

  private async renderInto(el: HTMLElement, text: string): Promise<void> {
    // Render into a child so a streaming bubble's thought/tool segment blocks
    // survive the final Markdown pass.
    const md = el.createDiv({ cls: "atl-chat-md" });
    // The source path resolves relative links, [[wikilinks]] and embeds in the
    // reply against the note under discussion; "" resolved them against the Vault
    // root, so a link the agent wrote next to the note silently dead-ended.
    const sourcePath = this.pinned?.notePath ?? this.lastSentNotePath;
    await MarkdownRenderer.render(this.app, text, md, sourcePath, this);
    this.attachCopy(md, text);
    this.scrollToBottom();
  }

  /** A hover-revealed copy button that copies the raw Markdown (UTF-8). */
  private attachCopy(el: HTMLElement, raw: string): void {
    const button = el.createEl("button", { cls: "atl-chat-copy" });
    setIcon(button, "copy");
    setTooltip(button, t("chat.copy"));
    button.onclick = (event) => {
      event.stopPropagation();
      void this.copyToClipboard(raw, button, t("chat.copy"), "copy");
    };
  }

  /** Write text to the clipboard and flash the button to confirm. */
  private async copyToClipboard(
    raw: string,
    button: HTMLButtonElement,
    label: string,
    icon?: string
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(raw);
    } catch {
      this.addNotice(t("chat.copyFailed"));
      return;
    }
    if (icon) setIcon(button, "check");
    else button.setText(t("chat.copied"));
    setTooltip(button, t("chat.copied"));
    window.setTimeout(() => {
      if (icon) setIcon(button, icon);
      else button.setText(label);
      setTooltip(button, label);
    }, 1500);
  }

  // --- helpers --------------------------------------------------------------

  private engineLabel(): string {
    return this.plugin.settings.chatEngine === "api"
      ? this.plugin.settings.apiModel.trim() || "API"
      : this.plugin.settings.agentModel.trim() || "OpenCode";
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.sendBtn.dataset.busy === String(busy)) return;
    this.sendBtn.dataset.busy = String(busy);
    // The send button stays clickable while busy — it morphs into the stop control.
    this.sendBtn.toggleClass("is-generating", busy);
    setIcon(this.sendBtn, busy ? "square" : "send-horizontal");
    setTooltip(this.sendBtn, busy ? t("chat.stop") : t("chat.send"));
    this.inputEl.disabled = false;
  }

  /** Abort the in-flight turn (the send button morphs into this stop control). */
  private stop(): void {
    this.plugin.tutorConversation.cancel();
  }

  private clearEmpty(): void {
    this.messagesEl.querySelector(".atl-chat-empty")?.remove();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private iconButton(
    container: HTMLElement,
    icon: string,
    tooltip: string,
    handler: () => void
  ): HTMLButtonElement {
    const button = container.createEl("button", { cls: "atl-iconbtn" });
    setIcon(button, icon);
    setTooltip(button, tooltip);
    button.onclick = () => handler();
    return button;
  }
}
