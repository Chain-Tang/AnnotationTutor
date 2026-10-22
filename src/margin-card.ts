// Shared building blocks for the Word-style margin comment cards, used by both
// the CodeMirror editor rail (margin-rail.ts) and the Reading-view rail
// (reading-rail.ts). Each rail owns its own coordinate system and re-render
// loop; everything that is identical between them lives here: the editable card
// DOM, the dotted connector geometry, drag, vertical stacking, and the handler
// registry the plugin wires once on load.

import { Menu, Notice, setIcon, setTooltip } from "obsidian";
import { ANNOTATION_REVIEW_ICON, ANNOTATION_BRANCH_ICON, setAnnotationIcon } from "./annotation-icons.js";
import { t } from "./i18n.js";
import type { AnchorMark } from "./decorations-plan.js";
import type { DialogueTurn } from "./model.js";
import { diffLineClass } from "./line-diff.js";
import { nextCardScale } from "./card-zoom.js";
import { skinClass, type RailSkin } from "./skins.js";
import VanillaTilt from "vanilla-tilt";
import { enableCardDrag, isCardResizeHandle } from "./card-drag.js";
import { installCardChrome } from "./card-chrome.js";
import type { AnnotationReplyTarget } from "./annotation-branches.js";
import { annotationReplyFailureMessage } from "./annotation-reply-status.js";

const disposers = new WeakMap<HTMLElement, () => void>();

export function disposeMarginCard(card: HTMLElement): void {
  disposers.get(card)?.();
  disposers.delete(card);
  (card as TiltElement).vanillaTilt?.destroy();
  card.remove();
}

/** An element that vanilla-tilt has been initialized on stashes its handle here. */
type TiltElement = HTMLElement & { vanillaTilt?: { destroy(): void } };

/**
 * The outcome of one in-card dialogue turn. `edit` is present only when the
 * tutor proposed a change to the source text (Phase 3): `diff` is the rendered
 * before/after and `apply` writes it into the note, returning whether it landed.
 */
export type DialogueReplyResult = {
  ok: boolean;
  agentText?: string;
  error?: string;
  /** Bounded host code used for repair actions, never rendered as a reply. */
  errorCode?: string;
  edit?: { diff: string; text: string; apply: () => boolean };
};

/** Transient transport recovery keeps the same saved question and request. */
export type AnnotationReplyProgress = { type: "reconnecting"; attempt: 1 };
export type AnnotationReplyProgressHandler = (status: AnnotationReplyProgress) => void;

export type MarginCardHandlers = {
  save: (id: string, note: string) => void;
  /** Review this annotation, or route to a Build-mode edit if the note asks for one. */
  ask: (id: string, note: string) => void;
  /** Open the sidebar chat seeded with this annotation as context. */
  discuss: (id: string) => void;
  /** Send one in-card dialogue turn; resolves with the tutor's reply (+ any edit). */
  reply: (id: string, message: string, onProgress?: AnnotationReplyProgressHandler) => Promise<DialogueReplyResult>;
  /** Deepen the current card without changing its initial question or review. */
  continueDialogue?: (id: string, message: string, onProgress?: AnnotationReplyProgressHandler) => Promise<DialogueReplyResult>;
  saveDialogueDraft?: (id: string, note: string) => void | Promise<void>;
  /** Explicitly create a saved child; sending/retrying never creates another card. */
  createConversation?: (id: string, target: AnnotationReplyTarget) => Promise<{ id: string } | void>;
  saveDraft?: (id: string, note: string) => void | Promise<void>;
  refreshParent?: (id: string) => Promise<void>;
  graphCards?: (id: string) => AnchorMark[];
  subscribeGraph?: (listener: () => void) => () => void;
  openGraph?: (id: string) => void;
  openAnnotation?: (id: string) => void;
  /**
   * Render Markdown into an element (so tutor replies aren't shown as raw text).
   * `annotationId` lets the host resolve relative links against the annotated note.
   */
  render: (
    el: HTMLElement,
    markdown: string,
    annotationId?: string
  ) => void | Promise<void>;
  /** Distill a memory cell from this annotation's note + review + dialogue. */
  saveCell: (id: string) => void | Promise<void>;
  remove: (id: string) => void;
  settings: () => void;
};

let handlers: MarginCardHandlers | null = null;

// Which annotations have their dialogue revealed. The rail rebuilds cards from
// scratch on scroll/geometry changes, so this session-level set keeps a card's
// dialogue open across those rebuilds (otherwise a toggle would be undone on the
// next re-render, which read as "needs two clicks").
const openDialogues = new Set<string>();

export function setMarginCardHandlers(value: MarginCardHandlers | null): void {
  handlers = value;
  if(!value)openDialogues.clear();
}

export function getMarginCardHandlers(): MarginCardHandlers | null {
  return handlers;
}

/**
 * Per-card offset (drag), size (resize), and `s` (CTRL+scroll text zoom scale),
 * persisted across re-renders and reloads.
 */
export type BranchDirection = "left" | "right" | "bottom";
export type Geom = { dx: number; dy: number; w?: number; h?: number; s?: number; side?: BranchDirection; space?: "source" };

/**
 * Durable storage for card geometry, wired by the plugin so a card's size/place
 * survives re-renders, agent writes, and reloads — and so every card keeps its
 * own size independently. `get` seeds a card; `set` is called only on a real
 * user drag/resize.
 */
export type CardGeomStore = {
  get(id: string): Geom | undefined;
  set(id: string, geom: Geom): void;
};

let geomStore: CardGeomStore | null = null;

export function setCardGeomStore(store: CardGeomStore | null): void {
  geomStore = store;
}

export function isMarginConversationOpen(id: string): boolean { return openDialogues.has(id); }

/** The persisted geometry for a card, if any (used to seed a fresh rail). */
export function loadCardGeom(id: string): Geom | undefined {
  return geomStore?.get(id);
}

export function persistCardGeom(id: string, geom: Geom): void {
  geomStore?.set(id, geom);
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export const CARD_GAP = 8;

type BuildOptions = {
  skin: RailSkin;
  geom: Geom;
  /** Show the agent review (if any) inside the card, below the note. */
  showReview: boolean;
  onCollapse: () => void;
  /** Called continuously while the card is dragged, to redraw its connector. */
  onDragMove: (card: HTMLElement) => void;
  /** Dedicated graph details already provide navigation. */
  showBranches?: boolean;
  /** The source overlay provides external ports and independent branch cards. */
  inlineWorkflow?: boolean;
};

/** Build one editable margin card. Returns the element and its size observer. */
export function buildMarginCard(
  mark: AnchorMark,
  options: BuildOptions
): { card: HTMLElement; observer: ResizeObserver } {
  const card = document.createElement("div");
  // Every card carries its skin class (`atl-skin-<id>`); "quiet" skins (paper,
  // sticky, leaf, and all user skins) also get the chrome-less base that hides
  // scrollbars, the grip, and the resize cue.
  card.className = `atl-rail-card ${skinClass(options.skin.id)}`;
  if (options.inlineWorkflow) card.classList.add("atl-inline-workflow-card");
  if (options.skin.quiet) card.classList.add("atl-rail-card--quiet");
  card.dataset["atlId"] = mark.id;
  installCardTextInteraction(card);

  // Assigned once the dialogue area is built; the header button toggles it.
  let toggleDialogue = (): void => {};
  const cleanups: (() => void)[] = [];

  const head = document.createElement("div");
  head.className = "atl-rail-card-head";
  const grip = document.createElement("span");
  grip.className = "atl-rail-grip";
  head.appendChild(grip);
  head.appendChild(spacer());
  headButton(head, "settings", t("panel.settings"), () =>
    getMarginCardHandlers()?.settings()
  );
  if (!mark.branch) {
    const reviewButton=headButton(head, ANNOTATION_REVIEW_ICON, t("card.ask"), () =>
      getMarginCardHandlers()?.ask(mark.id, editor.value)
    );
    reviewButton.classList.add("atl-review-action");
  }
  // Keeps reading immersive: the dialogue input stays hidden until requested.
  const dialogueButton=headButton(head, "message-circle", "在此卡片内继续对话", () => toggleDialogue());
  dialogueButton.classList.add("atl-dialogue-toggle");
  // Breadth and depth have separate controls. This button reopens dismissed
  // branches without changing the conversation within the current card.
  if (options.inlineWorkflow || options.showBranches !== false) {
    const branchesButton=headButton(head, ANNOTATION_BRANCH_ICON, "展开分支", () =>
      card.dispatchEvent(new CustomEvent("atl-branches-toggle", {bubbles:true,detail:{id:mark.id}}))
    );
    branchesButton.classList.add("atl-branches-toggle");
    branchesButton.setAttribute("aria-expanded","false");
  }
  headButton(head, "trash-2", t("card.delete"), () =>
    getMarginCardHandlers()?.remove(mark.id)
  );
  headButton(head, "x", t("card.collapse"), options.onCollapse);
  card.appendChild(head);
  const stopChrome = installCardChrome(card, head);
  const stopDrag = enableCardDrag(card, head, options.geom,
    () => options.onDragMove(card),
    () => persistCardGeom(mark.id, options.geom));

  const editor = document.createElement("textarea");
  editor.className = "atl-rail-edit";
  editor.value = mark.note ?? "";
  editor.placeholder = t("panel.placeholder");
  editor.addEventListener("mousedown", (event) => event.stopPropagation());
  if (mark.branch) {
    cleanups.push(bindConversationQuestion(editor, mark));
    editor.placeholder = "输入你的问题";
  } else {
    editor.addEventListener("blur", () => getMarginCardHandlers()?.save(mark.id, editor.value));
  }
  card.appendChild(editor);

  // The agent review sits quietly under the note, inside the same card, so the
  // feedback reads as part of the comment rather than a separate labelled block.
  if (options.showReview && (mark.review || mark.reviewQuestion)) {
    const divider = document.createElement("div");
    divider.className = "atl-rail-divider";
    card.appendChild(divider);
    if (mark.review) {
      const review = document.createElement("div");
      review.className = "atl-rail-review";
      card.appendChild(review);
      void renderCardMarkdown(review, mark.review, mark.id);
    }
    // The Socratic question reads as a gentle prompt below the comment.
    if (mark.reviewQuestion) {
      const question = document.createElement("div");
      question.className = "atl-rail-question";
      card.appendChild(question);
      void renderCardMarkdown(question, mark.reviewQuestion, mark.id);
    }
  }

  // Standalone graph details keep their legacy port; source overlays own three
  // external ports, so scrollable card content never clips the controls.
  if (options.showBranches === false && !options.inlineWorkflow) {
    const target = marginReplyTarget(mark);
    if (target) appendCreateConversation(card, mark.id, target);
  }

  // A continuous dialogue: hidden until the learner clicks the dialogue button,
  // then the tutor remembers the thread (persisted in the annotation file) and a
  // "rewrite the original" request surfaces a diff.
  if (mark.branch) cleanups.push(renderBranchComposer(card, mark, editor));
  const conversation=document.createElement("div");
  conversation.className="atl-card-conversation";
  conversation.id=`atl-conversation-${mark.id}`;
  dialogueButton.setAttribute("aria-controls",conversation.id);
  const setConversationOpen=(open:boolean):void=>{
    if(open)openDialogues.add(mark.id);else openDialogues.delete(mark.id);
    conversation.hidden=!open;
    // A collapsed workflow should not retain blank space from its former
    // expanded height. Width/position and the expanded size stay remembered.
    card.style.height=open&&options.geom.h?`${options.geom.h}px`:"";
    dialogueButton.setAttribute("aria-expanded",String(open));
    dialogueButton.classList.toggle("is-active",open);
    card.classList.toggle("is-conversation-open",open);
  };
  toggleDialogue=()=>setConversationOpen(!openDialogues.has(mark.id));
  card.appendChild(conversation);
  cleanups.push(renderDialogue(conversation, mark, options.showBranches === false && !options.inlineWorkflow));
  setConversationOpen(openDialogues.has(mark.id));

  // Apply remembered size, then ignore the resize events that applying it fires.
  let applying = true;
  if (options.geom.w) card.style.width = `${options.geom.w}px`;
  if (options.geom.h && openDialogues.has(mark.id)) card.style.height = `${options.geom.h}px`;
  // Restore the remembered text zoom (set by CTRL+scroll below).
  if (options.geom.s) {
    card.style.setProperty("--atl-card-scale", String(options.geom.s));
  }
  requestAnimationFrame(() => {
    applying = false;
  });

  // CTRL+scroll (or a mac trackpad pinch, which arrives as a ctrl-wheel) zooms the
  // card's text by scaling --atl-card-scale; every text element derives its
  // font-size from it, so the note, review, dialogue, and reply scale together.
  // preventDefault claims the gesture from Electron's page-zoom / scroll.
  card.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const current = options.geom.s ?? 1;
      const next = nextCardScale(current, event.deltaY);
      if (next === current) return;
      options.geom.s = next;
      card.style.setProperty("--atl-card-scale", String(next));
      persistCardGeom(mark.id, options.geom);
    },
    { passive: false }
  );

  // Only a deliberate resize gesture should change a card's remembered size.
  // Content changes (a review arriving, the textarea reflowing) must not, or one
  // card's size would silently follow another card's edits. A size change counts
  // as user-driven only while a pointer is held down on this card.
  let resizing = false;
  const endResize = (): void => {
    resizing = false;
    document.removeEventListener("pointerup", endResize, true);
    document.removeEventListener("pointercancel", endResize, true);
  };
  card.addEventListener("pointerdown", (event) => {
    if (event.target !== card || !isCardResizeHandle(card, event)) return;
    resizing = true;
    document.addEventListener("pointerup", endResize, true);
    document.addEventListener("pointercancel", endResize, true);
  });
  const observer = new ResizeObserver(() => {
    if (applying || !resizing) return;
    options.geom.w = card.offsetWidth;
    options.geom.h = card.offsetHeight;
    persistCardGeom(mark.id, options.geom);
  });
  observer.observe(card);

  // A tilt skin (sticky, leaf) becomes a GPU 3D object that leans toward the
  // pointer with a moving glare. Init after a frame so the card is in the DOM
  // (vanilla-tilt measures it); the connected guard skips cards already torn
  // down by a fast re-render. clearChildren destroys the instance on rebuild so
  // its window resize listener (added for glare) never accumulates.
  if (options.skin.tilt) {
    const tilt = options.skin.tilt;
    const initTilt = (): void => {
      if (!card.isConnected || (card as TiltElement).vanillaTilt) return;
      VanillaTilt.init(card, {
        max: tilt.max,
        glare: tilt.glare,
        "max-glare": tilt.maxGlare,
        speed: 400,
        scale: 1.02,
        perspective: 1000,
        gyroscope: false
      });
    };
    requestAnimationFrame(initTilt);
    // Suspend the tilt while the card is dragged by its head, so it doesn't lean
    // away under the pointer (which made repositioning feel slippery), then
    // restore it when the drag ends.
    head.addEventListener("pointerdown", () => {
      (card as TiltElement).vanillaTilt?.destroy();
      const restore = (): void => {
        document.removeEventListener("pointerup", restore, true);
        requestAnimationFrame(initTilt);
      };
      document.addEventListener("pointerup", restore, { capture: true, once: true });
    });
  }

  disposers.set(card, () => {
    for (const cleanup of cleanups) cleanup();
    stopChrome();
    stopDrag();
    endResize();
    observer.disconnect();
  });
  return { card, observer };
}

/** Keep card selections and native editing out of the surrounding source editor. */
function installCardTextInteraction(card: HTMLElement): void {
  // Selecting rendered prose must focus this surface instead of leaving
  // CodeMirror active, where Cmd/Ctrl+C would copy the source-note selection.
  card.tabIndex = -1;
  card.contentEditable = "false";
  card.addEventListener("mousedown", event => {
    if (event.button === 0 && !(event.target as Element).closest("button, textarea, input, select, a, [contenteditable='true']")) {
      card.focus({ preventScroll: true });
    }
    event.stopPropagation();
  });
  // Do not prevent the browser's text selection, native clipboard or textarea
  // editing. Only stop source-editor listeners from claiming these events.
  for (const type of ["pointerdown", "mouseup", "keydown", "keypress", "keyup", "copy", "cut", "paste"]) {
    card.addEventListener(type, event => event.stopPropagation());
  }
  card.addEventListener("contextmenu", event => {
    const selected = selectedCardText(card, event.target);
    if (!selected) return;
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem(item => item.setTitle(t("chat.copy")).setIcon("copy").onClick(() => {
      void navigator.clipboard.writeText(selected).catch(() => new Notice(t("chat.copyFailed")));
    }));
    menu.showAtMouseEvent(event);
  });
}

function selectedCardText(card: HTMLElement, target: EventTarget | null): string {
  const field = target instanceof Element ? target.closest<HTMLTextAreaElement | HTMLInputElement>("textarea, input") : null;
  if (field && card.contains(field)) return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  const selection = card.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!card.contains(range.startContainer) || !card.contains(range.endContainer)) return "";
  }
  return selection.toString();
}

/**
 * Build the dialogue thread + reply input, hidden until toggled (so reading
 * stays immersive). Its disclosure belongs to this card only; external ports
 * create breadth, while this composer continues the same durable thread.
 */
function renderDialogue(card: HTMLElement, mark: AnchorMark, legacyPorts = false): () => void {
  const wrap = document.createElement("div");
  wrap.className = "atl-rail-dialogue";
  const thread = document.createElement("div");
  thread.className = "atl-rail-thread";
  for (const [turnIndex, turn] of (mark.dialogue ?? []).entries()) {
    const turnEl=appendTurn(thread, turn.role, turn.text, mark.id);
    if (legacyPorts && turn.role === "agent") appendCreateConversation(turnEl, mark.id, { kind: "dialogue", turnId: turn.id, turnIndex });
  }
  wrap.appendChild(thread);
  const row = document.createElement("div");
  row.className = "atl-rail-reply-row";
  const input = document.createElement("textarea");
  input.className = "atl-rail-reply";
  input.placeholder = t("card.reply.placeholder");
  input.setAttribute("aria-label", "在此卡片内继续提问");
  input.rows = 1;
  input.value = mark.dialogueRequest?.status === "completed" ? "" : mark.dialogueRequest?.question ?? "";
  input.addEventListener("mousedown", (event) => event.stopPropagation());
  const send = document.createElement("button");
  send.className = "atl-iconbtn atl-rail-reply-send";
  setIcon(send, "send-horizontal");
  setTooltip(send, t("card.reply.send"));
  row.appendChild(input);
  row.appendChild(send);
  wrap.appendChild(row);
  const status = document.createElement("div");
  status.className = "atl-rail-dialogue-status";
  status.setAttribute("role", "status");
  wrap.appendChild(status);
  const setStatus = (text: string): void => { status.textContent = text; status.hidden = !text; };
  const requestStatus = mark.dialogueRequest?.status;
  setStatus(requestStatus === "generating" ? "问题已保存，Tutor 正在回复…"
    : requestStatus === "interrupted" ? "上次回复已中断，问题已保存，可重试。"
    : requestStatus === "cancelled" ? "已取消，问题已保存，可重试。"
    : requestStatus === "failed" ? annotationReplyFailureMessage(mark.dialogueRequest?.errorCode) : "");
  // Read-only fields still allow selecting/copying the saved question while
  // the request runs; disabled form controls would suppress those interactions.
  input.readOnly = requestStatus === "generating";
  send.disabled = input.readOnly;

  // A new branch first finishes its initial question; after that it supports
  // the same unlimited in-card continuation as any original annotation.
  let initialComplete = !mark.branch || mark.request?.status === "completed" || Boolean(mark.review || mark.reviewQuestion);
  const updateAvailability = (): void => {
    const h = getMarginCardHandlers();
    const canContinue = initialComplete && !["archived", "agent_requested", "source_missing"].includes(mark.status ?? "")
      && Boolean(h?.continueDialogue || (!mark.branch && !h?.createConversation));
    row.hidden = !canContinue;
    wrap.hidden = !canContinue && !thread.children.length;
  };
  updateAvailability();
  const rootCard = card.closest<HTMLElement>(".atl-rail-card");
  const completed = (): void => { initialComplete = true; updateAvailability(); };
  rootCard?.addEventListener("atl-initial-answer-completed", completed);
  const stopDraft = bindDurableDraft(input, mark.id, () => getMarginCardHandlers()?.saveDialogueDraft);

  let busy = requestStatus === "generating";
  const submit = async (): Promise<void> => {
    const message = input.value.trim();
    const cardHandlers = getMarginCardHandlers();
    if (!message || !cardHandlers || busy || row.hidden || input.readOnly) return;
    busy = true; send.disabled = true;
    if (rootCard) rootCard.dataset["localRequest"] = "true";
    let saved = false;
    try {
      await draftFlushers.get(input)?.();
      saved = true; input.readOnly = true;
      setStatus(t("card.reply.thinking"));
      const result = await (cardHandlers.continueDialogue ?? cardHandlers.reply)(mark.id, message, progress => {
        if (busy && progress.type === "reconnecting") setStatus("连接短暂中断，正在自动重连…");
      });
      if (!result.ok) {
        setStatus(annotationReplyFailureMessage(result.errorCode));
      } else {
        input.value = "";
        draftResetters.get(input)?.();
        setStatus("");
        appendTurn(thread, "user", message, mark.id);
        appendTurn(thread, "agent", result.agentText || t("card.reply.empty"), mark.id);
        if (result.edit) appendEditCard(thread, result.edit);
        thread.scrollTop = thread.scrollHeight;
      }
    } catch {
      setStatus(saved ? "回复未完成，问题已保存，可重试。" : "草稿保存失败，尚未发送；请重试。");
    } finally {
      busy = false; send.disabled = false;
      input.readOnly = false;
      input.focus();
      if (rootCard) delete rootCard.dataset["localRequest"];
      rootCard?.dispatchEvent(new CustomEvent("atl-conversation-updated", { bubbles: true, detail: { id: mark.id } }));
    }
  };
  send.onclick = () => void submit();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  card.appendChild(wrap);
  return () => {
    stopDraft();
    rootCard?.removeEventListener("atl-initial-answer-completed", completed);
  };
}

function appendTurn(
  thread: HTMLElement,
  role: DialogueTurn["role"],
  text: string,
  annotationId: string
): HTMLElement {
  const el = document.createElement("div");
  el.className = `atl-rail-turn atl-rail-turn--${role}`;
  // Render the tutor's reply as Markdown; the learner's own line stays plain.
  if (role === "agent" && getMarginCardHandlers()?.render) {
    // Attach the copy button after the async render so it isn't clobbered, and
    // so the learner can lift a generated table/diagram out of the narrow card.
    void renderCardMarkdown(el, text, annotationId).then(() =>
      attachCopyButton(el, text)
    );
  } else {
    el.textContent = text;
  }
  thread.appendChild(el);
  return el;
}

const draftFlushers = new WeakMap<HTMLTextAreaElement, () => Promise<void>>();
const draftResetters = new WeakMap<HTMLTextAreaElement, () => void>();
const activeDraftFlushers = new Set<() => Promise<void>>();

/** Upgrade/shutdown gate: include focused text typed inside the debounce window. */
export async function flushMarginConversationDrafts(): Promise<void> {
  await Promise.all([...activeDraftFlushers].map(flush => flush()));
}

/** Debounced durable drafts, with a flush before send and before card teardown. */
function bindConversationQuestion(editor: HTMLTextAreaElement, mark: AnchorMark): () => void {
  editor.readOnly = mark.request?.status === "completed" || mark.request?.status === "generating" || mark.status === "archived";
  return bindDurableDraft(editor, mark.id, () => getMarginCardHandlers()?.saveDraft);
}

function bindDurableDraft(
  editor: HTMLTextAreaElement,
  id: string,
  getSave: () => ((id: string, note: string) => void | Promise<void>) | undefined
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saved = editor.value;
  let chain = Promise.resolve();
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const value = editor.value;
    if (value === saved || editor.readOnly || editor.disabled) return chain;
    const save = getSave();
    if (!save) return Promise.resolve();
    chain = chain.catch(() => {}).then(async () => {
      await save(id, value);
      saved = value;
    });
    return chain;
  };
  const input = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(() => {
      editor.dataset["saveFailed"] = "true";
    }); }, 350);
  };
  const blur = (): void => { void flush().catch(() => { editor.dataset["saveFailed"] = "true"; }); };
  editor.addEventListener("input", input);
  editor.addEventListener("blur", blur);
  draftFlushers.set(editor, flush);
  draftResetters.set(editor, () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    saved = editor.value;
  });
  activeDraftFlushers.add(flush);
  return () => {
    void flush().catch(() => {}).finally(() => activeDraftFlushers.delete(flush));
    editor.removeEventListener("input", input);
    editor.removeEventListener("blur", blur);
    draftFlushers.delete(editor);
    draftResetters.delete(editor);
  };
}

/** Choose only an existing, complete Tutor answer as a branch origin. */
export function marginReplyTarget(mark: AnchorMark): AnnotationReplyTarget | undefined {
  if (mark.status === "archived" || mark.request?.status === "generating" || mark.dialogueRequest?.status === "generating") return undefined;
  const latest=(mark.dialogue??[]).map((turn,turnIndex)=>({turn,turnIndex})).reverse().find(({turn})=>turn.role==="agent");
  if(latest)return {kind:"dialogue",turnId:latest.turn.id,turnIndex:latest.turnIndex};
  return mark.review || mark.reviewQuestion ? { kind: "review" } : undefined;
}

export function appendCreateConversation(host: HTMLElement, id: string, target: AnnotationReplyTarget, onCreated?:(id:string)=>void): void {
  if (!getMarginCardHandlers()?.createConversation) return;
  if([...host.children].some(el=>el.classList.contains("atl-branch-port")))return;
  host.classList.add("atl-has-branch-port");
  const button = document.createElement("button");
  button.className = "atl-branch-create atl-branch-port";
  button.textContent = "+";
  button.setAttribute("aria-label","创建分支");
  button.title="创建分支";
  button.addEventListener("mousedown", event => event.stopPropagation());
  button.onclick = async event => {
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    try {
      const created = await getMarginCardHandlers()?.createConversation?.(id, target);
      if (created) {
        button.disabled = false;
        const card = host.closest<HTMLElement>(".atl-rail-card");
        // The host may rebuild rails on disk writes; refresh the surviving card
        // too, so an unchanged root record still reveals its new child. Adding
        // breadth does not change this card's dialogue disclosure.
        card?.dispatchEvent(new CustomEvent("atl-branches-refresh"));
        host.dispatchEvent(new CustomEvent("atl-conversation-created", { bubbles: true, detail: { id: created.id } }));
        onCreated?.(created.id);
        getMarginCardHandlers()?.openAnnotation?.(created.id);
      }
    } catch {
      new Notice("创建对话失败，请重试。");
    } finally { button.disabled = false; }
  };
  host.appendChild(button);
}

function requestLabel(mark: AnchorMark): string {
  if (mark.status === "archived") return "已归档，关联与子卡仍保留";
  switch (mark.request?.status) {
    case "generating": return "问题已保存，Tutor 正在回复…";
    case "completed": return "";
    case "failed": return annotationReplyFailureMessage(mark.request?.errorCode);
    case "cancelled": return "已取消，问题已保存，可重试。";
    case "interrupted": return "上次回复已中断，问题已保存，可重试。";
    default: return "";
  }
}

function renderBranchComposer(host: HTMLElement, mark: AnchorMark, editor: HTMLTextAreaElement): () => void {
  const row = document.createElement("div");
  row.className = "atl-branch-send-row";
  const status = document.createElement("div");
  status.className = "atl-branch-status";
  status.setAttribute("role", "status");
  status.textContent = requestLabel(mark);
  status.hidden = !status.textContent;
  row.appendChild(status);
  const button = document.createElement("button");
  button.className = "atl-branch-send";
  button.textContent = mark.request?.status === "failed" || mark.request?.status === "interrupted" || mark.request?.status === "cancelled" ? "重试" : "发送";
  button.disabled = mark.request?.status === "generating";
  const finished = mark.request?.status === "completed" || mark.status === "archived";
  button.hidden = finished;
  row.hidden = finished;
  row.appendChild(button);
  host.appendChild(row);
  const installRefreshParent = (errorCode?: string): void => {
    if (!errorCode || !/^annotation-(?:parent|source|branch|context)/.test(errorCode)
      || !getMarginCardHandlers()?.refreshParent || finished || row.querySelector(".atl-branch-refresh-parent")) return;
    const refresh = document.createElement("button"); refresh.className = "atl-branch-refresh-parent";
    refresh.textContent = "更新关联";
    refresh.title = "使用父批注当前的 Tutor 回复和原文，保留当前问题";
    row.appendChild(refresh);
    refresh.onclick = async () => {
      if (refresh.disabled) return;
      refresh.disabled = true; button.disabled = true;
      try {
        await draftFlushers.get(editor)?.();
        await getMarginCardHandlers()?.refreshParent?.(mark.id);
        status.textContent = "关联已更新，问题已保留，可重试。"; status.hidden=false;
        refresh.remove();
        host.closest<HTMLElement>(".atl-rail-card")?.dispatchEvent(new CustomEvent("atl-branches-refresh"));
      } catch {
        status.textContent = "无法更新关联，请恢复父批注或原文后重试。"; status.hidden=false;
      } finally { refresh.disabled = false; button.disabled = false; }
    };
  };
  installRefreshParent(mark.request?.errorCode);
  let busy = false;
  const submit = async (): Promise<void> => {
    if (busy || button.disabled || finished || editor.readOnly || !editor.value.trim()) return;
    const h = getMarginCardHandlers();
    if (!h) return;
    busy = true; button.disabled = true;
    host.dataset["localRequest"] = "true";
    let saved = false;
    try {
      await draftFlushers.get(editor)?.();
      saved = true;
      editor.readOnly = true;
      status.textContent = "Tutor 正在回复…"; status.hidden=false;
      const result = await h.reply(mark.id, editor.value.trim(), progress => {
        if (busy && progress.type === "reconnecting") {
          status.textContent = "连接短暂中断，正在自动重连…";
          status.hidden = false;
        }
      });
      if (!result.ok) {
        status.textContent = annotationReplyFailureMessage(result.errorCode);
        button.textContent = "重试";
        installRefreshParent(result.errorCode);
      } else {
        status.textContent = ""; status.hidden=true; row.hidden=true;
        editor.readOnly = true;
        button.hidden = true;
        if (result.agentText && !host.querySelector(".atl-rail-review")) {
          const conversation = host.querySelector(".atl-card-conversation");
          if (!host.querySelector(".atl-rail-divider")) {
            const divider = document.createElement("div"); divider.className = "atl-rail-divider";
            host.insertBefore(divider, conversation);
          }
          const reply = document.createElement("div"); reply.className = "atl-rail-review";
          host.insertBefore(reply, conversation);
          await renderCardMarkdown(reply, result.agentText, mark.id);
          if(!host.classList.contains("atl-inline-workflow-card"))appendCreateConversation(host, mark.id, { kind: "review" });
        }
        if (result.edit) appendEditCard(host, result.edit);
        host.dispatchEvent(new CustomEvent("atl-initial-answer-completed"));
      }
    } catch {
      status.textContent = saved ? "回复未完成，问题已保存，可重试。" : "草稿保存失败，尚未发送；请重试。";
      status.hidden=false;
      button.textContent = "重试";
    } finally {
      busy = false; button.disabled = false;
      editor.readOnly = button.hidden;
      delete host.dataset["localRequest"];
      host.dispatchEvent(new CustomEvent("atl-conversation-updated", { bubbles: true, detail: { id: mark.id } }));
    }
  };
  button.onclick = () => void submit();
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
  };
  editor.addEventListener("keydown", keydown);
  return () => editor.removeEventListener("keydown", keydown);
}

/** Use the host's Markdown renderer for every agent-authored card section. */
function renderCardMarkdown(
  el: HTMLElement,
  markdown: string,
  annotationId: string
): Promise<void> {
  const render = getMarginCardHandlers()?.render;
  if (!render) {
    el.textContent = markdown;
    return Promise.resolve();
  }
  el.classList.add("atl-rail-md");
  // Keep untrusted source text inert if the host renderer is unavailable or
  // fails, including a partially rendered section. Never interpolate HTML here.
  const fallback = (): void => {
    el.classList.remove("atl-rail-md");
    el.textContent = markdown;
  };
  try {
    return Promise.resolve(render(el, markdown, annotationId)).catch(fallback);
  } catch {
    fallback();
    return Promise.resolve();
  }
}

/**
 * A hover-revealed button that copies a complete turn's Markdown, complementing
 * native partial-text selection and the context-menu Copy action.
 */
function attachCopyButton(host: HTMLElement, raw: string): void {
  const button = host.createEl("button", { cls: "atl-iconbtn atl-rail-copy" });
  setIcon(button, "copy");
  setTooltip(button, t("chat.copy"));
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.onclick = (event) => {
    event.stopPropagation();
    void copyToClipboard(raw, button, "copy");
  };
}

/**
 * Copy `raw` and flash confirmation. An icon button (`icon` set) swaps to a check
 * glyph; a text button shows "Copied", matching the sidebar chat's copy buttons.
 */
async function copyToClipboard(
  raw: string,
  button: HTMLElement,
  icon?: string
): Promise<void> {
  try {
    await navigator.clipboard.writeText(raw);
  } catch {
    new Notice(t("chat.copyFailed"));
    return;
  }
  if (icon) {
    setIcon(button, "check");
    setTooltip(button, t("chat.copied"));
  } else {
    button.textContent = t("chat.copied");
  }
  window.setTimeout(() => {
    if (icon) {
      setIcon(button, icon);
      setTooltip(button, t("chat.copy"));
    } else {
      button.textContent = t("chat.copy");
    }
  }, 1500);
}

/** A diff preview + Apply/Copy/Dismiss for a tutor-proposed change to the source. */
function appendEditCard(
  thread: HTMLElement,
  edit: { diff: string; text: string; apply: () => boolean }
): void {
  const card = document.createElement("div");
  card.className = "atl-rail-editcard";
  const title = document.createElement("div");
  title.className = "atl-rail-editcard-title";
  title.textContent = t("chat.edit.title");
  card.appendChild(title);

  const pre = document.createElement("pre");
  pre.className = "atl-diff";
  for (const line of edit.diff.split("\n")) {
    const div = document.createElement("div");
    div.className = diffLineClass(line);
    div.textContent = line;
    pre.appendChild(div);
  }
  card.appendChild(pre);

  const actions = document.createElement("div");
  actions.className = "atl-actions";
  const apply = document.createElement("button");
  apply.className = "mod-cta";
  apply.textContent = t("chat.edit.apply");
  apply.onclick = () => {
    if (edit.apply()) {
      apply.disabled = true;
      apply.textContent = t("chat.edit.applied");
    }
  };
  const copy = document.createElement("button");
  copy.textContent = t("chat.copy");
  copy.onclick = () => void copyToClipboard(edit.text, copy);
  const dismiss = document.createElement("button");
  dismiss.textContent = t("chat.edit.dismiss");
  dismiss.onclick = () => card.remove();
  actions.appendChild(apply);
  actions.appendChild(copy);
  actions.appendChild(dismiss);
  card.appendChild(actions);

  thread.appendChild(card);
}

function headButton(
  container: HTMLElement,
  icon: string,
  tooltip: string,
  handler: () => void
): HTMLButtonElement {
  const button = container.createEl("button", { cls: "atl-iconbtn" });
  setAnnotationIcon(button, icon);
  setTooltip(button, tooltip);
  button.setAttribute("aria-label",tooltip);
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.onclick = () => handler();
  return button;
}

export type PlacedCard = {
  card: HTMLElement;
  anchorX: number;
  anchorMidY: number;
  desiredY: number;
};

/**
 * Stack cards top to bottom against the right edge of a rail of `railWidth`,
 * honouring each card's remembered drag offset and never overlapping. Calls
 * `draw` with the final geometry so the caller can render the connector.
 */
export function placeCards(
  cards: PlacedCard[],
  railWidth: number,
  geomByID: Map<string, Geom>,
  draw: (id: string, anchorX: number, anchorMidY: number) => void
): void {
  cards.sort((a, b) => a.desiredY - b.desiredY);
  let cursorY = 0;
  for (const item of cards) {
    const id = item.card.dataset["atlId"] ?? "";
    const geom = geomByID.get(id) ?? { dx: 0, dy: 0 };
    if (item.card.dataset["dragging"]) {
      cursorY = Number(item.card.dataset["baseTop"] ?? item.card.offsetTop) + item.card.offsetHeight + CARD_GAP;
      draw(id, item.anchorX, item.anchorMidY);
      continue;
    }
    const baseTop = Math.max(item.desiredY, cursorY);
    const baseLeft = Math.max(0, railWidth - item.card.offsetWidth - 34);
    item.card.dataset["baseLeft"] = `${baseLeft}`;
    item.card.dataset["baseTop"] = `${baseTop}`;
    item.card.dataset["anchorX"] = `${item.anchorX}`;
    item.card.dataset["anchorMidY"] = `${item.anchorMidY}`;
    item.card.style.left = `${baseLeft + geom.dx}px`;
    item.card.style.top = `${baseTop + geom.dy}px`;
    cursorY = baseTop + item.card.offsetHeight + CARD_GAP;
    draw(id, item.anchorX, item.anchorMidY);
  }
}

/** Draw the dotted connector from an anchor point to a card's left-middle. */
export function drawConnector(
  svg: SVGSVGElement,
  cardsEl: HTMLElement,
  id: string,
  anchorX: number,
  anchorMidY: number,
  originRect: DOMRect
): void {
  const card = cardsEl.querySelector<HTMLElement>(
    `.atl-rail-card[data-atl-id="${id}"]`
  );
  if (!card) return;
  const cardRect = card.getBoundingClientRect();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "atl-rail-link");
  path.setAttribute("data-atl-id", id);
  path.setAttribute(
    "d",
    connectorD(
      anchorX,
      anchorMidY,
      cardRect.left - originRect.left,
      cardRect.top - originRect.top + cardRect.height / 2
    )
  );
  svg.appendChild(path);
}

/** Live-update a single card's connector while it is dragged. */
export function updateConnector(
  svg: SVGSVGElement,
  card: HTMLElement,
  originRect: DOMRect
): void {
  const id = card.dataset["atlId"];
  if (!id) return;
  const path = svg.querySelector<SVGPathElement>(`path[data-atl-id="${id}"]`);
  if (!path) return;
  const cardRect = card.getBoundingClientRect();
  path.setAttribute(
    "d",
    connectorD(
      Number(card.dataset["anchorX"] ?? "0"),
      Number(card.dataset["anchorMidY"] ?? "0"),
      cardRect.left - originRect.left,
      cardRect.top - originRect.top + cardRect.height / 2
    )
  );
}

function connectorD(x1: number, y1: number, x2: number, y2: number): string {
  const midX = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function spacer(): HTMLElement {
  const el = document.createElement("span");
  el.className = "atl-spacer";
  return el;
}

export function clearChildren(node: Element): void {
  // Tear down any vanilla-tilt instances before dropping the cards, so the
  // window resize listener glare adds doesn't pile up across rail rebuilds.
  node
    .querySelectorAll<HTMLElement>(".atl-rail-card")
    .forEach(disposeMarginCard);
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * The rect of an element's last on-screen line. An inline highlight that wraps
 * across visual lines reports one client rect per line; the connector should meet
 * the end of the underline, so anchor it to that final rect (not the bounding box,
 * whose right edge is the widest line). Null when the element has no box.
 */
export function lastLineRect(el: Element): DOMRect | null {
  const rects = el.getClientRects();
  const last = rects.item(rects.length - 1);
  if (last) return last;
  const box = el.getBoundingClientRect();
  return box.width || box.height ? box : null;
}
