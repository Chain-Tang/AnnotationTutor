# Tutor structured vector runtime

Tutor schema v5 adds a structured, editable vector scene alongside ordinary board objects and immutable ink. Existing v1-v4 documents are upgraded one durable step per save; object IDs, anchors and ink IDs are not rewritten.

## Scene model

- `BoardVectorAsset` is a versioned scene with stable node IDs and a flat parent-linked tree.
- Nodes are typed as groups, paths, shapes, text, content-addressed images or component instances.
- Paths use absolute `M/L/Q/C/A/Z` commands. Pressure ink remains native ink and is not forced into SVG outlines.
- Paint supports solid color, linear/radial gradients and component-backed patterns. Internal clip paths and component references are validated for missing or cyclic references.
- One `BoardObject` of kind `vector` places an asset on an Artboard. The object can be moved and resized without rewriting its internal geometry.

## Safe SVG boundary

Studio's **导入 SVG** action parses XML into the internal scene. Scripts, event attributes, inline CSS, `foreignObject`, animation, filters, external URLs and executable image references are rejected. `<use>` is restricted to document-local references and expanded during import. Paths, transforms, inherited paints, gradients and clip paths are normalized before the asset is accepted.

SVG export is generated from the validated scene rather than replaying source XML. `.tutorboard` archives store independent copies under `vectors/` and `characters/`, with the archive checksum manifest covering them.

## BoardToolRuntime

`DefaultBoardToolRuntime` is host-independent. Every session follows:

1. `beginTransaction` against an Artboard and base revision.
2. Batched typed tool calls (maximum 256 nodes per call).
3. Optional checkpoints and previews.
4. `commit`, or `rollback` without any formal-board mutation.

The runtime caps a session at 5,000 nodes and 50,000 path commands. Each write is applied to a cloned draft and the entire asset is validated before it replaces the previous draft. Studio commits the final asset as one Tutor history transaction.

## Local MCP

The optional desktop MCP bridge is disabled by default. When enabled in Settings → Board AI tool bridge it:

- binds only to a random port on `127.0.0.1`;
- creates an in-memory token for the current plugin session;
- defaults to read-only mode;
- exposes only the typed runtime and transaction lifecycle;
- never exposes JavaScript, shell, DOM or Vault file access.

Copy the generated connection JSON from settings into an MCP client. Use Artboard ID `active` and omit `baseRevision` to open the selected vector asset (or a new isolated scene) from the visible Studio. Commit fails if the board revision changed while the model was working.

## Optional vectorization providers

`SvgVectorizationProvider` adapts an injected trace or semantic SVG service. VTracer WASM, StarVector and OmniSVG remain optional downloads or external companions; no model weights or WASM are bundled into the plugin. Provider output always passes through the safe SVG parser before preview or commit.

