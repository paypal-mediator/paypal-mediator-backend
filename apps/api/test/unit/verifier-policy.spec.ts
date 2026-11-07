import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VerificationResultSchema,
  type InvestigationDraft,
  type VerificationResult,
} from '@resolve-ai/contracts';
import { contentHash } from '../../src/common/data/content-hash.js';
import { enforceVerification } from '../../src/modules/verifier/verification-policy.js';
import { draftUnits } from '../../src/modules/verifier/draft-units.js';
import type { InvestigationSnapshot } from '../../src/modules/verifier/verifier.engine.js';

function fixture() {
  const draft: InvestigationDraft = {
    summary: 'Payment recorded.',
    findings: [{ statement: 'Tracking recorded.', evidenceIds: [] }],
    missing: [],
    contradictions: [],
    irrelevantEvidenceIds: [],
    suggestedResponse: 'Delivered. Buyer signed.',
  };
  const items = [
    'PAYMENT_RECORD',
    'ORDER_RECORD',
    'TRACKING',
    'PROOF_OF_DELIVERY',
  ].map((type) => {
    const content =
      type === 'TRACKING' || type === 'PROOF_OF_DELIVERY'
        ? {
            paypalCaptureId: 'MOCK-CAP',
            merchantOrderReference: 'MOCK-ORDER',
            carrier: type === 'TRACKING' ? 'dhl' : 'DHL',
            trackingNumber: 'MOCK-TRACK',
            ...(type === 'TRACKING'
              ? { shippedAt: '2026-01-02T00:00:00.000Z' }
              : { deliveredAt: '2026-01-03T00:00:00.000Z' }),
          }
        : {};
    return {
      id: randomUUID(),
      type,
      content,
      contentHash: contentHash(content),
      current: true,
      integrity: 'VALID',
      version: 1,
      sourceKind: 'MERCHANT_INPUT',
      sourceSystem: 'MOCK',
      externalReference: 'MOCK',
      retrievedAt: '2026-01-04T00:00:00.000Z',
    };
  });
  draft.findings[0]!.evidenceIds = [items[2]!.id];
  const ids = items.map((i) => i.id);
  const snapshot = {
    transaction: {
      paypalCaptureId: 'MOCK-CAP',
      order: {
        externalId: 'MOCK-ORDER',
        orderedAt: '2026-01-01T00:00:00.000Z',
      },
      orderLink: { status: 'LINKED' },
      readiness: {
        status: 'READY',
        containsDemo: false,
        checks: items.map((i) => ({
          code: i.type,
          status: 'PRESENT',
          evidenceIds: [i.id],
        })),
      },
    },
    dossier: { items },
  } as unknown as InvestigationSnapshot;
  const checks = Object.fromEntries(
    [
      'PROVENANCE',
      'INTEGRITY',
      'IDENTITY',
      'CONSISTENCY',
      'RELEVANCE',
      'COVERAGE',
      'EXPLAINABILITY',
      'CURRENTNESS',
    ].map((key) => [
      key,
      {
        status: 'PASS',
        explanation: 'Explicit MOCK evaluation',
        evidenceIds: ids,
      },
    ]),
  );
  const result = VerificationResultSchema.parse({
    verdict: 'APPROVED',
    verifiedEvidenceIds: ids,
    missingRequirements: [],
    contradictions: [],
    reasons: [
      { code: 'MOCK_REVIEW', explanation: 'MOCK only', evidenceIds: ids },
    ],
    checklist: checks,
    claims: draftUnits(draft).map((unit) => ({
      ...unit,
      status: 'SUPPORTED',
      explanation: 'MOCK support',
      evidenceIds: ids,
    })),
  });
  const evaluate = (proposed: VerificationResult = result) =>
    enforceVerification(snapshot, draft, proposed, new Set(ids));
  return { snapshot, draft, result, evaluate };
}

describe('M06 deterministic approval controls (explicit MOCK source evaluations)', () => {
  it('accepts fully reviewed coverage with case-equivalent carriers', () => {
    expect(fixture().evaluate().verdict).toBe('APPROVED');
  });
  it('does not confuse commercial custom_id with the PayPal order ID', () => {
    const f = fixture();
    const order = f.snapshot.dossier.items.find(
      (i) => i.type === 'ORDER_RECORD',
    )!;
    order.content = {
      externalId: 'MOCK-PAYPAL-ORDER-ID',
      merchantOrderReference: 'MOCK-COMMERCIAL-REF',
    };
    expect(f.evaluate().verdict).toBe('APPROVED');
  });
  it('rejects genuinely different carriers', () => {
    const f = fixture();
    f.snapshot.dossier.items.find(
      (i) => i.type === 'PROOF_OF_DELIVERY',
    )!.content.carrier = 'UPS';
    expect(f.evaluate().contradictions).toContain('TRACKING_IDENTITY_MISMATCH');
  });
  it('inventories all response sentences including a claim outside findings', () => {
    const f = fixture();
    expect(draftUnits(f.draft).map((u) => u.statement)).toContain(
      'Buyer signed.',
    );
    f.result.claims = f.result.claims.filter(
      (c) => c.statement !== 'Buyer signed.',
    );
    expect(f.evaluate()).toMatchObject({
      verdict: 'INCOMPLETE',
      missingRequirements: expect.arrayContaining([
        'DRAFT_CLAIMS_NOT_REVIEWED',
      ]),
    });
  });
  it.each(['UNSUPPORTED', 'CONTRADICTED'] as const)(
    'rejects an extra response assertion evaluated as %s',
    (status) => {
      const f = fixture();
      f.result.claims.find((c) => c.statement === 'Buyer signed.')!.status =
        status;
      expect(f.evaluate().verdict).toBe('REJECTED');
    },
  );
  it('does not accept altered text or duplicate units as a full review', () => {
    const f = fixture();
    f.result.claims[0]!.statement = 'Different assertion';
    f.result.claims.push(f.result.claims[1]!);
    expect(f.evaluate().contradictions).toContain('INVALID_CLAIM_INVENTORY');
  });
  it('rejects SUPPORTED without cited verified originals', () => {
    const f = fixture();
    f.result.claims[0]!.evidenceIds = [];
    expect(f.evaluate().verdict).toBe('REJECTED');
  });
  it('requires all eight checklist dimensions in the public schema', () => {
    const f = fixture();
    const { INTEGRITY: removed, ...checklist } = f.result.checklist;
    expect(removed).toBeDefined();
    expect(
      VerificationResultSchema.safeParse({ ...f.result, checklist }).success,
    ).toBe(false);
  });
  it('retains NOT_EVALUATED explicitly and prevents approval', () => {
    const f = fixture();
    f.result.checklist.RELEVANCE.status = 'NOT_EVALUATED';
    expect(f.evaluate()).toMatchObject({
      verdict: 'INCOMPLETE',
      checklist: { RELEVANCE: { status: 'NOT_EVALUATED' } },
    });
  });
  it('does not allow a generic uncited PASS for a dimension', () => {
    const f = fixture();
    f.result.checklist.IDENTITY.evidenceIds = [];
    expect(f.evaluate().verdict).toBe('INCOMPLETE');
  });
  it('lets deterministic identity conflicts override model PASS and update the checklist', () => {
    const f = fixture();
    f.snapshot.dossier.items.find(
      (i) => i.type === 'TRACKING',
    )!.content.paypalCaptureId = 'OTHER';
    expect(f.evaluate()).toMatchObject({
      verdict: 'REJECTED',
      checklist: { IDENTITY: { status: 'FAIL' } },
    });
  });
});
