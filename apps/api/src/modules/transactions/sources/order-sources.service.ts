import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OrderSourceResultSchema } from '@resolve-ai/contracts';
import { PrismaService } from '../../../common/database/prisma.service.js';
import { contentHash } from '../../../common/data/content-hash.js';
import { ApiException } from '../../../common/http/api.exception.js';
import { Prisma, type Transaction } from '../../../generated/prisma/client.js';
import { EvidenceService } from '../../evidence/index.js';
import { AuditService } from '../../monitoring/audit.service.js';
import { evidenceContext } from '../order-mapping.js';
import { lockMerchantOrders } from '../order-linking.js';
import {
  ORDER_INFORMATION_SOURCES,
  OrderSourceError,
  type OrderInformationSource,
} from './order-information-source.js';

@Injectable()
export class OrderSourcesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
    @Inject(ORDER_INFORMATION_SOURCES)
    private readonly sources: OrderInformationSource[],
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    if (new Set(sources.map((s) => s.providerId)).size !== sources.length)
      throw new Error('DUPLICATE_ORDER_PROVIDER');
  }
  async schedule(tx: Prisma.TransactionClient, row: Transaction) {
    for (const source of this.sources.filter((s) => s.supports(row)))
      await tx.orderSourceJob.upsert({
        where: {
          transactionId_providerId: {
            transactionId: row.id,
            providerId: source.providerId,
          },
        },
        create: {
          merchantId: row.merchantId,
          transactionId: row.id,
          providerId: source.providerId,
          sourceKind: source.sourceKind,
          sourceSystem: source.sourceSystem,
        },
        update: {},
      });
  }
  async operationalMetrics(merchantId: string) {
    const groups = await this.prisma.orderSourceJob.groupBy({
      by: ['status'],
      where: { merchantId },
      _count: { _all: true },
    });
    return groups.map((g) => ({ status: g.status, count: g._count._all }));
  }
  async refresh(merchantId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockMerchantOrders(tx, merchantId);
      const row = await tx.transaction.findFirst({ where: { id, merchantId } });
      if (!row)
        throw new ApiException(
          'TRANSACTION_NOT_FOUND',
          'Transaction not found',
          404,
        );
      await this.schedule(tx, row);
      const active = await tx.orderSourceJob.count({
        where: {
          transactionId: id,
          status: 'FETCHING',
          leaseExpiresAt: { gt: new Date() },
        },
      });
      if (active)
        throw new ApiException(
          'ORDER_SOURCE_BUSY',
          'Order source fetch is in progress',
          409,
        );
      await tx.orderSourceJob.updateMany({
        where: { transactionId: id },
        data: {
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: null,
          httpStatus: null,
        },
      });
    });
    for (let i = 0; i < this.sources.length; i++)
      if ((await this.processNext(merchantId, id)) === 'EMPTY') break;
  }
  async processNext(merchantId: string, transactionId?: string) {
    const startedAt = Date.now();
    const job = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Merchant lock establishes the same ordering as capture/evidence refresh.
      await lockMerchantOrders(tx, merchantId);
      const candidate = await tx.orderSourceJob.findFirst({
        where: {
          merchantId,
          ...(transactionId ? { transactionId } : {}),
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', nextAttemptAt: { lte: now } },
            { status: 'FETCHING', leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;
      const leased = await tx.orderSourceJob.update({
        where: { id: candidate.id },
        data: {
          status: 'FETCHING',
          attempts: { increment: 1 },
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 120000),
          nextAttemptAt: null,
          lastCheckedAt: now,
        },
        include: { transaction: true },
      });
      await this.audit.append(
        {
          merchantId,
          actorUserId: null,
          actorKind: 'SYSTEM',
          transactionId: leased.transactionId,
          resourceType: 'ORDER_SOURCE',
          resourceId: leased.id,
          outcome: 'STARTED',
          record: { action: 'ORDER_SOURCE_STARTED', details: {} },
        },
        tx,
      );
      return leased;
    });
    if (!job) return 'EMPTY';
    const source = this.sources.find((s) => s.providerId === job.providerId);
    try {
      if (!source) throw new OrderSourceError('NOT_CONFIGURED');
      const fetched = await source.fetch(job.transaction);
      const result = OrderSourceResultSchema.parse(fetched.result);
      if (
        result.order &&
        (result.order.providerId !== source.providerId ||
          result.order.sourceKind !== source.sourceKind ||
          result.order.sourceSystem !== source.sourceSystem)
      )
        throw new OrderSourceError('INVALID_SOURCE_PROVENANCE');
      await this.prisma.$transaction(
        async (tx) => {
          await lockMerchantOrders(tx, merchantId);
          const current = await tx.orderSourceJob.findUnique({
            where: { id: job.id },
          });
          if (current?.leaseToken !== job.leaseToken) return;
          const row = await tx.transaction.findUniqueOrThrow({
            where: { id: job.transactionId },
            include: { merchantOrder: true, orderSources: true },
          });
          const receipt = await this.evidence.recordOrderSource(
            tx,
            evidenceContext(row),
            {
              sourceKind: source.sourceKind,
              sourceSystem: source.sourceSystem,
              externalReference: row.paypalOrderId ?? row.id,
              content: {
                providerId: source.providerId,
                original: fetched.original,
                normalized: result,
              },
            },
          );
          const saved = await tx.orderSourceJob.update({
            where: { id: job.id },
            data: {
              status:
                result.association === 'CONFLICT' || result.issues.length
                  ? 'CONFLICT'
                  : result.association === 'MATCHED' &&
                      !result.missingFields.length
                    ? 'COMPLETE'
                    : 'PARTIAL',
              normalized: result as Prisma.InputJsonValue,
              contentHash: contentHash(result),
              evidenceId: receipt.evidenceId,
              lastSucceededAt: new Date(),
              errorCode: null,
              httpStatus: 200,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          await this.audit.append(
            {
              merchantId,
              actorUserId: null,
              actorKind: 'SYSTEM',
              transactionId: job.transactionId,
              resourceType: 'ORDER_SOURCE',
              resourceId: job.id,
              durationMs: Date.now() - startedAt,
              outcome: saved.status === 'CONFLICT' ? 'BLOCKED' : 'SUCCEEDED',
              record: {
                action: 'ORDER_SOURCE_FINISHED',
                details: {
                  state: saved.status as 'COMPLETE' | 'PARTIAL' | 'CONFLICT',
                  httpStatus: 200,
                },
              },
            },
            tx,
          );
          const updated = await tx.transaction.findUniqueOrThrow({
            where: { id: row.id },
            include: { merchantOrder: true, orderSources: true },
          });
          await this.evidence.syncBase(tx, evidenceContext(updated));
        },
        { timeout: 15000 },
      );
      return 'PROCESSED';
    } catch (error) {
      const safe =
        error instanceof OrderSourceError
          ? error
          : new OrderSourceError('ORDER_SOURCE_PROCESSING_FAILED', true);
      await this.prisma.$transaction(async (tx) => {
        const saved = await tx.orderSourceJob.updateMany({
          where: { id: job.id, leaseToken: job.leaseToken },
          data: {
            status:
              safe.code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'FAILED',
            errorCode: safe.code,
            httpStatus: safe.httpStatus,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt:
              safe.retryable && job.attempts < 5
                ? new Date(
                    Date.now() + Math.min(300000, 1000 * 2 ** job.attempts),
                  )
                : null,
          },
        });
        if (saved.count)
          await this.audit.append(
            {
              merchantId,
              actorUserId: null,
              actorKind: 'SYSTEM',
              transactionId: job.transactionId,
              resourceType: 'ORDER_SOURCE',
              resourceId: job.id,
              outcome: 'FAILED',
              durationMs: Date.now() - startedAt,
              record: {
                action: 'ORDER_SOURCE_FINISHED',
                details: {
                  state:
                    safe.code === 'NOT_CONFIGURED'
                      ? 'NOT_CONFIGURED'
                      : 'FAILED',
                  errorCode: safe.code,
                  ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}),
                },
              },
            },
            tx,
          );
      });
      return 'FAILED';
    }
  }
}
