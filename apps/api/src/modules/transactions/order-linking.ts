import type { Prisma, Transaction } from '../../generated/prisma/client.js';

export async function lockMerchantOrders(
  tx: Prisma.TransactionClient,
  merchantId: string,
) {
  const key = `m03:orders:${merchantId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

// A reference alone does not create an order. MVP matches one complete capture to one order.
export async function reconcileOrder(
  tx: Prisma.TransactionClient,
  row: Transaction,
) {
  const references: Prisma.MerchantOrderWhereInput[] = [];
  if (row.paypalOrderId) references.push({ paypalOrderId: row.paypalOrderId });
  if (row.merchantOrderReference)
    references.push({ externalId: row.merchantOrderReference });
  const candidates = references.length
    ? await tx.merchantOrder.findMany({
        where: {
          merchantId: row.merchantId,
          environment: row.environment,
          OR: references,
        },
        include: { transaction: { select: { id: true } } },
      })
    : [];
  let error: string | null = null;
  const candidate = candidates[0];
  if (candidates.length > 1) error = 'ORDER_REFERENCE_CONFLICT';
  else if (candidate) {
    if (
      (row.merchantOrderReference &&
        row.merchantOrderReference !== candidate.externalId) ||
      (row.paypalOrderId &&
        candidate.paypalOrderId &&
        row.paypalOrderId !== candidate.paypalOrderId)
    )
      error = 'ORDER_REFERENCE_CONFLICT';
    else if (row.currencyCode !== candidate.currencyCode)
      error = 'ORDER_CURRENCY_MISMATCH';
    else if (!row.amount.equals(candidate.totalAmount))
      error = 'ORDER_AMOUNT_MISMATCH';
    else if (row.capturedAt < candidate.orderedAt)
      error = 'ORDER_AFTER_PAYMENT';
    else if (candidate.transaction && candidate.transaction.id !== row.id)
      error = 'ORDER_ALREADY_LINKED';
  }
  return tx.transaction.update({
    where: { id: row.id },
    data: {
      merchantOrderId: candidate && !error ? candidate.id : null,
      orderLinkError: error,
    },
    include: { merchantOrder: true, orderSources: true },
  });
}
