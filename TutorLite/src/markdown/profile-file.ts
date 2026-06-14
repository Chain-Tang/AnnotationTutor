import type { LearnerProfile, ProfileClaim } from "../model.js";
import { learnerProfileSchema } from "../schemas.js";
import {
  parseFrontmatter,
  renderFrontmatter,
  section,
  stringArray,
  wikiLink,
  wikiLinkId
} from "./frontmatter.js";

const CLAIM_START = "<!-- annotation-tutor:claim:start -->";
const CLAIM_END = "<!-- annotation-tutor:claim:end -->";

export function serializeProfile(
  profile: LearnerProfile,
  memoryRoot = "Agent Memory"
): string {
  const claims = profile.claims
    .map((claim) => renderClaim(claim, memoryRoot))
    .join("\n\n");
  return renderFrontmatter(
    {
      schema: 2,
      kind: profile.kind,
      id: profile.id,
      status: profile.status,
      title: profile.title,
      tags: profile.tags,
      updated_at: profile.updatedAt
    },
    [
      `# ${profile.title}`,
      "",
      "## Summary",
      "",
      profile.summary,
      "",
      "## Claims",
      "",
      claims
    ].join("\n")
  );
}

export function parseProfileFile(markdown: string): LearnerProfile | null {
  const document = parseFrontmatter(markdown);
  if (
    !document ||
    document.data.schema !== 2 ||
    (document.data.kind !== "learner-profile" &&
      document.data.kind !== "preferences")
  ) {
    return null;
  }
  const parsed = learnerProfileSchema.safeParse({
    id: document.data.id,
    kind: document.data.kind,
    title: document.data.title,
    status: document.data.status,
    summary: section(document.body, "Summary"),
    claims: parseClaims(section(document.body, "Claims")),
    tags: stringArray(document.data.tags),
    updatedAt: document.data.updated_at
  });
  return parsed.success ? parsed.data : null;
}

function renderClaim(claim: ProfileClaim, memoryRoot: string): string {
  const evidence = claim.evidence.map((id) => {
    const folder = id.startsWith("SCENE-") ? "scenes" : "memory-cells";
    return wikiLink(`${memoryRoot}/${folder}/${id}`, id);
  });
  return [
    CLAIM_START,
    `### ${claim.statement}`,
    "",
    `Evidence: ${evidence.join(", ")}`,
    CLAIM_END
  ].join("\n");
}

function parseClaims(markdown: string): ProfileClaim[] {
  const pattern = new RegExp(
    `${escapeRegExp(CLAIM_START)}\\s*###\\s+(.+?)\\r?\\n\\s*Evidence:\\s*(.+?)\\s*${escapeRegExp(CLAIM_END)}`,
    "gs"
  );
  return [...markdown.matchAll(pattern)].map((match) => ({
    statement: (match[1] ?? "").trim(),
    evidence: (match[2] ?? "")
      .split(",")
      .map((value) => wikiLinkId(value))
      .filter((value): value is string => value !== null)
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
