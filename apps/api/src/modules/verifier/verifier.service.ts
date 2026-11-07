import { Inject, Injectable } from '@nestjs/common';
import {
  VerificationResponseSchema,
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
  ) {}

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
      await tx.verificationRun.updateMany({
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
          } as unknown as Prisma.InputJsonValue,
          snapshotHash: contentHash({
            ...snapshot,
            draft: investigation.result,
          }),
          trace: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          expiresAt: new Date(Date.now() + this.env.VERIFIER_TIMEOUT_MS),
        },
      });
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
      const saved = await this.prisma.verificationRun.updateMany({
        where: { id: row.id, status: 'RUNNING', expiresAt: { gt: new Date() } },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          result: result as unknown as Prisma.InputJsonValue,
          resultHash: contentHash(result),
          trace: trace as unknown as Prisma.InputJsonValue,
          usage,
        },
      });
      if (!saved.count) throw new AgentError('VERIFICATION_TIMEOUT');
    } catch (error) {
      const code = signal.aborted
        ? 'VERIFICATION_TIMEOUT'
        : error instanceof AgentError || error instanceof ApiException
          ? error.code
          : 'VERIFICATION_FAILED';
      await this.prisma.verificationRun.updateMany({
        where: { id: row.id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          errorCode: code,
          finishedAt: new Date(),
          trace: trace as unknown as Prisma.InputJsonValue,
          usage,
        },
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
    const snapshot = row.snapshot as unknown as InvestigationSnapshot;
    return VerificationResponseSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt.toISOString(),
      expired: row.status === 'RUNNING' && row.expiresAt.getTime() < Date.now(),
      stale: row.evidenceRevision !== currentRevision,
      containsDemo: snapshot.transaction.readiness.containsDemo,
      scope: 'PREVENTIVE_INR',
      submissionAuthorized: false,
    });
  }
}
