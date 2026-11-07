import { z } from 'zod';
import {
  PayPalWebhookEnvelopeSchema,
  type DisputeInternalState,
  type DisputePayPalStage,
  type DisputePayPalStatus,
  type DisputeReasonCategory,
} from '@resolve-ai/contracts';
import { IngestionRejection } from '../event-ingestion/index.js';

const DISPUTE_EVENT_TYPES = new Set([
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
]);

export type DisputeEventType =
  | 'CUSTOMER.DISPUTE.CREATED'
  | 'CUSTOMER.DISPUTE.UPDATED'
  | 'CUSTOMER.DISPUTE.RESOLVED';

const reference = z.string().trim().min(1).max(255);
const positiveMoney = z.object({
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  value: z
    .string()
    .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
    .refine((value) => /[1-9]/.test(value)),
});
const DisputedTransactionSchema = z.object({
  seller_transaction_id: reference.optional(),
  buyer_transaction_id: reference.optional(),
  invoice_number: reference.optional(),
  custom: reference.optional(),
  gross_amount: positiveMoney.optional(),
});
const DisputeResourceSchema = z.object({
  dispute_id: reference,
  create_time: z.iso.datetime({ offset: true }),
  update_time: z.iso.datetime({ offset: true }).optional(),
  status: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(128),
  dispute_life_cycle_stage: z.string().trim().min(1).max(64).optional(),
  dispute_amount: positiveMoney.optional(),
  seller_response_due_date: z.iso.datetime({ offset: true }).optional(),
  dispute_outcome: z
    .object({ outcome_code: z.string().trim().min(1).max(64) })
    .optional(),
  disputed_transactions: z.array(DisputedTransactionSchema).max(64).optional(),
});

const STATUSES: Record<string, DisputePayPalStatus> = {
  OPEN: 'OPEN',
  WAITING_FOR_BUYER_RESPONSE: 'WAITING_FOR_BUYER_RESPONSE',
  WAITING_FOR_SELLER_RESPONSE: 'WAITING_FOR_SELLER_RESPONSE',
  UNDER_REVIEW: 'UNDER_REVIEW',
  RESOLVED: 'RESOLVED',
  OTHER: 'OTHER',
};

const STAGES: Record<string, DisputePayPalStage> = {
  INQUIRY: 'INQUIRY',
  CHARGEBACK: 'CHARGEBACK',
  PRE_ARBITRATION: 'PRE_ARBITRATION',
  ARBITRATION: 'ARBITRATION',
  OTHER: 'OTHER',
};

const REASON_CATEGORIES: Record<string, DisputeReasonCategory> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'ITEM_NOT_RECEIVED',
  ITEM_NOT_RECEIVED: 'ITEM_NOT_RECEIVED',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'NOT_AS_DESCRIBED',
  SIGNIFICANTLY_NOT_AS_DESCRIBED: 'NOT_AS_DESCRIBED',
  UNAUTHORISED: 'UNAUTHORIZED',
  UNAUTHORIZED_TRANSACTION: 'UNAUTHORIZED',
  DUPLICATE_TRANSACTION: 'DUPLICATE',
};

export interface ParsedDisputeEvent {
  eventType: DisputeEventType;
  paypalEventId: string;
  occurredAt: Date;
  paypalDisputeId: string;
  paypalStatus: DisputePayPalStatus;
  paypalStage: DisputePayPalStage;
  paypalReason: string;
  paypalOutcome: string | null;
  reasonCategory: DisputeReasonCategory;
  amount: { currencyCode: string; value: string } | null;
  disputedAt: Date;
  deadlineAt: Date | null;
  sellerTransactionIds: string[];
  resolution: DisputeInternalState | null;
}

function resolutionState(
  status: DisputePayPalStatus,
  outcomeCode: string | null,
): DisputeInternalState | null {
  if (status !== 'RESOLVED' || !outcomeCode) return null;
  // PayPal's official outcome code is the only source for a final state.
  if (outcomeCode === 'RESOLVED_SELLER_FAVOUR') return 'RESOLVED_WON';
  if (outcomeCode === 'RESOLVED_BUYER_FAVOUR') return 'RESOLVED_LOST';
  return 'CLOSED';
}

export function parseDisputeEvent(payload: unknown): ParsedDisputeEvent {
  const envelope = PayPalWebhookEnvelopeSchema.safeParse(payload);
  if (!envelope.success || !DISPUTE_EVENT_TYPES.has(envelope.data.event_type))
    throw new IngestionRejection('INVALID_DISPUTE');
  const result = DisputeResourceSchema.safeParse(envelope.data.resource);
  if (!result.success) throw new IngestionRejection('INVALID_DISPUTE');
  const resource = result.data;

  const paypalStatus = STATUSES[resource.status] ?? 'OTHER';
  const paypalOutcome = resource.dispute_outcome?.outcome_code ?? null;
  const amount =
    resource.dispute_amount ??
    resource.disputed_transactions?.[0]?.gross_amount;
  const sellerTransactionIds = [
    ...new Set(
      (resource.disputed_transactions ?? [])
        .map((transaction) => transaction.seller_transaction_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  return {
    eventType: envelope.data.event_type as DisputeEventType,
    paypalEventId: envelope.data.id,
    occurredAt: new Date(envelope.data.create_time),
    paypalDisputeId: resource.dispute_id,
    paypalStatus,
    paypalStage: STAGES[resource.dispute_life_cycle_stage ?? ''] ?? 'OTHER',
    paypalReason: resource.reason,
    paypalOutcome,
    reasonCategory: REASON_CATEGORIES[resource.reason] ?? 'OTHER',
    amount: amount
      ? { currencyCode: amount.currency_code, value: amount.value }
      : null,
    disputedAt: new Date(resource.create_time),
    deadlineAt: resource.seller_response_due_date
      ? new Date(resource.seller_response_due_date)
      : null,
    sellerTransactionIds,
    resolution: resolutionState(paypalStatus, paypalOutcome),
  };
}
