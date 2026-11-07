import { AuditService } from '../monitoring/audit.service.js';
import { Inject, Injectable } from '@nestjs/common';
import {
  InvestigationResponseSchema,
  type StartInvestigation,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { ApiException } from '../../common/http/api.exception.js';
import { contentHash } from '../../common/data/content-hash.js';
import type {
  InvestigationRun,
  Prisma,
} from '../../generated/prisma/client.js';
import { MerchantsService, type MerchantActor } from '../merchants/index.js';
import { TransactionsService } from '../transactions/index.js';
import { AgentProvider, AgentError } from './agent-provider.js';
import {
  InvestigatorEngine,
  type InvestigationSnapshot,
  type InvestigationTrace,
} from './investigator.engine.js';
import { INVESTIGATOR_PROMPT_VERSION } from './prompts/investigator.prompts.js';

@Injectable()
export class InvestigatorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MerchantsService) private readonly merchants: MerchantsService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(AgentProvider) private readonly provider: AgentProvider,
    @Inject(InvestigatorEngine) private readonly engine: InvestigatorEngine,
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async operationalMetrics(merchantId: string) {
    const groups = await this.prisma.investigationRun.groupBy({
      by: ['status'],
      where: { merchantId },
      _count: { _all: true },
    });
    return groups.map((g) => ({ status: g.status, count: g._count._all }));
  }

  async start(
    actor: MerchantActor,
    transactionId: string,
    input: StartInvestigation,
  ) {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'An administrator is required',
        403,
      );
    await this.merchants.assertActionAllowed(actor.merchantId, 'INVESTIGATE');
    const snapshot = await this.transactions.investigationSnapshot(
      actor.merchantId,
      transactionId,
    );
    snapshot.dossier.items = snapshot.dossier.items.filter(
      (item) => item.current,
    );
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 256 * 1024)
      throw new ApiException(
        'INVESTIGATION_CONTEXT_LIMIT',
        'The evidence snapshot exceeds the investigation size limit',
        413,
      );
    const config = this.provider.configuration();
    const acquired = await this.prisma.$transaction(async (tx) => {
      const key = `investigate:${actor.merchantId}:${transactionId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
      const expired = await tx.investigationRun.updateManyAndReturn({
        where: {
          merchantId: actor.merchantId,
          transactionId,
          status: 'RUNNING',
          expiresAt: { lt: new Date() },
        },
        data: {
          status: 'FAILED',
          errorCode: 'INVESTIGATION_TIMEOUT',
          finishedAt: new Date(),
        },
      });
      for (const run of expired)
        await this.audit.append(
          {
            merchantId: run.merchantId,
            actorUserId: run.actorUserId,
            actorKind: 'SYSTEM',
            transactionId: run.transactionId,
            resourceType: 'INVESTIGATION',
            resourceId: run.id,
            outcome: 'FAILED',
            durationMs: Math.max(0, Date.now() - run.createdAt.getTime()),
            record: {
              action: 'INVESTIGATION_FINISHED',
              details: { errorCode: 'INVESTIGATION_TIMEOUT' },
            },
          },
          tx,
        );
      const existing = await tx.investigationRun.findUnique({
        where: {
          merchantId_transactionId_idempotencyKey: {
            merchantId: actor.merchantId,
            transactionId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) return { row: existing, created: false };
      if (
        await tx.investigationRun.findFirst({
          where: {
            merchantId: actor.merchantId,
            transactionId,
            status: 'RUNNING',
          },
        })
      )
        throw new ApiException(
          'INVESTIGATION_IN_PROGRESS',
          'An investigation is already running for this transaction',
          409,
        );
      const row = await tx.investigationRun.create({
        data: {
          merchantId: actor.merchantId,
          transactionId,
          idempotencyKey: input.idempotencyKey,
          actorUserId: actor.userId,
          status: 'RUNNING',
          provider: config.provider,
          model: config.model,
          promptVersion: INVESTIGATOR_PROMPT_VERSION,
          evidenceRevision: snapshot.dossier.revision,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          snapshotHash: contentHash(snapshot),
          trace: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          expiresAt: new Date(Date.now() + this.env.INVESTIGATOR_TIMEOUT_MS),
        },
      });
      await this.audit.append(
        {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          transactionId,
          resourceType: 'INVESTIGATION',
          resourceId: row.id,
          outcome: 'STARTED',
          record: {
            action: 'INVESTIGATION_STARTED',
            details: { provider: config.provider },
          },
        },
        tx,
      );
      return { row, created: true };
    });
    if (!acquired.created)
      return this.present(acquired.row, snapshot.dossier.revision);
    const row = acquired.row;
    const trace: InvestigationTrace[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const remaining = row.expiresAt.getTime() - Date.now();
    const signal = AbortSignal.timeout(Math.max(1, remaining));
    try {
      const result = await this.engine.execute(snapshot, signal, trace, usage);
      await this.merchants.assertActionAllowed(actor.merchantId, 'INVESTIGATE');
      if (signal.aborted) throw new AgentError('INVESTIGATION_TIMEOUT');
      const latest = await this.transactions.investigationSnapshot(
        actor.merchantId,
        transactionId,
      );
      if (latest.dossier.revision !== snapshot.dossier.revision)
        throw new AgentError('INVESTIGATION_STALE');
      const saved = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.investigationRun.updateMany({
          where: {
            id: row.id,
            status: 'RUNNING',
            expiresAt: { gt: new Date() },
          },
          data: {
            status: 'COMPLETED',
            finishedAt: new Date(),
            result: result as unknown as Prisma.InputJsonValue,
            resultHash: contentHash(result),
            trace: trace as unknown as Prisma.InputJsonValue,
            usage,
          },
        });
        if (saved.count) {
          const context = {
            merchantId: actor.merchantId,
            actorUserId: actor.userId,
            transactionId,
            resourceId: row.id,
          };
          await this.audit.agentSteps(context, 'INVESTIGATION', trace, tx);
          await this.audit.append(
            {
              ...context,
              actorKind: 'AGENT',
              resourceType: 'INVESTIGATION',
              durationMs: Math.max(0, Date.now() - row.createdAt.getTime()),
              ...usage,
              record: {
                action: 'INVESTIGATION_FINISHED',
                details: { provider: config.provider },
              },
            },
            tx,
          );
        }
        return saved;
      });
      if (!saved.count) throw new AgentError('INVESTIGATION_TIMEOUT');
    } catch (error) {
      const code =
        error instanceof AgentError || error instanceof ApiException
          ? error.code
          : 'INVESTIGATION_FAILED';
      await this.prisma.$transaction(async (tx) => {
        const saved = await tx.investigationRun.updateMany({
          where: { id: row.id, status: 'RUNNING' },
          data: {
            status: 'FAILED',
            errorCode: code,
            finishedAt: new Date(),
            trace: trace as unknown as Prisma.InputJsonValue,
            usage,
          },
        });
        if (saved.count) {
          const context = {
            merchantId: actor.merchantId,
            actorUserId: actor.userId,
            transactionId,
            resourceId: row.id,
          };
          await this.audit.agentSteps(context, 'INVESTIGATION', trace, tx);
          await this.audit.append(
            {
              ...context,
              actorKind: 'AGENT',
              resourceType: 'INVESTIGATION',
              outcome: 'FAILED',
              durationMs: Math.max(0, Date.now() - row.createdAt.getTime()),
              ...usage,
              record: {
                action: 'INVESTIGATION_FINISHED',
                details: { errorCode: code, provider: config.provider },
              },
            },
            tx,
          );
        }
      });
    }
    return this.detail(actor.merchantId, transactionId, row.id);
  }

  async list(merchantId: string, transactionId: string) {
    const snapshot = await this.transactions.investigationSnapshot(
      merchantId,
      transactionId,
    );
    const rows = await this.prisma.investigationRun.findMany({
      where: { merchantId, transactionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    return {
      items: rows.map((row) => this.present(row, snapshot.dossier.revision)),
    };
  }

  async detail(merchantId: string, transactionId: string, id: string) {
    const row = await this.prisma.investigationRun.findFirst({
      where: { id, merchantId, transactionId },
    });
    if (!row)
      throw new ApiException(
        'INVESTIGATION_NOT_FOUND',
        'Investigation not found',
        404,
      );
    const snapshot = await this.transactions.investigationSnapshot(
      merchantId,
      transactionId,
    );
    return this.present(row, snapshot.dossier.revision);
  }

  private present(row: InvestigationRun, currentRevision: number) {
    if (
      contentHash(row.snapshot) !== row.snapshotHash ||
      (row.result !== null && contentHash(row.result) !== row.resultHash)
    )
      throw new ApiException(
        'INVESTIGATION_INTEGRITY_MISMATCH',
        'Investigation integrity check failed',
        409,
      );
    const snapshot = row.snapshot as unknown as InvestigationSnapshot;
    return InvestigationResponseSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt.toISOString(),
      expired: row.status === 'RUNNING' && row.expiresAt.getTime() < Date.now(),
      stale: row.evidenceRevision !== currentRevision,
      containsDemo: snapshot.transaction.readiness.containsDemo,
      commercialSource: snapshot.transaction.orderEnrichment?.records.some(
        (record) =>
          record.integrity === 'VALID' &&
          record.data?.association === 'MATCHED',
      )
        ? 'AVAILABLE'
        : 'NOT_CONNECTED',
      requiresVerification: true,
      deterministicIssues: [
        ...snapshot.transaction.readiness.reasons,
        ...(snapshot.transaction.orderEnrichment?.records.some(
          (record) =>
            record.integrity === 'VALID' &&
            record.data?.association === 'MATCHED',
        )
          ? []
          : ['COMMERCIAL_SOURCE_NOT_CONNECTED']),
        ...snapshot.transaction.readiness.checks
          .filter((check) => check.status === 'MISSING')
          .map((check) => `MISSING_${check.code}`),
      ],
    });
  }
}
