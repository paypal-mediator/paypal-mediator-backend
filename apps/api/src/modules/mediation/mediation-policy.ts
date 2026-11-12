import {
  MEDIATION_NOTICE,
  type MediationState,
  type MediationPolicy,
  type MediationProposal,
  type MediationVerdict,
} from '@resolve-ai/contracts';
import { ApiException } from '../../common/http/api.exception.js';

export const MEDIATION_TRANSITIONS: Record<
  MediationState,
  readonly MediationState[]
> = {
  detectado: ['abierto', 'cerrado'],
  abierto: ['en_conciliacion', 'cerrado'],
  en_conciliacion: ['acuerdo', 'sin_acuerdo', 'cerrado'],
  acuerdo: ['cerrado'],
  sin_acuerdo: ['demanda_admitida', 'cerrado'],
  demanda_admitida: ['recopilando_pruebas', 'cerrado'],
  recopilando_pruebas: ['dictaminado', 'cerrado'],
  dictaminado: ['escalado_a_paypal', 'cerrado'],
  escalado_a_paypal: ['cerrado'],
  cerrado: [],
};
export function assertTransition(from: MediationState, to: MediationState) {
  if (!MEDIATION_TRANSITIONS[from].includes(to))
    throw new ApiException(
      'MEDIATION_INVALID_TRANSITION',
      'Invalid mediation transition',
      409,
    );
}
export const DAY = 86400000;
export function mediationDeadlines(
  policy: MediationPolicy,
  now: Date,
  openedAt: Date,
  responseDeadline: Date | null,
) {
  // Inquiry cap is a fallback ceiling, never an extension of PayPal's specific due date.
  const paypal = Math.min(
    openedAt.getTime() + 20 * DAY,
    responseDeadline?.getTime() ?? Infinity,
  );
  const safeEnd = paypal - policy.deadlineMarginHours * 3600000;
  const claim = safeEnd - policy.evidenceHours * 3600000;
  const conciliation = Math.min(
    now.getTime() + policy.conciliationDays * DAY,
    claim - policy.claimHours * 3600000,
  );
  if (conciliation <= now.getTime())
    throw new ApiException(
      'MEDIATION_INSUFFICIENT_TIME',
      'Insufficient PayPal time for the configured mediation and evidence windows',
      409,
    );
  return {
    paypal: new Date(paypal),
    claim: new Date(claim),
    conciliation: new Date(conciliation),
  };
}
export function assertSafeAgentText(value: unknown) {
  const raw = JSON.stringify(value);
  // Defence in depth; prompts and a separate independent review also apply.
  if (
    /\b(neutral(?:es|idad)?|impartial)\b/i.test(raw) ||
    /(?:reembolsar[eé]|reembolsar[aá]|reembolsaremos|retendr[eé]|retendr[aá]|retendremos|transferir[eé]|transferir[aá]|transferiremos|devolver[eé]|devolver[aá]|devolveremos)/i.test(
      raw,
    ) ||
    /\b(?:we|platform|resolveai)\s+(?:will|shall|can)\s+(?:issue|process|execute)\b.{0,40}\b(?:refund|transfer|payment|hold)\b/i.test(
      raw,
    ) ||
    /(?:we|platform|plataforma|nosotros|yo)\s+(?:will\s+)?(?:refund|transfer|hold|reembolsar[eé]|retendr[eé]|transferir[eé])|(?:refund|reembolso|transferencia)\s+(?:executed|processed|completed|ejecutad[oa]|procesad[oa]|realizad[oa])/i.test(
      raw,
    )
  )
    throw new ApiException(
      'MEDIATION_UNSAFE_OUTPUT',
      'Agent output violates mediation policy',
      422,
    );
}
export function validateProposal(
  proposal: MediationProposal,
  policy: MediationPolicy,
) {
  assertSafeAgentText(proposal);
  if (
    proposal.options.some((o) => !policy.allowedSolutions.includes(o.solution))
  )
    throw new ApiException(
      'MEDIATION_OPTION_NOT_ALLOWED',
      'Proposal does not follow merchant policy',
      422,
    );
  const refundIndex = proposal.options.findIndex(
    (o) => o.solution === 'FULL_REFUND_RECOMMENDATION',
  );
  if (
    refundIndex === 0 &&
    proposal.options.some((o) => o.solution !== 'FULL_REFUND_RECOMMENDATION')
  )
    throw new ApiException(
      'MEDIATION_SALE_PRIORITY',
      'Sale preserving options must precede a full refund recommendation',
      422,
    );
}
export function validateVerdict(
  verdict: MediationVerdict,
  evidenceIds: string[],
) {
  assertSafeAgentText(verdict);
  const available = new Set(evidenceIds),
    assessed = verdict.assessedEvidence.map((e) => e.evidenceId);
  if (
    !available.size ||
    assessed.length !== available.size ||
    new Set(assessed).size !== assessed.length ||
    assessed.some((id) => !available.has(id)) ||
    verdict.grounds.some((g) => g.evidenceIds.some((id) => !available.has(id)))
  )
    throw new ApiException(
      'MEDIATION_INVALID_CITATION',
      'Every evidence item must be assessed and every citation must exist',
      422,
    );
  if (
    ((verdict.evidenceBalance === 'EQUIVALENT' ||
      verdict.evidenceBalance === 'CLEAR_SELLER') &&
      verdict.recommendation !== 'SELLER') ||
    (verdict.evidenceBalance === 'CLEAR_BUYER' &&
      verdict.recommendation !== 'BUYER')
  )
    throw new ApiException(
      'MEDIATION_INVALID_POSTURE',
      'Verdict contradicts the assessed evidence balance',
      422,
    );
  if (verdict.notice !== MEDIATION_NOTICE)
    throw new ApiException(
      'MEDIATION_TRANSPARENCY_REQUIRED',
      'Transparency notice is required',
      422,
    );
}
