import { Inject, Injectable } from '@nestjs/common';
import {
  IngestionHealthSchema,
  IngestionJobsResponseSchema,
  type IngestionJobsQuery,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import type { MerchantActor } from '../merchants/index.js';
import { AuditService } from '../monitoring/audit.service.js';

@Injectable()
export class IngestionOperationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async health(merchantId: string) {
    const groupsQuery = this.prisma.ingestionJob.groupBy({
      by: ['status'],
      where: { event: { merchantId } },
      _count: { _all: true },
    });
    const [last, oldest, groups] = await this.prisma.$transaction([
      this.prisma.webhookEvent.findFirst({
        where: { merchantId },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true },
      }),
      this.prisma.ingestionJob.findFirst({
        where: { event: { merchantId }, status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      groupsQuery,
    ]);
    const counts = { QUEUED: 0, FAILED: 0, COMPLETED: 0 };
    for (const group of groups)
      if (group.status in counts)
        counts[group.status as keyof typeof counts] = group._count._all;
    return IngestionHealthSchema.parse({
      lastReceivedAt: last?.receivedAt.toISOString() ?? null,
      oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
      counts,
    });
  }

  async list(merchantId: string, query: IngestionJobsQuery) {
    const rows = await this.prisma.ingestionJob.findMany({
      where: {
        event: { merchantId },
        ...(query.status ? { status: query.status } : {}),
        ...(query.before && query.beforeId
          ? {
              OR: [
                { createdAt: { lt: new Date(query.before) } },
                {
                  createdAt: new Date(query.before),
                  id: { lt: query.beforeId },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        eventId: true,
        kind: true,
        status: true,
        errorCode: true,
        createdAt: true,
        finishedAt: true,
        event: {
          select: { paypalEventId: true, eventType: true, receivedAt: true },
        },
      },
    });
    const items = rows.slice(0, query.limit).map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      event: { ...r.event, receivedAt: r.event.receivedAt.toISOString() },
    }));
    const last = items.at(-1);
    return IngestionJobsResponseSchema.parse({
      items,
      nextCursor:
        rows.length > query.limit && last
          ? { before: last.createdAt, beforeId: last.id }
          : null,
    });
  }

  async retry(actor: MerchantActor, id: string) {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'Administrator access is required',
        403,
      );
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.ingestionJob.findFirst({
        where: { id, event: { merchantId: actor.merchantId } },
      });
      if (!job)
        throw new ApiException('INGESTION_JOB_NOT_FOUND', 'Job not found', 404);
      const updated = await tx.ingestionJob.updateMany({
        where: {
          id,
          status: 'FAILED',
          event: { merchantId: actor.merchantId },
        },
        data: { status: 'QUEUED', errorCode: null, finishedAt: null },
      });
      if (!updated.count)
        throw new ApiException(
          'INGESTION_JOB_NOT_FAILED',
          'Only failed jobs can be retried',
          409,
        );
      await this.audit.append(
        {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          actorKind: 'USER',
          resourceType: 'INGESTION_JOB',
          resourceId: id,
          record: {
            action: 'INGESTION_RETRIED',
            details: {
              state: 'QUEUED',
              ...(job.errorCode ? { errorCode: job.errorCode } : {}),
            },
          },
        },
        tx,
      );
      return { id, status: 'QUEUED' as const };
    });
  }
}
