import { t } from "./i18n/index.js";
// Shared plumbing for everything the content script injects into the page: the
// chrome stylesheet, the widget factories (buttons, toast), live-selection
// reading, and the Obsidian send channel. The highlight flow (content.ts) and
// the ask overlay (ask-overlay.ts) both build on this — feature logic lives
// elsewhere, this module is DOM chrome only.

import { MARK_CLASS, UI_CLASS } from "./anchor.js";
import type { SelectionMessage } from "./messages.js";
import type { CaptureSelection } from "./protocol.js";

let toastTimer: number | undefined;

/** Inject the highlight + chrome stylesheet once. Controls reset with all:unset. */
export function injectChromeStyles(): void {
  if (document.getElementById("atl-hl-style")) return;
  const style = document.createElement("style");
  style.id = "atl-hl-style";
  style.textContent = `
mark.${MARK_CLASS}{background-color:inherit;color:inherit;border-radius:2px;padding:0 1px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone}
mark.${MARK_CLASS}[data-atl-note]{text-decoration:underline dotted;text-underline-offset:3px}
mark.${MARK_CLASS}.atl-hl-flash{animation:atl-hl-flash 1.2s ease}
@keyframes atl-hl-flash{0%,100%{box-shadow:none}30%{box-shadow:0 0 0 3px rgba(124,58,237,.5)}}
.atl-hl-toolbar,.atl-hl-popover{position:absolute;z-index:2147483647;background:#1f2430;color:#e5e7eb;box-shadow:0 8px 24px rgba(0,0,0,.32);font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
.atl-hl-toolbar{display:none;align-items:center;gap:6px;padding:6px 8px;border-radius:12px}
.atl-hl-swatch{all:unset;width:18px;height:18px;border-radius:50%;cursor:pointer;box-sizing:border-box;border:2px solid rgba(255,255,255,.55);transition:transform .12s ease}
.atl-hl-swatch:hover{transform:scale(1.15)}
.atl-hl-sep{width:1px;align-self:stretch;margin:2px 0;background:rgba(255,255,255,.18)}
.atl-hl-btn{all:unset;display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:7px;color:#e5e7eb;background:rgba(255,255,255,.08);cursor:pointer;font:13px/1.2 system-ui,sans-serif;white-space:nowrap}
.atl-hl-btn:hover{background:rgba(255,255,255,.18)}
.atl-hl-btn-danger:hover{background:rgba(248,113,113,.28);color:#fecaca}
.atl-hl-popover{max-width:300px;padding:11px 13px;border-radius:12px}
.atl-hl-note{margin:0 0 9px;white-space:pre-wrap;word-break:break-word}
.atl-hl-note.empty{color:#94a3b8;font-style:italic}
.atl-hl-actions{display:flex;flex-wrap:wrap;gap:6px}
.atl-hl-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);z-index:2147483647;padding:8px 14px;border-radius:9px;background:#1f2430;color:#e5e7eb;box-shadow:0 8px 24px rgba(0,0,0,.32);font:13px/1.3 system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}
.atl-hl-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media (prefers-reduced-motion:reduce){.atl-hl-swatch,.atl-hl-toast{transition:none}mark.${MARK_CLASS}.atl-hl-flash{animation:none}}
`;
  (document.head ?? document.documentElement).appendChild(style);
}

/** A reset button styled as one of our chrome pills. */
export function mkButton(label: string, extraClass?: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = extraClass ? `atl-hl-btn ${extraClass}` : "atl-hl-btn";
  btn.textContent = label;
  return btn;
}

/** Show a brief bottom-centered toast (the content script has no badge surface). */
export function toast(message: string): void {
  let el = document.querySelector<HTMLElement>(".atl-hl-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = `${UI_CLASS} atl-hl-toast`;
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove("show"), 1600);
}

/** The active selection Range, or null when empty / inside our own chrome. */
export function currentSelectionRange(): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!sel.toString().trim()) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (el?.closest(`.${UI_CLASS}`)) return null;
  return range;
}

/** Ship selections to the service worker for the Obsidian capture channel. */
export async function sendToObsidian(selections: CaptureSelection[]): Promise<boolean> {
  const message: SelectionMessage = {
    type: "selection",
    selections,
    url: location.href,
    title: document.title
  };
  try {
    const result = await chrome.runtime.sendMessage(message) as { ok?: boolean };
    toast(t(result?.ok ? "content.sent" : "content.captureFailed"));
    return result?.ok === true;
  } catch {
    toast(t("content.captureFailed"));
    return false;
  }
}
