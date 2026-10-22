# Tutor for Codex

Requires Node.js 22+, desktop Obsidian, and Tutor's local MCP service. Obsidian must remain open. This package contains no server address, API key or pairing token.

1. Install the Tutor Obsidian build. Open the documents/canvases to authorize. Enable **Settings → Tutor → Board MCP**. Disable the global read-only switch only if drawing changes are wanted.
2. Install this host plugin in Codex, then start a new Codex task so its MCP and Skills are loaded. Portable `plugin.json` / `mcp.json` are canonical; `.codex-plugin/plugin.json` and `.mcp.json` are generated compatibility files.
3. Ask to connect Tutor. `tutor_instances` lists running vaults; `tutor_connect` opens a pairing dialog **in Obsidian**. Select scope there. Existing pairings are reused. Re-pair when adding documents or selected objects.
4. Use “请教 Tutor”, “结合学习材料作图”, or “交给 Tutor 检查”. Reasoning tasks return immediately with a task ID. Drawing results are drafts until `tutor_commit_change` succeeds.

Use `tutor_diagnose` for connection errors. Stop/revoke clients in Obsidian settings. Closing Obsidian stops the service; do not start another background daemon. A stale scene requires reading and planning again. An uncertain commit should reuse its exact change ID, not invent a new insertion.

The connector stores pairing credentials privately under `~/.local/share/tutor/clients/`. The service stores their hashes. Discovery under `~/.local/share/tutor/instances/` contains only instance identity and loopback port. Never share those credential files or put them in a plugin archive.

Generic MCP clients may run `node /absolute/path/to/tutor/scripts/connector.cjs` as a stdio server. Set `TUTOR_INSTANCE_ID` only when selecting among multiple local vaults. No Claude-specific compatibility claim is made.

The reverse Tutor → Codex workflow is available from Obsidian's **Tutor + Codex collaboration** command. Set the Codex executable in Tutor settings. It uses existing Codex authentication, an ephemeral thread and a temporary working directory; it returns specialist advice/drafts for Tutor to review. It does not modify your current Codex chat or automatically apply expert output.

For ongoing collaboration use **Tutor collaboration spaces** (Tutor 0.6.0+).
Each space has a dedicated persistent Codex conversation, explicit members,
editable Markdown context and a dialogue record. Tutors may initiate requests;
results return to the same space. Pair with the separate communication permission
and have the space owner add your identity. The `tutor_communication_*` tools
expose only authorized spaces. Add `instanceId` per tool call to route concurrent
requests to a fixed vault; omitted IDs retain the selected-vault fallback.
See [the project communication guide](../../docs/communication/README.md).

## Build and rollback

Run `node scripts/build-tutor-plugin.mjs` at repository root. Reinstall the resulting plugin and start a fresh Codex task. To roll back, restore the previous plugin folder and Obsidian installation bundle. Preserve Obsidian `data.json` and Vault drawing data. Existing data stays on format v5.

## Validation scope

See `docs/qa/upgrade-m2/` and `docs/tutor-upgrade-status.md` in the repository. A formal MCP SDK client tested this stdio connector through the real Obsidian pairing/service and live Direct API Tutor. The Codex App Server adapter also returned a real model answer. A fresh ephemeral Codex App Server session is tested separately in `codex-plugin-live.json`; the visible desktop UI remains a separate acceptance item.

The portable MCP file must include its schema identifier; a missing `$schema` makes portable tool discovery fail even if Skills are visible. Large scenes are read in pages; commits return a saved revision rather than an unbounded scene.
