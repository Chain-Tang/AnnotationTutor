# Annotation Tutor Lite

A self-contained Obsidian plugin that turns learning annotations into
agent-readable Markdown memory — **no server, MCP, SQLite, or model API key**.
Everything lives as Markdown in your Vault; any agent (Claude Code, OpenCode,
Codex) interacts purely through files.

This is the "Lite" sibling of the full Annotation Tutor in the parent repo. It is
a standalone project (its own build, not part of the monorepo workspace).

## Quick start

Requires **Node 22.13+** and **pnpm 10**.

```bash
git clone https://github.com/Chain-Tang/PriveTutor.git
cd PriveTutor/TutorLite
pnpm install
pnpm build                 # -> dist/main.js
```

Install the built plugin into your own Vault, then enable it in **Settings →
Community plugins**:

```bash
# copies manifest.json, main.js, styles.css into
# <YourVault>/.obsidian/plugins/annotation-tutor-lite/
pnpm install:dev-plugin -- --vault "C:\path\to\YourVault"
```

Reload Obsidian (`Ctrl/Cmd+R`) after the first install. To install by hand
instead, copy `manifest.json`, `styles.css`, and `dist/main.js` (renamed to
`main.js`) into that plugin folder yourself.

## Connect an engine (OpenCode or API)

Reviews, the tutor chat, and translation run on one of two engines — pick it in
**Settings → General**:

- **OpenCode** (recommended; it can read your Vault directly). Install and log in
  to the [`opencode`](https://opencode.ai) CLI yourself, then set the engine to
  **OpenCode**. The plugin drives your already-authenticated CLI over ACP — **no
  API key is stored**. Default model is `opencode/mimo-v2.5-free`; change **Agent
  model** to use another.
- **Direct API** (default): any OpenAI-compatible endpoint. Defaults target
  DeepSeek (`https://api.deepseek.com/v1`, model `deepseek-chat`) — paste your key
  under **API key**. The key lives only in your Vault's local plugin data, never
  in this repo.

No cloud services, model keys, or credentials ship with this plugin: agents
authenticate through their own CLIs and all data stays in your Vault.

## How it works

1. Select text in a note → **Add learning annotation** → write your understanding.
2. The plugin inserts an Obsidian block id (`^ann-…`) and writes a per-annotation
   Markdown file under `Agent Memory/annotations/`.
3. **Ask Agent** writes a task into `Agent Memory/agent-inbox.md`. You run your
   agent in the Vault; it reads the files (guided by `Agent Memory/AGENTS.md`),
   writes a review into the annotation's **Agent Review** section, and marks the
   task `completed`.
4. The plugin watches the files, validates Agent writes, rebuilds its cache and
   Markdown indexes, and refreshes the Obsidian UI.

The plugin owns the metadata, Selected Text, and User Note; the agent owns the
Agent Review / Review History sections, which are preserved verbatim on every
plugin edit. `index.json` (under the plugin folder) is a rebuildable cache —
**Rebuild Annotation Tutor index** regenerates it from the Markdown files.

## Vault layout

```
Agent Memory/
├── annotations/ANN-YYYYMMDD-NNN.md   # source of truth, one per annotation
├── memory-cells/CELL-YYYYMMDD-NNN.md # atomic, evidence-backed memories
├── scenes/SCENE-*.md                  # topic/course/document/project contexts
├── profiles/
│   ├── learner-profile.md             # auditable long-term learner model
│   └── preferences.md                 # optional, disabled for Agent writes by default
├── indexes/
│   ├── annotations.md
│   ├── cells.md
│   └── scenes.md
├── proposals/
│   ├── pending/                       # confirmation-mode review queue
│   └── archive/
├── annotation-memory.md              # generated overview / agent entry point
├── recent-learning.md                # generated short summary
├── agent-inbox.md                    # task queue
└── AGENTS.md                         # generated agent instructions
```

New files use YAML Properties plus readable Markdown bodies and Obsidian
Wikilinks. Legacy annotation and `MEM-*` files remain readable. The plugin
settings contain six tabs — General, Annotations, Cells, Scenes, Profile, and
Proposals — while the existing annotation dashboard remains available for
high-frequency annotation work.

Agent memory writes default to `direct`. Switch to `confirmation` in settings
to require proposed Cell, Scene, and Profile changes to pass through the
Proposals tab. Preference memory is stored separately and Agent access is
disabled by default.

## Development

Requires Node 22.13+ and pnpm 10.

- `pnpm install` — install dev dependencies (isolated from the parent workspace).
- `pnpm typecheck` / `pnpm test` / `pnpm build` — the gate.
- `pnpm dev` — esbuild watch.
- `pnpm install:dev-plugin -- --vault ../Tutor` — copy the built plugin into a
  dev Vault (defaults to `../Tutor`); the id `annotation-tutor-lite` lets it
  coexist with the full plugin. Then enable it in Obsidian.

## Architecture

Pure, unit-tested logic (no Obsidian imports): `src/model.ts`, `src/ids.ts`,
`src/anchors.ts`, `src/index-table.ts`, `src/markdown/*`. Obsidian-bound layer:
`src/store.ts` (file I/O + self-write loop-guard), `src/watcher.ts`,
`src/decorations.ts`, `src/editor.ts`, `src/settings.ts`, `src/views/*`, and
`src/main.ts` (wiring). Tests live in `tests/`.
