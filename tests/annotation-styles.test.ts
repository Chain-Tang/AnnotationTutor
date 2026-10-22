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
  it("reveals external workflow ports only while their card group is hovered", () => {
    document.body.innerHTML = '<div class="atl-rail-card" data-chrome-visible="true"><textarea></textarea></div><div class="atl-workflow-ports"><button class="atl-branch-port" data-direction="right">+</button></div>';
    const ports = document.querySelector<HTMLElement>(".atl-workflow-ports")!;
    const button = ports.querySelector<HTMLButtonElement>("button")!;
    document.querySelector("textarea")!.focus();
    button.disabled = true;
    expect(getComputedStyle(button).opacity).toBe("0");
    expect(getComputedStyle(button).pointerEvents).toBe("none");
    ports.classList.add("is-hovered");
    expect(getComputedStyle(button).opacity).toBe(".65");
    expect(getComputedStyle(button).pointerEvents).toBe("auto");
    button.disabled = false;
    expect(getComputedStyle(button).opacity).toBe("1");
    ports.classList.remove("is-hovered");
    expect(getComputedStyle(button).opacity).toBe("0");
    expect(getComputedStyle(button).pointerEvents).toBe("none");
  });
  it("positions the three ports beyond the card bounds without clipping card content", () => {
    document.body.innerHTML = '<div class="atl-rail-card"></div><div class="atl-workflow-ports"><button class="atl-branch-port" data-direction="left">+</button><button class="atl-branch-port" data-direction="right">+</button><button class="atl-branch-port" data-direction="bottom">+</button></div>';
    const ports = document.querySelector<HTMLElement>(".atl-workflow-ports")!;
    expect(getComputedStyle(ports).overflow).toBe("visible");
    expect(getComputedStyle(ports).pointerEvents).toBe("none");
    const left = getComputedStyle(ports.children[0]!);
    const right = getComputedStyle(ports.children[1]!);
    const bottom = getComputedStyle(ports.children[2]!);
    expect(left.width).toBe("24px");
    expect(left.left).toBe("-32px");
    expect(right.right).toBe("-32px");
    expect(bottom.bottom).toBe("-32px");
    expect(bottom.top).toBe("auto");
    const card = getComputedStyle(document.querySelector(".atl-rail-card")!);
    expect(card.overflowY).toBe("auto");
    expect(card.resize).toBe("both");
  });
  it("hides ports for a collapsed branch even if the group had been hovered", () => {
    document.body.innerHTML = '<div class="atl-workflow-ports is-hovered" hidden><button class="atl-branch-port" data-direction="right">+</button></div>';
    expect(getComputedStyle(document.querySelector(".atl-workflow-ports")!).display).toBe("none");
  });
});
