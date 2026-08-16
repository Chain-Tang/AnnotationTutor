# Annotation Tutor Web Clipper

A companion **browser extension** (Chromium — Chrome / Edge / Brave) for the
[Annotation Tutor Lite](../README.md) Obsidian plugin. It lets you **highlight and
annotate any web page** and **clip selections or whole pages** straight into your Vault.

It is a separate build with its own version, released independently of the plugin.

## Features

- **Highlight** any passage in four colors, and **attach a note** to a highlight.
- **Persistent & re-anchored.** Highlights are saved for the page's URL in
  `chrome.storage.local` and re-drawn on your next visit using a W3C text-quote anchor
  (`prefix` / `exact` / `suffix`), so they survive reloads and small page edits. A short
  retry loop re-anchors late-rendering (SPA) content.
- **Popup manager.** The toolbar popup lists every highlight on the current page — click one
  to scroll to and flash it, or **Clear all**.
- **Clip into Obsidian.** Two delivery channels, chosen automatically:
  - **Selections** ride an `obsidian://atl-web-capture` deep link when small enough.
  - **Whole pages** are converted to Markdown (via Readability + Turndown in an offscreen
    document), paired with archived HTML, and POSTed to the plugin's **localhost bridge**.

## Build

Requires **Node 22.13+** and **pnpm 10**.

```bash
cd extension
pnpm install
pnpm build        # bundles + copies assets into extension/dist/
```

- `pnpm build` — one-shot build to `dist/`.
- `pnpm typecheck` — `tsc --noEmit` (strict).

The plugin's build also bundles a copy of `dist/` into your Vault under
`.obsidian/plugins/annotation-tutor-lite/web-clipper/`, so you can load it from there too.

## Install (load unpacked)

1. Build it (above), or reveal the bundled folder from the plugin
   (**Settings → Annotation Tutor Lite → TutorWeb → Open extension folder**).
2. Open `chrome://extensions` (Edge: `edge://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and choose the `extension/dist/` folder.
4. Pin the extension. Highlighting works on any page immediately.

## Pair with the plugin (for clipping)

Highlighting needs no pairing. Sending clips into your Vault does:

1. In Obsidian → **Settings → Annotation Tutor Lite → TutorWeb**, turn on **Enable the Web
   Clipper bridge** and **copy the pairing token**.
2. Open the extension's popup, paste the token into **Bridge token**, set **Bridge port** to
   match the plugin (default `51256`), then **Save** → **Test pairing**.

The token is a bearer secret for a loopback-only (`127.0.0.1`) service that runs only while
the bridge is enabled. Keep it private.

## Architecture

Four execution contexts, one shared wire format:

- `src/content.ts` — in-page highlight UI (toolbar, note popover), painting, persistence, and
  re-anchoring; also grabs the DOM for full-page clips.
- `src/anchor.ts` — text-quote anchoring: flatten the DOM to text, locate a selector with a
  4-level fallback, and paint/unpaint `<mark>` ranges.
- `src/highlights.ts` — `chrome.storage.local` model, keyed per normalized URL.
- `src/background.ts` — service worker: bridge config, channel choice, offscreen lifecycle.
- `src/offscreen.ts` — Readability + Turndown HTML → Markdown conversion.
- `src/popup/` — settings + full-page trigger + highlight manager.
- `src/protocol.ts` — the capture wire format, mirrored byte-for-byte from the plugin
  (`src/web-bridge/protocol.ts`); bump `CAPTURE_PROTOCOL_VERSION` on both sides together.

## License

MIT — see [../LICENSE](../LICENSE). © 2026 Chain.
