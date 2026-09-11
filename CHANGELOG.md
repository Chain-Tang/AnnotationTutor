# Changelog

All notable changes to **Annotation Tutor Lite** and its companion **Web Clipper** extension
are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.4] - 2026-09-08

### Fixed

- Enforce shared hover-only header behavior through pointer events for every
  built-in/custom card skin. Textarea focus no longer reveals buttons under
  Electron's `hover:none` media classification. Real touch taps and keyboard
  action focus remain accessible; dragging stays usable until release.

## [0.2.3] - 2026-09-08

### Fixed

- Restore writing-first annotation chrome across Markdown and PDF skins:
  buttons and drag grip are invisible and non-clickable at rest, revealed on
  hover, keyboard focus on an action, or an active drag. Revealed icons remain
  black. Touch-only devices reveal controls on focus. Existing skin selection
  and stable card geometry are preserved; this does not implement Pad ink input.

## [0.2.2] - 2026-09-08

### Fixed

- Make annotation header actions and SVG icons visibly black instead of muted,
  including quiet/textured skins; preserve dimming only for disabled buttons.
- Paint PDF highlights outside Obsidian's 20%-opacity text layer. Background
  tint now uses the same palette as Markdown, without double attenuation or a
  separate hover-only color. Dotted/wavy styles no longer force a background;
  style and color changes apply immediately. `none` respects marker visibility.
- Hit-test the painted PDF rectangles even when the native text/link/canvas
  layer receives the click; selecting text remains possible. Cards anchor to
  the clicked visible segment instead of an off-screen final line.
- Recompute page-relative geometry on PDF reflow/zoom/page replacement without
  modifying PDF.js text nodes or the PDF file. Since PDF glyphs are canvas pixels,
  the bold emphasis option is represented by a heavier accent underline.

### Verification

- DOM and style regressions cover native-layer click routing, settings changes,
  zoom/border coordinates, preserved selections, visible card anchors, and icons.
- Obsidian 1.13.7 renderer fixture confirmed equal PDF/Markdown background tint,
  successful click-through to a margin card, black SVG icons, and immediate
  background-to-dotted style switching. This is a renderer-fixture check, not
  a claim of full physical-mouse testing against every PDF.

## [0.2.1] - 2026-09-08

### Fixed

- Retain PDF, editor and reading-view card DOM across layout refreshes so dragging
  and unsaved inputs survive. Add a dedicated drag grip for quiet skins and
  pointer-based drag cleanup, including scaled host coordinates.
- Render Live Preview table highlights in a separate geometry layer, filtering
  Obsidian's hidden duplicate cell preview. Preserve text selection and avoid
  double toggles when switching between rendered cells and cell editors.
- Stop inserting source block ids for new table annotations; clean only indexed,
  generated legacy table ids, preserving user ids, inline code, math and CRLF.
- Restore no-id source/reading table highlights; refresh unchanged Reading-view
  source after annotation changes. Guard PDF chat reads against binary decoding.
- Add DOM regressions for dragging through refresh, table hydration/selection,
  hidden cell previews, PDF context-menu routing and click-versus-drag behavior.

### Added

- **PDF source annotations.** Select text in Obsidian's built-in PDF viewer and use the
  context menu or annotation shortcut to save it into the TutorLite learning loop, with a
  backlink to the captured PDF page. Saved selections are re-highlighted whenever PDF.js
  renders the page; clicking a highlight opens the same TutorLite annotation popover used
  by Markdown notes. The source PDF remains unchanged.

### Fixed

- PDF selection actions now bind directly to Obsidian's PDF viewer container, so
  the TutorLite item reliably replaces the native macOS context menu. Clicking an
  existing PDF highlight now opens the same draggable, resizable margin card as
  Markdown, without also reopening the new-annotation action.
- Rebind PDF annotations when a different PDF opens in the same leaf, and avoid
  re-highlighting in response to TutorLite's own margin-card DOM changes.
- Markdown table annotations retain logical anchors in annotation files without
  inserting block ids into the source table; this supersedes the intermediate
  standalone-after-table anchor implementation.
- Ignore Finder's `.DS_Store` metadata in the repository on macOS.

## [0.2.0] — 2026-08-16

Web Clipper annotation release: highlights now persist on the page, the chat history reads
better, and the sidebar clearly shows when the tutor is working.

### Added

- **Web page annotations (Web Clipper).** Highlight any passage in four colors and attach a
  note. Highlights are saved per page URL in the browser's local storage and re-anchored on
  reload via a W3C text-quote selector (prefix / exact / suffix), with a short retry loop for
  late-rendering (SPA) pages.
- **Highlight manager in the popup.** The toolbar popup lists every highlight on the current
  page; click one to scroll to and flash it, or clear them all.
- **A dedicated SVG icon** for the Web Clipper (rasterized to 16 / 32 / 48 / 128 px),
  registered in the extension manifest and toolbar action.
- **`extension/README.md`** plus a Web Clipper section in the main README (EN + zh-CN) covering
  features, install (load unpacked), and pairing.

### Changed

- **Chat history page redesign.** Refined layout and styling for the session list — timeline,
  titles, and message previews are cleaner and easier to scan.
- **Sidebar send button.** While the tutor is generating, the paper-plane send button now
  morphs from a rounded pill into a rounded square "stop" control with a subtle breathing
  (pulse) animation for clear "working…" feedback. Honors `prefers-reduced-motion`.
- Bumped the plugin to **0.2.0** and the Web Clipper extension to **0.2.0**.

### Fixed

- Highlights added on a web page were not retained on the original page; they are now
  persisted and correctly associated with the source URL.

## [0.1.0]

- Initial public release of Annotation Tutor Lite: a Markdown-native learning loop
  (annotations → agent reviews → memory cells → scenes), spaced repetition (SM-2), the
  generated study notebook, inline translation / full-document pre-translation, and
  OpenCode / OpenAI-compatible engines.

[0.2.0]: https://github.com/Chain-Tang/AnnotationTutor/releases/tag/v0.2.0
[0.1.0]: https://github.com/Chain-Tang/AnnotationTutor/releases/tag/v0.1.0
