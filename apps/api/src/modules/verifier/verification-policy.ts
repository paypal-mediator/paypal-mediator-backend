import type {
  InvestigationDraft,
  VerificationResult,
} from '@resolve-ai/contracts';
import { draftUnits } from './draft-units.js';
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
  type Dimension = keyof VerificationResult['checklist'];
  const mark = (dimension: Dimension, explanation: string, ids: string[]) => {
    const check = result.checklist[dimension];
    check.status = 'FAIL';
    check.explanation = `${explanation}; ${check.explanation}`.slice(0, 2000);
    check.evidenceIds = [...new Set([...check.evidenceIds, ...ids])].slice(
      0,
      32,
    );
  };
  const reject = (
    code: string,
    ids: string[] = [],
    dimension: Dimension = 'CONSISTENCY',
  ) => {
    mark(dimension, code, ids);
    result.verdict = 'REJECTED';
    result.contradictions.push(code);
    result.reasons.push({ code, explanation: code, evidenceIds: ids });
  };
  const missing = (code: string, dimension: Dimension = 'COVERAGE') => {
    mark(dimension, code, []);
    if (result.verdict !== 'REJECTED') result.verdict = 'INCOMPLETE';
    result.missingRequirements.push(code);
    result.reasons.push({ code, explanation: code, evidenceIds: [] });
  };
  // Every dimension is mandatory; a generic reason cannot stand in for the checklist.
  for (const [dimension, check] of Object.entries(proposed.checklist)) {
    if (check.status === 'NOT_EVALUATED') {
      missing(`NOT_EVALUATED_${dimension}`, dimension as Dimension);
      result.checklist[dimension as Dimension].status = 'NOT_EVALUATED';
    }
    if (check.status === 'FAIL') {
      if (dimension === 'COVERAGE' || dimension === 'CURRENTNESS')
        missing(`FAILED_${dimension}`, dimension);
      else
        reject(
          `FAILED_${dimension}`,
          check.evidenceIds,
          dimension as Dimension,
        );
    }
    if (check.status === 'PASS' && !check.evidenceIds.length)
      missing(`UNCITED_${dimension}`, dimension as Dimension);
  }
  const units = draftUnits(draft);
  const expected = new Map(units.map((unit) => [unit.unitId, unit.statement]));
  const reviewed = new Set<string>();
  for (const claim of result.claims) {
    if (
      reviewed.has(claim.unitId) ||
      expected.get(claim.unitId) !== claim.statement
    )
      reject('INVALID_CLAIM_INVENTORY', claim.evidenceIds, 'EXPLAINABILITY');
    reviewed.add(claim.unitId);
    if (claim.status === 'UNSUPPORTED' || claim.status === 'CONTRADICTED')
      reject(
        `CLAIM_${claim.status}:${claim.unitId}`,
        claim.evidenceIds,
        'EXPLAINABILITY',
      );
    if (claim.status === 'NOT_VERIFIABLE')
      missing(`CLAIM_NOT_VERIFIABLE:${claim.unitId}`, 'EXPLAINABILITY');
    if (
      claim.status === 'SUPPORTED' &&
      (!claim.evidenceIds.length ||
        claim.evidenceIds.some(
          (id) =>
            !inspected.has(id) || !result.verifiedEvidenceIds.includes(id),
        ))
    )
      reject(
        `CLAIM_WITHOUT_VERIFIED_SUPPORT:${claim.unitId}`,
        claim.evidenceIds,
        'EXPLAINABILITY',
      );
  }
  if (units.some((unit) => !reviewed.has(unit.unitId)))
    missing('DRAFT_CLAIMS_NOT_REVIEWED', 'EXPLAINABILITY');
  if (result.contradictions.length) result.verdict = 'REJECTED';
  if (result.missingRequirements.length && result.verdict === 'APPROVED')
    result.verdict = 'INCOMPLETE';
  if (
    transaction.readiness.status === 'NEEDS_REVIEW' ||
    transaction.orderLink.status === 'CONFLICT'
  )
    reject('DETERMINISTIC_SOURCE_CONFLICT');
  if (current.some((item) => item.integrity !== 'VALID'))
    reject('EVIDENCE_INTEGRITY_MISMATCH', [], 'INTEGRITY');
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
    reject('DRAFT_REFERENCES_NON_CURRENT_EVIDENCE', [], 'CURRENTNESS');
  if (draftIds.some((id) => !inspected.has(id)))
    missing('DRAFT_SOURCES_NOT_INDEPENDENTLY_READ', 'EXPLAINABILITY');
  if (draft.suggestedResponse.trim() && !draft.findings.length)
    reject('DRAFT_WITHOUT_SUPPORTING_FINDINGS', [], 'EXPLAINABILITY');
  if (!result.verifiedEvidenceIds.length) missing('NO_VERIFIED_EVIDENCE');
  // M04 checks coverage; M06 also compares directly available identifiers/dates.
  for (const item of current) {
    if (
      !item.sourceSystem.trim() ||
      !item.externalReference.trim() ||
      !Number.isFinite(Date.parse(item.retrievedAt)) ||
      Date.parse(item.retrievedAt) > Date.now()
    )
      reject(
        'INVALID_PROVENANCE',
        inspected.has(item.id) ? [item.id] : [],
        'PROVENANCE',
      );
    const content = item.content;
    if (
      typeof content.paypalCaptureId === 'string' &&
      content.paypalCaptureId !== transaction.paypalCaptureId
    )
      reject(
        'CAPTURE_ID_MISMATCH',
        inspected.has(item.id) ? [item.id] : [],
        'IDENTITY',
      );
    if (
      (item.type === 'TRACKING' || item.type === 'PROOF_OF_DELIVERY') &&
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
      String(tracking.content.carrier).toUpperCase() !==
        String(delivery.content.carrier).toUpperCase()
    )
      reject('TRACKING_IDENTITY_MISMATCH', [], 'IDENTITY');
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
