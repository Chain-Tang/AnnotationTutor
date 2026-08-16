// Core data model for Annotation Tutor Lite.
//
// These types intentionally mirror the design spec (§7) and stay free of any
// Obsidian imports so the parsing/serialising logic around them can be unit
// tested in a plain Node environment.

import type { ReviewState } from "./srs.js";

export type AnnotationStatus =
  | "draft"
  | "saved"
  | "agent_requested"
  | "reviewed"
  // Spec §16.3: a review was written but could not be parsed into fields.
  | "reviewed_unstructured"
  // Spec §16.4: the annotation's source file no longer exists.
  | "source_missing"
  | "archived";

export const annotationStatuses: readonly AnnotationStatus[] = [
  "draft",
  "saved",
  "agent_requested",
  "reviewed",
  "reviewed_unstructured",
  "source_missing",
  "archived"
];

export type ReviewSource =
  | "opencode"
  | "codex"
  | "claude-code"
  | "manual"
  | "unknown";

export type Correctness =
  | "correct"
  | "partially_correct"
  | "incorrect"
  | "uncertain";

/**
 * A source-text anchor. `blockId` is stored WITHOUT the leading caret
 * (e.g. `ann-20260606-001`); the caret form `^ann-20260606-001` is what gets
 * written into the source Markdown and the index. `selectedText` lets the
 * anchor be re-located (and repaired) if the block id is lost.
 */
export type Anchor = {
  blockId: string;
  selectedText: string;
};

export type AnchorOrigin = "generated" | "existing" | "legacy";

export type DialogueRole = "user" | "agent";

/**
 * One turn of in-annotation dialogue (learner ↔ tutor), persisted in the
 * annotation file's `## Dialogue` section so the conversation context survives
 * reloads and is readable/editable as plain Markdown.
 */
export type DialogueTurn = {
  role: DialogueRole;
  text: string;
  /** ISO timestamp the turn was recorded. */
  at: string;
};

export type AgentReview = {
  source: ReviewSource;
  correctness: Correctness;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestedRevision?: string;
  socraticQuestion?: string;
  createdAt: string;
};

export type Annotation = {
  id: string;
  sourceFile: string;
  anchor: Anchor;
  anchorOrigin?: AnchorOrigin;
  userNote: string;
  status: AnnotationStatus;
  concepts: string[];
  relatedMemoryCells: string[];
  /** Parsed structured review, when the agent output could be understood. */
  review?: AgentReview;
  /** Raw Markdown of the Agent Review section, preserved verbatim for display. */
  reviewText?: string;
  /** Raw Markdown of the Review History section, preserved verbatim. */
  reviewHistory?: string;
  /** In-annotation chat turns (learner + tutor), persisted in the file. */
  dialogue?: DialogueTurn[];
  createdAt: string;
  updatedAt: string;
};

export type MemoryCellStatus =
  | "new"
  | "partially_understood"
  | "stable"
  | "needs_review"
  | "draft"
  | "active"
  | "superseded"
  | "archived";

export type MemoryCellType =
  | "understanding"
  | "misconception"
  | "goal"
  | "difficulty"
  | "strategy"
  | "progress";

export type MemoryCell = {
  id: string;
  type: MemoryCellType;
  concept: string;
  domain?: string;
  status: MemoryCellStatus;
  summary: string;
  sourceAnnotations: string[];
  tags: string[];
  confidence: number;
  validFrom?: string;
  validUntil?: string;
  supersedes?: string[];
  agentGuidance?: string;
  /** Spaced-repetition schedule (SM-2); absent on cells never scheduled. */
  review?: ReviewState;
  createdAt: string;
  updatedAt: string;
};

export type SceneType = "topic" | "course" | "document" | "project";
export type SceneStatus = "active" | "archived";

export type Scene = {
  id: string;
  type: SceneType;
  title: string;
  status: SceneStatus;
  summary: string;
  cells: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProfileKind = "learner-profile" | "preferences";

export type ProfileClaim = {
  statement: string;
  evidence: string[];
};

export type LearnerProfile = {
  id: string;
  kind: ProfileKind;
  title: string;
  status: "active" | "archived";
  summary: string;
  claims: ProfileClaim[];
  tags: string[];
  updatedAt: string;
};

/** One turn of a saved sidebar chat session (see ChatLog). */
export type ChatLogTurn = {
  role: "user" | "assistant";
  text: string;
  /** ISO timestamp the turn was recorded. */
  at: string;
};

/** Which engine a saved chat session ran on (mirrors `chatEngine`). */
export type ChatLogEngine = "opencode" | "api";

/** The chat view's conversation mode at the time the session was saved. */
export type ChatLogMode = "ask" | "plan" | "build";

/**
 * A persisted sidebar chat session — one Markdown file per session under
 * `<memoryRoot>/chats/`. This is the raw transcript only, deliberately distinct
 * from MemoryCell (the distilled, SRS-tracked knowledge model): chat logs never
 * feed the schedule, the profile, or mastery. `text` is the message as sent or
 * received; `at` orders the turns.
 */
export type ChatLog = {
  id: string;
  title: string;
  engine: ChatLogEngine;
  mode: ChatLogMode;
  status: "active" | "archived";
  turns: ChatLogTurn[];
  createdAt: string;
  updatedAt: string;
};

/** Frontmatter-only projection of a ChatLog for listing sessions cheaply. */
export type ChatLogHead = {
  id: string;
  title: string;
  engine: ChatLogEngine;
  mode: ChatLogMode;
  status: "active" | "archived";
  /** Turn count from the frontmatter (the body is not parsed for heads). */
  turns: number;
  createdAt: string;
  updatedAt: string;
};

export type ProposalOperation = "create" | "update";
export type ProposalTargetKind =
  | "memory-cell"
  | "scene"
  | "learner-profile"
  | "preferences";
export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "stale";

export type MemoryProposal = {
  id: string;
  operation: ProposalOperation;
  targetKind: ProposalTargetKind;
  targetPath: string;
  baseSha256?: string;
  status: ProposalStatus;
  candidate: string;
  createdAt: string;
  resolvedAt?: string;
};

/** Lightweight, rebuildable index row (spec §7.4 / §10). */
export type IndexRecord = {
  annotationId: string;
  memoryFile: string;
  sourceFile: string;
  anchor: string;
  anchorOrigin: AnchorOrigin;
  /** The anchored source text, so editor decorations can hug the exact span. */
  selectedText: string;
  status: AnnotationStatus;
  concepts: string[];
  relatedMemoryCells: string[];
  reviewSummary?: string;
  /** Full agent review text, so margin cards can show it without re-reading the file. */
  reviewText?: string;
  userNoteSummary?: string;
  /** Full user note, so margin cards can edit it without re-reading the file. */
  userNote?: string;
  /** In-annotation dialogue turns, so margin cards render them without re-reading. */
  dialogue?: DialogueTurn[];
  createdAt: string;
  updatedAt: string;
};

export type IndexFile = {
  version: 1;
  records: IndexRecord[];
};

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export type Task = {
  id: string;
  type: "review_annotation";
  status: TaskStatus;
  annotationId: string;
  memoryFile: string;
  sourceFile: string;
  anchor: string;
  request: string;
  createdAt: string;
};

export const correctnessValues: readonly Correctness[] = [
  "correct",
  "partially_correct",
  "incorrect",
  "uncertain"
];

/** Caret form of a stored block id, as written into source Markdown. */
export function caretId(blockId: string): string {
  return blockId.startsWith("^") ? blockId : `^${blockId}`;
}

/** Stored form of a block id (no caret). */
export function bareBlockId(anchor: string): string {
  return anchor.replace(/^\^/, "");
}
