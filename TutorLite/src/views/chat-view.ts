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
  setIcon,
  setTooltip,
  type WorkspaceLeaf
} from "obsidian";
import type AnnotationTutorLitePlugin from "../main.js";
import type { EditTarget } from "../main.js";
import type { IndexRecord } from "../model.js";
import { t } from "../i18n.js";
import { classifyIntent } from "../intent.js";
import { detectLanguageName } from "../lang.js";
import { lineDiff } from "../line-diff.js";
import { buildEditInstruction, extractEdit } from "../edit-parse.js";
import {
  buildApiMessages,
  opencodePreamble,
  type ChatContext
} from "../chat-prompt.js";
import type { ChatMessage } from "../api-runner.js";
import type { AcpSessionHandle, AcpStreamEvent } from "../acp-session.js";

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

  private messagesEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;

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
    }

    this.contextEl = root.createDiv({ cls: "atl-chat-context" });
    void this.renderContext();

    const inputRow = root.createDiv({ cls: "atl-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", { cls: "atl-chat-input" });
    this.inputEl.placeholder = t("chat.placeholder");
    this.inputEl.rows = 2;
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });
    this.sendBtn = inputRow.createEl("button", { cls: "atl-chat-send mod-cta" });
    setIcon(this.sendBtn, "send-horizontal");
    setTooltip(this.sendBtn, t("chat.send"));
    this.sendBtn.onclick = () => void this.send();
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
      return {
        notePath: this.pinned.notePath,
        noteTitle: this.pinned.noteTitle,
        selection: this.pinned.selection,
        content: await this.plugin.noteContent(this.pinned.notePath)
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
    if (intent === "write" && this.mode !== "build") {
      this.addNotice(t("chat.writeHint"));
    }

    this.setBusy(true);
    const ctx = await this.resolveContext();
    // In Build mode the agent may propose an edit: capture where it would land
    // and append the edit protocol to the message the engine actually receives.
    // With an annotation pinned (e.g. a "polish" routed from a card), prefer its
    // selected text so the edit replaces the annotated span.
    const target =
      this.mode === "build"
        ? this.plugin.captureEditTarget(this.pinned?.selection)
        : null;
    const engineText =
      this.mode === "build"
        ? `${buildEditInstruction(target?.hasSelection ?? false)}\n\n${text}`
        : text;
    try {
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
    if (!result.ok || !result.reviewText) {
      this.addNotice(result.error ? t("chat.error", { detail: result.error }) : t("chat.empty"));
      return;
    }
    // Keep the conversation history clean (the raw message, not the protocol).
    this.apiHistory.push({ role: "user", content: rawText });
    this.apiHistory.push({ role: "assistant", content: result.reviewText });
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
        bubble.setRaw(raw);
        this.scrollToBottom();
      } else if (event.type === "tool") {
        bubble.setStatus(t("chat.usingTool", { tool: event.title }));
      }
    };
    const prompt = `${this.opencodeContextPrefix(ctx, rawText)}${engineText}`;
    this.firstTurn = false;
    if (ctx.notePath) this.lastSentNotePath = ctx.notePath;
    const result = await session.session.prompt(prompt, { mode: ACP_MODE[this.mode] });
    bubble.onUpdate = null;
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
    await this.presentReply(finalText, bubble.el, target);
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
    if (this.mode === "build") {
      const { explanation, edit } = extractEdit(text);
      if (edit) {
        const message = explanation || t("chat.edit.proposed");
        if (container) await this.renderInto(container, message);
        else await this.renderAssistant(message);
        this.renderEditCard(edit, target);
        return;
      }
    }
    if (container) await this.renderInto(container, text);
    else await this.renderAssistant(text);
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
      const cls = line.startsWith("+")
        ? "atl-diff-add"
        : line.startsWith("-")
          ? "atl-diff-del"
          : "atl-diff-ctx";
      pre.createDiv({ cls, text: line });
    }
  }

  private async ensureSession(): Promise<AcpSessionHandle> {
    const key = `opencode:${this.plugin.settings.agentCommand}:${this.plugin.settings.agentModel}`;
    if (this.session && this.sessionKey === key && !this.session.session.error) {
      return this.session;
    }
    this.disposeSession();
    this.firstTurn = true;
    const handle = await this.plugin.startChatSession({
      onUpdate: (event) => this.activeStream?.(event),
      onExit: () => {
        /* surfaced per-turn via prompt() resolving with an error */
      }
    });
    this.session = handle;
    this.sessionKey = key;
    return handle;
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
    setRaw: (text: string) => void;
    setStatus: (text: string) => void;
    onUpdate: ((event: AcpStreamEvent) => void) | null;
  } {
    const el = this.messagesEl.createDiv({
      cls: "atl-chat-msg atl-chat-msg--assistant"
    });
    const status = el.createDiv({ cls: "atl-chat-status", text: t("chat.thinking") });
    const body = el.createDiv({ cls: "atl-chat-body" });
    const handle = {
      el,
      setRaw: (text: string): void => {
        status.hide();
        body.textContent = text;
      },
      setStatus: (text: string): void => {
        status.setText(text);
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
    el.empty();
    el.addClass("atl-chat-md");
    await MarkdownRenderer.render(this.app, text, el, "", this);
    this.attachCopy(el, text);
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
    if (this.firstTurn) {
      return `${opencodePreamble(ctx, this.languageTarget(text))}\n\n`;
    }
    if (ctx.notePath && ctx.notePath !== this.lastSentNotePath) {
      const sel = ctx.selection?.trim();
      const selPart = sel ? `, selected: "${sel}"` : "";
      return `[The learner is now reading: ${ctx.notePath}${selPart}. Read it with your file tools if helpful.]\n\n`;
    }
    return "";
  }

  private engineLabel(): string {
    return this.plugin.settings.chatEngine === "api"
      ? this.plugin.settings.apiModel.trim() || "API"
      : this.plugin.settings.agentModel.trim() || "OpenCode";
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.inputEl.disabled = busy;
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
