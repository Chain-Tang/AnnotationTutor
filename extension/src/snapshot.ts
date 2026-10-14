// Snapshot building: the HTML that rides along in page captures and asks is the
// rendered DOM minus everything that must not execute when the archive is
// opened later — scripts, event handlers, javascript: URLs, nested browsing
// contexts — and minus the chrome we injected (toolbar, popover, ask overlay,
// toast). The learner's painted highlights stay, so a saved copy of the page
// shows what was studied. Zotero strips JavaScript the same way when it saves
// a page snapshot.

import { UI_CLASS } from "./anchor.js";

/** Elements that execute or pull in live sub-documents when re-opened. */
const STRIPPED_ELEMENTS = "script, iframe, frame, embed, object, applet";

/** URL-carrying attributes that must not keep a javascript: scheme. */
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href"]);

/** Attributes whose value is code the browser runs on some interaction. */
function isEventAttribute(name: string): boolean {
  return name.length > 2 && name.slice(0, 2).toLowerCase() === "on";
}

/** Neutralize every execution vector on one element (in place). */
function stripElement(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (isEventAttribute(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && /^\s*javascript:/i.test(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
}

/**
 * Clone the current document into a static, safe snapshot string. The live DOM
 * is untouched — the clone takes the hit — and painted highlight <mark>s keep
 * their inline colors, so the archive renders the learner's annotations.
 */
export function buildSnapshotHtml(document: Document): string {
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll(STRIPPED_ELEMENTS).forEach((el) => el.remove());
  // Our own chrome (toolbar / popover / ask panel / toast) all carry UI_CLASS.
  root.querySelectorAll(`.${UI_CLASS}`).forEach((el) => el.remove());
  // A meta refresh would yank the re-opened snapshot somewhere else.
  root.querySelectorAll('meta[http-equiv="refresh" i]').forEach((el) => el.remove());
  root.querySelectorAll("*").forEach(stripElement);
  // querySelectorAll("*") never yields the root itself, and a hostile page can
  // hang event attributes (onload and friends) on <html> too.
  stripElement(root);
  return root.outerHTML;
}
