---
name: ask-tutor
description: Ask the independent Tutor agent to teach or explain using documents explicitly authorized in Obsidian.
---
Use `tutor_diagnose` first. If pairing is missing, call `tutor_instances` then `tutor_connect`; the user selects scope in Obsidian. Never read tokens, the vault directory or plugin settings to bypass pairing.
List authorized documents. Read only the context needed, then call `tutor_start_task` with the chosen source, the learner's question and a unique idempotency key. Query `tutor_task_status` or `tutor_task_events` for progress; do not resubmit a task whose result is uncertain. Cancel with `tutor_cancel_task` when asked.
The host Agent remains the lead; Tutor supplies its own teaching response. Summarize its answer, preserving uncertainty and distinguishing it from your own judgment. Do not claim a reply was saved to learning memory. The memory tool is read-only.
