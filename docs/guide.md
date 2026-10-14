# Annotation Tutor Lite — User Guide

This guide explains what each piece of Annotation Tutor Lite is, how it's created, and
why it helps. Everything described here is a plain-Markdown file in your Vault that any
agent can read — there is no hidden database.

- [The learning loop (mental model)](#the-learning-loop-mental-model)
- [Annotations](#annotations)
- [Memory cells](#memory-cells)
- [Spaced repetition (SM-2)](#spaced-repetition-sm-2)
- [Scenes](#scenes)
- [The learner profile](#the-learner-profile)
- [The notebook](#the-notebook)
- [Translation](#translation)
- [Memory write modes & proposals](#memory-write-modes--proposals)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Commands reference](#commands-reference)

## The learning loop (mental model)

```
annotate → agent review → distill a memory cell → cells auto-form scenes
   → the learner profile tracks you over time → the notebook is your readable output
   → spaced repetition brings cells back before you forget → repeat
```

Each arrow is a Markdown file written into `Agent Memory/`. You can read, edit, or delete
any of them by hand; the plugin reconciles and rebuilds its index from the files.

## Annotations

An **annotation** is the atom: a passage you highlighted plus what you think it means.

**How to create one:** select text in any note and run **Add learning annotation**
(`Ctrl/Cmd + Shift + L`), or use the editor right-click menu. Write your understanding in
the modal. The plugin:

- inserts an Obsidian block id (`^ann-YYYYMMDD-NNN`) at the source so the annotation stays
  anchored even as you edit around it, and
- writes `Agent Memory/annotations/ANN-YYYYMMDD-NNN.md` — the **source of truth** for that
  annotation (YAML frontmatter + Selected Text + your Note + the Agent Review + a Dialogue
  section). A link back to the source block sits at the top, so the file is one hop from
  the original text.

**The review:** run **Ask agent to review current annotation**. Your engine reads the
annotation, judges your understanding (correct / partially / incorrect), and writes an
**Agent Review** into the file. The plugin owns the metadata and your Note; the agent owns
the Agent Review / Review History — neither clobbers the other.

You can also chat with the tutor *inside* an annotation; turns are saved to the file's
`## Dialogue` section so the conversation survives reloads.

## Memory cells

A **memory cell** is an atomic, evidence-backed memory distilled from one or more
annotations. It is the unit your tutor remembers, schedules, and reviews. Each cell
(see `src/model.ts`) carries:

- a **concept** and a one-paragraph **summary**;
- a **type** — `understanding`, `misconception`, `goal`, `difficulty`, `strategy`, or
  `progress`;
- a **status** — e.g. `new`, `partially_understood`, `stable`, `needs_review`;
- a **confidence** (0–1) and the **source annotations** that back it; and
- a **spaced-repetition schedule** (see below) once it enters the review loop.

**How to create one:**

- **Manually** — place the cursor in an annotation and run **Create memory cell from
  current annotation**; or
- **Automatically** — when the agent finishes a review it can distill a durable cell for
  you.

Cells are stored as Markdown with YAML frontmatter in `Agent Memory/memory-cells/`
(filenames are the cell id, e.g. `MEM-ann-20260606-001.md`; both `MEM-` and `CELL-`
prefixes are valid). The frontmatter is the source of truth.

## Spaced repetition (SM-2)

Cells are scheduled with the **SM-2 algorithm** (SuperMemo 2, Woźniak 1990 — the scheme
Anki and Mnemosyne use). SM-2 counters the **Ebbinghaus forgetting curve**: it expands the
gap between reviews each time you recall a cell, and collapses it when you don't, so you
review right before you'd forget. The implementation is `src/srs.ts`.

**How it works:** run **Review due cells**. For each due cell you reveal the answer, then
grade your recall:

| Button | Meaning | Effect |
| --- | --- | --- |
| **Again** | forgot it | interval resets to 1 day, lapse counted, streak reset |
| **Hard** | barely | passes, ease nudged down |
| **Good** | recalled | interval steps 1d → 6d → `round(interval × ease)` |
| **Easy** | effortless | passes, ease nudged up, interval grows faster |

A brand-new cell is due immediately so it enters the loop; from there the schedule lives in
the cell's frontmatter (`ease`, `intervalDays`, `reps`, `lapses`, `dueAt`). Your measured
recall (reps/lapses) also feeds the strength/weakness analysis below — so the notebook's
judgments are grounded in behavior, not just the model's guess.

## Scenes

A **scene** is a context that groups related cells (a topic, course, document, or project).

**How scenes are triggered:** they form **automatically**. Whenever two or more cells
share the same concept, the plugin derives a scene for that concept (`deriveScenes` in
`src/memory-derive.ts`), tagged `auto`. This runs after you create a cell, after a review,
and on **Rebuild Annotation Tutor index** (via `store.syncScenesFromCells`). A single cell
needs no grouping, so it gets no scene until a second cell joins it.

Auto scenes are regenerated from the current cells, so stale ones are cleaned up
automatically. **Hand-authored scenes** (and agent-proposed scenes) are *not* tagged `auto`
and are left untouched — you can curate your own contexts alongside the automatic ones.

## The learner profile

The **learner profile** (`Agent Memory/profiles/learner-profile.md`) is an auditable,
plain-Markdown model of *you*: a short summary plus a list of **claims**, each a statement
backed by **evidence** (links to the annotations/cells that justify it). The tutor reads it
to personalize reviews and explanations to your strengths, gaps, and goals.

It starts empty and is maintained by the agent over time. `preferences.md` is a separate
profile for stated preferences; **agent writes to it are disabled by default** so the agent
can't silently rewrite your preferences.

## The notebook

The **notebook** turns your scattered annotations and cells into a study resource that
reads like a book — generated under `Agent Memory/Notebook/`:

- `Notebook.md` — the entry point / map of content;
- `pages/<doc>.md` — one "literature note" per studied document;
- `chapters/<topic>.md` — concept chapters grouping related pages;
- `Learning summary.md` — your **strengths**, **weaknesses**, and **problem-solving
  methods**.

**Why it helps:**

- **Navigable by design.** Entries are headed by a localized **date that links to the
  annotation**, and each annotation links back to its **source** — so you can travel
  notebook → annotation → original text in two clicks.
- **Real content without an agent pass.** Pages are generated deterministically from your
  annotations and cells, so the notebook is useful immediately; an optional agent pass adds
  prose.
- **Grounded summaries.** Strengths/weaknesses come from your actual review performance
  (reps/lapses), not guesses.
- **In your language.** Structure follows the plugin's display language; agent prose follows
  your review language.

**How to build it:** run **Build notebook** (deterministic) or **Enrich notebook with
agent** (adds synthesis prose). **Open study notebook** opens `Notebook.md`.

## Translation

For immersive reading in a foreign language:

- **Inline gloss** — select a word or passage and press **`Alt + T`** to insert a concise
  translation right after it. (Command: *Translate selection (inline gloss)*.)
- **Full-document pre-translation** — press **`Ctrl/Cmd + Alt + T`** to gloss the whole
  document into a cached glossary so inline lookups are instant. (Command: *Pre-translate
  current document*.)
- **Pre-translate on open** — a setting that runs the full-document pre-translation
  automatically when you open a document. Its glossary feeds the inline `Alt+T` dictionary.
- **Dictionary language** — set your native language so foreign words are glossed as
  `word (译文)`; empty follows the display language.

## Memory write modes & proposals

Memory writes default to **`direct`**: the agent's cell/scene/profile changes are applied
immediately. Switch to **`confirmation`** in settings to route every proposed change through
the **Proposals** tab, where you approve or reject each one (queued under
`Agent Memory/proposals/pending/`, archived after). Use this when you want a human gate on
what enters your long-term memory.

## Keyboard shortcuts

Defaults (Mod = `Ctrl` on Windows/Linux, `Cmd` on macOS):

| Action | Shortcut |
| --- | --- |
| Add learning annotation | `Ctrl/Cmd + Shift + L` |
| Translate selection (inline gloss) | `Alt + T` |
| Pre-translate whole document (full-text) | `Ctrl/Cmd + Alt + T` |

All other commands have **no default hotkey**. Assign your own in **Settings → Hotkeys**:
search for "Annotation Tutor Lite".

## Commands reference

Open the command palette (`Ctrl/Cmd + P`) and search for these:

| Command | What it does |
| --- | --- |
| Add learning annotation | Annotate the selection (hotkey above) |
| Ask agent to review current annotation | Request an AI review of the annotation at the cursor |
| Open tutor chat | Chat with the tutor about what you're reading |
| Translate selection (inline gloss) | Inline translation (hotkey above) |
| Pre-translate current document | Full-document pre-translation (hotkey above) |
| Create memory cell from current annotation | Distill a cell from the annotation at the cursor |
| Review due cells | Run a spaced-repetition session |
| Build notebook | Generate the study notebook deterministically |
| Enrich notebook with agent | Add agent synthesis prose to the notebook |
| Open study notebook | Open `Notebook.md` |
| Refresh learning summary | Rebuild the strengths/weaknesses/methods summary |
| Generate practice for weaknesses | Create retrieval-practice questions for weak cells |
| Suggest next steps (strengths) | Ask the tutor where to go deeper |
| Rebuild Annotation Tutor index | Rebuild the cache (and refresh auto scenes) from the Markdown |
| Toggle annotation marks | Show/hide the in-editor annotation highlights |

### Drawing connection and mathematical plots

The inspiration board follows the Tutor sidebar's engine, connection and model by default. In Settings → model routes, select the board's separate configuration to restore or override its own engine/model. Existing board presets are retained during migration; API keys are not replaced. Each drawing task identifies its actual execution model, including independent connections.

Ask in the sidebar, for example, “Draw sin(x)/x near x=0, with an open point at its limit.” Tutor first identifies the drawing intent and opens the document board if needed. Function and finite-point limit diagrams use host-computed coordinates for curves, axes, guides and markers. The resulting objects remain editable and the entire reply is one undo step. Moving an object does not recompute the mathematical relationships. Numerical consistency checks are not proofs.

A provider denial or empty answer is a connection/execution failure, not a drawing-format mistake. Use “Check connection”; when a separate board connection fails, “Retry with sidebar model” switches to the current chat connection while keeping the target board. Only malformed drawing content receives one automatic correction. Configuration changes cancel in-flight board requests and clear their previews.
