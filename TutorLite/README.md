# Annotation Tutor Lite

**English** · [简体中文](README.zh-CN.md)

**Turn what you read into learning memory your AI tutor can actually use — all in
plain Markdown, all on your machine.**

Annotation Tutor Lite is a self-contained Obsidian plugin. You highlight a passage,
write what you think it means, and an AI tutor reviews it, distills durable **memory
cells**, and brings them back on a forgetting-curve schedule so you remember. There's
**no server, no database, no model API key baked in** — every artifact is a Markdown
file in your Vault, so any agent (Claude Code, OpenCode, Codex) can read and extend it.

> The "Lite" sibling of the full Annotation Tutor. It's a standalone project (its own
> build; not part of the monorepo workspace).

## Why it's different

- 🗂 **Your data stays yours.** Annotations, reviews, cells, scenes, and your learner
  profile are all human-readable Markdown in your Vault. Nothing is locked in a binary.
- 🧠 **A real learning loop, not just notes.** Reviews become **memory cells**, cells
  auto-group into **scenes**, and **spaced repetition (SM-2)** schedules them before you
  forget — grounded in the Ebbinghaus forgetting curve.
- 📓 **A study notebook that reads like a book.** One command turns scattered
  annotations into a navigable notebook with dated links chaining
  notebook → annotation → original source.
- 🌐 **Read in any language.** Inline word/phrase glosses (`Alt+T`) and full-document
  pre-translation (`Ctrl+Alt+T`) for immersive reading.
- 🔌 **Bring your own engine.** Use the already-authenticated **OpenCode** CLI or any
  **OpenAI-compatible API** — your key lives only in your Vault's local plugin data.
- 🌏 **Fully localized UI** in English, 简体中文, 繁體中文, and 日本語.

## Download & install

Pick whichever method suits you — all install the same plugin into
`<YourVault>/.obsidian/plugins/annotation-tutor-lite/`. **Methods 1–3 need no Node or
build tools.**

### 1. Release zip (easiest)

1. Download `annotation-tutor-lite-<version>.zip` from the
   [**Releases** page](https://github.com/Chain-Tang/PriveTutor/releases/latest).
2. Unzip it into your Vault's `.obsidian/plugins/` folder — it creates the
   `annotation-tutor-lite/` folder for you.
3. In Obsidian → **Settings → Community plugins**, turn off Restricted mode if needed,
   enable **Annotation Tutor Lite**, and reload (`Ctrl/Cmd+R`).

### 2. Loose files (manual)

From the same [release](https://github.com/Chain-Tang/PriveTutor/releases/latest),
download `main.js`, `manifest.json`, and `styles.css`, then drop all three into a folder
you create at `<YourVault>/.obsidian/plugins/annotation-tutor-lite/`. Enable and reload as
above.

### 3. BRAT (auto-updates)

Install the **BRAT** community plugin, then *Add beta plugin* → enter
`Chain-Tang/PriveTutor`. BRAT installs from the latest release's assets and keeps the
plugin updated. (If BRAT can't resolve it, use method 1 or 2.)

### 4. Build from source (developers)

You need **Node 22.13+** and **pnpm 10**. Get the source any of these ways:

```bash
git clone https://github.com/Chain-Tang/PriveTutor.git      # full repo
# or:  gh repo clone Chain-Tang/PriveTutor
# or:  download the source ZIP from the repo's green "Code" button (no git needed)
```

Then build and install into a Vault:

```bash
cd PriveTutor/TutorLite
pnpm install
pnpm install:vault -- --vault "/path/to/YourVault"   # build + copy + enable
# or, to produce release artifacts (zip + loose files under dist/):
pnpm package
```

Then [connect an engine](#connect-an-engine) and you're ready.

## Platform support

Desktop **Windows, macOS, and Linux** are all supported (Obsidian 1.12.4+); the plugin is
desktop-only (mobile is not supported). The pure logic is unit-tested and the
OS-touching code paths (locating the agent CLI, quoting, path handling) are written for
all three platforms.

One thing to know if you use the **OpenCode engine**: Obsidian launched from a Dock,
Start menu, or desktop entry can inherit a minimal `PATH` that omits where CLIs install.
The plugin compensates by also searching the usual locations — `%APPDATA%\npm` on Windows,
and `/opt/homebrew/bin`, `/usr/local/bin`, `~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`
on macOS/Linux. If your `opencode` lives somewhere unusual, set its full path as the
engine command, or use the **Direct API** engine (no subprocess, works everywhere).

## Connect an engine

Reviews, the tutor chat, and translation run on one engine — pick it in
**Settings → General**:

- **OpenCode** (recommended; it can read your Vault directly). Install and log in to the
  [`opencode`](https://opencode.ai) CLI yourself, then set the engine to **OpenCode**.
  The plugin drives your already-authenticated CLI over ACP — **no API key is stored**.
  Default model is `opencode/mimo-v2.5-free`; change **Agent model** to use another.
- **Direct API** (default): any OpenAI-compatible endpoint. Defaults target DeepSeek
  (`https://api.deepseek.com/v1`, model `deepseek-chat`) — paste your key under
  **API key**. The key lives only in your Vault's local plugin data, never in this repo.

No cloud services or credentials ship with this plugin.

## How it works

1. Select text in a note → **Add learning annotation** (`Ctrl/Cmd+Shift+L`) → write your
   understanding. The plugin inserts an Obsidian block id (`^ann-…`) and a per-annotation
   Markdown file under `Agent Memory/annotations/`.
2. **Ask the agent** to review it. Your engine reads the files (guided by
   `Agent Memory/AGENTS.md`), writes a review into the annotation's **Agent Review**
   section, and can distill a **memory cell**.
3. Cells with a shared concept auto-form a **scene**; your **learner profile** tracks
   durable facts about you over time.
4. **Spaced repetition** resurfaces due cells; **Build notebook** turns everything into a
   readable study notebook.

The plugin owns the metadata, Selected Text, and User Note; the agent owns the Agent
Review / Review History sections, which are preserved verbatim on every plugin edit.
`index.json` (under the plugin folder) is a rebuildable cache — **Rebuild Annotation
Tutor index** regenerates it from the Markdown.

## Core concepts

- **Memory cell** — an atomic, evidence-backed memory distilled from one or more
  annotations (a concept, your grasp of it, a confidence, and a spaced-repetition
  schedule). This is the unit your tutor remembers and reviews.
- **Scene** — a context that groups related cells. Scenes form **automatically** once
  two or more cells share a concept; you (or the agent) can also author your own.
- **Learner profile** — an auditable, plain-Markdown model of you: claims about your
  strengths, gaps, and goals, each backed by evidence. The tutor uses it to personalize.
- **Notebook** — a generated, human-readable study notebook (per-document pages, concept
  chapters, a strengths/weaknesses summary) with dated links back to every annotation
  and source.

→ Full explanations, the data model, and how each piece is triggered are in
**[docs/guide.md](docs/guide.md)**.

## Keyboard shortcuts

Defaults (Mod = `Ctrl` on Windows/Linux, `Cmd` on macOS):

| Action | Shortcut |
| --- | --- |
| Add learning annotation | `Ctrl/Cmd + Shift + L` |
| Translate selection (inline gloss) | `Alt + T` |
| Pre-translate whole document (full-text) | `Ctrl/Cmd + Alt + T` |

Every other command (Open study notebook, Build notebook, Review due cells, Open tutor
chat, …) has **no default hotkey** — assign one in **Settings → Hotkeys** by searching
for "Annotation Tutor Lite".

## Vault layout

```
Agent Memory/
├── annotations/ANN-YYYYMMDD-NNN.md   # source of truth, one per annotation
├── memory-cells/MEM-*.md             # atomic, evidence-backed memories (+ SRS schedule)
├── scenes/SCENE-*.md                 # auto-grouped or hand-authored contexts
├── profiles/
│   ├── learner-profile.md            # auditable long-term learner model
│   └── preferences.md                # optional; Agent writes disabled by default
├── indexes/{annotations,cells,scenes}.md
├── proposals/{pending,archive}/      # confirmation-mode review queue
├── Notebook/                         # generated study notebook
│   ├── Notebook.md                   #   entry point / map of content
│   ├── pages/<doc>.md                #   one literature note per studied document
│   ├── chapters/<topic>.md           #   concept chapters grouping related pages
│   └── Learning summary.md           #   strengths / weaknesses / methods
├── annotation-memory.md              # generated overview / agent entry point
├── recent-learning.md                # generated short summary
├── agent-inbox.md                    # task queue
└── AGENTS.md                         # generated agent instructions
```

New files use YAML Properties plus readable Markdown bodies and Obsidian Wikilinks.
Memory writes default to `direct`; switch to `confirmation` in settings to route proposed
Cell/Scene/Profile changes through the **Proposals** tab.

## Development

After getting the source ([method 4 above](#4-build-from-source-developers)) and running
`pnpm install` in `TutorLite/`:

- `pnpm typecheck` / `pnpm test` / `pnpm build` — the gate.
- `pnpm dev` — esbuild watch.
- `pnpm package` — build + stage `dist/release/annotation-tutor-lite/` and a release zip.
- `pnpm install:dev-plugin -- --vault ../Tutor` — copy the built plugin into a dev Vault
  (defaults to `../Tutor`); the id `annotation-tutor-lite` lets it coexist with the full
  plugin. `pnpm install:vault` builds then installs in one step.

## Architecture

Pure, unit-tested logic (no Obsidian imports): `src/model.ts`, `src/ids.ts`,
`src/anchors.ts`, `src/srs.ts`, `src/memory-derive.ts`, `src/learning.ts`,
`src/index-table.ts`, `src/markdown/*`. Obsidian-bound layer: `src/store.ts`
(file I/O + self-write loop-guard), `src/watcher.ts`, `src/decorations.ts`,
`src/editor.ts`, `src/settings.ts`, `src/views/*`, the `*-controller.ts` modules, and
`src/main.ts` (wiring). Tests live in `tests/`.

See **[docs/guide.md](docs/guide.md)** for the learning model and
`PrivTutor Lite MVP Design Spec.md` for the original product baseline.
