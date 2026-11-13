import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  IngestionQueueService,
  IngestionRejection,
} from '../event-ingestion/index.js';
import { EvidenceService } from '../evidence/index.js';
import { AuditService } from '../monitoring/audit.service.js';
import { lockMerchantOrders } from './order-linking.js';
import { evidenceContext } from './order-mapping.js';
import { parsePaymentAdjustment } from './payment-adjustment.js';
import { PaymentMoney } from './payment-money.js';

@Injectable()
export class PaymentAdjustmentsService {
  constructor(
    @Inject(IngestionQueueService)
    private readonly queue: IngestionQueueService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  processNext(merchantId: string) {
    return this.queue.processNext(
      'PAYMENT_ADJUSTED',
      merchantId,
      async (delivery, tx) => {
        if (delivery.environment !== 'sandbox')
          throw new IngestionRejection('INVALID_PAYMENT_ADJUSTMENT');
        const movement = parsePaymentAdjustment(delivery.payload);
        const amount = new PaymentMoney(movement.amount);
        const cumulative =
          movement.cumulativeReturnedAmount === null
            ? null
            : new PaymentMoney(movement.cumulativeReturnedAmount);
        if (cumulative?.lt(amount))
          throw new IngestionRejection('PAYMENT_ADJUSTMENT_CONFLICT');
        const key = `${merchantId}:sandbox:${movement.paypalCaptureId}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
        await lockMerchantOrders(tx, merchantId);
        const existing = await tx.paymentAdjustment.findUnique({
          where: {
            merchantId_environment_paypalAdjustmentId: {
              merchantId,
              environment: 'sandbox',
              paypalAdjustmentId: movement.paypalAdjustmentId,
            },
          },
        });
        if (existing) {
          if (
            existing.paypalCaptureId !== movement.paypalCaptureId ||
            existing.currencyCode !== movement.currencyCode ||
            !existing.amount.equals(amount) ||
            existing.occurredAt.getTime() !== movement.occurredAt.getTime()
          )
            throw new IngestionRejection('PAYMENT_ADJUSTMENT_CONFLICT');
          // The same refund resource may be notified as refunded and reversed. Count it once.
          if (
            (movement.kind === 'REVERSAL' && existing.kind !== 'REVERSAL') ||
            (cumulative &&
              (!existing.cumulativeReturnedAmount ||
                cumulative.gt(existing.cumulativeReturnedAmount)))
          )
            await tx.paymentAdjustment.update({
              where: { id: existing.id },
              data: {
                kind: movement.kind === 'REVERSAL' ? 'REVERSAL' : existing.kind,
                cumulativeReturnedAmount: cumulative
                  ? PaymentMoney.max(
                      cumulative,
                      existing.cumulativeReturnedAmount ?? 0,
                    )
                  : existing.cumulativeReturnedAmount,
              },
            });
        } else {
          await tx.paymentAdjustment.create({
            data: {
              ...movement,
              merchantId,
              environment: 'sandbox',
              sourceEventId: delivery.eventId,
            },
          });
        }
        const row = await this.reconcile(
          tx,
          merchantId,
          movement.paypalCaptureId,
        );
        await this.audit.append(
          {
            merchantId,
            actorUserId: null,
            actorKind: 'SYSTEM',
            resourceType: 'TRANSACTION',
            resourceId: row?.id ?? null,
            transactionId: row?.id ?? null,
            record: { action: 'TRANSACTION_ADJUSTED', details: {} },
          },
          tx,
        );
        return row ? { transactionId: row.id } : undefined;
      },
    );
  }

  // Caller holds capture lock then merchant-order lock, shared with capture processing.
  async reconcile(
    tx: Prisma.TransactionClient,
    merchantId: string,
    paypalCaptureId: string,
  ) {
    const row = await tx.transaction.findUnique({
      where: {
        merchantId_environment_paypalCaptureId: {
          merchantId,
          environment: 'sandbox',
          paypalCaptureId,
        },
      },
      include: { merchantOrder: true, orderSources: true },
    });
    if (!row) return null; // Retained movement will be reconciled when the capture arrives.
    const movements = await tx.paymentAdjustment.findMany({
      where: { merchantId, environment: 'sandbox', paypalCaptureId },
    });
    if (!movements.length) return row;
    let known = new PaymentMoney(0),
      reported = new PaymentMoney(0);
    let requiresReview = false,
      hasReversal = false;
    for (const movement of movements) {
      if (movement.currencyCode !== row.currencyCode) {
        requiresReview = true;
        continue;
      }
      known = known.plus(movement.amount);
      if (movement.cumulativeReturnedAmount?.gt(reported))
        reported = movement.cumulativeReturnedAmount;
      if (movement.kind === 'REVERSAL') hasReversal = true;
    }
    const returnedAmount = PaymentMoney.max(known, reported);
    requiresReview ||= returnedAmount.gt(row.amount);
    const full = returnedAmount.gte(row.amount);
    const status = requiresReview
      ? 'NEEDS_REVIEW'
      : returnedAmount.isZero()
        ? 'COMPLETED'
        : hasReversal
          ? full
            ? 'REVERSED'
            : 'PARTIALLY_REVERSED'
          : full
            ? 'REFUNDED'
            : 'PARTIALLY_REFUNDED';
    const updated = await tx.transaction.update({
      where: { id: row.id },
      data: {
        status,
        returnedAmount,
        adjustmentReviewRequired: requiresReview,
      },
      include: { merchantOrder: true, orderSources: true },
    });
    if (movements.length)
      await this.evidence.syncBase(tx, evidenceContext(updated));
    return updated;
  }
}
