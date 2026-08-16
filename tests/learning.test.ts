import { describe, expect, it } from "vitest";
import {
  calibrateProfileClaims,
  classifyCells,
  deriveMasterySnapshot,
  deriveProfileSummary,
  deriveStudyPlan,
  isStrength,
  isWeakness,
  summarizeMastery,
  summarizeStudyPlan
} from "../src/learning.js";
import type { MemoryCell } from "../src/model.js";
import type { ReviewState } from "../src/srs.js";

function cell(overrides: Partial<MemoryCell> = {}): MemoryCell {
  return {
    id: "MEM-1",
    type: "understanding",
    concept: "C",
    status: "new",
    summary: "s",
    sourceAnnotations: ["ANN-1"],
    tags: [],
    confidence: 0.6,
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
    ...overrides
  };
}

function review(overrides: Partial<ReviewState> = {}): ReviewState {
  return { ease: 2.5, intervalDays: 1, reps: 0, lapses: 0, dueAt: "2026-06-15T10:00:00.000Z", ...overrides };
}

describe("classifyCells", () => {
  it("routes misconceptions/low-confidence to weaknesses, understanding to strengths", () => {
    const cells = [
      cell({ id: "MEM-1", type: "understanding", confidence: 0.9 }),
      cell({ id: "MEM-2", type: "misconception", confidence: 0.4 }),
      cell({ id: "MEM-3", type: "understanding", confidence: 0.3 }) // low conf → weakness
    ];
    const { strengths, weaknesses } = classifyCells(cells);
    expect(strengths.map((c) => c.id)).toEqual(["MEM-1"]);
    expect(weaknesses.map((c) => c.id)).toEqual(["MEM-3", "MEM-2"]); // weakest first
  });

  it("collects strategy cells as problem-solving methods", () => {
    const { methods } = classifyCells([
      cell({ id: "MEM-1", type: "strategy", confidence: 0.7 }),
      cell({ id: "MEM-2", type: "understanding" })
    ]);
    expect(methods.map((c) => c.id)).toEqual(["MEM-1"]);
  });

  it("treats stable/high-confidence as strengths and needs_review as weakness", () => {
    expect(isStrength(cell({ status: "stable", confidence: 0.2 }))).toBe(true);
    expect(isWeakness(cell({ status: "needs_review", confidence: 0.9, type: "goal" }))).toBe(true);
  });

  it("lets measured review performance override the LLM confidence guess", () => {
    const cells = [
      // High-confidence "understanding" the learner just failed in review → weakness.
      cell({ id: "MEM-1", type: "understanding", confidence: 0.95, review: review({ reps: 0, lapses: 1 }) }),
      // A "misconception" now recalled 3× running with no current lapse → strength.
      cell({ id: "MEM-2", type: "misconception", confidence: 0.3, review: review({ reps: 3, lapses: 1 }) })
    ];
    const { strengths, weaknesses } = classifyCells(cells);
    expect(weaknesses.map((c) => c.id)).toEqual(["MEM-1"]);
    expect(strengths.map((c) => c.id)).toEqual(["MEM-2"]);
  });

  it("orders weaknesses by lapses and strengths by reps (most-relevant first)", () => {
    const { strengths, weaknesses } = classifyCells([
      cell({ id: "W1", confidence: 0.4, review: review({ reps: 0, lapses: 1 }) }),
      cell({ id: "W2", confidence: 0.4, review: review({ reps: 0, lapses: 3 }) }),
      cell({ id: "S1", type: "understanding", review: review({ reps: 3, lapses: 0 }) }),
      cell({ id: "S2", type: "understanding", review: review({ reps: 5, lapses: 0 }) })
    ]);
    expect(weaknesses.map((c) => c.id)).toEqual(["W2", "W1"]); // 3 lapses before 1
    expect(strengths.map((c) => c.id)).toEqual(["S2", "S1"]); // 5 reps before 3
  });

  it("treats a brand-new schedule (reps 0, no lapses) as no signal — falls back to heuristics", () => {
    const { strengths } = classifyCells([
      cell({ id: "N", type: "understanding", confidence: 0.9, review: review({ reps: 0, lapses: 0 }) })
    ]);
    expect(strengths.map((c) => c.id)).toEqual(["N"]);
  });
});

describe("deriveProfileSummary", () => {
  it("names strengths, gaps, and methods from the cells", () => {
    const summary = deriveProfileSummary([
      cell({ id: "S", type: "understanding", concept: "Projection", confidence: 0.9 }),
      cell({ id: "W", type: "misconception", concept: "Splitting", confidence: 0.3 }),
      cell({ id: "M", type: "strategy", concept: "Active recall", confidence: 0.7 })
    ]);
    expect(summary).toContain("Strengths: Projection");
    expect(summary).toContain("Working on: Splitting");
    expect(summary).toContain("Methods: Active recall");
  });

  it("de-duplicates concepts and caps each list at four", () => {
    const cells = Array.from({ length: 6 }, (_, i) =>
      cell({ id: `S${i}`, type: "understanding", concept: `Topic ${i}`, confidence: 0.9 })
    );
    cells.push(cell({ id: "DUP", type: "understanding", concept: "Topic 0", confidence: 0.9 }));
    const summary = deriveProfileSummary(cells);
    expect(summary).toContain("Topic 0; Topic 1; Topic 2; Topic 3.");
    expect(summary).not.toContain("Topic 4");
  });

  it("returns an empty string when there are no cells", () => {
    expect(deriveProfileSummary([])).toBe("");
  });
});

describe("deriveMasterySnapshot", () => {
  it("grades by measured recall: >=3 reps mastered, 1-2 developing, fresh new", () => {
    const snapshot = deriveMasterySnapshot([
      cell({ id: "M", concept: "Mastered", review: review({ reps: 3 }) }),
      cell({ id: "D", concept: "Developing", review: review({ reps: 1 }) }),
      cell({ id: "N", concept: "New", type: "progress", confidence: 0.6 })
    ]);
    const levels = Object.fromEntries(
      snapshot.concepts.map((item) => [item.concept, item.mastery])
    );
    expect(levels).toEqual({ Mastered: "mastered", Developing: "developing", New: "new" });
  });

  it("lets a fresh lapse pull a concept to struggling and sums its lapses", () => {
    const snapshot = deriveMasterySnapshot([
      cell({ id: "L", concept: "Chain rule", confidence: 0.9, review: review({ reps: 0, lapses: 2 }) })
    ]);
    expect(snapshot.concepts[0]?.mastery).toBe("struggling");
    expect(snapshot.concepts[0]?.lapses).toBe(2);
  });

  it("forces struggling for an unresolved misconception even beside a mastered cell", () => {
    const snapshot = deriveMasterySnapshot([
      cell({ id: "OK", concept: "Attention", type: "understanding", review: review({ reps: 4 }) }),
      cell({ id: "BUG", concept: "Attention", type: "misconception", review: review({ reps: 0 }) })
    ]);
    expect(snapshot.concepts).toHaveLength(1);
    expect(snapshot.concepts[0]?.mastery).toBe("struggling");
    expect(snapshot.concepts[0]?.cellIds).toEqual(["BUG", "OK"]);
    expect(snapshot.misconceptions.map((item) => item.concept)).toEqual(["Attention"]);
  });

  it("treats a misconception now recalled reliably as resolved (measured recall wins)", () => {
    const snapshot = deriveMasterySnapshot([
      cell({ id: "FIXED", concept: "Query vs Key", type: "misconception", review: review({ reps: 3, lapses: 1 }) })
    ]);
    expect(snapshot.concepts[0]?.mastery).toBe("mastered");
    expect(snapshot.misconceptions).toEqual([]);
  });

  it("falls back to the heuristic when a concept has no review history", () => {
    const snapshot = deriveMasterySnapshot([
      cell({ id: "W", concept: "Weak", status: "needs_review", confidence: 0.3 }),
      cell({ id: "S", concept: "Solid", type: "understanding", confidence: 0.9 })
    ]);
    const levels = Object.fromEntries(
      snapshot.concepts.map((item) => [item.concept, item.mastery])
    );
    expect(levels).toEqual({ Weak: "struggling", Solid: "developing" });
  });

  it("orders struggling-first, then by lapses, and skips blank concepts", () => {
    const snapshot = deriveMasterySnapshot([
      cell({ id: "A", concept: "Mastered", review: review({ reps: 5 }) }),
      cell({ id: "B", concept: "BadLots", confidence: 0.4, review: review({ reps: 0, lapses: 3 }) }),
      cell({ id: "C", concept: "BadFew", confidence: 0.4, review: review({ reps: 0, lapses: 1 }) }),
      cell({ id: "D", concept: "   " })
    ]);
    expect(snapshot.concepts.map((item) => item.concept)).toEqual([
      "BadLots",
      "BadFew",
      "Mastered"
    ]);
  });
});

describe("summarizeMastery", () => {
  it("names concepts per level and calls out misconceptions explicitly", () => {
    const summary = summarizeMastery(
      deriveMasterySnapshot([
        cell({ id: "A", concept: "Backprop", review: review({ reps: 4 }) }),
        cell({ id: "B", concept: "Gradients", review: review({ reps: 1 }) }),
        cell({ id: "C", concept: "Chain rule", type: "misconception", review: review({ reps: 0 }) })
      ])
    );
    expect(summary).toContain("Mastered: Backprop.");
    expect(summary).toContain("Developing: Gradients.");
    expect(summary).toContain("Struggling: Chain rule.");
    expect(summary).toContain("Misconceptions to address: Chain rule.");
  });

  it("returns an empty string when there are no graded concepts", () => {
    expect(summarizeMastery(deriveMasterySnapshot([]))).toBe("");
  });
});

describe("calibrateProfileClaims", () => {
  const cells = [
    cell({ id: "MEM-weak", concept: "Chain rule", type: "misconception", review: review({ reps: 0 }) }),
    cell({ id: "MEM-ok", concept: "Backprop", review: review({ reps: 4 }) })
  ];

  it("flags a claim whose evidence cites a struggling concept", () => {
    const result = calibrateProfileClaims(
      [
        { statement: "Understands the chain rule.", evidence: ["MEM-weak", "MEM-ok"] },
        { statement: "Understands backprop.", evidence: ["MEM-ok"] }
      ],
      cells
    );
    expect(result).toEqual([{ claimIndex: 0, strugglingConcepts: ["Chain rule"] }]);
  });

  it("ignores evidence that is not a memory cell (e.g. a scene id)", () => {
    expect(
      calibrateProfileClaims(
        [{ statement: "Likes examples.", evidence: ["SCENE-transformers"] }],
        cells
      )
    ).toEqual([]);
  });
});

describe("deriveStudyPlan / summarizeStudyPlan", () => {
  const now = "2026-06-15T10:00:00.000Z";
  const past = "2026-06-14T10:00:00.000Z";
  const future = "2026-06-20T10:00:00.000Z";

  it("collects active goals and cells due now, excluding archived", () => {
    const plan = deriveStudyPlan(
      [
        cell({ id: "G1", type: "goal", concept: "Finish transformers", review: review({ dueAt: future }) }),
        cell({ id: "G2", type: "goal", concept: "Archived goal", status: "archived", review: review({ dueAt: future }) }),
        cell({ id: "DUE", concept: "Attention", review: review({ dueAt: past }) }),
        cell({ id: "NEW", concept: "Unscheduled" }),
        cell({ id: "LATER", concept: "Later", review: review({ dueAt: future }) })
      ],
      now
    );
    expect(plan.goals.map((c) => c.id)).toEqual(["G1"]);
    expect(plan.due.map((c) => c.id)).toEqual(["NEW", "DUE"]);
  });

  it("summarizes goals and the due-review concepts", () => {
    const summary = summarizeStudyPlan(
      deriveStudyPlan(
        [
          cell({ id: "G1", type: "goal", concept: "Master attention", review: review({ dueAt: future }) }),
          cell({ id: "DUE", concept: "Backprop", review: review({ dueAt: past }) })
        ],
        now
      )
    );
    expect(summary).toContain("Goals: Master attention.");
    expect(summary).toContain("Due for review (1): Backprop.");
  });

  it("returns an empty string with no goals and nothing due", () => {
    const summary = summarizeStudyPlan(
      deriveStudyPlan(
        [cell({ id: "X", concept: "X", review: review({ dueAt: "2999-01-01T00:00:00.000Z" }) })],
        now
      )
    );
    expect(summary).toBe("");
  });
});
