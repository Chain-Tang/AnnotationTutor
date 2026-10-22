// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../src/i18n.js";
import type { CommunicationUiSpace, TutorCommunicationUi } from "../src/tutor-communication-modal.js";
import type { CommunicationMessage } from "../src/tutor-communication.js";

vi.mock("obsidian", () => {
  function element(tag = "div"): HTMLElement {
    const node = document.createElement(tag);
    Object.defineProperties(node, {
      empty: { value: () => node.replaceChildren() },
      createDiv: { value: () => { const child = element(); node.append(child); return child; } },
      createEl: { value: (name: string, options?: { text?: string; attr?: Record<string, string> }) => {
        const child = element(name); child.textContent = options?.text ?? "";
        for (const [key, value] of Object.entries(options?.attr ?? {})) child.setAttribute(key, value);
        node.append(child); return child;
      } },
    });
    return node;
  }
  class Modal {
    titleEl = element(); contentEl = element(); constructor(_app: unknown) {}
    onOpen(): void {} onClose(): void {} open() { this.onOpen(); } close() { this.onClose(); }
  }
  class Setting {
    row: HTMLElement; constructor(parent: HTMLElement) { this.row = element(); parent.append(this.row); }
    setName(name: string) { this.row.dataset.name = name; return this; } setDesc(_description: string) { return this; }
    addDropdown(callback: (control: unknown) => void) {
      const input = document.createElement("select"); this.row.append(input);
      const control = { addOption(key: string, label: string) { const option = document.createElement("option"); option.value = key; option.textContent = label; input.append(option); return control; }, setValue(value: string) { input.value = value; return control; }, onChange(handler: (value: string) => void) { input.addEventListener("change", () => handler(input.value)); return control; } };
      callback(control); return this;
    }
    addButton(callback: (control: unknown) => void) {
      const input = document.createElement("button"); this.row.append(input);
      const control = { setButtonText(text: string) { input.textContent = text; return control; }, setCta() { return control; }, setDisabled(value: boolean) { input.disabled = value; return control; }, onClick(handler: () => void) { input.addEventListener("click", handler); return control; } };
      callback(control); return this;
    }
    addText(callback: (control: unknown) => void) { return this.text("input", callback); }
    addTextArea(callback: (control: unknown) => void) { return this.text("textarea", callback); }
    private text(tag: "input" | "textarea", callback: (control: unknown) => void) {
      const input = document.createElement(tag); this.row.append(input);
      const control = { inputEl: input, onChange(handler: (value: string) => void) { input.addEventListener("input", () => handler(input.value)); return control; } };
      callback(control); return this;
    }
    addToggle(callback: (control: unknown) => void) {
      const input = document.createElement("input"); input.type = "checkbox"; this.row.append(input);
      const control = { setValue(value: boolean) { input.checked = value; return control; }, onChange(handler: (value: boolean) => void) { input.addEventListener("change", () => handler(input.checked)); return control; } };
      callback(control); return this;
    }
  }
  return { Modal, Setting };
});
import { TutorCommunicationModal } from "../src/tutor-communication-modal.js";

const modals: TutorCommunicationModal[] = [];
afterEach(() => { for (const modal of modals.splice(0)) modal.onClose(); vi.useRealTimers(); document.body.replaceChildren(); });
function space(spaceId: string): CommunicationUiSpace {
  const caller = { agentId: "caller", vaultId: "a", kind: "tutor" as const }, recipient = { agentId: "recipient", vaultId: "b", kind: "tutor" as const };
  return { key: `peer:${spaceId}`, label: spaceId, local: false, caller, space: { spaceId, title: spaceId, createdAt: 0, updatedAt: 0, membershipRevision: 1, members: [{ identity: caller, read: true, write: true }, { identity: recipient, read: true, write: true }], context: { goal: "Goal", background: "", summary: "", sources: [], revision: 1, updatedAt: 0, updatedBy: caller }, contextHistory: [] } };
}
function fixture(overrides: Partial<TutorCommunicationUi> = {}) {
  const ui: TutorCommunicationUi = { spaces: async () => [space("one"), space("two")], create: async () => {}, members: () => [], setMember: async () => {}, bindCodex: async () => "bound", openNote: async () => {}, send: vi.fn(async () => {}), messages: vi.fn(async () => []), peers: async () => [], connect: async () => {}, disconnect: async () => {}, ...overrides };
  const modal = new TutorCommunicationModal({} as never, ui); modals.push(modal); document.body.append(modal.contentEl); modal.onOpen();
  const input = () => modal.contentEl.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("upgrade.communicationMessage")}"]`)!;
  const choose = async (value: string) => {
    const select = [...modal.contentEl.querySelectorAll("select")].find(item => item.parentElement?.dataset.name === t("upgrade.communicationSpace"))!;
    select.value = `peer:${value}`; select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(modal.contentEl.querySelector("select")?.value).toBe(`peer:${value}`));
  };
  return { modal, ui, input, choose };
}
describe("collaboration modal lifecycle and space isolation", () => {
  it("does not start a polling timer or rebuild DOM after closing during an in-flight refresh", async () => {
    vi.useFakeTimers(); let finish!: (messages: CommunicationMessage[]) => void;
    const messages = vi.fn(() => new Promise<CommunicationMessage[]>(resolve => { finish = resolve; }));
    const f = fixture({ messages }); await vi.waitFor(() => expect(messages).toHaveBeenCalledOnce());
    f.modal.onClose(); finish([]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0); expect(f.modal.contentEl.children).toHaveLength(0);
  });
  it("keeps unsent drafts separate when switching collaboration spaces", async () => {
    const f = fixture(); await vi.waitFor(() => expect(f.input()).not.toBeNull());
    f.input().value = "Material intended for the first vault"; f.input().dispatchEvent(new Event("input"));
    await f.choose("two"); expect(f.input().value).toBe("");
    f.input().value = "A different message for the second vault"; f.input().dispatchEvent(new Event("input"));
    await f.choose("one"); expect(f.input().value).toBe("Material intended for the first vault");
    await f.choose("two"); expect(f.input().value).toBe("A different message for the second vault");
    expect(f.ui.send).not.toHaveBeenCalled();
  });
  it("offers the newly bound Codex as a recipient without reopening the window", async () => {
    const entry=space("one");entry.local=true;entry.key="local:one";
    const codex={agentId:"codex-one",vaultId:"codex",kind:"codex" as const};
    const f=fixture({spaces:async()=>[entry],bindCodex:async()=>{entry.space.members.push({identity:codex,read:true,write:true});return "bound";}});
    await vi.waitFor(()=>expect(f.input()).not.toBeNull());
    const button=[...f.modal.contentEl.querySelectorAll("button")].find(item=>item.textContent===t("upgrade.communicationCodex"))!;
    button.click();
    await vi.waitFor(()=>expect([...f.modal.contentEl.querySelectorAll("option")].some(option=>option.textContent?.includes("codex-one"))).toBe(true));
  });
});
