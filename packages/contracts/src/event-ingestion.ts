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
    .regex(/^[A-Z0-9_.]+$/),
  create_time: z.iso.datetime({ offset: true }),
  resource: z.record(z.string(), z.unknown()),
});
export type PayPalWebhookEnvelope = z.infer<typeof PayPalWebhookEnvelopeSchema>;

export const IngestionJobKindSchema = z.enum([
  'TRANSACTION_CAPTURED',
  'DISPUTE_CHANGED',
]);
export type IngestionJobKind = z.infer<typeof IngestionJobKindSchema>;

export const WebhookReceiptSchema = z.object({
  eventId: z.uuid(),
  paypalEventId: z.string(),
  outcome: z.enum(['ACCEPTED', 'DUPLICATE', 'IGNORED']),
  jobId: z.uuid().nullable(),
});
export type WebhookReceipt = z.infer<typeof WebhookReceiptSchema>;
