import { Inject, Injectable } from '@nestjs/common';
import { MonitoringMetricsResponseSchema } from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { IngestionQueueService } from '../event-ingestion/index.js';
import { TransactionsService } from '../transactions/index.js';
import { InvestigatorService } from '../investigator/index.js';
import { VerifierService } from '../verifier/index.js';

@Injectable()
export class MonitoringService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IngestionQueueService)
    private readonly ingestion: IngestionQueueService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(InvestigatorService)
    private readonly investigator: InvestigatorService,
    @Inject(VerifierService) private readonly verifier: VerifierService,
  ) {}

  async metrics(merchantId: string, hours: number) {
    const generatedAt = new Date();
    const since = new Date(generatedAt.getTime() - hours * 3600000);
    const [
      groups,
      ingestion,
      orderSources,
      investigations,
      verifications,
      verdicts,
    ] = await Promise.all([
      this.prisma.auditEvent.groupBy({
        by: ['module', 'action', 'outcome'],
        where: { merchantId, createdAt: { gte: since, lte: generatedAt } },
        _count: { _all: true, durationMs: true },
        _avg: { durationMs: true },
        _sum: { inputTokens: true, outputTokens: true },
        orderBy: [{ module: 'asc' }, { action: 'asc' }, { outcome: 'asc' }],
      }),
      this.ingestion.operationalMetrics(merchantId),
      this.transactions.orderSourceMetrics(merchantId),
      this.investigator.operationalMetrics(merchantId),
      this.verifier.operationalMetrics(merchantId),
      Promise.all(
        (['APPROVED', 'INCOMPLETE', 'REJECTED'] as const).map(
          async (verdict) => ({
            verdict,
            count: await this.prisma.auditEvent.count({
              where: {
                merchantId,
                action: 'VERIFICATION_FINISHED',
                outcome: 'SUCCEEDED',
                createdAt: { gte: since, lte: generatedAt },
                record: { path: ['details', 'verdict'], equals: verdict },
              },
            }),
          }),
        ),
      ),
    ]);
    return MonitoringMetricsResponseSchema.parse({
      generatedAt: generatedAt.toISOString(),
      since: since.toISOString(),
      scope: 'AUDITED_EVENTS_SINCE_M09',
      verdicts,
      groups: groups.map((g) => ({
        module: g.module,
        action: g.action,
        outcome: g.outcome,
        count: g._count._all,
        durationSamples: g._count.durationMs,
        averageDurationMs: g._avg.durationMs,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
      })),
      current: { ingestion, orderSources, investigations, verifications },
    });
  }
}
