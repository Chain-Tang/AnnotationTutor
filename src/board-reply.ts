import { t } from "./i18n.js";
import { boardFontCss, ensureBoardFonts } from "./board-fonts.js";

/** Keep prose legible in the handwritten caption; never interpret HTML or SVG. */
export function boardReplyPlainText(text: string): string {
  return text.replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]\n]+)\]\([^\s)]+\)/g, "$1");
}

/** View-only conversation chrome. None of this text is a saved board object. */
export class BoardReplyOverlay {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly bubble: HTMLElement;
  private readonly body: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly pin: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly edit: HTMLButtonElement;
  private readonly connection: HTMLButtonElement;
  private readonly follow: HTMLButtonElement;
  private readonly execution: HTMLElement;
  private readonly win: Window;
  private frame = 0;
  private disposed = false;
  private previousFocus: HTMLElement | null = null;
  private latest = { text: "", busy: false, visible: false, error: "", canRetry: false, taskStatus: "", requestToEdit: "", connectionFailure: false, execution: "", customConnection: false };

  constructor(
    root: HTMLElement,
    actions: { submit: () => void; pin: (text: string) => void; stop: () => void; retry?: () => void; connection?:()=>void; follow?:()=>void },
  ) {
    const doc = root.ownerDocument;
    this.win = doc.defaultView!;
    this.element = doc.createElement("div");
    this.element.className = "atl-board-conversation";
    this.bubble = doc.createElement("section");
    this.bubble.className = "atl-board-reply";
    this.bubble.hidden = true;
    this.bubble.setAttribute("aria-label", t("board.currentReply"));
    const header = doc.createElement("div");
    header.className = "atl-board-reply-header";
    const handle = doc.createElement("span");
    handle.textContent = "Tutor";
    handle.className = "atl-board-reply-handle";
    handle.title = t("board.moveReply");
    header.append(handle);
    const button = (parent: HTMLElement, key: string, onClick: () => void) => {
      const item = doc.createElement("button");
      item.type = "button";
      item.textContent = t(`board.${key}`);
      item.setAttribute("aria-label", item.textContent);
      item.onclick = onClick;
      parent.append(item);
      return item;
    };
    this.pin = button(header, "pinReply", () => actions.pin(boardReplyPlainText(this.latest.text)));
    this.stop = button(header, "stopReply", actions.stop);
    this.retry = button(header, "retryTask", () => actions.retry?.());
    this.retry.hidden = true;
    this.connection=button(header,"checkConnection",()=>actions.connection?.());this.connection.hidden=true;
    this.follow=button(header,"followAndRetry",()=>actions.follow?.());this.follow.hidden=true;
    this.execution=doc.createElement("span");this.execution.className="atl-muted";this.bubble.append(this.execution);
    this.edit = button(header, "editRequest", () => {
      this.input.value=this.latest.requestToEdit;this.showInput();
    });
    this.edit.hidden = true;
    this.body = doc.createElement("div");
    this.body.className = "atl-board-reply-text";
    this.body.style.font = boardFontCss({ font: "handwritten", size: 21, align: "left" });
    this.bubble.append(header, this.body);
    this.composer = doc.createElement("div");
    this.composer.className = "atl-board-quick-input";
    this.composer.hidden = true;
    this.input = doc.createElement("input");
    this.input.type = "text";
    this.input.placeholder = t("board.prompt");
    this.input.setAttribute("aria-label", t("board.prompt"));
    this.composer.append(this.input);
    button(this.composer, "send", () => actions.submit());
    button(this.composer, "cancel", () => this.hideInput());
    this.input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (this.input.value.trim()) actions.submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.hideInput();
      }
    };
    this.element.append(this.bubble, this.composer);
    root.append(this.element);
    let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return;
      const box = this.bubble.getBoundingClientRect(), host = root.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.left - host.left, top: box.top - host.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    handle.onpointermove = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const host = root.getBoundingClientRect(), box = this.bubble.getBoundingClientRect();
      this.bubble.style.left = `${Math.max(0, Math.min(host.width - box.width, drag.left + event.clientX - drag.x))}px`;
      this.bubble.style.top = `${Math.max(0, Math.min(host.height - box.height, drag.top + event.clientY - drag.y))}px`;
      this.bubble.style.right = "auto";
      this.bubble.style.bottom = "auto";
    };
    handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = () => { drag = null; };
  }

  update(state: { text: string; busy: boolean; visible: boolean; error?: string | null; canRetry?: boolean; taskStatus?: string; requestToEdit?: string; connectionFailure?:boolean; execution?:string; customConnection?:boolean }): void {
    this.latest = { ...state, error: state.error ?? "", canRetry: !!state.canRetry, taskStatus: state.taskStatus ?? "", requestToEdit: state.requestToEdit ?? "",connectionFailure:!!state.connectionFailure,execution:state.execution??"",customConnection:!!state.customConnection };
    if (this.frame || this.disposed) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      const { text, busy, visible, error } = this.latest;
      this.bubble.hidden = !visible || !(text || busy || error || this.latest.canRetry);
      this.body.textContent = error || (this.latest.taskStatus === "cancelled" ? t("board.taskCancelled") : boardReplyPlainText(text)) || (busy ? t("board.thinking") : "");
      this.bubble.setAttribute("aria-busy", String(busy));
      this.pin.disabled = busy || !!error || this.latest.taskStatus === "cancelled" || !text;
      this.stop.hidden = !busy;
      this.retry.hidden = !this.latest.canRetry;
      this.connection.hidden=!this.latest.connectionFailure;
      this.follow.hidden=!this.latest.connectionFailure || !this.latest.customConnection;
      this.execution.textContent=this.latest.execution;
      this.edit.hidden = !this.latest.requestToEdit;
      // Font loading never holds up the first streamed characters.
      if (visible && text) void ensureBoardFonts(this.element.ownerDocument, text).catch(() => undefined);
    });
  }

  showInput(): void {
    this.previousFocus = this.element.ownerDocument.activeElement as HTMLElement | null;
    this.composer.hidden = false;
    this.input.focus({ preventScroll: true });
  }
  hideInput(): void {
    this.composer.hidden = true;
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = null;
  }
  dispose(): void {
    this.disposed = true;
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.element.remove();
  }
}
