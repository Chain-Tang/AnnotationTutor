# HANDOFF — Annotation Tutor Lite

A handoff for the next agent/maintainer taking over this project. Read this before
making changes or cutting a release.

## 1. What this project is

**Annotation Tutor Lite** (`annotation-tutor-lite`) is a standalone, desktop-only
**Obsidian plugin**: you highlight a passage, write what you think it means, and an AI
tutor reviews it, distills durable **memory cells**, auto-groups them into **scenes**,
resurfaces them on a spaced-repetition schedule (SM-2), and weaves them into a readable
**notebook** — plus inline / full-document **translation**. Learning memory is Markdown in the user's Vault. Private support data and credentials
use separate protected storage; no API key is baked into the code.

- **Repo:** `Chain-Tang/AnnotationTutor` (this repo *is* the plugin — it was a
  monorepo until the standalone restructure; the old full project is only in git history).
- **Current local source:** `manifest.json` / `package.json` are **0.7.7** (2026-10-22).
  Recovery reconstructs the engineering baseline at `95ffe399` and its saved
  0.7.7 working files; it does not publish a release or update installed Vaults.
  Check the actual branch and working-tree status before making changes. See the
  [recovery report](docs/project-recovery-2026-10-22.md) for verification results and
  the [assessment](docs/project-assessment-2026-10-22.md) for the pre-recovery state.
  Remote release status must be checked separately. This remains a development
  candidate, not complete commercial acceptance.
  See [implementation status](docs/qa/implementation-status-20261012/report.md) and
  [optimization verification](docs/optimization-verification-2026-10-14.md) and
  [second-stage/source archive](docs/optimization-stage2-2026-10-14.md).
- **Runtime:** runs inside Obsidian's bundled Electron/Node runtime — **end users do NOT
  install Node.js**. It's desktop-only because it uses Node APIs (spawning a CLI, fs).

## 2. Project composition

```
.                              ← repo root = the plugin
├── manifest.json              # Obsidian plugin manifest (id, version, author, minAppVersion)
├── styles.css                 # all plugin CSS (Obsidian theme tokens)
├── package.json               # scripts + deps (private; not published to npm)
├── pnpm-workspace.yaml        # `packages: []` — keeps this a standalone single package
├── pnpm-lock.yaml             # lockfile (commit it)
├── tsconfig.json              # strict TS (noUncheckedIndexedAccess, noImplicitOverride)
├── vitest.config.ts           # node env, globals, tsconfig path resolution
├── .github/workflows/ci.yml   # CI: pnpm install/typecheck/test/build on Win+macOS+Linux
├── docs/guide.md              # deep learning-model reference (linked from README)
├── PrivTutor Lite MVP Design Spec.md   # original product baseline (historical)
├── README.md                  # English usage, development and installation guide
├── README.zh-CN.md            # Simplified Chinese guide
├── scripts/
│   ├── build.mjs              # platform entry + desktop/mobile bundles (`--watch` for dev)
│   ├── package.mjs            # build plugin/extension + seal complete release folder/ZIP
│   └── install-dev-plugin.mjs # verify, back up, install and check one explicit Vault
├── src/
│   ├── (pure, unit-tested — no `obsidian`/`@codemirror/view` runtime import)
│   │   model.ts, ids.ts, anchors.ts, srs.ts, memory-derive.ts, learning.ts,
│   │   index-table.ts, decorations-plan.ts, settings-config.ts, i18n.ts,
│   │   translate.ts, pretranslate.ts, reading-highlight.ts, agent-runner.ts, markdown/*
│   └── (Obsidian/CM6-bound)
│       main.ts (wiring), store.ts (file I/O + self-write guard), watcher.ts,
│       decorations.ts, margin-rail.ts, reading-rail.ts, margin-card.ts, editor.ts,
│       settings.ts, views/*, *-controller.ts, acp-runner.ts/acp-session.ts (OpenCode
│       over ACP), api-runner.ts (Direct API)
└── tests/                     # Vitest; current counts in the dated verification report
```

**Two engines** (chosen in Settings → engine):
- **Direct API** (default): OpenAI-compatible HTTP, no subprocess. Key stored in the
  system-encrypted storage outside the Vault (configuration contains references);
  if secure storage is unavailable, new credentials are session-only.
- **OpenCode**: spawns the user's already-authenticated `opencode` CLI over ACP. No key
  stored. The plugin augments `PATH` so the CLI resolves even when Obsidian is launched
  from the GUI.

**Two distinct "agent" roles** — don't confuse them:
- The **engine** above powers in-plugin reviews/translation/chat (self-contained prompts).
- `Agent Memory/` + `AGENTS.md` are generated *in the user's Vault* so an **external**
  agent (Claude Code/OpenCode/Codex) can read/extend the learning memory. Auto-created on
  first plugin load (`store.ensureScaffold()`); never shipped in the download.

## 3. What goes to GitHub vs what must NOT

**Commit & push (source of truth):**
- Everything under `src/`, `tests/`, `scripts/`, `docs/`
- `manifest.json`, `styles.css`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `tsconfig.json`, `vitest.config.ts`, `.github/`, both READMEs, the design spec, this file.

**Never commit (gitignored — see `.gitignore`):**
- `node_modules/` — dependencies (reinstall with `pnpm install`).
- `dist/` — **build output, including the compiled `main.js` and the release ZIP.** These
  are NOT in the repo; they ship via GitHub Releases only.
- `*.tsbuildinfo`.
- `coverage/` and machine-local audit/recovery outputs listed in `.gitignore`.
- `Tutor/` — a **local dev Vault** (test data + an installed copy of the plugin). It may
  exist on the current machine; it must not enter the repo.

**Never commit, ever (secrets):**
- No provider API keys or credentials belong anywhere in the repo. The user's Direct-API
  credentials are encrypted outside the Vault in the current candidate. Historical
  `data.json`, backups or sync history may contain old plaintext; never commit them.
  OpenCode uses the user's own authenticated CLI.

**Release assets (uploaded to a GitHub Release, NOT committed):**
- `annotation-tutor-lite-<version>.zip` (extracts to a `annotation-tutor-lite/` folder)
- Complete sealed plugin folder/ZIP: the entry requires `desktop.js` or `mobile.js`,
  compatibility metadata, offline fonts and dependency licenses. Do not install only
  the three conventional Obsidian files.
- ⚠️ GitHub auto-attaches "Source code (zip/tar.gz)" to every release — those are the dev
  source with **no compiled plugin runtime**. Tell users to download the named `…-<version>.zip`
  asset, not the source archives.

## 4. How to accept the work (verify it builds and runs)

Prereqs: **Node.js 22.13+** and **pnpm 10** (only for development — not for end users).

```bash
git clone https://github.com/Chain-Tang/AnnotationTutor.git
cd AnnotationTutor
pnpm install --frozen-lockfile
npm --prefix extension ci
pnpm typecheck
pnpm test                 # CI uses test:coverage on Linux
pnpm test:release
pnpm package              # builds plugin and extension, then seals the release
pnpm package:verify
```

Passing a previous dated report is not acceptance of the recovered tree. Record
the commands, results, build identity and remaining host checks in the recovery
report. `pnpm typecheck` also checks production sources, extension types, scripts
and interface-language parity.

Run it in a real Vault and smoke-test:

```bash
pnpm install:vault -- --vault "/absolute/path/to/a/test/Vault"
```

The default online installer currently uses the macOS Obsidian CLI. It verifies
the program and credential compatibility, asks the running plugin to save and
stop, backs up the installation, replaces it transactionally, then reloads the
plugin and checks its version. A busy task or failed save blocks the upgrade.
Keep the printed backup path. For offline installation, fully exit Obsidian
first, add `--offline`, then start Obsidian and check loading manually; offline
success only confirms filesystem checks. Other platforms need this offline path
or a separately validated host entry. See [upgrade and rollback](docs/tutor-learning-upgrade.md).

Then in the test Vault:
1. Confirm an `Agent Memory/` folder + `AGENTS.md` were auto-created in the Vault.
2. Settings → pick an engine (Direct API + a key is the zero-dependency path).
3. Select text → `Ctrl/Cmd+Shift+L` → write a note → ask the tutor to review.
4. Check the margin comment card, the highlight-as-toggle, and the connector.
5. `Alt+T` inline translation (works in both editing and Reading view).
6. Build the notebook; review a due cell.

## 5. How to cut a release

Work on a reviewed branch and explicit commit/tag. Do not publish while restoring
the repository, and do not assume local validation has run merely because these
commands are documented.

```bash
# 1. Bump the version in BOTH manifest.json and package.json (keep them in sync).
# 2. Review changes and run every acceptance command in section 4.
# 3. Commit the reviewed changes on the working branch; verify CI for that commit.
# 4. Build and verify the complete assets (portable ZIP paths).
pnpm package          # → dist/annotation-tutor-lite-X.Y.Z.zip + dist/release/<id>/*
pnpm package:verify   # → dist/package-verification.json
# 5. When publishing is intended, replace REVIEWED_COMMIT and notes.md explicitly.
gh release create vX.Y.Z --draft \
  --repo Chain-Tang/AnnotationTutor --target REVIEWED_COMMIT \
  --title "Annotation Tutor Lite vX.Y.Z" --notes-file notes.md \
  dist/annotation-tutor-lite-X.Y.Z.zip \
  dist/package-verification.json
# 6. Verify the draft tag, commit, release notes and assets before publication.
gh release view vX.Y.Z --repo Chain-Tang/AnnotationTutor --json tagName,isDraft,assets
```
Check the current `gh` authentication and target repository instead of assuming a
machine-specific executable path or signed-in account. The sealed ZIP is the
installation unit; three standalone conventional plugin files are incomplete.

## 6. Conventions & gotchas (don't regress these)

- **Commit identity:** `Chain <chain2423408957@gmail.com>`. **Never** add a Claude
  co-author trailer. Use a `codex/` working branch and review the complete diff;
  do not infer permission to push `main` from this handoff.
- **Run pnpm at the repo ROOT** (this used to be a monorepo subdir — it isn't anymore).
- **Tests:** pure modules use normal Vitest tests. Board DOM tests use `happy-dom`
  with a scoped Obsidian mock; editor tests use real CM6 states, views and
  transactions, with geometry supplied for the headless DOM. GUI acceptance is
  recorded separately and cannot be inferred from these geometry fixtures.
- **The release ZIP must use forward-slash paths.** `package.mjs` writes the ZIP in pure
  Node for this reason — do NOT switch back to PowerShell `Compress-Archive` (it writes
  backslash entry names that break extraction on macOS/Linux).
- **Engine settings must always render** (engine picker + API key + OpenCode config) — they
  were once hidden behind the off-by-default "Auto-run agent" toggle; don't re-gate them.
- **Cross-platform matters:** several modules special-case Windows (CLI lookup, quoting,
  PATH). CI runs Win/macOS/Linux; keep it green.
- Strict TS; UI strings go through `t()` in `i18n.ts` (en / zh-cn / zh-tw / ja).

## 7. Historical implementation notes / open items

The dated results below describe their original snapshots. They are not test or
desktop-acceptance results for the recovered 0.7.7 tree; consult the recovery
report for the current verification record.

- **2026-09-12 inspiration board v3:** vertical drawing rail and tool property
  popover; one plugin-owned Tutor conversation for sidebar and board, sharing the
  chat engine/model/history. Closing the sidebar keeps the turn alive and shows
  its latest reply in a movable handwritten caption; only explicit pinning saves
  that caption. Cmd/Ctrl+Alt+L opens a transient board composer (Shift+L remains
  the existing annotation shortcut). Direct SSE and
  ACP updates drive validated transient vector previews; only a completed turn
  enters board history as one transaction. Cancellation discards previews.
  Font subsets load on demand per window, derived text heights preserve undo,
  queued saves coalesce, and the ACP board session stays warm between turns.
  Typecheck, 808 tests across 75 files, build, and full ZIP checks pass. Live DeepSeek API first
  reply/preview/finish: 3.323/3.647/3.973 s; live OpenCode: 90.349/91.300/92.191 s
  (single cold run, still slow). See [v3 acceptance](docs/qa/board-v3/README.md)
  for real desktop checks and remaining limitations. Legacy board-specific model
  settings remain readable but the current UI uses the shared chat settings.
- **2026-09-12 inspiration board v2:** Markdown Live Preview/source/reading share
  stable transaction-mapped anchors and v2 migration with permanent v1 backup.
  Icon tools, editable handwritten text, seeded Rough.js shapes, expression assets,
  visual groups, CM readiness/IME guards and shared-source request coordination are
  implemented. Bundle the complete ZIP, including `assets/fonts/` (216 offline
  Excalifont/Xiaolai WOFF2 subsets and licenses); a three-file install is insufficient.
  Typecheck, 710 tests across 72 files, build and package pass. Real Direct/ACP
  v2 protocol validation and desktop editor/text/sticker/diagram interactions passed;
  see [current acceptance and remaining manual checks](docs/inspiration-board.md).
- **2026-09-12 inspiration board implementation:** desktop Markdown/PDF overlays,
  durable ink/history, regional Electron capture, Direct API + ACP drawing, and
  versioned characters are implemented. See [usage and acceptance evidence](docs/inspiration-board.md)
  for verified behavior and the remaining host checks. Pad and recognition remain future work.
  Final local checks: typecheck, 637 tests across 69 files, build and package pass.
  Real OpenCode and Direct API vision requests passed; Markdown/PDF co-drawing and
  split-view sharing were exercised in Obsidian 1.13.7. Popout visual round-trip
  and the remaining full manual acceptance cases are explicitly tracked in the guide.
- **2026-09-11 product direction:** start with [Next development: Pad & collaborative
  drawing](docs/next-development-plan.md). The two tracks share an ink/drawing foundation:
  Pad handwriting recognition, and human–Tutor drawing over Markdown/PDF with contextual
  observation and expressive doodles. Tutor characters may be built in, uploaded by the
  learner, or co-created; both minimal and fixed original styles are supported directions.
  This records the original design proposal; the board implementation is described above. Read current code and the
  manifest for implementation/version status; older snapshots in this handoff are historical.
- **README images:** the current hero is an AI-generated concept illustration,
  not a desktop acceptance screenshot. Keep that distinction when adding images.
- **`LICENSE`** — MIT (`Copyright (c) 2026 Chain`); `package.json` carries `"license": "MIT"`. The project is open source.
- **No `CLAUDE.md`** (the monorepo one was removed). Run `/init` to regenerate a
  Lite-focused one if desired.
- **Contributor graph:** git history has a stray `Your Name <you@example.com>` on 2 early
  commits (no Claude anywhere). Cleaning it needs a history rewrite + force-push — only with
  the owner's explicit go-ahead.
