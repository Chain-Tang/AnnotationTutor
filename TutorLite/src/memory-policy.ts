import type { IndexRecord, MemoryProposal } from "./model.js";
import { parseMemoryCellFile } from "./markdown/memory-cell-file.js";
import { parseProfileFile } from "./markdown/profile-file.js";
import { parseSceneFile } from "./markdown/scene-file.js";

export type PolicyResult =
  | { ok: true }
  | { ok: false; message: string };

export function shouldRemoveAnnotationBlockId(
  record: IndexRecord,
  allRecords: IndexRecord[]
): boolean {
  if (record.anchorOrigin !== "generated") return false;
  return !allRecords.some(
    (candidate) =>
      candidate.annotationId !== record.annotationId &&
      candidate.sourceFile === record.sourceFile &&
      candidate.anchor === record.anchor
  );
}

export function validateProposalCandidate(
  proposal: MemoryProposal,
  preferenceWritesEnabled: boolean,
  knownEvidence?: ReadonlySet<string>
): PolicyResult {
  if (
    proposal.targetKind === "preferences" &&
    !preferenceWritesEnabled
  ) {
    return { ok: false, message: "Preference memory writes are disabled" };
  }

  const parsed =
    proposal.targetKind === "memory-cell"
      ? parseMemoryCellFile(proposal.candidate)
      : proposal.targetKind === "scene"
        ? parseSceneFile(proposal.candidate)
        : parseProfileFile(proposal.candidate);
  if (!parsed) {
    return {
      ok: false,
      message: `Candidate is not valid ${proposal.targetKind} Markdown`
    };
  }

  const expectedId =
    proposal.targetKind === "learner-profile" ||
    proposal.targetKind === "preferences"
      ? proposal.targetKind
      : fileStem(proposal.targetPath);
  if (parsed.id !== expectedId) {
    return {
      ok: false,
      message: "Candidate id does not match the proposal target"
    };
  }
  if (
    "kind" in parsed &&
    (proposal.targetKind === "learner-profile" ||
      proposal.targetKind === "preferences") &&
    parsed.kind !== proposal.targetKind
  ) {
    return {
      ok: false,
      message: "Candidate profile kind does not match the proposal target"
    };
  }
  if (
    "claims" in parsed &&
    knownEvidence &&
    parsed.claims.some((claim) =>
      claim.evidence.some((id) => !knownEvidence.has(id))
    )
  ) {
    return {
      ok: false,
      message: "Profile evidence does not exist in the memory library"
    };
  }
  return { ok: true };
}

function fileStem(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return file.replace(/\.md$/i, "");
}
