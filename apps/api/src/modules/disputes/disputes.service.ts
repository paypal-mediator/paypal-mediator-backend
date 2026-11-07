import { Inject, Injectable } from '@nestjs/common';
import {
  DisputeDetailSchema,
  DisputeSummarySchema,
  type DisputeDetail,
  type DisputeInternalState,
  type DisputeQuery,
  type DisputeSummary,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import {
  Prisma,
  type Dispute,
  type DisputeEvent,
} from '../../generated/prisma/client.js';
import {
  IngestionQueueService,
  IngestionRejection,
} from '../event-ingestion/index.js';
import {
  parseDisputeEvent,
  type ParsedDisputeEvent,
} from './dispute-payload.js';

interface ResolvedLink {
  status: 'LINKED' | 'UNLINKED' | 'CONFLICT';
  transactionId: string | null;
  reason: string | null;
}

function summary(row: Dispute): DisputeSummary {
  return DisputeSummarySchema.parse({
    id: row.id,
    merchantId: row.merchantId,
    environment: 'sandbox',
    paypalDisputeId: row.paypalDisputeId,
    paypalStatus: row.paypalStatus,
    paypalStage: row.paypalStage,
    paypalReason: row.paypalReason,
    paypalOutcome: row.paypalOutcome,
    reasonCategory: row.reasonCategory,
    internalState: row.internalState,
    amount:
      row.currencyCode && row.amount
        ? { currencyCode: row.currencyCode, value: row.amount.toFixed() }
        : null,
    disputedAt: row.disputedAt.toISOString(),
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt.toISOString(),
    link: {
      status: row.linkStatus,
      transactionId: row.transactionId,
      reason: row.linkReason,
    },
    sourceEventId: row.sourceEventId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function eventResponse(row: DisputeEvent) {
  return {
    id: row.id,
    eventType: row.eventType,
    paypalEventId: row.paypalEventId,
    outcome: row.outcome,
    reason: row.reason,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  };
}

function internalStateFor(
  parsed: ParsedDisputeEvent,
  link: ResolvedLink,
): { internalState: DisputeInternalState; linkReason: string | null } {
  if (parsed.paypalStatus === 'RESOLVED') {
    if (parsed.resolution)
      return { internalState: parsed.resolution, linkReason: link.reason };
    // Never infer a winner without PayPal's official outcome code.
    return {
      internalState: 'NEEDS_REVIEW',
      linkReason: link.reason ?? 'RESOLVED_WITHOUT_OUTCOME',
    };
  }
  if (parsed.eventType === 'CUSTOMER.DISPUTE.RESOLVED')
    return {
      internalState: 'NEEDS_REVIEW',
      linkReason: link.reason ?? 'RESOLVED_EVENT_WITHOUT_RESOLVED_STATUS',
    };
  if (link.status === 'CONFLICT')
    return { internalState: 'NEEDS_REVIEW', linkReason: link.reason };
  if (link.status === 'LINKED' && link.transactionId)
    return { internalState: 'LINKED', linkReason: null };
  return {
    internalState: 'NEEDS_REVIEW',
    linkReason: link.reason ?? 'TRANSACTION_NOT_FOUND',
  };
}

@Injectable()
export class DisputesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IngestionQueueService)
    private readonly queue: IngestionQueueService,
  ) {}

  async processNextDispute(
    merchantId: string,
  ): Promise<'EMPTY' | 'COMPLETED' | 'FAILED'> {
    return this.queue.processNext(
      'DISPUTE_CHANGED',
      merchantId,
      async (delivery, tx) => {
        if (delivery.environment !== 'sandbox')
          throw new IngestionRejection('INVALID_DISPUTE');
        const parsed = parseDisputeEvent(delivery.payload);
        // Serialize distinct webhook IDs that refer to the same PayPal dispute.
        const key = `${delivery.merchantId}:sandbox:${parsed.paypalDisputeId}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
        const existing = await tx.dispute.findUnique({
          where: {
            merchantId_environment_paypalDisputeId: {
              merchantId: delivery.merchantId,
              environment: 'sandbox',
              paypalDisputeId: parsed.paypalDisputeId,
            },
          },
        });

        if (existing && parsed.occurredAt < existing.lastEventAt) {
          await tx.disputeEvent.create({
            data: {
              disputeId: existing.id,
              eventId: delivery.eventId,
              eventType: parsed.eventType,
              paypalEventId: parsed.paypalEventId,
              outcome: 'IGNORED_STALE',
              reason: 'EVENT_OLDER_THAN_LAST_APPLIED',
              occurredAt: parsed.occurredAt,
            },
          });
          return;
        }

        const link = await this.resolveLink(
          tx,
          delivery.merchantId,
          existing,
          parsed,
        );
        const state = internalStateFor(parsed, link);
        const values = {
          paypalStatus: parsed.paypalStatus,
          paypalStage: parsed.paypalStage,
          paypalReason: parsed.paypalReason,
          paypalOutcome: parsed.paypalOutcome,
          reasonCategory: parsed.reasonCategory,
          internalState: state.internalState,
          currencyCode: parsed.amount?.currencyCode ?? null,
          amount: parsed.amount
            ? new Prisma.Decimal(parsed.amount.value)
            : null,
          disputedAt: parsed.disputedAt,
          deadlineAt: parsed.deadlineAt,
          lastEventAt: parsed.occurredAt,
          transactionId: link.transactionId,
          linkStatus: link.status,
          linkReason: state.linkReason,
        };

        if (existing) {
          const unchanged =
            existing.paypalStatus === values.paypalStatus &&
            existing.paypalStage === values.paypalStage &&
            existing.paypalReason === values.paypalReason &&
            existing.paypalOutcome === values.paypalOutcome &&
            existing.reasonCategory === values.reasonCategory &&
            existing.internalState === values.internalState &&
            existing.currencyCode === values.currencyCode &&
            (existing.amount?.toFixed() ?? null) ===
              (values.amount?.toFixed() ?? null) &&
            existing.disputedAt.getTime() === values.disputedAt.getTime() &&
            (existing.deadlineAt?.getTime() ?? null) ===
              (values.deadlineAt?.getTime() ?? null) &&
            existing.transactionId === values.transactionId &&
            existing.linkStatus === values.linkStatus &&
            existing.linkReason === values.linkReason;

          if (unchanged) {
            await tx.dispute.update({
              where: { id: existing.id },
              data: { lastEventAt: parsed.occurredAt },
            });
            await tx.disputeEvent.create({
              data: {
                disputeId: existing.id,
                eventId: delivery.eventId,
                eventType: parsed.eventType,
                paypalEventId: parsed.paypalEventId,
                outcome: 'IGNORED_DUPLICATE',
                reason: 'NO_STATE_CHANGE',
                occurredAt: parsed.occurredAt,
              },
            });
            return;
          }

          await tx.dispute.update({
            where: { id: existing.id },
            data: values,
          });
          await tx.disputeEvent.create({
            data: {
              disputeId: existing.id,
              eventId: delivery.eventId,
              eventType: parsed.eventType,
              paypalEventId: parsed.paypalEventId,
              outcome: 'APPLIED',
              reason: null,
              occurredAt: parsed.occurredAt,
            },
          });
          return;
        }

        const created = await tx.dispute.create({
          data: {
            ...values,
            merchantId: delivery.merchantId,
            environment: 'sandbox',
            paypalDisputeId: parsed.paypalDisputeId,
            sourceEventId: delivery.eventId,
          },
        });
        await tx.disputeEvent.create({
          data: {
            disputeId: created.id,
            eventId: delivery.eventId,
            eventType: parsed.eventType,
            paypalEventId: parsed.paypalEventId,
            outcome: 'APPLIED',
            reason: null,
            occurredAt: parsed.occurredAt,
          },
        });
      },
    );
  }

  private async resolveLink(
    tx: Prisma.TransactionClient,
    merchantId: string,
    existing: Dispute | null,
    parsed: ParsedDisputeEvent,
  ): Promise<ResolvedLink> {
    const current = existing?.transactionId
      ? await tx.transaction.findFirst({
          where: { id: existing.transactionId, merchantId },
          select: { id: true, paypalCaptureId: true },
        })
      : null;
    if (existing?.transactionId && !current)
      return {
        status: 'CONFLICT',
        transactionId: existing.transactionId,
        reason: 'LINKED_TRANSACTION_MISSING',
      };

    const references = parsed.sellerTransactionIds;
    if (references.length === 0)
      return current
        ? { status: 'LINKED', transactionId: current.id, reason: null }
        : {
            status: 'UNLINKED',
            transactionId: null,
            reason: 'NO_TRANSACTION_REFERENCE',
          };

    const matches = await tx.transaction.findMany({
      where: {
        merchantId,
        environment: 'sandbox',
        paypalCaptureId: { in: references },
      },
      select: { id: true, paypalCaptureId: true },
    });
    const known = new Set(matches.map((match) => match.paypalCaptureId));
    const unknown = references.filter((reference) => !known.has(reference));

    if (matches.length > 1)
      return {
        status: 'CONFLICT',
        transactionId: current?.id ?? null,
        reason: 'AMBIGUOUS_TRANSACTION',
      };
    if (matches.length === 0)
      return current
        ? {
            status: 'CONFLICT',
            transactionId: current.id,
            reason: 'TRANSACTION_REFERENCE_CHANGED',
          }
        : {
            status: 'UNLINKED',
            transactionId: null,
            reason: 'TRANSACTION_NOT_FOUND',
          };

    const match = matches[0]!;
    if (unknown.length > 0)
      return {
        status: 'CONFLICT',
        transactionId: match.id,
        reason: 'UNKNOWN_TRANSACTION_REFERENCE',
      };
    if (current && current.id !== match.id)
      return {
        status: 'CONFLICT',
        transactionId: current.id,
        reason: 'TRANSACTION_REFERENCE_CHANGED',
      };
    return { status: 'LINKED', transactionId: match.id, reason: null };
  }

  async list(merchantId: string, query: DisputeQuery) {
    const where = {
      merchantId,
      ...(query.internalState ? { internalState: query.internalState } : {}),
      ...(query.paypalStatus ? { paypalStatus: query.paypalStatus } : {}),
    };
    return this.prisma.$transaction(
      async (tx) => {
        const items = await tx.dispute.findMany({
          where,
          orderBy: [{ disputedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        const total = await tx.dispute.count({ where });
        return {
          items: items.map(summary),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async detail(merchantId: string, id: string): Promise<DisputeDetail> {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.dispute.findFirst({
          where: { id, merchantId },
          include: {
            events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
          },
        });
        if (!row)
          throw new ApiException('DISPUTE_NOT_FOUND', 'Dispute not found', 404);
        return DisputeDetailSchema.parse({
          ...summary(row),
          events: row.events.map(eventResponse),
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
