import { z } from 'zod';

export const CommerceReferenceSchema = z.string().trim().min(1).max(255);
export const DecimalAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/);
export const PositiveAmountSchema = DecimalAmountSchema.refine((value) =>
  /[1-9]/.test(value),
);
export const SourceKindSchema = z.enum(['MERCHANT_INPUT', 'DEMO']);
export const OrderItemSchema = z.strictObject({
  sku: CommerceReferenceSchema.optional(),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(100000),
  unitAmount: DecimalAmountSchema,
});
export const CreateOrderSchema = z.strictObject({
  externalId: CommerceReferenceSchema,
  paypalOrderId: CommerceReferenceSchema.optional(),
  sourceKind: SourceKindSchema,
  sourceSystem: CommerceReferenceSchema,
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  totalAmount: PositiveAmountSchema,
  shippingAmount: DecimalAmountSchema.default('0'),
  taxAmount: DecimalAmountSchema.default('0'),
  discountAmount: DecimalAmountSchema.default('0'),
  orderedAt: z.iso.datetime({ offset: true }),
  items: z.array(OrderItemSchema).min(1).max(100),
});
export type CreateOrder = z.infer<typeof CreateOrderSchema>;
export const OrderResponseSchema = CreateOrderSchema.extend({
  id: z.uuid(),
  merchantId: z.uuid(),
  environment: z.literal('sandbox'),
  paypalOrderId: CommerceReferenceSchema.nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
}).strip();
export type OrderResponse = z.infer<typeof OrderResponseSchema>;
export const OrderReceiptSchema = z.object({
  outcome: z.enum(['CREATED', 'DUPLICATE']),
  order: OrderResponseSchema,
});
export const OrderQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  externalId: CommerceReferenceSchema.optional(),
});
export type OrderQuery = z.infer<typeof OrderQuerySchema>;
export const OrderListResponseSchema = z.object({
  items: z.array(OrderResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
