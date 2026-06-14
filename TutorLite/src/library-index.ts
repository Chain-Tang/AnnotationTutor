import { z } from "zod";
import type {
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
  annotationId: z.string(),
  memoryFile: z.string(),
  sourceFile: z.string(),
  anchor: z.string(),
  anchorOrigin: z.enum(["generated", "existing", "legacy"]),
  selectedText: z.string(),
  status: z.string(),
  concepts: z.array(z.string()),
  relatedMemoryCells: z.array(z.string()),
  reviewSummary: z.string().optional(),
  userNoteSummary: z.string().optional(),
  userNote: z.string().optional(),
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
  previous?: LibrarySnapshot
): LibrarySnapshot {
  const diagnostics: LibraryDiagnostic[] = [];
  const fileHashes: Record<string, string> = {};
  for (const group of Object.values(files)) {
    for (const file of group) fileHashes[file.path] = sha256(file.content);
  }

  const annotations = files.annotations.flatMap((file) => {
    const annotation = parseAnnotationFile(file.content);
    if (!annotation) {
      diagnostics.push(invalid(file.path, "annotation"));
      return [];
    }
    return [recordFromAnnotation(annotation, file.path)];
  });

  const parsedCells = files.cells.flatMap((file) => {
    const cell = parseMemoryCellFile(file.content);
    if (!cell) {
      diagnostics.push(invalid(file.path, "memory-cell"));
      return [];
    }
    return [{ cell, path: file.path }];
  });

  const parsedScenes = files.scenes.flatMap((file) => {
    const scene = parseSceneFile(file.content);
    if (!scene) {
      diagnostics.push(invalid(file.path, "scene"));
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
    const profile = parseProfileFile(file.content);
    if (!profile) {
      diagnostics.push(invalid(file.path, "profile"));
      return [];
    }
    if (
      profile.claims.some((claim) =>
        claim.evidence.some((id) => !evidenceIds.has(id))
      )
    ) {
      diagnostics.push({
        path: file.path,
        kind: "profile",
        message: "Profile evidence does not exist in the memory library",
        recoverable: false
      });
      return [];
    }
    return [profile];
  });

  const proposals = files.proposals.flatMap((file) => {
    const proposal = parseProposalFile(file.content);
    if (!proposal) {
      diagnostics.push(invalid(file.path, "proposal"));
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
  return previous ? retainLastValid(snapshot, previous) : snapshot;
}

export function serializeLibraryCache(snapshot: LibrarySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function parseLibraryCache(text: string): LibrarySnapshot | null {
  try {
    const result = libraryCacheSchema.safeParse(JSON.parse(text));
    return result.success ? (result.data as LibrarySnapshot) : null;
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
      if (record) current.profiles.push(record);
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
