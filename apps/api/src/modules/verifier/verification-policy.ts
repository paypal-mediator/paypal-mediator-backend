import type {
  InvestigationDraft,
  VerificationResult,
} from '@resolve-ai/contracts';
import type { InvestigationSnapshot } from './verifier.engine.js';

// Model approval cannot override deterministic blocks. This is not M08 authorization.
export function enforceVerification(
  snapshot: InvestigationSnapshot,
  draft: InvestigationDraft,
  proposed: VerificationResult,
  inspected: Set<string>,
): VerificationResult {
  const result = structuredClone(proposed);
  const { transaction, dossier } = snapshot;
  const current = dossier.items.filter((item) => item.current);
  const reject = (code: string, ids: string[] = []) => {
    result.verdict = 'REJECTED';
    result.contradictions.push(code);
    result.reasons.push({ code, explanation: code, evidenceIds: ids });
  };
  const missing = (code: string) => {
    if (result.verdict !== 'REJECTED') result.verdict = 'INCOMPLETE';
    result.missingRequirements.push(code);
    result.reasons.push({ code, explanation: code, evidenceIds: [] });
  };
  if (result.contradictions.length) result.verdict = 'REJECTED';
  if (result.missingRequirements.length && result.verdict === 'APPROVED')
    result.verdict = 'INCOMPLETE';
  if (
    transaction.readiness.status === 'NEEDS_REVIEW' ||
    transaction.orderLink.status === 'CONFLICT'
  )
    reject('DETERMINISTIC_SOURCE_CONFLICT');
  if (current.some((item) => item.integrity !== 'VALID'))
    reject('EVIDENCE_INTEGRITY_MISMATCH');
  if (
    transaction.readiness.containsDemo ||
    current.some((item) => item.sourceKind === 'DEMO')
  )
    missing('DEMO_IS_NOT_REAL_EVIDENCE');
  for (const check of transaction.readiness.checks) {
    if (check.status === 'CONFLICT') reject(`CONFLICT_${check.code}`);
    if (check.status === 'MISSING') missing(`MISSING_${check.code}`);
    if (
      check.status === 'PRESENT' &&
      check.code !== 'ORDER_REFERENCE' &&
      !check.evidenceIds.some(
        (id) => inspected.has(id) && result.verifiedEvidenceIds.includes(id),
      )
    )
      missing(`UNVERIFIED_${check.code}`);
  }
  const draftIds = [...draft.findings, ...draft.contradictions].flatMap(
    (item) => item.evidenceIds,
  );
  if (draftIds.some((id) => !current.some((item) => item.id === id)))
    reject('DRAFT_REFERENCES_NON_CURRENT_EVIDENCE');
  if (draftIds.some((id) => !inspected.has(id)))
    missing('DRAFT_SOURCES_NOT_INDEPENDENTLY_READ');
  if (draft.suggestedResponse.trim() && !draft.findings.length)
    reject('DRAFT_WITHOUT_SUPPORTING_FINDINGS');
  if (!result.verifiedEvidenceIds.length) missing('NO_VERIFIED_EVIDENCE');
  // M04 checks coverage; M06 also compares directly available identifiers/dates.
  for (const item of current) {
    if (
      !item.sourceSystem.trim() ||
      !item.externalReference.trim() ||
      !Number.isFinite(Date.parse(item.retrievedAt)) ||
      Date.parse(item.retrievedAt) > Date.now()
    )
      reject('INVALID_PROVENANCE', inspected.has(item.id) ? [item.id] : []);
    const content = item.content;
    if (
      typeof content.paypalCaptureId === 'string' &&
      content.paypalCaptureId !== transaction.paypalCaptureId
    )
      reject('CAPTURE_ID_MISMATCH', inspected.has(item.id) ? [item.id] : []);
    if (
      typeof content.merchantOrderReference === 'string' &&
      transaction.order &&
      content.merchantOrderReference !== transaction.order.externalId
    )
      reject(
        'ORDER_REFERENCE_MISMATCH',
        inspected.has(item.id) ? [item.id] : [],
      );
    for (const field of ['shippedAt', 'deliveredAt']) {
      if (
        typeof content[field] === 'string' &&
        ((transaction.order?.orderedAt != null &&
          Date.parse(content[field]) <
            Date.parse(transaction.order.orderedAt)) ||
          Date.parse(content[field]) > Date.now())
      )
        reject(
          'EVIDENCE_DATE_CONFLICT',
          inspected.has(item.id) ? [item.id] : [],
        );
    }
  }
  const tracking = current.find((item) => item.type === 'TRACKING');
  const delivery = current.find((item) => item.type === 'PROOF_OF_DELIVERY');
  if (tracking && delivery) {
    if (
      tracking.content.trackingNumber !== delivery.content.trackingNumber ||
      tracking.content.carrier !== delivery.content.carrier
    )
      reject('TRACKING_IDENTITY_MISMATCH');
    if (
      typeof tracking.content.shippedAt === 'string' &&
      typeof delivery.content.deliveredAt === 'string' &&
      Date.parse(delivery.content.deliveredAt) <
        Date.parse(tracking.content.shippedAt)
    )
      reject('DELIVERY_BEFORE_SHIPPING');
  }
  result.missingRequirements = [...new Set(result.missingRequirements)];
  result.contradictions = [...new Set(result.contradictions)];
  result.verifiedEvidenceIds = [...new Set(result.verifiedEvidenceIds)];
  return result;
}
