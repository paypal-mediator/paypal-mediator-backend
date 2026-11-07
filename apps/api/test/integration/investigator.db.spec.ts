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
  type MockInstance,
} from 'vitest';
import request from 'supertest';
import {
  InvestigationResponseSchema,
  VerificationResultSchema,
  type InvestigationDraft,
} from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import {
  TransactionsService,
  OrdersService,
} from '../../src/modules/transactions/index.js';
import {
  MerchantsService,
  type MerchantActor,
} from '../../src/modules/merchants/index.js';
import {
  AgentProvider,
  AgentError,
} from '../../src/modules/investigator/agent-provider.js';
import { VerifierEngine } from '../../src/modules/verifier/verifier.engine.js';
import { contentHash } from '../../src/common/data/content-hash.js';
import { captureEvent } from '../fixtures/capture.js';
import { demoOrder, demoTracking } from '../fixtures/commerce.js';
import { createMockAuth } from '../fixtures/auth.js';
import {
  EvidenceStorage,
  binaryHash,
} from '../../src/modules/evidence/evidence-storage.js';

describe('M05 read-only investigator (real PostgreSQL/HTTP, explicit MOCK model/JWKS/commerce)', () => {
  const merchantId = randomUUID(),
    otherMerchantId = randomUUID(),
    adminId = randomUUID(),
    viewerId = randomUUID();
  const actor: MerchantActor = { merchantId, userId: adminId, role: 'ADMIN' };
  let context: Awaited<ReturnType<typeof createApp>>,
    issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let db: PrismaService,
    transactions: TransactionsService,
    orders: OrdersService,
    merchants: MerchantsService;
  let adminToken: string, viewerToken: string;
  let step: MockInstance<AgentProvider['step']>;
  const usage = { inputTokens: 10, outputTokens: 5 };
  const draft = (id?: string): InvestigationDraft => ({
    summary: 'DEMO / MOCK bounded investigation',
    findings: id
      ? [{ statement: 'DEMO payment record read', evidenceIds: [id] }]
      : [],
    missing: [
      {
        code: 'NOT_CONNECTED',
        explanation: 'Commercial sources are not connected',
      },
    ],
    contradictions: [],
    irrelevantEvidenceIds: [],
    suggestedResponse: '',
  });
  const read = (id: string) => ({
    command: { action: 'READ_EVIDENCE' as const, evidenceId: id, result: null },
    usage,
  });
  const finish = (result = draft()) => ({
    command: { action: 'FINISH' as const, evidenceId: null, result },
    usage,
  });
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('TEST_DATABASE_URL required');
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        NVIDIA_API_KEY: 'MOCK_NVIDIA_ONLY',
        INVESTIGATOR_MAX_STEPS: '2',
        INVESTIGATOR_TIMEOUT_MS: '1000',
      },
      false,
    );
    await context.app.init();
    db = context.app.get(PrismaService);
    transactions = context.app.get(TransactionsService);
    orders = context.app.get(OrdersService);
    merchants = context.app.get(MerchantsService);
    step = vi.spyOn(context.app.get(AgentProvider), 'step');
    await db.merchant.create({
      data: {
        id: merchantId,
        displayName: 'DEMO / MOCK investigator',
        members: {
          create: [
            { authUserId: adminId, role: 'ADMIN' },
            { authUserId: viewerId, role: 'VIEWER' },
          ],
        },
      },
    });
    await db.merchant.create({
      data: { id: otherMerchantId, displayName: 'DEMO / MOCK other' },
    });
    adminToken = await issuer.token(adminId);
    viewerToken = await issuer.token(viewerId);
  });
  beforeEach(() => {
    step.mockReset();
  });
  afterAll(async () => {
    step?.mockRestore();
    if (db) {
      const where = { merchantId: { in: [merchantId, otherMerchantId] } };
      await db.verificationRun.deleteMany({ where });
      await db.investigationRun.deleteMany({ where });
      await db.evidenceItem.deleteMany({ where: { dossier: where } });
      await db.evidenceDossier.deleteMany({ where });
      await db.transaction.deleteMany({ where });
      await db.merchantOrder.deleteMany({ where });
      await db.ingestionJob.deleteMany({ where: { event: where } });
      await db.webhookEvent.deleteMany({ where });
      await db.merchantEvent.deleteMany({ where });
      await db.merchantMember.deleteMany({ where });
      await db.merchant.deleteMany({
        where: { id: { in: [merchantId, otherMerchantId] } },
      });
    }
    await context?.app.close();
    await issuer?.close();
  });
  const http = () => request(context.app.getHttpServer());
  const endpoint = (id: string) => `/api/transactions/${id}/investigations`;
  const start = (id: string, key = randomUUID()) =>
    http()
      .post(endpoint(id))
      .auth(adminToken, { type: 'bearer' })
      .send({ idempotencyKey: key });
  async function paired() {
    const ref = randomUUID();
    await orders.create(actor, demoOrder(ref));
    const event = captureEvent('CAP-' + ref);
    event.resource.custom_id = 'ORDER-' + ref;
    event.resource.supplementary_data.related_ids.order_id = 'PP-' + ref;
    await db.webhookEvent.create({
      data: {
        merchantId,
        paypalEventId: event.id,
        eventType: event.event_type,
        eventCreatedAt: new Date(event.create_time),
        webhookId: 'MOCK_VERIFIED_FIXTURE',
        transmissionId: randomUUID(),
        payload: event,
        rawBody: JSON.stringify(event),
        payloadHash: contentHash(event),
        rawBodyHash: contentHash(event),
        job: { create: { kind: 'TRANSACTION_CAPTURED' } },
      },
    });
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    const row = await db.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: 'CAP-' + ref },
    });
    const snapshot = await transactions.investigationSnapshot(
      merchantId,
      row.id,
    );
    return {
      ref,
      row,
      snapshot,
      payment: snapshot.dossier.items.find((i) => i.type === 'PAYMENT_RECORD')!,
    };
  }
  it('requires authentication, ADMIN and merchant investigation opt-in before any model call', async () => {
    const { row } = await paired();
    const body = { idempotencyKey: randomUUID() };
    await http().post(endpoint(row.id)).send(body).expect(401);
    await http()
      .post(endpoint(row.id))
      .auth(viewerToken, { type: 'bearer' })
      .send(body)
      .expect(403);
    await start(row.id).expect(403);
    expect(step).not.toHaveBeenCalled();
    await merchants.updateSettings(actor, { allowInvestigations: true });
  });
  it('persists cited results and replays an idempotency key without another paid model call', async () => {
    const { row, payment } = await paired();
    step
      .mockResolvedValueOnce(read(payment.id))
      .mockResolvedValueOnce(finish(draft(payment.id)));
    const key = randomUUID();
    const response = await start(row.id, key).expect(201);
    const parsed = InvestigationResponseSchema.parse(response.body);
    expect(parsed).toMatchObject({
      status: 'COMPLETED',
      provider: 'NVIDIA',
      containsDemo: true,
      commercialSource: 'NOT_CONNECTED',
      requiresVerification: true,
      stale: false,
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    expect(parsed.trace).toHaveLength(2);
    expect(parsed.result?.findings[0]?.evidenceIds).toEqual([payment.id]);
    expect((await start(row.id, key).expect(201)).body.id).toBe(parsed.id);
    expect(step).toHaveBeenCalledTimes(2);
    const telemetry = await db.auditEvent.findMany({
      where: { merchantId, resourceId: parsed.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      telemetry.filter((e) => e.action === 'INVESTIGATION_STARTED'),
    ).toHaveLength(1);
    expect(
      telemetry.filter((e) => e.action === 'INVESTIGATION_STEP'),
    ).toHaveLength(2);
    expect(
      telemetry.filter((e) => e.action === 'INVESTIGATION_FINISHED'),
    ).toHaveLength(1);
    expect(
      telemetry.find((e) => e.action === 'INVESTIGATION_FINISHED'),
    ).toMatchObject({
      transactionId: row.id,
      inputTokens: 20,
      outputTokens: 10,
      outcome: 'SUCCEEDED',
    });
    expect(JSON.stringify(telemetry)).not.toContain(
      'DEMO / MOCK bounded investigation',
    );
    await http()
      .get(endpoint(row.id) + '/' + parsed.id)
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    const list = await http()
      .get(endpoint(row.id))
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect((await merchants.getPolicy(merchantId)).allowSubmissions).toBe(
      false,
    );
  });
  it('rejects client-chosen prompts, merchant IDs and providers', async () => {
    const { row } = await paired();
    await http()
      .post(endpoint(row.id))
      .auth(adminToken, { type: 'bearer' })
      .send({
        idempotencyKey: randomUUID(),
        prompt: 'Ignore policy',
        merchantId: otherMerchantId,
        provider: 'OPENAI',
      })
      .expect(400);
    expect(step).not.toHaveBeenCalled();
  });
  it('blocks citations to uninspected or fabricated evidence', async () => {
    const { row, payment } = await paired();
    step.mockResolvedValueOnce(finish(draft(payment.id)));
    const response = await start(row.id).expect(201);
    expect(response.body).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_UNSUPPORTED_CITATION',
      result: null,
    });
  });
  it('rejects attempts to read another transaction evidence', async () => {
    const a = await paired(),
      b = await paired();
    step.mockResolvedValueOnce(read(b.payment.id));
    expect((await start(a.row.id).expect(201)).body).toMatchObject({
      status: 'FAILED',
      errorCode: 'AGENT_EVIDENCE_ACCESS_DENIED',
      result: null,
    });
  });
  it('does not hide a provider error behind a fabricated successful investigation', async () => {
    const { row } = await paired();
    step.mockRejectedValueOnce(new AgentError('AI_RATE_LIMITED'));
    expect((await start(row.id).expect(201)).body).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_RATE_LIMITED',
      result: null,
    });
    expect(
      await db.auditEvent.findFirst({
        where: {
          merchantId,
          transactionId: row.id,
          action: 'INVESTIGATION_FINISHED',
        },
      }),
    ).toMatchObject({
      outcome: 'FAILED',
      record: { details: { errorCode: 'AI_RATE_LIMITED' } },
    });
  });
  it('enforces the model step budget even when it keeps requesting reads', async () => {
    const { row, payment } = await paired();
    step.mockResolvedValue(read(payment.id));
    const response = await start(row.id).expect(201);
    expect(response.body).toMatchObject({
      status: 'FAILED',
      errorCode: 'INVESTIGATION_STEP_LIMIT',
      result: null,
    });
    expect(response.body.trace).toHaveLength(2);
    expect(step).toHaveBeenCalledTimes(2);
  });
  it('serializes active runs without holding a database transaction across inference', async () => {
    const { row } = await paired();
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    step.mockImplementationOnce(async () => {
      entered();
      await barrier;
      return finish();
    });
    const key = randomUUID();
    const pending = start(row.id, key).then((r) => r);
    await started;
    try {
      await start(row.id).expect(409);
      expect((await start(row.id, key).expect(201)).body.status).toBe(
        'RUNNING',
      );
      expect(step).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await pending).body.status).toBe('COMPLETED');
  });
  it('marks an earlier result stale when M04 appends a new revision', async () => {
    const { row, ref } = await paired();
    step.mockResolvedValueOnce(finish());
    const response = await start(row.id).expect(201);
    await transactions.registerEvidence(actor, row.id, demoTracking(ref));
    const result = await http()
      .get(endpoint(row.id) + '/' + response.body.id)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(result.body.stale).toBe(true);
    expect(result.body.requiresVerification).toBe(true);
  });
  it('passes verified original image bytes to the model and records only metadata in the run', async () => {
    const { row } = await paired();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
    const storage = context.app.get(EvidenceStorage);
    const put = vi.spyOn(storage, 'put').mockResolvedValue();
    const get = vi.spyOn(storage, 'get').mockResolvedValue(bytes);
    const privateBucket = vi
      .spyOn(storage, 'ensurePrivate')
      .mockResolvedValue();
    try {
      const receipt = await transactions.uploadEvidenceFile(actor, row.id, {
        sourceKind: 'DEMO',
        sourceSystem: 'DEMO / MOCK image',
        externalReference: 'MOCK_IMAGE',
        retrievedAt: new Date().toISOString(),
        fileName: 'mock.png',
        mediaType: 'image/png',
        dataBase64: bytes.toString('base64'),
      });
      step
        .mockResolvedValueOnce(read(receipt.evidenceId))
        .mockImplementationOnce(async (messages) => {
          expect(messages.find((m) => m.image)?.image).toEqual({
            mediaType: 'image/png',
            base64: bytes.toString('base64'),
          });
          return finish({
            ...draft(),
            irrelevantEvidenceIds: [receipt.evidenceId],
          });
        });
      const response = await start(row.id).expect(201);
      expect(response.body.status).toBe('COMPLETED');
      expect(response.body.trace[0].outcome).toBe('IMAGE_ORIGINAL');
      const run = await db.investigationRun.findUniqueOrThrow({
        where: { id: response.body.id },
      });
      expect(JSON.stringify(run)).not.toContain(bytes.toString('base64'));
      expect(JSON.stringify(run.snapshot)).toContain(binaryHash(bytes));
    } finally {
      put.mockRestore();
      get.mockRestore();
      privateBucket.mockRestore();
    }
  });
  it('reports PDF extraction as unsupported instead of pretending to inspect it', async () => {
    const { row } = await paired();
    const storage = context.app.get(EvidenceStorage);
    const put = vi.spyOn(storage, 'put').mockResolvedValue();
    const download = vi.spyOn(transactions, 'downloadEvidenceFile');
    try {
      const receipt = await transactions.uploadEvidenceFile(actor, row.id, {
        sourceKind: 'DEMO',
        sourceSystem: 'DEMO / MOCK PDF',
        externalReference: 'MOCK_PDF',
        retrievedAt: new Date().toISOString(),
        fileName: 'mock.pdf',
        mediaType: 'application/pdf',
        dataBase64: Buffer.from('%PDF-1.7\nMOCK').toString('base64'),
      });
      step
        .mockResolvedValueOnce(read(receipt.evidenceId))
        .mockResolvedValueOnce(finish());
      const response = await start(row.id).expect(201);
      expect(response.body.status).toBe('COMPLETED');
      expect(response.body.trace[0].outcome).toBe('UNSUPPORTED_PDF');
      expect(download).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
      download.mockRestore();
    }
  });
  it('honors merchant revocation before publishing a completed result', async () => {
    const { row } = await paired();
    step.mockImplementationOnce(async () => {
      await merchants.updateSettings(actor, { allowInvestigations: false });
      return finish();
    });
    try {
      expect((await start(row.id).expect(201)).body).toMatchObject({
        status: 'FAILED',
        errorCode: 'MERCHANT_ACTION_DISABLED',
        result: null,
      });
    } finally {
      await merchants.updateSettings(actor, { allowInvestigations: true });
    }
  });
  it('recovers an expired lease on retry without making a model call', async () => {
    const { row, snapshot } = await paired();
    const key = randomUUID();
    await db.investigationRun.create({
      data: {
        merchantId,
        transactionId: row.id,
        actorUserId: adminId,
        idempotencyKey: key,
        provider: 'NVIDIA',
        model: 'MOCK',
        promptVersion: 'MOCK',
        evidenceRevision: snapshot.dossier.revision,
        snapshot: JSON.parse(JSON.stringify(snapshot)),
        snapshotHash: contentHash(snapshot),
        trace: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect((await start(row.id, key).expect(201)).body).toMatchObject({
      status: 'FAILED',
      errorCode: 'INVESTIGATION_TIMEOUT',
      result: null,
    });
    expect(step).not.toHaveBeenCalled();
  });
  it('detects tampering in stored investigation results', async () => {
    const { row } = await paired();
    step.mockResolvedValueOnce(finish());
    const response = await start(row.id).expect(201);
    await db.investigationRun.update({
      where: { id: response.body.id },
      data: { result: { ...draft(), summary: 'MOCK tampered' } },
    });
    await http()
      .get(endpoint(row.id) + '/' + response.body.id)
      .auth(adminToken, { type: 'bearer' })
      .expect(409);
  });
  it('keeps M05 merchant-scoped with RLS and composite foreign keys', async () => {
    const { row } = await paired();
    step.mockResolvedValueOnce(finish());
    const response = await start(row.id).expect(201);
    const stored = await db.investigationRun.findUniqueOrThrow({
      where: { id: response.body.id },
    });
    await expect(
      db.investigationRun.create({
        data: {
          id: randomUUID(),
          merchantId: otherMerchantId,
          transactionId: row.id,
          actorUserId: adminId,
          idempotencyKey: randomUUID(),
          provider: 'NVIDIA',
          model: 'MOCK',
          promptVersion: 'MOCK',
          evidenceRevision: stored.evidenceRevision,
          snapshot: {},
          snapshotHash: contentHash({}),
          trace: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          expiresAt: new Date(Date.now() + 10000),
        },
      }),
    ).rejects.toThrow();
    const rls = await db.$queryRaw<
      Array<{ enabled: boolean }>
    >`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='investigation_runs'::regclass`;
    expect(rls[0]?.enabled).toBe(true);
  });
  it('requires audited ADMIN review after rejection, across keys and investigations (MOCK verifier)', async () => {
    await merchants.updateSettings(actor, { allowInvestigations: true });
    const { row, payment } = await paired();
    step.mockResolvedValue(finish(draft()));
    const inv = (await start(row.id).expect(201)).body;
    const vpath = endpoint(row.id) + '/' + inv.id + '/verifications';
    const check = {
      status: 'FAIL',
      explanation: 'Explicit MOCK rejection',
      evidenceIds: [payment.id],
    };
    const rejected = VerificationResultSchema.parse({
      verdict: 'REJECTED',
      verifiedEvidenceIds: [payment.id],
      missingRequirements: [],
      contradictions: ['MOCK_CONFLICT'],
      reasons: [
        {
          code: 'MOCK_CONFLICT',
          explanation: 'MOCK',
          evidenceIds: [payment.id],
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
        ].map((k) => [k, check]),
      ),
      claims: [],
    });
    const engine = vi
      .spyOn(context.app.get(VerifierEngine), 'execute')
      .mockResolvedValue(rejected);
    const post = (path: string, body: object) =>
      http().post(path).auth(adminToken, { type: 'bearer' }).send(body);
    try {
      await http()
        .post(vpath)
        .send({ idempotencyKey: randomUUID() })
        .expect(401);
      await http()
        .post(vpath)
        .auth(viewerToken, { type: 'bearer' })
        .send({ idempotencyKey: randomUUID() })
        .expect(403);
      const key = randomUUID();
      const first = (await post(vpath, { idempotencyKey: key }).expect(201))
        .body;
      expect(first.result.verdict).toBe('REJECTED');
      expect(
        (await post(vpath, { idempotencyKey: key }).expect(201)).body.id,
      ).toBe(first.id);
      expect(engine).toHaveBeenCalledTimes(1);
      const blocked = await post(vpath, {
        idempotencyKey: randomUUID(),
      }).expect(409);
      expect(blocked.body.code).toBe('VERIFICATION_REJECTION_REVIEW_REQUIRED');
      const secondInv = (await start(row.id).expect(201)).body;
      await post(endpoint(row.id) + '/' + secondInv.id + '/verifications', {
        idempotencyKey: randomUUID(),
      }).expect(409);
      await post(vpath, {
        idempotencyKey: randomUUID(),
        rejectionReview: {
          verificationId: randomUUID(),
          justification: 'Explicit MOCK administrator review',
        },
      }).expect(409);
      await post(vpath, {
        idempotencyKey: randomUUID(),
        rejectionReview: { verificationId: first.id, justification: 'short' },
      }).expect(400);
      const reviewed = (
        await post(vpath, {
          idempotencyKey: randomUUID(),
          rejectionReview: {
            verificationId: first.id,
            justification:
              'Explicit MOCK administrator review of rejected case',
          },
        }).expect(201)
      ).body;
      expect(reviewed.rejectionReview).toMatchObject({
        verificationId: first.id,
        actorUserId: adminId,
      });
      expect(reviewed.result.verdict).toBe('REJECTED');
      expect(
        await db.auditEvent.count({
          where: {
            merchantId,
            resourceId: first.id,
            action: 'VERIFICATION_STARTED',
          },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            merchantId,
            resourceId: first.id,
            action: 'VERIFICATION_FINISHED',
          },
        }),
      ).toBe(1);
      expect(
        await db.auditEvent.findFirst({
          where: {
            merchantId,
            resourceId: reviewed.id,
            action: 'VERIFICATION_FINISHED',
          },
        }),
      ).toMatchObject({
        module: 'M06',
        record: { details: { verdict: 'REJECTED' } },
      });
      const stored = await db.verificationRun.findUniqueOrThrow({
        where: { id: reviewed.id },
      });
      expect(contentHash(stored.snapshot)).toBe(stored.snapshotHash);
      expect(engine).toHaveBeenCalledTimes(2);
      await post(vpath, {
        idempotencyKey: randomUUID(),
        rejectionReview: {
          verificationId: first.id,
          justification: 'Explicit MOCK outdated rejection review',
        },
      }).expect(409);
    } finally {
      engine.mockRestore();
    }
  });
});
