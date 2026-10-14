# Tutor brush material calibration — 2026-09-26

This is a reproducible visual review protocol, not a declaration that the ten brushes are professional-grade. The current Tutor sample is the editable Obsidian board `Agent Memory/boards/BOARD-96284109-9f1a-4fe2-9973-44407bae7bdf.md` in the `/Users/mac/Documents` Vault. Its PNG and SVG siblings are generated from the same v2 stroke snapshots. `scripts/verify-brush-materials.mjs` can regenerate it with `--vault Documents --source 'Agent Memory/boards/BOARD-96284109-9f1a-4fe2-9973-44407bae7bdf.md'`.

## Fixed six-task protocol for each material

Use the same input trajectory, color, size and paper across Tutor and the comparison engine. Repeat at 1× and 2× DPR, with and without pressure and tilt.

1. Fine line: constant low pressure, 200–400 px.
2. Pressure ramp: 0.1 → 1.0 → 0.1, with an abrupt lift.
3. Fast turn: two 90° turns and an S-curve with recorded timestamps.
4. Slow stacking: three passes on the same area.
5. Cross coverage: two orthogonal strokes and a transparent overlap.
6. Surface change: smooth paper, toothy paper and a user-provided texture.

For every natural reference used in scoring, record the original object URL, downloaded original checksum, crop rectangle in original pixels, crop checksum, physical medium, image dimensions, author, source institution, exact rights notice, access date and attribution. A painting photograph is **not** a pressure-sample ground truth. Do not distribute a crop until its individual object page has been checked. No images are bundled in the plugin.

| Tutor material | Reference candidate / role | Rights status |
| --- | --- | --- |
| Pen, fountain | [Raphael, *A Marble Horse*](https://www.nga.gov/artworks/75780-marble-horse-quirinal-hill-recto) and [Zuccarelli, *Landscape with a Bridge*](https://www.nga.gov/artworks/213169-landscape-bridge) — ink edge and hatching | Candidate; confirm downloadable media on each page before cropping |
| Pencil | [Sargent, *Men on a Spar*](https://www.nga.gov/artworks/184307-men-spar) — graphite pressure and paper tooth | NGA object page says downloadable public-domain media |
| Chalk | [Leonardo, *Study of a Madonna*](https://www.nga.gov/artworks/74164-study-madonna-verso) — broken dry mark | NGA object page says public-domain media |
| Crayon | [Bellows, *Street Fight*](https://www.nga.gov/artworks/95318-street-fight-recto) — conté crayon and repeated coverage | NGA object page says downloadable public-domain media |
| Watercolor | [Homer, *On the Sands*](https://www.nga.gov/artworks/64550-sands) and [Turner, *A Yorkshire River*](https://www.nga.gov/artworks/69410-yorkshire-river) — wash edge and glazing | NGA object pages say downloadable public-domain media |
| Sumi | [Kirchner, *Self-Portrait*](https://www.nga.gov/artworks/110412-self-portrait) — brush-and-ink mark; not a claim of Japanese sumi equivalence | NGA object page says downloadable public-domain media; a genuine sumi reference is still needed |
| Oil | [Monet, *Morning Haze*](https://www.nga.gov/artworks/45872-morning-haze) — directional, visible strokes | Candidate; verify the individual media rights/download before cropping |
| Marker, highlighter | User-made analog swatches or authorized CC0 samples — nib edge, consistent flow and self-overlap | No verified natural source yet; do not substitute an unrelated historical painting |

MyPaint's [brush data repository](https://github.com/mypaint/mypaint-brushes) is a CC0 digital comparison source. Its install scripts have a different GPL license, so do not copy them. [NGA Open Access](https://www.nga.gov/artworks/free-images-and-open-access) permits downloaded open-access media for commercial and noncommercial use, but an individual artwork's media availability must be verified. Do not ingest AStro or the gated ink dataset without their required permission.

`references.json` records the first two individually rights-verified source works and their original download URLs. It deliberately does not claim to contain downloaded originals or measured crop regions yet.

## Blind review and promotion gate

Show original-source crop, Tutor v1, Tutor v2 and Krita/MyPaint sample in shuffled order at equal display size. Score edge softness, continuous grain, dry breaks, accumulation, wet edge, bristle direction and tone drift individually (1–5). Record evaluator and comments. The owner must score each material at least 4/5 in an actual illustration before removing its experimental label; protocol success alone is insufficient.

The current one-stroke visual check shows clear differentiation but still exposes weak watercolor wet-edge behavior and limited oil paint body. No blind natural-reference review has yet been run.

## Optional Hokusai engine decision

[Hokusai v0.3.0](https://github.com/reearth/hokusai/releases) is a released MIT/Apache-2.0 Rust/WASM candidate. Its repository describes `.myb` v3 handling, 64×64 fix15 tiles and a reported 188/196 near-parity result against libmypaint; these are upstream claims, not Tutor measurements. Tutor's 512×512 tiles would need an 8×8 tile bridge, checkpoint conversion, color/compositing comparison and version-pinned resource loading. The development host currently lacks `cargo` and `wasm-pack`, so a Tutor-side latency/memory/reopen prototype was not run and the engine is **not** enabled in production. It should only ship if a fixed-version/hash WASM build wins the owner's blind comparison while meeting the same performance limits.

## Implementation status

- v2 Studio brush snapshots and host-independent rendering entry are in place; old unversioned strokes remain v1.
- Tip, grain and paper assets are checksum-verified, decoded on demand, bounded in cache and used by preview, live stroke, replay and export. Missing assets are reported without silently selecting another brush.
- `.tutorbrush` v1 remains readable; v2 supports paper and bounded data-only `.myb` v3 curves. `.tutorboard` includes referenced resource bytes and checksums.
- Six-task natural reference corpus, blind owner scores, multi-hour session and optional WASM performance comparison remain open acceptance gates.

## Measured engineering checks (not a visual-quality score)

- The real Obsidian resource round-trip (`scripts/verify-brush-resources.mjs --vault Documents`) passed for a synthetic tip, grain and paper, including `.tutorbrush` import and `.tutorboard` reopen. These QA assets are not natural-media calibration references.
- The 5,000-object / 500,000-point synchronous sample (`scripts/verify-brush-materials.mjs --vault Documents --source 'Agent Memory/boards/BOARD-96284109-9f1a-4fe2-9973-44407bae7bdf.md' --performance`) measured 2,335 ms for the slowest initial render and 4.0 ms p95 for 119 warm renders on this Mac at 2× DPR. It measures the application draw call; it does **not** establish stylus-to-display p95, 55 FPS under human interaction, or a three-second full reopen. The stress objects lived only in a temporary draft; the QA artwork was restored to 20 objects / 10 ink strokes afterward.
- The material sample PNG shows differentiated marks, but the pencil and chalk are relatively faint on white and watercolor/oil still lack convincing natural-media depth. No material is yet promoted to “professional-grade.” Studio now refreshes the selected brush and pressure-range preview while advanced parameters change.
- `pnpm test` passed 120 files / 1,163 tests; `pnpm exec tsc --noEmit` passed. The current built `main.js` is 4,611,690 bytes, 24,042 bytes above the 4,587,648-byte pre-upgrade development build, below the per-round 100 KiB increment goal.
