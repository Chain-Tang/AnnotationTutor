// VaultStore: all Obsidian file I/O for Annotation Tutor Lite. The pure
// parsing/serialising lives in src/markdown and src/index-table; this layer
// just reads and writes files and keeps a short-lived record of the plugin's
// own writes so the watcher can ignore them (loop-guard).

import { type App, TFile, TFolder, normalizePath } from "obsidian";
import type {
  Annotation,
  LearnerProfile,
  MemoryProposal,
  Task
} from "./model.js";
import type { AnnotationTutorLiteSettings } from "./settings.js";
import {
  type AnnotationPatch,
  parseAnnotationFile,
  serializeAnnotation,
  updateAnnotationMarkdown
} from "./markdown/annotation-file.js";
import { parseAgentReview } from "./markdown/review.js";
import { nowIso } from "./ids.js";
import { serializeProfile } from "./markdown/profile-file.js";
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
  parseLibraryCache,
  serializeLibraryCache,
  type LibraryFile,
  type LibrarySnapshot
} from "./library-index.js";
import { validateProposalCandidate } from "./memory-policy.js";

const SELF_WRITE_WINDOW_MS = 1500;

export class VaultStore {
  private readonly recentWrites = new Map<string, number>();

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

  public indexPath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifestId}/index.json`;
  }

  public isWatchedPath(path: string): boolean {
    const root = `${this.memoryRoot()}/`;
    return path.startsWith(root);
  }

  // --- loop guard ------------------------------------------------------------

  public markWritten(path: string): void {
    this.recentWrites.set(path, Date.now());
  }

  public wasRecentlyWritten(path: string): boolean {
    const at = this.recentWrites.get(path);
    if (at === undefined) return false;
    if (Date.now() - at > SELF_WRITE_WINDOW_MS) {
      this.recentWrites.delete(path);
      return false;
    }
    return true;
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
    await this.app.vault.create(
      path,
      serializeAnnotation(annotation, this.memoryRoot())
    );
    this.markWritten(path);
  }

  public async readAnnotation(id: string): Promise<Annotation | null> {
    const content = await this.readVaultFile(this.annotationPath(id));
    return content === null ? null : parseAnnotationFile(content);
  }

  public async updateAnnotation(
    id: string,
    patch: AnnotationPatch
  ): Promise<Annotation | null> {
    const path = this.annotationPath(id);
    const file = this.fileAt(path);
    if (!file) return null;
    let result: Annotation | null = null;
    await this.app.vault.process(file, (data) => {
      const next = updateAnnotationMarkdown(data, patch, this.memoryRoot());
      if (next === null) return data;
      result = parseAnnotationFile(next);
      return next;
    });
    this.markWritten(path);
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
    await this.app.vault.process(file, (data) => {
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
    this.markWritten(path);
    return result;
  }

  public async deleteAnnotation(id: string): Promise<void> {
    const file = this.fileAt(this.annotationPath(id));
    if (file) await this.app.vault.delete(file);
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
    const files = {
      annotations: await this.listMarkdownFiles(this.annotationsDir()),
      cells: await this.listMarkdownFiles(this.memoryCellsDir()),
      scenes: await this.listMarkdownFiles(this.scenesDir()),
      profiles: await this.listMarkdownFiles(this.profilesDir()),
      proposals: await this.listMarkdownFiles(this.pendingProposalsDir())
    };
    const snapshot = buildLibrarySnapshot(files, previous);
    await this.app.vault.adapter.write(
      this.indexPath(),
      serializeLibraryCache(snapshot)
    );
    await this.writeLibraryOutputs(snapshot);
    return snapshot;
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
    const current = (await this.readVaultFile(this.inboxPath())) ?? "";
    await this.writeVaultFile(this.inboxPath(), `${appendTask(current, task)}\n`);
  }

  public async setTaskStatus(id: string, status: TaskStatus): Promise<void> {
    const current = await this.readVaultFile(this.inboxPath());
    if (current === null) return;
    await this.writeVaultFile(this.inboxPath(), setTaskStatus(current, id, status));
  }

  /** Tidy the inbox (dedupe open tasks, drop finished/dangling). Returns removed count. */
  public async cleanInbox(knownAnnotationIds: Iterable<string>): Promise<number> {
    const current = await this.readVaultFile(this.inboxPath());
    if (current === null) return 0;
    const { markdown, removed } = cleanInbox(current, knownAnnotationIds);
    if (removed > 0) await this.writeVaultFile(this.inboxPath(), markdown);
    return removed;
  }

  private async writeLibraryOutputs(snapshot: LibrarySnapshot): Promise<void> {
    const generatedAt = new Date().toISOString();
    const options = {
      memoryRoot: this.memoryRoot(),
      generatedAt,
      memoryWriteMode: this.getSettings().memoryWriteMode,
      allowPreferenceWrites: this.getSettings().allowPreferenceWrites,
      reviewLanguage: this.getSettings().reviewLanguage
    };
    await this.writeVaultFile(
      this.overviewPath(),
      renderOverview(snapshot.annotations, snapshot.cells, options)
    );
    await this.writeVaultFile(
      this.recentLearningPath(),
      renderRecentLearning(snapshot.annotations, options)
    );
    await this.writeVaultFile(
      this.annotationIndexPath(),
      renderAnnotationIndex(snapshot.annotations, options)
    );
    await this.writeVaultFile(
      this.cellIndexPath(),
      renderCellIndex(snapshot.cells, options)
    );
    await this.writeVaultFile(
      this.sceneIndexPath(),
      renderSceneIndex(snapshot.scenes, options)
    );
    if (this.getSettings().createAgentInstructions) {
      await this.writeVaultFile(
        this.agentsPath(),
        renderAgentInstructions(options)
      );
    }
  }

  private async archiveProposal(
    pendingPath: string,
    proposal: MemoryProposal
  ): Promise<void> {
    const archivePath = `${this.archivedProposalsDir()}/${proposal.id}.md`;
    await this.writeVaultFile(archivePath, serializeProposal(proposal));
    const pending = this.fileAt(pendingPath);
    if (pending) await this.app.vault.delete(pending);
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
    if (file) {
      await this.app.vault.modify(file, content);
    } else {
      await this.ensureFolder(parentPath(path));
      await this.app.vault.create(path, content);
    }
    this.markWritten(path);
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    if (!this.fileAt(path)) {
      await this.ensureFolder(parentPath(path));
      await this.app.vault.create(path, content);
      this.markWritten(path);
    }
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
