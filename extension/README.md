# Tutor Advanced Clipper

An optional advanced **browser extension** (Chromium — Chrome / Edge / Brave) for the
[Annotation Tutor Lite](../README.md) Obsidian plugin. It lets you **highlight and
annotate any web page** and **clip selections or whole pages** straight into your Vault.

For ordinary cross-browser clipping, Tutor uses the official
[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) with the
versioned template exported from TutorWeb settings. This advanced extension is
kept for Tutor-specific in-page Q&A, per-highlight notes, and raw HTML archives.

It is a separate build with its own version, released independently of the plugin.

## Features

- **Highlight** any passage in four colors, and **attach a note** to a highlight.
- **Persistent & re-anchored.** Highlights are saved for the page's URL in
  `chrome.storage.local` and re-drawn on your next visit using a W3C text-quote anchor
  (`prefix` / `exact` / `suffix`), so they survive reloads and small page edits. A short
  retry loop re-anchors late-rendering (SPA) content.
- **Popup manager.** The toolbar popup lists every highlight on the current page — click one
  to scroll to and flash it, or **Clear all**.
- **Clip into Obsidian.** Selections and whole pages use the approved localhost bridge. Whole pages are converted to Markdown (Readability + Turndown) and paired with archived HTML.
- **Stop an answer.** The Stop button, panel close, page navigation and tab close cancel the request. A disconnected answer is checked by request ID; it is never automatically resubmitted.

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

## Connect to Tutor

Enable the advanced browser bridge in Tutor settings, then click **Connect** in the extension popup. In Obsidian, approve **capture**, **ask**, or both, and choose the capture directory. Both capabilities start unchecked. The one-use challenge expires after five minutes. Opening the popup only checks an existing pairing; it cannot grant access.

Each approved client receives a random token bound to this Vault, extension origin, capabilities and directory. The extension stores it in `chrome.storage.local`, never browser sync; the host persists only its hash. An extension name, Origin or fixed header is not authentication. Old shared tokens are discarded and require a fresh approval. Small captures no longer bypass pairing through a URI.

The bridge listens only on `127.0.0.1`, limits bodies and request rates, and allows one active task per client and two per bridge/Vault with a cancellable bounded queue. A durable request journal prevents the same request from executing twice after reconnection or a host restart. Interrupted requests remain interrupted. A full journal safely refuses new requests rather than removing replay protection.

A transport failure can leave the outcome unknown. Reconnect queries the original request status without starting a new model request. A new question is a new explicit action and can incur new charges. Cancellation stops local waiting and forwards a cancellation signal; providers may still charge for work already performed. Revocation failures are reported and stop the bridge; no UI should claim an unsaved revocation is complete.

## Architecture

Four execution contexts, one shared wire format:

- `src/content.ts` — in-page highlight UI (toolbar, note popover), painting, persistence, and
  re-anchoring; also grabs the DOM for full-page clips.
- `src/anchor.ts` — text-quote anchoring: flatten the DOM to text, locate a selector with a
  4-level fallback, and paint/unpaint `<mark>` ranges.
- `src/highlights.ts` — `chrome.storage.local` model, keyed per normalized URL.
- `src/background.ts` — service worker: approved connections, request status/cancellation, offscreen lifecycle.
- `src/offscreen.ts` — Readability + Turndown HTML → Markdown conversion.
- `src/popup/` — settings + full-page trigger + highlight manager.
- `src/protocol.ts` — the capture wire format, mirrored byte-for-byte from the plugin
  (`src/web-bridge/protocol.ts`); bump `CAPTURE_PROTOCOL_VERSION` on both sides together.

## License

MIT — see [../LICENSE](../LICENSE). © 2026 Chain.
