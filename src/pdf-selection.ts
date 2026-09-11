// Selection interactions for Obsidian's built-in PDF.js viewer. PDF context
// menus are handled by Obsidian/Electron before a bubbling listener on the
// workspace document can see them, so listeners live on the PDF container in
// the capture phase. A small selection action also makes annotation available
// without requiring a right-click (important on macOS trackpads).

import { setIcon } from "obsidian";
import {
  pdfSelectionActionPoint,
  selectionFromPdfView,
  type PdfSelectionPoint,
  type PdfTextSelection
} from "./pdf-annotation.js";

type PdfSelectionHandlers = {
  label: string;
  onAdd: (selection: PdfTextSelection, point: PdfSelectionPoint) => void;
  onContextMenu: (
    event: MouseEvent,
    selection: PdfTextSelection,
    point: PdfSelectionPoint
  ) => void;
};

export class PdfSelectionController {
  private container: HTMLElement | null = null;
  private eventRoot: HTMLElement | null = null;
  private handlers: PdfSelectionHandlers | null = null;
  private action: HTMLButtonElement | null = null;
  private timer: number | null = null;
  private observer: MutationObserver | null = null;
  private press: { x: number; y: number } | null = null;

  public dismiss(): void {
    this.cancelPendingAction();
    this.hideAction();
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    const selection = this.readSelection(
      event.target as Node | null,
      event.view?.getSelection() ?? null
    );
    if (!selection) return;

    // Obsidian's PDF viewer otherwise opens the native macOS/Electron menu,
    // which plugins cannot extend with an item of their own.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.hideAction();
    const point = { x: event.clientX, y: event.clientY };
    this.handlers?.onContextMenu(event, selection, point);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.press = { x: event.clientX, y: event.clientY };
    this.cancelPendingAction();
    this.hideAction();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const dragged = this.press && Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > 4;
    this.press = null;
    if (!dragged && this.highlightFromEvent(event)) {
      this.cancelPendingAction();
      this.hideAction();
      return;
    }
    const container = this.container;
    if (!container) return;
    const win = container.ownerDocument.defaultView ?? window;
    this.cancelPendingAction();
    // Selection state is finalized just after mouseup in PDF.js.
    this.timer = win.setTimeout(() => {
      this.timer = null;
      this.showAction(
        event.target as Node | null,
        event.view?.getSelection() ?? null
      );
    }, 0);
  };

  private readonly handleScroll = (): void => this.hideAction();

  public attach(container: HTMLElement, handlers: PdfSelectionHandlers): void {
    if (this.container === container) {
      this.handlers = handlers;
      if (this.action) this.setActionLabel(this.action, handlers.label);
      return;
    }
    this.detach();
    this.container = container;
    this.handlers = handlers;
    const MutationObserverCtor = container.ownerDocument.defaultView?.MutationObserver;
    if (MutationObserverCtor) {
      this.observer = new MutationObserverCtor(() => this.bindEventRoot());
      this.observer.observe(container, { childList: true, subtree: true });
    }
    this.bindEventRoot();
  }

  public detach(): void {
    this.cancelPendingAction();
    this.observer?.disconnect();
    this.observer = null;
    this.unbindEventRoot();
    this.hideAction();
    this.container = null;
    this.handlers = null;
  }

  private bindEventRoot(): void {
    const container = this.container;
    if (!container) return;
    // This is the exact element on which Obsidian installs its own async PDF
    // context-menu handler. Capturing here reliably runs before that handler.
    const next =
      container.querySelector<HTMLElement>(".pdf-viewer-container") ?? container;
    if (next === this.eventRoot) return;
    this.unbindEventRoot();
    this.eventRoot = next;
    next.addEventListener("contextmenu", this.handleContextMenu, true);
    next.addEventListener("pointerdown", this.handlePointerDown, true);
    next.addEventListener("pointerup", this.handlePointerUp, true);
    next.addEventListener("scroll", this.handleScroll, true);
  }

  private unbindEventRoot(): void {
    const root = this.eventRoot;
    if (!root) return;
    root.removeEventListener("contextmenu", this.handleContextMenu, true);
    root.removeEventListener("pointerdown", this.handlePointerDown, true);
    root.removeEventListener("pointerup", this.handlePointerUp, true);
    root.removeEventListener("scroll", this.handleScroll, true);
    this.eventRoot = null;
  }

  private cancelPendingAction(): void {
    if (this.timer === null) return;
    const win = this.container?.ownerDocument.defaultView ?? window;
    win.clearTimeout(this.timer);
    this.timer = null;
  }

  private highlightFromEvent(event: Event): HTMLElement | null {
    for (const target of event.composedPath()) {
      if (
        target instanceof HTMLElement &&
        target.matches(".atl-pdf-highlight[data-atl-id]")
      ) {
        return target;
      }
    }
    return null;
  }

  private readSelection(
    fallbackNode?: Node | null,
    suppliedSelection?: Selection | null
  ): PdfTextSelection | null {
    const container = this.container;
    if (!container) return null;
    const targetDocument = fallbackNode?.ownerDocument;
    return selectionFromPdfView(
      container,
      suppliedSelection ??
        targetDocument?.getSelection() ??
        container.ownerDocument.getSelection(),
      fallbackNode
    );
  }

  private showAction(
    fallbackNode?: Node | null,
    suppliedSelection?: Selection | null
  ): void {
    const container = this.container;
    const handlers = this.handlers;
    if (!container || !handlers) return;
    const selection = this.readSelection(fallbackNode, suppliedSelection);
    if (!selection) {
      this.hideAction();
      return;
    }
    const domSelection = suppliedSelection ??
      fallbackNode?.ownerDocument?.getSelection() ??
      container.ownerDocument.getSelection();
    if (!domSelection?.rangeCount) return;
    const range = domSelection.getRangeAt(domSelection.rangeCount - 1);
    const rects = [...range.getClientRects()].filter(
      (rect) => rect.width > 0 || rect.height > 0
    );
    const rect = rects.at(-1) ?? range.getBoundingClientRect();
    const doc = container.ownerDocument;
    const win = doc.defaultView ?? window;
    const point = pdfSelectionActionPoint(rect, win.innerWidth, win.innerHeight);

    this.hideAction();
    const action = doc.createElement("button");
    action.type = "button";
    action.className = "atl-pdf-selection-action clickable-icon";
    action.style.left = `${point.x}px`;
    action.style.top = `${point.y}px`;
    action.setAttribute("aria-label", handlers.label);
    this.setActionLabel(action, handlers.label);
    action.addEventListener("mousedown", (event) => {
      // Preserve the PDF selection until the saved snapshot reaches onAdd.
      event.preventDefault();
      event.stopPropagation();
    });
    action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.hideAction();
      handlers.onAdd(selection, point);
    });
    doc.body.appendChild(action);
    this.action = action;
  }

  private setActionLabel(action: HTMLButtonElement, label: string): void {
    action.replaceChildren();
    const icon = action.ownerDocument.createElement("span");
    icon.className = "atl-pdf-selection-action-icon";
    setIcon(icon, "highlighter");
    const text = action.ownerDocument.createElement("span");
    text.textContent = label;
    action.append(icon, text);
  }

  private hideAction(): void {
    this.action?.remove();
    this.action = null;
  }
}
