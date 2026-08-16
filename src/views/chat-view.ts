// The Claudian-style tutor chat: the plugin's right-leaf sidebar. A multi-turn
// conversation with contextual memory that can answer questions about what the
// learner is reading, read the whole note on demand (OpenCode), and jump to a
// specific annotation. The dashboard table now lives in Settings → Annotations.
//
// The view owns the conversation state (the live ACP session for OpenCode, or
// the resent message history for the Direct API) and a mode toggle (Ask / Plan /
// Build) that maps to the OpenCode session mode. All prompt assembly is pure and
// lives in chat-prompt.ts; engine glue (settings, the Vault, spawning) lives on
// the plugin, so this file is just UI + flow.

import {
  ItemView,
  MarkdownRenderer,
  Modal,
  setIcon,
  setTooltip,
  type WorkspaceLeaf
} from "obsidian";
import type AnnotationTutorLitePlugin from "../main.js";
import type { EditTarget } from "../main.js";
import type { ChatLog, ChatLogHead, IndexRecord } from "../model.js";
import { t } from "../i18n.js";
import { classifyIntent } from "../intent.js";
import { detectLanguageName } from "../lang.js";
import { diffLineClass, lineDiff } from "../line-diff.js";
import { buildEditInstruction, EDIT_START, resolveEdit } from "../edit-parse.js";
import {
  buildApiMessages,
  opencodePreamble,
  type ChatContext
} from "../chat-prompt.js";
import type { ChatMessage } from "../api-runner.js";
import type {
  AcpCommand,
  AcpSessionHandle,
  AcpStreamEvent
} from "../acp-session.js";
import {
  createFrameBatcher,
  foldStreamSegments,
  type ChatSegment
} from "../chat-stream.js";
import { ConfirmModal } from "./annotation-modal.js";
import { makeId, nowIso } from "../ids.js";
import { capChatLog, chatTitleFrom } from "../markdown/chat-log-file.js";

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
const ACP_MODE: Record<ChatMode, string> = { ask: "build", plan: "plan", build: "build" };

export class ChatView extends ItemView {
  private mode: ChatMode = "ask";
  private busy = false;
  private session: AcpSessionHandle | null = null;
  private sessionKey = ""; // engine+command+model the live session was built for
  private firstTurn = true;
  private lastSentNotePath = ""; // so we can re-index OpenCode when the note changes
  private pinned: PinnedAnnotation | null = null;
  private readonly apiHistory: ChatMessage[] = [];
  /** Slash commands the live OpenCode session has advertised (empty for API). */
  private commands: AcpCommand[] = [];
  /** The saved session this conversation persists into (null until the first turn). */
  private currentLog: ChatLog | null = null;
  /** True until the first reply after a restore; the recap is prefixed once. */
  private restoredFromHistory = false;

  private messagesEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private commandPopupEl!: HTMLElement;
  /** Set when the learner hits the stop control mid-turn; guards the result. */
  private stopRequested = false;

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
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => void this.renderContext())
    );
    void this.restoreLatestSession();
  }

  public override async onClose(): Promise<void> {
    this.disposeSession();
    this.contentEl.empty();
  }

  /** Re-read settings-derived chrome (model badge) when settings change. */
  public refresh(): void {
    if (this.contentEl.isConnected) this.render();
  }

  // --- layout ---------------------------------------------------------------

  private render(): void {
    this.contentEl.empty();
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
    this.iconButton(header, "history", t("chat.history"), () => void this.showHistory());
    this.iconButton(header, "settings", t("panel.settings"), () =>
      this.plugin.openSettings()
    );

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

    this.messagesEl = root.createDiv({ cls: "atl-chat-messages" });
    if (this.apiHistory.length === 0 && this.messagesEl.childElementCount === 0) {
      const empty = this.messagesEl.createDiv({ cls: "atl-chat-empty" });
      setIcon(empty.createDiv({ cls: "atl-chat-empty-icon" }), "graduation-cap");
      empty.createDiv({ cls: "atl-chat-empty-text", text: t("chat.welcome") });
      // One-tap starters: they send immediately, so the surface never sits
      // blank waiting for the learner to think of a first question.
      const suggest = empty.createDiv({ cls: "atl-chat-suggest" });
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
    this.inputEl.addEventListener("keydown", (event) => {
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
  }

  private async renderContext(): Promise<void> {
    if (!this.contextEl?.isConnected) return;
    this.contextEl.empty();
    if (this.pinned) {
      this.contextEl.createSpan({
        cls: "atl-chat-chip atl-chat-chip--pinned",
        text: `💬 ${this.pinned.annotationId}`
      });
      this.addSelectionChip(this.pinned.selection);
      return;
    }
    const ctx = await this.plugin.chatContext();
    if (!ctx?.notePath) {
      this.contextEl.createSpan({ cls: "atl-chat-chip atl-muted", text: t("chat.context.none") });
      return;
    }
    this.contextEl.createSpan({
      cls: "atl-chat-chip",
      text: `📄 ${ctx.noteTitle ?? ctx.notePath}`
    });
    this.addSelectionChip(ctx.selection);
  }

  private addSelectionChip(selection?: string): void {
    const sel = selection?.trim();
    if (!sel) return;
    this.contextEl.createSpan({
      cls: "atl-chat-chip",
      text: `✦ ${sel.length > 30 ? `${sel.slice(0, 30)}…` : sel}`
    });
  }

  // --- conversation ---------------------------------------------------------

  private newChat(): void {
    this.disposeSession();
    this.apiHistory.length = 0;
    this.firstTurn = true;
    this.lastSentNotePath = "";
    this.pinned = null;
    this.commands = [];
    this.currentLog = null;
    this.restoredFromHistory = false;
    this.render();
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
    this.disposeSession();
    this.apiHistory.length = 0;
    this.firstTurn = true;
    this.lastSentNotePath = "";
    this.currentLog = null;
    this.restoredFromHistory = false;
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

  /**
   * Persist one turn to the session file, creating the session on the first
   * turn. Best-effort: a write failure surfaces a notice but never breaks the
   * conversation.
   */
  private async persistTurn(
    role: "user" | "assistant",
    text: string
  ): Promise<void> {
    if (!this.plugin.settings.persistChatLog) return;
    try {
      const now = nowIso();
      if (!this.currentLog) {
        const heads = await this.plugin.store.listChatLogs();
        this.currentLog = {
          id: makeId("CHAT", heads.map((head) => head.id)),
          title: chatTitleFrom(text),
          engine: this.plugin.settings.chatEngine,
          mode: this.mode,
          status: "active",
          turns: [],
          createdAt: now,
          updatedAt: now
        };
      }
      this.currentLog = {
        ...this.currentLog,
        // The engine may have been toggled mid-conversation; keep the file honest.
        engine: this.plugin.settings.chatEngine,
        mode: this.mode,
        turns: [...this.currentLog.turns, { role, text, at: now }],
        updatedAt: now
      };
      await this.plugin.store.saveChatLog(this.currentLog);
    } catch {
      this.addNotice(t("chat.persistError"));
    }
  }

  /**
   * Show a saved session and continue it in place: capped turns render behind a
   * divider, `apiHistory` is rebuilt so the API engine keeps its memory, and the
   * next OpenCode turn gets a transcript recap (it is a brand-new session).
   */
  private loadSession(log: ChatLog): void {
    this.disposeSession();
    this.apiHistory.length = 0;
    this.firstTurn = true;
    this.lastSentNotePath = "";
    this.pinned = null;
    this.commands = [];
    this.currentLog = log;
    this.restoredFromHistory = log.turns.length > 0;
    const { turns, truncated } = capChatLog(log.turns);
    this.apiHistory.push(
      ...turns.map((turn) => ({ role: turn.role, content: turn.text }))
    );
    this.render();
    const divider = this.messagesEl.createDiv({ cls: "atl-chat-divider" });
    divider.createSpan({
      text: t("chat.earlierSession", {
        date: log.updatedAt.slice(0, 10),
        count: log.turns.length
      })
    });
    for (const turn of turns) {
      if (turn.role === "user") this.addMessage("user", turn.text);
      else void this.renderAssistant(turn.text);
    }
    if (truncated > 0) {
      this.addNotice(t("chat.truncatedNotice", { count: truncated }));
    }
    this.scrollToBottom();
  }

  /** After a restart, reload the newest saved session so the chat survives. */
  private async restoreLatestSession(): Promise<void> {
    if (!this.plugin.settings.persistChatLog) return;
    if (
      this.currentLog ||
      this.apiHistory.length > 0 ||
      this.messagesEl.childElementCount > 0
    ) {
      return;
    }
    try {
      const [latest] = await this.plugin.store.listChatLogs();
      if (!latest) return;
      const log = await this.plugin.store.loadChatLog(latest.id);
      if (log && log.turns.length > 0) this.loadSession(log);
    } catch {
      /* history is best-effort: a read failure must not break the chat */
    }
  }

  /** A modal listing saved sessions on a timeline: click to reopen, trash to delete. */
  private async showHistory(): Promise<void> {
    let heads: ChatLogHead[] = [];
    try {
      heads = await this.plugin.store.listChatLogs();
    } catch {
      /* fall through to the empty list */
    }
    const modal = new Modal(this.app);
    modal.titleEl.setText(t("chat.history"));
    modal.modalEl.addClass("atl-history-modal");
    const list = modal.contentEl.createDiv({ cls: "atl-chat-history" });
    if (heads.length === 0) {
      const empty = list.createDiv({ cls: "atl-chat-history-empty" });
      setIcon(empty.createDiv({ cls: "atl-chat-history-empty-icon" }), "messages-square");
      empty.createDiv({ text: t("chat.historyEmpty") });
    }
    // Load full logs for previews. The modal is on-demand and sessions are
    // capped (chatLogKeepSessions), so a handful of small file reads is fine.
    const logs = await Promise.all(
      heads.map((head) => this.plugin.store.loadChatLog(head.id).catch(() => null))
    );
    let lastBucket = "";
    for (const [index, head] of heads.entries()) {
      const bucket = this.historyBucket(head.updatedAt);
      if (bucket !== lastBucket) {
        list.createDiv({ cls: "atl-chat-history-group", text: bucket });
        lastBucket = bucket;
      }
      const row = list.createDiv({ cls: "atl-chat-history-item" });
      const open = row.createEl("button", { cls: "atl-chat-history-open" });
      const titleRow = open.createDiv({ cls: "atl-chat-history-titlerow" });
      titleRow.createSpan({ cls: "atl-chat-history-title", text: head.title });
      titleRow.createSpan({
        cls: "atl-chat-history-time",
        text: this.historyTime(head.updatedAt)
      });
      const preview = this.previewOf(logs[index] ?? null);
      if (preview) {
        open.createDiv({ cls: "atl-chat-history-preview", text: preview });
      }
      const meta = open.createDiv({ cls: "atl-chat-history-meta" });
      meta.createSpan({
        cls: "atl-chat-history-badge",
        text: head.engine === "api" ? "API" : "OpenCode"
      });
      meta.createSpan({
        cls: "atl-chat-history-badge atl-chat-history-badge--mode",
        text: t(`chat.mode.${head.mode}`)
      });
      meta.createSpan({
        cls: "atl-muted",
        text: t("chat.turnsCount", { count: head.turns })
      });
      open.onclick = () => {
        void this.plugin.store.loadChatLog(head.id).then((log) => {
          if (log) this.loadSession(log);
        });
        modal.close();
      };
      const del = row.createEl("button", { cls: "atl-iconbtn atl-chat-history-del" });
      setIcon(del, "trash-2");
      setTooltip(del, t("chat.deleteSession"));
      del.onclick = () => {
        new ConfirmModal(this.app, {
          title: t("chat.deleteSession"),
          body: t("chat.deleteSessionBody", { title: head.title }),
          confirmText: t("chat.deleteSession"),
          warning: true,
          onConfirm: async () => {
            await this.plugin.store.deleteChatLog(head.id);
            row.remove();
            if (this.currentLog?.id === head.id) {
              this.currentLog = null;
              this.restoredFromHistory = false;
            }
          }
        }).open();
      };
    }
    const footer = modal.contentEl.createDiv({ cls: "atl-chat-history-footer" });
    const clearAll = footer.createEl("button", {
      text: t("chat.deleteAllSessions"),
      cls: "mod-warning"
    });
    clearAll.onclick = () => {
      new ConfirmModal(this.app, {
        title: t("chat.deleteAllSessions"),
        body: t("chat.deleteAllBody"),
        confirmText: t("chat.deleteAllSessions"),
        warning: true,
        onConfirm: async () => {
          await this.plugin.store.clearChatLogs();
          this.currentLog = null;
          this.restoredFromHistory = false;
          modal.close();
          this.newChat();
        }
      }).open();
    };
    modal.open();
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

  /**
   * A bounded transcript recap for the engine: a restored OpenCode session is a
   * brand-new process with no memory, so its first prompt replays the tail of
   * the saved conversation (the API engine needs no recap — apiHistory carries it).
   */
  private transcriptRecap(): string {
    const { turns } = capChatLog(this.currentLog?.turns ?? [], 20, 1200);
    const lines = turns.map((turn) => {
      const who = turn.role === "user" ? "Learner" : "Tutor";
      const text = turn.text.replace(/\s+/g, " ").trim();
      return `${who}: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
    });
    return `[This conversation was restored from an earlier session. Recent transcript:\n${lines.join("\n").slice(0, 1500)}\nContinue from here.]`;
  }

  private async toggleEngine(): Promise<void> {
    this.plugin.settings.chatEngine =
      this.plugin.settings.chatEngine === "opencode" ? "api" : "opencode";
    await this.plugin.persistSettings();
    this.disposeSession();
    this.render();
  }

  /** The note context for this turn: the pinned annotation, else the active note. */
  private async resolveContext(): Promise<ChatContext> {
    if (this.pinned) {
      const profileSummary = this.plugin.learnerProfileSummary();
      return {
        notePath: this.pinned.notePath,
        noteTitle: this.pinned.noteTitle,
        selection: this.pinned.selection,
        content: await this.plugin.noteContent(this.pinned.notePath),
        ...(profileSummary ? { profileSummary } : {})
      };
    }
    return (await this.plugin.chatContext()) ?? {};
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.clearEmpty();
    this.addMessage("user", text);

    // First layer: decide whether this is a quick "locate" the plugin can answer
    // without the model, a "write" (hint toward Build), or a plain question.
    const intent = classifyIntent(text);
    if (intent === "locate" && this.tryLocate(text)) return;

    // Local-only turns (locate above) are not worth a session file; everything
    // that reaches an engine is.
    await this.persistTurn("user", text);

    this.stopRequested = false;
    this.setBusy(true);
    // Everything from here on lives inside the try: `resolveContext()` reads the
    // Vault and `captureEditTarget()` touches the editor, so either can throw —
    // and outside the try that left `busy` stuck on, silently swallowing every
    // later message (callers use `void this.send()`, so nothing else catches it).
    try {
      const ctx = await this.resolveContext();
      // The agent may propose an edit when in Build mode or when the message
      // clearly asks for one ("insert a table…", "draw a diagram…") — so writing
      // and inserting work without first switching to Build. Capture where the
      // edit would land and append the edit protocol to the message the engine
      // receives. With an annotation pinned (e.g. a "polish" routed from a card),
      // prefer its selected text so the edit replaces the annotated span.
      const wantsEdit = this.mode === "build" || intent === "write";
      const target = wantsEdit
        ? this.plugin.captureEditTarget(this.pinned?.selection)
        : null;
      const engineText = wantsEdit
        ? `${buildEditInstruction(target?.hasSelection ?? false)}\n\n${text}`
        : text;
      if (this.plugin.settings.chatEngine === "opencode") {
        await this.runOpenCodeWithFallback(ctx, engineText, text, target);
      } else {
        await this.runApiTurn(ctx, engineText, text, target);
      }
    } catch (error) {
      this.addNotice(
        t("chat.error", {
          detail: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      this.setBusy(false);
    }
  }

  /** Prefer OpenCode (it can read the Vault); fall back to the API if it can't start. */
  private async runOpenCodeWithFallback(
    ctx: ChatContext,
    engineText: string,
    rawText: string,
    target: EditTarget | null
  ): Promise<void> {
    try {
      await this.runOpenCodeTurn(ctx, engineText, rawText, target);
    } catch (error) {
      // The session could not be spawned (OpenCode missing / unreachable).
      if (this.plugin.settings.apiKey.trim()) {
        this.addNotice(
          t("chat.fallbackApi", {
            detail: error instanceof Error ? error.message : String(error)
          })
        );
        await this.runApiTurn(ctx, engineText, rawText, target);
        return;
      }
      throw error;
    }
  }

  private async runApiTurn(
    ctx: ChatContext,
    engineText: string,
    rawText: string,
    target: EditTarget | null
  ): Promise<void> {
    if (!this.plugin.settings.apiKey.trim()) {
      this.addNotice(t("notice.apiKeyMissing"));
      return;
    }
    const thinking = this.addThinking();
    const messages = buildApiMessages(
      this.apiHistory,
      ctx,
      engineText,
      this.languageTarget(rawText)
    );
    const result = await this.plugin.chatApiTurn(messages);
    thinking.remove();
    if (this.stopRequested) return;
    if (!result.ok || !result.reviewText) {
      this.addNotice(result.error ? t("chat.error", { detail: result.error }) : t("chat.empty"));
      return;
    }
    // Keep the conversation history clean (the raw message, not the protocol).
    this.apiHistory.push({ role: "user", content: rawText });
    this.apiHistory.push({ role: "assistant", content: result.reviewText });
    await this.persistTurn("assistant", result.reviewText);
    await this.presentReply(result.reviewText, null, target);
  }

  private async runOpenCodeTurn(
    ctx: ChatContext,
    engineText: string,
    rawText: string,
    target: EditTarget | null
  ): Promise<void> {
    const session = await this.ensureSession();
    const bubble = this.addStreamingAssistant();
    let raw = "";
    let gotChunk = false;
    bubble.onUpdate = (event: AcpStreamEvent): void => {
      if (event.type === "message") {
        gotChunk = true;
        raw += event.text;
        bubble.appendRaw(raw);
        this.scrollToBottom();
      } else if (event.type === "thought" || event.type === "tool") {
        bubble.addEvent(event);
        this.scrollToBottom();
      }
    };
    const prompt = `${this.opencodeContextPrefix(ctx, rawText)}${engineText}`;
    this.firstTurn = false;
    if (ctx.notePath) this.lastSentNotePath = ctx.notePath;
    const result = await session.session.prompt(prompt, { mode: ACP_MODE[this.mode] });
    bubble.onUpdate = null;
    if (this.stopRequested) {
      // Keep whatever streamed so far; skip the error/empty notices and don't persist.
      if (gotChunk) bubble.finalize();
      else bubble.el.remove();
      return;
    }
    const finalText = result.text || raw;
    if (!result.ok && !finalText) {
      bubble.el.remove();
      this.addNotice(result.error ? t("chat.error", { detail: result.error }) : t("chat.empty"));
      // A dead session should be rebuilt next turn.
      this.disposeSession();
      return;
    }
    if (!gotChunk && !finalText) {
      bubble.el.remove();
      this.addNotice(t("chat.empty"));
      return;
    }
    bubble.finalize();
    await this.presentReply(finalText, bubble.el, target);
    await this.persistTurn("assistant", finalText);
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
    // The engine answered, so the restored-session recap must not repeat.
    this.restoredFromHistory = false;
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
    const base = target ?? this.plugin.captureEditTarget();
    return base ? { ...base, hasSelection: false, original: "" } : null;
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

  private async ensureSession(): Promise<AcpSessionHandle> {
    const key = `opencode:${this.plugin.settings.agentCommand}:${this.plugin.settings.agentModel}:${this.plugin.settings.mcpServersJson}`;
    if (this.session && this.sessionKey === key && !this.session.session.error) {
      return this.session;
    }
    this.disposeSession();
    this.firstTurn = true;
    const handle = await this.plugin.startChatSession({
      onUpdate: (event) => {
        // Command broadcasts arrive right after session/new, between turns,
        // so they are handled here rather than on the per-turn stream sink.
        if (event.type === "commands") {
          this.commands = event.commands;
          this.updateCommandPopup();
          return;
        }
        this.activeStream?.(event);
      },
      onExit: () => {
        /* surfaced per-turn via prompt() resolving with an error */
      }
    });
    this.session = handle;
    this.sessionKey = key;
    this.commands = handle.session.commands;
    return handle;
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
    const card = this.messagesEl.createDiv({ cls: "atl-chat-msg atl-chat-msg--assistant" });
    card.createDiv({
      cls: "atl-chat-locate",
      text: t("chat.locate.found", { id: record.annotationId })
    });
    if (record.userNoteSummary) {
      card.createDiv({ cls: "atl-muted", text: record.userNoteSummary });
    }
    const open = card.createEl("button", { cls: "mod-cta", text: t("chat.locate.open") });
    open.onclick = () => this.plugin.chatJump(record);
    this.scrollToBottom();
    return true;
  }

  // --- message rendering ----------------------------------------------------

  /** The live OpenCode stream sink, set while a turn is in flight. */
  private activeStream: ((event: AcpStreamEvent) => void) | null = null;

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
    }, (callback) => window.requestAnimationFrame(callback));

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
      window.requestAnimationFrame(callback)
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
    // Bridge the session's single stream sink to this bubble for its lifetime.
    this.activeStream = (event) => handle.onUpdate?.(event);
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

  private languageTarget(text: string): string {
    return this.plugin.settings.reviewLanguage.trim() || detectLanguageName(text);
  }

  /**
   * The context the OpenCode turn is prefixed with: the full preamble on the
   * first turn, and a short "now reading …" note whenever the active note has
   * changed since the last turn (so the agent re-indexes the new file).
   */
  private opencodeContextPrefix(ctx: ChatContext, text: string): string {
    let prefix = "";
    if (this.firstTurn) {
      prefix = `${opencodePreamble(ctx, this.languageTarget(text))}\n\n`;
    } else if (ctx.notePath && ctx.notePath !== this.lastSentNotePath) {
      const sel = ctx.selection?.trim();
      const selPart = sel ? `, selected: "${sel}"` : "";
      prefix = `[The learner is now reading: ${ctx.notePath}${selPart}. Read it with your file tools if helpful.]\n\n`;
    }
    if (this.restoredFromHistory) {
      prefix += `${this.transcriptRecap()}\n\n`;
    }
    return prefix;
  }

  private engineLabel(): string {
    return this.plugin.settings.chatEngine === "api"
      ? this.plugin.settings.apiModel.trim() || "API"
      : this.plugin.settings.agentModel.trim() || "OpenCode";
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    // The send button stays clickable while busy — it morphs into the stop control.
    this.sendBtn.toggleClass("is-generating", busy);
    setIcon(this.sendBtn, busy ? "square" : "send-horizontal");
    setTooltip(this.sendBtn, busy ? t("chat.stop") : t("chat.send"));
    this.inputEl.disabled = busy;
  }

  /** Abort the in-flight turn (the send button morphs into this stop control). */
  private stop(): void {
    if (!this.busy) return;
    this.stopRequested = true;
    // OpenCode: tearing the session down settles the pending prompt at once.
    // API: requestUrl can't be aborted mid-flight, so the pending result is
    // discarded when it returns (see the stopRequested guards in the run* turns).
    if (this.plugin.settings.chatEngine === "opencode") this.disposeSession();
    this.setBusy(false);
    this.addNotice(t("chat.stopped"));
  }

  private clearEmpty(): void {
    this.messagesEl.querySelector(".atl-chat-empty")?.remove();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private disposeSession(): void {
    this.session?.dispose();
    this.session = null;
    this.sessionKey = "";
    this.activeStream = null;
    // Second line of defence for the busy flag: tearing the session down mid-turn
    // (new chat / engine switch / pinning a card) must never leave the composer
    // disabled-in-spirit, because `send()` returns early on `busy` without a word.
    this.setBusy(false);
  }

  private iconButton(
    container: HTMLElement,
    icon: string,
    tooltip: string,
    handler: () => void
  ): void {
    const button = container.createEl("button", { cls: "atl-iconbtn" });
    setIcon(button, icon);
    setTooltip(button, tooltip);
    button.onclick = () => handler();
  }
}
