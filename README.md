# 🎓 Annotation Tutor

<p align="center">
  <img src="Screenshots/Screenshot 2026-06-08 033945.png" alt="Annotation Tutor" width="800">
</p>

<p align="center">
  <b>Turn your Obsidian highlights into a private, AI-reviewed learning memory — fully local.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.17.0-blue?logo=node.js" alt="Node.js Version">
  <img src="https://img.shields.io/badge/pnpm-%3E%3D10-orange?logo=pnpm" alt="pnpm Version">
  <img src="https://img.shields.io/github/actions/workflow/status/Chain-Tang/PriveTutor/ci.yml?branch=main&label=build&logo=github" alt="Build Status">
  <img src="https://img.shields.io/github/stars/Chain-Tang/PriveTutor?style=social" alt="GitHub Stars">
</p>

---

## What is this?

**Annotation Tutor** is an Obsidian tool for active learners. Highlight a passage,
write what you think it means, and a local AI agent — **OpenCode**, Codex, or
Claude Code — reviews your understanding: correcting mistakes, filling gaps, and
building a durable, searchable *learning memory* in plain Markdown. It can also
translate and pre-gloss foreign-language notes inline as you read.

Everything runs on your machine. **No cloud, no vector DB, no required API keys** —
agents authenticate through their own CLIs, and your notes never leave your Vault.

It comes in two editions:

- 🪶 **TutorLite** — a single, self-contained Obsidian plugin. Markdown-only, zero
  infrastructure. **This is the one most people want.**
- 🧰 **Full MVP** — a server-backed build (local REST + MCP server, SQLite/FTS5
  index, CLI) for power users and integrations.

---

## ✨ Features

- 📝 **Annotate → review** — highlight, write your understanding, get an AI review right beside your notes.
- 🌐 **Inline translation** — `Alt+T` glosses a word or passage; `Ctrl+Alt+T` pre-translates the whole document into a per-file glossary so later lookups are instant.
- 🤖 **Bring your own agent** — OpenCode (recommended), Codex, or Claude Code, already authenticated via their own CLI.
- 🧠 **Memory as Markdown** — annotations, memory cells, and a learner profile you can read, edit, and `grep`.
- 🔒 **Local-first & private** — your Vault is the source of truth; no keys are stored in this repo.

---

## 🧭 The learning method

Annotation Tutor is built around how people actually learn deeply — not just
collect highlights. Each principle maps to a concrete feature:

- 🛋️ **Immersive, in-context learning.** Read, annotate, and converse without
  leaving the page — margin cards and an in-card dialogue keep you *in the text*
  instead of bouncing to a chatbot.
- ✍️ **The Feynman technique.** You write what a passage means in *your own words*;
  the tutor reviews that explanation, so the act of explaining is what reveals and
  then closes the gaps.
- ❓ **Socratic questioning.** Reviews often end with a question rather than a
  verdict, nudging you one step further instead of just handing over the answer.
- 🌐 **Rapid translation.** `Alt+T` glosses a word or passage inline; the whole
  document can be pre-glossed in the background so foreign-language reading stays
  fluid.
- 🧠 **Memory units (cells).** Durable, single-idea memory cells are distilled from
  your annotations and dialogue — each with a concept, a confidence, and a status —
  forming a learning memory you can read and `grep`.
- 📓 **A Zettelkasten notebook.** One command assembles your studied documents into
  a slip-box: literature-note pages per source, structure-note chapters that link
  related reading, and an index — so connections between ideas surface on their own.
- 🔁 **Reinforcement along the forgetting curve.** Cells track confidence and a
  `needs_review` status — the foundation for spaced review of what hasn't yet stuck.
  *(Automated review scheduling is on the roadmap.)*

All of it is plain, local Markdown you own — private, portable, and future-proof.

---

## 🚀 Install TutorLite (≈2 minutes)

Requires **Node 22.13+** and **pnpm 10**.

```bash
git clone https://github.com/Chain-Tang/PriveTutor.git
cd PriveTutor/TutorLite
pnpm install
pnpm build                                          # -> dist/main.js
pnpm install:dev-plugin -- --vault "C:\path\to\YourVault"
```

The last command copies `manifest.json`, `main.js`, and `styles.css` into
`<YourVault>/.obsidian/plugins/annotation-tutor-lite/`. Open Obsidian, enable
**Annotation Tutor Lite** under *Settings → Community plugins*, and reload
(`Ctrl/Cmd+R`). Prefer to install by hand? Copy those three files into that folder
yourself (`main.js` is `dist/main.js` renamed).

> Full plugin details, the Vault layout, and the agent review protocol live in
> [**`TutorLite/README.md`**](TutorLite/README.md).

---

## 🔌 Connect OpenCode (or a direct API)

Open *Settings → General* and pick the engine that powers reviews, chat, and translation:

- **OpenCode** *(recommended)* — install and log in to the
  [`opencode`](https://opencode.ai) CLI, then select **OpenCode**. The plugin
  drives your already-authenticated CLI over ACP and can read your Vault directly.
  **No API key is stored.** Default model: `opencode/mimo-v2.5-free` (change
  **Agent model** to use another).
- **Direct API** — any OpenAI-compatible endpoint. Defaults target DeepSeek
  (`https://api.deepseek.com/v1`, model `deepseek-chat`); paste your key under
  **API key**. It is saved only in your Vault's local plugin data.

---

## 📖 How to use

1. **Annotate** — select text in a note, run **Add learning annotation**, and write your understanding.
2. **Ask for a review** — run **Ask Agent**; your agent reads the annotation files, writes a review back into the note, and marks the task done. The plugin watches the files and refreshes the UI automatically.
3. **Translate while reading** — `Alt+T` on a selection for an inline gloss, or `Ctrl+Alt+T` to pre-translate the open document so subsequent lookups are instant.
4. **Open your notebook** — click the 📓 **notebook icon** in the left ribbon (or run **Open study notebook** from the command palette) to assemble everything you've studied into a Zettelkasten-style notebook; the first open builds it. The notebook's own **About this notebook** page explains its format and the ideas behind it.

Your annotations, reviews, and memory cells are all plain Markdown under your
Vault's `Agent Memory/` folder — portable and future-proof. Memory cells are
captured automatically after a review, or on demand from the 🧠 button on a card.

---

## 🧰 Full MVP (advanced)

The server-backed edition adds a local REST + MCP server, a rebuildable
SQLite/FTS5 index, and a CLI. Most users don't need it.

```bash
git clone https://github.com/Chain-Tang/PriveTutor.git
cd PriveTutor
pnpm install
pnpm install:dev-plugin            # builds + installs the full plugin into ./Tutor
```

Open the `Tutor` folder as a Vault, enable **Annotation Tutor**, and reload. CLI tools:

```bash
node apps/cli/dist/index.js doctor        --vault Tutor
node apps/cli/dist/index.js start         --vault Tutor
node apps/cli/dist/index.js rebuild-index --vault Tutor
```

Architecture: `domain → core → service → apps/{obsidian-plugin, cli}`, with `mcp`
and `agent-bridges` layered on `core`. See
[`docs/project-status.md`](docs/project-status.md) for status and roadmap.

> **Note:** the full MVP's SQLite search needs **Node 22.17+** — earlier
> `node:sqlite` builds lack the FTS5 module on Linux/macOS. TutorLite has no such
> requirement.

---

## 🛠️ Development

```bash
# TutorLite (standalone — run from inside the folder)
cd TutorLite && pnpm install && pnpm check     # typecheck + test + build

# Full MVP (workspace root)
pnpm install && pnpm check
```

CI runs the same checks on **Linux, Windows, and macOS**.

---

<p align="center">Built for the Obsidian community. Local-first, always.</p>
```