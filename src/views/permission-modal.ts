// The write/execute permission gate for the tutor chat. When the OpenCode
// agent asks to run a non-read-only tool (edit a file, run a command), this
// modal collects the learner's choice — allow once, always allow, or decline —
// and resolves the pending ACP request. Closing the modal counts as decline so
// a dismissed prompt can never wedge the session.

import { Modal, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { PermissionChoice } from "../acp-session.js";
import { t } from "../i18n.js";

export function openPermissionModal(
  app: App,
  tool: { kind?: string; title?: string },
  onResolve: (choice: PermissionChoice) => void
): void {
  const modal = new (class extends Modal {
    private answered = false;

    public override onOpen(): void {
      this.contentEl.empty();
      this.contentEl.addClass("atl-permission");
      this.titleEl.setText(t("perm.title"));

      const body = this.contentEl.createDiv({ cls: "atl-permission-body" });
      const icon = body.createDiv({ cls: "atl-permission-icon" });
      setIcon(icon, "shield-question");
      body.createEl("p", { text: t("perm.question") });
      const toolEl = body.createEl("p", { cls: "atl-permission-tool" });
      toolEl.setText(tool.title?.trim() || tool.kind || "tool");

      const actions = this.contentEl.createDiv({ cls: "atl-permission-actions" });
      const allow = actions.createEl("button", {
        cls: "mod-cta",
        text: t("perm.allowOnce")
      });
      allow.onclick = () => this.answer("allow_once");
      const always = actions.createEl("button", { text: t("perm.allowAlways") });
      always.onclick = () => this.answer("allow_always");
      const reject = actions.createEl("button", {
        cls: "mod-warning",
        text: t("perm.reject")
      });
      reject.onclick = () => this.answer("reject_once");
      allow.focus();
    }

    public override onClose(): void {
      // Dismissing without a button is a decline — the ACP request must
      // always be answered or the agent hangs.
      if (!this.answered) {
        this.answered = true;
        onResolve("reject_once");
      }
    }

    private answer(choice: PermissionChoice): void {
      if (this.answered) return;
      this.answered = true;
      onResolve(choice);
      this.close();
    }
  })(app);
  modal.open();
}
