---
name: draw-with-tutor
description: Collaborate with Tutor to create or precisely edit a diagram on an authorized Obsidian board, Studio or Excalidraw drawing.
---
Connect using `tutor_diagnose` / `tutor_connect`. List surfaces and read the chosen scene. Bind its stable target ID and exact revision; switching the active window never changes the target. If no target is authorized, ask the user to open it and re-pair with that scope.
For semantic drawing, call `tutor_start_task` with the target ID and a unique key. Tutor returns a changes artifact, not an already saved drawing. Inspect the task result, and use `tutor_preview_change` to review it. Apply a valid result with `tutor_commit_change`. An already authorized drawing request does not require per-stroke confirmation.
For direct object editing, use `tutor_begin_change`, the typed operation schemas, and `tutor_commit_change`. Only modify explicitly authorized selected objects or your own additions. Do not issue arbitrary JavaScript, rewrite Excalidraw compressed files, infer character parts from a bitmap, or replace an entire drawing to change one element.
On a conflict, read the scene and re-plan; never blindly resend with a new ID. Preserve the exact change ID for an uncertain commit. Stop on cancellation. Reference-image generation currently requires the Studio candidate workflow; report that boundary instead of claiming success.
