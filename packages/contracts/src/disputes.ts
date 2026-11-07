import { z } from 'zod';

// PayPal owns these values. Anything unrecognised is preserved as OTHER and
// surfaced to the merchant instead of being silently normalised.
export const DisputePayPalStatusSchema = z.enum([
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'OTHER',
]);
export type DisputePayPalStatus = z.infer<typeof DisputePayPalStatusSchema>;

export const DisputePayPalStageSchema = z.enum([
  'INQUIRY',
  'CHARGEBACK',
  'PRE_ARBITRATION',
  'ARBITRATION',
  'OTHER',
]);
export type DisputePayPalStage = z.infer<typeof DisputePayPalStageSchema>;

// Deterministic classification used by M05/M06 later. It never predicts an
// outcome; it only groups PayPal's official reason codes.
export const DisputeReasonCategorySchema = z.enum([
  'ITEM_NOT_RECEIVED',
  'NOT_AS_DESCRIBED',
  'UNAUTHORIZED',
  'DUPLICATE',
  'OTHER',
]);
export type DisputeReasonCategory = z.infer<typeof DisputeReasonCategorySchema>;

// Local M07 state. It is deliberately separate from PayPal's official status.
export const DisputeInternalStateSchema = z.enum([
  'DETECTED',
  'LINKED',
  'NEEDS_REVIEW',
  'RESOLVED_WON',
  'RESOLVED_LOST',
  'CLOSED',
]);
export type DisputeInternalState = z.infer<typeof DisputeInternalStateSchema>;

export const DisputeLinkStatusSchema = z.enum([
  'LINKED',
  'UNLINKED',
  'CONFLICT',
]);
export type DisputeLinkStatus = z.infer<typeof DisputeLinkStatusSchema>;

const money = z.object({
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  value: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/),
});

export const DisputeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  internalState: DisputeInternalStateSchema.optional(),
  paypalStatus: DisputePayPalStatusSchema.optional(),
});
export type DisputeQuery = z.infer<typeof DisputeQuerySchema>;

export const DisputeSummarySchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  environment: z.literal('sandbox'),
  paypalDisputeId: z.string(),
  paypalStatus: DisputePayPalStatusSchema,
  paypalStage: DisputePayPalStageSchema,
  paypalReason: z.string(),
  paypalOutcome: z.string().nullable(),
  reasonCategory: DisputeReasonCategorySchema,
  internalState: DisputeInternalStateSchema,
  amount: money.nullable(),
  disputedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime().nullable(),
  lastEventAt: z.iso.datetime(),
  link: z.object({
    status: DisputeLinkStatusSchema,
    transactionId: z.uuid().nullable(),
    reason: z.string().nullable(),
  }),
  sourceEventId: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DisputeSummary = z.infer<typeof DisputeSummarySchema>;

export const DisputeEventOutcomeSchema = z.enum([
  'APPLIED',
  'IGNORED_STALE',
  'IGNORED_DUPLICATE',
]);
export type DisputeEventOutcome = z.infer<typeof DisputeEventOutcomeSchema>;

export const DisputeEventResponseSchema = z.object({
  id: z.uuid(),
  eventType: z.string(),
  paypalEventId: z.string(),
  outcome: DisputeEventOutcomeSchema,
  reason: z.string().nullable(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});
export type DisputeEventResponse = z.infer<typeof DisputeEventResponseSchema>;

export const DisputeDetailSchema = DisputeSummarySchema.extend({
  events: z.array(DisputeEventResponseSchema),
});
export type DisputeDetail = z.infer<typeof DisputeDetailSchema>;

export const DisputeListResponseSchema = z.object({
  items: z.array(DisputeSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type DisputeListResponse = z.infer<typeof DisputeListResponseSchema>;
