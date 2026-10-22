// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Notice: class {}, addIcon: vi.fn(), setIcon: vi.fn(), setTooltip: vi.fn() }));
import {
  buildMarginCard,
  disposeMarginCard,
  setMarginCardHandlers,
  type MarginCardHandlers
} from "../src/margin-card.js";

const mark = {
  id: "ANN-markdown",
  blockId: "paragraph",
  selectedText: "原文",
  note: "学习者的 **原始笔记**",
  review: "**能指**是物质性的单位。",
  reviewQuestion: "怎样理解 **替代**？",
  dialogue: [{ role: "agent" as const, text: "**对话回复**", at: "2026-10-20T00:00:00Z" }]
};
const cards: HTMLElement[] = [];

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "createEl", {
    configurable: true,
    value(tag: string, options: { cls?: string }) {
      const el = document.createElement(tag);
      el.className = options.cls ?? "";
      this.append(el);
      return el;
    }
  });
});
afterEach(() => {
  for (const card of cards.splice(0)) disposeMarginCard(card);
  setMarginCardHandlers(null);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setRenderer(render: MarginCardHandlers["render"]): void {
  setMarginCardHandlers({
    save: vi.fn(), ask: vi.fn(), discuss: vi.fn(), reply: vi.fn(),
    render, saveCell: vi.fn(), remove: vi.fn(), settings: vi.fn()
  });
}

function build(overrides: Partial<typeof mark> = {}): HTMLElement {
  const { card } = buildMarginCard({ ...mark, ...overrides }, {
    skin: { id: "flat", quiet: false, tilt: null },
    geom: { dx: 0, dy: 0 }, showReview: true, onCollapse: vi.fn(), onDragMove: vi.fn()
  });
  cards.push(card);
  document.body.append(card);
  return card;
}

describe("annotation card Markdown", () => {
  it("renders reviews and questions through the same Markdown host as dialogue", async () => {
    // The actual Obsidian renderer owns Markdown parsing, links and sanitizing.
    // Its DOM result must survive the card's synchronous build and async finish.
    const render = vi.fn(async (el: HTMLElement, markdown: string) => {
      await Promise.resolve();
      const paragraph = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = markdown;
      paragraph.append(strong);
      el.append(paragraph);
    });
    setRenderer(render);
    const card = build();
    await Promise.resolve();
    expect(render.mock.calls.map(([el, markdown]) => [el.className, markdown])).toEqual([
      ["atl-rail-review atl-rail-md", mark.review],
      ["atl-rail-question atl-rail-md", mark.reviewQuestion],
      ["atl-rail-turn atl-rail-turn--agent atl-rail-md", mark.dialogue[0]!.text]
    ]);
    expect(render).toHaveBeenNthCalledWith(1, card.querySelector(".atl-rail-review"), mark.review, mark.id);
    expect(render).toHaveBeenNthCalledWith(2, card.querySelector(".atl-rail-question"), mark.reviewQuestion, mark.id);
    expect(card.querySelector(".atl-rail-review strong")?.textContent).toBe(mark.review);
    expect(card.querySelector(".atl-rail-question strong")?.textContent).toBe(mark.reviewQuestion);
    expect(card.querySelector<HTMLTextAreaElement>(".atl-rail-edit")?.value).toBe(mark.note);
  });

  it("keeps source text inert when no Markdown renderer is installed", () => {
    const raw = '**强调** <img src=x onerror="alert(1)">';
    const card = build({ review: raw });
    expect(card.querySelector(".atl-rail-review")?.textContent).toBe(raw);
    expect(card.querySelector(".atl-rail-review img")).toBeNull();
  });

  it.each(["synchronous", "asynchronous"])("restores inert text after a %s render failure", async (failure) => {
    setRenderer((el) => {
      el.append(document.createElement("strong"));
      if (failure === "synchronous") throw new Error("renderer unavailable");
      return Promise.reject(new Error("renderer unavailable"));
    });
    const raw = '**强调** <script>alert(1)</script>';
    const card = build({ review: raw });
    await Promise.resolve();
    await Promise.resolve();
    const review = card.querySelector<HTMLElement>(".atl-rail-review")!;
    expect(review.textContent).toBe(raw);
    expect(review.childElementCount).toBe(0);
    expect(review.classList.contains("atl-rail-md")).toBe(false);
  });
});
