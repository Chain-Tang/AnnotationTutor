// The note editor as a draggable, no-backdrop floating panel. It is NOT an
// Obsidian Modal, so the original text stays fully visible; drag it by the thin
// top handle and edit while reading the source. Buttons are icons with tooltips.

import { Notice, setIcon, setTooltip } from "obsidian";
import { t } from "../i18n.js";

export type PanelSubmit = (
  note: string,
  askAgent: boolean
) => void | Promise<void>;

type IconVariant = "cta" | "danger" | undefined;

export type PanelOptions = {
  initialNote?: string;
  allowAsk: boolean;
  /** Where to first place the panel (e.g. near the selection). */
  anchor?: { x: number; y: number };
  onSubmit: PanelSubmit;
  onOpenSettings: () => void;
};

export class FloatingNotePanel {
  private static current: FloatingNotePanel | null = null;

  private readonly el: HTMLElement;
  private note: string;
  private submitted = false;
  private dragOffset: { x: number; y: number } | null = null;

  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onDragMove: (event: MouseEvent) => void;
  private readonly onDragEnd: () => void;

  private constructor(private readonly options: PanelOptions) {
    FloatingNotePanel.current?.close();
    FloatingNotePanel.current = this;
    this.note = options.initialNote ?? "";

    this.el = document.body.createDiv({ cls: "atl-float-panel" });

    this.onDragMove = (event) => this.handleDragMove(event);
    this.onDragEnd = () => this.handleDragEnd();
    this.onKeyDown = (event) => {
      if (event.key === "Escape") this.close();
    };

    const textarea = this.render();
    this.position();
    document.addEventListener("keydown", this.onKeyDown, true);
    window.setTimeout(() => textarea.focus(), 0);
  }

  public static open(options: PanelOptions): void {
    new FloatingNotePanel(options);
  }

  private render(): HTMLTextAreaElement {
    const bar = this.el.createDiv({ cls: "atl-float-bar" });
    bar.createSpan({ cls: "atl-float-grip" });
    bar.addEventListener("mousedown", (event) => this.handleDragStart(event));

    const textarea = this.el.createEl("textarea", { cls: "atl-textarea" });
    textarea.value = this.note;
    textarea.placeholder = t("panel.placeholder");
    textarea.addEventListener("input", () => {
      this.note = textarea.value;
    });

    const actions = this.el.createDiv({ cls: "atl-iconbar atl-float-actions" });
    this.iconButton(actions, "settings", t("panel.settings"), () =>
      this.options.onOpenSettings()
    );
    actions.createDiv({ cls: "atl-spacer" });
    this.iconButton(actions, "check", t("panel.save"), () => this.submit(false), "cta");
    if (this.options.allowAsk) {
      this.iconButton(actions, "sparkles", t("panel.saveAndAsk"), () =>
        this.submit(true)
      );
    }
    this.iconButton(actions, "x", t("panel.cancel"), () => this.close());
    return textarea;
  }

  private iconButton(
    container: HTMLElement,
    icon: string,
    tooltip: string,
    handler: () => void | Promise<void>,
    variant: IconVariant = undefined
  ): void {
    const cls = variant ? `atl-iconbtn atl-iconbtn--${variant}` : "atl-iconbtn";
    const button = container.createEl("button", { cls });
    setIcon(button, icon);
    setTooltip(button, tooltip);
    button.onclick = () => void handler();
  }

  private async submit(askAgent: boolean): Promise<void> {
    if (this.submitted) return;
    const note = this.note.trim();
    if (!note) {
      new Notice(t("notice.writeFirst"));
      return;
    }
    // Close first so a long-running submit (auto-run agent) can't be triggered
    // again by a second click, which would create a duplicate annotation.
    this.submitted = true;
    this.close();
    await this.options.onSubmit(note, askAgent);
  }

  // --- dragging --------------------------------------------------------------

  private handleDragStart(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = this.el.getBoundingClientRect();
    this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    document.addEventListener("mousemove", this.onDragMove, true);
    document.addEventListener("mouseup", this.onDragEnd, true);
    event.preventDefault();
  }

  private handleDragMove(event: MouseEvent): void {
    if (!this.dragOffset) return;
    const left = clamp(
      event.clientX - this.dragOffset.x,
      0,
      window.innerWidth - this.el.offsetWidth
    );
    const top = clamp(
      event.clientY - this.dragOffset.y,
      0,
      window.innerHeight - this.el.offsetHeight
    );
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private handleDragEnd(): void {
    this.dragOffset = null;
    document.removeEventListener("mousemove", this.onDragMove, true);
    document.removeEventListener("mouseup", this.onDragEnd, true);
  }

  private position(): void {
    const width = this.el.offsetWidth;
    const height = this.el.offsetHeight;
    const anchor = this.options.anchor;
    const left = clamp(
      anchor ? anchor.x : (window.innerWidth - width) / 2,
      8,
      window.innerWidth - width - 8
    );
    const top = clamp(
      anchor ? anchor.y + 8 : (window.innerHeight - height) / 3,
      8,
      window.innerHeight - height - 8
    );
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private close(): void {
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.handleDragEnd();
    this.el.remove();
    if (FloatingNotePanel.current === this) FloatingNotePanel.current = null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
