import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateProposal,
  isAllowedProposalTarget,
  parseProposalFile,
  serializeProposal
} from "../src/markdown/proposal-file.js";
import type { MemoryProposal } from "../src/model.js";

const candidate = [
  "---",
  "schema: 2",
  "kind: scene",
  "id: SCENE-transformer",
  "---",
  "# Transformer",
  ""
].join("\n");

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "PROP-20260607-001",
    operation: "update",
    targetKind: "scene",
    targetPath: "scenes/SCENE-transformer.md",
    baseSha256: createHash("sha256").update("old").digest("hex"),
    status: "pending",
    candidate,
    createdAt: "2026-06-07T10:00:00.000Z",
    ...overrides
  };
}

describe("memory proposals", () => {
  it("round-trips candidate markdown without modifying it", () => {
    const markdown = serializeProposal(proposal());
    expect(parseProposalFile(markdown)).toEqual(proposal());
  });

  it("allows only managed relative Markdown targets", () => {
    expect(isAllowedProposalTarget("memory-cells/CELL-1.md", "memory-cell")).toBe(
      true
    );
    expect(isAllowedProposalTarget("scenes/SCENE-1.md", "scene")).toBe(true);
    expect(
      isAllowedProposalTarget("profiles/learner-profile.md", "learner-profile")
    ).toBe(true);
    expect(isAllowedProposalTarget("../Private.md", "scene")).toBe(false);
    expect(isAllowedProposalTarget("annotations/ANN-1.md", "scene")).toBe(false);
  });

  it("marks an update stale when the target hash changed", () => {
    expect(evaluateProposal(proposal(), "old")).toBe("ready");
    expect(evaluateProposal(proposal(), "changed")).toBe("stale");
    expect(
      evaluateProposal(
        proposal({ operation: "create", baseSha256: undefined }),
        null
      )
    ).toBe("ready");
  });
});
