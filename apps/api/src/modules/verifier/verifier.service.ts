import { AuditService } from '../monitoring/audit.service.js';
import { Inject, Injectable } from '@nestjs/common';
import {
  VerificationResponseSchema,
  VerificationResultSchema,
  type StartVerification,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { ApiException } from '../../common/http/api.exception.js';
import { contentHash } from '../../common/data/content-hash.js';
import type { VerificationRun, Prisma } from '../../generated/prisma/client.js';
import { MerchantsService, type MerchantActor } from '../merchants/index.js';
import { TransactionsService } from '../transactions/index.js';
import {
  AgentProvider,
  AgentError,
  InvestigatorService,
} from '../investigator/index.js';
import {
  VerifierEngine,
  type InvestigationSnapshot,
  type VerificationTrace,
} from './verifier.engine.js';
import { VERIFIER_PROMPT_VERSION } from './prompts/verifier.prompts.js';

@Injectable()
export class VerifierService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvestigatorService)
    private readonly investigator: InvestigatorService,
    @Inject(MerchantsService) private readonly merchants: MerchantsService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(AgentProvider) private readonly provider: AgentProvider,
    @Inject(VerifierEngine) private readonly engine: VerifierEngine,
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async operationalMetrics(merchantId: string) {
    const groups = await this.prisma.verificationRun.groupBy({
      by: ['status'],
      where: { merchantId },
      _count: { _all: true },
    });
    return groups.map((g) => ({ status: g.status, count: g._count._all }));
  }

  async verify(
    actor: MerchantActor,
    transactionId: string,
    investigationId: string,
    input: StartVerification,
  ) {
    if (actor.role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'An administrator is required',
        403,
      );
    await this.merchants.assertActionAllowed(actor.merchantId, 'INVESTIGATE');
    const investigation = await this.investigator.detail(
      actor.merchantId,
      transactionId,
      investigationId,
    );
    if (
      investigation.status !== 'COMPLETED' ||
      !investigation.result ||
      investigation.stale
    )
      throw new ApiException(
        'INVESTIGATION_NOT_VERIFIABLE',
        'A completed current investigation is required',
        409,
      );
    const snapshot = await this.transactions.investigationSnapshot(
      actor.merchantId,
      transactionId,
    );
    snapshot.dossier.items = snapshot.dossier.items.filter(
      (item) => item.current,
    );
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 256 * 1024)
      throw new ApiException(
        'VERIFICATION_CONTEXT_LIMIT',
        'The evidence snapshot exceeds the verification size limit',
        413,
      );
    if (snapshot.dossier.revision !== investigation.evidenceRevision)
      throw new ApiException(
        'INVESTIGATION_STALE',
        'Evidence changed since investigation',
        409,
      );
    const config = this.provider.configuration();
    const acquired = await this.prisma.$transaction(async (tx) => {
      const key = `verify:${actor.merchantId}:${transactionId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
      const expired = await tx.verificationRun.updateManyAndReturn({
        where: {
          merchantId: actor.merchantId,
          transactionId,
          status: 'RUNNING',
          expiresAt: { lt: new Date() },
        },
        data: {
          status: 'FAILED',
          errorCode: 'VERIFICATION_TIMEOUT',
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
            resourceType: 'VERIFICATION',
            resourceId: run.id,
            outcome: 'FAILED',
            durationMs: Math.max(0, Date.now() - run.createdAt.getTime()),
            record: {
              action: 'VERIFICATION_FINISHED',
              details: { errorCode: 'VERIFICATION_TIMEOUT' },
            },
          },
          tx,
        );
      const existing = await tx.verificationRun.findUnique({
        where: {
          merchantId_investigationId_idempotencyKey: {
            merchantId: actor.merchantId,
            investigationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) return { row: existing, created: false };
      // Serialized with acquisition: a different key or investigation cannot erase a rejection.
      const rejection = await tx.verificationRun.findFirst({
        where: {
          merchantId: actor.merchantId,
          transactionId,
          status: 'COMPLETED',
          result: { path: ['verdict'], equals: 'REJECTED' },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (rejection && contentHash(rejection.result) !== rejection.resultHash)
        throw new ApiException(
          'VERIFICATION_INTEGRITY_MISMATCH',
          'Rejected result integrity check failed',
          409,
        );
      if (rejection && input.rejectionReview?.verificationId !== rejection.id)
        throw new ApiException(
          'VERIFICATION_REJECTION_REVIEW_REQUIRED',
          'An administrator must review and justify retrying the latest rejected verification',
          409,
        );
      if (!rejection && input.rejectionReview)
        throw new ApiException(
          'VERIFICATION_REJECTION_REVIEW_INVALID',
          'No rejected verification exists for this transaction',
          409,
        );
      const rejectionReview = input.rejectionReview
        ? {
            ...input.rejectionReview,
            actorUserId: actor.userId,
            reviewedAt: new Date().toISOString(),
          }
        : null;
      if (
        await tx.verificationRun.findFirst({
          where: {
            merchantId: actor.merchantId,
            transactionId,
            status: 'RUNNING',
          },
        })
      )
        throw new ApiException(
          'VERIFICATION_IN_PROGRESS',
          'A verification is already running for this transaction',
          409,
        );
      const row = await tx.verificationRun.create({
        data: {
          merchantId: actor.merchantId,
          transactionId,
          investigationId,
          idempotencyKey: input.idempotencyKey,
          actorUserId: actor.userId,
          status: 'RUNNING',
          provider: config.provider,
          model: config.model,
          promptVersion: VERIFIER_PROMPT_VERSION,
          evidenceRevision: snapshot.dossier.revision,
          snapshot: {
            ...snapshot,
            draft: investigation.result,
            rejectionReview,
          } as unknown as Prisma.InputJsonValue,
          snapshotHash: contentHash({
            ...snapshot,
            draft: investigation.result,
            rejectionReview,
          }),
          trace: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          expiresAt: new Date(Date.now() + this.env.VERIFIER_TIMEOUT_MS),
        },
      });
      await this.audit.append(
        {
          merchantId: actor.merchantId,
          actorUserId: actor.userId,
          transactionId,
          resourceType: 'VERIFICATION',
          resourceId: row.id,
          outcome: 'STARTED',
          record: {
            action: 'VERIFICATION_STARTED',
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
    const trace: VerificationTrace[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const remaining = row.expiresAt.getTime() - Date.now();
    const signal = AbortSignal.timeout(Math.max(1, remaining));
    try {
      const result = await this.engine.execute(
        snapshot,
        investigation.result,
        signal,
        trace,
        usage,
      );
      await this.merchants.assertActionAllowed(actor.merchantId, 'INVESTIGATE');
      if (signal.aborted) throw new AgentError('VERIFICATION_TIMEOUT');
      const latest = await this.transactions.investigationSnapshot(
        actor.merchantId,
        transactionId,
      );
      if (latest.dossier.revision !== snapshot.dossier.revision)
        throw new AgentError('VERIFICATION_STALE');
      const saved = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.verificationRun.updateMany({
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
          await this.audit.agentSteps(context, 'VERIFICATION', trace, tx);
          await this.audit.append(
            {
              ...context,
              actorKind: 'AGENT',
              resourceType: 'VERIFICATION',
              durationMs: Math.max(0, Date.now() - row.createdAt.getTime()),
              ...usage,
              record: {
                action: 'VERIFICATION_FINISHED',
                details: {
                  provider: config.provider,
                  verdict: result.verdict,
                },
              },
            },
            tx,
          );
        }
        return saved;
      });
      if (!saved.count) throw new AgentError('VERIFICATION_TIMEOUT');
    } catch (error) {
      const code = signal.aborted
        ? 'VERIFICATION_TIMEOUT'
        : error instanceof AgentError || error instanceof ApiException
          ? error.code
          : 'VERIFICATION_FAILED';
      await this.prisma.$transaction(async (tx) => {
        const saved = await tx.verificationRun.updateMany({
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
          await this.audit.agentSteps(context, 'VERIFICATION', trace, tx);
          await this.audit.append(
            {
              ...context,
              actorKind: 'AGENT',
              resourceType: 'VERIFICATION',
              outcome: 'FAILED',
              durationMs: Math.max(0, Date.now() - row.createdAt.getTime()),
              ...usage,
              record: {
                action: 'VERIFICATION_FINISHED',
                details: { errorCode: code, provider: config.provider },
              },
            },
            tx,
          );
        }
      });
    }
    return this.detail(
      actor.merchantId,
      transactionId,
      investigationId,
      row.id,
    );
  }

  async list(
    merchantId: string,
    transactionId: string,
    investigationId: string,
  ) {
    await this.investigator.detail(merchantId, transactionId, investigationId);
    const snapshot = await this.transactions.investigationSnapshot(
      merchantId,
      transactionId,
    );
    const rows = await this.prisma.verificationRun.findMany({
      where: { merchantId, transactionId, investigationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    return {
      items: rows.map((row) => this.present(row, snapshot.dossier.revision)),
    };
  }

  async detail(
    merchantId: string,
    transactionId: string,
    investigationId: string,
    id: string,
  ) {
    const row = await this.prisma.verificationRun.findFirst({
      where: { id, merchantId, transactionId, investigationId },
    });
    if (!row)
      throw new ApiException(
        'VERIFICATION_NOT_FOUND',
        'Verification not found',
        404,
      );
    const snapshot = await this.transactions.investigationSnapshot(
      merchantId,
      transactionId,
    );
    return this.present(row, snapshot.dossier.revision);
  }

  private present(row: VerificationRun, currentRevision: number) {
    if (
      contentHash(row.snapshot) !== row.snapshotHash ||
      (row.result !== null && contentHash(row.result) !== row.resultHash)
    )
      throw new ApiException(
        'VERIFICATION_INTEGRITY_MISMATCH',
        'Verification integrity check failed',
        409,
      );
    if (
      row.result !== null &&
      !VerificationResultSchema.safeParse(row.result).success
    )
      throw new ApiException(
        'VERIFICATION_RESULT_REVIEW_REQUIRED',
        'This historical result does not satisfy the current verification contract; request a new review',
        409,
      );
    const snapshot = row.snapshot as unknown as InvestigationSnapshot & {
      rejectionReview?: {
        verificationId: string;
        justification: string;
        actorUserId: string;
        reviewedAt: string;
      } | null;
    };
    return VerificationResponseSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt.toISOString(),
      expired: row.status === 'RUNNING' && row.expiresAt.getTime() < Date.now(),
      stale: row.evidenceRevision !== currentRevision,
      containsDemo: snapshot.transaction.readiness.containsDemo,
      rejectionReview: snapshot.rejectionReview ?? null,
      scope: 'PREVENTIVE_INR',
      submissionAuthorized: false,
    });
  }
}
