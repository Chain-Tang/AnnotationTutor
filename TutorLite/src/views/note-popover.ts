// A lightweight, Word-comment-style card shown when a marker is clicked. It is
// NOT an Obsidian Modal, so there is no dimming backdrop — the source text stays
// readable behind it. Dismisses on outside click or Escape.

import { setIcon, setTooltip } from "obsidian";
import { t } from "../i18n.js";
import type { Annotation } from "../model.js";

export type PopoverHandlers = {
  jump: () => void | Promise<void>;
  edit: () => void | Promise<void>;
  ask: () => void | Promise<void>;
  remove: () => void | Promise<void>;
};

export class NotePopover {
  private static current: NotePopover | null = null;

  private readonly el: HTMLElement;
  private readonly onDocMouseDown: (event: MouseEvent) => void;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  private constructor(
    anchor: HTMLElement,
    annotation: Annotation,
    handlers: PopoverHandlers
  ) {
    NotePopover.current?.close();
    NotePopover.current = this;

    this.el = document.body.createDiv({ cls: "atl-popover" });
    this.render(annotation, handlers);
    this.position(anchor);

    this.onDocMouseDown = (event) => {
      const target = event.target as Node;
      if (!this.el.contains(target) && !anchor.contains(target)) this.close();
    };
    this.onKeyDown = (event) => {
      if (event.key === "Escape") this.close();
    };
    // Defer so the click that opened the popover doesn't immediately close it.
    window.setTimeout(() => {
      document.addEventListener("mousedown", this.onDocMouseDown, true);
      document.addEventListener("keydown", this.onKeyDown, true);
    }, 0);
  }

  public static open(
    anchor: HTMLElement,
    annotation: Annotation,
    handlers: PopoverHandlers
  ): void {
    new NotePopover(anchor, annotation, handlers);
  }

  private render(annotation: Annotation, handlers: PopoverHandlers): void {
    const head = this.el.createDiv({ cls: "atl-popover-head" });
    head.createSpan({
      cls: `atl-chip atl-status-${annotation.status}`,
      text: annotation.status.replace(/_/g, " ")
    });

    this.el.createDiv({
      cls: "atl-popover-note",
      text: annotation.userNote || t("popover.noNote")
    });

    if (annotation.reviewText) {
      const review = this.el.createDiv({ cls: "atl-popover-review" });
      review.createEl("pre", { text: annotation.reviewText });
    }

    const bar = this.el.createDiv({ cls: "atl-iconbar" });
    this.iconButton(bar, "corner-up-right", t("action.jump"), handlers.jump);
    this.iconButton(bar, "pencil", t("action.edit"), handlers.edit);
    this.iconButton(bar, "sparkles", t("action.ask"), handlers.ask);
    this.iconButton(bar, "trash-2", t("action.delete"), handlers.remove, true);
  }

  private iconButton(
    container: HTMLElement,
    icon: string,
    tooltip: string,
    handler: () => void | Promise<void>,
    danger = false
  ): void {
    const button = container.createEl("button", {
      cls: danger ? "atl-iconbtn atl-iconbtn--danger" : "atl-iconbtn"
    });
    setIcon(button, icon);
    setTooltip(button, tooltip);
    button.onclick = () => {
      this.close();
      void handler();
    };
  }

  private position(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const pop = this.el.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    const maxLeft = window.innerWidth - pop.width - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    if (top + pop.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - pop.height - 6);
    }
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private close(): void {
    document.removeEventListener("mousedown", this.onDocMouseDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.el.remove();
    if (NotePopover.current === this) NotePopover.current = null;
  }
}
