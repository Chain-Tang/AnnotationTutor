// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { decorateBoardButton } from "../src/board-ui.js";

describe("board icon buttons", () => {
  it("renders every document and Studio action as an icon with hover-only text", () => {
    const actions = [
      "read", "edit", "select", "pan", "pen", "erase", "partialErase", "lasso",
      "fill", "gradient", "eyedropper", "transform", "crop", "text", "line",
      "arrow", "rect", "ellipse", "diamond", "connector", "undo", "redo",
      "fitContent", "origin", "addArtboard", "export", "share", "immersive",
      "rotate", "mirror", "symmetry", "visible", "hidden", "lock", "unlock",
      "alphaLock", "clip", "sticker", "character", "remove", "group", "ungroup",
      "settings", "close", "more", "together",
    ];
    for (const action of actions) {
      const button = document.createElement("button");
      button.textContent = `Label ${action}`;
      decorateBoardButton(button, action);
      expect(button.querySelector("svg"), action).not.toBeNull();
      expect(button.querySelector(".atl-board-sr-only")?.textContent).toBe(`Label ${action}`);
      expect(button.getAttribute("aria-label")).toBe(`Label ${action}`);
      expect(button.title).toBe(`Label ${action}`);
    }
  });
});
