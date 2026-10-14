import { Modal, type App } from "obsidian";
import { t } from "./i18n.js";
import { mountSupportPanel } from "./support-panel.js";
import type { SupportSession } from "./support-session.js";

const openDialogs = new WeakMap<SupportSession, SupportModal>();

/** Explicit privacy choice. Normal Tutor chat and its draft remain untouched. */
export function openSupportDialog(app: App, session: SupportSession, days: () => number, draft?: string): void {
  const existing = openDialogs.get(session);
  if (existing) { existing.focusInput(); return; }
  const modal = new SupportModal(app, session, days, draft);
  openDialogs.set(session, modal);
  modal.open();
}

class SupportModal extends Modal {
  private cleanup?: () => void;
  private unsubscribe?: () => void;
  constructor(app: App, private session: SupportSession, private days: () => number, private draft?: string) { super(app); }
  override onOpen(): void {
    this.modalEl.classList.add("atl-support-private", "atl-support-modal");
    this.titleEl.textContent = t("upgrade.supportOpen");
    this.session.open();
    this.cleanup = mountSupportPanel(this.contentEl, this.session, { quiet: () => true, days: this.days });
    const input = this.contentEl.querySelector("textarea");
    if (input && this.draft) input.value = this.draft;
    this.unsubscribe = this.session.subscribe(() => { if (!this.session.opened) this.close(); });
    this.focusInput();
  }
  focusInput(): void { this.contentEl.querySelector("textarea")?.focus(); }
  override onClose(): void {
    openDialogs.delete(this.session);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.cleanup?.(); this.cleanup = undefined;
    this.session.close();
    this.draft = undefined;
    this.contentEl.empty();
  }
}
