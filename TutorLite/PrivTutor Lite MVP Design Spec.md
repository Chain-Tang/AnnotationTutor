

## 1. Project Name

**Annotation Tutor**

## 2. One-line Description

Annotation Tutor is an Obsidian plugin that lets users create learning annotations directly inside Markdown documents, stores agent-readable memory files inside the current Obsidian Vault, and maintains a lightweight index table for fast navigation and synchronization.

## 3. Core Idea

The system has three layers:

```text
1. Source Markdown Layer
   用户正在阅读的原始 Markdown 文档。

2. Annotation Memory Markdown Layer
   插件在当前 Vault 内创建的学习记忆 Markdown 文件。

3. Plugin Index Layer
   插件维护的一张轻量索引表，用于快速查找、跳转、刷新和校验。
```

The user interacts only inside Obsidian.

Agents such as OpenCode, Codex, and Claude Code can read and update the Markdown memory files directly.

The plugin watches those files and renders the latest annotation and review state back inside Obsidian.

---

# 4. Design Principles

## 4.1 Obsidian-first

The user should not need to switch repeatedly between Obsidian and another tool.

The plugin must support:

- Reading source Markdown
    
- Selecting text
    
- Creating annotations
    
- Writing personal understanding
    
- Asking an agent
    
- Viewing agent feedback
    
- Jumping between annotation and source text
    

inside Obsidian.

## 4.2 Markdown-native

All durable learning data should be stored as Markdown files inside the current Vault.

This makes the data:

- User-visible
    
- Agent-readable
    
- Git-friendly
    
- Sync-friendly
    
- Portable
    
- Easy to edit manually
    

## 4.3 File-based Agent Protocol First

MVP should not require:

- Model API key
    
- Database server
    
- REST API
    
- MCP server
    
- Cloud account
    
- Vector database
    

Agents communicate through files.

The plugin writes annotation and task Markdown files.

The agent reads those files, optionally reads source Markdown files, and writes results back.

## 4.4 Index for Speed, Markdown for Truth

The Markdown files are the source of truth.

The plugin index table is only for speed and navigation.

If the index is lost or corrupted, it must be rebuildable from the Markdown memory files.

## 4.5 Beginner-friendly

The user should see simple actions:

- Add annotation
    
- Write my understanding
    
- Ask Agent
    
- View review
    
- Jump to source
    

The user should not be forced to understand:

- MCP
    
- API
    
- JSON
    
- SQLite
    
- Model provider
    
- Prompt engineering
    

---

# 5. MVP Scope

## 5.1 MVP Must Include

1. Obsidian plugin.
    
2. Create annotation from selected Markdown text.
    
3. Insert or associate an anchor with the selected text.
    
4. Create agent-readable Markdown files under the current Vault.
    
5. Maintain a plugin-side index table for all created memory Markdown files and annotations.
    
6. Show a global annotation dashboard.
    
7. Click annotation to jump to source Markdown position.
    
8. Ask Agent by writing a task into a Markdown inbox file.
    
9. Let Agent write review results back into Markdown memory files.
    
10. Plugin detects changed memory files and refreshes the Obsidian UI.
    
11. User can view annotation, user note, agent review, and related memory cell inside Obsidian.
    

## 5.2 MVP Should Not Include

1. REST API.
    
2. MCP server.
    
3. SQLite requirement.
    
4. Cloud sync.
    
5. Direct model API.
    
6. Learning scoring system.
    
7. Mascot skin marketplace.
    
8. Mobile client.
    
9. Vector database.
    
10. Complex knowledge graph.
    

These can be added later.

---

# 6. Vault File Structure

The plugin creates files inside the currently opened Obsidian Vault.

Default root directory:

```text
Agent Memory/
```

Recommended structure:

```text
Vault/
├── Papers/
│   └── Attention is All You Need.md
│
├── Agent Memory/
│   ├── annotation-memory.md
│   ├── agent-inbox.md
│   ├── recent-learning.md
│   └── index.md
│
└── .obsidian/
    └── plugins/
        └── annotation-tutor/
            ├── data.json
            └── index.json
```

## 6.1 User-visible Markdown Files

### `Agent Memory/annotation-memory.md`

Main memory file.

Contains:

- Agent instructions
    
- Recent learning summary
    
- Memory cells
    
- Annotation index
    
- Agent review results
    

### `Agent Memory/agent-inbox.md`

Task queue for agents.

The plugin writes pending agent tasks here.

Agents read tasks and write back completion status.

### `Agent Memory/recent-learning.md`

Short learning summary for agents.

This file can be updated by the plugin or agent.

### `Agent Memory/index.md`

Human-readable index of created memory files and annotation groups.

This is optional but recommended for transparency.

## 6.2 Plugin-internal Files

### `.obsidian/plugins/annotation-tutor/data.json`

Stores plugin settings.

### `.obsidian/plugins/annotation-tutor/index.json`

Stores the lightweight index table.

This is not the source of truth.

It can be rebuilt.

---

# 7. Core Data Model

## 7.1 Annotation

An annotation is a user note anchored to a source Markdown text span.

Fields:

```ts
type Annotation = {
  id: string;
  sourceFile: string;
  anchor: string;
  selectedText: string;
  userNote: string;
  status: "draft" | "saved" | "agent_requested" | "reviewed" | "archived";
  relatedMemoryCells: string[];
  createdAt: string;
  updatedAt: string;
};
```

## 7.2 Agent Review

Agent review is feedback written by OpenCode, Codex, Claude Code, or another agent.

Fields:

```ts
type AgentReview = {
  source: "opencode" | "codex" | "claude-code" | "manual" | "unknown";
  correctness: "correct" | "partially_correct" | "incorrect" | "uncertain";
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestedRevision?: string;
  socraticQuestion?: string;
  createdAt: string;
};
```

## 7.3 Memory Cell

A memory cell is a compressed long-term learning summary created from one or more annotations.

Fields:

```ts
type MemoryCell = {
  id: string;
  concept: string;
  domain?: string;
  status: "new" | "partially_understood" | "stable" | "needs_review";
  summary: string;
  sourceAnnotations: string[];
  agentGuidance?: string;
  lastUpdated: string;
};
```

## 7.4 Index Record

The plugin index table tracks where each annotation and memory file exists.

Fields:

```ts
type IndexRecord = {
  annotationId: string;
  memoryFile: string;
  sourceFile: string;
  anchor: string;
  status: string;
  concepts: string[];
  relatedMemoryCells: string[];
  createdAt: string;
  updatedAt: string;
};
```

---

# 8. Markdown File Format

## 8.1 `annotation-memory.md`

Recommended format:

```md
# Annotation Memory

> This file is maintained by Annotation Tutor.
> Agents may read and update specific sections.
> Do not delete user-authored notes.

## Agent Instructions

When helping the user with learning:

1. Read this file first.
2. Use Memory Cells to understand the user's learning state.
3. Use Annotation Index to locate source documents.
4. Open source Markdown files only when needed.
5. Do not overwrite User Note sections.
6. Write review results under Agent Review.
7. Prefer appending over rewriting.
8. If a durable insight appears, create or update a Memory Cell.

---

## Recent Learning Summary

- Current topics:
  - TBD

- Active confusions:
  - TBD

- Suggested agent behavior:
  - Ask the user to explain first.
  - Correct misunderstandings gently.
  - Cite annotation ID and source file when giving feedback.

---

## Memory Cells

### MEM-YYYYMMDD-001: Example Concept

<!-- annotation-tutor:memory-cell:start MEM-YYYYMMDD-001 -->

- Concept: Example Concept
- Domain: Example Domain
- Status: new
- Source annotations:
  - ANN-YYYYMMDD-001
- Summary:
  TBD
- Agent guidance:
  TBD
- Last updated: YYYY-MM-DD

<!-- annotation-tutor:memory-cell:end MEM-YYYYMMDD-001 -->

---

## Annotation Index

### ANN-YYYYMMDD-001

<!-- annotation-tutor:annotation:start ANN-YYYYMMDD-001 -->

- Source file: `Papers/example.md`
- Anchor: `^ann-YYYYMMDD-001`
- Status: saved
- Created at: YYYY-MM-DDTHH:mm:ss
- Updated at: YYYY-MM-DDTHH:mm:ss
- Related memory cells:
  - None

#### Selected Text

> Example selected text.

#### User Note

> User's own understanding.

#### Agent Review

<!-- Agent may write here. Do not edit User Note. -->

#### Review History

<!-- Agent or plugin may append older review entries here. -->

<!-- annotation-tutor:annotation:end ANN-YYYYMMDD-001 -->
```

## 8.2 Protected Sections

The plugin should protect these sections conceptually:

```text
User Note
Selected Text
Source file
Anchor
Annotation ID
```

Agents may write to:

```text
Agent Review
Review History
Memory Cells
Recent Learning Summary
Agent guidance
```

Agent instructions must clearly state:

```text
Do not overwrite User Note.
Do not delete annotation blocks.
Prefer appending over rewriting.
```

---

# 9. Source Markdown Anchor Design

When the user creates an annotation, the plugin associates the selected text with an anchor.

Example source Markdown:

```md
Multi-head attention allows the model to jointly attend to information from different representation subspaces. ^ann-20260606-001
```

Alternative visual form:

```md
==Multi-head attention allows the model to jointly attend to information from different representation subspaces.== ^ann-20260606-001
```

The plugin should support at least one stable anchor strategy.

Recommended MVP strategy:

```text
Use Obsidian block IDs:
^ann-YYYYMMDD-NNN
```

The plugin should also store selected text in `annotation-memory.md` so that anchor repair is possible.

---

# 10. Plugin Index Table

## 10.1 Purpose

The index table lets the plugin quickly display all annotations without reparsing all Markdown files every time.

It should support:

- Annotation dashboard
    
- Jump to source
    
- Status filter
    
- Concept filter
    
- Agent review detection
    
- Rebuild from Markdown
    

## 10.2 Location

Recommended MVP storage:

```text
.obsidian/plugins/annotation-tutor/index.json
```

Alternative future storage:

```text
SQLite
```

But SQLite is not required for MVP.

## 10.3 Example `index.json`

```json
{
  "version": 1,
  "records": [
    {
      "annotationId": "ANN-20260606-001",
      "memoryFile": "Agent Memory/annotation-memory.md",
      "sourceFile": "Papers/Attention is All You Need.md",
      "anchor": "^ann-20260606-001",
      "status": "reviewed",
      "concepts": ["Multi-head Attention"],
      "relatedMemoryCells": ["MEM-20260606-001"],
      "createdAt": "2026-06-06T10:00:00",
      "updatedAt": "2026-06-06T10:10:00"
    }
  ]
}
```

## 10.4 Rebuild Rule

The index is rebuildable by parsing:

```text
Agent Memory/annotation-memory.md
```

and optionally:

```text
Agent Memory/*.md
```

The plugin must provide command:

```text
Rebuild Annotation Tutor Index
```

---

# 11. Agent Inbox Design

## 11.1 Purpose

The plugin uses `agent-inbox.md` to ask agents for work without needing an API or MCP server.

## 11.2 Example Task

```md
# Agent Inbox

## TASK-20260606-001

<!-- annotation-tutor:task:start TASK-20260606-001 -->

- Type: review_annotation
- Status: pending
- Annotation: ANN-20260606-001
- Memory file: `Agent Memory/annotation-memory.md`
- Source file: `Papers/Attention is All You Need.md`
- Anchor: `^ann-20260606-001`
- Created at: 2026-06-06T10:15:00

### User Request

Please review my understanding of this annotation.
If needed, inspect the source Markdown file.
Write the review back to the Agent Review section of ANN-20260606-001.
If the insight is durable, create or update a Memory Cell.

### Required Output

Write back:

1. Correctness
2. Summary
3. Strengths
4. Weaknesses
5. Suggested revision
6. One Socratic question
7. Optional Memory Cell update

<!-- annotation-tutor:task:end TASK-20260606-001 -->
```

## 11.3 Task Status

Task status values:

```text
pending
in_progress
completed
failed
```

Agents may update task status.

The plugin watches this file and updates the UI when task status changes.

---

# 12. User Flow

## 12.1 Create Annotation

1. User opens a Markdown file in Obsidian.
    
2. User selects text.
    
3. User clicks `Add Learning Annotation`.
    
4. Plugin creates annotation ID.
    
5. Plugin inserts or associates source anchor.
    
6. User writes their own understanding.
    
7. Plugin appends annotation block to `Agent Memory/annotation-memory.md`.
    
8. Plugin updates `index.json`.
    
9. Plugin renders underline/highlight in source Markdown.
    

## 12.2 Ask Agent

1. User opens annotation panel.
    
2. User clicks `Ask Agent to Review`.
    
3. Plugin writes task to `Agent Memory/agent-inbox.md`.
    
4. Plugin marks annotation status as `agent_requested`.
    
5. Agent reads `agent-inbox.md`.
    
6. Agent reads `annotation-memory.md`.
    
7. Agent optionally reads source Markdown.
    
8. Agent writes review into `annotation-memory.md`.
    
9. Agent marks task as `completed`.
    
10. Plugin detects file change.
    
11. Plugin refreshes annotation panel and dashboard.
    

## 12.3 Jump to Source

1. User opens Annotation Dashboard.
    
2. User clicks an annotation.
    
3. Plugin reads index record.
    
4. Plugin opens `sourceFile`.
    
5. Plugin searches for `anchor`.
    
6. Plugin scrolls to the anchor.
    
7. Plugin highlights selected annotation.
    

## 12.4 Rebuild Index

1. User runs `Rebuild Annotation Tutor Index`.
    
2. Plugin parses `annotation-memory.md`.
    
3. Plugin extracts annotation blocks.
    
4. Plugin extracts memory cells.
    
5. Plugin rebuilds `index.json`.
    

---

# 13. Obsidian UI Requirements

## 13.1 Ribbon Icon

Add a ribbon icon:

```text
Annotation Tutor
```

Clicking it opens the Annotation Dashboard.

## 13.2 Commands

Plugin commands:

```text
Add Learning Annotation
Open Annotation Dashboard
Ask Agent to Review Current Annotation
Open Annotation Memory File
Open Agent Inbox
Rebuild Annotation Tutor Index
Toggle Annotation Marks
```

## 13.3 Context Menu

When text is selected, add:

```text
Add Learning Annotation
Add Annotation and Ask Agent
```

## 13.4 Annotation Panel

The panel should show:

```text
Selected Text
User Note
Agent Review
Related Memory Cell
Source File
Anchor
Actions
```

Actions:

```text
Save
Ask Agent
Copy Agent Prompt
Open Memory File
Jump to Source
Delete Annotation
```

## 13.5 Dashboard

Dashboard columns:

```text
ID
Status
Concept
Source File
User Note Summary
Agent Review Summary
Updated At
```

Filters:

```text
Status
Source file
Concept
Reviewed / Unreviewed
Date
```

---

# 14. Agent Instructions File

The plugin should create a simple instruction file for agents.

Recommended path:

```text
Agent Memory/AGENTS.md
```

Example:

```md
# Annotation Tutor Agent Instructions

When working with this Vault:

1. Read `Agent Memory/annotation-memory.md` first.
2. Read `Agent Memory/agent-inbox.md` for pending tasks.
3. Use Memory Cells to understand the user's current learning state.
4. Use Annotation Index to locate source documents.
5. Only open source Markdown files when needed.
6. Never overwrite User Note sections.
7. Write reviews under Agent Review.
8. Prefer appending over rewriting.
9. When creating durable learning summaries, write or update Memory Cells.
10. If you complete a task, mark it as completed in `agent-inbox.md`.
```

---

# 15. Settings

Plugin settings:

```json
{
  "memoryRoot": "Agent Memory",
  "mainMemoryFile": "Agent Memory/annotation-memory.md",
  "agentInboxFile": "Agent Memory/agent-inbox.md",
  "recentLearningFile": "Agent Memory/recent-learning.md",
  "agentInstructionsFile": "Agent Memory/AGENTS.md",
  "indexFile": ".obsidian/plugins/annotation-tutor/index.json",
  "useBlockAnchors": true,
  "highlightAnnotations": true,
  "watchMemoryFiles": true,
  "autoRefreshOnAgentWrite": true
}
```

User-facing setting labels should be simple:

```text
Memory folder
Show annotation highlights
Watch Agent files
Auto-refresh Agent reviews
Create Agent instruction file
```

Avoid exposing internal language like “file-based protocol” in beginner UI.

---

# 16. Error Handling

## 16.1 Source Anchor Missing

If the plugin cannot find the anchor:

1. Search selected text.
    
2. Search nearby text.
    
3. Ask user whether to repair anchor.
    
4. Update `annotation-memory.md` and index if repaired.
    

## 16.2 Memory File Corrupted

If `annotation-memory.md` format is broken:

1. Warn user.
    
2. Show affected annotation IDs.
    
3. Offer to rebuild index from valid blocks.
    
4. Never delete user data automatically.
    

## 16.3 Agent Review Malformed

If Agent writes unparseable review:

1. Display raw Agent Review content.
    
2. Mark annotation as `reviewed_unstructured`.
    
3. Let user manually clean it later.
    

## 16.4 Source File Missing

If source file path no longer exists:

1. Mark annotation as `source_missing`.
    
2. Ask user to relink file.
    
3. Keep annotation memory block.
    

---

# 17. Privacy and Safety

## 17.1 Local-first

All files are stored in the current Vault.

The plugin must not upload files.

## 17.2 Agent Visibility

Agents can only see files they are allowed to read through the user's local environment.

The plugin should explain:

```text
Annotation Tutor stores memory files in your Vault.
If you allow an agent to access this Vault, the agent may read those files.
```

## 17.3 User Data Control

User must be able to:

- Delete one annotation.
    
- Delete all annotations.
    
- Delete agent reviews.
    
- Delete memory cells.
    
- Delete the Agent Memory folder.
    
- Rebuild index.
    

---

# 18. Development Phases

## Phase 1: Markdown Memory MVP

Deliverables:

1. Obsidian plugin skeleton.
    
2. Create `Agent Memory/` folder.
    
3. Create `annotation-memory.md`.
    
4. Create `agent-inbox.md`.
    
5. Create `AGENTS.md`.
    
6. Create annotation from selected text.
    
7. Append annotation block to memory file.
    
8. Insert source anchor.
    
9. Build `index.json`.
    
10. Open dashboard.
    
11. Jump from dashboard to source anchor.
    

## Phase 2: Agent Task Loop

Deliverables:

1. Ask Agent button.
    
2. Write task to `agent-inbox.md`.
    
3. Watch memory files for changes.
    
4. Parse Agent Review section.
    
5. Refresh annotation panel.
    
6. Mark task status.
    

## Phase 3: Better Parser and Repair

Deliverables:

1. Parse all annotation blocks.
    
2. Parse memory cell blocks.
    
3. Rebuild index.
    
4. Anchor repair.
    
5. Malformed review fallback.
    

## Phase 4: Agent Integration Helpers

Deliverables:

1. Generate OpenCode instructions.
    
2. Generate Claude Code `AGENTS.md`.
    
3. Generate Codex-friendly instructions.
    
4. Copy Agent Prompt button.
    
5. Optional CLI scripts.
    

## Phase 5: Optional API/MCP Upgrade

Only after file-based MVP is stable.

Possible deliverables:

1. REST API.
    
2. MCP server.
    
3. SQLite index.
    
4. Direct model API.
    
5. Mobile SDK preparation.
    

---

# 19. MVP Acceptance Criteria

The MVP is complete when:

1. User can select text in Obsidian and create an annotation.
    
2. Source Markdown receives a stable anchor.
    
3. `Agent Memory/annotation-memory.md` is created inside the current Vault.
    
4. The annotation is written into `annotation-memory.md`.
    
5. Plugin index table records the annotation.
    
6. Dashboard lists the annotation.
    
7. Clicking dashboard item opens source file and jumps to anchor.
    
8. User can click `Ask Agent`.
    
9. A task is written into `agent-inbox.md`.
    
10. Agent can manually or automatically write review into `annotation-memory.md`.
    
11. Plugin detects and displays that review.
    
12. User does not need to configure model API.
    
13. No database server is required.
    
14. If index is deleted, plugin can rebuild it from Markdown.
    

---

# 20. Final Positioning

Annotation Tutor MVP is an Obsidian plugin with a Markdown-native memory backend.

The plugin provides the reading and annotation interface.

Markdown memory files provide the agent-readable backend.

The index table provides speed and navigation.

The first version should prioritize stability, transparency, and low setup cost over complex infrastructure.

Product slogan:

```text
让你的批注成为 Agent 能理解的学习记忆。
```

English slogan:

```text
Turn your annotations into agent-readable learning memory.
```

[^1]: a'w'f'q'w'f'q'f'q'w'f
