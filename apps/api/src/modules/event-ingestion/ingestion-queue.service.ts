import { Inject, Injectable } from '@nestjs/common';
import type { IngestionJobKind } from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async processNext(
    kind: IngestionJobKind,
    merchantId: string,
    consume: (
      delivery: IngestionDelivery,
      tx: Prisma.TransactionClient,
    ) => Promise<void>,
  ): Promise<'EMPTY' | 'COMPLETED' | 'FAILED'> {
    return this.prisma.$transaction(async (tx) => {
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
      try {
        await consume(
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
        return 'FAILED';
      }
      await tx.$executeRaw`RELEASE SAVEPOINT ingestion_consumer`;
      await tx.ingestionJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', finishedAt: new Date(), errorCode: null },
      });
      return 'COMPLETED';
    });
  }
}
