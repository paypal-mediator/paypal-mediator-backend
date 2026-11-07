import { z } from 'zod';
import { OrderResponseSchema } from './orders.js';
import { EvidenceReceiptSchema } from './evidence.js';
import {
  SourceOrderResponseSchema,
  OrderEnrichmentSchema,
} from './order-sources.js';

export const TransactionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  paypalCaptureId: z.string().min(1).max(255).optional(),
});
export type TransactionQuery = z.infer<typeof TransactionQuerySchema>;

export const TransactionResponseSchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  environment: z.literal('sandbox'),
  paypalCaptureId: z.string(),
  paypalOrderId: z.string().nullable(),
  merchantOrderReference: z.string().nullable(),
  invoiceId: z.string().nullable(),
  status: z.literal('COMPLETED'),
  amount: z.object({ currencyCode: z.string(), value: z.string() }),
  capturedAt: z.iso.datetime(),
  sourceEventId: z.uuid(),
  createdAt: z.iso.datetime(),
  order: z.union([OrderResponseSchema, SourceOrderResponseSchema]).nullable(),
  orderEnrichment: OrderEnrichmentSchema,
  orderLink: z.object({
    status: z.enum(['UNLINKED', 'LINKED', 'CONFLICT']),
    reason: z.string().nullable(),
  }),
  readiness: z.object({
    status: z.enum(['READY', 'INCOMPLETE', 'NEEDS_REVIEW']),
    basis: z.literal('DOCUMENT_COVERAGE'),
    containsDemo: z.boolean(),
    dossierId: z.uuid().nullable(),
    evidenceRevision: z.number().int(),
    reasons: z.array(z.string()),
    checks: z.array(
      z.object({
        code: z.enum([
          'PAYMENT_RECORD',
          'ORDER_REFERENCE',
          'ORDER_RECORD',
          'TRACKING',
          'PROOF_OF_DELIVERY',
        ]),
        status: z.enum(['PRESENT', 'MISSING', 'CONFLICT']),
        evidenceIds: z.array(z.uuid()),
      }),
    ),
  }),
});
export type TransactionResponse = z.infer<typeof TransactionResponseSchema>;
export const EvidenceRegistrationResponseSchema = EvidenceReceiptSchema.extend({
  transaction: TransactionResponseSchema,
});

export const TransactionListResponseSchema = z.object({
  items: z.array(TransactionResponseSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
