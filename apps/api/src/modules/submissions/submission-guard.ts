import {
  SubmissionGuardReasonSchema,
  SubmissionGuardResultSchema,
  type SubmissionGuardReason,
  type SubmissionGuardResult,
} from '@resolve-ai/contracts';
import { DisputeInternalStateSchema } from '@resolve-ai/contracts';
import { DisputeLinkStatusSchema } from '@resolve-ai/contracts';

// Verification verdict type (mirrors contracts/verifications.ts verdict enum).
// Not exported from contracts as a standalone type, so we define it locally.
type VerificationVerdict = 'APPROVED' | 'INCOMPLETE' | 'REJECTED';

/**
 * Submission Guard: deterministic validation that must pass before any
 * evidence is sent to PayPal. This module never talks to PayPal; it only
 * decides whether a submission is allowed and why.
 */

// PayPal states in which providing evidence is permitted.
// These are documented in PayPal's Disputes API reference.
const ELIGIBLE_PAYPAL_STATUSES = new Set([
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
]);

const ELIGIBLE_PAYPAL_STAGES = new Set(['INQUIRY', 'CHARGEBACK']);

function isPayPalStatusEligible(status: string | null | undefined): boolean {
  return (
    status !== null &&
    status !== undefined &&
    ELIGIBLE_PAYPAL_STATUSES.has(status)
  );
}

function isPayPalStageEligible(stage: string | null | undefined): boolean {
  return (
    stage !== null && stage !== undefined && ELIGIBLE_PAYPAL_STAGES.has(stage)
  );
}

function reason(
  code: string,
  explanation: string,
  evidenceIds: string[] = [],
): SubmissionGuardReason {
  return SubmissionGuardReasonSchema.parse({ code, explanation, evidenceIds });
}

/**
 * Evaluate whether a dispute may be submitted to PayPal right now.
 *
 * Rules (deterministic, no AI):
 * 1. Dispute internal state must be LINKED (transaction mapped) and Verifier
 *    must have APPROVED the evidence.
 * 2. Merchant must allow submissions (allowSubmissions) and merchant approval
 *    must be satisfied.
 * 3. PayPal status/stage must be eligible for provide-evidence.
 * 4. Transaction must be linked (not UNLINKED or CONFLICT).
 * 5. No prior submission exists for this dispute (idempotency).
 */
export function evaluateSubmissionGuard(input: {
  internalState: string | null | undefined;
  linkStatus: string | null | undefined;
  verificationVerdict: VerificationVerdict | null | undefined;
  verifiedEvidenceIds: string[];
  merchantAllowSubmissions: boolean | null | undefined;
  merchantRequireApproval: boolean | null | undefined;
  paypalStatus: string | null | undefined;
  paypalStage: string | null | undefined;
  existingSubmission: boolean | null | undefined;
}): SubmissionGuardResult {
  const reasons: SubmissionGuardReason[] = [];

  // Rule 1: internal state must be LINKED
  if (
    input.internalState === null ||
    input.internalState === undefined ||
    !DisputeInternalStateSchema.safeParse(input.internalState).success ||
    input.internalState !== 'LINKED'
  ) {
    reasons.push(
      reason(
        'DISPUTE_NOT_LINKED',
        'La disputa no está vinculada a una transacción de pago verificada.',
      ),
    );
  }

  // Rule 2: link status must not be CONFLICT or UNLINKED
  if (
    input.linkStatus === null ||
    input.linkStatus === undefined ||
    !DisputeLinkStatusSchema.safeParse(input.linkStatus).success ||
    input.linkStatus !== 'LINKED'
  ) {
    reasons.push(
      reason(
        'TRANSACTION_LINK_CONFLICT',
        'El vínculo entre la disputa y la transacción no es confiable o está ausente.',
      ),
    );
  }

  // Rule 3: Verifier must have APPROVED
  if (
    input.verificationVerdict === null ||
    input.verificationVerdict === undefined ||
    input.verificationVerdict !== 'APPROVED'
  ) {
    reasons.push(
      reason(
        'EVIDENCE_NOT_VERIFIED',
        'El Verifier no ha aprobado la evidencia (veredicto no es APPROVED).',
        input.verifiedEvidenceIds,
      ),
    );
  }

  // Rule 4: merchant must allow submissions
  if (input.merchantAllowSubmissions !== true) {
    reasons.push(
      reason(
        'SUBMISSIONS_DISABLED',
        'El comerciante no tiene habilitados los envíos de evidencia (allowSubmissions=false).',
      ),
    );
  }

  // Rule 5: merchant approval required
  if (input.merchantRequireApproval === true) {
    reasons.push(
      reason(
        'MERCHANT_APPROVAL_REQUIRED',
        'Se requiere aprobación explícita del comerciante antes de enviar.',
      ),
    );
  }

  // Rule 6: PayPal status must be eligible
  if (!isPayPalStatusEligible(input.paypalStatus)) {
    reasons.push(
      reason(
        'PAYPAL_STATUS_NOT_ELIGIBLE',
        `El estado de PayPal (${input.paypalStatus ?? 'desconocido'}) no permite proporcionar evidencia ahora.`,
      ),
    );
  }

  // Rule 7: PayPal stage must be eligible
  if (!isPayPalStageEligible(input.paypalStage)) {
    reasons.push(
      reason(
        'PAYPAL_STAGE_NOT_ELIGIBLE',
        `La etapa de PayPal (${input.paypalStage ?? 'desconocida'}) no permite proporcionar evidencia ahora.`,
      ),
    );
  }

  // Rule 8: no prior submission (idempotency)
  if (input.existingSubmission === true) {
    reasons.push(
      reason(
        'DUPLICATE_SUBMISSION',
        'Ya existe un envío registrado para esta disputa.',
      ),
    );
  }

  const verdict = reasons.length === 0 ? 'ALLOWED' : 'BLOCKED';

  return SubmissionGuardResultSchema.parse({ verdict, reasons });
}
