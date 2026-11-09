import { z } from 'zod';

// Deliberately closed metadata: never accept arbitrary logs, prompts or payloads.
export const AuditRecordSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('SETTINGS_UPDATED'),
      details: z
        .object({
          displayNameChanged: z.boolean(),
          allowInvestigations: z.boolean().optional(),
          allowSubmissions: z.boolean().optional(),
          requireMerchantApproval: z.literal(true).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.enum([
        'MERCHANT_ACTION_FAILED',
        'TRANSACTION_ACTION_FAILED',
        'EVIDENCE_ACTION_FAILED',
        'INVESTIGATION_ACTION_FAILED',
        'VERIFICATION_ACTION_FAILED',
        'PAYPAL_CONNECTION_CHECKED',
        'WEBHOOK_RECEIVED',
        'WEBHOOK_DUPLICATE',
        'WEBHOOK_REJECTED',
        'INGESTION_FINISHED',
        'TRANSACTION_CAPTURED',
        'ORDER_CREATED',
        'ORDER_SOURCE_STARTED',
        'ORDER_SOURCE_FINISHED',
        'EVIDENCE_APPENDED',
        'EVIDENCE_DOWNLOADED',
        'EVIDENCE_REFRESHED',
        'INVESTIGATION_STARTED',
        'INVESTIGATION_FINISHED',
        'INVESTIGATION_STEP',
        'VERIFICATION_STARTED',
        'VERIFICATION_FINISHED',
        'VERIFICATION_STEP',
        'SUBMISSION_ATTEMPTED',
        'SUBSCRIPTION_CREATED',
      ]),
      details: z
        .object({
          errorCode: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
            .optional(),
          httpStatus: z.number().int().min(100).max(599).optional(),
          state: z
            .enum([
              'QUEUED',
              'COMPLETED',
              'FAILED',
              'IGNORED',
              'COMPLETE',
              'PARTIAL',
              'CONFLICT',
              'NOT_CONFIGURED',
            ])
            .optional(),
          sourceKind: z
            .enum(['PAYPAL', 'CONNECTED_SYSTEM', 'MERCHANT_INPUT', 'DEMO'])
            .optional(),
          evidenceType: z
            .enum([
              'PAYMENT_RECORD',
              'ORDER_RECORD',
              'ORDER_SOURCE_RECORD',
              'TRACKING',
              'PROOF_OF_DELIVERY',
              'DOCUMENT',
            ])
            .optional(),
          version: z.number().int().min(1).max(256).optional(),
          verdict: z.enum(['APPROVED', 'INCOMPLETE', 'REJECTED']).optional(),
          provider: z.enum(['NVIDIA', 'OPENAI']).optional(),
          step: z.number().int().min(1).max(100).optional(),
          tool: z.enum(['READ_EVIDENCE', 'FINISH']).optional(),
          toolResult: z
            .enum([
              'JSON_ORIGINAL',
              'IMAGE_ORIGINAL',
              'UNSUPPORTED_PDF',
              'IMAGE_BUDGET_EXCEEDED',
              'DRAFT_REQUIRES_VERIFICATION',
              'INDEPENDENT_REVIEW',
            ])
            .optional(),
          evidenceId: z.uuid().optional(),
          observedAt: z.iso.datetime().optional(),
          planId: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export const AuditModuleSchema = z.enum([
  'M01',
  'M02',
  'M03',
  'M04',
  'M05',
  'M06',
]);
export const AuditOutcomeSchema = z.enum([
  'STARTED',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'DUPLICATE',
  'IGNORED',
]);
export const AuditResourceSchema = z.enum([
  'MERCHANT',
  'WEBHOOK',
  'INGESTION_JOB',
  'TRANSACTION',
  'ORDER',
  'ORDER_SOURCE',
  'EVIDENCE',
  'INVESTIGATION',
  'VERIFICATION',
  'SUBMISSION',
  'SUBSCRIPTION',
]);
const counters = {
  durationMs: z.number().int().min(0).max(2147483647).nullable().default(null),
  inputTokens: z.number().int().min(0).max(2147483647).nullable().default(null),
  outputTokens: z
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .nullable()
    .default(null),
};
export const AuditWriteSchema = z
  .object({
    merchantId: z.uuid(),
    actorUserId: z.uuid().nullable(),
    actorKind: z.enum(['USER', 'SYSTEM', 'PAYPAL', 'AGENT']).default('USER'),
    outcome: AuditOutcomeSchema.default('SUCCEEDED'),
    transactionId: z.uuid().nullable().default(null),
    resourceType: AuditResourceSchema.default('MERCHANT'),
    resourceId: z.uuid().nullable().default(null),
    ...counters,
    record: AuditRecordSchema,
  })
  .strict();
export type AuditWrite = z.input<typeof AuditWriteSchema>;

export const ActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    module: AuditModuleSchema.optional(),
    action: z
      .enum([
        'SETTINGS_UPDATED',
        ...AuditRecordSchema.options[1].shape.action.options,
      ])
      .optional(),
    outcome: AuditOutcomeSchema.optional(),
    transactionId: z.uuid().optional(),
    resourceId: z.uuid().optional(),
    resourceType: AuditResourceSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.before) === Boolean(v.beforeId), {
    message: 'before and beforeId must be supplied together',
  })
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), {
    message: 'from must precede to',
  });
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export const ActivityEventSchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  actorUserId: z.uuid().nullable(),
  actorKind: z.enum(['USER', 'SYSTEM', 'PAYPAL', 'AGENT']),
  module: AuditModuleSchema,
  action: z.string(),
  outcome: AuditOutcomeSchema,
  transactionId: z.uuid().nullable(),
  resourceType: AuditResourceSchema,
  resourceId: z.uuid().nullable(),
  ...counters,
  record: AuditRecordSchema,
  createdAt: z.iso.datetime(),
});
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

export const MonitoringMetricsQuerySchema = z
  .object({
    hours: z.coerce.number().int().min(1).max(744).default(24),
  })
  .strict();
export const MonitoringMetricsResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  since: z.iso.datetime(),
  scope: z.literal('AUDITED_EVENTS_SINCE_M09'),
  verdicts: z.array(
    z.object({
      verdict: z.enum(['APPROVED', 'INCOMPLETE', 'REJECTED']),
      count: z.number().int().nonnegative(),
    }),
  ),
  groups: z.array(
    z.object({
      module: AuditModuleSchema,
      action: z.string(),
      outcome: AuditOutcomeSchema,
      count: z.number().int().nonnegative(),
      durationSamples: z.number().int().nonnegative(),
      averageDurationMs: z.number().nonnegative().nullable(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
  current: z.object({
    ingestion: z.array(
      z.object({ status: z.string(), count: z.number().int().nonnegative() }),
    ),
    orderSources: z.array(
      z.object({ status: z.string(), count: z.number().int().nonnegative() }),
    ),
    investigations: z.array(
      z.object({ status: z.string(), count: z.number().int().nonnegative() }),
    ),
    verifications: z.array(
      z.object({ status: z.string(), count: z.number().int().nonnegative() }),
    ),
  }),
});
export const ActivityResponseSchema = z.object({
  items: z.array(ActivityEventSchema),
  nextCursor: z
    .object({ before: z.iso.datetime(), beforeId: z.uuid() })
    .nullable(),
});
