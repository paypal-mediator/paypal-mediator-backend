import { Inject, Injectable } from '@nestjs/common';
import {
  TransactionResponseSchema,
  type TransactionQuery,
  type TransactionResponse,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import { Prisma, type Transaction } from '../../generated/prisma/client.js';
import {
  IngestionQueueService,
  IngestionRejection,
} from '../event-ingestion/index.js';
import { parseCapture } from './capture.js';

function response(row: Transaction): TransactionResponse {
  return TransactionResponseSchema.parse({
    ...row,
    amount: { currencyCode: row.currencyCode, value: row.amount.toFixed() },
    capturedAt: row.capturedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    readiness: {
      status: 'INCOMPLETE',
      checks: [
        { code: 'PAYMENT_RECORD', status: 'PRESENT' },
        {
          code: 'ORDER_REFERENCE',
          status:
            row.paypalOrderId || row.merchantOrderReference
              ? 'PRESENT'
              : 'MISSING',
        },
        { code: 'ORDER_RECORD', status: 'MISSING' },
        { code: 'TRACKING', status: 'MISSING' },
        { code: 'PROOF_OF_DELIVERY', status: 'MISSING' },
      ],
    },
  });
}

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IngestionQueueService)
    private readonly queue: IngestionQueueService,
  ) {}

  async processNextCapture(merchantId: string) {
    return this.queue.processNext(
      'TRANSACTION_CAPTURED',
      merchantId,
      async (delivery, tx) => {
        if (delivery.environment !== 'sandbox')
          throw new IngestionRejection('INVALID_CAPTURE');
        const capture = parseCapture(delivery.payload);
        // Also serialize distinct webhook IDs referring to the same capture.
        const key = `${delivery.merchantId}:sandbox:${capture.paypalCaptureId}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
        const existing = await tx.transaction.findUnique({
          where: {
            merchantId_environment_paypalCaptureId: {
              merchantId: delivery.merchantId,
              environment: 'sandbox',
              paypalCaptureId: capture.paypalCaptureId,
            },
          },
        });
        if (existing) {
          if (
            !existing.amount.equals(new Prisma.Decimal(capture.amount)) ||
            existing.currencyCode !== capture.currencyCode ||
            existing.capturedAt.getTime() !== capture.capturedAt.getTime() ||
            existing.paypalOrderId !== capture.paypalOrderId ||
            existing.merchantOrderReference !==
              capture.merchantOrderReference ||
            existing.invoiceId !== capture.invoiceId
          )
            throw new IngestionRejection('CAPTURE_CONFLICT');
          return;
        }
        await tx.transaction.create({
          data: {
            ...capture,
            merchantId: delivery.merchantId,
            environment: 'sandbox',
            sourceEventId: delivery.eventId,
          },
        });
      },
    );
  }

  async list(merchantId: string, query: TransactionQuery) {
    const where = {
      merchantId,
      ...(query.paypalCaptureId
        ? { paypalCaptureId: query.paypalCaptureId }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.transaction.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.transaction.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      items: items.map(response),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(merchantId: string, id: string) {
    const row = await this.prisma.transaction.findFirst({
      where: { id, merchantId },
    });
    if (!row)
      throw new ApiException(
        'TRANSACTION_NOT_FOUND',
        'Transaction not found',
        404,
      );
    return response(row);
  }
}
