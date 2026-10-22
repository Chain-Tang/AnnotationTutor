// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Happy DOM checks the actual cascade, including Obsidian's inline writes. It
// does not lay out pixels: the narrow-pane bounds still need real-host checks.
const css = readFileSync("styles.css", "utf8");
beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
});
afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); });

function host(mode: string) {
  document.body.innerHTML = `<div class="workspace-leaf-content"><div class="view-content atl-board-active-vertical" style="width:380px"><div class="${mode}" style="width:100%;height:100%"><div class="markdown-preview-view" style="width:100%"></div></div><canvas class="atl-board-layer"></canvas></div></div>`;
  return {
    root: document.querySelector<HTMLElement>(".view-content")!,
    pane: document.querySelector<HTMLElement>(`.${mode}`)!,
    preview: document.querySelector<HTMLElement>(".markdown-preview-view")!,
    canvas: document.querySelector<HTMLElement>("canvas")!,
  };
}

describe("document board rail CSS cascade", () => {
  it.each(["markdown-reading-view", "markdown-source-view", "pdf-container"])("reserves width after the %s host rewrites its inline width", mode => {
    const { root, pane, preview, canvas } = host(mode);
    const assertReservation = () => {
      expect(getComputedStyle(pane).width).toBe("calc(100% - 64px)");
      expect(getComputedStyle(pane).marginInlineStart).toBe("64px");
      expect(parseFloat(getComputedStyle(pane).minWidth)).toBe(0);
      expect(getComputedStyle(pane).boxSizing).toBe("border-box");
    };
    assertReservation();
    pane.style.width = "100%";
    root.style.width = "720px";
    assertReservation();
    // Only the outer document host reserves the rail, never a nested scroller
    // or the canvas whose coordinates cover the whole parent.
    expect(getComputedStyle(preview).width).toBe("100%");
    expect(getComputedStyle(canvas).width).toBe("100%");
  });

  it("keeps the document offset and width together when the reservation changes", () => {
    const { root, pane } = host("markdown-reading-view");
    root.style.setProperty("--atl-board-rail-width", "80px");
    expect(getComputedStyle(pane).marginInlineStart).toBe("80px");
    expect(getComputedStyle(pane).width).toBe("calc(100% - 80px)");
  });

  it("restores the native host width when the board closes", () => {
    const { root, pane } = host("markdown-reading-view");
    root.classList.remove("atl-board-active-vertical");
    expect(getComputedStyle(pane).width).toBe("100%");
    expect(["", "0px"]).toContain(getComputedStyle(pane).marginInlineStart);
    expect(pane.style.cssText).toBe("width: 100%; height: 100%;");
  });

  it("leaves an unassociated document pane at its native width", () => {
    host("markdown-reading-view");
    const other = document.createElement("div");
    other.className = "workspace-leaf-content";
    other.innerHTML = '<div class="view-content"><div class="markdown-reading-view" style="width:100%"></div></div>';
    document.body.append(other);
    const pane = other.querySelector<HTMLElement>(".markdown-reading-view")!;
    expect(getComputedStyle(pane).width).toBe("100%");
    expect(["", "0px"]).toContain(getComputedStyle(pane).marginInlineStart);
  });
});
