import { Inject, Injectable } from '@nestjs/common';
import {
  SubmissionResultSchema,
  type SubmissionResult,
  SubmissionGuardResultSchema,
  type SubmissionGuardResult,
  type SubmitRequest,
  SubmissionListResponseSchema,
  type SubmissionListResponse,
} from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ApiException } from '../../common/http/api.exception.js';
import { Prisma, type Submission } from '../../generated/prisma/client.js';
import { AuditService } from '../../modules/monitoring/index.js';
import {
  PAYPAL_FETCH,
  PAYPAL_SANDBOX_URL,
  PayPalAuthService,
} from '../merchants/index.js';
import { evaluateSubmissionGuard } from './submission-guard.js';

type VerificationVerdict = 'APPROVED' | 'INCOMPLETE' | 'REJECTED';

interface DisputeWithVerification {
  id: string;
  merchantId: string;
  paypalDisputeId: string;
  paypalStatus: string | null;
  paypalStage: string | null;
  paypalReason: string | null;
  reasonCategory: string | null;
  internalState: string | null;
  linkStatus: string | null;
  linkReason: string | null;
  transactionId: string | null;
  amount: Prisma.Decimal | null;
  currencyCode: string | null;
  verifiedAt: Date | null;
  verificationVerdict: VerificationVerdict | null;
  verifiedEvidenceIds: string[];
  merchantAllowSubmissions: boolean | null;
  merchantRequireApproval: boolean | null;
  existingSubmission: boolean | null;
}

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYPAL_FETCH) private readonly fetcher: typeof fetch,
    @Inject(PayPalAuthService) private readonly auth: PayPalAuthService,
    @Inject(AuditService)
    private readonly audit: AuditService,
  ) {}

  /**
   * Gather all data needed to evaluate the Submission Guard for a dispute.
   */
  async resolveDisputeContext(
    merchantId: string,
    disputeId: string,
  ): Promise<DisputeWithVerification> {
    const dispute = await this.prisma.dispute.findFirst({
      where: { id: disputeId, merchantId },
      include: {
        merchant: {
          select: {
            allowSubmissions: true,
            requireMerchantApproval: true,
          },
        },
        transaction: {
          select: {
            id: true,
            verifications: {
              orderBy: [{ createdAt: 'desc' }],
              take: 1,
            },
          },
        },
        submissions: {
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!dispute) {
      throw new ApiException('DISPUTE_NOT_FOUND', 'Dispute not found', 404);
    }

    const latestVerification = dispute.transaction?.verifications[0];
    const verificationResult =
      (latestVerification?.result as
        | { verdict?: VerificationVerdict; verifiedEvidenceIds?: string[] }
        | undefined) ?? {};
    const verificationVerdict =
      verificationResult.verdict === 'APPROVED' ||
      verificationResult.verdict === 'INCOMPLETE' ||
      verificationResult.verdict === 'REJECTED'
        ? verificationResult.verdict
        : null;
    const verifiedEvidenceIds: string[] = Array.isArray(
      verificationResult.verifiedEvidenceIds,
    )
      ? verificationResult.verifiedEvidenceIds
      : [];

    return {
      id: dispute.id,
      merchantId: dispute.merchantId,
      paypalDisputeId: dispute.paypalDisputeId,
      paypalStatus: dispute.paypalStatus,
      paypalStage: dispute.paypalStage,
      paypalReason: dispute.paypalReason,
      reasonCategory: dispute.reasonCategory,
      internalState: dispute.internalState,
      linkStatus: dispute.linkStatus,
      linkReason: dispute.linkReason,
      transactionId: dispute.transactionId,
      amount: dispute.amount,
      currencyCode: dispute.currencyCode,
      verifiedAt: latestVerification?.finishedAt ?? null,
      verificationVerdict,
      verifiedEvidenceIds,
      merchantAllowSubmissions: dispute.merchant.allowSubmissions,
      merchantRequireApproval: dispute.merchant.requireMerchantApproval,
      existingSubmission: dispute.submissions.length > 0,
    };
  }

  /**
   * Evaluate the Submission Guard without making any PayPal call.
   * Returns the guard result and whether submission would be allowed.
   */
  async evaluateGuard(
    merchantId: string,
    disputeId: string,
  ): Promise<SubmissionGuardResult> {
    const ctx = await this.resolveDisputeContext(merchantId, disputeId);
    return evaluateSubmissionGuard({
      internalState: ctx.internalState,
      linkStatus: ctx.linkStatus,
      verificationVerdict: ctx.verificationVerdict,
      verifiedEvidenceIds: ctx.verifiedEvidenceIds,
      merchantAllowSubmissions: ctx.merchantAllowSubmissions,
      merchantRequireApproval: ctx.merchantRequireApproval,
      paypalStatus: ctx.paypalStatus,
      paypalStage: ctx.paypalStage,
      existingSubmission: ctx.existingSubmission,
    });
  }

  /**
   * Submit evidence to PayPal. This is the only entry point that can call
   * PayPal's provide-evidence endpoint. It is protected by the Submission Guard.
   */
  async submit(
    merchantId: string,
    disputeId: string,
    actorUserId: string,
    request: SubmitRequest,
  ): Promise<SubmissionResult> {
    // Idempotency: reject if we already processed this key for this dispute.
    const existing = await this.prisma.submission.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    if (existing && existing.disputeId === disputeId) {
      return this.mapSubmission(existing);
    }

    const ctx = await this.resolveDisputeContext(merchantId, disputeId);

    // Run the deterministic guard first.
    const guardResult = evaluateSubmissionGuard({
      internalState: ctx.internalState,
      linkStatus: ctx.linkStatus,
      verificationVerdict: ctx.verificationVerdict,
      verifiedEvidenceIds: ctx.verifiedEvidenceIds,
      merchantAllowSubmissions: ctx.merchantAllowSubmissions,
      merchantRequireApproval: ctx.merchantRequireApproval,
      paypalStatus: ctx.paypalStatus,
      paypalStage: ctx.paypalStage,
      existingSubmission: ctx.existingSubmission,
    });

    // If blocked, record and return without calling PayPal.
    if (guardResult.verdict === 'BLOCKED') {
      return this.recordSubmission(
        disputeId,
        merchantId,
        actorUserId,
        request.idempotencyKey,
        'BLOCKED',
        null,
        null,
        null,
        'SUBMISSION_BLOCKED_BY_GUARD',
        'Submission Guard blocked the submission',
        guardResult,
      );
    }

    // Guard allowed: call PayPal provide-evidence.
    let paypalRequestId: string | null = null;
    let paypalResponseStatus: number | null = null;
    let submittedAt: Date | null = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let status: 'SUBMITTED' | 'FAILED' = 'SUBMITTED';

    try {
      const signal = AbortSignal.timeout(10000);
      const token = await this.auth.getAccessToken(signal, true);

      const response = await this.fetcher(
        `${PAYPAL_SANDBOX_URL}/v1/customer/disputes/${ctx.paypalDisputeId}/provide-evidence`,
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'PayPal-Request-Id': request.idempotencyKey.toString(),
          },
          body: JSON.stringify({
            evidence_items: ctx.verifiedEvidenceIds.map((id) => ({
              evidence_id: id,
            })),
          }),
        },
      );

      paypalResponseStatus = response.status;

      if (!response.ok) {
        await response.body?.cancel();
        status = 'FAILED';
        errorCode = 'PAYPAL_API_ERROR';
        errorMessage = `PayPal provide-evidence returned ${response.status}`;
        paypalRequestId = null;
      } else {
        const body = await response.json();
        paypalRequestId = body?.request_id ?? body?.id ?? null;
        submittedAt = new Date();
      }
    } catch (err) {
      status = 'FAILED';
      errorCode = 'SUBMISSION_REQUEST_FAILED';
      errorMessage =
        err instanceof Error ? err.message : 'Unknown submission error';
    }

    return this.recordSubmission(
      disputeId,
      merchantId,
      actorUserId,
      request.idempotencyKey,
      status,
      paypalRequestId,
      paypalResponseStatus,
      submittedAt,
      errorCode,
      errorMessage,
      guardResult,
    );
  }

  private async recordSubmission(
    disputeId: string,
    merchantId: string,
    actorUserId: string,
    idempotencyKey: string,
    status: 'SUBMITTED' | 'BLOCKED' | 'FAILED',
    paypalRequestId: string | null,
    paypalResponseStatus: number | null,
    submittedAt: Date | null,
    errorCode: string | null,
    errorMessage: string | null,
    guardResult: SubmissionGuardResult,
  ): Promise<SubmissionResult> {
    return this.prisma.$transaction(async (tx) => {
      // Re-check idempotency inside transaction.
      const existing = await tx.submission.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return this.mapSubmission(existing);
      }

      const submission = await tx.submission.create({
        data: {
          idempotencyKey,
          merchantId,
          disputeId,
          environment: 'sandbox',
          status,
          paypalRequestId,
          paypalResponseStatus,
          submittedAt,
          errorCode,
          errorMessage,
          guardVerdict: guardResult.verdict,
          guardReasons: guardResult.reasons,
        },
      });

      // Audit the submission attempt via M09.
      const auditRecord: Parameters<typeof this.audit.append>[0]['record'] = {
        action: 'SUBMISSION_ATTEMPTED',
        details: {
          state:
            status === 'SUBMITTED'
              ? 'COMPLETED'
              : status === 'FAILED'
                ? 'FAILED'
                : 'IGNORED',
          ...(errorCode ? { errorCode } : {}),
          ...(paypalResponseStatus ? { httpStatus: paypalResponseStatus } : {}),
          ...(submittedAt ? { observedAt: submittedAt.toISOString() } : {}),
        },
      } as Parameters<typeof this.audit.append>[0]['record'];

      await this.audit.append(
        {
          merchantId,
          actorUserId,
          resourceType: 'SUBMISSION',
          resourceId: submission.id,
          outcome: status === 'SUBMITTED' ? 'SUCCEEDED' : 'BLOCKED',
          record: auditRecord,
        },
        tx,
      );

      return this.mapSubmission(submission);
    });
  }

  private mapSubmission(row: Submission): SubmissionResult {
    return SubmissionResultSchema.parse({
      id: row.id,
      disputeId: row.disputeId,
      status: row.status as SubmissionResult['status'],
      paypalRequestId: row.paypalRequestId,
      paypalResponseStatus: row.paypalResponseStatus,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      guardResult: SubmissionGuardResultSchema.parse({
        verdict: row.guardVerdict,
        reasons: row.guardReasons,
      }),
      createdAt: row.createdAt.toISOString(),
    });
  }

  async list(
    merchantId: string,
    page: number,
    pageSize: number,
  ): Promise<SubmissionListResponse> {
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
      items: items.map((item) => this.mapSubmission(item)),
      page,
      pageSize,
      total,
    });
  }
}
