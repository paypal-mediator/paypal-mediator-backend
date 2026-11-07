import { mockWebhookEvent } from './paypal-webhook.js';

export type DisputeEventType =
  | 'CUSTOMER.DISPUTE.CREATED'
  | 'CUSTOMER.DISPUTE.UPDATED'
  | 'CUSTOMER.DISPUTE.RESOLVED';

interface MutableDisputeResource {
  dispute_id: string;
  create_time: string;
  update_time?: string;
  status: string;
  reason: string;
  dispute_life_cycle_stage?: string;
  dispute_amount?: { currency_code: string; value: string };
  seller_response_due_date?: string;
  dispute_outcome?: { outcome_code: string };
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    gross_amount?: { currency_code: string; value: string };
  }>;
  source?: string;
}

export interface DisputeEventOptions {
  eventType?: DisputeEventType;
  eventId?: string;
  disputeId?: string;
  status?: string;
  stage?: string;
  reason?: string;
  outcome?: string | null;
  sellerTransactionIds?: string[];
  occurredAt?: string;
  disputedAt?: string;
  deadlineAt?: string | null;
  amount?: string;
  currency?: string;
}

// DEMO / MOCK dispute webhook built on the shared envelope fixture.
export function disputeEvent(options: DisputeEventOptions = {}) {
  const event = mockWebhookEvent(
    options.eventType ?? 'CUSTOMER.DISPUTE.CREATED',
  );
  const resource = event.resource as unknown as MutableDisputeResource;
  event.id = options.eventId ?? event.id;
  event.create_time = options.occurredAt ?? event.create_time;
  resource.dispute_id = options.disputeId ?? resource.dispute_id;
  if (options.disputedAt) resource.create_time = options.disputedAt;
  if (options.status) resource.status = options.status;
  if (options.stage !== undefined)
    resource.dispute_life_cycle_stage = options.stage;
  if (options.reason !== undefined) resource.reason = options.reason;
  if (options.amount !== undefined) {
    const currency = options.currency ?? 'USD';
    resource.dispute_amount = {
      currency_code: currency,
      value: options.amount,
    };
    if (resource.disputed_transactions?.[0])
      resource.disputed_transactions[0].gross_amount = {
        currency_code: currency,
        value: options.amount,
      };
  }
  if (options.deadlineAt === null) delete resource.seller_response_due_date;
  else if (options.deadlineAt)
    resource.seller_response_due_date = options.deadlineAt;
  if (options.outcome === null) delete resource.dispute_outcome;
  else if (options.outcome)
    resource.dispute_outcome = { outcome_code: options.outcome };
  if (options.sellerTransactionIds)
    resource.disputed_transactions = options.sellerTransactionIds.map(
      (sellerTransactionId) => ({
        seller_transaction_id: sellerTransactionId,
        buyer_transaction_id: 'MOCK-BUYER',
        gross_amount: resource.dispute_amount,
      }),
    );
  return event;
}
