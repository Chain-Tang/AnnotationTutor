# 🎓 Annotation Tutor

<p align="center">
  <img src="Screenshots/Screenshot 2026-06-08 033945.png" alt="Annotation Tutor Dashboard" width="800">
</p>

<p align="center">
  <b>Turn Obsidian learning annotations into local, agent-readable learning memory.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.13.0-blue?logo=node.js" alt="Node.js Version">
  <img src="https://img.shields.io/badge/pnpm-%3E%3D10-orange?logo=pnpm" alt="pnpm Version">
  <img src="https://img.shields.io/github/actions/workflow/status/Chain-Tang/PriveTutor/ci.yml?branch=main&label=build&logo=github" alt="Build Status">
  <img src="https://img.shields.io/github/stars/Chain-Tang/PriveTutor?style=social" alt="GitHub Stars">
</p>

---

## 🌟 Overview

**Annotation Tutor** is a powerful tool for learners who use Obsidian. It bridges the gap between manual note-taking and AI-assisted learning by turning your Markdown annotations into a structured "Learning Memory" that local agents (like OpenCode or Codex) can understand and review.

### Key Features

- 📝 **Smart Annotations**: Select text, write explanations, and tag them for review.
- 🤖 **Agent Integration**: Seamlessly connect with authenticated **OpenCode** or **Codex** for deep reviews.
- 📂 **Dual Implementations**:
  - **Full MVP**: Complete with sidecar JSON, SQLite/FTS index, REST/MCP servers, and a CLI.
  - [**TutorLite**](TutorLite/README.md): A lightweight, Markdown-only version for quick use without server dependencies.
- 🔍 **Local-First**: All data stays on your machine. Authoritative JSON and Markdown files with a rebuildable SQLite index.

---

## 🔌 Get the plugin (Annotation Tutor Lite)

The fastest way in is the **Lite** plugin — a single, self-contained Obsidian
plugin with **no server, SQLite, or required API key**. Pull it straight from this
repo and build it:

```bash
git clone https://github.com/Chain-Tang/PriveTutor.git
cd PriveTutor/TutorLite
pnpm install
pnpm build                                          # -> dist/main.js
pnpm install:dev-plugin -- --vault "C:\path\to\YourVault"
```

The last command copies `manifest.json`, `main.js`, and `styles.css` into
`<YourVault>/.obsidian/plugins/annotation-tutor-lite/`. Then open Obsidian, enable
**Annotation Tutor Lite** under *Settings → Community plugins*, and reload
(`Ctrl/Cmd+R`). To install by hand instead, copy those three files yourself
(`main.js` is `dist/main.js` renamed).

**Connect OpenCode:** in *Settings → General*, set the engine to **OpenCode** and
make sure the [`opencode`](https://opencode.ai) CLI is installed and logged in —
the plugin drives your already-authenticated CLI directly, so no API key is
stored. Prefer a direct API? Choose **API** (defaults to DeepSeek). Full details
in [**`TutorLite/README.md`**](TutorLite/README.md).

---

## 🏗️ Architecture

```text
domain -> core -> service -> apps/obsidian-plugin
                |       \-> apps/cli
                +-> mcp
                +-> agent-bridges

ui ---------------------> apps/obsidian-plugin
```

- **`packages/domain`**: Zod schemas and core domain types.
- **`packages/core`**: Storage, indexing (SQLite/FTS), and document access control.
- **`packages/service`**: REST and MCP handlers serving the same application logic.
- **`packages/mcp`**: Tools for AI agents to interact with your learning vault.
- **`packages/ui`**: Shared React components for the dashboard and editor.

---

## 🚀 Full MVP (server + CLI)

> Most users want the **Lite** plugin above. This section is for the full,
> server-backed MVP (REST/MCP server, SQLite index, and CLI).

### Prerequisites

- **Node.js**: >= 22.13.0
- **pnpm**: >= 10
- **Obsidian**: Desktop version

### Installation

1. **Clone and Install Dependencies**:
   ```bash
   git clone https://github.com/Chain-Tang/PriveTutor.git
   cd PriveTutor
   pnpm install
   ```

2. **Setup Development Plugin**:
   ```bash
   pnpm install:dev-plugin
   ```

3. **Open in Obsidian**:
   - Open the `Tutor` folder as an Obsidian Vault.
   - Enable the **Annotation Tutor** community plugin.
   - Reload Obsidian after the build finishes.

---

## 💻 CLI Usage

The standalone CLI provides administrative tools for your vault:

```bash
# Check vault health
node apps/cli/dist/index.js doctor --vault Tutor

# Start the service
node apps/cli/dist/index.js start --vault Tutor

# Rebuild the search index
node apps/cli/dist/index.js rebuild-index --vault Tutor
```

---

## 📊 Project Status

The core MVP is substantially complete with automated tests. We are currently in the **Acceptance Testing** phase for real Obsidian environments.

For more details on features and roadmap, see [**`docs/project-status.md`**](docs/project-status.md).

---

<p align="center">
  Built with ❤️ for the Obsidian Community.
</p>
