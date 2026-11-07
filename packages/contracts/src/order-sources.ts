import { z } from 'zod';
import { CommerceReferenceSchema, DecimalAmountSchema } from './orders.js';

export const InformationProviderIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const SourceMoneySchema = z.strictObject({
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  value: DecimalAmountSchema,
});
export const NormalizedSourceOrderSchema = z.strictObject({
  providerId: InformationProviderIdSchema,
  sourceKind: z.enum(['PAYPAL', 'CONNECTED_SYSTEM']),
  sourceSystem: CommerceReferenceSchema,
  externalId: CommerceReferenceSchema,
  paypalOrderId: CommerceReferenceSchema.nullable(),
  merchantOrderReference: CommerceReferenceSchema.nullable(),
  invoiceId: CommerceReferenceSchema.nullable(),
  purchaseUnitReference: CommerceReferenceSchema.nullable(),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  totalAmount: DecimalAmountSchema.nullable(),
  shippingAmount: DecimalAmountSchema.nullable(),
  taxAmount: DecimalAmountSchema.nullable(),
  discountAmount: DecimalAmountSchema.nullable(),
  orderedAt: z.iso.datetime().nullable(),
  items: z
    .array(
      z.strictObject({
        sku: CommerceReferenceSchema.nullable(),
        description: z.string().min(1).max(500).nullable(),
        quantity: z.number().int().positive().safe().nullable(),
        unitAmount: DecimalAmountSchema.nullable(),
        currencyCode: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullable(),
      }),
    )
    .max(100),
  breakdown: z.strictObject({
    itemTotal: SourceMoneySchema.nullable(),
    shipping: SourceMoneySchema.nullable(),
    tax: SourceMoneySchema.nullable(),
    handling: SourceMoneySchema.nullable(),
    insurance: SourceMoneySchema.nullable(),
    shippingDiscount: SourceMoneySchema.nullable(),
    discount: SourceMoneySchema.nullable(),
  }),
});
export type NormalizedSourceOrder = z.infer<typeof NormalizedSourceOrderSchema>;
export const SourceOrderResponseSchema = NormalizedSourceOrderSchema.extend({
  id: z.uuid(),
  merchantId: z.uuid(),
  environment: z.literal('sandbox'),
  createdAt: z.iso.datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const OrderSourceResultSchema = z.strictObject({
  order: NormalizedSourceOrderSchema.nullable(),
  association: z.enum(['MATCHED', 'UNRESOLVED', 'CONFLICT']),
  missingFields: z.array(z.string().max(128)).max(512),
  issues: z.array(z.string().max(128)).max(100),
});
export type OrderSourceResult = z.infer<typeof OrderSourceResultSchema>;
export const OrderEnrichmentSchema = z.object({
  status: z.enum([
    'UNAVAILABLE',
    'PENDING',
    'FETCHING',
    'COMPLETE',
    'PARTIAL',
    'CONFLICT',
    'FAILED',
    'NOT_CONFIGURED',
  ]),
  records: z.array(
    z.object({
      providerId: InformationProviderIdSchema,
      status: z.enum([
        'PENDING',
        'FETCHING',
        'COMPLETE',
        'PARTIAL',
        'CONFLICT',
        'FAILED',
        'NOT_CONFIGURED',
      ]),
      sourceKind: z.enum(['PAYPAL', 'CONNECTED_SYSTEM']),
      sourceSystem: z.string(),
      attempts: z.number().int().nonnegative(),
      lastCheckedAt: z.iso.datetime().nullable(),
      lastSucceededAt: z.iso.datetime().nullable(),
      nextAttemptAt: z.iso.datetime().nullable(),
      errorCode: z.string().nullable(),
      httpStatus: z.number().int().nullable(),
      evidenceId: z.uuid().nullable(),
      integrity: z.enum(['VALID', 'INVALID', 'UNAVAILABLE']),
      data: OrderSourceResultSchema.nullable(),
    }),
  ),
});
