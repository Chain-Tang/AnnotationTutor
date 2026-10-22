# Changelog

All notable changes to **Annotation Tutor Lite** and its companion **Web Clipper** extension
are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Manually created annotation conversation branches, durable card histories,
  pinned context, and an editable, zoomable annotation relationship view.
- Per-vault background learning observations with resumable history backfill,
  source-linked causal hypotheses, discriminating exercises, and private settings
  for pausing, excluding, correcting or removing observations.

- Versioned multi-vault collaboration spaces with editable Markdown context and
  dialogue, durable directed messages, explicit membership and recipient receipts.
- A dedicated persistent Codex conversation per space; Tutors can initiate
  requests and receive replies without replacing the desktop main chat.
- Scoped peer pairing, encrypted credentials outside the Vault, per-call MCP
  instance routing and a separate background communication switch.
- Collaboration-only Codex-backed Tutor sessions, isolated by Tutor and space,
  with persistent recovery and fixed diagnostic codes for failed replies.

### Fixed

- Recover one proven zero-byte transient chat connection failure on a fresh
  connection, with a cancelable pause, shared timeout/model-call budget and
  revalidated annotation associations. Show reconnection progress in cards;
  never replay partial replies or bypass strict format validation.
- Restore hidden annotation branches through a dedicated header toggle, separate
  from each card's continuing conversation. Use the selected custom branch icon
  in the former memory-cell slot and the brain icon for annotation review.
- Restore native card text selection, keyboard and selected-text context-menu
  copy without letting the surrounding source editor take over.
- Drag cards from blank outer padding and borders, leaving text selection,
  scrollbars and the resize corner available; persist only real drags.
- Connect parent and child borders with one continuous curve, without the
  fixed straight segment at the hover port.
- Preserve finite reply failure causes across reopening and distinguish
  connection, timeout, format and provider failures. Keep strict string replies
  and one guarded format correction, with targeted string/escaping guidance.

- Include the initial annotation and Tutor review in follow-up context; keep
  failed branch questions durable and reject stale or duplicate reply commits.
- Preserve legacy chat completion uncertainty and invalidate qualitative learning
  observations when their source is changed, removed or excluded.

- Keep independent Tutor conversations out of the ACP drawing role while
  retaining strict model selection and tool isolation.
- Restore annotation status after failed, empty or cancelled reviews; retain
  completed reviews when a later derived-memory step fails.
- Replace repeated translation placeholders literally and typecheck complete
  core dictionaries; translate credential and connection settings in all four locales.
- Generate schema-valid stable scene IDs for Unicode and long concept titles.
- Upgrade the extension's Readability to 0.6.0 for CVE-2025-2792 and package
  the licenses of all bundled extension parsing dependencies.
- Fix Windows private-state saves, retain explicit symlink/identity checks
  without O_NOFOLLOW, and make CI fixtures portable across paths and CRLF checkouts.

### Changed

- Show linked conversation annotations directly beside their original text; use
  three hover-only external ports to add left, right or lower child cards, with
  independently draggable saved positions and card-local continuing dialogue.
- Keep branch cards visually identical to existing annotations, removing nested
  branch lists, default draft labels and relation-page navigation.

- Continue repeated questions in each card through its header conversation
  button; create breadth through hover-revealed edge ports without coupling
  parent and child positions. Store both kinds of activity as source-linked
  observations for optional background learning analysis.
- Compact conversation navigation and size note inputs to their text instead
  of stretching them into the available card height.

- Reduce board draft validation and library refresh work; retain awaited durable
  saves and explicit full-index rebuilds.
- Minify production bundles, check the extension from the root workflow, and
  validate packaged release artifacts in CI.
- Ignore local storage reports/audits and generated research media.
- Defer custom skin scans until layout-ready idle time and expose bounded,
  memory-only startup stage timings; retain authorization/recovery readiness.
- Refresh image/MCP/official Clipper settings sections locally and preserve
  drafts, credential bindings, focus and scroll through background refreshes.
- Reuse dirty-generation source snapshots for cells-to-scenes reconciliation;
  protect hand-authored and incomplete files and retain explicit repair scans.
- Add V8 coverage reports with measured global and critical-boundary thresholds.

The following entries reconstruct **local development candidates** from dated
validation records. They are not assertions that those versions were published
on GitHub, nor that all product acceptance gates passed.

## [0.5.4] — development candidate, verified 2026-10-12

- Secure credential references outside the Vault, explicit Clipper authorization,
  durable task/surface recovery and managed program rollback.
- Natural learning v3 uses versioned, restricted evidence and preserves legacy
  records. Commercial, full desktop and long-term learning gates remain open.
- C67 fixes settings-lock compatibility on FSKit/exFAT; its real installation
  evidence is separate from the C66 test-library baseline.
- Evidence: [implementation status](docs/qa/implementation-status-20261012/report.md),
  [commercial candidates](docs/qa/commercial-optimization-20261009/report.md),
  [C67 installation](docs/qa/digital-twin-install-20261012/report.md).

## [0.5.3] — development candidate, 2026-09-27 evidence

- Natural expert review, recovery of completed results, permission invalidation,
  PDF observation scope and adult support evaluation.
- Full UI, professional support and long-term outcome gates remain open.
- Evidence: [batch 4](docs/qa/natural-learning-20260927/batch4/report.md).

## [0.5.2] — development candidate, 2026-09-27 evidence

- Annotation learning integration, source/revision protection, original ink
  preservation and local watercolor drawing.
- Evidence: [batch 3](docs/qa/natural-learning-20260927/batch3/report.md).

## [0.5.1] — development candidate, 2026-09-27 evidence

- Six learning topics, 54 templates, host-side answer checking, separate practice,
  transfer and delayed-verification pools, and 1/3/7-day scheduling.
- Evidence: [batch 2](docs/qa/natural-learning-20260927/batch2/report.md).

## [0.5.0] — development candidate, 2026-09-27 evidence

- Natural learning dialogue, shared restricted summaries, explicit consent,
  independent v2 records and separately authorized MCP learning access.
- Evidence: [batch 1](docs/qa/natural-learning-20260927/batch1/report.md).

## [0.4.6] — development candidate, 2026-09-26 evidence

- Keep drawing annotations visible without hiding their underlying artwork;
  preserve existing placements and ink.
- Evidence: [annotation compatibility](docs/qa/board-annotation-20260926/report.md).

## [0.4.5] — development candidate, 2026-09-26 evidence

- Avoid document text when placing generated diagrams; allow inspecting and
  undoing a relocation while retaining shared artwork identity across views.
- Evidence: [placement validation](docs/qa/board-placement-20260926/report.md).

## [0.4.4] — development candidate, 2026-09-26 evidence

- Restore Studio readiness after reload and connect selected text to Tutor
  explanations or drawings.
- Evidence: [Studio reload](docs/qa/studio-reload-20260926/report.md).

## [0.4.3] — development candidate, 2026-09-26 evidence

- One default conversation entry; optional private conversation moves under More.
  Learning, check-ins and expert features remain opt-in.
- Evidence: [simplified entry](docs/qa/simple-entry-20260926/report.md).

## [0.4.2] / [0.4.1] / [0.4.0] / [0.3.1] — development candidates, 2026-09-26 evidence

- 0.3.1 binds translation to its original document/revision, prevents duplicate
  review submissions and adds transactional installation/rollback.
- 0.4.0 adds six topics, versioned learning evidence, budgets and review scheduling.
- 0.4.1 adds optional check-ins and temporary support sessions; confirmed encrypted
  summaries have expiry and deletion controls.
- 0.4.2 adds scoped expert review with distinct evidence, advice and uncertainty.
- Evidence: [upgrade milestones and validation](docs/qa/learning-upgrade-20260926/report.md).

## [0.3.0] — desktop preview, 2026-09-20 evidence

- Excalidraw, independent Tutor MCP/Codex integration, component editing and local A2A.
  Android companion remains a source preview without device-release acceptance.
- Evidence: [0.3.0 validation](docs/tutor-upgrade-status.md).

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
