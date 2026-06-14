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
