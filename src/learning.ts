// Classify memory cells into the learner's strengths, weaknesses, and
// problem-solving methods. Measured spaced-repetition performance (SM-2
// reps/lapses, see srs.ts) is the primary signal — what the learner actually
// recalled outranks the LLM's one-shot confidence guess — and a cell's
// type/status/confidence are the fallback only when it has no review history yet.
// Pure (only pure model/SRS imports) so it is unit-testable and reused by the
// notebook's learner summary, the opt-in feedback commands, and (Phase P3) the
// per-concept mastery model that grounds the learner profile in measured recall.

import type { MemoryCell, ProfileClaim } from "./model.js";
import { dueCells } from "./srs.js";

export type LearningClassification = {
  strengths: MemoryCell[];
  weaknesses: MemoryCell[];
  methods: MemoryCell[];
};

// `reps` counts consecutive successful recalls and resets to 0 on a lapse, so a
// streak is current, demonstrated retention; reps 0 with a past lapse is a
// currently-active gap (a brand-new cell — reps 0, no lapse — is neither).
const MASTERED_REPS = 3;

/** Recalled several times running in spaced review — current, measured retention. */
function recalledReliably(cell: MemoryCell): boolean {
  return reps(cell) >= MASTERED_REPS;
}

/** Forgotten in spaced review and not yet re-learned — a current, measured gap. */
function recentlyLapsed(cell: MemoryCell): boolean {
  return reps(cell) === 0 && lapses(cell) > 0;
}

/** A cell that signals solid understanding (fallback when there's no review history). */
export function isStrength(cell: MemoryCell): boolean {
  return (
    cell.type === "understanding" ||
    cell.type === "strategy" ||
    cell.status === "stable" ||
    cell.confidence >= 0.8
  );
}

/** A cell that signals a gap to revisit (fallback when there's no review history). */
export function isWeakness(cell: MemoryCell): boolean {
  return (
    cell.type === "misconception" ||
    cell.type === "difficulty" ||
    cell.status === "needs_review" ||
    cell.confidence < 0.5
  );
}

/**
 * Split cells into strengths / weaknesses / methods. Spaced-repetition history
 * decides first — a reliably-recalled cell is a strength and a freshly-lapsed one
 * a weakness, however the LLM rated it — and cells with no review yet fall back to
 * the type/status/confidence heuristic (where weakness wins ties, since gaps
 * deserve attention first). `methods` cross-cuts (every `strategy` cell). Each
 * list is deterministically sorted: most-forgotten weaknesses and best-recalled
 * strengths first.
 */
export function classifyCells(cells: MemoryCell[]): LearningClassification {
  const strengths: MemoryCell[] = [];
  const weaknesses: MemoryCell[] = [];
  const methods: MemoryCell[] = [];
  for (const cell of cells) {
    if (cell.type === "strategy") methods.push(cell);
    if (recentlyLapsed(cell)) weaknesses.push(cell);
    else if (recalledReliably(cell)) strengths.push(cell);
    else if (isWeakness(cell)) weaknesses.push(cell);
    else if (isStrength(cell)) strengths.push(cell);
  }
  // Most-forgotten weaknesses first; best-recalled, most-confident strengths
  // first; newest methods first. `id` is the deterministic final tiebreak.
  weaknesses.sort(
    (a, b) => lapses(b) - lapses(a) || a.confidence - b.confidence || a.id.localeCompare(b.id)
  );
  strengths.sort(
    (a, b) => reps(b) - reps(a) || b.confidence - a.confidence || a.id.localeCompare(b.id)
  );
  methods.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { strengths, weaknesses, methods };
}

/**
 * A short, deterministic learner-profile summary built from the cells — a stand-in
 * used until the tutor agent writes a richer profile. Names a few current
 * strengths, gaps, and methods (from classifyCells), de-duplicated by concept.
 * Returns "" when there are no cells, so callers can omit the profile context.
 */
export function deriveProfileSummary(cells: MemoryCell[]): string {
  const { strengths, weaknesses, methods } = classifyCells(cells);
  const names = (list: MemoryCell[]): string =>
    [...new Set(list.map((cell) => cell.concept.trim()).filter(Boolean))]
      .slice(0, 4)
      .join("; ");
  const parts: string[] = [];
  const strong = names(strengths);
  const weak = names(weaknesses);
  const method = names(methods);
  if (strong) parts.push(`Strengths: ${strong}.`);
  if (weak) parts.push(`Working on: ${weak}.`);
  if (method) parts.push(`Methods: ${method}.`);
  return parts.join(" ");
}

// ── Mastery model (Phase P3) ────────────────────────────────────────────────
// The classification above answers "strength or gap?" per cell; the snapshot
// below rolls that up per concept into a measured mastery level (an OLM/ECD-style
// learner model), so prompts and the profile UI reason about concepts, not loose
// cells, and surface misconceptions first.

export type MasteryLevel = "mastered" | "developing" | "struggling" | "new";

export type ConceptMastery = {
  concept: string;
  mastery: MasteryLevel;
  /** Cell ids backing the concept (evidence), sorted for determinism. */
  cellIds: string[];
  /** Best demonstrated recall streak across the concept's cells. */
  reps: number;
  /** Total measured lapses across the concept's cells. */
  lapses: number;
  /** The concept still carries an unresolved misconception. */
  hasMisconception: boolean;
};

export type MasterySnapshot = {
  /** Every graded concept, most-attention-first. */
  concepts: ConceptMastery[];
  /** The subset with an unresolved misconception (surfaced first). */
  misconceptions: ConceptMastery[];
};

// How much attention each level needs (struggling first, mastered last); orders
// the snapshot deterministically.
const MASTERY_RANK: Record<MasteryLevel, number> = {
  struggling: 0,
  developing: 1,
  new: 2,
  mastered: 3
};

/**
 * Roll the cells up into a per-concept mastery snapshot. Spaced-repetition
 * history leads: a concept with a reliably-recalled cell and no active gap is
 * `mastered`, one with a freshly-lapsed cell is `struggling`, and the
 * type/status/confidence heuristic is the fallback only for concepts with no
 * review history yet (`developing` if it looks solid, `struggling` if flagged a
 * gap, else `new`). An unresolved misconception always forces `struggling`
 * (Brown & Burton: address bugs first). Concepts with a blank name are skipped.
 */
export function deriveMasterySnapshot(cells: MemoryCell[]): MasterySnapshot {
  const byConcept = new Map<string, MemoryCell[]>();
  for (const cell of cells) {
    const concept = cell.concept.trim();
    if (!concept) continue;
    const group = byConcept.get(concept);
    if (group) group.push(cell);
    else byConcept.set(concept, [cell]);
  }
  const concepts: ConceptMastery[] = [];
  for (const [concept, group] of byConcept) {
    const hasMisconception = group.some(
      (cell) => cell.type === "misconception" && !recalledReliably(cell)
    );
    let mastery: MasteryLevel;
    if (hasMisconception || group.some(recentlyLapsed)) mastery = "struggling";
    else if (group.some(recalledReliably)) mastery = "mastered";
    else if (group.some((cell) => reps(cell) > 0 || lapses(cell) > 0))
      mastery = "developing";
    else if (group.some(isWeakness)) mastery = "struggling";
    else if (group.some(isStrength)) mastery = "developing";
    else mastery = "new";
    concepts.push({
      concept,
      mastery,
      cellIds: group.map((cell) => cell.id).sort((a, b) => a.localeCompare(b)),
      reps: Math.max(...group.map(reps)),
      lapses: group.reduce((sum, cell) => sum + lapses(cell), 0),
      hasMisconception
    });
  }
  concepts.sort(
    (a, b) =>
      MASTERY_RANK[a.mastery] - MASTERY_RANK[b.mastery] ||
      b.lapses - a.lapses ||
      a.concept.localeCompare(b.concept)
  );
  return {
    concepts,
    misconceptions: concepts.filter((item) => item.hasMisconception)
  };
}

/**
 * A compact, deterministic mastery line for prompt injection: a few concepts per
 * level (misconceptions called out explicitly so the tutor tackles them first).
 * Brand-new concepts are omitted as noise. Returns "" when nothing is graded.
 */
export function summarizeMastery(snapshot: MasterySnapshot): string {
  const names = (level: MasteryLevel): string =>
    snapshot.concepts
      .filter((item) => item.mastery === level)
      .slice(0, 4)
      .map((item) => item.concept)
      .join("; ");
  const parts: string[] = [];
  const mastered = names("mastered");
  const developing = names("developing");
  const struggling = names("struggling");
  if (mastered) parts.push(`Mastered: ${mastered}.`);
  if (developing) parts.push(`Developing: ${developing}.`);
  if (struggling) parts.push(`Struggling: ${struggling}.`);
  const misconceptions = snapshot.misconceptions
    .slice(0, 4)
    .map((item) => item.concept)
    .join("; ");
  if (misconceptions) parts.push(`Misconceptions to address: ${misconceptions}.`);
  return parts.join(" ");
}

export type ClaimCalibration = {
  /** Index of the flagged claim in the profile's `claims` array. */
  claimIndex: number;
  /** Concepts the claim cites that the SRS currently measures as struggling. */
  strugglingConcepts: string[];
};

/**
 * OLM-style negotiation signal: flag profile claims whose cited cell evidence
 * points at concepts the spaced-repetition data now measures as `struggling` (a
 * lapse or unresolved misconception). The agent's prose is never rewritten — the
 * discrepancy is surfaced for the human to reconcile. Returns one entry per
 * conflicting claim, in claim order (empty = no conflicts).
 */
export function calibrateProfileClaims(
  claims: ProfileClaim[],
  cells: MemoryCell[]
): ClaimCalibration[] {
  const conceptByCell = new Map<string, string>();
  for (const cell of cells) conceptByCell.set(cell.id, cell.concept.trim());
  const struggling = new Set(
    deriveMasterySnapshot(cells)
      .concepts.filter((item) => item.mastery === "struggling")
      .map((item) => item.concept)
  );
  const result: ClaimCalibration[] = [];
  claims.forEach((claim, claimIndex) => {
    const concepts = new Set<string>();
    for (const id of claim.evidence) {
      const concept = conceptByCell.get(id);
      if (concept && struggling.has(concept)) concepts.add(concept);
    }
    if (concepts.size > 0) {
      result.push({
        claimIndex,
        strugglingConcepts: [...concepts].sort((a, b) => a.localeCompare(b))
      });
    }
  });
  return result;
}

export type StudyPlan = {
  /** Active goal cells the learner set (Zimmerman: forethought phase). */
  goals: MemoryCell[];
  /** Cells due for spaced review now — the concrete next actions. */
  due: MemoryCell[];
};

/**
 * A self-regulated-learning scaffold (Zimmerman): the learner's active goals plus
 * the cells due for review right now, so a plan can state both intent and
 * concrete next actions. Archived/superseded cells are excluded; `now` is an ISO
 * timestamp. Deterministically ordered (goals newest-first, due most-overdue-first).
 */
export function deriveStudyPlan(cells: MemoryCell[], now: string): StudyPlan {
  const live = cells.filter(
    (cell) => cell.status !== "archived" && cell.status !== "superseded"
  );
  const goals = live
    .filter((cell) => cell.type === "goal")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const due = dueCells(live, now).sort(
    (a, b) =>
      (a.review?.dueAt ?? "").localeCompare(b.review?.dueAt ?? "") ||
      a.id.localeCompare(b.id)
  );
  return { goals, due };
}

/**
 * A compact, deterministic study-plan line: current goals + the concepts due for
 * review (de-duplicated). Returns "" when there are no goals and nothing is due.
 */
export function summarizeStudyPlan(plan: StudyPlan): string {
  const parts: string[] = [];
  const goals = plan.goals
    .slice(0, 3)
    .map((cell) => cell.concept.trim() || cell.summary.trim())
    .filter(Boolean)
    .join("; ");
  if (goals) parts.push(`Goals: ${goals}.`);
  if (plan.due.length > 0) {
    const concepts = [
      ...new Set(plan.due.map((cell) => cell.concept.trim()).filter(Boolean))
    ]
      .slice(0, 6)
      .join("; ");
    parts.push(`Due for review (${plan.due.length}): ${concepts}.`);
  }
  return parts.join(" ");
}

function reps(cell: MemoryCell): number {
  return cell.review?.reps ?? 0;
}

function lapses(cell: MemoryCell): number {
  return cell.review?.lapses ?? 0;
}
