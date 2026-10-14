# Credits

## Textures

The built-in **Sticky note** and **Leaf** card skins use real photographic
textures from [ambientCG](https://ambientcg.com), released under
**CC0 1.0** (public domain):

- **Paper005** — manila paper surface (sticky note).
- **Leaf001** — photographed leaf (leaf skin).

CC0 places no obligation on us, but we credit the source gratefully. The images
are downscaled and re-encoded; the originals are available at ambientcg.com.

## Libraries

- [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) — MIT —
  the official, separately installed browser extension used by Tutor's versioned
  capture template. Tutor does not vendor or fork its source code.

- [vanilla-tilt.js](https://github.com/micku7zu/vanilla-tilt.js) — MIT — the GPU
  3D tilt + glare on the textured skins.
- [perfect-freehand](https://github.com/steveruizok/perfect-freehand) — MIT —
  pressure- and velocity-aware editable stroke outlines.
- [RBush](https://github.com/mourner/rbush) — MIT — per-anchor spatial indexing
  for viewport culling, hit testing, lasso selection, and erasing.
- [Rough.js](https://github.com/rough-stuff/rough) — MIT — deterministic
  hand-drawn geometry used by sketch-style board objects.
- [fflate](https://github.com/101arrowz/fflate) — MIT — compact, local ZIP
  support for `.tutorbrush`, OpenRaster, and editable `.tutorboard` files.

## Tutor host integration

- `@modelcontextprotocol/sdk` 1.30.0 — MIT, official Model Context Protocol TypeScript SDK. Used by the local service and bundled stdio connector. Its dependency notices are included in the host plugin distribution.
- Excalidraw integration uses the installed Obsidian Excalidraw plugin's public Automate and scene APIs; Excalidraw itself is not bundled in Tutor.
- Codex App Server integration uses the local user's existing Codex installation and authentication. Tutor does not bundle Codex or copy its credentials.
