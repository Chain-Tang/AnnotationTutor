import { BoardLayoutStore } from "./board-layout-store.js";
import type { BoardLayoutManifest } from "./board-layout.js";
import type { BoardSourceIdentity } from "./board-source-identity.js";
import { beginTutorActivity } from "./interaction-activity.js";
/** Dedicated board sidecars. Deliberately independent from the learning index. */
import type {
  BoardBundle,
  BoardDocument,
  BoardInk,
  BoardInkManifest,
  BoardObject,
  BoardAssetLibraryState,
  BoardExpression,
  BoardSemanticGroup,
  TutorCharacterProfile,
} from "./board-types.js";
import {
  createBoardDocument,
  comparableBoardSourceDocument,
  boardInkSchema,
  inkStrokeSchema,
  parseBoardDocument,
  tutorCharacterProfileSchema,
  validateBoardDocument,
  validateBoardInk,
  upgradeBoardDocument,
} from "./board-model.js";
import { boardStickerExpressions, boardStickerKey, builtInBoardAssets } from "./board-characters.js";
import { BoardDraftStore, boardDraftFile, boardDraftBytes, boardDraftHash, boardDraftBundleHash, type BoardDraftFile, type BoardDraftTicket } from "./board-draft.js";

function assetReference(object: BoardObject): { id: string; version: number } | null {
  if (object.kind === "sticker" && object.assetId && object.assetVersion)
    return { id: object.assetId, version: object.assetVersion };
  if (object.kind === "character" && object.characterId && object.characterVersion)
    return { id: object.characterId, version: object.characterVersion };
  return null;
}
const assetKey = (profile: { id: string; version: number }): string => `${profile.id}:${profile.version}`;

export interface BoardStorageAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  /** Obsidian adapters provide an atomic read/modify/write for existing files. */
  process?(path: string, update: (current: string) => string): Promise<string>;
}

export class BoardConflictError extends Error {
  public constructor(
    public readonly localPath: string,
    public readonly externalPath: string,
  ) {
    super(
      `Board changed outside Tutor; both versions were preserved: ${localPath}`,
    );
    this.name = "BoardConflictError";
  }
}

function normalizeBoardPath(path: string): string {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error("Board storage requires a vault-relative path");
  }
  return normalized;
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id))
    throw new Error("Invalid board or ink ID");
}

async function ensureFolder(
  adapter: BoardStorageAdapter,
  path: string,
): Promise<void> {
  let current = "";
  for (const segment of path.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    if (await adapter.exists(current)) continue;
    try {
      await adapter.mkdir(current);
    } catch (error) {
      if (!(await adapter.exists(current))) throw error;
    }
  }
}

function escapeMarkdownLink(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\|/g, "\\|")
    .replace(/\]/g, "\\]")
    .replace(/[\r\n]/g, " ");
}

type OpenBoard = {
  document: BoardDocument;
  ink: BoardInk;
  raw: string | null;
  validRaw: string | null;
  recovery?: BoardBundle["recovery"];
  recoveryBaseHash?: string | null;
  /** Immutable samples belonging to the recovered branch, not the outside authority. */
  recoveryInk?: BoardInk;
  draft?: BoardBundle;
};
export type BoardExternalChange = {
  boardId: string;
  affectedBoardIds?: string[];
  path: string;
  changed: true;
  stale: true;
};
export type BoardSourceMoveReceipt = {
  boardId: string;
  from: string;
  to: string;
  durability: "committed" | "recovery-only" | "recovered-conflict";
};

/** A view freezes its original scene until the repository verifies the new source. */
export type BoardSourceMoveParticipant = {
  prepare(requireSaved?: boolean): Promise<BoardBundle>;
  accept(bundle: BoardBundle, receipt: BoardSourceMoveReceipt): void | Promise<void>;
  replaceVersion?(bundle: BoardBundle): Promise<void>;
  release(): void;
};

export type BoardSourceBranch = { id: string; hash: string; title: string; revision: number; objects: number };
export type BoardSourceChoices = { source: string; sourceType: BoardDocument["sourceType"]; branches: BoardSourceBranch[]; identityRevision: number | null; selectedId?: string };
export class BoardSourceBranchesError extends Error {
  public constructor(public readonly source: string, public readonly sourceType: BoardDocument["sourceType"], public readonly branches: BoardSourceBranch[], public readonly identityRevision: number | null) {
    super("board-source-branches"); this.name = "BoardSourceBranchesError";
  }
}
type SourceCandidate = { path: string; raw: string | null; validRaw: string; document: BoardDocument; branch: BoardSourceBranch };

export class BoardRepository {
  public readonly memoryRoot: string;
  public readonly layouts: BoardLayoutStore;
  private readonly opened = new Map<string, OpenBoard>();
  private tail: Promise<void> = Promise.resolve();
  private readonly writeErrors = new Map<string, unknown>();
  private readonly inkConflicts = new Map<string, Set<string>>();

  public constructor(
    private readonly adapter: BoardStorageAdapter,
    memoryRoot: string,
    private readonly drafts?: BoardDraftStore,
  ) {
    this.memoryRoot = normalizeBoardPath(memoryRoot || "Agent Memory");
    this.layouts = new BoardLayoutStore(adapter,this.memoryRoot);
  }
  public boardPath(boardId: string): string {
    assertSafeId(boardId);
    return `${this.memoryRoot}/boards/${boardId}.board.json`;
  }
  public inkPath(inkId: string): string {
    assertSafeId(inkId);
    return `${this.memoryRoot}/ink/${inkId}.ink.json`;
  }
  public inkPackPath(boardId: string, packId: string): string {
    assertSafeId(boardId);
    assertSafeId(packId);
    return `${this.memoryRoot}/ink-packs/${boardId}/${packId}.inkpack.json`;
  }
  public tilePath(boardId: string, layerId: string, tileKey: string, revision: number): string {
    assertSafeId(boardId);
    assertSafeId(layerId);
    if (!/^-?\d+:-?\d+$/.test(tileKey) || !Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Invalid board tile identity");
    return `${this.memoryRoot}/tiles/${boardId}/${layerId}/${tileKey.replace(":", "_")}.r${revision}.rgba.deflate`;
  }
  public async writeTile(boardId: string, layerId: string, tileKey: string, revision: number, data: ArrayBuffer): Promise<string> {
    const path = this.tilePath(boardId, layerId, tileKey, revision);
    await this.writeBinaryAsset(path, data);
    return path;
  }
  public async readTile(path: string): Promise<ArrayBuffer | null> {
    const safe = normalizeBoardPath(path);
    if (!safe.startsWith(`${this.memoryRoot}/tiles/`) || !safe.endsWith(".rgba.deflate")) throw new Error("Invalid board tile path");
    if (!(await this.adapter.exists(safe))) return null;
    return this.readBinaryAsset(safe);
  }
  public brushResourcePath(hash: string, extension: "png" | "webp"): string {
    if (!/^[a-f\d]{64}$/i.test(hash)) throw new Error("Invalid brush resource hash");
    return `${this.memoryRoot}/brushes/resources/${hash.toLowerCase()}.${extension}`;
  }
  public async writeBinaryAsset(path: string, data: ArrayBuffer): Promise<void> {
    const safe = normalizeBoardPath(path);
    if (!safe.startsWith(`${this.memoryRoot}/`)) throw new Error("Board assets must remain inside the board store");
    if (!this.adapter.writeBinary) throw new Error("Binary board assets are unsupported by this Vault adapter");
    await ensureFolder(this.adapter, safe.slice(0, safe.lastIndexOf("/")));
    await this.adapter.writeBinary(safe, data);
  }
  public async readBinaryAsset(path: string): Promise<ArrayBuffer> {
    const safe = normalizeBoardPath(path);
    if (!safe.startsWith(`${this.memoryRoot}/`)) throw new Error("Board assets must remain inside the board store");
    if (!this.adapter.readBinary) throw new Error("Binary board assets are unsupported by this Vault adapter");
    return this.adapter.readBinary(safe);
  }
  public async references(): Promise<Array<{path:string; prompt:string}>> {
    const folder=`${this.memoryRoot}/references`;
    if(!await this.adapter.exists(folder)) return [];
    const files=(await this.adapter.list(folder)).files.filter(path =>
      path.startsWith(folder+"/") && !path.slice(folder.length+1).includes("/") && /\.(png|jpe?g|webp)$/i.test(path)).slice(-200);
    return Promise.all(files.map(async path=>{
      let prompt="";
      try {const raw=await this.adapter.read(path+".json");
        if(raw.length<=64_000){const meta=JSON.parse(raw);if(typeof meta.prompt==="string")prompt=meta.prompt.slice(0,2000);}}
      catch { /* An original remains reusable if its optional metadata is missing. */ }
      return {path,prompt};
    }));
  }
  public async readReference(path:string):Promise<{bytes:Uint8Array;mimeType:"image/png"|"image/jpeg"|"image/webp"}> {
    const safe=normalizeBoardPath(path),folder=`${this.memoryRoot}/references/`;
    if(!safe.startsWith(folder)||safe.slice(folder.length).includes("/")||!/\.(png|jpe?g|webp)$/i.test(safe))
      throw new Error("invalid-reference-path");
    const bytes=new Uint8Array(await this.readBinaryAsset(safe));
    if(!bytes.length||bytes.length>20*1024*1024)throw new Error("invalid-reference-size");
    return {bytes,mimeType:/\.webp$/i.test(safe)?"image/webp":/\.jpe?g$/i.test(safe)?"image/jpeg":"image/png"};
  }
  public characterPath(characterId: string, version: number): string {
    assertSafeId(characterId);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error("Invalid character version");
    return `${this.memoryRoot}/characters/${characterId}.v${version}.character.json`;
  }
  public characterLibraryPath(): string {
    return `${this.memoryRoot}/characters/library.json`;
  }
  public isWatchedPath(path: string): boolean {
    return ["boards", "ink", "ink-packs", "tiles", "brushes", "characters"].some((dir) =>
      path.startsWith(`${this.memoryRoot}/${dir}/`),
    );
  }

  /** Reading an absent board does not create files or a new board identity. */
  public read(
    sourceFile: string,
    sourceType: BoardDocument["sourceType"],
  ): Promise<BoardBundle | null> {
    return this.enqueue(async () => {
      const source = normalizeBoardPath(sourceFile);
      const state = await this.sourceCandidates(source, sourceType);
      const cached = [...this.opened.values()].find(entry => entry.document.sourceFile === source && entry.document.sourceType === sourceType);
      if (cached && (!state.identity || state.identity.boardId === cached.document.id) && (!state.selected || state.selected.document.id === cached.document.id))
        return structuredClone(cached.draft ?? { document: cached.document, ink: cached.ink });
      return this.readRecoverable(source, sourceType);
    });
  }
  public open(
    sourceFile: string,
    sourceType: BoardDocument["sourceType"],
  ): Promise<BoardBundle> {
    return this.enqueue(async () => {
      const source = normalizeBoardPath(sourceFile);
      const existing = await this.readRecoverable(source, sourceType);
      if (existing) {
        await this.drafts?.identities.assert(this.memoryRoot, source, sourceType, existing.document.id);
        if (existing.recovery || await this.readIfExists(this.boardPath(existing.document.id)) !== null)
          await this.drafts?.identities.markWork(this.memoryRoot, source, sourceType, existing.document.id);
        return existing;
      }
      const candidate = createBoardDocument(source, sourceType);
      const boardId = await this.drafts?.identities.claim(this.memoryRoot, source, sourceType, candidate.id) ?? candidate.id;
      // A competing creator can save while the reservation is being read.
      const published = await this.readRecoverable(source, sourceType);
      if (published) return published;
      const document = { ...candidate, id: boardId };
      this.opened.set(document.id, {
        document,
        ink: {},
        raw: null,
        validRaw: null,
      });
      return structuredClone({ document, ink: {} });
    });
  }

  /** Capture inputs now, then serialize writes; ink never races the manifest. */
  public save(
    document: BoardDocument,
    ink: BoardInk,
    previewSvg?: string,
    layout?: BoardLayoutManifest,
  ): Promise<void> {
    // Reflect the manifest in the caller's detached snapshot as well, so a
    // same-session reopen observes the exact authoritative v3 document.
    const known = this.opened.get(document.id);
    const isDerivedArtifactRetry = this.writeErrors.has(document.id) && !!known &&
      known.document.schemaVersion === document.schemaVersion &&
      known.document.revision === document.revision &&
      JSON.stringify(known.document) === JSON.stringify(document);
    if (!isDerivedArtifactRetry) Object.assign(document, upgradeBoardDocument(document));
    document.inkManifest = this.buildInkManifest(document.inkManifest, ink);
    const snapshot = validateBoardDocument(structuredClone(document));
    const capturedManifest = JSON.stringify(document.inkManifest);
    const strokes = structuredClone(ink);
    validateBoardInk(snapshot, strokes);
    return this.enqueue(() => this.persistSnapshot(snapshot, strokes, previewSvg, document, capturedManifest, layout ? structuredClone(layout) : undefined), snapshot.id);
  }

  private async persistSnapshot(snapshot: BoardDocument, strokes: BoardInk, previewSvg?: string, document?: BoardDocument, capturedManifest?: string, layout?: BoardLayoutManifest): Promise<void> {
    const priorSource = this.opened.get(snapshot.id);
    if (this.drafts && priorSource && priorSource.document.sourceFile !== snapshot.sourceFile && priorSource.raw === null &&
      !priorSource.recovery && !priorSource.document.objects.length && !Object.keys(priorSource.ink).length) {
      // Studio creates an empty scratch identity before its real Vault entry.
      // Only that empty, never-saved source may be rebound without a draft move.
      const pending = await this.drafts.read(this.memoryRoot, priorSource.document.sourceFile, snapshot.sourceType);
      if (pending) throw new Error("board-source-rebind-required");
      await this.drafts.identities.move(this.memoryRoot, priorSource.document.sourceFile, snapshot.sourceFile, snapshot.sourceType, snapshot.id);
    }
    const sourceCandidates = await this.sourceCandidates(snapshot.sourceFile, snapshot.sourceType);
    if (sourceCandidates.selected && sourceCandidates.selected.document.id !== snapshot.id) throw new Error("board-source-identity-conflict");
    await this.drafts?.identities.assert(this.memoryRoot, snapshot.sourceFile, snapshot.sourceType, snapshot.id);
    // The previous queued save may have published different pack identities.
    // Freeze this save's immutable references before writing its recovery record.
    snapshot.inkManifest = this.prepareInkManifest(snapshot, strokes);
    if (document && document.revision === snapshot.revision && JSON.stringify(document.inkManifest) === capturedManifest)
      document.inkManifest = structuredClone(snapshot.inkManifest);
    const assetConflicts = await this.refreshInkConflicts(snapshot.id, strokes);
    let ticket: BoardDraftTicket | undefined, backupError: unknown;
    if (this.drafts) {
      const prior = this.opened.get(snapshot.id);
      try {
        const files = await this.draftDependencies(snapshot);
        ticket = await this.drafts.capture(this.memoryRoot, { document: snapshot, ink: strokes, ...(layout?{layout}: {}) },
          prior?.recovery?.baseline ?? prior?.document ?? snapshot, prior?.raw ?? null, files,
          { assetConflicts, ...(prior?.recovery ? { baseHash: prior.recoveryBaseHash } : {}) });
        if (prior?.draft) prior.draft = { ...prior.draft, document: structuredClone(snapshot), ink: structuredClone(strokes) };
      } catch (error) { backupError = error; }
    }
    if (backupError instanceof Error && ["board-draft-conflict", "board-draft-source-moved", "board-draft-move-conflict", "state-file-conflict", "state-file-locked"].includes(backupError.message)
      && (backupError.message === "board-draft-source-moved" || !this.opened.get(snapshot.id)?.recovery?.conflicted)) throw backupError;
    try {
      if(layout){await ensureFolder(this.adapter,`${this.memoryRoot}/boards`);await this.layouts.prepare(layout,snapshot);}
      await this.saveInternal(snapshot, strokes, previewSvg);
      if(layout)await this.layouts.commit(layout);
    }
    catch (error) {
      const committed = this.opened.get(snapshot.id);
      const authoritySaved = !(error instanceof BoardConflictError) && !!this.drafts && committed?.raw != null && !committed.recovery &&
        (await this.readIfExists(this.boardPath(snapshot.id))) === committed.raw &&
        await boardDraftBundleHash({ document: committed.document, ink: committed.ink }) === await boardDraftBundleHash({ document: snapshot, ink: strokes });
      if (authoritySaved && ticket && !layout) {
        // Identity confirmation must precede discarding the complete recovery copy.
        const indexed = await this.drafts!.identities.markWork(this.memoryRoot, snapshot.sourceFile, snapshot.sourceType, snapshot.id).then(() => true, () => false);
        if (indexed) await this.drafts!.resolve(ticket).catch(() => {});
      }
      if (backupError && !authoritySaved && !(error instanceof BoardConflictError))
        throw new AggregateError([error, backupError], "Board save and recovery backup failed; keep this view open");
      throw error;
    }
    // Failure here preserves the draft. The scene was saved, but its locator
    // must not later mistake missing authority files for a fresh empty source.
    try { await this.drafts?.identities.markWork(this.memoryRoot, snapshot.sourceFile, snapshot.sourceType, snapshot.id); }
    catch (error) { throw new AggregateError([error], "Board saved; source identity could not be confirmed. Recovery data is preserved."); }
    // Cleanup is not authority. A committed scene remains successful if the journal is unavailable.
    if (ticket) await this.drafts!.resolve(ticket).catch(() => {});
  }

  public async flush(): Promise<void> {
    await this.tail;
    for (const error of this.writeErrors.values())
      if (!(error instanceof BoardConflictError)) throw error;
  }

  public onExternalChange(path: string): Promise<BoardExternalChange | null> {
    return this.enqueue(async () => {
      if (!this.isWatchedPath(path)) return null;
      const affectedBoardIds: string[] = [];
      for (const [boardId, opened] of this.opened) {
        if(path===this.layouts.path(boardId)){if(await this.layouts.changed(boardId))affectedBoardIds.push(boardId);continue;}
        if (path === this.boardPath(boardId)) {
          const raw = await this.readIfExists(path);
          if (raw !== opened.raw) affectedBoardIds.push(boardId);
          continue;
        }
        const changed = await this.externalInkChanged(path, opened.recovery?.baseline ?? opened.document, opened.draft?.ink ?? opened.ink);
        if (changed) {
          const paths = this.inkConflicts.get(boardId) ?? new Set<string>(); paths.add(path); this.inkConflicts.set(boardId, paths);
          affectedBoardIds.push(boardId);
        } else {
          this.inkConflicts.get(boardId)?.delete(path);
          if (!this.inkConflicts.get(boardId)?.size) this.inkConflicts.delete(boardId);
        }
      }
      return affectedBoardIds.length ? { boardId: affectedBoardIds[0]!, affectedBoardIds, path, changed: true, stale: true } : null;
    });
  }

  /** Only event-invalidated files are re-read; normal saves keep immutable caches. */
  private async refreshInkConflicts(boardId: string, ink: BoardInk): Promise<string[]> {
    const paths = this.inkConflicts.get(boardId), opened = this.opened.get(boardId);
    if (!paths || !opened) return [];
    for (const path of paths) if (!await this.externalInkChanged(path, opened.recovery?.baseline ?? opened.document, ink)) paths.delete(path);
    if (!paths.size) this.inkConflicts.delete(boardId);
    return [...paths].sort();
  }
  private async externalInkChanged(path: string, document: BoardDocument, ink: BoardInk): Promise<boolean> {
    const packPrefix = `${this.memoryRoot}/ink-packs/${document.id}/`, rawPrefix = `${this.memoryRoot}/ink/`;
    const pack = path.startsWith(packPrefix) && path.endsWith(".inkpack.json")
      ? document.inkManifest?.packs.find(pack => path === this.inkPackPath(document.id, pack.id)) : undefined;
    const rawId = path.startsWith(rawPrefix) && path.endsWith(".ink.json") ? path.slice(rawPrefix.length, -".ink.json".length) : undefined;
    const strokeId = rawId && Object.hasOwn(ink, rawId) ? rawId : undefined;
    if (!pack && !strokeId) return false;
    try {
      const raw = await this.readIfExists(path); if (raw === null) return true;
      if (strokeId) return JSON.stringify(inkStrokeSchema.parse(JSON.parse(raw))) !== JSON.stringify(inkStrokeSchema.parse(ink[strokeId]));
      const value = JSON.parse(raw);
      if (value?.format !== "ink-pack-v1" || value.boardId !== document.id || value.packId !== pack!.id) return true;
      const diskInk = boardInkSchema.parse(value.strokes);
      return pack!.strokeIds.some(id => !Object.hasOwn(ink, id) || !Object.hasOwn(diskInk, id) || JSON.stringify(inkStrokeSchema.parse(diskInk[id])) !== JSON.stringify(inkStrokeSchema.parse(ink[id])));
    } catch { return true; }
  }

  public renameSource(oldPath: string, newPath: string, live: readonly BoardBundle[] = []): Promise<BoardSourceMoveReceipt[]> {
    const captured = structuredClone(live);
    return this.enqueue(async () => {
      const before = normalizeBoardPath(oldPath),
        after = normalizeBoardPath(newPath);
      const receipts: BoardSourceMoveReceipt[] = [];
      if (before === after) return receipts;
      for (const sourceType of ["markdown", "pdf", "standalone"] as const) {
        const forwarded = await this.drafts?.movedTo(this.memoryRoot, before, sourceType);
        if (forwarded && forwarded.source !== after) continue; // A late event cannot move a newer route backwards.
        let bundle = forwarded ? await this.readRecoverable(after, sourceType) : await this.readRecoverable(before, sourceType);
        if (!bundle) continue;
        if (!forwarded) {
          const retiredTarget = await this.drafts?.movedTo(this.memoryRoot, after, sourceType);
          const target = retiredTarget?.source === before && retiredTarget.boardId === bundle.document.id
            ? null : await this.readRecoverable(after, sourceType);
          if (target && target.document.id !== bundle.document.id) throw new Error("board-draft-target-conflict");
          if (target) bundle = target; // Complete a destination copy left by an interrupted move.
          else {
            await this.drafts?.identities.validateMove(this.memoryRoot, before, after, sourceType, bundle.document.id);
            const snapshots = captured.filter(candidate => candidate.document.sourceFile === before && candidate.document.sourceType === sourceType);
            for (const candidate of snapshots) {
              if (candidate.document.id !== bundle.document.id) throw new Error("board-draft-target-conflict");
              validateBoardInk(candidate.document, candidate.ink);
              if (candidate.document.revision > bundle.document.revision) bundle = structuredClone(candidate);
              else if (candidate.document.revision === bundle.document.revision && await boardDraftBundleHash({ document: comparableBoardSourceDocument(candidate.document), ink: candidate.ink }) !== await boardDraftBundleHash({ document: comparableBoardSourceDocument(bundle.document), ink: bundle.ink }))
                throw new Error("board-draft-conflict");
            }
            const known = this.opened.get(bundle.document.id)!;
            if (!bundle.document.inkManifest) bundle.document = upgradeBoardDocument(bundle.document);
            if (this.drafts) {
              const files = await this.draftDependencies(bundle.document), assetConflicts = await this.refreshInkConflicts(bundle.document.id, bundle.ink);
              const previous = await this.drafts.read(this.memoryRoot, before, sourceType);
              const alreadyBackedUp = previous && await boardDraftBundleHash(previous.bundle) === await boardDraftBundleHash(bundle);
              const baseline = alreadyBackedUp ? previous.baseline : known.recovery?.baseline ?? known.document;
              const options = { assetConflicts, ...(alreadyBackedUp ? { baseHash: previous.baseHash } : known.recovery ? { baseHash: known.recoveryBaseHash } : {}) };
              // Preserve the latest live input before publishing any path change.
              if (!alreadyBackedUp) {
                bundle.document.inkManifest = this.prepareInkManifest(bundle.document, bundle.ink);
                await this.drafts.capture(this.memoryRoot, bundle, baseline, known.raw, files, options);
              }
              await this.drafts.relocate(this.memoryRoot, before, after, bundle, baseline, known.raw, files, options);
              bundle = (await this.readRecoverable(after, sourceType))!;
            } else {
              bundle.document.inkManifest = this.prepareInkManifest(bundle.document, bundle.ink);
              bundle.document.sourceFile = after; bundle.document.revision++; bundle.document.updatedAt = new Date().toISOString();
            }
          }
        }
        try {
          await this.persistSnapshot(bundle.document, bundle.ink,undefined,undefined,undefined,bundle.layout);
          this.writeErrors.delete(bundle.document.id);
          receipts.push({ boardId: bundle.document.id, from: before, to: after, durability: "committed" });
        } catch (error) {
          if (!this.drafts) throw error;
          const pending = await this.drafts.read(this.memoryRoot, after, sourceType);
          // Only a verified new-path draft can release the old view. A failed
          // backup or unknown outcome keeps the original view and error intact.
          if (!pending || await boardDraftBundleHash(pending.bundle) !== await boardDraftBundleHash(bundle)) throw error;
          this.writeErrors.set(bundle.document.id, error);
          receipts.push({ boardId: bundle.document.id, from: before, to: after,
            durability: error instanceof BoardConflictError ? "recovered-conflict" : "recovery-only" });
        }
      }
      return receipts;
    }, `rename:${oldPath}`);
  }

  /** Profiles are immutable versions. Co-created raw ink uses the shared ink store. */
  public async saveTranscript(document:BoardDocument,group:BoardSemanticGroup,vaultName:string):Promise<string>{
    assertSafeId(group.id);if(!group.recognition)throw new Error("missing-transcription");
    const folder=`${this.memoryRoot}/ink/transcripts`,path=`${folder}/${group.id}.md`;
    return this.enqueue(async()=>{
      await ensureFolder(this.adapter,folder);
      const uri=`obsidian://tutor-ink?vault=${encodeURIComponent(vaultName)}&source=${encodeURIComponent(document.sourceFile)}&objects=${encodeURIComponent(group.objectIds.join(","))}`;
      const record={format:"tutor-transcript-v1",boardId:document.id,sourceFile:document.sourceFile,group};
      await this.adapter.write(`${folder}/${group.id}.json`,JSON.stringify(record,null,2));
      await this.adapter.write(path,`# Handwriting transcription\n\n[Locate original ink](${uri}) · [[${escapeMarkdownLink(document.sourceFile)}]]\n\n${group.recognition!.text}\n\nSource objects: ${group.objectIds.join(", ")}\n`);return path;
    });
  }

  public async saveCharacter(profile: TutorCharacterProfile, dependencies: readonly TutorCharacterProfile[] = []): Promise<void> {
    const snapshot = tutorCharacterProfileSchema.parse(
      structuredClone(profile),
    );
    const supplied = new Map(dependencies.map(dependency => {
      const valid = tutorCharacterProfileSchema.parse(structuredClone(dependency));
      return [assetKey(valid), valid] as const;
    }));
    supplied.set(assetKey(snapshot), snapshot);
    return this.enqueue(async () => {
      const builtins = new Map(builtInBoardAssets().map(asset => [assetKey(asset), asset]));
      const ordered: TutorCharacterProfile[] = [];
      const done = new Set<string>();
      const visit = async (asset: TutorCharacterProfile, ancestry: Set<string>): Promise<void> => {
        const key = assetKey(asset);
        if (ancestry.has(key) || ancestry.size >= 8) throw new Error("Recursive or excessively nested asset dependency");
        if (done.has(key)) return;
        if (builtins.has(key)) {
          if (asset.origin !== "builtin") throw new Error("Built-in asset identity is reserved");
          done.add(key);
          return;
        }
        await this.validateAssetFile(asset);
        const next = new Set([...ancestry, key]);
        for (const object of asset.objects ?? []) {
          const reference = assetReference(object);
          if (!reference) continue;
          const dependencyKey = assetKey(reference);
          let dependency = builtins.get(dependencyKey) ?? supplied.get(dependencyKey);
          if (!dependency) {
            const path = this.characterPath(reference.id, reference.version);
            if (!(await this.adapter.exists(path))) throw new Error(`Missing versioned asset dependency: ${dependencyKey}`);
            dependency = await this.readCharacter(path);
          }
          await visit(dependency, next);
        }
        done.add(key);
        ordered.push(asset);
      };
      await visit(snapshot, new Set());
      for (const asset of ordered) {
        await this.writeInk(asset.ink ?? {});
        await ensureFolder(this.adapter, `${this.memoryRoot}/characters`);
        const { ink: _ink, ...manifest } = asset;
        const serialized = JSON.stringify(manifest, null, 2) + "\n";
        const path = this.characterPath(asset.id, asset.version);
        const previous = await this.readIfExists(path);
        if (previous !== null && previous !== serialized)
          throw new Error("Character versions are immutable; save a new version");
        if (previous === null) await this.adapter.write(path, serialized);
      }
      // Saving a new version makes a previously hidden custom asset discoverable again.
      if (snapshot.origin !== "builtin") await this.writeCharacterLibraryHidden(snapshot.id, false);
    });
  }

  public characterLibraryState(): Promise<BoardAssetLibraryState> {
    return this.enqueue(() => this.readCharacterLibraryState());
  }

  /** Hide/unhide a custom profile without deleting immutable manifests or image data. */
  public setCharacterHidden(id: string, hidden: boolean): Promise<BoardAssetLibraryState> {
    assertSafeId(id);
    if (builtInBoardAssets().some(asset => asset.id === id))
      return Promise.reject(new Error("Built-in assets cannot be removed from the library"));
    return this.enqueue(() => this.writeCharacterLibraryHidden(id, hidden));
  }

  /** A built-in expression can leave this user's picker without changing old boards. */
  public setBuiltInStickerHidden(id: string, expression: BoardExpression, hidden: boolean): Promise<BoardAssetLibraryState> {
    assertSafeId(id);
    const profile = builtInBoardAssets().find(asset => asset.id === id);
    if (!profile || !boardStickerExpressions(profile).includes(expression))
      return Promise.reject(new Error("Unknown built-in expression"));
    return this.enqueue(async () => {
      const current = await this.readCharacterLibraryState();
      const keys = new Set(current.hiddenStickerKeys);
      const key = boardStickerKey(profile, expression);
      if (hidden) keys.add(key); else keys.delete(key);
      if (keys.size === current.hiddenStickerKeys.length && current.hiddenStickerKeys.includes(key) === hidden) return current;
      const next: BoardAssetLibraryState = {...current, hiddenStickerKeys: [...keys].sort(), updatedAt: new Date().toISOString()};
      await ensureFolder(this.adapter, `${this.memoryRoot}/characters`);
      await this.adapter.write(this.characterLibraryPath(), JSON.stringify(next, null, 2) + "\n");
      return next;
    });
  }

  /** All stored versions are available so historical boards retain their appearance. */
  public characters(): Promise<TutorCharacterProfile[]> {
    return this.enqueue(async () => {
      const folder = `${this.memoryRoot}/characters`;
      if (!(await this.adapter.exists(folder))) return [];
      const { files } = await this.adapter.list(folder);
      const profiles: TutorCharacterProfile[] = [];
      for (const path of files
        .filter((path) => path.endsWith(".character.json"))
        .sort()) {
        try {
          profiles.push(await this.readCharacter(path));
        } catch {
          /* A broken profile must not hide every other valid character. */
        }
      }
      return profiles;
    });
  }

  public getCharacter(
    id: string,
    version: number,
  ): Promise<TutorCharacterProfile | null> {
    return this.enqueue(async () => {
      const path = this.characterPath(id, version);
      return (await this.adapter.exists(path))
        ? this.readCharacter(path)
        : null;
    });
  }

  private enqueue<T>(
    operation: () => Promise<T>,
    writeKey?: string,
  ): Promise<T> {
    const done=beginTutorActivity();
    const result = this.tail.then(operation).finally(done);
    this.tail = result.then(
      () => {
        if (writeKey) this.writeErrors.delete(writeKey);
      },
      (error) => {
        if (writeKey) this.writeErrors.set(writeKey, error);
      },
    );
    return result;
  }
  private async readIfExists(path: string): Promise<string | null> {
    return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
  }
  private async readCharacterLibraryState(): Promise<BoardAssetLibraryState> {
    const raw = await this.readIfExists(this.characterLibraryPath());
    if (!raw) return { formatVersion: 1, hiddenProfileIds: [], hiddenStickerKeys: [], updatedAt: new Date(0).toISOString() };
    try {
      const value = JSON.parse(raw) as Partial<BoardAssetLibraryState>;
      const hiddenProfileIds = Array.isArray(value.hiddenProfileIds)
        ? [...new Set(value.hiddenProfileIds.filter(item => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(item)))].sort()
        : [];
      const hiddenStickerKeys = Array.isArray(value.hiddenStickerKeys)
        ? [...new Set(value.hiddenStickerKeys.filter(item => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}:v[1-9]\d{0,5}:(thinking|curious|discovery|encouraging|celebrating|quiet)$/.test(item)))].sort()
        : [];
      return { formatVersion: 1, hiddenProfileIds, hiddenStickerKeys, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString() };
    } catch {
      return { formatVersion: 1, hiddenProfileIds: [], hiddenStickerKeys: [], updatedAt: new Date(0).toISOString() };
    }
  }
  private async writeCharacterLibraryHidden(id: string, hidden: boolean): Promise<BoardAssetLibraryState> {
    const current = await this.readCharacterLibraryState();
    const ids = new Set(current.hiddenProfileIds);
    if (hidden) ids.add(id); else ids.delete(id);
    if (!hidden && ids.size === current.hiddenProfileIds.length) return current;
    const next: BoardAssetLibraryState = {
      formatVersion: 1,
      hiddenProfileIds: [...ids].sort(),
      hiddenStickerKeys: current.hiddenStickerKeys,
      updatedAt: new Date().toISOString(),
    };
    await ensureFolder(this.adapter, `${this.memoryRoot}/characters`);
    await this.adapter.write(this.characterLibraryPath(), JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  private async readRecoverable(source: string, sourceType: BoardDocument["sourceType"]): Promise<BoardBundle | null> {
    const cached = [...this.opened.values()].find(entry => entry.document.sourceFile === source && entry.document.sourceType === sourceType);
    if (cached?.draft) {
      const candidates = await this.sourceCandidates(source, sourceType);
      if ((!candidates.identity || candidates.identity.boardId === cached.document.id) && (!candidates.selected || candidates.selected.document.id === cached.document.id)) return structuredClone(cached.draft);
    }
    const draft = await this.drafts?.read(this.memoryRoot, source, sourceType);
    let saved: BoardBundle | null;
    try { saved = await this.readInternal(source, sourceType); }
    catch (error) { if (!draft || error instanceof BoardSourceBranchesError || error instanceof Error && error.message.startsWith("board-source-")) throw error; saved = null; }
    if (!draft) return saved;
    if (saved && saved.document.id !== draft.bundle.document.id) throw new Error("board-draft-target-conflict");
    const assetConflicts = new Set<string>();
    for (const path of draft.assetConflicts ?? [])
      if (await this.externalInkChanged(path, draft.baseline, draft.bundle.ink)) assetConflicts.add(path);
    // Old drafts lack event metadata. Same IDs with different samples are a
    // conflict even if the board JSON itself has not changed.
    const changedSharedInk = !!saved && Object.entries(saved.ink).some(([id, stroke]) => Object.hasOwn(draft.bundle.ink, id) &&
      JSON.stringify(inkStrokeSchema.parse(stroke)) !== JSON.stringify(inkStrokeSchema.parse(draft.bundle.ink[id])));
    // Includes orphan undo ink: recovery must never duplicate a committed reply after cleanup fails.
    if (saved && !assetConflicts.size && !changedSharedInk && await boardDraftBundleHash(saved) === await boardDraftBundleHash(draft.bundle)) {
      await this.drafts!.identities.markWork(this.memoryRoot, source, sourceType, saved.document.id);
      await this.drafts!.acknowledge(this.memoryRoot, source, sourceType, draft.token).catch(() => {});
      return saved;
    }
    const path = this.boardPath(draft.bundle.document.id), raw = await this.readIfExists(path);
    const conflicted = assetConflicts.size > 0 || changedSharedInk || (raw === null ? null : await boardDraftHash(raw)) !== draft.baseHash;
    if (assetConflicts.size) this.inkConflicts.set(draft.bundle.document.id, assetConflicts);
    for (const file of draft.files) {
      const bytes = await boardDraftBytes(file);
      if (await this.adapter.exists(file.path)) {
        const existing = file.encoding === "utf8" ? await boardDraftFile(file.path, await this.adapter.read(file.path))
          : await boardDraftFile(file.path, await this.readBinaryAsset(file.path));
        if (existing.sha256 !== file.sha256) throw new Error("board-draft-asset-conflict");
      } else if (file.encoding === "utf8") {
        await ensureFolder(this.adapter, file.path.slice(0, file.path.lastIndexOf("/")));
        await this.adapter.write(file.path, bytes.toString("utf8"));
        if (await boardDraftHash(await this.adapter.read(file.path)) !== file.sha256) throw new Error("board-draft-asset-verification");
      } else {
        await this.writeBinaryAsset(file.path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        if ((await boardDraftFile(file.path, await this.readBinaryAsset(file.path))).sha256 !== file.sha256) throw new Error("board-draft-asset-verification");
      }
    }
    // Check completeness against the recovered document, not merely the supplied file list.
    const restoredFiles = await this.draftDependencies(draft.bundle.document);
    if (restoredFiles.length !== draft.files.length || restoredFiles.some(file => !draft.files.some(original => original.path === file.path && original.sha256 === file.sha256)))
      throw new Error("board-draft-incomplete");
    const baseline = saved?.document ?? draft.baseline;
    const bundle: BoardBundle = { ...structuredClone(draft.bundle), recovery: { baseline: structuredClone(draft.baseline), conflicted } };
    this.opened.set(bundle.document.id, { document: baseline, ink: saved?.ink ?? {}, raw, validRaw: saved ? JSON.stringify(saved.document, null, 2) + "\n" : null,
      recovery: bundle.recovery, recoveryBaseHash: draft.baseHash, recoveryInk: structuredClone(draft.bundle.ink), draft: bundle });
    return structuredClone(bundle);
  }

  /** Original ink is embedded in the draft. Derived tiles/previews can be rebuilt. */
  private async draftDependencies(document: BoardDocument): Promise<BoardDraftFile[]> {
    const files = new Map<string, BoardDraftFile>();
    const binary = async (path: string, hash?: string) => {
      const safe = normalizeBoardPath(path);
      if (!["characters/", "brushes/resources/", "paint-assets/"].some(folder => safe.startsWith(`${this.memoryRoot}/${folder}`))) throw new Error("board-draft-asset-path");
      if (files.has(safe)) return;
      const file = await boardDraftFile(safe, await this.readBinaryAsset(safe));
      if (hash && file.sha256 !== hash.toLowerCase()) throw new Error("board-draft-asset-checksum");
      files.set(safe, file);
    };
    const builtins = new Map(builtInBoardAssets().map(asset => [assetKey(asset), asset]));
    const visited = new Set<string>();
    const vectors = async (assets: BoardDocument["vectorAssets"]) => {
      for (const asset of assets ?? []) for (const node of asset.nodes) {
        if (!node.image) continue;
        const suffix = node.image.mimeType === "image/png" ? "png" : node.image.mimeType === "image/jpeg" ? "jpg" : "webp";
        await binary(`${this.memoryRoot}/characters/assets/${node.image.assetHash}.${suffix}`, node.image.assetHash);
      }
    };
    const visit = async (reference: { id: string; version: number }, ancestry: Set<string>) => {
      const key = assetKey(reference);
      if (ancestry.has(key) || ancestry.size >= 8) throw new Error("board-draft-asset-cycle");
      if (visited.has(key)) return;
      visited.add(key);
      let profile = builtins.get(key);
      if (!profile) {
        const path = this.characterPath(reference.id, reference.version), raw = await this.adapter.read(path);
        profile = tutorCharacterProfileSchema.parse(JSON.parse(raw));
        if (assetKey(profile) !== key) throw new Error("board-draft-asset-identity");
        files.set(path, await boardDraftFile(path, raw));
        if (profile.assetPath) await binary(profile.assetPath);
        for (const id of profile.objects?.flatMap(object => object.inkId ? [object.inkId] : []) ?? []) {
          const inkPath = this.inkPath(id), inkRaw = await this.adapter.read(inkPath);
          if (inkStrokeSchema.parse(JSON.parse(inkRaw)).id !== id) throw new Error("board-draft-ink-identity");
          files.set(inkPath, await boardDraftFile(inkPath, inkRaw));
        }
      }
      const next = new Set([...ancestry, key]);
      for (const object of profile.objects ?? []) { const ref = assetReference(object); if (ref) await visit(ref, next); }
      await vectors(profile.vectorAssets);
    };
    for (const object of document.objects) { const ref = assetReference(object); if (ref) await visit(ref, new Set()); }
    await vectors(document.vectorAssets);
    for (const operation of document.paintOperations ?? []) if (operation.maskAssetHash)
      await binary(`${this.memoryRoot}/paint-assets/${operation.maskAssetHash}.mask.deflate`);
    for (const brush of document.brushDefinitions ?? []) for (const ref of [brush.tip, brush.grain, brush.paper]) if (ref)
      await binary(ref.path ?? this.brushResourcePath(ref.hash, ref.mimeType === "image/png" ? "png" : "webp"), ref.hash);
    // Do not claim a resource-aware stroke with an unrepresented dependency is recoverable.
    const hashes = new Set([...files.values()].map(file => file.sha256));
    for (const brush of [...document.objects.flatMap(object => [object.brush, object.fill?.brush]), ...(document.paintOperations ?? []).map(operation => operation.brush)])
      for (const hash of [...(brush?.resourceHashes ?? []), brush?.tipHash, brush?.grainHash, brush?.paperHash])
        if (hash && !hashes.has(hash.toLowerCase())) throw new Error("board-draft-missing-brush");
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private async sourceCandidates(source: string, sourceType: BoardDocument["sourceType"]): Promise<{ candidates: SourceCandidate[]; selected?: SourceCandidate; identity: BoardSourceIdentity | null }> {
    const identity = await this.drafts?.identities.get(this.memoryRoot, source, sourceType) ?? null;
    if (identity?.movedTo) throw new Error("board-source-moved");
    const candidates: SourceCandidate[] = [];
    for (const path of await this.manifestPaths()) {
      const raw = await this.readIfExists(path);
      let document: BoardDocument, validRaw = raw;
      try { document = parseBoardDocument(raw ?? ""); }
      catch {
        validRaw = await this.readIfExists(path.replace(".board.json", ".previous.board.json"));
        if (!validRaw) continue;
        try { document = parseBoardDocument(validRaw); } catch { continue; }
      }
      if (document.sourceFile !== source || document.sourceType !== sourceType || path !== this.boardPath(document.id)) continue;
      const branch = { id: document.id, hash: "", title: document.title ?? "", revision: document.revision, objects: document.objects.length };
      candidates.push({ path, raw, validRaw: validRaw!, document, branch });
    }
    if (candidates.length > 32) throw new Error("board-source-branches-limit");
    // Fingerprints are needed for a version choice, not every ordinary pen save.
    // Avoid dispatching one asynchronous digest per unrelated manifest on that path.
    if (candidates.length > 1 || identity && candidates.length && candidates[0]!.document.id !== identity.boardId)
      await Promise.all(candidates.map(async candidate => { candidate.branch.hash = await boardDraftHash(JSON.stringify([candidate.raw, candidate.validRaw])); }));
    const selected = identity ? candidates.find(candidate => candidate.document.id === identity.boardId) : candidates[0];
    const others = candidates.filter(candidate => candidate !== selected);
    const acknowledged = identity && others.length === identity.alternatives.length && others.every(candidate => identity.alternatives.some(branch => branch.id === candidate.branch.id && branch.hash === candidate.branch.hash));
    if (candidates.length && (identity && !selected || others.length && !acknowledged))
      throw new BoardSourceBranchesError(source, sourceType, candidates.map(candidate => candidate.branch), identity?.revision ?? null);
    if (!selected && identity?.hasWork) {
      const pending = await this.drafts?.read(this.memoryRoot, source, sourceType);
      if (!pending || pending.bundle.document.id !== identity.boardId) throw new Error("board-source-data-missing");
    }
    return { candidates, selected, identity };
  }

  public inspectSourceBranch(sourceFile: string, sourceType: BoardDocument["sourceType"], branch: BoardSourceBranch): Promise<BoardBundle> {
    return this.enqueue(async () => {
      const source = normalizeBoardPath(sourceFile), [candidate] = await this.sourceCandidatesForChoice(source, sourceType, [branch]);
      if (!candidate) throw new Error("board-source-choice-stale");
      const document = candidate.document, ink = await this.loadInk(document.objects.flatMap(object => object.inkId ? [object.inkId] : []).concat(document.inkManifest?.packs.flatMap(pack => pack.strokeIds) ?? []), document);
      validateBoardInk(document, ink);
      return structuredClone({ document, ink });
    });
  }

  /** Explicit version navigation uses the same snapshots as ambiguity recovery.
   * It is read-only and does not broaden automatic document-open behavior. */
  public sourceBranchChoices(sourceFile: string, sourceType: BoardDocument["sourceType"]): Promise<BoardSourceChoices | null> {
    return this.enqueue(async () => {
      const source = normalizeBoardPath(sourceFile);
      try {
        const state = await this.sourceCandidates(source, sourceType);
        if (state.candidates.length < 2) return null;
        return { source, sourceType, branches: structuredClone(state.candidates.map(candidate => candidate.branch)), identityRevision: state.identity?.revision ?? null, selectedId: state.identity?.boardId };
      } catch (error) {
        if (!(error instanceof BoardSourceBranchesError)) throw error;
        return { source, sourceType, branches: structuredClone(error.branches), identityRevision: error.identityRevision };
      }
    });
  }

  /** Explicit recovery choice preserves every branch; only its locator is selected. */
  public selectSourceBranch(sourceFile: string, sourceType: BoardDocument["sourceType"], boardId: string, expected: readonly BoardSourceBranch[], identityRevision: number | null, isCurrent = () => true): Promise<BoardBundle> {
    return this.enqueue(async () => {
      if (!this.drafts) throw new Error("board-source-choice-storage-unavailable");
      const source = normalizeBoardPath(sourceFile);
      let candidates: SourceCandidate[], currentRevision: number | null;
      try { const state = await this.sourceCandidates(source, sourceType); candidates = state.candidates; currentRevision = state.identity?.revision ?? null; }
      catch (error) {
        if (!(error instanceof BoardSourceBranchesError)) throw error;
        // Obtain complete candidates without choosing an arbitrary branch.
        candidates = await this.sourceCandidatesForChoice(source, sourceType, error.branches); currentRevision = error.identityRevision;
      }
      if (currentRevision !== identityRevision || candidates.length !== expected.length || candidates.some(candidate => !expected.some(branch => branch.id === candidate.branch.id && branch.hash === candidate.branch.hash))) throw new Error("board-source-choice-stale");
      const selected = candidates.find(candidate => candidate.document.id === boardId);
      if (!selected) throw new Error("board-source-choice-stale");
      validateBoardInk(selected.document, await this.loadInk(selected.document.objects.flatMap(object => object.inkId ? [object.inkId] : []).concat(selected.document.inkManifest?.packs.flatMap(pack => pack.strokeIds) ?? []), selected.document));
      const pending = await this.drafts.read(this.memoryRoot, source, sourceType);
      if (pending && pending.bundle.document.id !== boardId) throw new Error("board-source-choice-pending-work");
      if (!isCurrent()) throw new Error("board-source-choice-stale");
      await this.drafts.identities.choose(this.memoryRoot, source, sourceType, boardId, candidates.filter(candidate => candidate !== selected).map(candidate => ({ id: candidate.branch.id, hash: candidate.branch.hash })), identityRevision);
      for (const [id, entry] of this.opened) if (entry.document.sourceFile === source && entry.document.sourceType === sourceType && id !== boardId) this.opened.delete(id);
      const result = await this.readRecoverable(source, sourceType);
      if (!result || result.document.id !== boardId) throw new Error("board-source-choice-stale");
      return result;
    });
  }
  private async sourceCandidatesForChoice(source: string, sourceType: BoardDocument["sourceType"], branches: readonly BoardSourceBranch[]): Promise<SourceCandidate[]> {
    const candidates: SourceCandidate[] = [];
    for (const branch of branches) {
      const path = this.boardPath(branch.id), raw = await this.readIfExists(path);
      let validRaw = raw, document: BoardDocument;
      try { document = parseBoardDocument(raw ?? ""); }
      catch { validRaw = await this.readIfExists(path.replace(".board.json", ".previous.board.json")); if (!validRaw) throw new Error("board-source-choice-stale"); document = parseBoardDocument(validRaw); }
      if (document.id !== branch.id || document.sourceFile !== source || document.sourceType !== sourceType || await boardDraftHash(JSON.stringify([raw, validRaw])) !== branch.hash) throw new Error("board-source-choice-stale");
      candidates.push({ path, raw, validRaw: validRaw!, document, branch });
    }
    return candidates;
  }

  private async readInternal(sourceFile: string, sourceType: BoardDocument["sourceType"]): Promise<BoardBundle | null> {
    const { selected, identity } = await this.sourceCandidates(sourceFile, sourceType);
    const cached = [...this.opened.values()].find(entry => entry.document.sourceFile === sourceFile && entry.document.sourceType === sourceType);
    if (!selected) {
      if (cached && cached.raw === null && (!identity || identity.boardId === cached.document.id)) return structuredClone({ document: cached.document, ink: cached.ink });
      return null;
    }
    const { path, raw } = selected;
    let { document, validRaw } = selected;
      let ink: BoardInk;
      try {
        ink = await this.loadInk(
          [
            ...document.objects.flatMap((object) => object.inkId ? [object.inkId] : []),
            ...(document.inkManifest?.packs.flatMap((pack) => pack.strokeIds) ?? []),
          ],
          document,
        );
      } catch (error) {
        const previousRaw = await this.readIfExists(path.replace(/\.board\.json$/, ".previous.board.json"));
        if (!previousRaw) throw error;
        const previous = parseBoardDocument(previousRaw);
        if (previous.sourceFile !== sourceFile || previous.sourceType !== sourceType) throw error;
        document = previous;
        validRaw = previousRaw;
        ink = await this.loadInk(
          [
            ...document.objects.flatMap((object) => object.inkId ? [object.inkId] : []),
            ...(document.inkManifest?.packs.flatMap((pack) => pack.strokeIds) ?? []),
          ],
          document,
        );
      }
      validateBoardInk(document, ink);
      this.opened.set(document.id, { document, ink, raw, validRaw });
      return structuredClone({ document, ink });
  }

  private async manifestPaths(): Promise<string[]> {
    const folder = `${this.memoryRoot}/boards`;
    if (!(await this.adapter.exists(folder))) return [];
    const { files } = await this.adapter.list(folder);
    const paths = new Set<string>();
    for (const path of files) {
      const name = path.slice(folder.length + 1);
      const match =
        /^([A-Za-z0-9][A-Za-z0-9_-]{0,159})(?:\.previous)?\.board\.json$/.exec(
          name,
        );
      if (match?.[1]) paths.add(this.boardPath(match[1]));
    }
    return [...paths].sort();
  }

  private async saveInternal(
    document: BoardDocument,
    ink: BoardInk,
    previewSvg?: string,
  ): Promise<void> {
    // save() already performed exactly one lazy migration step before queuing.
    // Do not advance a v1 snapshot twice while the write waits its turn.
    if (!document.inkManifest) throw new Error("Missing prepared ink manifest");
    const path = this.boardPath(document.id);
    const serialized = JSON.stringify(document, null, 2) + "\n";
    const known = this.opened.get(document.id);
    const current = await this.readIfExists(path);
    const assetConflicts = await this.refreshInkConflicts(document.id, ink);
    const conflict = assetConflicts.length > 0 || known?.recovery?.conflicted ||
      current !== (known?.raw ?? null) ||
      (!!known &&
        (document.revision < known.document.revision ||
          (document.revision === known.document.revision &&
            JSON.stringify(document) !== JSON.stringify(
              known.document.schemaVersion === document.schemaVersion
                ? known.document
                : upgradeBoardDocument(known.document),
            ) &&
            current !== null)));
    await ensureFolder(this.adapter, `${this.memoryRoot}/boards`);
    // A compatibility mirror keeps v1/v2 readers and immutable character
    // assets operational while v3 boards load from chunked packs.
    await this.writeInk(ink, known?.ink, known?.recoveryInk, this.inkConflicts.get(document.id));
    if (conflict) return this.saveConflict(document, ink, path, previewSvg);
    await this.writeInkPacks(
      document.id,
      document.inkManifest,
      ink,
      known?.document.inkManifest,
    );
    // Also guard an unchanged-scene preview refresh: it must not replace the
    // derived files or acknowledge stale state after an external commit.
    if ((await this.readIfExists(path)) !== current)
      return this.saveConflict(document, ink, path, previewSvg);
    if (serialized === current) {
      this.opened.set(document.id, { document: structuredClone(document), ink: structuredClone(ink), raw: current, validRaw: current });
      if (previewSvg !== undefined)
        await this.adapter.write(
          path.replace(/\.board\.json$/, ".svg"),
          previewSvg,
        );
      await this.adapter.write(
        path.replace(/\.board\.json$/, ".md"),
        this.markdownEntry(document),
      );
      return;
    }
    if (known?.validRaw)
      await this.adapter.write(
        path.replace(/\.board\.json$/, ".previous.board.json"),
        known.validRaw,
      );
    if (known?.validRaw && parseBoardDocument(known.validRaw).schemaVersion === 1) {
      const legacyPath = path.replace(/\.board\.json$/, ".v1.board.json");
      if (!(await this.adapter.exists(legacyPath))) await this.adapter.write(legacyPath, known.validRaw);
    }
    if (known?.validRaw && parseBoardDocument(known.validRaw).schemaVersion === 2) {
      const legacyPath = path.replace(/\.board\.json$/, ".v2.board.json");
      if (!(await this.adapter.exists(legacyPath))) await this.adapter.write(legacyPath, known.validRaw);
    }
    if (known?.validRaw && parseBoardDocument(known.validRaw).schemaVersion === 3) {
      const legacyPath = path.replace(/\.board\.json$/, ".v3.board.json");
      if (!(await this.adapter.exists(legacyPath))) await this.adapter.write(legacyPath, known.validRaw);
    }
    if (current !== null && known?.validRaw && current !== known.validRaw) {
      await this.adapter.write(
        path.replace(/\.board\.json$/, `.corrupt-${crypto.randomUUID()}.json`),
        current,
      );
    }
    if (current !== null && this.adapter.process) {
      let changedDuringCommit = false;
      await this.adapter.process(path, (latest) => {
        if (latest !== current) {
          changedDuringCommit = true;
          return latest;
        }
        return serialized;
      });
      if (changedDuringCommit) return this.saveConflict(document, ink, path, previewSvg);
    } else await this.adapter.write(path, serialized);
    this.opened.set(document.id, {
      document: structuredClone(document),
      ink: structuredClone(ink),
      raw: serialized,
      validRaw: serialized,
    });
    // Derived artifacts can be rebuilt; the authoritative manifest commits first.
    if (previewSvg !== undefined)
      await this.adapter.write(
        path.replace(/\.board\.json$/, ".svg"),
        previewSvg,
      );
    await this.adapter.write(
      path.replace(/\.board\.json$/, ".md"),
      this.markdownEntry(document),
    );
  }

  private async saveConflict(document: BoardDocument, ink: BoardInk, path: string, previewSvg?: string): Promise<never> {
    // All conflict paths, including a late CAS rejection, get independent packs.
    const fork = structuredClone(document);
    fork.inkManifest = { format: "ink-pack-v1", packs: document.inkManifest!.packs.map(pack => ({ ...pack, id: `PACK-fork-${crypto.randomUUID()}` })) };
    validateBoardDocument(fork);
    await this.writeInkPacks(fork.id, fork.inkManifest, ink);
    const localPath = path.replace(/\.board\.json$/, `.conflict-${crypto.randomUUID()}.board.json`);
    await this.adapter.write(localPath, JSON.stringify(fork, null, 2) + "\n");
    if (previewSvg !== undefined) await this.adapter.write(localPath.replace(/\.board\.json$/, ".svg"), previewSvg);
    await this.adapter.write(localPath.replace(/\.board\.json$/, ".md"), this.markdownEntry(fork, localPath.split("/").pop()!.replace(/\.board\.json$/, "")));
    throw new BoardConflictError(localPath, path);
  }

  private markdownEntry(
    document: BoardDocument,
    basename = document.id,
  ): string {
    const sourceLink = document.sourceType === "standalone" ? "" : `[[${escapeMarkdownLink(document.sourceFile)}]]\n\n`;
    return `---\ntype: tutor-board\nboardId: ${document.id}\nrevision: ${document.revision}\n---\n\n# ${document.sourceType === "standalone" ? document.title ?? "Tutor 作品" : document.id}\n\n${sourceLink}![[${basename}.svg]]\n\n[JSON](./${basename}.board.json)\n`;
  }
  private buildInkManifest(existing: BoardInkManifest | undefined, ink: BoardInk): BoardInkManifest {
    const ids = Object.keys(ink);
    const remaining = new Set(ids);
    const packs = (existing?.packs ?? []).map((pack) => {
      const strokeIds = pack.strokeIds.filter((strokeId) => remaining.delete(strokeId) && !!ink[strokeId]);
      return { ...pack, strokeIds, pointCount: strokeIds.reduce((count, id) => count + ink[id]!.points.length, 0) };
    }).filter((pack) => pack.strokeIds.length > 0);
    let active = packs.at(-1);
    if (active?.sealed) active = undefined;
    for (const strokeId of ids.filter((candidate) => remaining.has(candidate))) {
      const points = ink[strokeId]!.points.length;
      if (!active || active.strokeIds.length >= 128 || active.pointCount + points > 50_000) {
        if (active) active.sealed = true;
        active = {
          id: `PACK-${String(packs.length + 1).padStart(6, "0")}`,
          strokeIds: [],
          sealed: false,
          pointCount: 0,
        };
        packs.push(active);
      }
      active.strokeIds.push(strokeId);
      active.pointCount += points;
    }
    for (let index = 0; index < packs.length - 1; index++) packs[index]!.sealed = true;
    return { format: "ink-pack-v1", packs };
  }
  private samePack(a: BoardInkManifest["packs"][number], b: BoardInkManifest["packs"][number]): boolean {
    return a.pointCount === b.pointCount && a.strokeIds.length === b.strokeIds.length && a.strokeIds.every((id, index) => id === b.strokeIds[index]);
  }
  private prepareInkManifest(document: BoardDocument, ink: BoardInk): BoardInkManifest {
    const known = this.opened.get(document.id), published = known?.raw != null ? known.document.inkManifest : undefined;
    // History contains older derived metadata. Repack from the latest committed
    // metadata so an unchanged scene/preview does not become a false conflict.
    const basis = known?.raw != null && !known.recovery ? published : document.inkManifest;
    const manifest = this.buildInkManifest(basis, ink);
    for (const pack of manifest.packs) {
      const prior = published?.packs.find(candidate => candidate.id === pack.id);
      if (!prior || !this.samePack(prior, pack)) pack.id = `PACK-${crypto.randomUUID()}`;
    }
    return manifest;
  }
  private async writeInkPacks(
    boardId: string,
    manifest: BoardInkManifest,
    ink: BoardInk,
    previousManifest?: BoardInkManifest,
  ): Promise<void> {
    if (!manifest.packs.length) return;
    await ensureFolder(this.adapter, `${this.memoryRoot}/ink-packs/${boardId}`);
    for (const pack of manifest.packs) {
      const priorPack = previousManifest?.packs.find((candidate) => candidate.id === pack.id);
      if (priorPack && this.samePack(priorPack, pack)) continue;
      const strokes: BoardInk = {};
      for (const strokeId of pack.strokeIds) strokes[strokeId] = inkStrokeSchema.parse(ink[strokeId]);
      const serialized = JSON.stringify({
        format: "ink-pack-v1",
        boardId,
        packId: pack.id,
        strokes,
      }, null, 2) + "\n";
      const path = this.inkPackPath(boardId, pack.id);
      const previous = await this.readIfExists(path);
      if (previous === serialized) continue;
      if (previous !== null)
        throw new Error(`Immutable ink pack was modified: ${pack.id}`);
      await this.adapter.write(path, serialized);
    }
  }
  private async writeInk(ink: BoardInk, previousInk?: BoardInk, recoveryInk?: BoardInk, preservedPaths?: ReadonlySet<string>): Promise<void> {
    if (!Object.keys(ink).length) return;
    await ensureFolder(this.adapter, `${this.memoryRoot}/ink`);
    for (const [id, stroke] of Object.entries(ink)) {
      // Legal imported IDs can equal Object.prototype names. Only own entries
      // identify previously committed or recovered immutable samples.
      const recoveredStroke = recoveryInk && Object.hasOwn(recoveryInk, id) ? recoveryInk[id] : undefined;
      const previousStroke = recoveredStroke ?? (previousInk && Object.hasOwn(previousInk, id) ? previousInk[id] : undefined);
      if (previousStroke) {
        // Stable ink IDs are immutable. Validate in memory and avoid thousands
        // of serial Vault reads for unchanged compatibility mirrors on save.
        if (JSON.stringify(inkStrokeSchema.parse(previousStroke)) !== JSON.stringify(inkStrokeSchema.parse(stroke)))
          throw new Error(`Immutable ink was modified: ${id}`);
        // Recovery validates against its own samples. Rebuild a missing mirror
        // only when it was not explicitly observed as an outside deletion.
        if (!recoveredStroke || preservedPaths?.has(this.inkPath(id)) || await this.adapter.exists(this.inkPath(id))) continue;
      }
      const valid = inkStrokeSchema.parse(stroke);
      if (valid.id !== id) throw new Error("Ink key must match stroke ID");
      const path = this.inkPath(id),
        serialized = JSON.stringify(valid, null, 2) + "\n";
      const previous = await this.readIfExists(path);
      if (previous !== null) {
        const parsed = inkStrokeSchema.parse(JSON.parse(previous));
        if (JSON.stringify(parsed) !== JSON.stringify(valid))
          throw new Error(`Immutable ink was modified: ${id}`);
      } else await this.adapter.write(path, serialized);
      const svgPath = path.replace(/\.ink\.json$/, ".svg");
      if (!(await this.adapter.exists(svgPath))) {
        const bounds = valid.points.reduce(
          (b, point) => ({
            minX: Math.min(b.minX, point.x),
            minY: Math.min(b.minY, point.y),
            maxX: Math.max(b.maxX, point.x),
            maxY: Math.max(b.maxY, point.y),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        );
        const { minX, minY } = bounds;
        const width = Math.max(1, bounds.maxX - minX),
          height = Math.max(1, bounds.maxY - minY);
        const points = valid.points
          .map((point) => `${point.x},${point.y}`)
          .join(" ");
        await this.adapter.write(
          svgPath,
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - 1} ${minY - 1} ${width + 2} ${height + 2}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`,
        );
      }
    }
  }
  private async loadInk(ids: string[], document?: BoardDocument): Promise<BoardInk> {
    if (document?.inkManifest) {
      const needed = new Set(ids);
      const ink: BoardInk = {};
      for (const pack of document.inkManifest.packs) {
        if (!pack.strokeIds.some((id) => needed.has(id))) continue;
        const path = this.inkPackPath(document.id, pack.id);
        let raw = await this.readIfExists(path);
        let parsed: { format?: unknown; boardId?: unknown; packId?: unknown; strokes?: unknown } | null = null;
        try { parsed = raw ? JSON.parse(raw) as { format?: unknown; boardId?: unknown; packId?: unknown; strokes?: unknown } : null; } catch { parsed = null; }
        if (!parsed || parsed.format !== "ink-pack-v1" || parsed.boardId !== document.id || parsed.packId !== pack.id) {
          raw = await this.readIfExists(path.replace(/\.inkpack\.json$/, ".previous.inkpack.json"));
          try { parsed = raw ? JSON.parse(raw) as { format?: unknown; boardId?: unknown; packId?: unknown; strokes?: unknown } : null; } catch { parsed = null; }
        }
        if (!parsed || parsed.format !== "ink-pack-v1" || parsed.boardId !== document.id || parsed.packId !== pack.id)
          throw new Error(`Missing or corrupt ink pack: ${pack.id}`);
        const strokes = boardInkSchema.parse(parsed.strokes);
        for (const strokeId of pack.strokeIds)
          if (needed.has(strokeId)) {
            const stroke = Object.hasOwn(strokes, strokeId) ? strokes[strokeId] : undefined;
            if (!stroke) throw new Error(`Missing immutable ink: ${strokeId}`);
            ink[strokeId] = stroke;
          }
      }
      for (const id of needed) if (!Object.hasOwn(ink, id)) throw new Error(`Missing immutable ink: ${id}`);
      return ink;
    }
    const ink: BoardInk = {};
    for (const id of new Set(ids)) {
      const raw = await this.readIfExists(this.inkPath(id));
      if (raw === null) throw new Error(`Missing immutable ink: ${id}`);
      const stroke = inkStrokeSchema.parse(JSON.parse(raw));
      if (stroke.id !== id) throw new Error(`Ink identity mismatch: ${id}`);
      ink[id] = stroke;
    }
    return ink;
  }
  private async validateAssetFile(profile: TutorCharacterProfile): Promise<void> {
    if (!profile.assetPath) return;
    if (!profile.assetPath.startsWith(`${this.memoryRoot}/characters/`))
      throw new Error("Character assets must stay inside the configured characters directory");
    if (!(await this.adapter.exists(profile.assetPath))) throw new Error("Character asset is missing");
  }

  private async readCharacter(path: string, ancestry = new Set<string>()): Promise<TutorCharacterProfile> {
    if (ancestry.has(path) || ancestry.size >= 8) throw new Error("Recursive or excessively nested asset dependency");
    const value = JSON.parse(
      await this.adapter.read(path),
    ) as TutorCharacterProfile;
    const ids = Array.isArray(value.objects)
      ? value.objects.flatMap((object) => (object.inkId ? [object.inkId] : []))
      : [];
    const ink = await this.loadInk(ids);
    const profile = tutorCharacterProfileSchema.parse({
      ...value,
      ...(ids.length ? { ink } : {}),
    });
    if (path !== this.characterPath(profile.id, profile.version))
      throw new Error("Character identity does not match its versioned path");
    await this.validateAssetFile(profile);
    const next = new Set([...ancestry, path]);
    const builtins = new Set(builtInBoardAssets().map(assetKey));
    for (const object of profile.objects ?? []) {
      const reference = assetReference(object);
      if (!reference || builtins.has(assetKey(reference))) continue;
      const dependencyPath = this.characterPath(reference.id, reference.version);
      if (!(await this.adapter.exists(dependencyPath))) throw new Error(`Missing versioned asset dependency: ${assetKey(reference)}`);
      await this.readCharacter(dependencyPath, next);
    }
    return profile;
  }
}
