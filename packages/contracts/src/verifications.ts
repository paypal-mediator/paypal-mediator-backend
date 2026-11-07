import { z } from 'zod';
import { InvestigationProviderSchema } from './investigations.js';

const reason = z.strictObject({
  code: z.string().min(1).max(80),
  explanation: z.string().min(1).max(2000),
  evidenceIds: z.array(z.uuid()).max(32),
});
export const VerificationResultSchema = z.strictObject({
  verdict: z.enum(['APPROVED', 'INCOMPLETE', 'REJECTED']),
  verifiedEvidenceIds: z.array(z.uuid()).max(64),
  missingRequirements: z.array(z.string().min(1).max(2000)).max(64),
  contradictions: z.array(z.string().min(1).max(2000)).max(64),
  reasons: z.array(reason).min(1).max(64),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export const VerificationStepSchema = z.strictObject({
  action: z.enum(['READ_EVIDENCE', 'FINISH']),
  evidenceId: z.uuid().nullable(),
  result: VerificationResultSchema.nullable(),
});
export const StartVerificationSchema = z.strictObject({
  idempotencyKey: z.uuid(),
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
