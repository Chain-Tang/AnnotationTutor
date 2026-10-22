import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { AnchorMark } from "../decorations-plan.js";
import { planAnnotationGraph } from "../annotation-graph-layout.js";
import { appendCreateConversation, buildMarginCard, disposeMarginCard } from "../margin-card.js";
import type { AnnotationReplyTarget } from "../annotation-branches.js";

export const ANNOTATION_GRAPH_VIEW_TYPE = "annotation-tutor-lite-annotation-graph";
export type AnnotationGraphHost = {
  snapshot: () => AnchorMark[];
  openAnnotation: (id: string) => void | Promise<void>;
  locateSource: (id: string) => void | Promise<void>;
  subscribe?: (listener: () => void) => () => void;
};

/** A projection of annotation files; this view owns no conversation data. */
export class AnnotationGraphView extends ItemView {
  private focusId: string | undefined;
  private readonly collapsed = new Set<string>();
  private scale = 1;
  private offset = { x: 0, y: 0 };
  private unsubscribe: (() => void) | undefined;
  private detailCard: HTMLElement | undefined;
  private scene: HTMLElement | undefined;
  private viewport: HTMLElement | undefined;
  private pendingRefresh = false;
  private readonly onConversationCreated = (event: Event): void => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;
    if (id) this.setFocus(id);
  };
  private readonly onConversationUpdated = (): void => this.refresh();
  private readonly onFocusOut = (): void => {
    queueMicrotask(() => { if (this.pendingRefresh) this.refresh(); });
  };
  private drag: { pointerId: number; x: number; y: number; left: number; top: number } | undefined;
  public constructor(leaf: WorkspaceLeaf, private readonly host: AnnotationGraphHost) { super(leaf); }
  public override getViewType(): string { return ANNOTATION_GRAPH_VIEW_TYPE; }
  public override getDisplayText(): string { return "批注关系图"; }
  public override getIcon(): string { return "workflow"; }
  public override async onOpen(): Promise<void> {
    this.contentEl.addEventListener("atl-conversation-created", this.onConversationCreated);
    this.contentEl.addEventListener("atl-conversation-updated", this.onConversationUpdated);
    this.contentEl.addEventListener("focusout", this.onFocusOut);
    this.render();
    this.unsubscribe = this.host.subscribe?.(() => this.refresh());
  }
  public setFocus(id: string): void {
    if (this.focusId !== id) { this.focusId = id; this.scale = 1; this.offset = { x: 0, y: 0 }; }
    this.render();
  }
  public refresh(): void {
    // Preserve unsent user input while an annotation elsewhere changes.
    const active = document.activeElement;
    if ((active instanceof HTMLTextAreaElement && !active.readOnly && this.detailCard?.contains(active))
      || this.detailCard?.querySelector("textarea:disabled, .atl-branch-send:disabled, .atl-branch-refresh-parent:disabled")
      || this.contentEl.querySelector(".atl-branch-create:disabled")) { this.pendingRefresh = true; return; }
    this.pendingRefresh = false;
    this.render();
  }
  public override async onClose(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.disposeDetails(); this.contentEl.replaceChildren();
    this.contentEl.removeEventListener("atl-conversation-created", this.onConversationCreated);
    this.contentEl.removeEventListener("atl-conversation-updated", this.onConversationUpdated);
    this.contentEl.removeEventListener("focusout", this.onFocusOut);
  }
  private disposeDetails(): void {
    if (this.detailCard) disposeMarginCard(this.detailCard);
    this.detailCard = undefined;
  }
  private transform(): void {
    if (this.scene) this.scene.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
  }
  private zoom(delta: number): void {
    this.scale = Math.max(0.25, Math.min(2.5, this.scale * Math.exp(delta)));
    this.transform();
    this.viewport?.setAttribute("aria-label", `批注关系图，缩放 ${Math.round(this.scale * 100)}%`);
  }
  private render(): void {
    this.disposeDetails();
    this.contentEl.replaceChildren(); this.contentEl.classList.add("atl-annotation-graph");
    const toolbar = document.createElement("div"); toolbar.className = "atl-graph-toolbar";
    const title = document.createElement("strong"); title.textContent = "批注关系图"; toolbar.appendChild(title);
    const action = (label: string, handler: () => void): void => {
      const button = document.createElement("button"); button.textContent = label; button.onclick = handler; toolbar.appendChild(button);
    };
    action("−", () => this.zoom(-0.2)); action("＋", () => this.zoom(0.2));
    action("重置视图", () => { this.scale = 1; this.offset = { x: 0, y: 0 }; this.transform(); });
    action("全部批注", () => { this.focusId = undefined; this.render(); });
    const hint = document.createElement("span"); hint.textContent = "拖动空白处平移 · Ctrl/⌘＋滚轮缩放 · 卡片边缘 ＋ 创建分支"; toolbar.appendChild(hint);
    this.contentEl.appendChild(toolbar);
    const body = document.createElement("div"); body.className = "atl-graph-body"; this.contentEl.appendChild(body);
    const viewport = document.createElement("div"); viewport.className = "atl-graph-viewport"; viewport.tabIndex = 0;
    this.viewport = viewport; body.appendChild(viewport);
    const scene = document.createElement("div"); scene.className = "atl-graph-scene"; this.scene = scene; viewport.appendChild(scene);
    const marks = this.host.snapshot();
    const placements = planAnnotationGraph(marks, this.focusId, this.collapsed);
    if (!placements.length) {
      const empty = document.createElement("p"); empty.className = "atl-graph-empty"; empty.textContent = "尚无批注。将鼠标移到已回复的批注上，点击边缘的 ＋ 创建分支。"; scene.appendChild(empty);
    }
    const byId = new Map(placements.map(node => [node.id, node]));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.classList.add("atl-graph-edges");
    svg.setAttribute("width", String(Math.max(800, ...placements.map(node => node.x + 330))));
    svg.setAttribute("height", String(Math.max(600, ...placements.map(node => node.y + 210)))); scene.appendChild(svg);
    for (const node of placements) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const x1 = parent.x + 280, y1 = parent.y + 90, x2 = node.x, y2 = node.y + 90;
        path.setAttribute("d", `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`); svg.appendChild(path);
      }
      const card = document.createElement("article"); card.className = "atl-graph-node";
      card.addEventListener("pointerdown", event => {
        // Real touch input reveals the edge action; desktop media queries can
        // incorrectly report hover:none in Electron.
        if (event.pointerType === "touch") card.dataset["chromeVisible"] = "true";
      });
      card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; card.dataset["annotationId"] = node.id;
      card.classList.toggle("is-active", node.id === this.focusId); card.classList.toggle("is-placeholder", node.missing);
      const select = document.createElement("button"); select.className = "atl-graph-node-select";
      select.textContent = node.missing ? "原批注已移除" : node.mark?.status === "archived" ? "已归档的批注" : node.mark?.branch ? "对话" : "原始批注";
      select.onclick = () => { this.focusId = node.id; this.render(); };
      card.appendChild(select);
      const question = document.createElement("div"); question.className = "atl-graph-node-question";
      question.textContent = node.mark?.note?.trim() || (node.missing ? node.id : "新对话草稿"); card.appendChild(question);
      const visibleReply = node.mark ? graphReply(node.mark) : undefined;
      const reply = document.createElement("div"); reply.className = "atl-graph-node-reply";
      reply.textContent = node.cycle ? "关联存在循环，请检查批注文件。" : node.missing ? "子卡保留创建时的回复快照。" : visibleReply?.text || node.mark?.request?.status || "等待提问"; card.appendChild(reply);
      if (node.childCount) {
        const fold = document.createElement("button"); fold.className = "atl-graph-fold";
        fold.textContent = `${this.collapsed.has(node.id) ? "展开" : "折叠"} ${node.childCount} 个分支`;
        fold.onclick = () => { if (this.collapsed.has(node.id)) this.collapsed.delete(node.id); else this.collapsed.add(node.id); this.render(); };
        card.appendChild(fold);
      }
      const target = node.mark && node.mark.status !== "archived" && !node.cycle ? visibleReply?.target : undefined;
      if (target) appendCreateConversation(card, node.id, target, id => this.setFocus(id));
      scene.appendChild(card);
    }
    viewport.addEventListener("wheel", event => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); this.zoom(-event.deltaY * 0.002); }
    }, { passive: false });
    viewport.addEventListener("pointerdown", event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest(".atl-graph-node")) return;
      this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: this.offset.x, top: this.offset.y };
      viewport.setPointerCapture?.(event.pointerId); viewport.classList.add("is-panning");
    });
    viewport.addEventListener("pointermove", event => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      this.offset = { x: this.drag.left + event.clientX - this.drag.x, y: this.drag.top + event.clientY - this.drag.y }; this.transform();
    });
    const end = (): void => { this.drag = undefined; viewport.classList.remove("is-panning"); };
    viewport.addEventListener("pointerup", end); viewport.addEventListener("pointercancel", end); viewport.addEventListener("lostpointercapture", end);
    viewport.addEventListener("keydown", event => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); this.zoom(0.2); }
      if (event.key === "-") { event.preventDefault(); this.zoom(-0.2); }
    });
    this.transform();
    const selected = marks.find(mark => mark.id === this.focusId);
    if (selected) {
      const details = document.createElement("aside"); details.className = "atl-graph-details"; body.appendChild(details);
      const actions = document.createElement("div"); actions.className = "atl-graph-detail-actions"; details.appendChild(actions);
      for (const [label, handler] of [["定位原文", this.host.locateSource], ["打开批注文件", this.host.openAnnotation]] as const) {
        const button = document.createElement("button"); button.textContent = label; button.onclick = () => void handler(selected.id); actions.appendChild(button);
      }
      const built = buildMarginCard(selected, { skin: { id: "flat", quiet: false, tilt: null }, geom: { dx: 0, dy: 0 }, showReview: true,
        showBranches: false, onCollapse: () => { this.focusId = undefined; this.render(); }, onDragMove: () => {} });
      this.detailCard = built.card; details.appendChild(built.card);
    }
  }
}

/** The output port always derives from the answer visible on this node. */
function graphReply(mark: AnchorMark): { target: AnnotationReplyTarget; text: string } | undefined {
  const review = [mark.review?.trim(), mark.reviewQuestion?.trim()].filter(Boolean).join("\n\n");
  if (review) return { target: { kind: "review" }, text: review };
  const dialogue = mark.dialogue ?? [];
  for (let index = dialogue.length - 1; index >= 0; index -= 1) {
    const turn = dialogue[index]!;
    if (turn.role === "agent" && turn.text.trim()) return { target: { kind: "dialogue", turnId: turn.id, turnIndex: index }, text: turn.text };
  }
  return undefined;
}
