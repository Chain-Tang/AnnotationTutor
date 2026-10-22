// VaultStore: all Obsidian file I/O for Annotation Tutor Lite. The pure
// parsing/serialising lives in src/markdown and src/index-table; this layer
// just reads and writes files and keeps a short-lived record of the plugin's
// own writes so the watcher can ignore them (loop-guard).

import { type App, TFile, TFolder, normalizePath } from "obsidian";
import type {
  Annotation,
  ChatLog,
  ChatLogHead,
  DialogueTurn,
  IndexRecord,
  LearnerProfile,
  MemoryCell,
  MemoryProposal,
  ProfileKind,
  Scene,
  Task
} from "./model.js";
import type { ReviewState } from "./srs.js";
import type { AnnotationTutorLiteSettings } from "./settings.js";
import {
  type AnnotationPatch,
  parseAnnotationFile,
  serializeAnnotation,
  updateAnnotationMarkdown
} from "./markdown/annotation-file.js";
import { parseAgentReview } from "./markdown/review.js";
import { nowIso } from "./ids.js";
import { serializeProfile, parseProfileFile } from "./markdown/profile-file.js";
import {
  evaluateProposal,
  parseProposalFile,
  serializeProposal
} from "./markdown/proposal-file.js";
import { parseFrontmatter } from "./markdown/frontmatter.js";
import {
  appendTask,
  cleanInbox,
  parseTasks,
  setTaskStatus
} from "./markdown/inbox.js";
import {
  renderAgentInstructions,
  renderAnnotationIndex,
  renderCellIndex,
  renderOverview,
  renderRecentLearning,
  renderSceneIndex
} from "./markdown/overview.js";
import type { TaskStatus } from "./model.js";
import {
  buildLibrarySnapshot,
  LibraryParseCache,
  parseLibraryCache,
  serializeLibraryCache,
  type LibraryFile,
  type LibraryFiles,
  type LibrarySnapshot
} from "./library-index.js";
import { validateProposalCandidate } from "./memory-policy.js";
import { buildNotebook } from "./markdown/notebook.js";
import {
  parseMemoryCellFile,
  serializeMemoryCell
} from "./markdown/memory-cell-file.js";
import { parseSceneFile, serializeScene } from "./markdown/scene-file.js";
import {
  parseChatLogFile,
  parseChatLogHead,
  serializeChatLog
} from "./markdown/chat-log-file.js";
import { deriveScenes } from "./memory-derive.js";
import { getLocale } from "./i18n.js";
import { sha256 } from "./markdown/proposal-file.js";
import { GenerationRefreshQueue } from "./refresh-queue.js";
import { makeId } from "./ids.js";
import { AnnotationContextError, assembleAnnotationContext, replySnapshot, type AnnotationReplyTarget } from "./annotation-branches.js";

type LibraryGroup = keyof LibraryFiles;
type LibraryRead = {
  root: string;
  files: LibraryFiles;
  groups: Set<LibraryGroup>;
  dirty: Map<string, number>;
};
type OwnWrite = { hash: string | null; generation: number };
type LibraryOutput = { generatedAt: string; write: OwnWrite };

export class VaultStore {
  private branchCreation: Promise<unknown> = Promise.resolve();
  private readonly pendingBranchCreations = new Set<Promise<Annotation>>();
  private readonly branchReservations = new Set<string>();
  private readonly conversationOperations = new Map<string, Promise<unknown>>();
  private readonly ownWrites = new Map<string, OwnWrite>();
  private readonly dirtyLibraryPaths = new Map<string, number>();
  private readonly dirtyLibraryOutputs = new Map<string, number>();
  private readonly libraryOutputs = new Map<string, LibraryOutput>();
  private libraryOutputsRoot = "";
  private libraryCache: { path: string; hash: string } | undefined;
  private writeGeneration = 0;
  private libraryFiles: LibraryFiles | undefined;
  private readonly cachedLibraryGroups = new Set<LibraryGroup>();
  private libraryRoot = "";
  private lastLibrarySnapshot: LibrarySnapshot | undefined;
  private libraryRefresh: Promise<unknown> = Promise.resolve();
  private readonly parsedLibrary = new LibraryParseCache();
  private parsedLibraryRoot = "";
  private readonly refreshQueue = new GenerationRefreshQueue<
    { previous?: LibrarySnapshot; full: boolean }, LibrarySnapshot
  >((left, right) => ({ previous: right.previous ?? left.previous, full: left.full || right.full }),
    request => this.queueLibraryOperation(() => this.reconcileLibrary(request.previous, request.full)));
  private readonly sceneRefreshQueue = new GenerationRefreshQueue<boolean, void>(
    (left, right) => left || right,
    full => this.queueLibraryOperation(() => this.reconcileScenes(full))
  );

  public constructor(
    private readonly app: App,
    private readonly manifestId: string,
    private readonly getSettings: () => AnnotationTutorLiteSettings
  ) {}

  // --- path helpers ----------------------------------------------------------

  public memoryRoot(): string {
    return normalizePath(this.getSettings().memoryRoot || "Agent Memory");
  }

  public annotationsDir(): string {
    return `${this.memoryRoot()}/annotations`;
  }

  public memoryCellsDir(): string {
    return `${this.memoryRoot()}/memory-cells`;
  }

  public scenesDir(): string {
    return `${this.memoryRoot()}/scenes`;
  }

  public profilesDir(): string {
    return `${this.memoryRoot()}/profiles`;
  }

  public indexesDir(): string {
    return `${this.memoryRoot()}/indexes`;
  }

  public proposalsDir(): string {
    return `${this.memoryRoot()}/proposals`;
  }

  public pendingProposalsDir(): string {
    return `${this.proposalsDir()}/pending`;
  }

  public archivedProposalsDir(): string {
    return `${this.proposalsDir()}/archive`;
  }

  /** Saved sidebar chat sessions (raw transcripts; outside the library index). */
  public chatsDir(): string {
    return `${this.memoryRoot()}/chats`;
  }

  public learnerProfilePath(): string {
    return `${this.profilesDir()}/learner-profile.md`;
  }

  public preferencesPath(): string {
    return `${this.profilesDir()}/preferences.md`;
  }

  public annotationIndexPath(): string {
    return `${this.indexesDir()}/annotations.md`;
  }

  public cellIndexPath(): string {
    return `${this.indexesDir()}/cells.md`;
  }

  public sceneIndexPath(): string {
    return `${this.indexesDir()}/scenes.md`;
  }

  public annotationPath(id: string): string {
    return `${this.annotationsDir()}/${id}.md`;
  }

  public overviewPath(): string {
    return `${this.memoryRoot()}/annotation-memory.md`;
  }

  public inboxPath(): string {
    return `${this.memoryRoot()}/agent-inbox.md`;
  }

  public recentLearningPath(): string {
    return `${this.memoryRoot()}/recent-learning.md`;
  }

  public agentsPath(): string {
    return `${this.memoryRoot()}/AGENTS.md`;
  }

  public notebookIndexPath(): string {
    return `${this.memoryRoot()}/Notebook/Notebook.md`;
  }

  public indexPath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifestId}/index.json`;
  }

  public isWatchedPath(path: string): boolean {
    const root = `${this.memoryRoot()}/`;
    return path.startsWith(root);
  }

  public isLearningWatchedPath(path: string): boolean {
    const normalized = path.replace(/\\/g, "/");
    const root = `${this.memoryRoot()}/`;
    return normalized.startsWith(root) && !["boards", "ink", "ink-packs", "tiles", "brushes", "characters", "references", "tasks", "learning"].includes(normalized.slice(root.length).split("/")[0] ?? "");
  }

  // --- loop guard ------------------------------------------------------------

  public markWritten(path: string, content: string | null): void {
    const generation = ++this.writeGeneration;
    this.ownWrites.set(path, { hash: content === null ? null : sha256(content), generation });
    // Eviction can only cause an extra reconciliation, never hide an edit.
    if (this.ownWrites.size > 4096) this.ownWrites.delete(this.ownWrites.keys().next().value!);
    if (this.libraryGroup(path)) this.dirtyLibraryPaths.set(path, generation);
  }

  /** Invalidate immediately on vault events, before any debounced UI refresh. */
  public invalidateLibrary(paths: readonly string[]): void {
    const root = this.memoryRoot();
    const directories = Object.values(this.libraryDirectories(root));
    const outputs = this.libraryOutputPaths(root);
    for (const path of paths) {
      for (const output of outputs) {
        if (path === output || output.startsWith(`${path}/`)) {
          this.dirtyLibraryOutputs.set(output, ++this.writeGeneration);
        }
      }
      if (this.libraryGroup(path)) {
        this.dirtyLibraryPaths.set(path, ++this.writeGeneration);
      } else {
        // Expand ancestor changes per group: a cells/scenes-only sync must not
        // consume the same rename invalidation needed by annotations/profiles.
        for (const directory of directories) {
          if (path === directory || directory.startsWith(`${path}/`)) {
            this.dirtyLibraryPaths.set(directory, ++this.writeGeneration);
          }
        }
      }
    }
  }

  /** Match the actual persisted content, even when a vault event arrives late. */
  public async isOwnWrite(path: string): Promise<boolean> {
    if (!this.ownWrites.has(path)) return false;
    const expected = this.ownWrites.get(path)!;
    const outputGeneration = this.dirtyLibraryOutputs.get(path);
    const content = await this.readVaultFile(path);
    if (this.ownWrites.get(path) !== expected) return false;
    const matches = expected.hash === (content === null ? null : sha256(content));
    // Once an external version is observed, returning to an old self version is
    // another external change. Never suppress that A -> B -> A transition.
    if (!matches) this.ownWrites.delete(path);
    else if (this.dirtyLibraryOutputs.get(path) === outputGeneration) this.dirtyLibraryOutputs.delete(path);
    return matches;
  }

  // --- scaffold --------------------------------------------------------------

  public async ensureScaffold(): Promise<void> {
    await this.ensureFolder(this.memoryRoot());
    await this.ensureFolder(this.annotationsDir());
    await this.ensureFolder(this.memoryCellsDir());
    await this.ensureFolder(this.scenesDir());
    await this.ensureFolder(this.profilesDir());
    await this.ensureFolder(this.indexesDir());
    await this.ensureFolder(this.pendingProposalsDir());
    await this.ensureFolder(this.archivedProposalsDir());
    const createdAt = new Date().toISOString();
    await this.writeIfMissing(
      this.learnerProfilePath(),
      serializeProfile(emptyProfile("learner-profile", createdAt), this.memoryRoot())
    );
    await this.writeIfMissing(
      this.preferencesPath(),
      serializeProfile(emptyProfile("preferences", createdAt), this.memoryRoot())
    );
    if (this.getSettings().createAgentInstructions) {
      await this.writeIfMissing(
        this.agentsPath(),
        renderAgentInstructions({
          memoryRoot: this.memoryRoot(),
          memoryWriteMode: this.getSettings().memoryWriteMode,
          allowPreferenceWrites: this.getSettings().allowPreferenceWrites,
          reviewLanguage: this.getSettings().reviewLanguage
        })
      );
    }
    await this.writeIfMissing(this.inboxPath(), "# Agent Inbox\n");
  }

  // --- annotations -----------------------------------------------------------

  public async createAnnotation(annotation: Annotation): Promise<void> {
    const path = this.annotationPath(annotation.id);
    await this.ensureFolder(this.annotationsDir());
    const content = serializeAnnotation(annotation, this.memoryRoot());
    this.markWritten(path, content);
    await this.app.vault.create(path, content);
    this.markWritten(path, content);
  }

  public async readAnnotation(id: string): Promise<Annotation | null> {
    const content = await this.readVaultFile(this.annotationPath(id));
    return content === null ? null : parseAnnotationFile(content);
  }

  /** Source snapshot used by both request preparation and commit validation. */
  public async readConversationSource(annotation: Annotation): Promise<string> {
    if (annotation.anchor.sourceType === "pdf" || /\.pdf$/i.test(annotation.sourceFile)) {
      if (!this.fileAt(annotation.sourceFile)) throw new AnnotationContextError("annotation-source-missing");
      return annotation.anchor.selectedText;
    }
    const content = await this.readVaultFile(annotation.sourceFile);
    if (content === null) throw new AnnotationContextError("annotation-source-missing");
    return content;
  }

  public createConversationDraft(parentId: string, target: AnnotationReplyTarget): Promise<Annotation> {
    const operation = this.branchCreation.catch(() => undefined).then(async () => {
      let parent = await this.readAnnotation(parentId);
      if (!parent) throw new AnnotationContextError("annotation-parent-missing");
      if (target.kind === "dialogue") {
        const dialogue = (parent.dialogue ?? []).map(turn => ({ ...turn, id: turn.id ?? crypto.randomUUID() }));
        parent = await this.updateAnnotation(parentId, { dialogue }) ?? parent;
      }
      const snapshot = replySnapshot(parent, target);
      const source = await this.readConversationSource(parent);
      // Validate the parent path before creating another descendant.
      await assembleAnnotationContext(parent.id, id => this.readAnnotation(id), { sourceText: source });
      const files = await this.listAnnotationFiles();
      const ids = [...files.map(file => file.path.split("/").at(-1)!.replace(/\.md$/i, "")), ...this.branchReservations];
      const id = makeId("ANN", ids), at = nowIso();
      this.branchReservations.add(id);
      const child: Annotation = {
        ...(parent.tracking ? { tracking: parent.tracking } : {}),
        id, sourceFile: parent.sourceFile, anchor: { ...parent.anchor }, anchorOrigin: parent.anchorOrigin,
        userNote: "", status: "draft", concepts: [], relatedMemoryCells: [],
        branch: { parentAnnotationId: parent.id, rootAnnotationId: parent.branch?.rootAnnotationId ?? parent.id,
          parentReply: snapshot, sourceVersion: sha256(source) },
        request: { id: crypto.randomUUID(), status: "draft", question: "", updatedAt: at }, createdAt: at, updatedAt: at
      };
      await this.createAnnotation(child);
      return child;
    });
    this.branchCreation = operation;
    this.pendingBranchCreations.add(operation);
    void operation.finally(() => this.pendingBranchCreations.delete(operation)).catch(() => undefined);
    return operation;
  }

  public saveConversationDraft(id: string, question: string): Promise<Annotation | null> {
    return this.queueConversation(id, async () => this.mutateConversation(id, existing => {
      if (!existing.branch || existing.status === "archived" || existing.status === "source_missing" || existing.request?.status === "generating" || existing.request?.status === "completed") return null;
      const at = nowIso();
      return { ...existing, userNote: question, request: { id: existing.request?.id ?? crypto.randomUUID(), status: "draft", question, updatedAt: at }, updatedAt: at };
    }));
  }

  public beginConversationRequest(id: string, question: string, requestId: string = crypto.randomUUID()): Promise<Annotation | null> {
    return this.queueConversation(id, async () => {
      // Save the question before any context/source read can fail.
      const current = await this.mutateConversation(id, existing => {
        if (!existing.branch || existing.status === "archived" || existing.status === "source_missing" || existing.request?.status === "generating" || existing.request?.status === "completed" || !question.trim()) return null;
        return { ...existing, userNote: question, request: { id: requestId, status: "draft", question, updatedAt: nowIso() }, updatedAt: nowIso() };
      });
      if (!current) return null;
      let stillCurrent: () => boolean;
      try {
        stillCurrent = await this.validateConversationContext(current);
      } catch (error) {
        await this.mutateConversation(id, existing => existing.request?.id !== requestId ? null
          : { ...existing, request: { ...existing.request, status: "failed", errorCode: error instanceof AnnotationContextError ? error.code : "annotation-context-unavailable", updatedAt: nowIso() }, updatedAt: nowIso() });
        throw error;
      }
      return this.mutateConversation(id, existing => {
        if (existing.status === "archived" || existing.status === "source_missing" || existing.request?.status === "generating" || existing.request?.status === "completed"
          || JSON.stringify(existing.branch) !== JSON.stringify(current.branch)) return null;
        if (!stillCurrent()) throw new AnnotationContextError("annotation-context-changed");
        const at = nowIso();
        return { ...existing, userNote: question, status: "agent_requested", request: { id: requestId, status: "generating", question, startedAt: at, updatedAt: at }, updatedAt: at };
      });
    });
  }

  public completeConversationRequest(id: string, requestId: string, reply: string, options?: { tracking?: Annotation["tracking"] }): Promise<Annotation | null> {
    return this.queueConversation(id, async () => {
      if (!reply.trim()) return null;
      const current = await this.readAnnotation(id);
      if (!current?.branch || current.request?.id !== requestId || current.request.status !== "generating") return null;
      let stillCurrent: () => boolean;
      try {
        stillCurrent = await this.validateConversationContext(current);
      } catch (error) {
        await this.mutateConversation(id, existing => existing.request?.id === requestId && existing.request.status === "generating"
          ? { ...existing, status: "draft", request: { ...existing.request, status: "failed", errorCode: error instanceof AnnotationContextError ? error.code : "annotation-context-unavailable", updatedAt: nowIso() }, updatedAt: nowIso() } : null);
        throw error;
      }
      return this.mutateConversation(id, existing => {
        if (existing.status === "archived" || existing.status === "source_missing" || existing.request?.id !== requestId || existing.request.status !== "generating" || existing.userNote !== current.userNote
          || JSON.stringify(existing.branch) !== JSON.stringify(current.branch)) return null;
        if (!stillCurrent()) throw new AnnotationContextError("annotation-context-changed");
        const at = nowIso(), review = parseAgentReview(reply.trim(), at) ?? undefined;
        const tracking = existing.tracking === "excluded" || options?.tracking === "excluded" ? "excluded"
          : existing.tracking === "private" || options?.tracking === "private" ? "private" : options?.tracking ?? existing.tracking;
        return { ...existing, ...(tracking ? { tracking } : {}), reviewText: reply.trim(), review, status: review ? "reviewed" : "reviewed_unstructured",
          request: { ...existing.request, status: "completed", updatedAt: at }, updatedAt: at };
      });
    });
  }

  public failConversationRequest(id: string, requestId: string, status: "failed" | "cancelled" | "interrupted" = "failed", errorCode?: string): Promise<Annotation | null> {
    return this.queueConversation(id, async () => this.mutateConversation(id, existing => {
      if (existing.request?.id !== requestId || existing.request.status !== "generating") return null;
      const at = nowIso();
      return { ...existing, status: existing.status === "archived" || existing.status === "source_missing" ? existing.status : "draft", request: { ...existing.request, status, ...(errorCode ? { errorCode } : {}), updatedAt: at }, updatedAt: at };
    }));
  }

  /** Persist same-card follow-up separately from the original annotation and answer. */
  public saveDialogueDraft(id: string, question: string): Promise<Annotation | null> {
    return this.queueConversation(id, async () => this.mutateConversation(id, existing => {
      if (!this.canContinueAnnotation(existing) || existing.dialogueRequest?.status === "generating") return null;
      const at = nowIso(), previous = existing.dialogueRequest;
      return { ...existing, dialogueRequest: { id: previous && previous.status !== "completed" ? previous.id : crypto.randomUUID(),
        status: "draft", question, updatedAt: at }, updatedAt: at };
    }));
  }

  public beginDialogueRequest(id: string, question: string, requestId: string = crypto.randomUUID()): Promise<Annotation | null> {
    return this.queueConversation(id, async () => {
      const current = await this.mutateConversation(id, existing => {
        if (!question.trim() || !this.canContinueAnnotation(existing) || existing.dialogueRequest?.status === "generating"
          || existing.dialogue?.some(turn => turn.id === `${requestId}-user` || turn.id === `${requestId}-agent`)) return null;
        const at = nowIso();
        return { ...existing, dialogueRequest: { id: requestId, status: "draft", question, updatedAt: at }, updatedAt: at };
      });
      if (!current) return null;
      try {
        const sourceVersion = sha256(await this.readConversationSource(current));
        const stillCurrent = await this.validateConversationContext(current);
        return await this.mutateConversation(id, existing => {
          if (!this.canContinueAnnotation(existing) || existing.dialogueRequest?.id !== requestId
            || existing.dialogueRequest.status !== "draft" || this.dialogueContextVersion(existing) !== this.dialogueContextVersion(current)) return null;
          if (!stillCurrent()) throw new AnnotationContextError("annotation-context-changed");
          const at = nowIso();
          return { ...existing, dialogueRequest: { id: requestId, status: "generating", question,
            contextVersion: this.dialogueContextVersion(current), sourceVersion, startedAt: at, updatedAt: at }, updatedAt: at };
        });
      } catch (error) {
        await this.mutateConversation(id, existing => existing.dialogueRequest?.id !== requestId ? null
          : { ...existing, dialogueRequest: { ...existing.dialogueRequest, status: "failed",
            errorCode: error instanceof AnnotationContextError ? error.code : "annotation-context-unavailable", updatedAt: nowIso() }, updatedAt: nowIso() });
        throw error;
      }
    });
  }

  public completeDialogueRequest(id: string, requestId: string, reply: string, options?: { tracking?: Annotation["tracking"] }): Promise<Annotation | null> {
    return this.queueConversation(id, async () => {
      if (!reply.trim()) return null;
      const current = await this.readAnnotation(id), request = current?.dialogueRequest;
      if (!current || request?.id !== requestId || request.status !== "generating") return null;
      try {
        if (!this.canContinueAnnotation(current) || request.contextVersion !== this.dialogueContextVersion(current))
          throw new AnnotationContextError("annotation-context-changed");
        if (request.sourceVersion !== sha256(await this.readConversationSource(current))) throw new AnnotationContextError("annotation-source-changed");
        const stillCurrent = await this.validateConversationContext(current);
        return await this.mutateConversation(id, existing => {
          if (!this.canContinueAnnotation(existing) || existing.dialogueRequest?.id !== requestId || existing.dialogueRequest.status !== "generating") return null;
          if (!stillCurrent() || this.dialogueContextVersion(existing) !== request.contextVersion) throw new AnnotationContextError("annotation-context-changed");
          const at = nowIso(), tracking = existing.tracking === "excluded" || options?.tracking === "excluded" ? "excluded"
            : existing.tracking === "private" || options?.tracking === "private" ? "private" : options?.tracking ?? existing.tracking;
          return { ...existing, ...(tracking ? { tracking } : {}), dialogue: [...(existing.dialogue ?? []),
            { id: `${requestId}-user`, role: "user", text: request.question, at }, { id: `${requestId}-agent`, role: "agent", text: reply.trim(), at }],
            dialogueRequest: { ...existing.dialogueRequest, status: "completed", updatedAt: at }, updatedAt: at };
        });
      } catch (error) {
        await this.mutateConversation(id, existing => existing.dialogueRequest?.id !== requestId || existing.dialogueRequest.status !== "generating" ? null
          : { ...existing, dialogueRequest: { ...existing.dialogueRequest, status: "failed",
            errorCode: error instanceof AnnotationContextError ? error.code : "annotation-context-unavailable", updatedAt: nowIso() }, updatedAt: nowIso() });
        throw error;
      }
    });
  }

  public failDialogueRequest(id: string, requestId: string, status: "failed" | "cancelled" | "interrupted" = "failed", errorCode?: string): Promise<Annotation | null> {
    return this.queueConversation(id, async () => this.mutateConversation(id, existing => {
      if (existing.dialogueRequest?.id !== requestId || existing.dialogueRequest.status !== "generating") return null;
      const at = nowIso();
      return { ...existing, dialogueRequest: { ...existing.dialogueRequest, status, ...(errorCode ? { errorCode } : {}), updatedAt: at }, updatedAt: at };
    }));
  }

  private canContinueAnnotation(annotation: Annotation): boolean {
    return annotation.status !== "archived" && annotation.status !== "source_missing" && annotation.status !== "agent_requested" && annotation.request?.status !== "generating"
      && (!annotation.branch || annotation.request?.status === "completed" || !!annotation.reviewText?.trim());
  }

  private dialogueContextVersion(annotation: Annotation): string {
    return sha256(JSON.stringify({ sourceFile: annotation.sourceFile, anchor: annotation.anchor, userNote: annotation.userNote,
      reviewText: annotation.reviewText, dialogue: annotation.dialogue, branch: annotation.branch }));
  }

  /** Explicit user action: repin a stale direct parent without losing the question. */
  public refreshConversationParent(id: string): Promise<Annotation | null> {
    return this.queueConversation(id, async () => {
      const current = await this.readAnnotation(id);
      if (!current?.branch || current.request?.status === "generating" || current.request?.status === "completed") return null;
      const parent = await this.readAnnotation(current.branch.parentAnnotationId);
      if (!parent) throw new AnnotationContextError("annotation-parent-missing");
      const parentReply = replySnapshot(parent, current.branch.parentReply.kind === "review" ? { kind: "review" } : { kind: "dialogue", turnId: current.branch.parentReply.id });
      const sourceVersion = sha256(await this.readConversationSource(current));
      return this.mutateConversation(id, existing => existing.request?.status === "generating" || existing.request?.status === "completed" ? null
        : { ...existing, branch: { ...current.branch!, parentReply, sourceVersion }, request: existing.request ? { ...existing.request, status: "draft", errorCode: undefined, updatedAt: nowIso() } : undefined, updatedAt: nowIso() });
    });
  }

  public async interruptConversationRequests(): Promise<Annotation[]> {
    const interrupted: Annotation[] = [];
    for (const file of await this.listAnnotationFiles()) {
      const annotation = parseAnnotationFile(file.content);
      if (!annotation) continue;
      let next: Annotation | null = null;
      if (annotation.request?.status === "generating") next = await this.failConversationRequest(annotation.id, annotation.request.id, "interrupted", "annotation-request-interrupted");
      if (annotation.dialogueRequest?.status === "generating") next = await this.failDialogueRequest(annotation.id, annotation.dialogueRequest.id, "interrupted", "annotation-request-interrupted");
      if (next) interrupted.push(next);
    }
    return interrupted;
  }

  /** Upgrade/unload barrier after the UI has flushed its debounced draft editors. */
  public async drainConversationWrites(): Promise<void> {
    let firstFailure: unknown;
    while (true) {
      const creations = [...this.pendingBranchCreations];
      const operations = [...this.conversationOperations.values()];
      const results = await Promise.allSettled([...creations, ...operations]);
      firstFailure ??= results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      // Finalizers remove settled queue entries in the same microtask turn.
      await Promise.resolve();
      if (this.pendingBranchCreations.size === 0 && this.conversationOperations.size === 0) break;
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  private queueConversation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversationOperations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.conversationOperations.set(id, next);
    void next.finally(() => { if (this.conversationOperations.get(id) === next) this.conversationOperations.delete(id); }).catch(() => undefined);
    return next;
  }

  /** Guard the async read -> synchronous vault.process window against host and external edits. */
  private async validateConversationContext(annotation: Annotation): Promise<() => boolean> {
    const guards = new Map<string, () => boolean>();
    const guard = (path: string): void => {
      if (guards.has(path)) return;
      const signature = (): string => {
        const file = this.fileAt(path);
        return JSON.stringify({ exists: !!file, mtime: file?.stat?.mtime, size: file?.stat?.size,
          own: this.ownWrites.get(path)?.generation, dirty: this.dirtyLibraryPaths.get(path) });
      };
      const before = signature();
      guards.set(path, () => signature() === before);
    };
    guard(annotation.sourceFile);
    const sourceText = await this.readConversationSource(annotation);
    await assembleAnnotationContext(annotation.id, async id => {
      guard(this.annotationPath(id));
      return this.readAnnotation(id);
    }, { sourceText });
    const stillCurrent = (): boolean => [...guards.values()].every(check => check());
    if (!stillCurrent()) throw new AnnotationContextError("annotation-context-changed");
    return stillCurrent;
  }

  private async mutateConversation(id: string, mutate: (existing: Annotation) => Annotation | null): Promise<Annotation | null> {
    const file = this.fileAt(this.annotationPath(id));
    if (!file) return null;
    let result: Annotation | null = null;
    await this.processVaultFile(file, data => {
      const existing = parseAnnotationFile(data);
      if (!existing) return data;
      const next = mutate(existing);
      if (!next) return data;
      const out = serializeAnnotation(next, this.memoryRoot());
      result = parseAnnotationFile(out);
      return out;
    });
    return result;
  }

  public async updateAnnotation(
    id: string,
    patch: AnnotationPatch
  ): Promise<Annotation | null> {
    const path = this.annotationPath(id);
    const file = this.fileAt(path);
    if (!file) return null;
    let result: Annotation | null = null;
    await this.processVaultFile(file, (data) => {
      const next = updateAnnotationMarkdown(data, patch, this.memoryRoot());
      if (next === null) return data;
      result = parseAnnotationFile(next);
      return next;
    });
    return result;
  }

  /** A failed request may only restore the state it still owns. */
  public async restoreReviewRequest(
    id: string,
    status: Annotation["status"]
  ): Promise<Annotation | null> {
    const file = this.fileAt(this.annotationPath(id));
    if (!file) return null;
    let result: Annotation | null = null;
    await this.processVaultFile(file, data => {
      const current = parseAnnotationFile(data);
      if (!current || current.status !== "agent_requested") return data;
      const next = updateAnnotationMarkdown(data, { status }, this.memoryRoot());
      if (next === null) return data;
      result = parseAnnotationFile(next);
      return next;
    });
    return result;
  }

  /**
   * Write an agent review into an annotation file's Agent Review section (moving
   * any prior review to Review History). Used by the in-plugin auto-run path,
   * where the plugin — not the agent CLI — owns the file write. Returns the
   * re-parsed annotation (status upgraded to reviewed / reviewed_unstructured).
   */
  public async writeReview(
    id: string,
    reviewText: string
  ): Promise<Annotation | null> {
    const trimmed = reviewText.trim();
    if (!trimmed) return null;
    const path = this.annotationPath(id);
    const file = this.fileAt(path);
    if (!file) return null;
    let result: Annotation | null = null;
    await this.processVaultFile(file, (data) => {
      const existing = parseAnnotationFile(data);
      if (!existing) return data;
      const parsed = parseAgentReview(trimmed, nowIso()) ?? undefined;
      const preserved =
        existing.status === "archived" || existing.status === "source_missing";
      const next: Annotation = {
        ...existing,
        reviewText: trimmed,
        review: parsed,
        reviewHistory: mergeReviewHistory(existing.reviewHistory, existing.reviewText),
        status: preserved
          ? existing.status
          : parsed
            ? "reviewed"
            : "reviewed_unstructured",
        updatedAt: nowIso()
      };
      const out = serializeAnnotation(next, this.memoryRoot());
      result = parseAnnotationFile(out);
      return out;
    });
    return result;
  }

  /**
   * Append in-annotation dialogue turns to the file's `## Dialogue` section,
   * preserving every other (plugin- and agent-owned) section. Self-write is
   * suppressed via `markWritten`, so the margin card's interaction is not torn
   * down by the watcher mid-conversation. Returns the re-parsed annotation.
   */
  public async appendDialogueTurns(
    id: string,
    turns: DialogueTurn[]
  ): Promise<Annotation | null> {
    if (turns.length === 0) return null;
    const path = this.annotationPath(id);
    const file = this.fileAt(path);
    if (!file) return null;
    let result: Annotation | null = null;
    await this.processVaultFile(file, (data) => {
      const existing = parseAnnotationFile(data);
      if (!existing) return data;
      const next: Annotation = {
        ...existing,
        dialogue: [...(existing.dialogue ?? []), ...turns],
        updatedAt: nowIso()
      };
      const out = serializeAnnotation(next, this.memoryRoot());
      result = parseAnnotationFile(out);
      return out;
    });
    return result;
  }

  public async deleteAnnotation(id: string): Promise<void> {
    const hasChildren = (await this.listAnnotationFiles()).some(item => parseAnnotationFile(item.content)?.branch?.parentAnnotationId === id);
    if (hasChildren) { await this.updateAnnotation(id, { status: "archived" }); return; }
    const file = this.fileAt(this.annotationPath(id));
    if (file) await this.deleteVaultFile(file);
  }

  /** Write a new memory cell file (the plugin owns the write). */
  public async createMemoryCell(cell: MemoryCell): Promise<void> {
    await this.writeVaultFile(
      `${this.memoryCellsDir()}/${cell.id}.md`,
      serializeMemoryCell(cell, this.memoryRoot())
    );
  }

  /** Write a generated learning doc (training/summary) under the memory root. */
  public async writeMemoryDoc(relPath: string, content: string): Promise<string> {
    const path = `${this.memoryRoot()}/${relPath}`;
    await this.writeVaultFile(path, content);
    return path;
  }

  /** Persist a new spaced-repetition schedule onto a cell, preserving its body. */
  public async updateCellSchedule(
    cellId: string,
    review: ReviewState
  ): Promise<MemoryCell | null> {
    const path = `${this.memoryCellsDir()}/${cellId}.md`;
    const file = this.fileAt(path);
    if (!file) return null;
    let result: MemoryCell | null = null;
    await this.processVaultFile(file, (data) => {
      const existing = parseMemoryCellFile(data);
      if (!existing) return data;
      const next: MemoryCell = { ...existing, review, updatedAt: nowIso() };
      const out = serializeMemoryCell(next, this.memoryRoot());
      result = parseMemoryCellFile(out);
      return out;
    });
    return result;
  }

  /**
   * Rebuild the auto-generated scenes from the current cells (a scene per concept
   * with two or more cells). Hand-authored scenes (without the `auto` tag) are
   * left untouched; stale auto scenes are removed.
   */
  public async syncScenesFromCells(full = false): Promise<void> {
    return this.sceneRefreshQueue.request(full);
  }

  private async reconcileScenes(full: boolean): Promise<void> {
    const source = await this.readLibrarySources(["cells", "scenes"], full);
    if (this.memoryRoot() !== source.root) return this.reconcileScenes(full);
    const cells = source.files.cells.map(file => this.parsedLibrary.read("memory-cell", file).value);
    // An editor can temporarily leave a cell incomplete. Deriving from that
    // partial set would overwrite/delete valid scenes and lose their evidence.
    if (cells.some(cell => cell === null)) {
      this.publishLibrarySources(source);
      if (this.hasDirtyCellSources(source.root)) await this.reconcileScenes(false);
      return;
    }
    const scenes = deriveScenes(cells as MemoryCell[], nowIso());
    const wanted = new Set(scenes.map(scene => scene.id));
    const existing = new Map(source.files.scenes.map(file => [file.path, file]));
    const handAuthored = new Set(source.files.scenes.flatMap(file => {
      const scene = this.parsedLibrary.read("scene", file).value;
      return scene && !scene.tags.includes("auto") ? [scene.id] : [];
    }));
    for (const scene of scenes) {
      if (this.memoryRoot() !== source.root) return this.reconcileScenes(full);
      const path = `${source.root}/scenes/${scene.id}.md`;
      const current = existing.get(path);
      const previous = current ? this.parsedLibrary.read("scene", current).value : null;
      if (handAuthored.has(scene.id) || (current && (!previous || !previous.tags.includes("auto")))) continue;
      if (previous && sameDerivedScene(previous, scene)) continue;
      const next = { ...scene, createdAt: previous?.createdAt ?? scene.createdAt };
      const file = this.fileAt(path);
      if (file) {
        // The cache may predate an edit made during this sync. The atomic
        // transform rechecks ownership before replacing an existing scene.
        await this.processVaultFile(file, data => {
          const latest = parseSceneFile(data);
          if (!latest || !latest.tags.includes("auto")) return data;
          return serializeScene({ ...next, createdAt: latest.createdAt }, source.root);
        });
      } else {
        await this.writeVaultFile(path, serializeScene(next, source.root));
      }
    }
    for (const file of source.files.scenes) {
      if (this.memoryRoot() !== source.root) return this.reconcileScenes(full);
      const scene = this.parsedLibrary.read("scene", file).value;
      if (!scene || !scene.tags.includes("auto") || wanted.has(scene.id)) continue;
      // Recheck a deletion target rather than trusting a cached ownership tag.
      const latest = await this.readVaultFile(file.path);
      if (latest !== file.content) this.invalidateLibrary([file.path]);
      const current = latest === null ? null : parseSceneFile(latest);
      if (current?.tags.includes("auto") && !wanted.has(current.id)) {
        const handle = this.fileAt(file.path);
        if (handle) await this.deleteVaultFile(handle);
      }
    }
    if (this.memoryRoot() !== source.root) return this.reconcileScenes(full);
    this.publishLibrarySources(source);
    // A cell written/edited while scenes were persisting is a newer source
    // generation; reconcile it before reporting the sync as complete.
    if (this.hasDirtyCellSources(source.root)) await this.reconcileScenes(false);
  }

  private hasDirtyCellSources(root: string): boolean {
    return [...this.dirtyLibraryPaths.keys()].some(path =>
      this.libraryGroup(path, root) === "cells" || path === `${root}/memory-cells`
    );
  }

  /** Write a new hand-authored scene file (user-initiated; the plugin owns the write). */
  public async createScene(scene: Scene): Promise<void> {
    await this.writeVaultFile(
      `${this.scenesDir()}/${scene.id}.md`,
      serializeScene(scene, this.memoryRoot())
    );
  }

  /**
   * Mark a scene archived (user-initiated), preserving everything else. Returns
   * the re-parsed scene, or null when the scene file is missing or unparsable.
   */
  public async archiveScene(sceneId: string): Promise<Scene | null> {
    const path = `${this.scenesDir()}/${sceneId}.md`;
    const file = this.fileAt(path);
    if (!file) return null;
    let result: Scene | null = null;
    await this.processVaultFile(file, (data) => {
      const existing = parseSceneFile(data);
      if (!existing) return data;
      const next: Scene = { ...existing, status: "archived", updatedAt: nowIso() };
      const out = serializeScene(next, this.memoryRoot());
      result = parseSceneFile(out);
      return out;
    });
    return result;
  }

  /**
   * Remove a single profile claim by index (user-initiated), preserving the rest.
   * The remaining claims keep their own evidence, so the profile stays valid.
   * Returns the re-parsed profile, or null when it is missing / the index is out
   * of range.
   */
  public async deleteProfileClaim(
    kind: ProfileKind,
    claimIndex: number
  ): Promise<LearnerProfile | null> {
    const path =
      kind === "learner-profile"
        ? this.learnerProfilePath()
        : this.preferencesPath();
    const file = this.fileAt(path);
    if (!file) return null;
    let result: LearnerProfile | null = null;
    await this.processVaultFile(file, (data) => {
      const existing = parseProfileFile(data);
      if (!existing) return data;
      if (claimIndex < 0 || claimIndex >= existing.claims.length) return data;
      const claims = existing.claims.filter((_, index) => index !== claimIndex);
      const next: LearnerProfile = { ...existing, claims, updatedAt: nowIso() };
      const out = serializeProfile(next, this.memoryRoot());
      result = parseProfileFile(out);
      return out;
    });
    return result;
  }

  // --- chat logs --------------------------------------------------------------

  /** Saved chat sessions as frontmatter heads, newest-first. */
  public async listChatLogs(): Promise<ChatLogHead[]> {
    const heads = (await this.listMarkdownFiles(this.chatsDir()))
      .map((file) => parseChatLogHead(file.content))
      .filter((head): head is ChatLogHead => head !== null);
    return heads.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
    );
  }

  /**
   * Persist a chat session file (creating or overwriting it), then prune the
   * oldest sessions beyond `chatLogKeepSessions` so the folder stays bounded.
   */
  public async saveChatLog(log: ChatLog): Promise<void> {
    await this.writeVaultFile(
      `${this.chatsDir()}/${log.id}.md`,
      serializeChatLog(log)
    );
    const keep = Math.max(
      1,
      Math.floor(this.getSettings().chatLogKeepSessions ?? 30)
    );
    for (const head of (await this.listChatLogs()).slice(keep)) {
      const file = this.fileAt(`${this.chatsDir()}/${head.id}.md`);
      if (file) await this.deleteVaultFile(file);
    }
  }

  /** Load one session in full (frontmatter + every turn); null when missing. */
  public async loadChatLog(id: string): Promise<ChatLog | null> {
    const content = await this.readVaultFile(`${this.chatsDir()}/${id}.md`);
    return content === null ? null : parseChatLogFile(content);
  }

  /** Delete one saved session (user-initiated). */
  public async deleteChatLog(id: string): Promise<void> {
    const file = this.fileAt(`${this.chatsDir()}/${id}.md`);
    if (file) await this.deleteVaultFile(file);
  }

  /** Delete every saved session (user-initiated). */
  public async clearChatLogs(): Promise<void> {
    for (const file of await this.listMarkdownFiles(this.chatsDir())) {
      const handle = this.fileAt(file.path);
      if (handle) await this.deleteVaultFile(handle);
    }
  }

  public async listAnnotationFiles(): Promise<
    { path: string; content: string }[]
  > {
    const folder = this.app.vault.getAbstractFileByPath(this.annotationsDir());
    if (!(folder instanceof TFolder)) return [];
    const files = folder.children.filter(
      (child): child is TFile =>
        child instanceof TFile && child.extension === "md"
    );
    return Promise.all(
      files.map(async (file) => ({
        path: file.path,
        content: await this.app.vault.read(file)
      }))
    );
  }

  public async rebuildLibrary(
    previous?: LibrarySnapshot
  ): Promise<LibrarySnapshot> {
    return this.queueLibraryRefresh(previous);
  }

  /** Re-read changed files while retaining a full rebuild for explicit repair. */
  public async refreshLibrary(
    previous?: LibrarySnapshot,
    paths: string[] = []
  ): Promise<LibrarySnapshot> {
    this.invalidateLibrary(paths);
    return this.queueLibraryRefresh(previous, paths);
  }

  private queueLibraryRefresh(previous?: LibrarySnapshot, paths?: string[]): Promise<LibrarySnapshot> {
    return this.refreshQueue.request({ previous, full: paths === undefined });
  }

  private queueLibraryOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.libraryRefresh.then(operation);
    this.libraryRefresh = pending.catch(() => {});
    return pending;
  }

  private async readLibrarySources(groups: LibraryGroup[], full: boolean): Promise<LibraryRead> {
    const root = this.memoryRoot();
    if (this.parsedLibraryRoot !== root) {
      this.parsedLibrary.clear();
      this.parsedLibraryRoot = root;
    }
    const dirty = new Map(this.dirtyLibraryPaths);
    const directories = this.libraryDirectories(root);
    const cached = this.libraryRoot === root ? this.libraryFiles : undefined;
    const loaded = new Set(cached ? this.cachedLibraryGroups : []);
    const files: LibraryFiles = {
      annotations: [...(cached?.annotations ?? [])], cells: [...(cached?.cells ?? [])],
      scenes: [...(cached?.scenes ?? [])], profiles: [...(cached?.profiles ?? [])],
      proposals: [...(cached?.proposals ?? [])]
    };
    await Promise.all(groups.map(async group => {
      const directory = directories[group];
      const changed = [...dirty.keys()].filter(path => this.libraryGroup(path, root) === group);
      const scan = full || !loaded.has(group) || [...dirty.keys()].some(path => path === directory || directory.startsWith(`${path}/`));
      if (scan) files[group] = await this.listMarkdownFiles(directory);
      else {
        const updates = await Promise.all(changed.map(async path => ({ path, content: await this.readVaultFile(path) })));
        const replaced = new Set(changed);
        files[group] = files[group].filter(file => !replaced.has(file.path));
        for (const { path, content } of updates) if (content !== null) files[group].push({ path, content });
      }
      loaded.add(group);
    }));
    for (const group of Object.values(files)) group.sort((a, b) => a.path.localeCompare(b.path));
    // A cells/scenes-only refresh must leave other groups' dirty generations
    // pending for the next complete library refresh.
    const consumed = new Map([...dirty].filter(([path]) => groups.some(group =>
      this.libraryGroup(path, root) === group || path === directories[group] || directories[group].startsWith(`${path}/`)
    )));
    return { root, files, groups: loaded, dirty: consumed };
  }

  private publishLibrarySources(source: LibraryRead): void {
    if (this.libraryRoot !== source.root) {
      this.lastLibrarySnapshot = undefined;
      // Returning to an old root always starts from a full source read, so its
      // previous dirty entries need not accumulate across root changes.
      const directories = Object.values(this.libraryDirectories(source.root));
      for (const path of this.dirtyLibraryPaths.keys()) {
        if (!this.libraryGroup(path, source.root) && !directories.includes(path)) this.dirtyLibraryPaths.delete(path);
      }
    }
    this.libraryFiles = source.files;
    this.parsedLibrary.retain(source.files);
    this.libraryRoot = source.root;
    this.cachedLibraryGroups.clear();
    for (const group of source.groups) this.cachedLibraryGroups.add(group);
    for (const [path, generation] of source.dirty) {
      if (this.dirtyLibraryPaths.get(path) === generation) this.dirtyLibraryPaths.delete(path);
    }
  }

  private async reconcileLibrary(previous: LibrarySnapshot | undefined, full: boolean): Promise<LibrarySnapshot> {
    const source = await this.readLibrarySources(["annotations", "cells", "scenes", "profiles", "proposals"], full);
    const { root, files } = source;
    const snapshot = buildLibrarySnapshot(files, this.libraryRoot === root ? this.lastLibrarySnapshot ?? previous : previous, this.parsedLibrary);
    // Await every output even on error, so the next refresh cannot race old writes.
    await settleWrites([
      this.writeLibraryCache(snapshot, full),
      this.writeLibraryOutputs(snapshot, root, full)
    ]);
    if (this.memoryRoot() !== root) return this.reconcileLibrary(undefined, false);
    this.publishLibrarySources(source);
    // UI consumers own the returned projection; last-valid fallback must keep
    // the persisted version even when a view mutates one of its records.
    this.lastLibrarySnapshot = structuredClone(snapshot);
    return snapshot;
  }

  private libraryDirectories(root: string): Record<LibraryGroup, string> {
    return {
      annotations: `${root}/annotations`, cells: `${root}/memory-cells`, scenes: `${root}/scenes`,
      profiles: `${root}/profiles`, proposals: `${root}/proposals/pending`
    };
  }

  private libraryOutputPaths(root: string): string[] {
    return ["annotation-memory.md", "recent-learning.md", "indexes/annotations.md", "indexes/cells.md", "indexes/scenes.md", "AGENTS.md"]
      .map(path => `${root}/${path}`);
  }

  private async writeLibraryCache(snapshot: LibrarySnapshot, full: boolean): Promise<void> {
    const path = this.indexPath();
    const content = serializeLibraryCache(snapshot);
    const hash = sha256(content);
    if (!full && this.libraryCache?.path === path && this.libraryCache.hash === hash &&
      await this.app.vault.adapter.exists(path)) return;
    await this.app.vault.adapter.write(path, content);
    this.libraryCache = { path, hash };
  }

  private libraryGroup(path: string, root = this.memoryRoot()): LibraryGroup | undefined {
    for (const [group, directory] of Object.entries(this.libraryDirectories(root))) {
      if (path.endsWith(".md") && parentPath(path) === directory) return group as LibraryGroup;
    }
    return undefined;
  }

  public async loadLibraryCache(): Promise<LibrarySnapshot | null> {
    const path = this.indexPath();
    if (!(await this.app.vault.adapter.exists(path))) return null;
    return parseLibraryCache(await this.app.vault.adapter.read(path));
  }

  public async approveProposal(
    id: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const pendingPath = `${this.pendingProposalsDir()}/${id}.md`;
    const proposalText = await this.readVaultFile(pendingPath);
    const proposal = proposalText ? parseProposalFile(proposalText) : null;
    if (!proposal) return { ok: false, message: "Proposal is unavailable" };
    if (proposal.status === "stale") {
      return { ok: false, message: "Stale proposals must be regenerated" };
    }

    const cache = await this.loadLibraryCache();
    const knownEvidence = new Set([
      ...(cache?.cells.map((cell) => cell.id) ?? []),
      ...(cache?.scenes.map((scene) => scene.id) ?? [])
    ]);
    const policy = validateProposalCandidate(
      proposal,
      this.getSettings().allowPreferenceWrites,
      knownEvidence
    );
    if (!policy.ok) return policy;

    const targetPath = `${this.memoryRoot()}/${proposal.targetPath}`;
    const current = await this.readVaultFile(targetPath);
    if (evaluateProposal(proposal, current) === "stale") {
      await this.writeVaultFile(
        pendingPath,
        serializeProposal({ ...proposal, status: "stale" })
      );
      return {
        ok: false,
        message: "Proposal is stale because the target changed"
      };
    }

    await this.writeVaultFile(targetPath, proposal.candidate);
    await this.archiveProposal(pendingPath, {
      ...proposal,
      status: "approved",
      resolvedAt: new Date().toISOString()
    });
    // A newly approved memory cell can change which concepts now have two or more
    // cells, so re-derive the auto scenes (hand-authored scenes stay untouched).
    if (proposal.targetKind === "memory-cell") {
      await this.syncScenesFromCells();
    }
    return { ok: true };
  }

  public async rejectProposal(
    id: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const pendingPath = `${this.pendingProposalsDir()}/${id}.md`;
    const proposalText = await this.readVaultFile(pendingPath);
    const proposal = proposalText ? parseProposalFile(proposalText) : null;
    if (!proposal) return { ok: false, message: "Proposal is unavailable" };
    await this.archiveProposal(pendingPath, {
      ...proposal,
      status: "rejected",
      resolvedAt: new Date().toISOString()
    });
    return { ok: true };
  }

  public async proposalTargetContent(
    proposal: MemoryProposal
  ): Promise<string | null> {
    return this.readVaultFile(`${this.memoryRoot()}/${proposal.targetPath}`);
  }

  public async migrateLegacyAnnotations(): Promise<{
    migrated: number;
    skipped: number;
    errors: string[];
    backupRoot?: string;
  }> {
    const files = await this.listAnnotationFiles();
    const legacy = files.filter((file) => !parseFrontmatter(file.content));
    if (legacy.length === 0) {
      return { migrated: 0, skipped: files.length, errors: [] };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRoot = `${this.memoryRoot()}/.migration-backup/${stamp}`;
    await this.ensureFolder(backupRoot);
    let migrated = 0;
    const errors: string[] = [];
    for (const file of legacy) {
      const annotation = parseAnnotationFile(file.content);
      if (!annotation) {
        errors.push(file.path);
        continue;
      }
      const fileName = file.path.split("/").pop() ?? `${annotation.id}.md`;
      await this.writeVaultFile(`${backupRoot}/${fileName}`, file.content);
      await this.writeVaultFile(
        file.path,
        serializeAnnotation(
          { ...annotation, anchorOrigin: "legacy" },
          this.memoryRoot()
        )
      );
      migrated += 1;
    }
    return {
      migrated,
      skipped: files.length - legacy.length,
      errors,
      backupRoot
    };
  }

  // --- inbox -----------------------------------------------------------------

  public async readTasks(): Promise<Task[]> {
    const content = await this.readVaultFile(this.inboxPath());
    return content === null ? [] : parseTasks(content);
  }

  public async appendTask(task: Task): Promise<void> {
    const file = this.fileAt(this.inboxPath());
    if (file) await this.processVaultFile(file, current => `${appendTask(current, task)}\n`);
    else await this.writeVaultFile(this.inboxPath(), `${appendTask("", task)}\n`);
  }

  public async setTaskStatus(id: string, status: TaskStatus, onlyIf?: readonly TaskStatus[]): Promise<void> {
    const file = this.fileAt(this.inboxPath());
    if (file) await this.processVaultFile(file, current => {
      const task = parseTasks(current).find(task => task.id === id);
      if (onlyIf && (!task || !onlyIf.includes(task.status))) return current;
      return setTaskStatus(current, id, status);
    });
  }

  /** Tidy the inbox (dedupe open tasks, drop finished/dangling). Returns removed count. */
  public async cleanInbox(knownAnnotationIds: Iterable<string>): Promise<number> {
    const current = await this.readVaultFile(this.inboxPath());
    if (current === null) return 0;
    const { markdown, removed } = cleanInbox(current, knownAnnotationIds);
    if (removed > 0) await this.writeVaultFile(this.inboxPath(), markdown);
    return removed;
  }

  private async writeLibraryOutputs(snapshot: LibrarySnapshot, root: string, full: boolean): Promise<void> {
    if (this.libraryOutputsRoot !== root) {
      this.libraryOutputs.clear();
      this.libraryOutputsRoot = root;
      for (const path of this.dirtyLibraryOutputs.keys()) {
        if (!path.startsWith(`${root}/`)) this.dirtyLibraryOutputs.delete(path);
      }
    }
    const generatedAt = new Date().toISOString();
    const options = {
      memoryRoot: root,
      memoryWriteMode: this.getSettings().memoryWriteMode,
      allowPreferenceWrites: this.getSettings().allowPreferenceWrites,
      reviewLanguage: this.getSettings().reviewLanguage
    };
    const write = (path: string, render: (at: string) => string): Promise<void> =>
      this.writeLibraryOutput(path, render, generatedAt, full);
    const writes = [write(
      `${root}/annotation-memory.md`,
      at => renderOverview(snapshot.annotations, snapshot.cells, { ...options, generatedAt: at })
    ), write(
      `${root}/recent-learning.md`,
      at => renderRecentLearning(snapshot.annotations, { ...options, generatedAt: at })
    ), write(
      `${root}/indexes/annotations.md`,
      at => renderAnnotationIndex(snapshot.annotations, { ...options, generatedAt: at })
    ), write(
      `${root}/indexes/cells.md`,
      at => renderCellIndex(snapshot.cells, { ...options, generatedAt: at })
    ), write(
      `${root}/indexes/scenes.md`,
      at => renderSceneIndex(snapshot.scenes, { ...options, generatedAt: at })
    )];
    if (this.getSettings().createAgentInstructions) {
      writes.push(write(
        `${root}/AGENTS.md`,
        () => renderAgentInstructions(options)
      ));
    }
    await settleWrites(writes);
  }

  private async writeLibraryOutput(
    path: string,
    render: (generatedAt: string) => string,
    generatedAt: string,
    full: boolean
  ): Promise<void> {
    const previous = this.libraryOutputs.get(path);
    const dirty = this.dirtyLibraryOutputs.get(path);
    // Keep the previous successful timestamp while comparing actual output.
    // An unchanged projection does not acquire a new timestamp or vault event.
    const content = render(previous?.generatedAt ?? generatedAt);
    if (!full && previous?.write.hash === sha256(content) &&
      previous.write === this.ownWrites.get(path) && this.fileAt(path)) {
      if (dirty === undefined) return;
      // With automatic watching disabled (or before its debounce), our own
      // vault events are still invalidated but have not had fingerprint checks.
      if (await this.isOwnWrite(path).catch(() => false) && !this.dirtyLibraryOutputs.has(path) &&
        previous.write === this.ownWrites.get(path)) return;
    }
    const next = previous && previous.generatedAt !== generatedAt ? render(generatedAt) : content;
    await this.writeVaultFile(path, next);
    const write = this.ownWrites.get(path);
    // Concurrent writes may evict this fingerprint from the bounded guard.
    if (write) this.libraryOutputs.set(path, { generatedAt, write });
    else this.libraryOutputs.delete(path);
    // A newer vault event during persistence must survive for the next refresh.
    if (this.dirtyLibraryOutputs.get(path) === dirty) this.dirtyLibraryOutputs.delete(path);
  }

  /**
   * Build and write the whole per-Vault notebook (index + per-document pages +
   * related-document chapters) from the current annotation index. Returns the
   * index path plus counts for the completion notice.
   */
  public async writeNotebook(
    records: IndexRecord[],
    cells: MemoryCell[],
    synthesis?: Map<string, string>
  ): Promise<{ path: string; pages: number; chapters: number }> {
    const files = buildNotebook(records, {
      memoryRoot: this.memoryRoot(),
      generatedAt: new Date().toISOString(),
      locale: getLocale(),
      cells,
      ...(synthesis ? { synthesis } : {})
    });
    for (const file of files) {
      await this.writeVaultFile(file.path, file.content);
    }
    return {
      path: this.notebookIndexPath(),
      pages: files.filter((file) => file.path.includes("/pages/")).length,
      chapters: files.filter((file) => file.path.includes("/chapters/")).length
    };
  }

  private async archiveProposal(
    pendingPath: string,
    proposal: MemoryProposal
  ): Promise<void> {
    const archivePath = `${this.archivedProposalsDir()}/${proposal.id}.md`;
    await this.writeVaultFile(archivePath, serializeProposal(proposal));
    const pending = this.fileAt(pendingPath);
    if (pending) await this.deleteVaultFile(pending);
  }

  // --- low-level helpers -----------------------------------------------------

  private fileAt(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private async readVaultFile(path: string): Promise<string | null> {
    const file = this.fileAt(path);
    return file ? this.app.vault.read(file) : null;
  }

  private async listMarkdownFiles(folderPath: string): Promise<LibraryFile[]> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];
    const files = folder.children.filter(
      (child): child is TFile =>
        child instanceof TFile && child.extension === "md"
    );
    return Promise.all(
      files.map(async (file) => ({
        path: file.path,
        content: await this.app.vault.read(file)
      }))
    );
  }

  private async writeVaultFile(path: string, content: string): Promise<void> {
    const file = this.fileAt(path);
    this.markWritten(path, content);
    if (file) {
      await this.app.vault.modify(file, content);
    } else {
      await this.ensureFolder(parentPath(path));
      await this.app.vault.create(path, content);
    }
    this.markWritten(path, content);
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    if (!this.fileAt(path)) {
      await this.ensureFolder(parentPath(path));
      this.markWritten(path, content);
      await this.app.vault.create(path, content);
      this.markWritten(path, content);
    }
  }

  private async processVaultFile(file: TFile, transform: (data: string) => string): Promise<void> {
    let written = "";
    await this.app.vault.process(file, data => {
      const next = transform(data);
      written = next;
      this.markWritten(file.path, next);
      return next;
    });
    // A refresh may have read the old content while process was persisting.
    // Publish a fresh dirty generation only after the write has completed.
    this.markWritten(file.path, written);
  }

  private async deleteVaultFile(file: TFile): Promise<void> {
    this.markWritten(file.path, null);
    await this.app.vault.delete(file);
    this.markWritten(file.path, null);
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder || folder === "." || folder === "/") return;
    if (this.app.vault.getAbstractFileByPath(folder)) return;
    await this.ensureFolder(parentPath(folder));
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // A concurrent create or pre-existing folder is fine.
    }
  }
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/** Compare generated content while keeping stable creation/update timestamps. */
function sameDerivedScene(current: Scene, derived: Scene): boolean {
  return current.id === derived.id && current.type === derived.type &&
    current.title === derived.title && current.status === derived.status &&
    current.summary === derived.summary &&
    current.cells.length === derived.cells.length && current.cells.every((id, index) => id === derived.cells[index]) &&
    current.tags.length === derived.tags.length && current.tags.every((tag, index) => tag === derived.tags[index]);
}

async function settleWrites(writes: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(writes);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** Prepend the prior review (if any) to the existing Review History block. */
function mergeReviewHistory(
  existingHistory: string | undefined,
  priorReview: string | undefined
): string | undefined {
  const prior = priorReview?.trim();
  if (!prior) return existingHistory;
  const history = existingHistory?.trim();
  return history ? `${prior}\n\n---\n\n${history}` : prior;
}

function emptyProfile(
  kind: "learner-profile" | "preferences",
  updatedAt: string
): LearnerProfile {
  return {
    id: kind,
    kind,
    title: kind === "learner-profile" ? "Learner Profile" : "Preferences",
    status: "active",
    summary:
      kind === "learner-profile"
        ? "Evidence-backed understanding of the learner."
        : "Optional evidence-backed learning and communication preferences.",
    claims: [],
    tags: [],
    updatedAt
  };
}
