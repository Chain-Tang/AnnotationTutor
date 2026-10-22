import { Notice } from "obsidian";
import type { AnchorMark } from "./decorations-plan.js";
import type { RailSkin } from "./skins.js";
import { CardPool } from "./card-pool.js";
import {
  getMarginCardHandlers, loadCardGeom,
  marginReplyTarget, persistCardGeom, SVG_NS,
  updateConnector,
  type BranchDirection, type Geom
} from "./margin-card.js";

type RootCard = { mark: AnchorMark; card: HTMLElement };
type Options = { skin: RailSkin; showReview: boolean };
type Node = RootCard & { parentId?: string; geom?: Geom; slot: number };
type Ports = { el: HTMLElement; card: HTMLElement; dispose: () => void };
const SIDES: BranchDirection[] = ["left", "right", "bottom"];
const BRANCH_GAP = 72;
type Attachment = { x: number; y: number; nx: number; ny: number };

function connectionPath(parent: DOMRect, child: DOMRect, side: BranchDirection, origin: DOMRect): string {
  const start: Attachment = side === "bottom"
    ? { x: parent.left + parent.width / 2, y: parent.bottom, nx: 0, ny: 1 }
    : { x: side === "left" ? parent.left : parent.right, y: parent.top + parent.height / 2, nx: side === "left" ? -1 : 1, ny: 0 };
  const targets: Attachment[] = [
    { x: child.left, y: child.top + child.height / 2, nx: -1, ny: 0 },
    { x: child.right, y: child.top + child.height / 2, nx: 1, ny: 0 },
    { x: child.left + child.width / 2, y: child.top, nx: 0, ny: -1 },
    { x: child.left + child.width / 2, y: child.bottom, nx: 0, ny: 1 }
  ];
  const distance = (point: Attachment): number => Math.hypot(point.x - start.x, point.y - start.y);
  // The source stays on the chosen creation side. The destination faces its
  // actual position, so dragging across the parent never joins a distant edge.
  const end = targets.reduce((closest, target) => distance(target) < distance(closest) ? target : closest);
  const tangent = Math.min(120, distance(end) * 0.4);
  const x0 = start.x - origin.left, y0 = start.y - origin.top;
  const x1 = end.x - origin.left, y1 = end.y - origin.top;
  // One curve reaches both borders. Its bounded tangents remain smooth even
  // when cards overlap; there is no permanent straight stem for the hover +.
  return `M ${x0} ${y0} C ${x0 + start.nx * tangent} ${y0 + start.ny * tangent}, ${x1 + end.nx * tangent} ${y1 + end.ny * tangent}, ${x1} ${y1}`;
}

/** Independent annotation cards in the source pane, never a second document. */
export class InlineAnnotationWorkflow {
  private readonly cards = new CardPool();
  private readonly geom = new Map<string, Geom>();
  private readonly ports = new Map<string, Ports>();
  private readonly nodes = new Map<string, Node>();
  private readonly dismissed = new Set<string>();
  private readonly collapsed = new Set<string>();
  private readonly pending = new Set<string>();
  private roots: RootCard[] = [];
  private options?: Options;
  private destroyed = false;
  private focusId?: string;
  private sceneX = 0;
  private sceneY = 0;
  private readonly originalTransform: string;
  private readonly unsubscribe?: () => void;
  private readonly resize: ResizeObserver;
  private readonly panHost: HTMLElement;
  private stopPan?: () => void;
  private readonly onPan = (event: PointerEvent): void => {
    if (!event.altKey || event.button !== 0 || this.nodes.size < 2) return;
    event.preventDefault(); event.stopPropagation();
    this.stopPan?.();
    const doc=this.overlay.ownerDocument, x=event.clientX,y=event.clientY;
    const initialX=this.sceneX,initialY=this.sceneY;
    const move=(next:PointerEvent):void=>{
      if(next.pointerId!==event.pointerId)return;
      this.sceneX=initialX+next.clientX-x;this.sceneY=initialY+next.clientY-y;
      this.applyScene();this.updateConnections();
    };
    const finish=(next:PointerEvent):void=>{if(next.pointerId===event.pointerId)this.stopPan?.();};
    this.stopPan=()=>{
      doc.removeEventListener("pointermove",move,true);
      doc.removeEventListener("pointerup",finish,true);
      doc.removeEventListener("pointercancel",finish,true);
      doc.defaultView?.removeEventListener("blur",blur);
      this.stopPan=undefined;
    };
    const blur=():void=>this.stopPan?.();
    doc.addEventListener("pointermove",move,true);
    doc.addEventListener("pointerup",finish,true);
    doc.addEventListener("pointercancel",finish,true);
    doc.defaultView?.addEventListener("blur",blur);
  };
  private readonly onUpdated = (): void => this.redraw();
  private readonly onBranchesToggle = (event: Event): void => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id !== "string" || !this.nodes.has(id)) return;
    const descendants = this.descendants(id);
    if (!descendants.length) return;
    event.stopPropagation();
    if (descendants.every(node => !node.card.hidden)) {
      this.collapsed.add(id);
    } else {
      // Reopen the whole tree, including cards individually closed with X.
      // The cards remain in the pool, so their draft and geometry are intact.
      for (const node of [this.nodes.get(id)!, ...descendants]) {
        this.collapsed.delete(node.mark.id);
        this.dismissed.delete(node.mark.id);
      }
    }
    this.redraw();
  };

  public constructor(
    private readonly overlay: HTMLElement,
    private readonly svg: SVGSVGElement,
    private readonly originRect: () => DOMRect,
    private readonly schedule: () => void
  ) {
    this.originalTransform = overlay.style.transform;
    this.panHost=overlay.parentElement??overlay;
    this.panHost.addEventListener("pointerdown",this.onPan,true);
    overlay.addEventListener("atl-conversation-updated", this.onUpdated);
    overlay.addEventListener("atl-branches-toggle", this.onBranchesToggle);
    this.unsubscribe = getMarginCardHandlers()?.subscribeGraph?.(() => this.redraw());
    this.resize = new ResizeObserver(() => { this.updateConnections(); });
  }

  /** Rails place source roots first, then this layer places their descendants. */
  public render(roots: RootCard[], options: Options): void {
    if (this.destroyed) return;
    this.roots = roots;
    this.options = options;
    if(!roots.length){this.sceneX=0;this.sceneY=0;this.overlay.style.transform=this.originalTransform;this.dismissed.clear();this.collapsed.clear();}
    // A store notification can precede the create result. Wait until direction
    // has been saved rather than briefly showing a child on the wrong side.
    if (this.pending.size && roots.length) { this.updateConnections(); return; }
    this.nodes.clear();
    this.resize.disconnect();
    const available = getMarginCardHandlers()?.graphCards?.(roots[0]?.mark.id ?? "") ?? [];
    const byId = new Map(available.map(mark => [mark.id, mark]));
    const allChildren = new Set<string>();
    const visible = new Set<string>();
    const seen = new Set<string>();
    for (const root of roots) {
      if (root.card.hidden) continue;
      const rootMark = byId.get(root.mark.id) ?? root.mark;
      this.nodes.set(root.mark.id, { mark: rootMark, card: root.card, slot: 0 });
      visible.add(root.mark.id);
      seen.add(root.mark.id);
      root.card.classList.add("atl-inline-workflow-card");
      const queue: { mark: AnchorMark; shown: boolean }[] = [{ mark: rootMark, shown: true }];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const parent = queue[cursor]!;
        const slots = new Map<BranchDirection, number>();
        for (const mark of available) {
          if (!mark.branch || mark.branch.parentAnnotationId !== parent.mark.id || seen.has(mark.id)) continue;
          if (mark.branch.rootAnnotationId !== root.mark.id) continue;
          if (rootMark.sourceFile && mark.sourceFile && mark.sourceFile !== rootMark.sourceFile) continue;
          seen.add(mark.id);
          allChildren.add(mark.id);
          const geom = this.geom.get(mark.id) ?? loadCardGeom(mark.id) ?? { dx: 0, dy: 0, side: "right" };
          if (!SIDES.includes(geom.side!)) geom.side = "right";
          this.geom.set(mark.id, geom);
          const slot = slots.get(geom.side!) ?? 0;
          slots.set(geom.side!, slot + 1);
          const shown = parent.shown && !this.collapsed.has(parent.mark.id) && !this.dismissed.has(mark.id);
          queue.push({ mark, shown });
          if (shown) visible.add(mark.id);
          const card = this.cards.get(mark, {
            skin: options.skin, geom, showReview: options.showReview,
            showBranches: false, inlineWorkflow: true,
            onCollapse: () => { this.dismissed.add(mark.id); this.redraw(); },
            onDragMove: () => this.updateConnections()
          });
          card.classList.add("atl-inline-workflow-card");
          if (card.parentElement !== this.overlay) this.overlay.appendChild(card);
          this.nodes.set(mark.id, { mark, card, parentId: parent.mark.id, geom, slot });
        }
      }
    }
    // Keep hidden drafts alive across folding, retaining focus/typed values and
    // their pending debounce. Only removed sources dispose cards and flush them.
    this.cards.retain(allChildren);
    for (const [id, node] of this.nodes) {
      node.card.hidden = !visible.has(id);
      if (!node.card.hidden) {
        this.resize.observe(node.card);
        this.ensurePorts(node);
      }
    }
    for (const [id, ports] of this.ports) {
      if (this.nodes.has(id) && visible.has(id)) continue;
      ports.dispose(); this.ports.delete(id);
    }
    // Children are inserted after parents. Aggregate visibility once from the
    // leaves rather than walking the entire tree for each toolbar button.
    const branchState = new Map<string, { hasChildren: boolean; allVisible: boolean }>();
    for (const node of [...this.nodes.values()].reverse()) {
      const state = branchState.get(node.mark.id) ?? { hasChildren: false, allVisible: true };
      const expanded = state.hasChildren && state.allVisible;
      const toggle = node.card.querySelector<HTMLElement>(".atl-branches-toggle");
      toggle?.setAttribute("aria-expanded", String(expanded));
      toggle?.setAttribute("aria-label", expanded ? "收起分支" : "展开分支");
      toggle?.setAttribute("title", expanded ? "收起分支" : "展开分支");
      if (node.parentId) {
        const parent = branchState.get(node.parentId) ?? { hasChildren: true, allVisible: true };
        parent.hasChildren = true;
        parent.allVisible = parent.allVisible && !node.card.hidden && state.allVisible;
        branchState.set(node.parentId, parent);
      }
    }
    this.updateConnections();
    if (this.focusId) {
      const card = this.nodes.get(this.focusId)?.card;
      if (card) {
        this.frameCard(card);
        card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")?.focus({ preventScroll: true });
        this.focusId = undefined;
      }
    }
  }

  /** Positions belong to each card; only the connected endpoints follow a drag. */
  public updateConnections(): void {
    if (this.destroyed) return;
    for (const node of this.nodes.values()) {
      if (!node.parentId || !node.geom || node.card.hidden) continue;
      const parent = this.nodes.get(node.parentId)?.card;
      if (!parent || parent.hidden || node.card.dataset["dragging"]) continue;
      const root = this.nodes.get(node.mark.branch!.rootAnnotationId)?.card;
      if (!root) continue;
      // Source-root bases follow document scrolling/reflow, but never its drag.
      const baseLeft = Number(root.dataset["baseLeft"] ?? this.left(root));
      const baseTop = Number(root.dataset["baseTop"] ?? this.top(root));
      if (node.geom.space !== "source") {
        const side = node.geom.side ?? "right";
        const width = node.card.offsetWidth, height = node.card.offsetHeight;
        const px = this.left(parent), py = this.top(parent);
        const x = side === "bottom" ? px + (parent.offsetWidth - width) / 2 + node.slot * 40
          : side === "left" ? px - width - BRANCH_GAP : px + parent.offsetWidth + BRANCH_GAP;
        const y = side === "bottom" ? py + parent.offsetHeight + BRANCH_GAP
          : py + (parent.offsetHeight - height) / 2 + node.slot * 40;
        // Convert earlier parent-relative layouts once, preserving their visible
        // position. Every subsequent move is independent of the parent card.
        node.geom.dx = x + node.geom.dx - baseLeft;
        node.geom.dy = y + node.geom.dy - baseTop;
        node.geom.space = "source";
        persistCardGeom(node.mark.id, node.geom);
      }
      node.card.dataset["baseLeft"] = String(baseLeft);
      node.card.dataset["baseTop"] = String(baseTop);
      node.card.style.left = `${baseLeft + node.geom.dx}px`;
      node.card.style.top = `${baseTop + node.geom.dy}px`;
    }
    for (const [id, ports] of this.ports) {
      const card = this.nodes.get(id)?.card;
      ports.el.hidden = !card || card.hidden;
      if (!card) continue;
      ports.el.style.left = `${this.left(card)}px`;
      ports.el.style.top = `${this.top(card)}px`;
      ports.el.style.width = `${card.offsetWidth}px`;
      ports.el.style.height = `${card.offsetHeight}px`;
    }
    this.svg.querySelectorAll(".atl-workflow-link").forEach(el => el.remove());
    const origin = this.originRect();
    for (const root of this.roots) if (!root.card.hidden) updateConnector(this.svg, root.card, origin);
    for (const node of this.nodes.values()) {
      if (!node.parentId || node.card.hidden) continue;
      const parent = this.nodes.get(node.parentId)?.card;
      if (!parent || parent.hidden) continue;
      const a = parent.getBoundingClientRect(), b = node.card.getBoundingClientRect();
      const side = node.geom?.side ?? "right";
      const path = this.svg.ownerDocument.createElementNS(SVG_NS, "path");
      path.classList.add("atl-workflow-link");
      path.dataset["childId"] = node.mark.id;
      path.dataset["parentId"] = node.parentId;
      path.dataset["direction"] = side;
      path.setAttribute("d", connectionPath(a, b, side, origin));
      this.svg.appendChild(path);
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.(); this.resize.disconnect();
    this.stopPan?.();this.panHost.removeEventListener("pointerdown",this.onPan,true);
    this.overlay.removeEventListener("atl-conversation-updated", this.onUpdated);
    this.overlay.removeEventListener("atl-branches-toggle", this.onBranchesToggle);
    for (const ports of this.ports.values()) ports.dispose();
    this.ports.clear(); this.nodes.clear(); this.cards.clear();
    this.svg.querySelectorAll(".atl-workflow-link").forEach(el => el.remove());
    this.overlay.style.transform = this.originalTransform;
  }

  private ensurePorts(node: Node): void {
    const target = marginReplyTarget(node.mark);
    const existing = this.ports.get(node.mark.id);
    if (!target || !getMarginCardHandlers()?.createConversation) {
      existing?.dispose(); this.ports.delete(node.mark.id); return;
    }
    if (existing?.card === node.card) return;
    existing?.dispose();
    const el = this.overlay.ownerDocument.createElement("div");
    el.className = "atl-workflow-ports";
    el.dataset["atlOwner"] = node.mark.id;
    const enter = (): void => { el.classList.add("is-hovered"); };
    const leave = (event: PointerEvent): void => {
      const next = event.relatedTarget;
      if (next instanceof this.overlay.ownerDocument.defaultView!.Node && (node.card.contains(next) || el.contains(next))) return;
      el.classList.remove("is-hovered");
    };
    node.card.addEventListener("pointerenter", enter);
    node.card.addEventListener("pointerleave", leave);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    for (const side of SIDES) {
      const button = this.overlay.ownerDocument.createElement("button");
      button.className = "atl-branch-port";
      button.dataset["direction"] = side;
      button.textContent = "+";
      button.setAttribute("aria-label", `${side === "left" ? "左侧" : side === "right" ? "右侧" : "下方"}创建分支`);
      button.title = button.getAttribute("aria-label")!;
      button.addEventListener("pointerdown", event => event.stopPropagation());
      button.onclick = event => { event.stopPropagation(); void this.create(node.mark.id, side); };
      el.appendChild(button);
    }
    this.overlay.appendChild(el);
    this.ports.set(node.mark.id, { el, card: node.card, dispose: () => {
      node.card.removeEventListener("pointerenter", enter);
      node.card.removeEventListener("pointerleave", leave);
      el.remove();
    } });
  }

  private async create(parentId: string, side: BranchDirection): Promise<void> {
    if (this.pending.has(parentId) || this.destroyed) return;
    const parent = this.nodes.get(parentId);
    const target = parent && marginReplyTarget(parent.mark);
    const h = getMarginCardHandlers();
    if (!parent || !target || !h?.createConversation) return;
    this.pending.add(parentId);
    this.ports.get(parentId)?.el.querySelectorAll("button").forEach(button => { button.disabled = true; });
    try {
      const created = await h.createConversation(parentId, target);
      if (!created) return;
      const geom: Geom = { dx: 0, dy: 0, side, ...(parent.card.offsetWidth ? { w: parent.card.offsetWidth } : {}) };
      this.geom.set(created.id, geom);
      persistCardGeom(created.id, geom);
      if (this.destroyed) return;
      // Creating from a folded card reveals this path without disturbing a
      // sibling's independent fold state.
      for (let node: Node | undefined = parent; node; node = node.parentId ? this.nodes.get(node.parentId) : undefined) {
        this.collapsed.delete(node.mark.id);
        this.dismissed.delete(node.mark.id);
      }
      this.dismissed.delete(created.id);
      this.focusId = created.id;
    } catch {
      if (!this.destroyed) new Notice("创建分支失败，请重试。");
    } finally {
      this.pending.delete(parentId);
      this.ports.get(parentId)?.el.querySelectorAll("button").forEach(button => { button.disabled = false; });
      this.redraw();
    }
  }

  /** Frame a new card without scrolling the original text or changing geometry. */
  private frameCard(card: HTMLElement): void {
    const bounds=this.originRect(), rect=card.getBoundingClientRect();
    const inset=36;
    let dx=0,dy=0;
    if(rect.left<bounds.left+inset)dx=bounds.left+inset-rect.left;
    else if(rect.right>bounds.right-inset)dx=bounds.right-inset-rect.right;
    if(rect.top<bounds.top+inset)dy=bounds.top+inset-rect.top;
    else if(rect.bottom>bounds.bottom-inset)dy=bounds.bottom-inset-rect.bottom;
    if(!dx&&!dy)return;
    this.sceneX+=dx;this.sceneY+=dy;
    this.applyScene();
    this.updateConnections();
  }
  private applyScene(): void {this.overlay.style.transform=`translate(${this.sceneX}px, ${this.sceneY}px)`;}
  private redraw(): void {
    if (this.destroyed || !this.options) return;
    this.render(this.roots, this.options);
    this.schedule();
  }
  private left(card: HTMLElement): number { return parseFloat(card.style.left) || card.offsetLeft; }
  private top(card: HTMLElement): number { return parseFloat(card.style.top) || card.offsetTop; }
  private descendants(id: string): Node[] {
    const queue = [id], result: Node[] = [], seen = new Set([id]);
    for (let cursor = 0; cursor < queue.length; cursor++) for (const node of this.nodes.values()) {
      if (node.parentId !== queue[cursor] || seen.has(node.mark.id)) continue;
      seen.add(node.mark.id); queue.push(node.mark.id); result.push(node);
    }
    return result;
  }
}
