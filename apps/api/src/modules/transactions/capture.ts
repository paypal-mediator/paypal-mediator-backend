import { z } from 'zod';
import { PayPalWebhookEnvelopeSchema } from '@resolve-ai/contracts';
import { IngestionRejection } from '../event-ingestion/index.js';

const reference = z.string().trim().min(1).max(255);
const CaptureSchema = z.object({
  id: reference,
  status: z.literal('COMPLETED'),
  amount: z.object({
    currency_code: z.string().regex(/^[A-Z]{3}$/),
    // Exact decimal strings; never convert money through floating point.
    value: z
      .string()
      .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
      .refine((value) => /[1-9]/.test(value)),
  }),
  create_time: z.iso.datetime({ offset: true }),
  custom_id: reference.optional(),
  invoice_id: reference.optional(),
  supplementary_data: z
    .object({
      related_ids: z.object({ order_id: reference.optional() }).optional(),
    })
    .optional(),
});

export function parseCapture(payload: unknown) {
  const envelope = PayPalWebhookEnvelopeSchema.safeParse(payload);
  if (
    !envelope.success ||
    envelope.data.event_type !== 'PAYMENT.CAPTURE.COMPLETED'
  )
    throw new IngestionRejection('INVALID_CAPTURE');
  const result = CaptureSchema.safeParse(envelope.data.resource);
  if (!result.success) throw new IngestionRejection('INVALID_CAPTURE');
  const capture = result.data;
  return {
    paypalCaptureId: capture.id,
    paypalOrderId: capture.supplementary_data?.related_ids?.order_id ?? null,
    merchantOrderReference: capture.custom_id ?? null,
    invoiceId: capture.invoice_id ?? null,
    currencyCode: capture.amount.currency_code,
    amount: capture.amount.value,
    capturedAt: new Date(capture.create_time),
  };
}
