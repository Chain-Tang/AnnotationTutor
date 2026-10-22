// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ setIcon: vi.fn() }));
import { setIcon } from "obsidian";
import { ANNOTATION_BRANCH_ICON, ANNOTATION_REVIEW_ICON, setAnnotationIcon } from "../src/annotation-icons.js";

beforeEach(() => vi.clearAllMocks());

describe("annotation toolbar icons", () => {
  it("renders the selected branch symbol locally with open nodes and theme-aware strokes", () => {
    const button = document.createElement("button");
    button.textContent = "previous icon";
    setAnnotationIcon(button, ANNOTATION_BRANCH_ICON);
    const svg = button.querySelector("svg")!;
    expect(setIcon).not.toHaveBeenCalled();
    expect(button.childNodes).toHaveLength(1);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("circle")).toHaveLength(4);
    expect(svg.querySelectorAll("path")).toHaveLength(3);
    expect([...svg.children].map(child => child.tagName)).toEqual(["path", "path", "path", "circle", "circle", "circle", "circle"]);
    for (const path of svg.querySelectorAll("path")) {
      // All connections are curved; no fixed straight connector stem is added.
      expect(path.getAttribute("d")).toMatch(/^M[\d. ]+C[\d. ]+$/);
    }
    setAnnotationIcon(button, ANNOTATION_BRANCH_ICON);
    expect(button.querySelectorAll("svg")).toHaveLength(1);
  });

  it("uses the target element's document, including detached annotation surfaces", () => {
    const otherDocument = document.implementation.createHTMLDocument("annotation");
    const button = otherDocument.createElement("button");
    setAnnotationIcon(button, ANNOTATION_BRANCH_ICON);
    for (const node of button.querySelectorAll("svg, path, circle")) {
      expect(node.ownerDocument).toBe(otherDocument);
      expect(node.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });

  it("maps existing review identifiers to the brain icon across all annotation entry points", () => {
    const button = document.createElement("button");
    setAnnotationIcon(button, ANNOTATION_REVIEW_ICON);
    expect(setIcon).toHaveBeenCalledExactlyOnceWith(button, "brain");
  });

  it("continues to delegate standard toolbar icons to Obsidian", () => {
    const button = document.createElement("button");
    setAnnotationIcon(button, "message-circle");
    expect(setIcon).toHaveBeenCalledExactlyOnceWith(button, "message-circle");
  });
});
