<div align="center">

# 📝 Annotation Tutor Lite

**English** · [简体中文](README.zh-CN.md)

### _Read it. Annotate it. Remember it._

**Turn what you read into learning memory your AI tutor can actually use —
all in plain Markdown, all on your machine.**
![Uploading image.png…]()

[![Release](https://img.shields.io/github/v/release/Chain-Tang/AnnotationTutor?label=release&color=7c3aed)](https://github.com/Chain-Tang/AnnotationTutor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Chain-Tang/AnnotationTutor/total?color=7c3aed)](https://github.com/Chain-Tang/AnnotationTutor/releases)
![Obsidian](https://img.shields.io/badge/Obsidian-1.12.4%2B-7c3aed)
![Desktop](https://img.shields.io/badge/desktop-Windows%20%7C%20macOS%20%7C%20Linux-informational)

</div>

Annotation Tutor Lite is a self-contained Obsidian plugin. You highlight a passage,
write what you think it means, and an AI tutor reviews it, distills durable **memory
cells**, and brings them back on a forgetting-curve schedule so you remember. There's
**no server, no database, no model API key baked in** — every artifact is a Markdown
file in your Vault, so any agent (Claude Code, OpenCode, Codex) can read and extend it.

> The "Lite" build of Annotation Tutor — a focused, standalone Obsidian plugin.

## ✨ Why it's different

- 🗂 **Your data stays yours.** Annotations, reviews, cells, scenes, and your learner
  profile are all human-readable Markdown in your Vault. Nothing is locked in a binary.
- 🧠 **A real learning loop, not just notes.** Reviews become **memory cells**, cells
  auto-group into **scenes**, and **spaced repetition (SM-2)** schedules them before you
  forget — grounded in the Ebbinghaus forgetting curve.
- 📓 **A study notebook that reads like a book.** One command turns scattered
  annotations into a navigable notebook with dated links chaining
  notebook → annotation → original source.
- 🌐 **Read in any language.** Inline word/phrase glosses and full-document
  pre-translation for immersive reading (see [Keyboard shortcuts](#️-keyboard-shortcuts)).
- 🔌 **Bring your own engine.** Use the already-authenticated **OpenCode** CLI or any
  **OpenAI-compatible API** — your key lives only in your Vault's local plugin data.
- 🌏 **Fully localized UI** in English, 简体中文, 繁體中文, and 日本語.

## ⌨️ Keyboard shortcuts

Three commands ship with a default hotkey — and the defaults **differ by OS on purpose**:

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Add learning annotation | `Ctrl + Shift + L` | `⌘ + Shift + L` |
| Translate selection (inline gloss) | `Alt + T` | `⌘ + Shift + T` |
| Pre-translate whole document (full text) | `Ctrl + Alt + T` | `⌘ + Shift + Y` |

**Why macOS differs:** on macOS, `Option (⌥) + a letter` types a special glyph
(e.g. ⌥+T → `†`) instead of registering as that key, so an `Alt`-based hotkey would
silently never fire. The plugin therefore ships `⌘ + Shift` defaults on macOS and keeps
the lighter `Alt` defaults on Windows/Linux.

All three are **rebindable**: **Settings → Annotation Tutor Lite → Keyboard shortcuts**
(or **Settings → Hotkeys**, then search "Annotation Tutor Lite"). Every other command
(Open study notebook, Build notebook, Review due cells, Open tutor chat, …) has **no
default hotkey** — assign your own the same way.

## 🔌 Connect an engine

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

<details>
<summary>📦 <b>Download &amp; install</b> — four ways (methods 1–3 need no build tools)</summary>

All install the same plugin into `<YourVault>/.obsidian/plugins/annotation-tutor-lite/`.

### 1. Release zip (easiest)

1. Download `annotation-tutor-lite-<version>.zip` from the
   [**Releases** page](https://github.com/Chain-Tang/AnnotationTutor/releases/latest).
2. Unzip it into your Vault's `.obsidian/plugins/` folder — it creates the
   `annotation-tutor-lite/` folder for you.
3. In Obsidian → **Settings → Community plugins**, turn off Restricted mode if needed,
   enable **Annotation Tutor Lite**, and reload (`Ctrl/Cmd+R`).

### 2. Loose files (manual)

From the same [release](https://github.com/Chain-Tang/AnnotationTutor/releases/latest),
download `main.js`, `manifest.json`, and `styles.css`, then drop all three into a folder
you create at `<YourVault>/.obsidian/plugins/annotation-tutor-lite/`. Enable and reload as
above.

### 3. BRAT (auto-updates)

Install the **BRAT** community plugin, then *Add beta plugin* → enter
`Chain-Tang/AnnotationTutor`. BRAT installs from the latest release's assets and keeps the
plugin updated. (If BRAT can't resolve it, use method 1 or 2.)

### 4. Build from source (developers)

You need **Node 22.13+** and **pnpm 10**. Get the source any of these ways:

```bash
git clone https://github.com/Chain-Tang/AnnotationTutor.git      # full repo
# or:  gh repo clone Chain-Tang/AnnotationTutor
# or:  download the source ZIP from the repo's green "Code" button (no git needed)
```

Then build and install into a Vault:

```bash
cd AnnotationTutor
pnpm install
pnpm install:vault -- --vault "/path/to/YourVault"   # build + copy + enable
# or, to produce release artifacts (zip + loose files under dist/):
pnpm package
```

Then [connect an engine](#-connect-an-engine) and you're ready.

</details>

<details>
<summary>🚀 <b>First run</b> — what gets created automatically</summary>

After enabling the plugin, **reload Obsidian once** (`Ctrl/Cmd+R`). Everything it needs is
created automatically — you don't make any folders yourself:

1. **Reload.** An `Agent Memory/` folder appears at your Vault root, scaffolded with
   `annotations/`, `memory-cells/`, `scenes/`, `profiles/` (with an empty
   `learner-profile.md`), and an **`AGENTS.md`** describing the file protocol for external
   agents. (The folder name is the **Memory folder** setting; `AGENTS.md` comes from the
   **Create agent instruction file** toggle — both on by default.)
2. **Choose an engine** in **Settings → Annotation Tutor Lite** — see
   [Connect an engine](#-connect-an-engine). For OpenCode you just install and
   `opencode auth login` the CLI once; nothing extra is written into your Vault (no
   `.opencode` config, no API key).
3. **Annotate.** Select text → `Ctrl/Cmd+Shift+L` → write your understanding → ask the
   tutor to review it.

> The three files in the download (`main.js`, `manifest.json`, `styles.css`) are the whole
> plugin — all the source is bundled into `main.js`. The `Agent Memory/` notes are
> generated in your Vault on first run, not shipped in the download.

</details>

<details>
<summary>🖥️ <b>Platform support</b> — Windows · macOS · Linux</summary>

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

</details>

<details>
<summary>⚙️ <b>How it works</b></summary>

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

</details>

<details>
<summary>🧠 <b>Core concepts</b></summary>

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

</details>

<details>
<summary>🗂️ <b>Vault layout</b></summary>

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

</details>

<details>
<summary>🛠️ <b>Development</b></summary>

After getting the source ([method 4 above](#4-build-from-source-developers)) and running
`pnpm install` at the repo root:

- `pnpm typecheck` / `pnpm test` / `pnpm build` — the gate.
- `pnpm dev` — esbuild watch.
- `pnpm package` — build + stage `dist/release/annotation-tutor-lite/` and a release zip.
- `pnpm install:dev-plugin -- --vault "/path/to/YourVault"` — copy the built plugin into a
  Vault for testing. `pnpm install:vault -- --vault "…"` builds then installs in one step.

</details>

<details>
<summary>🏗️ <b>Architecture</b></summary>

Pure, unit-tested logic (no Obsidian imports): `src/model.ts`, `src/ids.ts`,
`src/anchors.ts`, `src/srs.ts`, `src/memory-derive.ts`, `src/learning.ts`,
`src/index-table.ts`, `src/reading-highlight.ts`, `src/markdown/*`. Obsidian-bound layer:
`src/store.ts` (file I/O + self-write loop-guard), `src/watcher.ts`, `src/decorations.ts`,
`src/editor.ts`, `src/settings.ts`, `src/views/*`, the `*-controller.ts` modules, and
`src/main.ts` (wiring). Tests live in `tests/`.

See **[docs/guide.md](docs/guide.md)** for the learning model and
`PrivTutor Lite MVP Design Spec.md` for the original product baseline.

</details>

## 📄 License

Released under the [**MIT License**](LICENSE) — free to use, modify, and distribute,
including commercially, as long as the copyright and license notice are kept. © 2026 Chain.
