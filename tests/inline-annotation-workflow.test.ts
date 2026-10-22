// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Notice: class {}, addIcon: vi.fn(), setIcon: vi.fn(), setTooltip: vi.fn() }));
import { InlineAnnotationWorkflow } from "../src/inline-annotation-workflow.js";
import { buildMarginCard, disposeMarginCard, flushMarginConversationDrafts, setCardGeomStore, setMarginCardHandlers, type Geom, type MarginCardHandlers } from "../src/margin-card.js";
import type { AnchorMark } from "../src/decorations-plan.js";

const skin = { id: "flat", quiet: false, tilt: null } as const;
const source = "reading.md";
const root: AnchorMark = { id: "A", sourceFile: source, blockId: "block", selectedText: "Source text", note: "Original question", review: "Original Tutor answer" };
function branch(id: string, parent = "A", options: Partial<AnchorMark> = {}): AnchorMark {
  return { id, sourceFile: source, blockId: "block", selectedText: root.selectedText, note: "", branch: {
    parentAnnotationId: parent, rootAnnotationId: "A", sourceVersion: "source-v1",
    parentReply: { id: "review", kind: "review", text: "Pinned parent answer", version: "v1" }
  }, request: { id: `request-${id}`, status: "draft", question: "", updatedAt: "2026-10-20" }, ...options };
}

const workflows: InlineAnnotationWorkflow[] = [], roots: HTMLElement[] = [];
const origin = new DOMRect(100, 60, 1000, 800);
const overlayOrigin = new DOMRect(860, 60, 240, 800);
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "createEl", { configurable: true, value(tag: string, options: { cls?: string } = {}) {
    const el = document.createElement(tag); el.className = options.cls ?? ""; this.append(el); return el;
  } });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return parseFloat(this.style.width) || (this.classList.contains("atl-rail-card") ? 224 : 240);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return parseFloat(this.style.height) || (this.classList.contains("atl-rail-card") ? 160 : 800);
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return parseFloat(this.style.left) || 0; });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return parseFloat(this.style.top) || 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("qa-source-pane")) return origin;
    if (this.classList.contains("atl-rail")) {
      const translate = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(this.style.transform);
      return new DOMRect(overlayOrigin.left + Number(translate?.[1] ?? 0), overlayOrigin.top + Number(translate?.[2] ?? 0), overlayOrigin.width, overlayOrigin.height);
    }
    const parent = this.parentElement?.getBoundingClientRect() ?? new DOMRect();
    return new DOMRect(parent.left + this.offsetLeft, parent.top + this.offsetTop, this.offsetWidth, this.offsetHeight);
  });
});
afterEach(async () => {
  for (const workflow of workflows.splice(0)) workflow.destroy();
  for (const card of roots.splice(0)) disposeMarginCard(card);
  await settle();
  setMarginCardHandlers(null); setCardGeomStore(null);
  document.body.replaceChildren(); vi.restoreAllMocks();
});

function fixture(initial: AnchorMark[] = [root], extra: Partial<MarginCardHandlers> = {}, storedGeometry: [string, Geom][] = []) {
  let marks = [...initial];
  const geometries = new Map<string, Geom>(storedGeometry);
  setCardGeomStore({ get: id => geometries.get(id), set: (id, geom) => { geometries.set(id, { ...geom }); } });
  const h: MarginCardHandlers = {
    save: vi.fn(), ask: vi.fn(), discuss: vi.fn(), saveCell: vi.fn(), remove: vi.fn(), settings: vi.fn(),
    render: (el, text) => { el.textContent = text; }, graphCards: () => marks,
    saveDraft: vi.fn(async (id, note) => { marks = marks.map(mark => mark.id === id ? { ...mark, note } : mark); }),
    createConversation: vi.fn(async parent => {
      const next = branch(marks.some(mark => mark.id === "B") ? "C" : "B", parent);
      marks.push(next); return { id: next.id };
    }),
    reply: vi.fn(async (id, question) => {
      marks = marks.map(mark => mark.id === id ? { ...mark, note: question, review: "Saved Tutor answer", request: { ...mark.request!, status: "completed", question } } : mark);
      return { ok: true, agentText: "Saved Tutor answer" };
    }), ...extra
  };
  setMarginCardHandlers(h);
  const pane = document.createElement("div"); pane.className = "qa-source-pane cm-editor";
  const sourceText = document.createElement("p"); sourceText.textContent = "The source document remains unchanged.";
  const overlay = document.createElement("div"); overlay.className = "atl-rail";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  pane.append(sourceText, svg, overlay); document.body.append(pane);
  let workflow: InlineAnnotationWorkflow;
  const geom: Geom = { dx: 0, dy: 0 };
  const { card } = buildMarginCard(root, { skin, geom, showReview: true, onCollapse: vi.fn(), onDragMove: () => workflow.updateConnections() });
  card.style.left = "4px"; card.style.top = "80px"; card.dataset["baseLeft"] = "4"; card.dataset["baseTop"] = "80";
  overlay.append(card); roots.push(card);
  const render = (): void => workflow.render([{ mark: root, card }], { skin, showReview: true });
  const schedule = vi.fn(() => queueMicrotask(render));
  workflow = new InlineAnnotationWorkflow(overlay, svg, () => origin, schedule); workflows.push(workflow);
  render();
  const getCard = (id: string): HTMLElement | null => overlay.querySelector(`.atl-rail-card[data-atl-id="${id}"]`);
  const getPort = (id: string, side: string): HTMLButtonElement => overlay.querySelector<HTMLButtonElement>(`.atl-workflow-ports[data-atl-owner="${id}"] .atl-branch-port[data-direction="${side}"]`)!;
  const getLine = (id: string): SVGPathElement | null => svg.querySelector(`.atl-workflow-link[data-child-id="${id}"]`);
  return { pane, sourceText, overlay, svg, card, workflow, geometries, h, render, getCard, getPort, getLine, setMarks: (next: AnchorMark[]) => { marks = next; } };
}

function endpoints(line: SVGPathElement): number[] {
  const values = line.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return [values[0]!, values[1]!, values.at(-2)!, values.at(-1)!];
}

function toggleBranches(card: HTMLElement): void {
  card.dispatchEvent(new CustomEvent("atl-branches-toggle", { bubbles: true, detail: { id: card.dataset["atlId"] } }));
}

describe("source annotation workflow", () => {
  it("keeps three creation ports outside the scrolling card and only creates on click", () => {
    const f = fixture();
    const ports = f.overlay.querySelector<HTMLElement>('.atl-workflow-ports[data-atl-owner="A"]')!;
    expect(ports.parentElement).toBe(f.overlay);
    expect(f.card.contains(ports)).toBe(false);
    expect([...ports.querySelectorAll<HTMLElement>(".atl-branch-port")].map(el => el.dataset["direction"]).sort()).toEqual(["bottom", "left", "right"]);
    expect(f.h.createConversation).not.toHaveBeenCalled();
    expect(f.overlay.querySelector(".atl-branches,.atl-branch-detail,.atl-branch-origin")).toBeNull();
  });

  it.each(["left", "right", "bottom"] as const)("creates a focused independent card strictly to the %s", async side => {
    const f = fixture();
    f.getPort("A", side).click(); await settle(); f.render();
    const child = f.getCard("B")!;
    expect(child).not.toBeNull(); expect(child.parentElement).toBe(f.overlay);
    expect(f.h.createConversation).toHaveBeenCalledWith("A", { kind: "review" });
    expect(f.geometries.get("B")?.side).toBe(side);
    if (side === "left") { expect(child.offsetLeft + child.offsetWidth).toBeLessThan(f.card.offsetLeft); expect(child.offsetLeft).toBeLessThan(0); }
    if (side === "right") expect(child.offsetLeft).toBeGreaterThan(f.card.offsetLeft + f.card.offsetWidth);
    if (side === "bottom") expect(child.offsetTop).toBeGreaterThan(f.card.offsetTop + f.card.offsetHeight);
    expect(document.activeElement).toBe(child.querySelector("textarea"));
    expect(f.card.querySelector(`.atl-rail-card[data-atl-id="B"]`)).toBeNull();
    expect(child.textContent).not.toMatch(/新对话草稿|衍生自|关联的 Tutor 回复|草稿会自动保存|对话已保存/);
  });

  it("converts editor rail coordinates to the SVG origin and updates both endpoints", async () => {
    const f = fixture();
    f.getPort("A", "right").click(); await settle(); f.render();
    const child = f.getCard("B")!, line = f.getLine("B")!;
    expect(line).not.toBeNull();
    const initial = endpoints(line), parentBox = f.card.getBoundingClientRect();
    expect(initial[0]).toBeCloseTo(parentBox.right - origin.left);
    expect(initial[1]).toBeCloseTo(parentBox.top - origin.top + parentBox.height / 2);
    expect(initial[2]).toBeCloseTo(child.getBoundingClientRect().left - origin.left);
    f.card.style.left = `${f.card.offsetLeft + 45}px`; f.card.style.top = `${f.card.offsetTop + 25}px`;
    f.workflow.updateConnections();
    const movedParent = endpoints(f.getLine("B")!);
    expect(movedParent[0]).toBeCloseTo(initial[0]! + 45); expect(movedParent[1]).toBeCloseTo(initial[1]! + 25);
    child.style.left = `${child.offsetLeft + 30}px`; child.style.top = `${child.offsetTop + 10}px`;
    f.workflow.updateConnections();
    const movedChild = endpoints(f.getLine("B")!);
    expect(movedChild[2]).toBeCloseTo(child.getBoundingClientRect().left - origin.left);
    expect(movedChild[3]).toBeCloseTo(child.getBoundingClientRect().top - origin.top + child.offsetHeight / 2);
  });

  it.each(["left", "right", "bottom"] as const)("draws one smooth %s connector between both card borders independently of its hover port", async side => {
    const f = fixture();
    f.getPort("A", side).click(); await settle(); f.render();
    const child = f.getCard("B")!;
    const expectAttached = (): number[] => {
      const line = f.getLine("B")!, d = line.getAttribute("d")!;
      expect(d).toMatch(/^M [-\d.]+ [-\d.]+ C /);
      expect(d).not.toMatch(/[LQ]|NaN|Infinity/);
      const values = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect(values).toHaveLength(8);
      const a = f.card.getBoundingClientRect(), b = child.getBoundingClientRect();
      const start = side === "left" ? [a.left, a.top + a.height / 2]
        : side === "right" ? [a.right, a.top + a.height / 2]
        : [a.left + a.width / 2, a.bottom];
      const finishes = [[b.left, b.top + b.height / 2, -1, 0], [b.right, b.top + b.height / 2, 1, 0],
        [b.left + b.width / 2, b.top, 0, -1], [b.left + b.width / 2, b.bottom, 0, 1]];
      const distance = (point: number[]): number => Math.hypot(point[0]! - start[0]!, point[1]! - start[1]!);
      const finish = finishes.reduce((closest, point) => distance(point) < distance(closest) ? point : closest);
      const tangent = Math.min(120, distance(finish) * 0.4);
      expect(values[0]).toBeCloseTo(start[0]! - origin.left);
      expect(values[1]).toBeCloseTo(start[1]! - origin.top);
      expect(values.at(-2)).toBeCloseTo(finish[0]! - origin.left);
      expect(values.at(-1)).toBeCloseTo(finish[1]! - origin.top);
      expect(values[2]! - values[0]!).toBeCloseTo(side === "left" ? -tangent : side === "right" ? tangent : 0);
      expect(values[3]! - values[1]!).toBeCloseTo(side === "bottom" ? tangent : 0);
      expect(values[4]! - values[6]!).toBeCloseTo(finish[2]! * tangent);
      expect(values[5]! - values[7]!).toBeCloseTo(finish[3]! * tangent);
      const ports = f.overlay.querySelector<HTMLElement>('.atl-workflow-ports[data-atl-owner="A"]')!;
      expect(ports.getBoundingClientRect()).toMatchObject({ left: a.left, top: a.top, width: a.width, height: a.height });
      return endpoints(line);
    };
    expectAttached();

    // A parent drag and independent resizing move only attachment points;
    // the child keeps its own saved position.
    f.card.style.left = `${f.card.offsetLeft + 45}px`;
    f.card.style.top = `${f.card.offsetTop + 25}px`;
    f.card.style.width = "310px"; f.card.style.height = "230px";
    child.style.width = "250px"; child.style.height = "190px";
    f.workflow.updateConnections();
    const beforePan = expectAttached();

    f.sourceText.dispatchEvent(new PointerEvent("pointerdown", { button: 0, altKey: true, pointerId: 17, clientX: 250, clientY: 150, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointermove", { altKey: true, pointerId: 17, clientX: 305, clientY: 185, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 17, clientX: 305, clientY: 185, bubbles: true }));
    const afterPan = expectAttached();
    expect(afterPan).toEqual([beforePan[0]! + 55, beforePan[1]! + 35, beforePan[2]! + 55, beforePan[3]! + 35]);
  });

  it.each([
    { side: "right", dx: 230, dy: 0, edge: "left", placement: "a narrow gap" },
    { side: "right", dx: -296, dy: 0, edge: "right", placement: "crossed to the other side" },
    { side: "right", dx: 0, dy: -240, edge: "bottom", placement: "above the parent" },
    { side: "right", dx: 100, dy: 30, edge: "top", placement: "overlapping the parent" },
    { side: "left", dx: 296, dy: 0, edge: "left", placement: "crossed to the other side" },
    { side: "bottom", dx: 0, dy: -240, edge: "bottom", placement: "above the parent" },
    { side: "bottom", dx: 0, dy: 166, edge: "top", placement: "a narrow gap" },
    { side: "right", dx: 224, dy: 0, edge: "left", placement: "touching borders" }
  ] as const)("keeps the $side curve finite with $placement and joins the facing $edge edge", ({ side, dx, dy, edge }) => {
    const f = fixture([root, branch("B")], {}, [["B", { side, space: "source", dx, dy }]]);
    const child = f.getCard("B")!, a = f.card.getBoundingClientRect(), b = child.getBoundingClientRect();
    const line = f.getLine("B")!, d = line.getAttribute("d")!;
    expect(d).toMatch(/^M [-\d.]+ [-\d.]+ C /);
    expect(d).not.toMatch(/[LQ]|NaN|Infinity/);
    const values = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(values).toHaveLength(8); expect(values.every(Number.isFinite)).toBe(true);
    const start = side === "bottom" ? [a.left + a.width / 2, a.bottom]
      : [side === "left" ? a.left : a.right, a.top + a.height / 2];
    const finish = edge === "top" || edge === "bottom" ? [b.left + b.width / 2, edge === "top" ? b.top : b.bottom]
      : [edge === "left" ? b.left : b.right, b.top + b.height / 2];
    expect(endpoints(line)).toEqual([start[0]! - origin.left, start[1]! - origin.top, finish[0]! - origin.left, finish[1]! - origin.top]);
    const tangent = Math.min(120, Math.hypot(finish[0]! - start[0]!, finish[1]! - start[1]!) * 0.4);
    expect(values[2]! - values[0]!).toBeCloseTo(side === "left" ? -tangent : side === "right" ? tangent : 0);
    expect(values[3]! - values[1]!).toBeCloseTo(side === "bottom" ? tangent : 0);
    expect(values[4]! - values[6]!).toBeCloseTo(edge === "left" ? -tangent : edge === "right" ? tangent : 0);
    expect(values[5]! - values[7]!).toBeCloseTo(edge === "top" ? -tangent : edge === "bottom" ? tangent : 0);
  });

  it("reserves one creation across all three ports until the saved child's direction is known", async () => {
    let resolve!: (value: { id: string }) => void;
    const createConversation = vi.fn(() => new Promise<{ id: string }>(done => { resolve = done; }));
    const f = fixture([root], { createConversation });
    f.getPort("A", "right").click(); f.getPort("A", "left").click(); f.getPort("A", "bottom").click();
    expect(createConversation).toHaveBeenCalledOnce();
    f.setMarks([root, branch("B")]); f.render();
    expect(f.getCard("B")).toBeNull();
    resolve({ id: "B" }); await settle();
    expect(f.getCard("B")).not.toBeNull();
    expect(f.geometries.get("B")?.side).toBe("right");
    expect(f.overlay.querySelectorAll('.atl-rail-card[data-atl-id="B"]')).toHaveLength(1);
  });

  it("keeps branches visible while the header opens only its own dialogue", async () => {
    const b = branch("B", "A", { note: "First question", review: "First answer", request: { id: "B", status: "completed", question: "First question", updatedAt: "now" } });
    const f = fixture([root, b, branch("C"), branch("D", "B")]);
    for (const id of ["B", "C", "D"]) expect(f.getCard(id)?.hidden).toBe(false);
    const own = f.card.querySelector<HTMLElement>(".atl-card-conversation")!;
    const childThread = f.getCard("B")!.querySelector<HTMLElement>(".atl-card-conversation")!;
    expect(own.hidden).toBe(true); expect(childThread.hidden).toBe(true);
    f.card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click(); await settle(); f.render();
    expect(own.hidden).toBe(false); expect(childThread.hidden).toBe(true);
    f.card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click(); await settle(); f.render();
    expect(own.hidden).toBe(true);
    for (const id of ["B", "C", "D"]) expect(f.getCard(id)?.hidden).toBe(false);
    expect(f.svg.querySelectorAll(".atl-workflow-link")).toHaveLength(3);
  });

  it("restores a child's saved direction and drag offset when opening a stored branch", async () => {
    const f = fixture([root, branch("B")], {}, [["B", { side: "bottom", dx: 35, dy: -20, w: 260 }]]);
    f.card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click(); await settle(); f.render();
    const child = f.getCard("B")!;
    expect(child.offsetWidth).toBe(260);
    expect(child.offsetLeft).toBeCloseTo(4 + (224 - 260) / 2 + 35);
    expect(child.offsetTop).toBeCloseTo(80 + 160 + 72 - 20);
    expect(f.getLine("B")!.dataset["direction"]).toBe("bottom");
    expect(f.geometries.get("B")).toMatchObject({ side: "bottom", space: "source", dx: 17, dy: 212 });
  });

  it("keeps each child thread local without hiding its descendants", async () => {
    const b = branch("B", "A", { note: "First question", review: "First answer", request: { id: "B", status: "completed", question: "First question", updatedAt: "now" } });
    const f = fixture([root, b, branch("D", "B")]);
    const toggle = f.getCard("B")!.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!;
    toggle.click(); await settle();
    expect(f.getCard("B")!.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(false);
    expect(f.card.querySelector<HTMLElement>(".atl-card-conversation")!.hidden).toBe(true);
    expect(f.getCard("D")!.hidden).toBe(false);
    toggle.click(); await settle(); expect(f.getCard("D")!.hidden).toBe(false);
  });

  it("folds and reopens the entire branch tree without destroying draft cards or changing their positions", async () => {
    const b = branch("B", "A", { review: "B answer" });
    const f = fixture([root, b, branch("C"), branch("D", "B")]);
    const children = ["B", "C", "D"].map(id => f.getCard(id)!);
    const positions = children.map(card => [card.style.left, card.style.top]);
    const editor = children[1]!.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "A draft kept while folded";
    editor.dispatchEvent(new Event("input"));
    const own = f.card.querySelector<HTMLElement>(".atl-card-conversation")!;
    const toggle = f.card.querySelector<HTMLButtonElement>(".atl-branches-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("收起分支");
    expect(own.hidden).toBe(true);
    toggle.click(); await settle();
    for (const child of children) expect(child.hidden).toBe(true);
    expect(f.svg.querySelectorAll(".atl-workflow-link")).toHaveLength(0);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("展开分支");
    expect(toggle.title).toBe("展开分支");
    expect(own.hidden).toBe(true);
    f.render();
    for (const child of children) expect(child.hidden).toBe(true);
    toggle.click(); await settle();
    for (const [index, id] of ["B", "C", "D"].entries()) {
      const card = f.getCard(id)!;
      expect(card).toBe(children[index]); expect(card.hidden).toBe(false);
      expect([card.style.left, card.style.top]).toEqual(positions[index]);
    }
    expect(f.getCard("C")!.querySelector<HTMLTextAreaElement>("textarea")).toBe(editor);
    expect(editor.value).toBe("A draft kept while folded");
    expect(f.svg.querySelectorAll(".atl-workflow-link")).toHaveLength(3);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(f.h.reply).not.toHaveBeenCalled();
  });

  it("reopens descendants individually closed with X directly from the branch toggle", async () => {
    const f = fixture([root, branch("B"), branch("C"), branch("D", "B")]);
    const b = f.getCard("B")!, d = f.getCard("D")!;
    b.querySelector<HTMLButtonElement>(".atl-rail-card-head button:last-child")!.click(); await settle();
    f.render(); expect(b.hidden).toBe(true); expect(d.hidden).toBe(true); expect(f.getLine("B")).toBeNull();
    expect(f.getCard("C")!.hidden).toBe(false);
    toggleBranches(f.card); await settle();
    expect(f.getCard("B")).toBe(b); expect(b.hidden).toBe(false);
    expect(f.getCard("D")).toBe(d); expect(d.hidden).toBe(false);
    expect(f.svg.querySelectorAll(".atl-workflow-link")).toHaveLength(3);
  });

  it("folds a child's subtree without hiding that card or its siblings, and a root toggle can reopen every nested fold", async () => {
    const f = fixture([root, branch("B"), branch("C"), branch("D", "B")]);
    toggleBranches(f.getCard("B")!); await settle();
    expect(f.getCard("B")!.hidden).toBe(false); expect(f.getCard("C")!.hidden).toBe(false);
    expect(f.getCard("D")!.hidden).toBe(true);
    expect(f.getLine("B")).not.toBeNull(); expect(f.getLine("C")).not.toBeNull(); expect(f.getLine("D")).toBeNull();
    f.render(); expect(f.getCard("D")!.hidden).toBe(true);
    toggleBranches(f.card); await settle();
    for (const id of ["B", "C", "D"]) expect(f.getCard(id)!.hidden).toBe(false);
    toggleBranches(f.card); await settle();
    for (const id of ["B", "C", "D"]) expect(f.getCard(id)!.hidden).toBe(true);
  });

  it("shows a newly created branch from a folded parent while retaining an unrelated nested fold", async () => {
    const f = fixture([root, branch("B", "A", { review: "B answer" }), branch("D", "B")]);
    toggleBranches(f.getCard("B")!); await settle();
    // A new sibling is shown without clearing another card's nested fold.
    f.getPort("A", "right").click(); await settle();
    expect(f.getCard("C")!.hidden).toBe(false);
    expect(f.getCard("B")!.hidden).toBe(false);
    expect(f.getCard("D")!.hidden).toBe(true);
    expect(f.getLine("C")).not.toBeNull();
    expect(document.activeElement).toBe(f.getCard("C")!.querySelector("textarea"));
  });

  it("expands a folded parent when a new branch is created from its hover port", async () => {
    const f = fixture([root, branch("B")]);
    toggleBranches(f.card); await settle();
    expect(f.getCard("B")!.hidden).toBe(true);
    f.getPort("A", "bottom").click(); await settle();
    expect(f.getCard("B")!.hidden).toBe(false); expect(f.getCard("C")!.hidden).toBe(false);
    expect(f.svg.querySelectorAll(".atl-workflow-link")).toHaveLength(2);
  });

  it("ignores malformed branch-toggle events and keeps their listeners detached after destruction", async () => {
    const f = fixture([root, branch("B")]);
    f.card.dispatchEvent(new CustomEvent("atl-branches-toggle", { bubbles: true, detail: { id: "missing" } }));
    f.card.dispatchEvent(new CustomEvent("atl-branches-toggle", { bubbles: true, detail: { id: 1 } }));
    expect(f.getCard("B")!.hidden).toBe(false);
    f.workflow.destroy();
    expect(() => toggleBranches(f.card)).not.toThrow();
  });

  it("persists a real pointer drag and reloads its independent source-relative position and direction", async () => {
    const f = fixture();
    f.getPort("A", "left").click(); await settle();
    const child = f.getCard("B")!, head = child.querySelector<HTMLElement>(".atl-rail-card-head")!;
    const beforeLeft = child.offsetLeft, beforeTop = child.offsetTop;
    head.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 7, clientX: 200, clientY: 180, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 255, clientY: 210, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: 255, clientY: 210, bubbles: true }));
    expect(child.offsetLeft).toBeCloseTo(beforeLeft + 55); expect(child.offsetTop).toBeCloseTo(beforeTop + 30);
    const stored = f.geometries.get("B")!;
    expect(stored).toMatchObject({ side: "left", space: "source", dx: beforeLeft - 4 + 55, dy: beforeTop - 80 + 30 });
    f.workflow.destroy();
    const reloaded = new InlineAnnotationWorkflow(f.overlay, f.svg, () => origin, vi.fn()); workflows.push(reloaded);
    reloaded.render([{ mark: root, card: f.card }], { skin, showReview: true });
    const restored = f.getCard("B")!;
    expect(restored.offsetLeft).toBeCloseTo(beforeLeft + 55); expect(restored.offsetTop).toBeCloseTo(beforeTop + 30);
    expect(f.getLine("B")!.dataset["direction"]).toBe("left");
    expect(f.geometries.get("B")).toEqual(stored);
  });

  it("moves each card independently, persists all positions and follows document scrolling", async () => {
    const b=branch("B","A",{review:"B answer",request:{id:"b",status:"completed",question:"",updatedAt:"now"}});
    const f=fixture([root,b,branch("D","B")]);
    const move=(card:HTMLElement,x:number,y:number):void=>{
      card.querySelector<HTMLElement>(".atl-rail-card-head")!.dispatchEvent(new PointerEvent("pointerdown",{button:0,pointerId:42,clientX:100,clientY:100,bubbles:true}));
      document.dispatchEvent(new PointerEvent("pointermove",{pointerId:42,clientX:100+x,clientY:100+y,bubbles:true}));
      document.dispatchEvent(new PointerEvent("pointerup",{pointerId:42,bubbles:true}));
    };
    const child=f.getCard("B")!,grand=f.getCard("D")!;
    const initialChild=[child.offsetLeft,child.offsetTop],initialGrand=[grand.offsetLeft,grand.offsetTop];
    const initialLine=endpoints(f.getLine("B")!);
    move(f.card,90,55);f.render();
    expect([child.offsetLeft,child.offsetTop]).toEqual(initialChild);
    expect([grand.offsetLeft,grand.offsetTop]).toEqual(initialGrand);
    expect(endpoints(f.getLine("B")!).slice(0,2)).toEqual([initialLine[0]!+90,initialLine[1]!+55]);
    expect(endpoints(f.getLine("B")!).slice(2)).toEqual(initialLine.slice(2));
    move(child,-40,35);f.render();
    expect([child.offsetLeft,child.offsetTop]).toEqual([initialChild[0]!-40,initialChild[1]!+35]);
    expect([grand.offsetLeft,grand.offsetTop]).toEqual(initialGrand);
    const savedChild={...f.geometries.get("B")!},savedGrand={...f.geometries.get("D")!};
    f.workflow.destroy();const reload=new InlineAnnotationWorkflow(f.overlay,f.svg,()=>origin,vi.fn());workflows.push(reload);
    reload.render([{mark:root,card:f.card}],{skin,showReview:true});
    expect([f.getCard("B")!.offsetLeft,f.getCard("B")!.offsetTop]).toEqual([initialChild[0]!-40,initialChild[1]!+35]);
    expect([f.getCard("D")!.offsetLeft,f.getCard("D")!.offsetTop]).toEqual(initialGrand);
    f.card.dataset["baseTop"]="20";f.card.style.top=`${f.card.offsetTop-60}px`;reload.updateConnections();
    expect(f.getCard("B")!.offsetTop).toBe(initialChild[1]!+35-60);
    expect(f.getCard("D")!.offsetTop).toBe(initialGrand[1]!-60);
    expect(f.geometries.get("B")).toEqual(savedChild);expect(f.geometries.get("D")).toEqual(savedGrand);
  });

  it("frames a new right child inside the source pane without changing its strict layout", async () => {
    const f = fixture();
    f.getPort("A", "right").click(); await settle();
    const child = f.getCard("B")!, box = child.getBoundingClientRect();
    expect(f.overlay.style.transform).toMatch(/^translate\(/);
    expect(box.left).toBeGreaterThanOrEqual(origin.left + 32); expect(box.right).toBeLessThanOrEqual(origin.right - 32);
    expect(child.offsetLeft).toBeGreaterThan(f.card.offsetLeft + f.card.offsetWidth);
    expect(f.geometries.get("B")).toMatchObject({ side: "right", space: "source", dx: 296, dy: 0 });
    const endpoint = endpoints(f.getLine("B")!);
    expect(endpoint[2]).toBeCloseTo(box.left - origin.left);
    f.workflow.destroy();
    expect(f.overlay.style.transform).toBe("");
  });

  it("resets only the temporary framing when the source roots leave the view", async () => {
    const f = fixture();
    f.getPort("A", "right").click(); await settle();
    const saved = { ...f.geometries.get("B")! };
    expect(f.overlay.style.transform).not.toBe("");
    f.workflow.render([], { skin, showReview: true });
    expect(f.overlay.style.transform).toBe("");
    expect(f.geometries.get("B")).toEqual(saved);
    expect(f.card.style.left).toBe("4px"); expect(f.card.style.top).toBe("80px");
  });

  it("pans only the annotation scene with Alt-drag while preserving source text and saved layout", async () => {
    const f = fixture();
    f.getPort("A", "right").click(); await settle();
    const child = f.getCard("B")!, childPosition = [child.style.left, child.style.top], rootPosition = [f.card.style.left, f.card.style.top];
    const saved = { ...f.geometries.get("B")! }, sourceBefore = f.sourceText.innerHTML;
    const readTranslation = (): number[] => f.overlay.style.transform.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const before = readTranslation();
    f.sourceText.dispatchEvent(new PointerEvent("pointerdown", { button: 0, altKey: true, pointerId: 9, clientX: 250, clientY: 150, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointermove", { altKey: true, pointerId: 9, clientX: 330, clientY: 195, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9, clientX: 330, clientY: 195, bubbles: true }));
    expect(readTranslation()).toEqual([before[0]! + 80, before[1]! + 45]);
    expect([child.style.left, child.style.top]).toEqual(childPosition); expect([f.card.style.left, f.card.style.top]).toEqual(rootPosition);
    expect(f.geometries.get("B")).toEqual(saved); expect(f.sourceText.innerHTML).toBe(sourceBefore);
    expect(f.h.save).not.toHaveBeenCalled(); expect(f.h.reply).not.toHaveBeenCalled();
    const after = f.overlay.style.transform;
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 9, clientX: 800, clientY: 700, bubbles: true }));
    expect(f.overlay.style.transform).toBe(after);
  });

  it("keeps failed questions in the same independent annotation when retried", async () => {
    const reply = vi.fn().mockResolvedValueOnce({ ok: false, error: "teaching-reply-string-required" }).mockResolvedValueOnce({ ok: true, agentText: "Recovered answer" });
    const f = fixture([root], { reply });
    f.getPort("A", "bottom").click(); await settle(); f.render();
    const child = f.getCard("B")!, editor = child.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "A question that must survive"; editor.dispatchEvent(new Event("input"));
    child.querySelector<HTMLButtonElement>(".atl-branch-send")!.click(); await settle();
    expect(editor.value).toBe("A question that must survive");
    expect(child.textContent).toContain("问题已保存，可重试"); expect(child.textContent).not.toContain("teaching-reply-string-required");
    child.querySelector<HTMLButtonElement>(".atl-branch-send")!.click(); await settle();
    expect(reply.mock.calls).toEqual([["B", "A question that must survive", expect.any(Function)], ["B", "A question that must survive", expect.any(Function)]]);
    expect(f.h.createConversation).toHaveBeenCalledOnce();
    expect(child.querySelector(".atl-rail-review")?.textContent).toBe("Recovered answer");
    expect(f.h.saveDraft).toHaveBeenCalledWith("B", "A question that must survive");
  });

  it("flushes a focused child draft when the source closes and restores it", async () => {
    const f = fixture();
    f.getPort("A", "left").click(); await settle(); f.render();
    const editor = f.getCard("B")!.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.focus(); editor.value = "An unsent branch question"; editor.dispatchEvent(new Event("input"));
    f.workflow.render([], {skin,showReview:true}); await settle();
    await flushMarginConversationDrafts();
    expect(f.h.saveDraft).toHaveBeenCalledWith("B", "An unsent branch question");
    f.render(); await settle();
    expect(f.getCard("B")!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("An unsent branch question");
    expect(f.h.reply).not.toHaveBeenCalled();
  });

  it("ignores disconnected, cyclic and cross-source branch records", async () => {
    const f = fixture([root, branch("B"), branch("orphan", "missing"), branch("cycle", "cycle"), branch("other-source", "A", { sourceFile: "other.md" })]);
    f.card.querySelector<HTMLButtonElement>(".atl-dialogue-toggle")!.click(); await settle(); f.render();
    expect(f.getCard("B")).not.toBeNull();
    for (const id of ["orphan", "cycle", "other-source"]) expect(f.getCard(id)).toBeNull();
  });
});
