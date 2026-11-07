import { Inject, Injectable } from '@nestjs/common';
import type { IngestionJobKind } from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../monitoring/audit.service.js';

export interface IngestionDelivery {
  eventId: string;
  merchantId: string;
  environment: string;
  payload: Prisma.JsonValue;
}

// Public M02 transaction boundary: consumers write only their own tables.
// Expected invalid data is terminal; unexpected exceptions roll back the job.
export class IngestionRejection extends Error {
  constructor(
    readonly code:
      | 'INVALID_CAPTURE'
      | 'CAPTURE_CONFLICT'
      | 'INVALID_DISPUTE'
      | 'DISPUTE_CONFLICT',
  ) {
    super(code);
  }
}

@Injectable()
export class IngestionQueueService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async operationalMetrics(merchantId: string) {
    const groups = await this.prisma.ingestionJob.groupBy({
      by: ['status'],
      where: { event: { merchantId } },
      _count: { _all: true },
    });
    return groups.map((g) => ({ status: g.status, count: g._count._all }));
  }

  async processNext(
    kind: IngestionJobKind,
    merchantId: string,
    consume: (
      delivery: IngestionDelivery,
      tx: Prisma.TransactionClient,
    ) => Promise<void | { transactionId: string }>,
  ): Promise<'EMPTY' | 'COMPLETED' | 'FAILED'> {
    return this.prisma.$transaction(async (tx) => {
      const startedAt = Date.now();
      const jobs = await tx.$queryRaw<Array<{ id: string; event_id: string }>>`
        SELECT j.id, j.event_id FROM ingestion_jobs j
        JOIN webhook_events e ON e.id = j.event_id
        WHERE j.kind = ${kind} AND j.status = 'QUEUED' AND e.merchant_id = ${merchantId}::uuid
        ORDER BY j.created_at, j.id
        FOR UPDATE OF j SKIP LOCKED LIMIT 1
      `;
      const job = jobs[0];
      if (!job) return 'EMPTY';
      const event = await tx.webhookEvent.findUniqueOrThrow({
        where: { id: job.event_id },
      });
      await tx.$executeRaw`SAVEPOINT ingestion_consumer`;
      let consumed: void | { transactionId: string };
      try {
        consumed = await consume(
          {
            eventId: event.id,
            merchantId: event.merchantId,
            environment: event.environment,
            payload: event.payload,
          },
          tx,
        );
      } catch (error) {
        if (!(error instanceof IngestionRejection)) throw error;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT ingestion_consumer`;
        await tx.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            errorCode: error.code,
            finishedAt: new Date(),
          },
        });
        await this.audit.append(
          {
            merchantId,
            actorUserId: null,
            actorKind: 'SYSTEM',
            resourceType: 'INGESTION_JOB',
            resourceId: job.id,
            outcome: 'FAILED',
            durationMs: Date.now() - startedAt,
            record: {
              action: 'INGESTION_FINISHED',
              details: { state: 'FAILED', errorCode: error.code },
            },
          },
          tx,
        );
        return 'FAILED';
      }
      await tx.$executeRaw`RELEASE SAVEPOINT ingestion_consumer`;
      await tx.ingestionJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', finishedAt: new Date(), errorCode: null },
      });
      await this.audit.append(
        {
          merchantId,
          actorUserId: null,
          actorKind: 'SYSTEM',
          resourceType: 'INGESTION_JOB',
          resourceId: job.id,
          durationMs: Date.now() - startedAt,
          transactionId: consumed?.transactionId ?? null,
          record: {
            action: 'INGESTION_FINISHED',
            details: { state: 'COMPLETED' },
          },
        },
        tx,
      );
      return 'COMPLETED';
    });
  }
}
