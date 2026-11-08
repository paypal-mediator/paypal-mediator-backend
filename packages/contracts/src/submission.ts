import { z } from 'zod';

// SubmissionGuard verdict: whether the evidence may be submitted to PayPal.
export const SubmissionGuardVerdictSchema = z.enum(['ALLOWED', 'BLOCKED']);
export type SubmissionGuardVerdict = z.infer<
  typeof SubmissionGuardVerdictSchema
>;

// Deterministic reason why the guard blocked (or allowed) a submission.
export const SubmissionGuardReasonSchema = z.strictObject({
  code: z.string().min(1).max(80).describe('Machine-readable guard rule code'),
  explanation: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('Human-readable explanation'),
  evidenceIds: z.array(z.uuid()).max(32),
});
export type SubmissionGuardReason = z.infer<typeof SubmissionGuardReasonSchema>;

// Result of evaluating the Submission Guard before any PayPal call.
export const SubmissionGuardResultSchema = z.strictObject({
  verdict: SubmissionGuardVerdictSchema,
  reasons: z.array(SubmissionGuardReasonSchema).min(1).max(64),
});
export type SubmissionGuardResult = z.infer<typeof SubmissionGuardResultSchema>;

// Final submission outcome recorded in the database.
export const SubmissionStatusSchema = z.enum([
  'SUBMITTED',
  'BLOCKED',
  'FAILED',
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

// Contract returned by the submit endpoint.
export const SubmissionResultSchema = z.strictObject({
  id: z.uuid(),
  disputeId: z.uuid(),
  status: SubmissionStatusSchema,
  paypalRequestId: z.string().nullable(),
  paypalResponseStatus: z.number().int().nonnegative().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  errorCode: z.string().max(80).nullable(),
  errorMessage: z.string().max(2000).nullable(),
  guardResult: SubmissionGuardResultSchema,
  createdAt: z.iso.datetime(),
});
export type SubmissionResult = z.infer<typeof SubmissionResultSchema>;

// Request body for POST /api/disputes/:id/submit.
export const SubmitRequestSchema = z.strictObject({
  idempotencyKey: z.uuid(),
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

// List response for GET /api/submissions.
export const SubmissionListResponseSchema = z.object({
  items: z.array(SubmissionResultSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type SubmissionListResponse = z.infer<
  typeof SubmissionListResponseSchema
>;
