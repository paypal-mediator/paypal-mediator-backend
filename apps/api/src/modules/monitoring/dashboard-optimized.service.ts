import { Inject, Injectable } from '@nestjs/common';
import type { MerchantRole } from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { DisputesService } from '../disputes/index.js';
import { TransactionsService } from '../transactions/index.js';

const PAGE_SIZE = 100;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

function sumMoney(values: Array<string | null>) {
  const scale = values.reduce((current, value) => {
    const fraction = value?.split('.')[1] ?? '';
    return Math.max(current, fraction.length);
  }, 0);
  const total = values.reduce((sum, value) => {
    if (value === null) return sum;
    const [whole, fraction = ''] = value.split('.');
    return sum + BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  }, 0n);
  if (scale === 0) return total.toString();
  const divisor = 10n ** BigInt(scale);
  return `${total / divisor}.${(total % divisor)
    .toString()
    .padStart(scale, '0')}`;
}

@Injectable()
export class DashboardOptimizedService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(DisputesService) private readonly disputes: DisputesService,
  ) {}

  async getDashboardData(merchantId: string, role: MerchantRole) {
    const generatedAt = new Date();
    const recentSince = new Date(generatedAt.getTime() - RECENT_WINDOW_MS);
    const metricsSince = new Date(generatedAt.getTime() - METRICS_WINDOW_MS);
    const [merchant, transactions, disputes, metricData] = await Promise.all([
      this.prisma.merchant.findUnique({
        where: { id: merchantId },
        include: { integration: true },
      }),
      this.allTransactions(merchantId),
      this.allDisputes(merchantId),
      this.getMetrics(merchantId, metricsSince),
    ]);

    if (!merchant) return this.getEmptyDashboard();

    const { activity, ...metrics } = metricData;

    const transactionCounts = { READY: 0, INCOMPLETE: 0, NEEDS_REVIEW: 0 };
    for (const transaction of transactions) {
      transactionCounts[transaction.readiness.status] += 1;
    }

    const disputeByStatus: Record<string, number> = {};
    const disputeByReason: Record<string, number> = {};
    let openDisputes = 0;
    for (const dispute of disputes) {
      disputeByStatus[dispute.internalState] =
        (disputeByStatus[dispute.internalState] ?? 0) + 1;
      disputeByReason[dispute.reasonCategory] =
        (disputeByReason[dispute.reasonCategory] ?? 0) + 1;
      if (
        !['CLOSED', 'RESOLVED_WON', 'RESOLVED_LOST'].includes(
          dispute.internalState,
        )
      )
        openDisputes += 1;
    }

    return {
      merchant: {
        id: merchant.id,
        displayName: merchant.displayName,
        role,
        policy: {
          allowInvestigations: merchant.allowInvestigations,
          allowSubmissions: merchant.allowSubmissions,
          requireMerchantApproval: merchant.requireMerchantApproval,
        },
        integration: {
          connectionStatus:
            merchant.integration?.connectionStatus ?? 'NOT_CONFIGURED',
          disputesReadStatus:
            merchant.integration?.disputesReadStatus ?? 'NOT_CONFIGURED',
          lastCheckedAt: merchant.integration?.lastCheckedAt ?? null,
        },
      },
      transactions: {
        total: transactions.length,
        ready: transactionCounts.READY,
        incomplete: transactionCounts.INCOMPLETE,
        needsReview: transactionCounts.NEEDS_REVIEW,
        recent: transactions
          .filter(
            (transaction) =>
              Date.parse(transaction.capturedAt) >= recentSince.getTime(),
          )
          .slice(0, 10)
          .map((transaction) => ({
            id: transaction.id,
            paypalCaptureId: transaction.paypalCaptureId,
            paypalOrderId: transaction.paypalOrderId,
            merchantOrderReference: transaction.merchantOrderReference,
            invoiceId: transaction.invoiceId,
            status: transaction.status,
            amount: transaction.amount,
            capturedAt: transaction.capturedAt,
            readiness: { status: transaction.readiness.status },
            order: transaction.order
              ? {
                  externalId: transaction.order.externalId,
                  items: transaction.order.items,
                }
              : null,
          })),
        totalAmount: sumMoney(
          transactions.map((transaction) => transaction.amount.value),
        ),
      },
      disputes: {
        total: disputes.length,
        open: openDisputes,
        byStatus: disputeByStatus,
        byReason: disputeByReason,
        recent: disputes
          .filter(
            (dispute) =>
              Date.parse(dispute.disputedAt) >= recentSince.getTime(),
          )
          .slice(0, 10)
          .map((dispute) => ({
            id: dispute.id,
            paypalDisputeId: dispute.paypalDisputeId,
            paypalStatus: dispute.paypalStatus,
            paypalStage: dispute.paypalStage,
            paypalReason: dispute.paypalReason,
            internalState: dispute.internalState,
            amount: dispute.amount,
            disputedAt: dispute.disputedAt,
            deadlineAt: dispute.deadlineAt,
            linkStatus: dispute.link.status,
          })),
        totalAmount: sumMoney(
          disputes.map((dispute) => dispute.amount?.value ?? null),
        ),
      },
      metrics,
      activity,
    };
  }

  private async allTransactions(merchantId: string) {
    const items: Awaited<ReturnType<TransactionsService['list']>>['items'] = [];
    let page = 1;
    let total: number;
    do {
      const result = await this.transactions.list(merchantId, {
        page,
        pageSize: PAGE_SIZE,
      });
      items.push(...result.items);
      total = result.total;
      page += 1;
    } while (items.length < total);
    return items;
  }

  private async allDisputes(merchantId: string) {
    const items: Awaited<ReturnType<DisputesService['list']>>['items'] = [];
    let page = 1;
    let total: number;
    do {
      const result = await this.disputes.list(merchantId, {
        page,
        pageSize: PAGE_SIZE,
      });
      items.push(...result.items);
      total = result.total;
      page += 1;
    } while (items.length < total);
    return items;
  }

  private async getMetrics(merchantId: string, since: Date) {
    const where = { merchantId, createdAt: { gte: since } };
    const [
      byType,
      byOutcome,
      byTypeDuration,
      avgDuration,
      totalEvents,
      failures,
      recent,
    ] = await Promise.all([
      this.prisma.auditEvent.groupBy({
        by: ['module'],
        where,
        _count: { _all: true },
      }),
      this.prisma.auditEvent.groupBy({
        by: ['outcome'],
        where,
        _count: { _all: true },
      }),
      this.prisma.auditEvent.groupBy({
        by: ['module'],
        where,
        _avg: { durationMs: true },
      }),
      this.prisma.auditEvent.aggregate({ where, _avg: { durationMs: true } }),
      this.prisma.auditEvent.count({ where }),
      this.prisma.auditEvent.count({ where: { ...where, outcome: 'FAILED' } }),
      this.prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    ]);

    const errorCounts = new Map<string, number>();
    const activity = recent.map((event) => {
      const record = event.record as {
        details?: { errorCode?: unknown };
      };
      const errorCode =
        typeof record?.details?.errorCode === 'string'
          ? record.details.errorCode
          : null;
      if (errorCode)
        errorCounts.set(errorCode, (errorCounts.get(errorCode) ?? 0) + 1);
      return {
        id: event.id,
        timestamp: event.createdAt.toISOString(),
        eventType: event.module,
        actor: event.actorKind,
        action: event.action,
        outcome: event.outcome,
        entityType: event.resourceType,
        entityId: event.resourceId ?? '',
        durationMs: event.durationMs,
        errorCode,
      };
    });
    const eventsByType = Object.fromEntries(
      byType.map((group) => [group.module, group._count._all]),
    );
    const eventsByOutcome = Object.fromEntries(
      byOutcome.map((group) => [group.outcome, group._count._all]),
    );
    const avgDurationByType = Object.fromEntries(
      byTypeDuration.map((group) => [group.module, group._avg.durationMs ?? 0]),
    );

    return {
      totalEvents,
      eventsByType,
      eventsByOutcome,
      avgDurationMs: avgDuration._avg.durationMs ?? 0,
      errorRate: totalEvents ? (failures * 100) / totalEvents : 0,
      topErrors: [...errorCounts]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      eventsByTypeDetail: eventsByType,
      eventsByOutcomeDetail: eventsByOutcome,
      avgDurationByType,
      activity: { items: activity, total: activity.length },
    };
  }

  private getEmptyDashboard() {
    return {
      merchant: null,
      transactions: {
        total: 0,
        ready: 0,
        incomplete: 0,
        needsReview: 0,
        recent: [],
        totalAmount: '0',
      },
      disputes: {
        total: 0,
        open: 0,
        byStatus: {},
        byReason: {},
        recent: [],
        totalAmount: '0',
      },
      metrics: {
        totalEvents: 0,
        eventsByType: {},
        eventsByOutcome: {},
        avgDurationMs: 0,
        errorRate: 0,
        topErrors: [],
        eventsByTypeDetail: {},
        eventsByOutcomeDetail: {},
        avgDurationByType: {},
      },
      activity: { items: [], total: 0 },
    };
  }
}
