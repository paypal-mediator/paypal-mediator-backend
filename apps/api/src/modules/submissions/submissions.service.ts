import { Inject, Injectable } from '@nestjs/common';
import {
  SubmissionResultSchema,
  SubmissionListResponseSchema,
  type SubmitRequest,
  type SubmissionGuardResult,
  type MerchantRole,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import { contentHash } from '../../common/data/content-hash.js';
import type { Prisma, Submission } from '../../generated/prisma/client.js';
import { AuditService } from '../monitoring/audit.service.js';
import { MerchantsService } from '../merchants/index.js';
import { DisputesService } from '../disputes/index.js';
import { VerifierService } from '../verifier/index.js';
import { TransactionsService } from '../transactions/index.js';
import { MediationPayPalClient } from './mediation-paypal.client.js';
import { evaluateSubmissionGuard } from './submission-guard.js';

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DisputesService) private readonly disputes: DisputesService,
    @Inject(VerifierService) private readonly verifier: VerifierService,
    @Inject(MerchantsService) private readonly merchants: MerchantsService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(MediationPayPalClient)
    private readonly paypal: MediationPayPalClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async resolveDisputeContext(
    merchantId: string,
    disputeId: string,
    request: SubmitRequest,
  ) {
    const dispute = await this.disputes.detail(merchantId, disputeId);
    const policy = await this.merchants.getPolicy(merchantId);
    const review = dispute.link.transactionId
      ? await this.verifier.submissionReview(
          merchantId,
          dispute.link.transactionId,
          dispute.id,
          dispute.lastEventAt,
          request.verificationId,
        )
      : null;
    const guard = evaluateSubmissionGuard({
      internalState: dispute.internalState,
      linkStatus: dispute.link.status,
      verificationVerdict: review ? 'APPROVED' : null,
      verifiedEvidenceIds: review?.evidenceIds ?? [],
      merchantAllowSubmissions: policy.allowSubmissions,
      merchantRequireApproval: policy.requireMerchantApproval,
      merchantApproved: request.approve === true,
      paypalStatus: dispute.paypalStatus,
      paypalStage: dispute.paypalStage,
      existingSubmission: false,
    });
    if (dispute.reasonCategory !== 'ITEM_NOT_RECEIVED') {
      guard.verdict = 'BLOCKED';
      guard.reasons.push({
        code: 'DISPUTE_REASON_UNSUPPORTED',
        explanation: 'Only case-specific INR reviews are supported.',
        evidenceIds: [],
      });
    }
    return { dispute, review, guard };
  }

  async evaluateGuard(
    merchantId: string,
    disputeId: string,
  ): Promise<SubmissionGuardResult> {
    return (
      await this.resolveDisputeContext(merchantId, disputeId, {
        idempotencyKey: disputeId,
      })
    ).guard;
  }

  async submit(
    merchantId: string,
    disputeId: string,
    actorUserId: string,
    request: SubmitRequest,
    role?: MerchantRole,
  ) {
    if (role !== 'ADMIN')
      throw new ApiException(
        'MERCHANT_ADMIN_REQUIRED',
        'An administrator is required',
        403,
      );
    await this.disputes.detail(merchantId, disputeId);
    const requestHash = contentHash({
      merchantId,
      disputeId,
      actorUserId,
      verificationId: request.verificationId ?? null,
      approve: request.approve === true,
    });
    const replay = (row: Submission) => {
      if (
        row.merchantId !== merchantId ||
        row.disputeId !== disputeId ||
        row.requestHash !== requestHash
      )
        throw new ApiException(
          'SUBMISSION_IDEMPOTENCY_CONFLICT',
          'Idempotency key already used for a different request',
          409,
        );
      return this.present(row);
    };
    const existing = await this.prisma.submission.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    if (existing) return replay(existing);
    const ctx = await this.resolveDisputeContext(
      merchantId,
      disputeId,
      request,
    );
    const acquired = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`submission-key:${request.idempotencyKey}`}, 0))::text`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`submission:${merchantId}:${disputeId}`}, 0))::text`;
      const prior = await tx.submission.findUnique({
        where: { idempotencyKey: request.idempotencyKey },
      });
      if (prior) {
        replay(prior);
        return { row: prior, created: false };
      }
      const active = await tx.submission.findFirst({
        where: {
          merchantId,
          disputeId,
          status: { in: ['PENDING', 'UNKNOWN', 'SUBMITTED'] },
        },
      });
      if (active)
        throw new ApiException(
          'SUBMISSION_ALREADY_RESERVED',
          'A submission exists or requires reconciliation',
          409,
        );
      const blocked = ctx.guard.verdict === 'BLOCKED';
      const row = await tx.submission.create({
        data: {
          merchantId,
          disputeId,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          status: blocked ? 'BLOCKED' : 'PENDING',
          guardVerdict: ctx.guard.verdict,
          guardReasons: ctx.guard.reasons as unknown as Prisma.InputJsonValue,
          errorCode: blocked ? 'SUBMISSION_BLOCKED_BY_GUARD' : null,
          errorMessage: blocked
            ? 'Submission Guard blocked the submission'
            : null,
        },
      });
      await this.auditAttempt(tx, row, actorUserId);
      return { row, created: true };
    });
    if (!acquired.created || acquired.row.status === 'BLOCKED')
      return this.present(acquired.row);
    let dispatched = false;
    try {
      const detail = await this.paypal.detail(
        merchantId,
        ctx.dispute.paypalDisputeId,
      );
      const latest = await this.resolveDisputeContext(
        merchantId,
        disputeId,
        request,
      );
      const transaction = await this.transactions.detail(
        merchantId,
        ctx.dispute.link.transactionId!,
      );
      if (
        latest.guard.verdict !== 'ALLOWED' ||
        !latest.review ||
        latest.dispute.lastEventAt !== ctx.dispute.lastEventAt ||
        detail.status !== 'WAITING_FOR_SELLER_RESPONSE' ||
        detail.reason !== ctx.dispute.paypalReason ||
        contentHash(
          detail.messages.map((message) => ({
            postedBy:
              message.posted_by === 'ARBITER' ? 'OTHER' : message.posted_by,
            postedAt: new Date(message.time_posted).toISOString(),
            content: message.content,
          })),
        ) !== contentHash(latest.dispute.messages) ||
        detail.evidences.some(
          (evidence) =>
            evidence.source === 'REQUESTED_FROM_SELLER' &&
            evidence.evidence_type !== 'OTHER',
        ) ||
        detail.messages.some(
          (message) => (message.documents?.length ?? 0) > 0,
        ) ||
        detail.evidences.some(
          (evidence) => (evidence.documents?.length ?? 0) > 0,
        ) ||
        detail.supporting_info.length > 0 ||
        detail.dispute_life_cycle_stage !== ctx.dispute.paypalStage ||
        detail.disputed_transactions.some(
          (t) => t.seller_transaction_id !== transaction.paypalCaptureId,
        ) ||
        !this.paypal.can(detail, 'provide-evidence')
      )
        throw new ApiException(
          'SUBMISSION_CONTEXT_CHANGED',
          'Current PayPal actions or verified context do not permit submission',
          409,
        );
      const form = new FormData();
      form.append(
        'input',
        JSON.stringify({
          evidences: [{ evidence_type: 'OTHER', notes: latest.review.notes }],
        }),
      );
      dispatched = true;
      await this.paypal.perform(
        merchantId,
        detail,
        'provide-evidence',
        form,
        request.idempotencyKey,
      );
      return await this.finish(acquired.row.id, actorUserId, 'SUBMITTED', null);
    } catch {
      return this.finish(
        acquired.row.id,
        actorUserId,
        dispatched ? 'UNKNOWN' : 'FAILED',
        dispatched
          ? 'SUBMISSION_RECONCILIATION_REQUIRED'
          : 'SUBMISSION_PREFLIGHT_FAILED',
      );
    }
  }

  private async finish(
    id: string,
    actorUserId: string,
    status: 'SUBMITTED' | 'FAILED' | 'UNKNOWN',
    errorCode: string | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.submission.update({
        where: { id },
        data: {
          status,
          errorCode,
          errorMessage: errorCode
            ? 'Submission requires review; no automatic resend was performed'
            : null,
          submittedAt: status === 'SUBMITTED' ? new Date() : null,
          paypalResponseStatus: status === 'SUBMITTED' ? 200 : null,
        },
      });
      await this.auditAttempt(tx, row, actorUserId);
      return this.present(row);
    });
  }

  private async auditAttempt(
    tx: Prisma.TransactionClient,
    row: Submission,
    actorUserId: string,
  ) {
    await this.audit.append(
      {
        merchantId: row.merchantId,
        actorUserId,
        resourceType: 'SUBMISSION',
        resourceId: row.id,
        outcome:
          row.status === 'SUBMITTED'
            ? 'SUCCEEDED'
            : row.status === 'PENDING'
              ? 'STARTED'
              : row.status === 'BLOCKED'
                ? 'BLOCKED'
                : 'FAILED',
        record: {
          action: 'SUBMISSION_ATTEMPTED',
          details: {
            state:
              row.status === 'SUBMITTED'
                ? 'COMPLETED'
                : row.status === 'PENDING'
                  ? 'QUEUED'
                  : row.status === 'BLOCKED'
                    ? 'IGNORED'
                    : 'FAILED',
            ...(row.errorCode ? { errorCode: row.errorCode } : {}),
          },
        },
      },
      tx,
    );
  }

  private present(row: Submission) {
    return SubmissionResultSchema.parse({
      id: row.id,
      disputeId: row.disputeId,
      status: row.status,
      paypalRequestId: row.paypalRequestId,
      paypalResponseStatus: row.paypalResponseStatus,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      guardResult: { verdict: row.guardVerdict, reasons: row.guardReasons },
      createdAt: row.createdAt.toISOString(),
    });
  }

  async list(merchantId: string, page: number, pageSize: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.submission.findMany({
        where: { merchantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.submission.count({ where: { merchantId } }),
    ]);
    return SubmissionListResponseSchema.parse({
      items: items.map((row) => this.present(row)),
      total,
      page,
      pageSize,
    });
  }
}
