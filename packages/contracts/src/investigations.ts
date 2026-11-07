import { z } from 'zod';

export const InvestigationProviderSchema = z.enum(['NVIDIA', 'OPENAI']);
const text = z.string().trim().min(1).max(2000);
const citation = z.strictObject({
  statement: text,
  evidenceIds: z.array(z.uuid()).min(1).max(32),
});
export const InvestigationDraftSchema = z.strictObject({
  summary: text,
  findings: z.array(citation).max(32),
  missing: z
    .array(
      z.strictObject({ code: z.string().min(1).max(80), explanation: text }),
    )
    .max(32),
  contradictions: z.array(citation).max(32),
  irrelevantEvidenceIds: z.array(z.uuid()).max(32),
  suggestedResponse: z.string().max(6000),
});
export type InvestigationDraft = z.infer<typeof InvestigationDraftSchema>;
// Portable command envelope: the backend interprets only this allowlist.
export const InvestigationStepSchema = z.strictObject({
  action: z.enum(['READ_EVIDENCE', 'FINISH']),
  evidenceId: z.uuid().nullable(),
  result: InvestigationDraftSchema.nullable(),
});
export const StartInvestigationSchema = z.strictObject({
  idempotencyKey: z.uuid(),
});
export type StartInvestigation = z.infer<typeof StartInvestigationSchema>;
export const InvestigationResponseSchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  transactionId: z.uuid(),
  idempotencyKey: z.uuid(),
  status: z.enum(['RUNNING', 'COMPLETED', 'FAILED']),
  provider: InvestigationProviderSchema,
  model: z.string(),
  promptVersion: z.string(),
  evidenceRevision: z.number().int(),
  containsDemo: z.boolean(),
  commercialSource: z.enum(['NOT_CONNECTED', 'AVAILABLE']),
  requiresVerification: z.literal(true),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
  stale: z.boolean(),
  result: InvestigationDraftSchema.nullable(),
  deterministicIssues: z.array(z.string()),
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
export type InvestigationResponse = z.infer<typeof InvestigationResponseSchema>;
export const InvestigationListSchema = z.object({
  items: z.array(InvestigationResponseSchema),
});
