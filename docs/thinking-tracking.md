# Background learning observations

Tutor keeps qualitative observations separately from fixed-question learning evidence, mastery, spaced review, and learner-profile claims. Each vault owns its own `Agent Memory/thinking/` directory. There is no cross-vault or Codex transcript import.

## Input and persistence

The host publishes a `LearningConversationCommit` only after its annotation or chat file has been saved. A commit contains source identity, a content revision, stable turn identities, completion provenance, and the ordinary/private/excluded tracking decision. Legacy transcripts have unknown completion; their presence never proves successful exercise completion. Stopped messages and private/excluded turns act as barriers, so removing them cannot join unrelated messages.

The service backfills eligible saved history on startup and handles future changes incrementally. A single worker yields to foreground Tutor requests. `.state.json` stores queued source references, hashed revisions, checkpoints, record paths, and deletion tombstones; it does not duplicate transcripts. Each `THINK-*.md` stores bounded quotations and structured observations with readable Markdown. Identical authored text does not become additional independent evidence merely because it appears in a sibling branch or copied transcript.

## Depth and breadth as saved activity

Continuing a conversation within the same card and creating a child card are two distinct, source-linked actions. Here “depth” means a saved same-card request or completed followup pair and “breadth” means a saved child relationship or submitted child question. These are operational descriptions of the interface, not claims that a question achieved deeper or broader understanding.

Annotation commits derive navigation snapshots from the files themselves: stable request and user/Tutor turn IDs for same-card followups, and parent/root annotation IDs plus the pinned parent reply identity/version for branches. `.state.json` keeps these references, event identities and authored-question fingerprints separately from the qualitative analyses. There is no click, pointer or drag telemetry. An empty child draft records only `branch-created`; submitting its question adds a separate action, even when answering fails. Same-card submissions likewise retain generating, failed, cancelled or interrupted outcomes as activity only. A matching completed pair replaces that request's pending activity; retries do not create another action. Only persisted user/answer pairs enter reasoning analysis. A completed outcome proves persistence, not successful comprehension. Identical authored fingerprints remain one reasoning sample even when several interface actions are recorded.

The analyst receives a bounded snapshot of the current saved branch family (at most twelve cards and the latest four non-creation actions per card). These sample counts are not vault-wide totals or preference scores. Accepted analyses preserve that snapshot and its source links. New actions can extend the history without rewriting older snapshots; editing, excluding or deleting an action used by a snapshot invalidates the dependent analysis and teaching summary. Private, excluded, deleted and missing sources are removed from the activity map; each worker remains confined to its own vault.

Navigation can help frame tentative questions about a learning strategy alongside the learner's actual words. Any interpretation must also consider the current task, unfamiliar terminology, Tutor explanation quality, deliberate exploration and interface convenience. A count alone cannot establish a fixed thinking tendency, personality, learning success or a personal neural cause. Empty drafts never trigger a model analysis on their own.

An analysis result is accepted only after schema validation, exact user-quotation checks, and another read of the source revision. Source changes hide the teaching projection synchronously. Reconciliation invalidates observations whose evidence changed, disappeared, or became excluded. Unrecorded conversations never create shadow logs. Executed support decisions carry a trusted private flag, rather than relying on keyword guesses.

## Analysis boundaries

Records distinguish observations, explicit self-reports, causal hypotheses, counterevidence, general mechanisms, and discriminating exercises. Life, work, and language practice remain possible causes until supported by actual user evidence. Alternative explanations include unfamiliar terminology, translation, task demands, deliberate disagreement, and inadequate Tutor explanation. Exercises describe competing predictions; unreported outcomes are not fabricated.

General semantic-control research can explain why task context affects conceptual retrieval ([Whitney et al., 2011](https://pmc.ncbi.nlm.nih.gov/articles/PMC3077429/)). It cannot identify a particular learner's neural cause. Reverse inference has further limits ([Poldrack, 2006](https://brainmapping.org/NITP/PNA/Readings/Poldrack2006.pdf)). Version 1 uses text, self-reports and exercises; it neither records audio nor infers speech speed or fixed personality from language.

## Teaching and user controls

`LearningInsightContext` provides a bounded, relevant summary to annotation review, ordinary chat and board teaching. Only observations, teaching suggestions, optional exercises, and user corrections enter that projection; causal hypotheses are not flattened into facts. Tutor adapts silently, without proactive scores, labels, profile panels or analysis cards.

Settings allow pausing analysis, excluding a source ID/file/folder, inspecting Markdown, correcting an observation, and deleting it. A correction replaces the previous inference in teaching context. Deletion records a tombstone so the identical evidence is not silently re-created on the next history scan.

## Verification

`tests/learning-insight.test.ts` covers history backfill, restart/checkpoints, deduplication, source invalidation, exclusions, foreground preemption, malformed evidence, corrections, deletion, and private/stopped barriers. It also verifies stable depth/breadth activity, draft/submission separation, retry deduplication, navigation-source invalidation and vault isolation. Chat-log and Tutor-conversation tests cover stable identities, unknown legacy completion, source metadata, and trusted support classification.
