import { OrderResponseSchema, type CreateOrder } from '@resolve-ai/contracts';
import {
  OrderSourceResultSchema,
  SourceOrderResponseSchema,
  OrderEnrichmentSchema,
} from '@resolve-ai/contracts';
import {
  Prisma,
  type MerchantOrder,
  type Transaction,
  type OrderSourceJob,
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
  orderSources?: OrderSourceJob[];
};
export function sourceEnrichment(row: TransactionWithOrder) {
  const records = [...(row.orderSources ?? [])]
    .sort((a, b) => a.providerId.localeCompare(b.providerId))
    .map((job) => {
      const parsed = OrderSourceResultSchema.safeParse(job.normalized);
      const integrity =
        job.normalized === null
          ? 'UNAVAILABLE'
          : parsed.success && contentHash(parsed.data) === job.contentHash
            ? 'VALID'
            : 'INVALID';
      return {
        providerId: job.providerId,
        status: job.status,
        sourceKind: job.sourceKind,
        sourceSystem: job.sourceSystem,
        attempts: job.attempts,
        lastCheckedAt: job.lastCheckedAt?.toISOString() ?? null,
        lastSucceededAt: job.lastSucceededAt?.toISOString() ?? null,
        nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
        errorCode: job.errorCode,
        httpStatus: job.httpStatus,
        evidenceId: job.evidenceId,
        integrity,
        data: integrity === 'VALID' && parsed.success ? parsed.data : null,
      };
    });
  const priority = [
    'CONFLICT',
    'FAILED',
    'NOT_CONFIGURED',
    'FETCHING',
    'PENDING',
    'PARTIAL',
    'COMPLETE',
  ];
  const candidates = records.flatMap((r) =>
    r.data?.order ? [r.data.order] : [],
  );
  const conflicts =
    records.some(
      (r) =>
        r.integrity === 'INVALID' ||
        r.data?.association === 'CONFLICT' ||
        r.data?.issues.length,
    ) ||
    candidates.some(
      (order) =>
        (order.currencyCode !== null &&
          order.currencyCode !== row.currencyCode) ||
        (order.totalAmount !== null && !row.amount.equals(order.totalAmount)) ||
        (order.paypalOrderId !== null &&
          row.paypalOrderId !== null &&
          order.paypalOrderId !== row.paypalOrderId) ||
        (order.merchantOrderReference !== null &&
          row.merchantOrderReference !== null &&
          order.merchantOrderReference !== row.merchantOrderReference) ||
        (order.invoiceId !== null &&
          row.invoiceId !== null &&
          order.invoiceId !== row.invoiceId) ||
        candidates.some(
          (other) =>
            (order.merchantOrderReference !== null &&
              other.merchantOrderReference !== null &&
              order.merchantOrderReference !== other.merchantOrderReference) ||
            (order.invoiceId !== null &&
              other.invoiceId !== null &&
              order.invoiceId !== other.invoiceId),
        ),
    );
  return OrderEnrichmentSchema.parse({
    status: conflicts
      ? 'CONFLICT'
      : records.length
        ? priority.find((s) => records.some((r) => r.status === s))
        : 'UNAVAILABLE',
    records,
  });
}
function sourceOrders(row: TransactionWithOrder) {
  const enrichment = sourceEnrichment(row);
  return enrichment.records.flatMap((record) => {
    const job = row.orderSources!.find(
      (j) => j.providerId === record.providerId,
    )!;
    if (!record.data?.order) return [];
    const order = record.data.order;
    return [
      SourceOrderResponseSchema.parse({
        ...order,
        id: job.id,
        merchantId: row.merchantId,
        environment: 'sandbox',
        createdAt: job.createdAt.toISOString(),
        contentHash: contentHash(order),
      }),
    ];
  });
}
export function evidenceContext(row: TransactionWithOrder): EvidenceContext {
  const manual = row.merchantOrder ? orderResponse(row.merchantOrder) : null;
  const enrichment = sourceEnrichment(row);
  const sources = sourceOrders(row);
  const orders = [...(manual ? [manual] : []), ...sources];
  const matched = [...enrichment.records]
    .sort(
      (a, b) =>
        Number(b.providerId === 'PAYPAL') - Number(a.providerId === 'PAYPAL'),
    )
    .find((r) => r.data?.association === 'MATCHED' && r.data.order);
  const order =
    manual ?? sources.find((o) => o.providerId === matched?.providerId) ?? null;
  let orderLinkError =
    manual &&
    contentHash(
      normalizeOrder({
        ...manual,
        paypalOrderId: manual.paypalOrderId ?? undefined,
      }),
    ) !== manual.contentHash
      ? 'ORDER_INTEGRITY_MISMATCH'
      : row.orderLinkError;
  if (enrichment.records.some((r) => r.integrity === 'INVALID'))
    orderLinkError = 'ORDER_SOURCE_INTEGRITY_MISMATCH';
  if (
    enrichment.records.some(
      (r) => r.data?.association === 'CONFLICT' || r.data?.issues.length,
    )
  )
    orderLinkError = 'ORDER_SOURCE_CONFLICT';
  for (const candidate of sources) {
    if (
      candidate.invoiceId &&
      row.invoiceId &&
      candidate.invoiceId !== row.invoiceId
    )
      orderLinkError = 'ORDER_INVOICE_CONFLICT';
    for (const other of sources) {
      if (
        candidate.merchantOrderReference &&
        other.merchantOrderReference &&
        candidate.merchantOrderReference !== other.merchantOrderReference
      )
        orderLinkError = 'ORDER_REFERENCE_CONFLICT';
      if (
        candidate.invoiceId &&
        other.invoiceId &&
        candidate.invoiceId !== other.invoiceId
      )
        orderLinkError = 'ORDER_INVOICE_CONFLICT';
    }
    if (candidate.currencyCode && candidate.currencyCode !== row.currencyCode)
      orderLinkError = 'ORDER_CURRENCY_MISMATCH';
    if (candidate.totalAmount && !row.amount.equals(candidate.totalAmount))
      orderLinkError = 'ORDER_AMOUNT_MISMATCH';
    if (
      candidate.paypalOrderId &&
      row.paypalOrderId &&
      candidate.paypalOrderId !== row.paypalOrderId
    )
      orderLinkError = 'ORDER_REFERENCE_CONFLICT';
    if (
      candidate.merchantOrderReference &&
      row.merchantOrderReference &&
      candidate.merchantOrderReference !== row.merchantOrderReference
    )
      orderLinkError = 'ORDER_REFERENCE_CONFLICT';
    if (
      manual &&
      candidate.merchantOrderReference &&
      manual.externalId !== candidate.merchantOrderReference
    )
      orderLinkError = 'ORDER_REFERENCE_CONFLICT';
  }
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
    orders,
    orderRecordComplete:
      !!order &&
      !!order.orderedAt &&
      !!order.currencyCode &&
      order.totalAmount !== null &&
      order.items.length > 0 &&
      order.items.every(
        (i) => !!i.description && i.quantity !== null && i.unitAmount !== null,
      ),
    orderRecordedBy: row.merchantOrder?.createdBy ?? null,
    orderLinkError,
  };
}
