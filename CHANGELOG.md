# Changelog

All notable changes to **Annotation Tutor Lite** and its companion **Web Clipper** extension
are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
