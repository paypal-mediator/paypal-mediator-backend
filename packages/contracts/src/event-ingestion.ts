import { z } from 'zod';

export const PayPalWebhookEnvelopeSchema = z.looseObject({
  id: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/),
  event_type: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z0-9_.-]+$/),
  create_time: z.iso.datetime({ offset: true }),
  resource: z.record(z.string(), z.unknown()),
});
export type PayPalWebhookEnvelope = z.infer<typeof PayPalWebhookEnvelopeSchema>;

export const IngestionJobKindSchema = z.enum([
  'TRANSACTION_CAPTURED',
  'PAYMENT_ADJUSTED',
  'DISPUTE_CHANGED',
]);
export type IngestionJobKind = z.infer<typeof IngestionJobKindSchema>;

// Read identifiers only; never fetch a URL supplied by a webhook.
export function paypalRefundCaptureId(
  resource: Record<string, unknown>,
): string | null {
  const parsed = z
    .object({
      supplementary_data: z
        .object({
          related_ids: z
            .object({ capture_id: z.string().optional() })
            .optional(),
        })
        .optional(),
      links: z
        .array(
          z.object({
            rel: z.string(),
            href: z.string(),
            method: z.string().optional(),
          }),
        )
        .max(32)
        .optional(),
    })
    .safeParse(resource);
  if (!parsed.success) return null;
  const ids = new Set<string>();
  const explicit = parsed.data.supplementary_data?.related_ids?.capture_id;
  if (explicit) ids.add(explicit);
  for (const link of parsed.data.links ?? []) {
    if (link.rel !== 'up') continue;
    try {
      const url = new URL(link.href);
      if (
        url.protocol !== 'https:' ||
        !['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'].includes(
          url.hostname,
        ) ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return null;
      const match = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]{1,255})$/.exec(
        url.pathname,
      );
      if (!match) return null;
      ids.add(match[1]!);
    } catch {
      return null;
    }
  }
  const id = [...ids][0];
  return ids.size === 1 && id && /^[A-Za-z0-9_-]{1,255}$/.test(id) ? id : null;
}

export const WebhookReceiptSchema = z.object({
  eventId: z.uuid(),
  paypalEventId: z.string(),
  outcome: z.enum(['ACCEPTED', 'DUPLICATE', 'IGNORED']),
  jobId: z.uuid().nullable(),
});
export type WebhookReceipt = z.infer<typeof WebhookReceiptSchema>;

export const IngestionJobsQuerySchema = z
  .strictObject({
    status: z.enum(['QUEUED', 'FAILED', 'COMPLETED']).optional(),
    before: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((q) => Boolean(q.before) === Boolean(q.beforeId), {
    message: 'before and beforeId must be supplied together',
  });
export type IngestionJobsQuery = z.infer<typeof IngestionJobsQuerySchema>;
export const RetryIngestionSchema = z.strictObject({});
export const RetryIngestionResponseSchema = z.object({
  id: z.uuid(),
  status: z.literal('QUEUED'),
});
export const IngestionJobSummarySchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  kind: IngestionJobKindSchema,
  status: z.enum(['QUEUED', 'FAILED', 'COMPLETED']),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  event: z.object({
    paypalEventId: z.string(),
    eventType: z.string(),
    receivedAt: z.iso.datetime(),
  }),
});
export const IngestionJobsResponseSchema = z.object({
  items: z.array(IngestionJobSummarySchema),
  nextCursor: z
    .object({ before: z.iso.datetime(), beforeId: z.uuid() })
    .nullable(),
});
export const IngestionHealthSchema = z.object({
  lastReceivedAt: z.iso.datetime().nullable(),
  oldestQueuedAt: z.iso.datetime().nullable(),
  counts: z.object({
    QUEUED: z.number().int(),
    FAILED: z.number().int(),
    COMPLETED: z.number().int(),
  }),
});
