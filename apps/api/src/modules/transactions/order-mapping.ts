import { OrderResponseSchema, type CreateOrder } from '@resolve-ai/contracts';
import {
  Prisma,
  type MerchantOrder,
  type Transaction,
} from '../../generated/prisma/client.js';
import { contentHash } from '../../common/data/content-hash.js';
import type { EvidenceContext } from '../evidence/index.js';

export function normalizeOrder(input: CreateOrder) {
  return {
    externalId: input.externalId,
    paypalOrderId: input.paypalOrderId ?? null,
    sourceKind: input.sourceKind,
    sourceSystem: input.sourceSystem,
    currencyCode: input.currencyCode,
    totalAmount: new Prisma.Decimal(input.totalAmount).toFixed(),
    shippingAmount: new Prisma.Decimal(input.shippingAmount).toFixed(),
    taxAmount: new Prisma.Decimal(input.taxAmount).toFixed(),
    discountAmount: new Prisma.Decimal(input.discountAmount).toFixed(),
    orderedAt: new Date(input.orderedAt).toISOString(),
    items: input.items.map((item) => ({
      ...item,
      unitAmount: new Prisma.Decimal(item.unitAmount).toFixed(),
    })),
  };
}

export function orderResponse(row: MerchantOrder) {
  return OrderResponseSchema.parse({
    ...row,
    totalAmount: row.totalAmount.toFixed(),
    shippingAmount: row.shippingAmount.toFixed(),
    taxAmount: row.taxAmount.toFixed(),
    discountAmount: row.discountAmount.toFixed(),
    orderedAt: row.orderedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

export type TransactionWithOrder = Transaction & {
  merchantOrder: MerchantOrder | null;
};
export function evidenceContext(row: TransactionWithOrder): EvidenceContext {
  const order = row.merchantOrder ? orderResponse(row.merchantOrder) : null;
  const orderLinkError =
    order &&
    contentHash(
      normalizeOrder({
        ...order,
        paypalOrderId: order.paypalOrderId ?? undefined,
      }),
    ) !== order.contentHash
      ? 'ORDER_INTEGRITY_MISMATCH'
      : row.orderLinkError;
  return {
    merchantId: row.merchantId,
    transactionId: row.id,
    paypalCaptureId: row.paypalCaptureId,
    paypalOrderId: row.paypalOrderId,
    merchantOrderReference: row.merchantOrderReference,
    amount: row.amount.toFixed(),
    currencyCode: row.currencyCode,
    capturedAt: row.capturedAt.toISOString(),
    sourceEventId: row.sourceEventId,
    order,
    orderRecordedBy: row.merchantOrder?.createdBy ?? null,
    orderLinkError,
  };
}
