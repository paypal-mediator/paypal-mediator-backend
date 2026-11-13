import { z } from 'zod';
import {
  PayPalWebhookEnvelopeSchema,
  paypalRefundCaptureId,
} from '@resolve-ai/contracts';
import { IngestionRejection } from '../event-ingestion/index.js';

const money = z.object({
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  value: z
    .string()
    .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
    .refine((v) => /[1-9]/.test(v)),
});
const resourceSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
  status: z.literal('COMPLETED'),
  amount: money,
  create_time: z.iso.datetime({ offset: true }),
  seller_payable_breakdown: z
    .object({ total_refunded_amount: money.optional() })
    .optional(),
});

export function parsePaymentAdjustment(payload: unknown) {
  const parsed = PayPalWebhookEnvelopeSchema.safeParse(payload);
  if (
    !parsed.success ||
    !['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'].includes(
      parsed.data.event_type,
    )
  )
    throw new IngestionRejection('INVALID_PAYMENT_ADJUSTMENT');
  const envelope = parsed.data;
  const resource = resourceSchema.safeParse(envelope.resource);
  const paypalCaptureId = paypalRefundCaptureId(envelope.resource);
  if (
    !resource.success ||
    !paypalCaptureId ||
    (envelope.resource_version !== undefined &&
      envelope.resource_version !== '2.0') ||
    (envelope.resource_type !== undefined &&
      envelope.resource_type !== 'refund')
  )
    throw new IngestionRejection('INVALID_PAYMENT_ADJUSTMENT');
  const r = resource.data;
  const cumulative = r.seller_payable_breakdown?.total_refunded_amount;
  if (cumulative && cumulative.currency_code !== r.amount.currency_code)
    throw new IngestionRejection('PAYMENT_ADJUSTMENT_CONFLICT');
  return {
    paypalCaptureId,
    paypalAdjustmentId: r.id,
    kind:
      envelope.event_type === 'PAYMENT.CAPTURE.REVERSED'
        ? 'REVERSAL'
        : 'REFUND',
    currencyCode: r.amount.currency_code,
    amount: r.amount.value,
    cumulativeReturnedAmount: cumulative?.value ?? null,
    occurredAt: new Date(r.create_time),
  };
}
