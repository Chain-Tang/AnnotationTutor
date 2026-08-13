# Annotation Tutor Lite Pad Handwriting — Product & Technical Spec

> Status: Draft v0.3  
> Date: 2026-08-09  
> Product: Annotation Tutor Lite  
> Delivery order: Android Pad first, iPad second  
> Source of truth: this document until superseded by an approved revision

## 1. Executive summary

The next phase turns Annotation Tutor Lite into a pen-first learning tool for tablets.
The user should be able to read an Obsidian Markdown note as if it were paper, mark the
text with a stylus, write a handwritten annotation beside it, and connect the annotation
to the relevant sentence or word without opening a bordered modal.

Every handwritten annotation has two synchronized but independent representations:

1. **Ink layer** — the original strokes, preserving the user's handwriting, pressure,
   timing, and spatial relationship to the source text.
2. **Semantic layer** — recognized Markdown text that can be searched, corrected,
   indexed, synced, and sent to an Agent.

Recognition must never destroy or replace the ink. The handwritten form remains the
primary visual artifact; recognized text is its machine-readable interpretation.

The intended experience is:

```text
read → mark with pen → pull a connector → handwrite a note
     → recognize locally → correct only if needed → send to Agent
```

This phase supports both handwriting attached to existing Markdown and full-page freehand
study notes. It does not attempt to become a general-purpose illustration application or
an unbounded collaborative whiteboard.

## 2. Product goals

### 2.1 Primary goals

1. Preserve a native pen-and-paper feeling on Android tablets and iPad.
2. Let the user annotate Markdown without switching to a modal or keyboard-first UI.
3. Preserve raw handwriting as durable, portable Vault data.
4. Convert the same handwriting into editable Markdown text when the platform supports it.
5. Reuse Tutor Lite's existing annotation, Agent review, memory-cell, scene, notebook,
   and spaced-review loop.
6. Work offline for ink capture and local persistence; prefer on-device recognition.
7. Keep the visible Pad UI frameless, backgroundless, and subordinate to the handwriting.
8. Support a broad Android tablet range through capability tiers instead of depending on
   one manufacturer, pen model, or handwriting keyboard.
9. Let a learner create a full-page handwritten note whose original ink and recognized
   Markdown remain available in the Vault.

### 2.2 Success definition

The feature succeeds when a learner can annotate a paragraph with a pen as quickly and
naturally as on paper, later search the recognized annotation as text, and ask Tutor Lite
to respond without retyping the note.

### 2.3 Non-goals for the first Pad release

- An infinite collaborative canvas or whiteboard.
- PDF annotation.
- General illustration tools, layers, stickers, or shape libraries.
- Collaborative real-time ink editing.
- Cloud OCR or mandatory network recognition.
- Perfect layout identity across different screen sizes.
- Replacing Obsidian's Markdown editor.
- Feature parity with desktop OpenCode process execution on mobile.

## 3. Design principles

### 3.1 Pen first, chrome last

The pen touches content, not controls. Toolbars remain collapsed until explicitly opened.
There is no permanent card border, background fill, floating window, or form field around
a handwritten note.

### 3.2 Ink is the original

Recognition is fallible. The raw strokes are the authoritative record of what the user
wrote. The recognized Markdown is a derived interpretation with its own provenance.

### 3.3 Direct manipulation

The user establishes meaning spatially:

- underline text and pull a connector to a note;
- circle a word and pull a connector to a note;
- write the note first and connect it back to text;
- place handwriting directly at an insertion point.

The interface should not force the user to select an abstract annotation type first.

### 3.4 Semantic anchoring over page coordinates

Markdown reflows. A mark must be attached to a text range or block, not only to absolute
screen pixels. Layout coordinates are retained for appearance, while quote context and
Obsidian block IDs preserve meaning after reflow.

### 3.5 Graceful degradation

Ink capture and storage must work even when handwriting recognition is unavailable.
The product detects capabilities at runtime and explains the active recognition path.

### 3.6 Mobile is not a smaller desktop

Desktop-only engines and dense settings are hidden on mobile. The Pad experience has its
own interaction layer while sharing Tutor Lite's Markdown protocol and learning model.

## 4. Core user stories

### 4.1 Underline, connect, then write

1. The learner underlines part of a sentence with the pen.
2. Without lifting for a separate command, or on the next stroke, the learner pulls a
   line from the underline toward free space in the margin.
3. At the line endpoint, the learner writes a note.
4. The original ink remains visible after the learner finishes writing.
5. When the learner pen-double-taps the completed handwriting, Tutor Lite starts local
   recognition and opens the recognition confirmation flow.

### 4.2 Write first, connect later

1. The learner writes a thought in empty margin space.
2. The learner drags from the note toward a sentence.
3. On release, Tutor Lite resolves the target text range and creates the annotation link.

### 4.3 Circle a concept

1. The learner circles a word or short phrase.
2. The circle snaps semantically to the nearest text range without visibly changing shape.
3. The learner writes beside it or pulls a connector to a remote note.

### 4.4 Insert handwriting at a position

1. The learner places the pen between two Markdown blocks or at a caret position.
2. The learner writes directly in the insertion zone.
3. Tutor Lite stores the handwriting and recognized Markdown at that semantic position.
4. The user chooses whether the recognized text remains a parallel transcript or becomes
   editable source Markdown.

### 4.5 Send to the Agent

1. The learner pen-double-taps a completed handwritten note or selected ink region.
2. Tutor Lite recognizes that ink and shows the machine-readable Unicode/Markdown text in
   a lightweight confirmation surface.
3. The confirmation surface provides **Edit**, **Send**, and **Don't ask again** actions.
4. The learner corrects the text if needed and sends it.
5. Tutor Lite sends the approved text, selected source text, anchor, and learner context.
6. Agent feedback returns to the existing annotation dialogue and memory workflow.

Nothing is sent automatically merely because the learner finished writing or because
recognition completed.

### 4.6 Create a full-page handwritten note

1. The learner creates a new **Handwritten note** inside the current Vault.
2. Tutor Lite opens a paper-like writing surface that occupies the content area without a
   surrounding card, form, or permanent toolbar.
3. The learner writes continuously, mixes short diagrams with prose, selects and moves
   strokes, erases, and adds more writing later.
4. Tutor Lite autosaves the original vector ink and progressively builds a recognized
   transcript for the portions classified as handwriting.
5. The Markdown note remains the entry point. It embeds the portable ink rendering and
   contains or references the learner-approved transcript.
6. The learner may send the full transcript, a lasso-selected region, or a specific
   handwritten paragraph to the Agent.

## 5. Input and gesture model

### 5.1 Input ownership

| Input | Default behavior |
| --- | --- |
| Stylus tip | Ink, underline, circle, connector, or handwriting |
| Stylus eraser / side button | Erase ink where supported; otherwise configurable |
| One finger | Scroll and tap UI |
| Two fingers | Scroll/zoom without creating ink |
| Mouse/trackpad | Existing desktop selection and navigation behavior |
| Palm | Rejected while a stylus session is active |

Touch drawing may be enabled as an accessibility setting, but is off by default.

### 5.2 Minimal tool model

The Pad MVP exposes only:

- Pen
- Highlighter/underline
- Eraser
- Lasso/select
- Pan/hand, when automatic input separation is unavailable

Circle, connector, and insertion are inferred gestures, not separate permanent tools.

### 5.3 Stroke interpretation

After each stroke group, the gesture classifier considers:

- stroke geometry;
- distance from rendered text;
- whether the stroke encloses glyph bounds;
- whether it begins or ends at existing ink;
- writing speed and pause boundaries;
- nearby annotation and text anchors.

The classifier may propose one of:

```text
freehand_text | underline | highlight | circle | connector | erase | unknown
```

It must not visibly beautify or replace the user's stroke. If confidence is low, the
stroke remains ordinary ink and can be reclassified through selection.

### 5.4 Grouping handwritten words into a note

A handwriting group remains open while all of the following are true:

- the pause between strokes is below the configurable grouping threshold;
- new strokes stay within the expanding local writing region;
- the user has not started scrolling or selected another object;
- no connector has completed a different annotation.

Default recognition debounce target: 600–900 ms after the last stroke. Recognition may
run again incrementally as the user continues writing.

### 5.5 Frameless visual language

- No visible card boundary or fill in the resting state.
- Original ink uses a pen-like width and pressure curve.
- The connector is a natural freehand stroke, not a rigid diagram arrow.
- A selected annotation may show only a faint dotted bounding contour and small handles.
- Recognition state is indicated with a small transient glyph or underline near the ink.
- Agent replies may appear as quiet typeset text beneath the handwriting or in an
  expandable thread; they must not cover the original ink.
- Controls appear on tap/long-press/lasso selection and disappear after inactivity.

### 5.6 Recognition trigger and ink lifecycle

- Recognition is an explicit pen-tip double-tap on completed ink, not a background action.
- The double-tap belongs to Tutor Lite and must work even when a stylus has no hardware
  double-tap button.
- Tutor Lite resolves the double-tap to the smallest meaningful completed handwriting
  group unless the learner has already made a lasso selection.
- A note remains rendered at its saved position whenever the source Markdown note opens.
- The learner can hide/close a handwritten note without deleting its ink or transcript.
- Hidden notes can be restored through the note's handwriting index or annotation controls.
- The learner can reposition a note; the semantic source anchor remains unchanged while
  its visual placement updates.
- Closing, hiding, deleting, and archiving are distinct operations.

## 6. Anchoring and reflow behavior

### 6.1 Anchor hierarchy

Each ink annotation stores all available anchor evidence:

1. Obsidian block ID.
2. Markdown source path.
3. Start/end text offsets within the block when they can be resolved safely.
4. Exact selected quote.
5. Prefix and suffix context.
6. Rendered text rectangles at creation time.
7. Relative ink placement against the anchor block.

This extends the existing Tutor Lite block-ID and quote-repair strategy.

### 6.2 Reflow rules

When font size, orientation, split view, or device width changes:

- underline and circle marks are recomputed against the current text rectangles;
- their original stroke character is approximated using normalized path segments;
- a margin note stays on its logical side when space exists;
- in narrow portrait layouts, margin notes move into an inline annotation lane after the
  anchored block;
- connector endpoints follow the target and note, while the stored freehand path provides
  curvature/style hints;
- the recognized text and semantic anchor remain valid even if visual placement changes.

The product promises semantic stability, not pixel-identical pagination.

### 6.3 Anchor repair

If a source block changes, Tutor Lite attempts repair using block ID, exact quote, nearby
quote, and fuzzy context in that order. Low-confidence repair is shown to the user; ink is
never deleted automatically.

## 7. Ink data model

### 7.1 TypeScript domain model

```ts
type InkPoint = {
  x: number;
  y: number;
  t: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
};

type InkStroke = {
  id: string;
  points: InkPoint[];
  tool: "pen" | "highlighter" | "eraser";
  color: string;
  baseWidth: number;
};

type InkAnchor = {
  sourceFile: string;
  blockId?: string;
  selectedText?: string;
  prefix?: string;
  suffix?: string;
  startOffset?: number;
  endOffset?: number;
};

type InkRecognition = {
  text: string;
  alternatives: string[];
  language: string;
  provider: "web-handwriting" | "android-native" | "android-ime" |
    "pencilkit" | "scribble" | "manual" | "unavailable";
  engineVersion?: string;
  recognizedAt: string;
  userCorrected: boolean;
};

type InkAnnotation = {
  schemaVersion: 1;
  id: string;
  annotationId: string;
  kind: "margin" | "inline" | "freehand" | "page";
  gesture: "underline" | "circle" | "connector" | "insertion" | "freehand";
  anchor: InkAnchor;
  strokes: InkStroke[];
  targetStrokeIds: string[];
  noteStrokeIds: string[];
  connectorStrokeIds: string[];
  canonicalViewport: { width: number; scale: number };
  recognition?: InkRecognition;
  createdAt: string;
  updatedAt: string;
};
```

The final implementation may split target, note, and connector into separate objects, but
the persisted format must retain stable stroke identities and a migration version.

For a full-page note, `kind: "page"` has no required source-text selection. Its anchor is
the Markdown note itself, and recognized regions map subsets of stroke IDs to transcript
blocks so the user can send or correct one part without retranscribing the entire page.
Each page uses a stable page-coordinate system. Device rotation or window resizing scales
or pans the paper instead of changing existing ink coordinates.

### 7.2 Vault storage

Recommended structure:

```text
Agent Memory/
├── annotations/ANN-...md
├── ink/
│   ├── INK-...ink.json     # editable vector source of truth
│   └── INK-...svg          # portable rendered representation
└── indexes/
    └── ink.md              # rebuildable human-readable index
```

The JSON sidecar preserves strokes and recognition metadata. SVG provides a portable
rendering that Obsidian and other Markdown tools can display without Tutor Lite.

### 7.3 Annotation Markdown format

The existing annotation file is extended rather than replaced:

```md
---
id: ANN-20260809-001
sourceFile: Papers/example.md
anchor: ^ann-20260809-001
inkId: INK-20260809-001
inkAsset: Agent Memory/ink/INK-20260809-001.svg
inkSource: Agent Memory/ink/INK-20260809-001.ink.json
recognitionProvider: android-native
recognitionLanguage: zh-Hans
---

## Selected Text

> The source sentence...

## Handwriting

![[Agent Memory/ink/INK-20260809-001.svg]]

## Recognized Text

我认为这里强调的是……

## User Note

我认为这里强调的是……

## Agent Review

<!-- Agent writes here. -->
```

`Recognized Text` records the transcription. `User Note` is the learner-approved semantic
note sent to the Agent. Before approval they may differ. Raw ink remains independently
available even if the learner edits `User Note`.

### 7.4 Source Markdown references

Margin annotations should not inject large SVG blocks into the source document. The source
keeps its existing block anchor and an optional compact reference:

```md
The source sentence. ^ann-20260809-001
<!-- annotation-tutor-ink: INK-20260809-001 -->
```

For explicit insertion annotations, Tutor Lite may insert a normal Markdown embed at the
chosen block boundary:

```md
![[Agent Memory/ink/INK-20260809-001.svg]]
<!-- annotation-tutor-recognized: 我认为这里强调的是…… -->
```

The insertion behavior must be user-configurable because some users will prefer source
notes to remain visually clean.

### 7.5 Full-page handwritten Markdown format

A full-page handwritten note remains a real `.md` file rather than a proprietary notebook
record:

```md
---
type: annotation-tutor-handwritten-note
inkId: INK-PAGE-20260809-001
inkAsset: Agent Memory/ink/INK-PAGE-20260809-001.svg
inkSource: Agent Memory/ink/INK-PAGE-20260809-001.ink.json
---

# Linear Algebra — handwritten notes

![[Agent Memory/ink/INK-PAGE-20260809-001.svg]]

## Recognized transcript

Eigenvectors preserve their direction under the transformation...
```

The SVG ensures the page can be read when Tutor Lite is unavailable; the vector source
preserves editability in Tutor Lite; the transcript makes the note searchable and
Agent-readable. In the normal Pad view, the original handwriting is shown rather than a
parallel typeset transcript. Recognized text appears on explicit recognition/Agent actions
or through a dedicated transcript view.

## 8. Recognition architecture

### 8.1 Provider contract

All recognition providers implement one cross-platform interface:

```ts
type RecognitionRequest = {
  strokes: InkStroke[];
  languages: string[];
  textContext?: string;
  writingArea: { width: number; height: number };
};

type RecognitionResult = {
  text: string;
  alternatives: string[];
  segments?: Array<{
    text: string;
    strokeIds: string[];
  }>;
  provider: InkRecognition["provider"];
  engineVersion?: string;
};
```

The rest of Tutor Lite must not depend directly on ML Kit, PencilKit, an IME, or a browser
experimental API.

### 8.2 Provider priority

Runtime priority:

1. Same-stroke on-device recognition exposed through a supported Web Handwriting API.
2. Platform-native bridge recognizing Tutor Lite's captured strokes.
3. System handwriting text field/Scribble, producing text but not recognizing the same
   persisted stroke set.
4. Manual transcript entry.

Cloud recognition is outside the Pad MVP unless later approved explicitly.

Recognition providers are invoked only after an explicit recognition action, normally a
pen-tip double-tap. Tutor Lite may prepare stroke groups and language hints in the
background, but it must not turn them into an Agent submission automatically.

### 8.3 Android capability facts

- Android 14+ supports stylus handwriting in standard `EditText` and `WebView` text
  widgets through a compatible IME.
- When the IME takes over handwriting, the app receives committed text; it does not own
  the same raw stroke stream.
- ML Kit Digital Ink Recognition accepts captured vector strokes, works on-device after
  language model download, and supports hundreds of languages.
- A stock Obsidian community plugin cannot add an arbitrary Kotlin/Capacitor native module
  to the already-built Obsidian mobile application.
- Chromium exposes a Handwriting Recognition Web API on some platforms, but availability,
  language support, secure-context behavior, and Android WebView support must be tested at
  runtime. It cannot be assumed as the Android baseline.

### 8.4 Android feasibility gate

Before feature implementation, build a device spike inside Obsidian Android that records:

```text
navigator.createHandwritingRecognizer availability
query result for zh-Hans / en
PointerEvent pressure, tilt, coalesced events, and pointerType
WebView stylus handwriting behavior in textarea/contenteditable
behavior in portrait, landscape, split-screen, and reading/editing views
```

Decision after the spike:

- **Path A — Web API works for target languages:** use it for same-stroke recognition;
  remain a standard Obsidian mobile plugin.
- **Path B — Web API unavailable:** full same-stroke native recognition requires a native
  companion/bridge distribution strategy. This needs explicit product approval.
- **Path C — no companion app:** preserve raw ink in Tutor Lite and use the Android system
  handwriting text field only as a separate transcription fallback. The transcript will
  not be produced from exactly the same stored strokes.

### 8.5 Android native recognition path

If Path B is approved, the native component should:

- be fully open source, including build and release instructions;
- prefer the tablet/operating system's on-device recognition interface when a stable public
  API is exposed;
- accept only a versioned recognition request, never direct Vault write commands;
- use an offline cross-device recognizer such as ML Kit Digital Ink only when a suitable
  system recognizer is not publicly available;
- download language packs with explicit user consent and show storage size;
- recognize fully offline after model installation;
- return candidates and stroke segmentation when available;
- expose no network service and no broad filesystem permission;
- authenticate messages from the Tutor Lite plugin/companion flow;
- preserve the JS/Markdown core as the source of truth.

The exact bridge mechanism is intentionally not selected until the feasibility spike
proves what stock Obsidian Android permits.

The companion application's source can be open even when a device vendor's recognition
engine is proprietary. Whether that distinction satisfies the product requirement remains
an explicit decision: many system handwriting engines and ML Kit models are not themselves
open-source software.

### 8.6 iPad recognition path

iPad implementation starts after the Android interaction and data model stabilize.

- Scribble can enter on-device recognized text into normal text fields, but does not give
  a JavaScript plugin the underlying PencilKit drawing.
- PencilKit provides native low-latency Apple Pencil capture.
- `PKStrokeRecognizer` adds on-device recognition of selected PencilKit strokes in
  iPadOS 27, but is currently a new/beta platform capability and requires native code.
- A standard Obsidian iOS plugin cannot add `PKCanvasView` or `PKStrokeRecognizer` to the
  Obsidian binary by itself.

Therefore the iPad release reuses the plugin's Pointer Events ink layer as its baseline.
Full same-stroke PencilKit recognition requires either an approved native companion path
or a future Obsidian-exposed bridge. The minimum supported iPadOS version must be decided
before implementation.

## 9. Agent integration

### 9.1 Agent payload

By default the Agent receives:

- learner-approved `User Note` text;
- current recognition text and whether it was corrected;
- source file, block anchor, selected quote, and nearby context;
- annotation ID and ink asset link;
- existing learner profile and relevant memory cells according to current Tutor Lite
  rules.

The Agent does not need raw stroke points. An optional rendered SVG or PNG may be attached
only when the user explicitly chooses **Include handwriting image**.

### 9.2 Recognition correction

- A pen-tip double-tap starts recognition for the resolved handwriting group or lasso
  selection.
- The top result appears in a lightweight recognition confirmation surface.
- Alternatives are offered only when available.
- The primary actions are **Edit**, **Send**, and **Don't ask again**.
- Editing the transcript sets `userCorrected: true` and preserves the original ink.
- The Agent is sent the learner-approved text, never an unconfirmed low-confidence guess.
- The original ink remains unchanged after correction.
- The confirmation preference can be restored from Tutor Lite settings.
- Chinese and other non-Latin results are stored as Unicode plain text or Markdown; they
  are not constrained to ASCII.

### 9.3 Agent response

Agent feedback reuses the existing review and dialogue model. On Pad it renders as quiet
typeset text attached beneath or beside the handwriting. The learner can respond with
handwriting again, producing another ink/transcript pair in the dialogue.

## 10. Mobile architecture changes to Tutor Lite

### 10.1 Current blockers

Tutor Lite currently declares `isDesktopOnly: true` and imports Node-dependent modules for
OpenCode process spawning and filesystem access. Obsidian mobile plugins cannot assume
Node, Electron, `process.platform`, or `FileSystemAdapter`.

### 10.2 Target layers

```text
packages/core-mobile-safe/
  domain models, Markdown formats, anchors, indexing, SRS, Agent payloads

src/platform/obsidian/
  Vault API, editor/reading view integration, capability detection

src/platform/desktop/
  OpenCode ACP, child_process, shell discovery, filesystem-only features

src/platform/mobile/
  Pointer Events ink capture, mobile views, IME/Scribble fallback

src/platform/recognition/
  provider interface, web provider, native bridge provider, manual provider
```

This is a logical target; exact folders will be chosen during the implementation plan.

### 10.3 Packaging decision

Preferred direction: keep one `annotation-tutor-lite` plugin and make capabilities
platform-gated. This keeps a single Vault protocol and avoids two plugins racing to write
the same indexes.

Requirements:

- set `isDesktopOnly: false` only after all top-level mobile-incompatible imports are
  removed or dynamically gated;
- keep OpenCode/ACP desktop-only;
- use Obsidian `Platform` rather than `process.platform` in shared modules;
- use Vault APIs and `CapacitorAdapter`-safe paths on mobile;
- use `requestUrl` for compatible network requests;
- hide unavailable settings and commands rather than allowing runtime failure;
- keep Direct API optional and disclose network transmission clearly.

## 11. Android delivery phases

### Phase A0 — Device and API feasibility spike

- Select a representative compatibility matrix rather than a single mandatory Pad.
- Include at least one Samsung S Pen device and one standards-based/non-Samsung stylus
  device when hardware is available.
- Run the capability matrix described in section 8.4.
- Prototype raw Pointer Events capture over one Obsidian Markdown paragraph.
- Validate palm rejection, scroll coexistence, and event latency.
- Choose recognition Path A, B, or C.

Exit criterion: the team has evidence for the actual target device and an approved
recognition architecture.

### Phase A1 — Mobile-compatible Tutor Lite shell

- Separate desktop-only modules from shared plugin startup.
- Load Tutor Lite successfully on Obsidian Android.
- Preserve existing Markdown library/index behavior through mobile-safe Vault APIs.
- Provide Direct API/file-inbox Agent paths; disable OpenCode execution on mobile.

### Phase A2 — Ink capture and persistence

- Add pen/touch separation and low-latency stroke rendering.
- Autosave vector ink after each completed stroke group.
- Generate SVG render artifacts.
- Restore ink after reload, orientation change, and app restart.
- Implement undo/redo and eraser without corrupting stroke identity.
- Create, reopen, and edit a full-page handwritten Markdown note.

### Phase A3 — Semantic annotation gestures

- Underline → connector → note.
- Note → connector → text.
- Circle word/phrase.
- Inline insertion.
- Lasso, move, reconnect, and delete.
- Reflow and anchor repair.

### Phase A4 — Recognition and correction

- Implement the approved provider.
- Add language selection and automatic language hints.
- Add incremental recognition, candidates, and correction.
- Persist provider/version/provenance.
- Verify offline behavior.

### Phase A5 — Agent loop

- Send learner-approved transcript and source context.
- Render Tutor feedback next to handwriting.
- Support handwritten follow-up dialogue.
- Distill memory cells and build notebooks through existing Tutor Lite flows.

### Phase A6 — Hardening

- Large-document and long-session performance.
- Crash recovery and partial-write repair.
- Cross-device Vault sync behavior.
- Accessibility and finger-only fallback.
- Privacy disclosures and release packaging.

## 12. iPad delivery phases

Development begins on macOS after the Android domain model, gesture grammar, and Markdown
format are stable.

### Phase I0 — iPad capability spike

- Test Apple Pencil Pointer Events inside Obsidian iPad.
- Test Scribble in plugin text fields.
- Decide minimum iPadOS version.
- Evaluate the approved native-companion strategy, if any, against PencilKit and
  `PKStrokeRecognizer`.

### Phase I1 — Shared plugin experience

- Port the Android-proven ink overlay and anchoring behavior.
- Adapt palm rejection, hover, squeeze/double-tap, and eraser capabilities where exposed.
- Match iPad scrolling, split view, Stage Manager, and orientation behavior.

### Phase I2 — iPad recognition

- Use Scribble as the baseline transcription fallback.
- If native integration is approved and the OS target supports it, recognize the same
  PencilKit strokes on-device and store recognition version metadata.
- Maintain identical `InkAnnotation` and Markdown schemas across platforms.

## 13. Performance and reliability requirements

Targets are measured on the agreed minimum device:

- Visible ink should track the pen at 60 fps where the device/WebView permits.
- No completed stroke may disappear after normal navigation or app backgrounding.
- Autosave begins within 250 ms after a stroke group closes and is atomic.
- A crash may lose the active unfinished stroke, but not earlier completed strokes.
- Recognition should begin within 500 ms of the explicit double-tap/recognize action and
  remain cancellable.
- A note with 1,000 strokes must remain editable without blocking scrolling.
- Index rebuild must recover annotation/transcript records when plugin cache is deleted.
- Missing or unsupported recognition must never block ink creation.

## 14. Privacy and security

- Raw ink and recognized text are stored in the user's Vault.
- On-device recognition is preferred and clearly labeled.
- Downloading an ML language model requires an explicit explanation of size and network
  use; recognition afterward must work offline.
- Sending recognized text to an Agent is a separate, explicit action unless the user
  enables auto-review.
- Raw ink images are not sent to an Agent by default.
- Provider, engine version, and whether text was user-corrected are recorded.
- No handwriting telemetry or analytics.
- Native bridges, if approved, expose a narrow recognition-only protocol and no general
  command execution or Vault filesystem access.

## 15. Accessibility and fallback behavior

- All pen actions have touch and command-palette alternatives.
- Recognized text is available to screen readers even when the visible artifact is ink.
- Color is not the only indication of selection or recognition status.
- A user can edit or supply a transcript with the system keyboard.
- Users can increase control hit targets without increasing ink size.
- Left-handed layout keeps transient controls away from the writing hand.
- Recognition failure preserves the ink and offers Retry, Choose language, or Type text.

## 16. Testing matrix

### 16.1 Required Android dimensions

- At least one Samsung Galaxy Tab + S Pen and one non-Samsung stylus device if supported.
- Android 14 minimum path plus the current Android release.
- Gboard handwriting and the device manufacturer's default handwriting IME.
- Portrait, landscape, split-screen, and hardware-keyboard modes.
- Editing view and Reading view.
- Chinese, English, mixed Chinese-English, numerals, and punctuation.
- Obsidian Sync or filesystem sync conflict simulation.

### 16.2 Required iPad dimensions

- At least one supported Apple Pencil model.
- Minimum supported iPadOS and current iPadOS.
- Portrait, landscape, Split View, and Stage Manager where available.
- Scribble enabled/disabled.
- Chinese, English, mixed input, numerals, and punctuation.

### 16.3 Automated tests

- Ink schema parsing, migration, and validation.
- Stroke grouping and gesture classification.
- Anchor resolution and reflow transforms.
- Recognition-provider contract and fallbacks.
- Markdown serialization round trips.
- Agent payload excludes raw ink by default.
- Crash-safe/atomic persistence behavior.
- Cross-platform capability gating.

Real-device tests remain mandatory because stylus latency, IME behavior, palm rejection,
and native recognition cannot be validated reliably in Node unit tests.

## 17. Android MVP acceptance criteria

The Android Pad MVP is complete when:

1. Tutor Lite loads in Obsidian Android without desktop-only runtime errors.
2. The user can underline or circle source Markdown using a stylus.
3. The user can connect source text to a handwritten note in either direction.
4. The resting annotation is frameless and backgroundless.
5. Raw strokes survive reload, restart, orientation change, and supported Vault sync.
6. The annotation remains semantically attached after normal Markdown edits and reflow.
7. The original handwriting is visible through a portable Vault asset.
8. Recognition produces editable Markdown text through the approved provider/fallback.
9. Recognition never replaces or deletes the original ink.
10. The learner can correct the transcript and send it to Tutor Lite's Agent flow.
11. Agent feedback appears beside the handwriting and is persisted in Markdown.
12. Ink capture and storage work offline.
13. Unsupported recognition produces a clear fallback rather than blocking annotation.
14. No raw ink leaves the device without an explicit user action.
15. The user can create and reopen a full-page handwritten note from the Vault.
16. The full-page note preserves vector ink, exposes a portable rendering, and provides a
    recognized Markdown transcript without destroying diagrams or unrecognized strokes.
17. Compatibility is capability-based: missing pressure, tilt, hover, side-button, or
    recognition APIs reduce only the relevant enhancement and do not disable basic ink.
18. Pen-tip double-tap on completed handwriting triggers recognition without requiring a
    stylus hardware button.
19. Recognition displays an editable confirmation before the first Agent submission.
20. Closing or hiding an ink note does not delete it, and reopening the Markdown note
    restores every non-hidden handwritten note at its saved position.

## 18. Open product decisions

These decisions materially affect architecture and must be answered before Android
implementation begins:

1. **Recognition openness:** must the underlying recognition engine/model itself be open
   source, or is an open-source companion that calls a proprietary on-device system API or
   ML Kit acceptable?
2. **Fixed page details:** what virtual paper size/aspect, page navigation, page-adding
   behavior, and Markdown-content layout should define the book-like writing surface?
3. **Recognition draft persistence:** should a recognized result be written immediately to
   a hidden/draft Markdown section after double-tap, or only after Edit/Send confirmation?
4. **Don't ask again semantics:** after the learner disables confirmation, should a
   double-tap recognize and send immediately, recognize and save without sending, or use a
   different reduced interaction?
5. **Non-text ink:** diagrams, mathematical notation, arrows, and sketches are preserved
   visually in v1. Which of them, if any, must also be understood semantically before v1
   can ship?
6. **Source-note cleanliness:** may inline ink inserts add SVG embeds/comments to the source
   Markdown, or should every ink artifact stay under `Agent Memory/` and render only through
   Tutor Lite?
7. **Cross-device editing:** when the Vault opens on desktop or another device without the
   companion, is portable display plus transcript editing sufficient, or must raw strokes
   remain editable everywhere?
8. **Pen mode:** should writing occur directly on the normal Obsidian reading/editing view,
   or may Tutor Lite enter a dedicated pen layer that visually matches the note?
9. **Double-tap scope:** when there is no lasso selection, how should Tutor Lite decide
   whether a double-tap means one word, one line, one handwritten note, or the full page?
10. **Drag gesture:** what pen/finger gesture should move a handwritten note without being
   mistaken for new ink?
11. **Close behavior:** where and how should a learner restore a note they deliberately
   closed/hidden?
12. **Full-page Agent scope:** how should the learner choose between sending one handwritten
   region, the whole page transcript, or several selected regions?
13. **iPad OS floor:** is targeting iPadOS 27 acceptable for same-stroke PencilKit
   recognition, or must the first iPad release support earlier versions through Scribble
   and plugin-captured ink?
14. **Language priority:** which recognition languages and mixed-language combinations are
   mandatory for the first Android release?

## 19. Recommended decisions for v0.1

Unless changed by the product owner, this draft recommends:

- A capability-tier matrix instead of a single manufacturer-specific Android target.
- Basic vector ink on every supported Obsidian Android device; recognition and advanced
  pen signals enabled only when the required device APIs exist.
- Both anchored annotations and full-page freehand handwritten notes in v1.
- An optional open-source native companion when same-stroke recognition cannot be achieved
  through the stock Obsidian WebView.
- One Tutor Lite plugin with platform adapters, not two competing Obsidian plugins.
- Raw vector JSON + derived SVG + recognized Markdown text.
- Hidden-by-default transcript with a subtle tap-to-correct affordance.
- Pen-tip double-tap as the explicit recognition trigger.
- First Agent submission shows an editable recognition confirmation; automatic background
  Agent submission is prohibited.
- Ink files under `Agent Memory/ink/`; source notes contain only stable anchors/references,
  except for explicit insertion annotations.
- Chinese and English, including mixed Chinese-English notes, as the first language set.
- A mandatory on-device feasibility spike before deciding whether a native companion is
  required.

## 20. Official capability references

- Obsidian manifest and `isDesktopOnly`:
  <https://docs.obsidian.md/Reference/Manifest>
- Obsidian mobile plugin checklist:
  <https://docs.obsidian.md/oo/plugin>
- Android stylus handwriting in text fields and WebView:
  <https://developer.android.com/develop/ui/views/touch-and-input/stylus-input/stylus-input-in-text-fields>
- Android stylus guidance:
  <https://developer.android.com/develop/ui/views/touch-and-input/stylus-input>
- ML Kit Digital Ink Recognition for Android:
  <https://developers.google.com/ml-kit/vision/digital-ink-recognition/android>
- Web Handwriting Recognition API:
  <https://developer.chrome.com/docs/web-platform/handwriting-recognition>
- Apple Pencil and Scribble HIG:
  <https://developer.apple.com/design/human-interface-guidelines/apple-pencil-and-scribble>
- PencilKit:
  <https://developer.apple.com/documentation/pencilkit>
- PencilKit handwriting recognition / `PKStrokeRecognizer`:
  <https://developer.apple.com/documentation/pencilkit/recognizing-handwriting-and-converting-to-text>

## 21. Spec change policy

Decisions from section 18 should be recorded in a dated decision log at the bottom of this
file. Data-format changes require a schema-version and migration note. Platform capability
claims must be verified on a real target device before they become implementation
requirements.

### Decision log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-08-09 | Android Pad precedes iPad; iPad development occurs on macOS | Product direction |
| 2026-08-09 | Ink and recognized Markdown are separate durable layers | Preserve original handwriting while enabling Agent use |
| 2026-08-09 | Native recognition architecture remains gated by a device spike | Stock Obsidian plugin capability is not yet proven |
| 2026-08-09 | Android support is capability-tiered rather than tied to one Pad model | Maximize compatible devices while degrading only unavailable enhancements |
| 2026-08-09 | An optional native Android companion is permitted and should be open source | Enable same-stroke on-device recognition when stock Obsidian cannot expose it |
| 2026-08-09 | Full-page freehand handwritten notes are in v1 scope | Product-owner requirement |
| 2026-08-09 | Pen-tip double-tap on completed ink explicitly triggers recognition | Preserve learner control and a paper-like default view |
| 2026-08-09 | Raw handwriting, not typeset recognition text, is the normal visible artifact | Preserve the learner's original writing and current product character |
| 2026-08-09 | Agent submission first shows recognized text with Edit, Send, and Don't ask again | Prevent silent OCR mistakes while allowing an opt-out |
| 2026-08-09 | Ink notes persist with their Markdown note and can be moved or hidden independently | Product-owner requirement |
| 2026-08-09 | Math, diagrams, arrows, and sketches follow device recognition capability in v1 | Preserve visually now; add specialized semantics later if needed |
