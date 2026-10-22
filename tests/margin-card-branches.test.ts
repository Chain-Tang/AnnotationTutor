// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Notice: class {}, addIcon: vi.fn(), setIcon: vi.fn(), setTooltip: vi.fn() }));
import { buildMarginCard, disposeMarginCard, flushMarginConversationDrafts, marginReplyTarget, setMarginCardHandlers, type AnnotationReplyProgressHandler, type DialogueReplyResult, type MarginCardHandlers } from "../src/margin-card.js";
import type { AnchorMark } from "../src/decorations-plan.js";
import { CardPool } from "../src/card-pool.js";
const root: AnchorMark = { id: "A", blockId: "block", selectedText: "source", note: "root note", review: "Tutor original reply", dialogue: [
  { role: "agent", id: "old-reply", text: "Old exact reply", at: "2026-10-20" }
] };
const child: AnchorMark = { id: "B", blockId: "block", selectedText: "source", note: "", branch: {
  parentAnnotationId: "A", rootAnnotationId: "A", sourceVersion: "source-v1",
  parentReply: { id: "review", kind: "review", version: "v1", text: root.review! }
}, request: { id: "request-B", status: "draft", question: "", updatedAt: "2026-10-20" } };
const cards: HTMLElement[] = [];
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "createEl", { configurable: true, value(tag: string, options: { cls?: string }) {
    const el = document.createElement(tag); el.className = options.cls ?? ""; this.append(el); return el;
  } });
});
afterEach(() => { for (const card of cards.splice(0)) disposeMarginCard(card); setMarginCardHandlers(null); document.body.replaceChildren(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(extra: Partial<MarginCardHandlers> = {}, mark = root, options: Partial<Parameters<typeof buildMarginCard>[1]> = {}) {
  let marks: AnchorMark[] = [mark];
  const h: MarginCardHandlers = { save: vi.fn(), ask: vi.fn(), discuss: vi.fn(), reply: vi.fn(async () => ({ ok: true, agentText: "Saved reply" })),
    render: (el, text) => { el.textContent = text; }, saveCell: vi.fn(), remove: vi.fn(), settings: vi.fn(),
    createConversation: vi.fn(async () => { marks = [root, child]; return { id: "B" }; }),
    saveDraft: vi.fn(async () => {}), graphCards: () => marks, openAnnotation: vi.fn(), openGraph: vi.fn(), ...extra };
  if (!("continueDialogue" in extra)) h.continueDialogue = vi.fn(async () => ({ ok: true, agentText: "Continued reply" }));
  if (!("saveDialogueDraft" in extra)) h.saveDialogueDraft = vi.fn(async () => {});
  setMarginCardHandlers(h);
  const { card } = buildMarginCard(mark, { skin: { id: "flat", quiet: false, tilt: null }, geom: { dx: 0, dy: 0 }, showReview: true, onCollapse: vi.fn(), onDragMove: vi.fn(), inlineWorkflow: true, ...options });
  cards.push(card); document.body.append(card); return { card, h };
}

describe("manual annotation conversation branches", () => {
  it("places the independent branch toggle after local dialogue and keeps review separate from memory saving",()=>{
    const {card,h}=fixture();
    const head=card.querySelector<HTMLElement>(".atl-rail-card-head")!;
    const review=head.querySelector<HTMLButtonElement>(".atl-review-action")!;
    const dialogue=head.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    const branches=head.querySelector<HTMLButtonElement>(".atl-branches-toggle")!;
    const actions=[...head.querySelectorAll("button")];
    expect(actions.indexOf(review)).toBe(actions.indexOf(dialogue)-1);
    expect(actions.indexOf(branches)).toBe(actions.indexOf(dialogue)+1);
    const listener=vi.fn();card.addEventListener("atl-branches-toggle",listener);
    branches.click();expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({id:root.id});
    expect(card.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(true);
    expect(h.ask).not.toHaveBeenCalled();expect(h.saveCell).not.toHaveBeenCalled();
    review.click();expect(h.ask).toHaveBeenCalledWith(root.id,root.note);expect(h.saveCell).not.toHaveBeenCalled();
  });
  it("restores the bounded cause after reopening and updates it after a failed retry",async()=>{
    const mark:AnchorMark={...root,dialogueRequest:{id:"depth",status:"failed",question:"Saved follow-up",updatedAt:"2026-10-20",errorCode:"annotation-reply-protocol"}};
    const {card}=fixture({continueDialogue:vi.fn(async()=>({ok:false,errorCode:"annotation-reply-connection",error:"PRIVATE_RAW_ERROR"}))},mark);
    const input=card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    expect(input.value).toBe("Saved follow-up");expect(card.textContent).toContain("回复格式不完整");
    card.querySelector<HTMLButtonElement>(".atl-rail-reply-send")!.click();await flush();
    expect(card.textContent).toContain("连接中断");expect(card.textContent).not.toContain("PRIVATE_RAW_ERROR");expect(input.value).toBe("Saved follow-up");
  });
  it("uses the header only to disclose this card's own continuous conversation", () => {
    const {card,h}=fixture({graphCards:()=>[root,child]});
    const toggle=card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    const conversation=card.querySelector<HTMLElement>(".atl-card-conversation")!;
    const events: unknown[] = [];
    card.addEventListener("atl-branches-toggle", event => events.push((event as CustomEvent).detail));
    expect(conversation.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector(".atl-rail-dialogue")?.parentElement).toBe(conversation);
    expect(card.querySelector(".atl-branches, .atl-branch-detail, .atl-branches-graph")).toBeNull();
    expect([...card.querySelectorAll("button")].some(button=>button.textContent==="创建对话")).toBe(false);
    toggle.click();
    expect(conversation.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();expect(conversation.hidden).toBe(true);
    expect(events).toEqual([]);
    expect(h.openGraph).not.toHaveBeenCalled();
    expect(h.createConversation).not.toHaveBeenCalled();
  });
  it("does not couple dialogue disclosure to tree updates or branch creation", () => {
    const {card}=fixture();
    const toggle=card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    const onToggle = vi.fn(); card.addEventListener("atl-branches-toggle", onToggle);
    card.dispatchEvent(new CustomEvent("atl-set-conversation-open", { detail: { open: true } }));
    card.dispatchEvent(new CustomEvent("atl-conversation-created", { bubbles: true, detail: { id: "new-child" } }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(true);
    expect(onToggle).not.toHaveBeenCalled();
  });
  it("uses natural collapsed height and restores the remembered expanded size",()=>{
    fixture();
    const {card}=buildMarginCard({...root,id:"sized-root"},{skin:{id:"flat",quiet:false,tilt:null},geom:{dx:0,dy:0,w:354,h:454},showReview:true,onCollapse:vi.fn(),onDragMove:vi.fn()});
    cards.push(card);document.body.append(card);
    const toggle=card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    expect(card.style.width).toBe("354px");expect(card.style.height).toBe("");
    toggle.click();expect(card.style.height).toBe("454px");
    toggle.click();expect(card.style.height).toBe("");
    expect(card.style.width).toBe("354px");
  });
  it("leaves source cards free of nested branch panels and internal creation ports", () => {
    const { card, h } = fixture();
    expect(h.createConversation).not.toHaveBeenCalled();
    expect(card.querySelector<HTMLElement>(".atl-rail-reply-row")!.hidden).toBe(false);
    expect(card.querySelector(".atl-branch-port, .atl-branch-detail, .atl-branches")).toBeNull();
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!.value).toBe(root.note);
    expect(card.querySelector(".atl-rail-review")?.textContent).toBe(root.review);
  });
  it("keeps the legacy exact-reply actions only for dedicated graph details", async () => {
    const { card, h } = fixture({}, root, { showBranches: false, inlineWorkflow: false });
    const port=card.querySelector<HTMLButtonElement>(".atl-branch-port")!;
    expect(port.textContent).toBe("+");expect(port.getAttribute("aria-label")).toBe("创建分支");
    port.click(); await flush();
    expect(h.createConversation).toHaveBeenCalledWith("A", { kind: "dialogue", turnId: "old-reply", turnIndex: 0 });
    expect(h.openAnnotation).toHaveBeenCalledWith("B");
    expect(card.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(true);
    const oldAction = card.querySelector<HTMLButtonElement>(".atl-rail-thread .atl-branch-create")!;
    oldAction.click(); await flush();
    expect(h.createConversation).toHaveBeenLastCalledWith("A", { kind: "dialogue", turnId: "old-reply", turnIndex: 0 });
  });
  it("shows a new child as an original-style question card without draft or provenance labels", () => {
    const { card } = fixture({}, child);
    const editor = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    expect(editor.parentElement).toBe(card);
    expect(editor.placeholder).toBe("输入你的问题");
    expect(editor.value).toBe("");
    expect(card.querySelector(".atl-branch-provenance, .atl-branch-origin, .atl-branch-detail")).toBeNull();
    expect(card.querySelector<HTMLElement>(".atl-branch-status")!.hidden).toBe(true);
    expect(card.textContent).not.toMatch(/新对话草稿|草稿会自动保存|关联的 Tutor 回复|衍生自/);
    expect(card.querySelector(".atl-rail-card-head")).not.toBeNull();
    expect(card.querySelector(".atl-branch-port")).toBeNull();
  });
  it("autosaves then sends the existing card and cannot send a second answer", async () => {
    const { card, h } = fixture({}, child);
    const editor = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    editor.value = "What does division mean?"; editor.dispatchEvent(new Event("input"));
    card.querySelector<HTMLButtonElement>(".atl-branch-send")!.click(); await flush();
    expect(h.saveDraft).toHaveBeenCalledWith("B", "What does division mean?");
    expect(h.reply).toHaveBeenCalledWith("B", "What does division mean?", expect.any(Function));
    expect(h.createConversation).not.toHaveBeenCalled();
    expect(editor.readOnly).toBe(true);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush();
    expect(h.reply).toHaveBeenCalledOnce();
    expect(card.querySelector(".atl-rail-review")?.textContent).toBe("Saved reply");
    expect(card.querySelector<HTMLElement>(".atl-branch-send-row")!.hidden).toBe(true);
    expect(card.querySelector(".atl-branch-status")?.textContent).toBe("");
    expect(card.querySelector(".atl-branch-port")).toBeNull();
  });
  it("flushes focused input durably before the debounce expires during upgrade", async () => {
    vi.useFakeTimers();
    const { card, h } = fixture({}, child);
    const editor = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    editor.focus(); editor.value = "The last 350 milliseconds"; editor.dispatchEvent(new Event("input"));
    expect(h.saveDraft).not.toHaveBeenCalled();
    await flushMarginConversationDrafts();
    expect(h.saveDraft).toHaveBeenCalledWith("B", "The last 350 milliseconds");
    expect(h.reply).not.toHaveBeenCalled();
  });
  it("retains a failed question and retries the same child without exposing protocol details", async () => {
    const reply = vi.fn().mockResolvedValueOnce({ ok: false, error: "teaching-reply-string-required" }).mockResolvedValueOnce({ ok: true, agentText: "Recovered" });
    const { card, h } = fixture({ reply }, child);
    const editor = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!; editor.value = "Saved question";
    const send = card.querySelector<HTMLButtonElement>(".atl-branch-send")!;
    send.click(); await flush();
    expect(editor.value).toBe("Saved question");
    expect(card.textContent).toContain("问题已保存，可重试"); expect(card.textContent).not.toContain("teaching-reply-string-required");
    send.click(); await flush();
    expect(reply.mock.calls).toEqual([["B", "Saved question", expect.any(Function)], ["B", "Saved question", expect.any(Function)]]);
    expect(h.createConversation).not.toHaveBeenCalled();
  });
  it("does not call Tutor if saving the question fails", async () => {
    const { card, h } = fixture({ saveDraft: vi.fn(async () => { throw new Error("disk full"); }) }, child);
    const editor = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!; editor.value = "Keep this question";
    card.querySelector<HTMLButtonElement>(".atl-branch-send")!.click(); await flush();
    expect(h.reply).not.toHaveBeenCalled(); expect(editor.value).toBe("Keep this question");
    expect(card.textContent).toContain("草稿保存失败，尚未发送");
  });
  it.each(["completed", "archived"] as const)("keeps %s cards read-only without a send footer", status => {
    const mark: AnchorMark = { ...child, review: "Existing answer", request: { ...child.request!, status: "completed" } };
    if (status === "archived") mark.status = "archived";
    const { card } = fixture({}, mark);
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!.readOnly).toBe(true);
    expect(card.querySelector<HTMLButtonElement>(".atl-branch-send")!.hidden).toBe(true);
    expect(card.querySelector<HTMLElement>(".atl-branch-send-row")!.hidden).toBe(true);
    expect(card.querySelector(".atl-rail-review")?.textContent).toBe("Existing answer");
  });
  it("updates a stale parent without losing the saved question or creating a card", async () => {
    const refreshParent = vi.fn(async () => {});
    const { card, h } = fixture({ refreshParent }, { ...child, note: "Unanswered question", request: {
      ...child.request!, status: "failed", errorCode: "annotation-parent-reply-changed"
    } });
    card.querySelector<HTMLButtonElement>(".atl-branch-refresh-parent")!.click(); await flush();
    expect(refreshParent).toHaveBeenCalledWith("B");
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!.value).toBe("Unanswered question");
    expect(h.createConversation).not.toHaveBeenCalled();
    expect(card.textContent).toContain("关联已更新");
  });
  it("keeps the focused branch question through source-rail refresh", async () => {
    const { h } = fixture({ graphCards: () => [root, child] });
    setMarginCardHandlers(h);
    const pool = new CardPool();
    const options = { skin: { id: "flat", quiet: false, tilt: null } as const, geom: { dx: 0, dy: 0 }, showReview: true, onCollapse: vi.fn(), onDragMove: vi.fn(), inlineWorkflow: true };
    const card = pool.get(child, options); document.body.appendChild(card);
    const editor = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    editor.focus(); editor.value = "Draft being typed"; editor.dispatchEvent(new Event("input"));
    expect(pool.get({ ...child, note: "Older disk snapshot" }, options)).toBe(card);
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("Draft being typed");
    pool.clear(); await flush();
    expect(h.saveDraft).toHaveBeenCalledWith("B", "Draft being typed");
  });
  it("preserves the initial question when the child header toggles its dialogue",async()=>{
    const {card,h}=fixture({},child);
    const toggle=card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    const question=card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    question.focus();question.value="Continue this exact branch";question.dispatchEvent(new Event("input"));
    toggle.click();toggle.click();
    expect(card.querySelector(".atl-rail-edit")).toBe(question);
    expect(document.activeElement).toBe(question);
    expect(question.value).toBe("Continue this exact branch");
    await flushMarginConversationDrafts();
    expect(h.saveDraft).toHaveBeenCalledWith("B","Continue this exact branch");
    expect(h.reply).not.toHaveBeenCalled();
  });

  it("continues multiple questions within the same card without creating breadth or overwriting its review", async () => {
    const { card, h } = fixture();
    card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const input = card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    const send = card.querySelector<HTMLButtonElement>(".atl-rail-reply-send")!;
    input.value = "Why does this follow?"; input.dispatchEvent(new Event("input"));
    send.click(); await flush();
    input.value = "Could you explain that more deeply?"; input.dispatchEvent(new Event("input"));
    send.click(); await flush();
    expect(h.continueDialogue).toHaveBeenNthCalledWith(1, "A", "Why does this follow?", expect.any(Function));
    expect(h.continueDialogue).toHaveBeenNthCalledWith(2, "A", "Could you explain that more deeply?", expect.any(Function));
    expect(h.saveDialogueDraft).toHaveBeenNthCalledWith(1, "A", "Why does this follow?");
    expect(h.saveDialogueDraft).toHaveBeenNthCalledWith(2, "A", "Could you explain that more deeply?");
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.createConversation).not.toHaveBeenCalled();
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!.value).toBe(root.note);
    expect(card.querySelector(".atl-rail-review")!.textContent).toBe(root.review);
    expect(card.querySelectorAll(".atl-rail-turn--user")).toHaveLength(2);
    expect(card.querySelectorAll(".atl-rail-turn--agent")).toHaveLength(3);
    expect(input.value).toBe("");
    await flushMarginConversationDrafts();
    expect(h.saveDialogueDraft).toHaveBeenCalledTimes(2);
  });

  it("enables same-card followups after a child's first answer and keeps the initial input read-only", async () => {
    const { card, h } = fixture({}, child);
    const row = card.querySelector<HTMLElement>(".atl-rail-reply-row")!;
    expect(row.hidden).toBe(true);
    const question = card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")!;
    question.value = "Initial branch question";
    card.querySelector<HTMLButtonElement>(".atl-branch-send")!.click(); await flush();
    expect(question.readOnly).toBe(true);
    expect(row.hidden).toBe(false);
    card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const followup = card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    followup.value = "A deeper question about this answer";
    card.querySelector<HTMLButtonElement>(".atl-rail-reply-send")!.click(); await flush();
    expect(h.reply).toHaveBeenCalledOnce();
    expect(h.continueDialogue).toHaveBeenCalledWith("B", "A deeper question about this answer", expect.any(Function));
    expect(question.value).toBe("Initial branch question");
    expect(card.querySelector(".atl-rail-review")!.textContent).toBe("Saved reply");
    expect([...card.children].indexOf(card.querySelector(".atl-rail-review")!)).toBeLessThan([...card.children].indexOf(card.querySelector(".atl-card-conversation")!));
    expect(h.createConversation).not.toHaveBeenCalled();
  });

  it("restores a failed durable followup, retries once at a time, and hides technical errors", async () => {
    let resolve!: (value: { ok: boolean; agentText: string }) => void;
    const continuation = vi.fn().mockResolvedValueOnce({ ok: false, error: "teaching-reply-string-required" })
      .mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    const { card, h } = fixture({ continueDialogue: continuation }, { ...root, dialogueRequest: {
      id: "depth-1", question: "Persisted deeper question", status: "interrupted", updatedAt: "2026-10-20"
    } });
    card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const input = card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    expect(input.value).toBe("Persisted deeper question");
    expect(card.textContent).toContain("问题已保存，可重试");
    const send = card.querySelector<HTMLButtonElement>(".atl-rail-reply-send")!;
    send.click(); await flush();
    expect(input.value).toBe("Persisted deeper question");
    expect(card.textContent).not.toContain("teaching-reply-string-required");
    send.click(); await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush();
    expect(continuation).toHaveBeenCalledTimes(2);
    resolve({ ok: true, agentText: "Recovered answer" }); await flush();
    expect(input.value).toBe("");
    expect(card.querySelectorAll(".atl-rail-turn--user")).toHaveLength(1);
    expect(card.textContent).toContain("Recovered answer");
    expect(h.createConversation).not.toHaveBeenCalled();
  });

  it("flushes same-card drafts before shutdown and blocks Tutor if saving fails", async () => {
    vi.useFakeTimers();
    const saveDialogueDraft = vi.fn(async () => { throw new Error("disk unavailable"); });
    const { card, h } = fixture({ saveDialogueDraft });
    card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const input = card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    input.value = "Keep this reasoning question"; input.dispatchEvent(new Event("input"));
    card.querySelector<HTMLButtonElement>(".atl-rail-reply-send")!.click(); await flush();
    expect(h.continueDialogue).not.toHaveBeenCalled();
    expect(input.value).toBe("Keep this reasoning question");
    expect(card.textContent).toContain("草稿保存失败，尚未发送");
  });

  it("saves a focused followup draft even before its debounce window expires", async () => {
    vi.useFakeTimers();
    const { card, h } = fixture();
    card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const input = card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!;
    input.focus(); input.value = "Unsent continuation"; input.dispatchEvent(new Event("input"));
    await flushMarginConversationDrafts();
    expect(h.saveDialogueDraft).toHaveBeenCalledWith("A", "Unsent continuation");
    expect(h.continueDialogue).not.toHaveBeenCalled();
  });

  it("restores generating state without resending and permits old conversations in archived cards", async () => {
    const { card, h } = fixture({}, { ...root, dialogueRequest: {
      id: "active", question: "Saved pending question", status: "generating", updatedAt: "2026-10-20"
    } });
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!.readOnly).toBe(true);
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!.disabled).toBe(false);
    card.querySelector<HTMLButtonElement>(".atl-rail-reply-send")!.click(); await flush();
    expect(h.continueDialogue).not.toHaveBeenCalled();
    const archived = fixture({}, { ...root, id: "archived", status: "archived" }).card;
    expect(archived.querySelector<HTMLElement>(".atl-rail-reply-row")!.hidden).toBe(true);
    expect(archived.querySelector(".atl-rail-thread")!.textContent).toContain("Old exact reply");
  });

  it("keeps card-local dialogue disclosure independent across parent and child", () => {
    const parent = fixture().card;
    const branch = fixture({}, { ...child, review: "Initial child answer", request: { ...child.request!, status: "completed" } }).card;
    parent.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    expect(parent.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(false);
    expect(branch.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(true);
    branch.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    parent.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    expect(branch.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(false);
    expect(branch.querySelector<HTMLElement>(".atl-rail-reply-row")!.hidden).toBe(false);
  });

  it("branches from the latest completed depth answer and blocks origins while a new reply is generating", () => {
    expect(marginReplyTarget(root)).toEqual({ kind: "dialogue", turnId: "old-reply", turnIndex: 0 });
    expect(marginReplyTarget({ ...root, dialogue: [] })).toEqual({ kind: "review" });
    expect(marginReplyTarget({ ...root, dialogueRequest: { id: "pending", question: "More", status: "generating", updatedAt: "2026-10-20" } })).toBeUndefined();
  });

  it.each([
    ["initial", true], ["initial", false], ["continuation", true], ["continuation", false]
  ] as const)("shows automatic reconnection for %s and preserves the question when success is %s", async (mode, success) => {
    let resolve!: (value: DialogueReplyResult) => void;
    let onProgress!: AnnotationReplyProgressHandler;
    const request = vi.fn<MarginCardHandlers["reply"]>((_id, _message, progress) => {
      onProgress = progress!;
      return new Promise(done => { resolve = done; });
    });
    const { card, h } = fixture(mode === "initial" ? { reply: request } : { continueDialogue: request }, mode === "initial" ? child : root);
    if (mode === "continuation") card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    const input = card.querySelector<HTMLTextAreaElement>(mode === "initial" ? ".atl-rail-edit" : ".atl-rail-reply")!;
    const button = card.querySelector<HTMLButtonElement>(mode === "initial" ? ".atl-branch-send" : ".atl-rail-reply-send")!;
    const status = card.querySelector<HTMLElement>(mode === "initial" ? ".atl-branch-status" : ".atl-rail-dialogue-status")!;
    input.value = "Keep my exact question";
    input.dispatchEvent(new Event("input"));
    button.click(); await flush();
    expect(mode === "initial" ? h.saveDraft : h.saveDialogueDraft).toHaveBeenCalledWith(mode === "initial" ? "B" : "A", input.value);
    onProgress({ type: "reconnecting", attempt: 1 });
    expect(status.textContent).toBe("连接短暂中断，正在自动重连…");
    expect(status.hidden).toBe(false);
    expect(input.readOnly).toBe(true); expect(input.disabled).toBe(false); expect(button.disabled).toBe(true);
    expect(input.value).toBe("Keep my exact question");
    button.click(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush();
    expect(request).toHaveBeenCalledOnce();
    expect(h.createConversation).not.toHaveBeenCalled();
    resolve(success ? { ok: true, agentText: "Answer after recovery" } : { ok: false, errorCode: "annotation-reply-connection" });
    await flush();
    if (success) {
      expect(status.hidden).toBe(true);
      expect(card.textContent).toContain("Answer after recovery");
      expect(input.value).toBe(mode === "initial" ? "Keep my exact question" : "");
    } else {
      expect(status.textContent).toBe("连接中断，问题已保存，可重试。");
      expect(input.value).toBe("Keep my exact question");
      expect(input.readOnly).toBe(false);
      expect(card.textContent).not.toContain("Answer after recovery");
    }
    expect(button.disabled).toBe(false);
    onProgress({ type: "reconnecting", attempt: 1 });
    expect(status.textContent).not.toContain("正在自动重连");
  });

  it.each(["initial", "continuation"] as const)("keeps the local %s request card alive through index refresh while its saved question remains copyable", async mode => {
    let resolve!: (value: { ok: boolean; agentText: string }) => void;
    const request = vi.fn(() => new Promise<{ ok: boolean; agentText: string }>(done => { resolve = done; }));
    fixture(mode === "initial" ? { reply: request } : { continueDialogue: request });
    const pool = new CardPool();
    const mark = mode === "initial" ? child : root;
    const options = { skin: { id: "flat", quiet: false, tilt: null } as const, geom: { dx: 0, dy: 0 }, showReview: true, onCollapse: vi.fn(), onDragMove: vi.fn(), inlineWorkflow: true };
    const card = pool.get(mark, options); document.body.appendChild(card);
    const input = card.querySelector<HTMLTextAreaElement>(mode === "initial" ? ".atl-rail-edit" : ".atl-rail-reply")!;
    if (mode === "continuation") card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click();
    input.value = "Local in-flight question"; input.focus();
    card.querySelector<HTMLButtonElement>(mode === "initial" ? ".atl-branch-send" : ".atl-rail-reply-send")!.click(); await flush();
    input.blur();
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    input.setSelectionRange(0, 5);
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("Local");
    expect(card.dataset["localRequest"]).toBe("true");
    const pending = { id: "pending", question: input.value, status: "generating" as const, updatedAt: "2026-10-20" };
    const snapshot = mode === "initial" ? { ...mark, request: pending } : { ...mark, dialogueRequest: pending };
    expect(pool.get(snapshot, options)).toBe(card);
    resolve({ ok: true, agentText: "Completed locally" }); await flush();
    expect(card.dataset["localRequest"]).toBeUndefined();
    expect(card.textContent).toContain("Completed locally");
    input.blur();
    const completed = { ...pending, status: "completed" as const };
    const finalSnapshot = mode === "initial" ? { ...mark, request: completed, review: "Completed locally" }
      : { ...mark, dialogueRequest: completed, dialogue: [...(mark.dialogue ?? []), { id: "fresh", role: "agent" as const, text: "Completed locally", at: "2026-10-20" }] };
    expect(pool.get(finalSnapshot, options)).not.toBe(card);
    pool.clear(); await flush();
  });

  it("refreshes a persisted generating card after external completion instead of preserving read-only stale DOM", () => {
    fixture();
    const pool = new CardPool();
    const options = { skin: { id: "flat", quiet: false, tilt: null } as const, geom: { dx: 0, dy: 0 }, showReview: true, onCollapse: vi.fn(), onDragMove: vi.fn(), inlineWorkflow: true };
    const pending = { id: "external", question: "Externally pending", status: "generating" as const, updatedAt: "2026-10-20" };
    const card = pool.get({ ...root, dialogueRequest: pending }, options); document.body.appendChild(card);
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!.readOnly).toBe(true);
    expect(card.dataset["localRequest"]).toBeUndefined();
    const updated = pool.get({ ...root, dialogueRequest: { ...pending, status: "completed" }, dialogue: [
      ...(root.dialogue ?? []), { id: "external-answer", role: "agent", text: "External finished answer", at: "2026-10-20" }
    ] }, options);
    expect(updated).not.toBe(card);
    expect(updated.querySelector<HTMLTextAreaElement>(".atl-rail-reply")!.readOnly).toBe(false);
    expect(updated.textContent).toContain("External finished answer");
    pool.clear();
  });
});
