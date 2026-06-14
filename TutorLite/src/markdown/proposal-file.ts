import { createHash } from "node:crypto";
import type {
  MemoryProposal,
  ProposalTargetKind
} from "../model.js";
import { proposalSchema } from "../schemas.js";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.js";

const CANDIDATE_START = "<!-- annotation-tutor:proposal-candidate:start -->";
const CANDIDATE_END = "<!-- annotation-tutor:proposal-candidate:end -->";

export function serializeProposal(proposal: MemoryProposal): string {
  return renderFrontmatter(
    {
      schema: 2,
      kind: "proposal",
      id: proposal.id,
      operation: proposal.operation,
      target_kind: proposal.targetKind,
      target_path: proposal.targetPath,
      ...(proposal.baseSha256 ? { base_sha256: proposal.baseSha256 } : {}),
      status: proposal.status,
      created_at: proposal.createdAt,
      ...(proposal.resolvedAt ? { resolved_at: proposal.resolvedAt } : {})
    },
    [
      `# ${proposal.id}`,
      "",
      "## Candidate",
      "",
      CANDIDATE_START,
      proposal.candidate,
      CANDIDATE_END
    ].join("\n")
  );
}

export function parseProposalFile(markdown: string): MemoryProposal | null {
  const document = parseFrontmatter(markdown);
  if (
    !document ||
    document.data.schema !== 2 ||
    document.data.kind !== "proposal"
  ) {
    return null;
  }
  const candidate = extractCandidate(document.body);
  const parsed = proposalSchema.safeParse({
    id: document.data.id,
    operation: document.data.operation,
    targetKind: document.data.target_kind,
    targetPath: document.data.target_path,
    status: document.data.status,
    candidate,
    createdAt: document.data.created_at,
    ...(typeof document.data.base_sha256 === "string"
      ? { baseSha256: document.data.base_sha256 }
      : {}),
    ...(typeof document.data.resolved_at === "string"
      ? { resolvedAt: document.data.resolved_at }
      : {})
  });
  if (!parsed.success) return null;
  if (!isAllowedProposalTarget(parsed.data.targetPath, parsed.data.targetKind)) {
    return null;
  }
  return parsed.data;
}

export function isAllowedProposalTarget(
  targetPath: string,
  targetKind: ProposalTargetKind
): boolean {
  const normalized = targetPath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized.includes("/./") ||
    !normalized.endsWith(".md")
  ) {
    return false;
  }
  const patterns: Record<ProposalTargetKind, RegExp> = {
    "memory-cell": /^memory-cells\/(?:CELL|MEM)-[A-Za-z0-9_-]+\.md$/,
    scene: /^scenes\/SCENE-[A-Za-z0-9_-]+\.md$/,
    "learner-profile": /^profiles\/learner-profile\.md$/,
    preferences: /^profiles\/preferences\.md$/
  };
  return patterns[targetKind].test(normalized);
}

export function evaluateProposal(
  proposal: MemoryProposal,
  currentContent: string | null
): "ready" | "stale" {
  if (proposal.operation === "create") {
    return currentContent === null ? "ready" : "stale";
  }
  if (!proposal.baseSha256 || currentContent === null) return "stale";
  return sha256(currentContent) === proposal.baseSha256 ? "ready" : "stale";
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function extractCandidate(body: string): string {
  const start = body.indexOf(CANDIDATE_START);
  const end = body.indexOf(CANDIDATE_END);
  if (start < 0 || end < start) return "";
  return body
    .slice(start + CANDIDATE_START.length, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
}
