import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { DisputesService } from '../../src/modules/disputes/index.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { VerifierService } from '../../src/modules/verifier/index.js';
import { InvestigatorEngine } from '../../src/modules/investigator/investigator.engine.js';
import { VerifierEngine } from '../../src/modules/verifier/verifier.engine.js';
import { VerificationResultSchema } from '@resolve-ai/contracts';
import { SubmissionsService } from '../../src/modules/submissions/index.js';
import {
  MediationPayPalClient,
  PayPalMediationDetailSchema,
} from '../../src/modules/submissions/mediation-paypal.client.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import { disputeEvent } from '../fixtures/dispute.js';
import { mockTransmissionHeaders } from '../fixtures/paypal-webhook.js';

describe('M07–M08 safety (real PostgreSQL/HTTP; MOCK PayPal, JWKS and qualified M06 boundary)', () => {
  const merchantId = randomUUID(),
    adminId = randomUUID(),
    viewerId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let db: PrismaService,
    disputes: DisputesService,
    submissions: SubmissionsService;
  let adminToken: string, viewerToken: string;
  const review = vi.fn(),
    detail = vi.fn(),
    perform = vi.fn();
  const send = (id: string, key = randomUUID(), extra: object = {}) =>
    request(context.app.getHttpServer())
      .post(`/api/disputes/${id}/submit`)
      .auth(adminToken, { type: 'bearer' })
      .send({
        idempotencyKey: key,
        approve: true,
        verificationId: randomUUID(),
        ...extra,
      });
  const deliver = (event: object) =>
    request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event)
      .expect(200);
  const seed = async () => {
    const paypalDisputeId = `PP-D-${randomUUID()}`;
    await deliver(
      disputeEvent({
        eventId: `MOCK-${randomUUID()}`,
        disputeId: paypalDisputeId,
        status: 'WAITING_FOR_SELLER_RESPONSE',
        deadlineAt: null,
        disputedAt: new Date().toISOString(),
      }),
    );
    expect(await disputes.processNextDispute(merchantId)).toBe('COMPLETED');
    const row = await db.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId },
    });
    detail.mockResolvedValue(
      PayPalMediationDetailSchema.parse({
        dispute_id: paypalDisputeId,
        create_time: '2026-11-01T00:00:00Z',
        reason: row.paypalReason,
        status: row.paypalStatus,
        dispute_life_cycle_stage: row.paypalStage,
        disputed_transactions: [{ seller_transaction_id: 'MOCK-CAPTURE' }],
        links: [
          {
            rel: 'provide-evidence',
            method: 'POST',
            href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${paypalDisputeId}/provide-evidence`,
          },
        ],
      }),
    );
    return row;
  };
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL required');
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api-m.sandbox.paypal.com/'))
        return nativeFetch(input, init);
      if (url.endsWith('/v1/oauth2/token'))
        return Response.json({
          access_token: 'MOCK_TOKEN',
          token_type: 'Bearer',
          expires_in: 300,
        });
      if (url.endsWith('/verify-webhook-signature'))
        return Response.json({ verification_status: 'SUCCESS' });
      throw new Error('Unexpected external call');
    });
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK',
        PAYPAL_CLIENT_SECRET: 'MOCK',
        PAYPAL_WEBHOOK_ID: 'MOCK',
        NVIDIA_API_KEY: 'MOCK_NO_NETWORK',
      },
      false,
    );
    await context.app.init();
    db = context.app.get(PrismaService);
    disputes = context.app.get(DisputesService);
    submissions = context.app.get(SubmissionsService);
    await db.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK M08',
        allowSubmissions: true,
        allowInvestigations: true,
        members: {
          create: [
            { authUserId: adminId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    adminToken = await issuer.token(adminId);
    viewerToken = await issuer.token(viewerId);
    await deliver(captureEvent('MOCK-CAPTURE'));
    expect(
      await context.app.get(TransactionsService).processNextCapture(merchantId),
    ).toBe('COMPLETED');
    vi.spyOn(
      context.app.get(VerifierService),
      'submissionReview',
    ).mockImplementation(review);
    vi.spyOn(
      context.app.get(MediationPayPalClient),
      'detail',
    ).mockImplementation(detail);
    vi.spyOn(
      context.app.get(MediationPayPalClient),
      'perform',
    ).mockImplementation(perform);
  });
  beforeEach(() => {
    review.mockReset().mockResolvedValue({
      verificationId: randomUUID(),
      evidenceIds: [randomUUID()],
      notes: 'MOCK independently supported statement',
      evidenceRevision: 1,
    });
    detail.mockReset();
    perform.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (db) {
      await db.verificationRun.deleteMany({ where: { merchantId } });
      await db.investigationRun.deleteMany({ where: { merchantId } });
      await db.submission.deleteMany({ where: { merchantId } });
      await db.disputeEvent.deleteMany({ where: { dispute: { merchantId } } });
      await db.dispute.deleteMany({ where: { merchantId } });
      await db.evidenceItem.deleteMany({ where: { dossier: { merchantId } } });
      await db.evidenceDossier.deleteMany({ where: { merchantId } });
      await db.transaction.deleteMany({ where: { merchantId } });
      await db.ingestionJob.deleteMany({ where: { event: { merchantId } } });
      await db.webhookEvent.deleteMany({ where: { merchantId } });
      await db.merchantMember.deleteMany({ where: { merchantId } });
      await db.merchant.delete({ where: { id: merchantId } });
    }
    await context?.app.close();
    await issuer?.close();
  });
  it('rejects VIEWER and unauthenticated requests before making a PayPal call', async () => {
    const row = await seed();
    await request(context.app.getHttpServer())
      .post(`/api/disputes/${row.id}/submit`)
      .send({ idempotencyKey: randomUUID() })
      .expect(401);
    await request(context.app.getHttpServer())
      .post(`/api/disputes/${row.id}/submit`)
      .auth(viewerToken, { type: 'bearer' })
      .send({ idempotencyKey: randomUUID() })
      .expect(403);
    expect(perform).not.toHaveBeenCalled();
  });
  it('records a blocked review, then permits a corrected request with a new key', async () => {
    const row = await seed();
    review.mockResolvedValueOnce(null);
    expect((await send(row.id).expect(201)).body.status).toBe('BLOCKED');
    expect((await send(row.id).expect(201)).body.status).toBe('SUBMITTED');
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await db.submission.count({ where: { disputeId: row.id } })).toBe(2);
    expect(
      await db.auditEvent.count({ where: { merchantId, module: 'M08' } }),
    ).toBeGreaterThan(0);
  });
  it('uses a valid multipart evidence payload and accepts bodyless acknowledged delivery', async () => {
    const row = await seed();
    expect((await send(row.id).expect(201)).body.status).toBe('SUBMITTED');
    const form = perform.mock.calls[0]![3] as FormData;
    expect(JSON.parse(String(form.get('input')))).toEqual({
      evidences: [
        {
          evidence_type: 'OTHER',
          notes: 'MOCK independently supported statement',
        },
      ],
    });
  });
  it('replays an identical key without sending again and rejects changed approval or target', async () => {
    const row = await seed(),
      key = randomUUID(),
      verificationId = randomUUID();
    const first = await send(row.id, key, { verificationId }).expect(201);
    const again = await send(row.id, key, { verificationId }).expect(201);
    expect(again.body.id).toBe(first.body.id);
    await send(row.id, key, { verificationId: randomUUID() }).expect(409);
    const other = await seed();
    await send(other.id, key, { verificationId }).expect(409);
    expect(perform).toHaveBeenCalledTimes(1);
  });
  it('serializes different-key attempts for the same dispute before dispatch', async () => {
    const row = await seed();
    const results = await Promise.all([send(row.id), send(row.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(perform).toHaveBeenCalledTimes(1);
  });
  it('serializes same-key requests and preserves one reservation and dispatch', async () => {
    const row = await seed(),
      key = randomUUID(),
      verificationId = randomUUID();
    const results = await Promise.all([
      send(row.id, key, { verificationId }),
      send(row.id, key, { verificationId }),
    ]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await db.submission.count({ where: { disputeId: row.id } })).toBe(1);
  });
  it('marks an ambiguous dispatch UNKNOWN and refuses another key', async () => {
    const row = await seed();
    perform.mockRejectedValueOnce(
      new Error('MOCK timeout with secret payload'),
    );
    const result = await send(row.id).expect(201);
    expect(result.body.status).toBe('UNKNOWN');
    expect(JSON.stringify(result.body)).not.toContain('secret payload');
    await send(row.id).expect(409);
    expect(perform).toHaveBeenCalledTimes(1);
  });
  it('permits a new attempt after preflight failure but never dispatches with stale actions', async () => {
    const row = await seed();
    detail.mockRejectedValueOnce(new Error('MOCK offline'));
    expect((await send(row.id).expect(201)).body.status).toBe('FAILED');
    expect(perform).not.toHaveBeenCalled();
    expect((await send(row.id).expect(201)).body.status).toBe('SUBMITTED');
  });
  it('blocks newly requested documentary evidence and leaves it for review', async () => {
    const row = await seed();
    const value = await detail();
    detail.mockResolvedValue({
      ...value,
      evidences: [
        { source: 'REQUESTED_FROM_SELLER', evidence_type: 'PROOF_OF_DELIVERY' },
      ],
    });
    expect((await send(row.id).expect(201)).body.status).toBe('FAILED');
    expect(perform).not.toHaveBeenCalled();
  });
  it('does not reveal an idempotent result to another merchant', async () => {
    const row = await seed(),
      key = randomUUID();
    await send(row.id, key).expect(201);
    await expect(
      submissions.submit(
        randomUUID(),
        row.id,
        adminId,
        { idempotencyKey: key },
        'ADMIN',
      ),
    ).rejects.toMatchObject({ code: 'DISPUTE_NOT_FOUND' });
  });
  it('persists the HTTP M07 → M05 → independent M06 cycle for the exact dispute (MOCK engines)', async () => {
    const row = await seed();
    const investigation = vi
      .spyOn(context.app.get(InvestigatorEngine), 'execute')
      .mockResolvedValue({
        summary: 'MOCK investigation',
        findings: [],
        missing: [
          {
            code: 'MISSING_DELIVERY',
            explanation: 'MOCK case lacks delivery evidence',
          },
        ],
        contradictions: [],
        irrelevantEvidenceIds: [],
        suggestedResponse: '',
      });
    const verification = vi
      .spyOn(context.app.get(VerifierEngine), 'execute')
      .mockResolvedValue(
        VerificationResultSchema.parse({
          verdict: 'INCOMPLETE',
          verifiedEvidenceIds: [],
          missingRequirements: ['MOCK delivery missing'],
          contradictions: [],
          reasons: [
            {
              code: 'MISSING_DELIVERY',
              explanation: 'MOCK delivery missing',
              evidenceIds: [],
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
                status: 'NOT_EVALUATED',
                explanation: 'MOCK incomplete case',
                evidenceIds: [],
              },
            ]),
          ),
          claims: [],
        }),
      );
    try {
      const key = randomUUID();
      const run = () =>
        request(context.app.getHttpServer())
          .post(`/api/disputes/${row.id}/investigate`)
          .auth(adminToken, { type: 'bearer' })
          .send({ idempotencyKey: key })
          .expect(201);
      const result = await run();
      expect(result.body).toMatchObject({
        investigation: { status: 'COMPLETED' },
        verification: {
          scope: 'DISPUTE_INR',
          status: 'COMPLETED',
          result: { verdict: 'INCOMPLETE' },
        },
        submissionAuthorized: false,
      });
      const stored = await db.verificationRun.findUniqueOrThrow({
        where: { id: result.body.verification.id },
      });
      expect(stored.snapshot).toMatchObject({
        dispute: {
          id: row.id,
          paypalDisputeId: row.paypalDisputeId,
          lastEventAt: row.lastEventAt.toISOString(),
        },
      });
      expect((await run()).body.verification.id).toBe(stored.id);
      expect(investigation).toHaveBeenCalledTimes(1);
      expect(verification).toHaveBeenCalledTimes(1);
      expect(perform).not.toHaveBeenCalled();
    } finally {
      investigation.mockRestore();
      verification.mockRestore();
    }
  });
  it('enforces one active reservation in PostgreSQL even outside the service locks', async () => {
    const tables = await db.$queryRaw<
      Array<{ relname: string; relrowsecurity: boolean }>
    >`SELECT relname, relrowsecurity FROM pg_class WHERE oid IN ('public.submissions'::regclass, 'public.submission_events'::regclass)`;
    expect(tables).toHaveLength(2);
    expect(tables.every((table) => table.relrowsecurity)).toBe(true);
    const row = await seed();
    const data = {
      merchantId,
      disputeId: row.id,
      status: 'PENDING',
      guardVerdict: 'ALLOWED',
      guardReasons: [],
    };
    await db.submission.create({
      data: { ...data, idempotencyKey: randomUUID() },
    });
    await expect(
      db.submission.create({ data: { ...data, idempotencyKey: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await db.submission.create({
      data: { ...data, status: 'BLOCKED', idempotencyKey: randomUUID() },
    });
    expect(await db.submission.count({ where: { disputeId: row.id } })).toBe(2);
  });
});
