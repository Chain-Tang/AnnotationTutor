// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
const css = readFileSync("styles.css", "utf8");
beforeEach(() => {
  const style = document.createElement("style"); style.textContent = css;
  document.head.append(style);
});
afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); });
describe("annotation appearance", () => {
  it.each(["flat", "paper", "sticky", "leaf", "custom"])("keeps %s controls hidden at rest and black when revealed", skin => {
    document.body.innerHTML = `<div class="atl-rail-card atl-rail-card--quiet atl-skin-${skin}"><div class="atl-rail-card-head"><button class="atl-iconbtn"><svg class="svg-icon"></svg></button></div></div>`;
    const button = document.querySelector("button")!;
    const svg = document.querySelector("svg")!;
    const head = document.querySelector<HTMLElement>(".atl-rail-card-head")!;
    const card = document.querySelector<HTMLElement>(".atl-rail-card")!;
    expect(getComputedStyle(head).opacity).toBe("0");
    expect(getComputedStyle(head).pointerEvents).toBe("none");
    card.dataset["dragging"] = "true";
    expect(getComputedStyle(head).opacity).toBe("1");
    expect(getComputedStyle(head).pointerEvents).toBe("auto");
    expect(["#111", "rgb(17, 17, 17)"]).toContain(getComputedStyle(button).color);
    expect(getComputedStyle(button).opacity).toBe("1");
    expect(["#111", "rgb(17, 17, 17)"]).toContain(getComputedStyle(svg).color);
    expect(getComputedStyle(svg).opacity).toBe("1");
    button.disabled = true;
    expect(getComputedStyle(button).opacity).toBe("0.4");
    delete card.dataset["dragging"];
    expect(getComputedStyle(head).opacity).toBe("0");
  });
  it("uses the same custom background tint for PDF and Markdown without text-layer opacity", () => {
    document.body.innerHTML = '<span class="atl-hl-bg" id="md"></span><div class="page"><div class="textLayer" style="opacity:0.2"></div><div class="atl-pdf-highlights"><span id="pdf" class="atl-pdf-highlight atl-hl-bg"></span></div></div>';
    document.body.style.setProperty("--atl-hl-bg-color", "rgba(124, 58, 237, 0.25)");
    expect(getComputedStyle(document.getElementById("pdf")!).backgroundColor)
      .toBe(getComputedStyle(document.getElementById("md")!).backgroundColor);
    expect(getComputedStyle(document.getElementById("pdf")!).backgroundColor).toContain("0.25");
    expect(getComputedStyle(document.querySelector(".atl-pdf-highlights")!).pointerEvents).toBe("none");
  });
});
