import { z } from "zod";
import type {
  Annotation,
  IndexRecord,
  LearnerProfile,
  MemoryCell,
  MemoryProposal,
  Scene
} from "./model.js";
import {
  learnerProfileSchema,
  memoryCellSchema,
  proposalSchema,
  sceneSchema
} from "./schemas.js";
import { recordFromAnnotation } from "./index-table.js";
import { parseAnnotationFile } from "./markdown/annotation-file.js";
import { parseMemoryCellFile } from "./markdown/memory-cell-file.js";
import { parseProfileFile } from "./markdown/profile-file.js";
import { parseProposalFile, sha256 } from "./markdown/proposal-file.js";
import { parseSceneFile } from "./markdown/scene-file.js";

export type LibraryFile = { path: string; content: string };
export type LibraryDiagnosticKind =
  | "annotation"
  | "memory-cell"
  | "scene"
  | "profile"
  | "proposal";

export type LibraryDiagnostic = {
  path: string;
  kind: LibraryDiagnosticKind;
  message: string;
  recoverable?: boolean;
};

export type MemoryCellRecord = MemoryCell & {
  path: string;
  sceneIds: string[];
};

export type SceneRecord = Scene & {
  path: string;
  sourceAnnotations: string[];
};

export type LibrarySnapshot = {
  version: 2;
  annotations: IndexRecord[];
  cells: MemoryCellRecord[];
  scenes: SceneRecord[];
  profiles: LearnerProfile[];
  proposals: MemoryProposal[];
  diagnostics: LibraryDiagnostic[];
  files: Record<string, string>;
};

export type LibraryFiles = {
  annotations: LibraryFile[];
  cells: LibraryFile[];
  scenes: LibraryFile[];
  profiles: LibraryFile[];
  proposals: LibraryFile[];
};

type ParsedLibraryKinds = {
  annotation: Annotation;
  "memory-cell": MemoryCell;
  scene: Scene;
  profile: LearnerProfile;
  proposal: MemoryProposal;
};
type ParsedLibraryFile<Kind extends LibraryDiagnosticKind> = {
  raw: string;
  hash: string;
  value: ParsedLibraryKinds[Kind] | null;
  diagnostic?: LibraryDiagnostic;
};

/** Raw versions are separate from last-valid snapshots. An incomplete editor
 * version must stay cached as invalid, rather than being retried on every read. */
export class LibraryParseCache {
  private readonly entries = new Map<string, ParsedLibraryFile<LibraryDiagnosticKind>>();

  read<Kind extends LibraryDiagnosticKind>(kind: Kind, file: LibraryFile): ParsedLibraryFile<Kind> {
    const key = `${kind}\n${file.path}`;
    const cached = this.entries.get(key);
    if (cached?.raw === file.content) return cached as ParsedLibraryFile<Kind>;
    const parsers = {
      annotation: parseAnnotationFile, "memory-cell": parseMemoryCellFile,
      scene: parseSceneFile, profile: parseProfileFile, proposal: parseProposalFile
    };
    const value = parsers[kind](file.content) as ParsedLibraryKinds[Kind] | null;
    const entry: ParsedLibraryFile<Kind> = {
      raw: file.content, hash: sha256(file.content), value,
      ...(value ? {} : { diagnostic: invalid(file.path, kind) })
    };
    this.entries.set(key, entry);
    return entry;
  }

  retain(files: LibraryFiles): void {
    const paths = new Set(Object.values(files).flatMap(group => group.map(file => file.path)));
    for (const key of this.entries.keys()) if (!paths.has(key.slice(key.indexOf("\n") + 1))) this.entries.delete(key);
  }

  clear(): void { this.entries.clear(); }
}

export function emptyLibrarySnapshot(): LibrarySnapshot {
  return {
    version: 2,
    annotations: [],
    cells: [],
    scenes: [],
    profiles: [],
    proposals: [],
    diagnostics: [],
    files: {}
  };
}

const indexRecordSchema = z.object({
  tracking: z.enum(["ordinary", "private", "excluded"]).optional(),
  annotationId: z.string(),
  memoryFile: z.string(),
  sourceFile: z.string(),
  anchor: z.string(),
  anchorOrigin: z.enum(["generated", "existing", "legacy"]),
  selectedText: z.string(),
  sourceType: z.enum(["markdown", "pdf"]).optional(),
  sourcePage: z.number().int().positive().optional(),
  status: z.string(),
  concepts: z.array(z.string()),
  relatedMemoryCells: z.array(z.string()),
  reviewSummary: z.string().optional(),
  reviewText: z.string().optional(),
  userNoteSummary: z.string().optional(),
  userNote: z.string().optional(),
  dialogue: z.array(z.object({ id: z.string().optional(), role: z.enum(["user", "agent"]), text: z.string(), at: z.string() })).optional(),
  branch: z.object({ parentAnnotationId: z.string(), rootAnnotationId: z.string(), sourceVersion: z.string(),
    parentReply: z.object({ id: z.string(), kind: z.enum(["review", "dialogue"]), version: z.string(), text: z.string(), question: z.string().optional(), contextVersion: z.string().optional(),
      history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional() }) }).optional(),
  request: z.object({ id: z.string(), status: z.enum(["draft", "generating", "completed", "failed", "cancelled", "interrupted"]),
    question: z.string(), errorCode: z.string().optional(), startedAt: z.string().optional(), contextVersion: z.string().optional(), sourceVersion: z.string().optional(), updatedAt: z.string() }).optional(),
  dialogueRequest: z.object({ id: z.string(), status: z.enum(["draft", "generating", "completed", "failed", "cancelled", "interrupted"]),
    question: z.string(), errorCode: z.string().optional(), startedAt: z.string().optional(), contextVersion: z.string().optional(), sourceVersion: z.string().optional(), updatedAt: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const cellRecordSchema = memoryCellSchema.extend({
  path: z.string(),
  sceneIds: z.array(z.string())
});

const sceneRecordSchema = sceneSchema.extend({
  path: z.string(),
  sourceAnnotations: z.array(z.string())
});

const diagnosticSchema = z.object({
  path: z.string(),
  kind: z.enum([
    "annotation",
    "memory-cell",
    "scene",
    "profile",
    "proposal"
  ]),
  message: z.string(),
  recoverable: z.boolean().optional()
});

const libraryCacheSchema = z.object({
  version: z.literal(2),
  annotationProjectionVersion: z.literal(3),
  annotations: z.array(indexRecordSchema),
  cells: z.array(cellRecordSchema),
  scenes: z.array(sceneRecordSchema),
  profiles: z.array(learnerProfileSchema),
  proposals: z.array(proposalSchema),
  diagnostics: z.array(diagnosticSchema),
  files: z.record(z.string(), z.string())
});

export function buildLibrarySnapshot(
  files: LibraryFiles,
  previous?: LibrarySnapshot,
  cache = new LibraryParseCache()
): LibrarySnapshot {
  const diagnostics: LibraryDiagnostic[] = [];
  const fileHashes: Record<string, string> = {};
  const kinds = { annotations: "annotation", cells: "memory-cell", scenes: "scene", profiles: "profile", proposals: "proposal" } as const;
  for (const group of Object.keys(files) as Array<keyof LibraryFiles>) {
    for (const file of files[group]) fileHashes[file.path] = cache.read(kinds[group], file).hash;
  }

  const annotations = files.annotations.flatMap((file) => {
    const parsed = cache.read("annotation", file), annotation = parsed.value;
    if (!annotation) {
      diagnostics.push({ ...parsed.diagnostic! });
      return [];
    }
    return [recordFromAnnotation(annotation, file.path)];
  });

  const parsedCells = files.cells.flatMap((file) => {
    const parsed = cache.read("memory-cell", file), cell = parsed.value;
    if (!cell) {
      diagnostics.push({ ...parsed.diagnostic! });
      return [];
    }
    return [{ cell, path: file.path }];
  });

  const parsedScenes = files.scenes.flatMap((file) => {
    const parsed = cache.read("scene", file), scene = parsed.value;
    if (!scene) {
      diagnostics.push({ ...parsed.diagnostic! });
      return [];
    }
    return [{ scene, path: file.path }];
  });

  const sceneIdsByCell = new Map<string, string[]>();
  for (const { scene } of parsedScenes) {
    for (const cellId of scene.cells) {
      const ids = sceneIdsByCell.get(cellId) ?? [];
      ids.push(scene.id);
      sceneIdsByCell.set(cellId, ids);
    }
  }
  const cells: MemoryCellRecord[] = parsedCells.map(({ cell, path }) => ({
    ...cell,
    path,
    sceneIds: [...(sceneIdsByCell.get(cell.id) ?? [])].sort()
  }));
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const scenes: SceneRecord[] = parsedScenes.map(({ scene, path }) => ({
    ...scene,
    path,
    sourceAnnotations: [
      ...new Set(
        scene.cells.flatMap(
          (cellId) => cellById.get(cellId)?.sourceAnnotations ?? []
        )
      )
    ].sort()
  }));

  const evidenceIds = new Set([
    ...cells.map((cell) => cell.id),
    ...scenes.map((scene) => scene.id)
  ]);
  const profiles = files.profiles.flatMap((file) => {
    const parsed = cache.read("profile", file), profile = parsed.value;
    if (!profile) {
      diagnostics.push({ ...parsed.diagnostic! });
      return [];
    }
    // Keep the profile but drop only the claims whose evidence has gone missing.
    // A whole claim is dropped, never a partial evidence strip, so a kept
    // learner-profile claim still satisfies its two-distinct-evidence invariant.
    // A recoverable diagnostic surfaces the loss without discarding sound claims.
    const validClaims = profile.claims.filter((claim) =>
      claim.evidence.every((id) => evidenceIds.has(id))
    );
    if (validClaims.length !== profile.claims.length) {
      diagnostics.push({
        path: file.path,
        kind: "profile",
        message:
          "Dropped profile claims whose evidence is missing from the memory library",
        recoverable: true
      });
    }
    return [{ ...profile, claims: validClaims }];
  });

  const proposals = files.proposals.flatMap((file) => {
    const parsed = cache.read("proposal", file), proposal = parsed.value;
    if (!proposal) {
      diagnostics.push({ ...parsed.diagnostic! });
      return [];
    }
    return [proposal];
  });

  const snapshot: LibrarySnapshot = {
    version: 2,
    annotations,
    cells,
    scenes,
    profiles,
    proposals,
    diagnostics,
    files: fileHashes
  };
  // Published records may be used by mutable host UI adapters. Keep that
  // boundary isolated from parsed raw versions, just as a fresh parse was.
  return structuredClone(previous ? retainLastValid(snapshot, previous) : snapshot);
}

export function serializeLibraryCache(snapshot: LibrarySnapshot): string {
  return `${JSON.stringify({ ...snapshot, annotationProjectionVersion: 3 }, null, 2)}\n`;
}

export function parseLibraryCache(text: string): LibrarySnapshot | null {
  try {
    const result = libraryCacheSchema.safeParse(JSON.parse(text));
    if (!result.success) return null;
    const { annotationProjectionVersion: _projectionVersion, ...snapshot } = result.data;
    return snapshot as LibrarySnapshot;
  } catch {
    return null;
  }
}

function invalid(
  path: string,
  kind: LibraryDiagnosticKind
): LibraryDiagnostic {
  return {
    path,
    kind,
    message: `Invalid ${kind} Markdown`
  };
}

function retainLastValid(
  current: LibrarySnapshot,
  previous: LibrarySnapshot
): LibrarySnapshot {
  for (const diagnostic of current.diagnostics) {
    if (diagnostic.recoverable === false) continue;
    const oldHash = previous.files[diagnostic.path];
    if (oldHash) current.files[diagnostic.path] = oldHash;
    if (diagnostic.kind === "annotation") {
      const record = previous.annotations.find(
        (item) => item.memoryFile === diagnostic.path
      );
      if (record) current.annotations.push(record);
    } else if (diagnostic.kind === "memory-cell") {
      const record = previous.cells.find(
        (item) => item.path === diagnostic.path
      );
      if (record) current.cells.push(record);
    } else if (diagnostic.kind === "scene") {
      const record = previous.scenes.find(
        (item) => item.path === diagnostic.path
      );
      if (record) current.scenes.push(record);
    } else if (diagnostic.kind === "profile") {
      const id = fileStem(diagnostic.path);
      const record = previous.profiles.find((item) => item.id === id);
      // A claim-filtered profile is already present under this id (recoverable),
      // so guard against re-adding the previous copy and duplicating it.
      if (record && !current.profiles.some((item) => item.id === id)) {
        current.profiles.push(record);
      }
    } else if (diagnostic.kind === "proposal") {
      const id = fileStem(diagnostic.path);
      const record = previous.proposals.find((item) => item.id === id);
      if (record) current.proposals.push(record);
    }
  }
  return current;
}

function fileStem(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}
