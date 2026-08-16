# Scene proposals (agent guide)

Scenes group related memory cells into a higher-level study context. This
document defines how an agent proposes a **typed** scene (`course`, `document`,
or `project`). Topic scenes are derived automatically and must not be authored
by hand.

## When to propose a scene

- **`topic`** — *Do not propose.* The plugin derives one automatically for every
  concept that has two or more cells, and tags it `auto`. Hand-authored or
  proposed `topic` scenes collide with the derived ones.
- **`course`** — a multi-week / multi-concept curriculum the learner is working
  through (e.g. "Linear Algebra MOOC").
- **`document`** — a single source the learner is studying end to end (e.g. one
  paper or book chapter).
- **`project`** — a goal-directed effort that pulls together several concepts
  (e.g. "Build a transformer from scratch").

Everything else (archiving a scene, deleting a profile claim, creating a scene
interactively) is a **user-initiated** action in the plugin UI and does not go
through a proposal.

## Where the file goes

Write one Markdown file per proposal under:

```
<memoryRoot>/proposals/pending/PROP-<slug>.md
```

`<memoryRoot>` defaults to `Agent Memory`. The plugin lists pending proposals in
its settings; the learner approves or rejects each one. On approval the plugin
writes the candidate to its real location and archives the proposal.

## Proposal frontmatter

```yaml
---
schema: 2
kind: proposal
id: PROP-attention-course          # ^PROP-[A-Za-z0-9_-]+$
operation: create                  # create | update
target_kind: scene
target_path: scenes/SCENE-attention-course.md   # ^scenes/SCENE-[A-Za-z0-9_-]+\.md$
status: pending
created_at: 2026-06-07T10:00:00.000Z
# base_sha256: <hash>              # REQUIRED for operation: update (see below)
---
```

Rules the plugin enforces (a proposal that violates any of these is skipped):

- `target_path` must match `^scenes/SCENE-[A-Za-z0-9_-]+\.md$`, contain no `..`
  or leading `/`, and end in `.md`.
- The candidate scene's `id` must equal the `target_path` file stem
  (`SCENE-attention-course` above).
- `operation: create` only applies when no file exists at `target_path`.
- `operation: update` requires `base_sha256` to equal the SHA-256 of the current
  target file; otherwise the proposal is considered stale.

## Candidate body

The candidate scene file is embedded verbatim between two marker comments:

```markdown
## Candidate

<!-- annotation-tutor:proposal-candidate:start -->
---
schema: 2
kind: scene
id: SCENE-attention-course
type: course
status: active
title: Attention & Transformers course
cells:
  - "[[Agent Memory/memory-cells/CELL-attention-001|CELL-attention-001]]"
  - "[[Agent Memory/memory-cells/CELL-attention-002|CELL-attention-002]]"
tags: []
created_at: 2026-06-07T10:00:00.000Z
updated_at: 2026-06-07T10:00:00.000Z
---
# Attention & Transformers course

## Summary

A 6-week course covering attention, transformers, and their training.
<!-- annotation-tutor:proposal-candidate:end -->
```

### Candidate rules

- `schema: 2`, `kind: scene`.
- `type` is one of `topic`, `course`, `document`, `project`. Use anything but
  `topic` for proposals.
- `status` is `active` or `archived`.
- `title` and the `## Summary` body are both required and non-empty.
- `cells` are wikilinks whose ids match `^(?:CELL|MEM)-[A-Za-z0-9_-]+$`. **Every
  referenced cell must already exist** in the memory library — propose the cells
  first (or in the same batch) so the scene never references dangling cells.
- Do **not** add the `auto` tag; it is reserved for derived topic scenes and the
  plugin deletes stale `auto` scenes on every rebuild.

## Checklist

1. Cells you reference already exist under `memory-cells/`.
2. `type` is `course`, `document`, or `project` (never `topic`).
3. `id` matches the `target_path` stem and starts with `SCENE-`.
4. `title` + `## Summary` are filled in; no `auto` tag.
5. For updates, `base_sha256` matches the current file.
