import { z } from "zod";

const isoDateSchema = z.string().datetime({ offset: true });
const idSchema = z.string().trim().min(1).max(160);
const tagSchema = z.string().trim().min(1).max(80);

export const cellTypeSchema = z.enum([
  "understanding",
  "misconception",
  "goal",
  "difficulty",
  "strategy",
  "progress"
]);

export const memoryCellStatusSchema = z.enum([
  "new",
  "partially_understood",
  "stable",
  "needs_review",
  "draft",
  "active",
  "superseded",
  "archived"
]);

// SM-2 spaced-repetition schedule. Dates are plain strings (the runtime always
// writes ISO via nowIso) so a hand-edited cell never fails to parse the whole cell.
export const reviewStateSchema = z.object({
  ease: z.number().min(1),
  intervalDays: z.number().min(0),
  reps: z.number().min(0),
  lapses: z.number().min(0),
  dueAt: z.string().min(1),
  lastReviewedAt: z.string().min(1).optional()
});

export const memoryCellSchema = z.object({
  id: idSchema.regex(/^(?:CELL|MEM)-[A-Za-z0-9_-]+$/),
  type: cellTypeSchema,
  concept: z.string().trim().min(1),
  domain: z.string().trim().min(1).optional(),
  status: memoryCellStatusSchema,
  summary: z.string().trim().min(1),
  sourceAnnotations: z
    .array(idSchema.regex(/^ANN-[A-Za-z0-9_-]+$/))
    .min(1),
  tags: z.array(tagSchema).default([]),
  confidence: z.number().min(0).max(1),
  validFrom: isoDateSchema.optional(),
  validUntil: isoDateSchema.optional(),
  supersedes: z.array(idSchema).optional(),
  agentGuidance: z.string().trim().min(1).optional(),
  review: reviewStateSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});

export const sceneTypeSchema = z.enum([
  "topic",
  "course",
  "document",
  "project"
]);

export const sceneSchema = z.object({
  id: idSchema.regex(/^SCENE-[A-Za-z0-9_-]+$/),
  type: sceneTypeSchema,
  title: z.string().trim().min(1),
  status: z.enum(["active", "archived"]),
  summary: z.string().trim().min(1),
  cells: z.array(idSchema.regex(/^(?:CELL|MEM)-[A-Za-z0-9_-]+$/)),
  tags: z.array(tagSchema).default([]),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});

export const profileClaimSchema = z.object({
  statement: z.string().trim().min(1),
  evidence: z.array(idSchema).min(1)
});

export const learnerProfileSchema = z
  .object({
    id: z.enum(["learner-profile", "preferences"]),
    kind: z.enum(["learner-profile", "preferences"]),
    title: z.string().trim().min(1),
    status: z.enum(["active", "archived"]),
    summary: z.string().trim(),
    claims: z.array(profileClaimSchema),
    tags: z.array(tagSchema).default([]),
    updatedAt: isoDateSchema
  })
  .superRefine((profile, context) => {
    if (profile.id !== profile.kind) {
      context.addIssue({
        code: "custom",
        message: "Profile id and kind must match",
        path: ["id"]
      });
    }
    if (profile.kind === "learner-profile") {
      for (const [index, claim] of profile.claims.entries()) {
        if (new Set(claim.evidence).size < 2) {
          context.addIssue({
            code: "custom",
            message: "Learner profile claims require two distinct evidence links",
            path: ["claims", index, "evidence"]
          });
        }
      }
    }
  });

export const chatLogEngineSchema = z.enum(["opencode", "api"]);
export const chatLogModeSchema = z.enum(["ask", "plan", "build"]);

const chatLogTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.string()
});

// A saved sidebar chat session (raw transcript; deliberately outside the
// cell/profile knowledge model). Dates are plain strings, like reviewState.
export const chatLogSchema = z.object({
  id: idSchema.regex(/^CHAT-[A-Za-z0-9_-]+$/),
  title: z.string().trim().min(1),
  engine: chatLogEngineSchema,
  mode: chatLogModeSchema,
  status: z.enum(["active", "archived"]),
  turns: z.array(chatLogTurnSchema),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});

/** Frontmatter-only head (turn count instead of turns) for cheap listings. */
export const chatLogHeadSchema = z.object({
  id: idSchema.regex(/^CHAT-[A-Za-z0-9_-]+$/),
  title: z.string().trim().min(1),
  engine: chatLogEngineSchema,
  mode: chatLogModeSchema,
  status: z.enum(["active", "archived"]),
  turns: z.number().int().min(0),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});

export const proposalSchema = z.object({
  id: idSchema.regex(/^PROP-[A-Za-z0-9_-]+$/),
  operation: z.enum(["create", "update"]),
  targetKind: z.enum([
    "memory-cell",
    "scene",
    "learner-profile",
    "preferences"
  ]),
  targetPath: z.string().trim().min(1),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: z.enum(["pending", "approved", "rejected", "stale"]),
  candidate: z.string().min(1),
  createdAt: isoDateSchema,
  resolvedAt: isoDateSchema.optional()
});
