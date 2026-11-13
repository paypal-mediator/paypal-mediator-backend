import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { VerificationResultSchema } from '@resolve-ai/contracts';
import { VerifierService } from '../../src/modules/verifier/verifier.service.js';
import { contentHash } from '../../src/common/data/content-hash.js';

function setup() {
  const id = randomUUID(),
    evidenceId = randomUUID(),
    disputeId = randomUUID(),
    merchantId = randomUUID(),
    transactionId = randomUUID();
  const lastEventAt = new Date().toISOString();
  const snapshot = {
    transaction: { readiness: { containsDemo: false } },
    dossier: {
      revision: 1,
      items: [{ id: evidenceId, current: true, integrity: 'VALID' }],
    },
    dispute: { id: disputeId, lastEventAt },
  };
  const result = VerificationResultSchema.parse({
    verdict: 'APPROVED',
    verifiedEvidenceIds: [evidenceId],
    missingRequirements: [],
    contradictions: [],
    reasons: [
      {
        code: 'MOCK_SUPPORTED',
        explanation: 'MOCK originals inspected',
        evidenceIds: [evidenceId],
      },
    ],
    checklist: Object.fromEntries(
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
          explanation: 'MOCK inspected',
          evidenceIds: [evidenceId],
        },
      ]),
    ),
    claims: [
      {
        unitId: 'finding:0',
        statement: 'MOCK supported statement',
        status: 'SUPPORTED',
        explanation: 'MOCK cited',
        evidenceIds: [evidenceId],
      },
    ],
  });
  const row = {
    id,
    merchantId,
    transactionId,
    investigationId: randomUUID(),
    idempotencyKey: randomUUID(),
    status: 'COMPLETED',
    provider: 'NVIDIA',
    model: 'MOCK',
    promptVersion: 'MOCK',
    evidenceRevision: 1,
    errorCode: null,
    snapshot,
    result,
    snapshotHash: contentHash(snapshot),
    resultHash: contentHash(result),
    createdAt: new Date(),
    finishedAt: new Date(),
    expiresAt: new Date(Date.now() + 10000),
    trace: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const db = { verificationRun: { findFirst: vi.fn().mockResolvedValue(row) } };
  const transactions = {
    investigationSnapshot: vi.fn().mockResolvedValue(snapshot),
  };
  type Args = ConstructorParameters<typeof VerifierService>;
  const service = new VerifierService(
    db as unknown as Args[0],
    {} as Args[1],
    {} as Args[2],
    transactions as unknown as Args[3],
    {} as Args[4],
    {} as Args[5],
    {} as Args[6],
    {} as Args[7],
    {} as Args[8],
  );
  const review = () =>
    service.submissionReview(
      merchantId,
      transactionId,
      disputeId,
      lastEventAt,
      id,
    );
  const rehash = () => {
    row.snapshotHash = contentHash(snapshot);
    row.resultHash = contentHash(result);
  };
  return { service, review, rehash, row, snapshot, result, db, id, evidenceId };
}

describe('M06 public submission review boundary with MOCK persistence/originals', () => {
  it('returns only independently supported notes for the exact current case', async () => {
    const test = setup();
    expect(await test.review()).toMatchObject({
      verificationId: test.id,
      evidenceIds: [test.evidenceId],
      notes: 'MOCK supported statement',
    });
  });
  it('never promotes preventive readiness into dispute authorization', async () => {
    const test = setup();
    delete (test.snapshot as { dispute?: unknown }).dispute;
    test.rehash();
    expect(await test.review()).toBeNull();
  });
  it.each(['FAILED', 'RUNNING'])(
    'rejects a %s run even if its stored result says approved',
    async (status) => {
      const test = setup();
      test.row.status = status;
      expect(await test.review()).toBeNull();
    },
  );
  it('rejects an obsolete evidence revision', async () => {
    const test = setup();
    test.row.evidenceRevision = 0;
    expect(await test.review()).toBeNull();
  });
  it('rejects a review for a different case update', async () => {
    const test = setup();
    test.snapshot.dispute.lastEventAt = '2000-01-01T00:00:00.000Z';
    test.rehash();
    expect(await test.review()).toBeNull();
  });
  it('rejects a prior approval when a newer verification exists', async () => {
    const test = setup();
    test.row.id = randomUUID();
    expect(await test.review()).toBeNull();
  });
  it('rejects DEMO evidence', async () => {
    const test = setup();
    test.snapshot.transaction.readiness.containsDemo = true;
    test.rehash();
    expect(await test.review()).toBeNull();
  });
  it('rejects superseded or invalid originals', async () => {
    const test = setup();
    test.snapshot.dossier.items[0]!.current = false;
    test.rehash();
    expect(await test.review()).toBeNull();
  });
  it('rejects tampered result hashes', async () => {
    const test = setup();
    test.result.claims[0]!.statement = 'Tampered';
    await expect(test.review()).rejects.toMatchObject({
      code: 'VERIFICATION_INTEGRITY_MISMATCH',
    });
  });
});
