import { z } from 'zod';
import { InvestigationProviderSchema } from './investigations.js';

const reason = z.strictObject({
  code: z.string().min(1).max(80),
  explanation: z.string().min(1).max(2000),
  evidenceIds: z.array(z.uuid()).max(32),
});
export const VerificationDimensionSchema = z.enum([
  'PROVENANCE',
  'INTEGRITY',
  'IDENTITY',
  'CONSISTENCY',
  'RELEVANCE',
  'COVERAGE',
  'EXPLAINABILITY',
  'CURRENTNESS',
]);
export const VerificationCheckSchema = z.strictObject({
  status: z.enum(['PASS', 'FAIL', 'NOT_EVALUATED']),
  explanation: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.uuid()).max(32),
});
export const VerificationChecklistSchema = z.strictObject({
  PROVENANCE: VerificationCheckSchema,
  INTEGRITY: VerificationCheckSchema,
  IDENTITY: VerificationCheckSchema,
  CONSISTENCY: VerificationCheckSchema,
  RELEVANCE: VerificationCheckSchema,
  COVERAGE: VerificationCheckSchema,
  EXPLAINABILITY: VerificationCheckSchema,
  CURRENTNESS: VerificationCheckSchema,
});
export const VerificationClaimSchema = z.strictObject({
  unitId: z.string().min(1).max(100),
  statement: z.string().trim().min(1).max(6000),
  status: z.enum([
    'SUPPORTED',
    'UNSUPPORTED',
    'CONTRADICTED',
    'NOT_VERIFIABLE',
    'NON_FACTUAL',
  ]),
  explanation: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.uuid()).max(32),
});
export const RejectionReviewSchema = z.strictObject({
  verificationId: z.uuid(),
  justification: z.string().trim().min(20).max(2000),
});
export const VerificationResultSchema = z.strictObject({
  verdict: z.enum(['APPROVED', 'INCOMPLETE', 'REJECTED']),
  verifiedEvidenceIds: z.array(z.uuid()).max(64),
  missingRequirements: z.array(z.string().min(1).max(2000)).max(1024),
  contradictions: z.array(z.string().min(1).max(2000)).max(1024),
  reasons: z.array(reason).min(1).max(1024),
  checklist: VerificationChecklistSchema,
  claims: z.array(VerificationClaimSchema).max(256),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export const VerificationStepSchema = z.strictObject({
  action: z.enum(['READ_EVIDENCE', 'FINISH']),
  evidenceId: z.uuid().nullable(),
  result: VerificationResultSchema.nullable(),
});
export const StartVerificationSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  rejectionReview: RejectionReviewSchema.optional(),
});
export type StartVerification = z.infer<typeof StartVerificationSchema>;
export const VerificationResponseSchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  transactionId: z.uuid(),
  investigationId: z.uuid(),
  idempotencyKey: z.uuid(),
  status: z.enum(['RUNNING', 'COMPLETED', 'FAILED']),
  provider: InvestigationProviderSchema,
  model: z.string(),
  promptVersion: z.string(),
  evidenceRevision: z.number().int(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
  stale: z.boolean(),
  containsDemo: z.boolean(),
  rejectionReview: RejectionReviewSchema.extend({
    actorUserId: z.uuid(),
    reviewedAt: z.iso.datetime(),
  }).nullable(),
  scope: z.literal('PREVENTIVE_INR'),
  submissionAuthorized: z.literal(false),
  result: VerificationResultSchema.nullable(),
  trace: z.array(
    z.object({
      step: z.number().int(),
      action: z.string(),
      evidenceId: z.uuid().nullable(),
      outcome: z.string(),
    }),
  ),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});
export type VerificationResponse = z.infer<typeof VerificationResponseSchema>;
export const VerificationListSchema = z.object({
  items: z.array(VerificationResponseSchema),
});
