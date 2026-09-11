// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { installCardChrome } from "../src/card-chrome.js";
afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); });

describe("skin-independent annotation controls", () => {
  it.each(["flat", "paper", "sticky", "leaf", "custom"])("hides %s controls on mouse leave even while editing", skin => {
    const card = document.createElement("div");
    card.className = `atl-rail-card atl-skin-${skin}`;
    card.innerHTML = '<div class="atl-rail-card-head"><button>Action</button></div><textarea>note</textarea>';
    document.body.append(card);
    const style = document.createElement("style");
    style.textContent = `.atl-skin-${skin} .atl-rail-card-head { opacity: 1 !important; pointer-events: auto !important; }`;
    document.head.append(style);
    const head = card.firstElementChild as HTMLElement;
    const stop = installCardChrome(card, head);
    expect(getComputedStyle(head).opacity).toBe("0");
    card.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    expect(getComputedStyle(head).opacity).toBe("1");
    const editor = card.querySelector("textarea")!;
    editor.focus();
    card.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    expect(document.activeElement).toBe(editor);
    expect(getComputedStyle(head).opacity).toBe("0");
    expect(getComputedStyle(head).pointerEvents).toBe("none");
    stop();
  });

  it("keeps drag controls visible until release outside the card", async () => {
    const card = document.createElement("div"), head = document.createElement("div");
    card.append(head); document.body.append(card);
    const stop = installCardChrome(card, head);
    card.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    card.dataset["dragging"] = "true";
    card.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    expect(head.style.opacity).toBe("1");
    document.dispatchEvent(new PointerEvent("pointerup"));
    delete card.dataset["dragging"];
    await Promise.resolve();
    expect(head.style.opacity).toBe("0");
    stop();
  });

  it("reveals on a real touch tap but not text focus, and disposes listeners", () => {
    const card = document.createElement("div"), head = document.createElement("div"), editor = document.createElement("textarea");
    card.append(head, editor); document.body.append(card);
    const stop = installCardChrome(card, head);
    editor.focus(); expect(head.style.opacity).toBe("0");
    editor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    expect(head.style.opacity).toBe("1");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    expect(head.style.opacity).toBe("0");
    stop();
    card.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    expect(head.style.opacity).toBe("0");
  });
});
