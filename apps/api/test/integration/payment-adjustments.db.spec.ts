import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { AuditService } from '../../src/modules/monitoring/audit.service.js';
import { captureEvent, paymentAdjustmentEvent } from '../fixtures/capture.js';
import { mockTransmissionHeaders } from '../fixtures/paypal-webhook.js';
import { createMockAuth } from '../fixtures/auth.js';

describe('Refunds/reversals: real PostgreSQL, M02/M03/M04 and HTTP; MOCK PayPal/identity', () => {
  const merchantId = randomUUID(),
    userId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>;
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let prisma: PrismaService, transactions: TransactionsService;
  let token: string;
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('Disposable TEST_DATABASE_URL is required');
    issuer = await createMockAuth();
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api-m.sandbox.paypal.com/'))
        return nativeFetch(input, init);
      if (url.endsWith('/oauth2/token'))
        return Response.json({
          access_token: 'MOCK',
          token_type: 'Bearer',
          expires_in: 300,
        });
      if (url.endsWith('/verify-webhook-signature'))
        return Response.json({ verification_status: 'SUCCESS' });
      throw new Error('Unexpected provider call');
    });
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK',
        PAYPAL_CLIENT_SECRET: 'MOCK',
        PAYPAL_WEBHOOK_ID: 'MOCK',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    transactions = context.app.get(TransactionsService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'MOCK refunds',
        members: { create: { authUserId: userId, role: 'ADMIN' } },
      },
    });
    token = await issuer.token(userId);
  });
  afterAll(async () => {
    await context?.app.close();
    await issuer?.close();
    vi.restoreAllMocks();
    // Preserve history; the whole database is disposable.
  });
  const deliver = (event: object) =>
    request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event);
  const createCapture = async (id = `MOCK-${randomUUID()}`) => {
    await deliver(captureEvent(id)).expect(200);
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    return prisma.transaction.findUniqueOrThrow({
      where: {
        merchantId_environment_paypalCaptureId: {
          merchantId,
          environment: 'sandbox',
          paypalCaptureId: id,
        },
      },
    });
  };
  const adjust = async (event: object) => {
    const receipt = (await deliver(event).expect(200)).body;
    expect(receipt.outcome).toBe('ACCEPTED');
    expect(await transactions.processNextAdjustment(merchantId)).toBe(
      'COMPLETED',
    );
    return receipt;
  };
  const detail = async (id: string) =>
    (
      await request(context.app.getHttpServer())
        .get(`/api/transactions/${id}`)
        .auth(token, { type: 'bearer' })
        .expect(200)
    ).body;

  it('keeps exact partial/full refunds, cumulative totals and out-of-order notifications without double counting', async () => {
    const row = await createCapture();
    const before = (await detail(row.id)).readiness.evidenceRevision;
    const first = paymentAdjustmentEvent(row.paypalCaptureId, 'MOCK-REFUND-1');
    await adjust(first);
    const partial = await detail(row.id);
    expect(partial).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      amount: { value: '10.25' },
      financialSummary: {
        returnedAmount: '2.1',
        remainingAmount: '8.15',
        requiresReview: false,
      },
    });
    expect(partial.readiness.evidenceRevision).toBeGreaterThan(before);
    const reportedUpdate = paymentAdjustmentEvent(
      row.paypalCaptureId,
      'MOCK-REFUND-1',
      '2.10',
      '4.10',
    );
    await adjust(reportedUpdate);
    await adjust({ ...first, id: `MOCK-${randomUUID()}` });
    expect((await detail(row.id)).financialSummary.returnedAmount).toBe('4.1');
    await adjust(
      paymentAdjustmentEvent(
        row.paypalCaptureId,
        'MOCK-REFUND-3',
        '3.15',
        '10.25',
      ),
    );
    expect(await detail(row.id)).toMatchObject({
      status: 'REFUNDED',
      financialSummary: { returnedAmount: '10.25', remainingAmount: '0' },
    });
    await adjust(
      paymentAdjustmentEvent(
        row.paypalCaptureId,
        'MOCK-REFUND-2',
        '5.00',
        '7.10',
      ),
    );
    const complete = await detail(row.id);
    expect(complete.status).toBe('REFUNDED');
    expect((await deliver(first).expect(200)).body.outcome).toBe('DUPLICATE');
    await adjust({ ...first, id: `MOCK-${randomUUID()}` });
    expect((await detail(row.id)).readiness.evidenceRevision).toBe(
      complete.readiness.evidenceRevision,
    );
    expect(
      await prisma.paymentAdjustment.count({
        where: { merchantId, paypalCaptureId: row.paypalCaptureId },
      }),
    ).toBe(3);
  });

  it('handles partial and full reversals, including a refund and reversal for the same resource', async () => {
    const row = await createCapture();
    const first = paymentAdjustmentEvent(
      row.paypalCaptureId,
      'MOCK-SAME-RESOURCE',
      '3.00',
    );
    await adjust(first);
    await adjust({
      ...first,
      id: `MOCK-${randomUUID()}`,
      event_type: 'PAYMENT.CAPTURE.REVERSED',
    });
    expect(await detail(row.id)).toMatchObject({
      status: 'PARTIALLY_REVERSED',
      financialSummary: { returnedAmount: '3', remainingAmount: '7.25' },
    });
    await adjust(
      paymentAdjustmentEvent(
        row.paypalCaptureId,
        'MOCK-REVERSAL-REST',
        '7.25',
        '10.25',
        true,
      ),
    );
    expect(await detail(row.id)).toMatchObject({
      status: 'REVERSED',
      financialSummary: { returnedAmount: '10.25', remainingAmount: '0' },
    });
    // An older refund notification cannot downgrade the reversal or reset the payment.
    await adjust({ ...first, id: `MOCK-${randomUUID()}` });
    await deliver({
      ...captureEvent(row.paypalCaptureId),
      id: `MOCK-${randomUUID()}`,
    }).expect(200);
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    expect((await detail(row.id)).status).toBe('REVERSED');
  });

  it('reconciles a stored adjustment when the capture is processed later', async () => {
    const id = `MOCK-${randomUUID()}`;
    await adjust(paymentAdjustmentEvent(id, 'MOCK-EARLY-REFUND'));
    const row = await createCapture(id);
    expect(await detail(row.id)).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      financialSummary: { returnedAmount: '2.1' },
    });
  });

  it('flags over-refunds and currency conflicts without inventing a remaining balance', async () => {
    const row = await createCapture();
    await adjust(
      paymentAdjustmentEvent(row.paypalCaptureId, 'MOCK-OVER-REFUND', '11.00'),
    );
    expect(await detail(row.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      financialSummary: {
        returnedAmount: '11',
        remainingAmount: null,
        requiresReview: true,
      },
    });
    const captureId = `MOCK-${randomUUID()}`;
    const wrongCurrency = paymentAdjustmentEvent(
      captureId,
      'MOCK-EARLY-CURRENCY',
    );
    wrongCurrency.resource.amount.currency_code = 'EUR';
    wrongCurrency.resource.seller_payable_breakdown.total_refunded_amount.currency_code =
      'EUR';
    await adjust(wrongCurrency);
    const early = await createCapture(captureId);
    expect(await detail(early.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      financialSummary: { remainingAmount: null, requiresReview: true },
    });
  });

  it('serializes distinct deliveries of the same refund resource and rejects conflicting amounts', async () => {
    const row = await createCapture();
    const first = paymentAdjustmentEvent(
      row.paypalCaptureId,
      'MOCK-CONCURRENT-REFUND',
    );
    await deliver(first).expect(200);
    await deliver({ ...first, id: `MOCK-${randomUUID()}` }).expect(200);
    expect(
      await Promise.all([
        transactions.processNextAdjustment(merchantId),
        transactions.processNextAdjustment(merchantId),
      ]),
    ).toEqual(['COMPLETED', 'COMPLETED']);
    expect(await detail(row.id)).toMatchObject({
      financialSummary: { returnedAmount: '2.1' },
    });
    const conflict = paymentAdjustmentEvent(
      row.paypalCaptureId,
      'MOCK-CONCURRENT-REFUND',
      '4.20',
    );
    const receipt = (await deliver(conflict).expect(200)).body;
    expect(await transactions.processNextAdjustment(merchantId)).toBe('FAILED');
    expect(
      await prisma.ingestionJob.findUniqueOrThrow({
        where: { id: receipt.jobId },
      }),
    ).toMatchObject({ errorCode: 'PAYMENT_ADJUSTMENT_CONFLICT' });
    expect((await detail(row.id)).financialSummary.returnedAmount).toBe('2.1');
  });

  it('rolls back the movement, projection, evidence and job when audit persistence fails', async () => {
    const row = await createCapture();
    const before = await detail(row.id);
    const receipt = (
      await deliver(
        paymentAdjustmentEvent(row.paypalCaptureId, 'MOCK-ROLLBACK-REFUND'),
      ).expect(200)
    ).body;
    const audit = context.app.get(AuditService);
    const original = audit.append.bind(audit);
    const spy = vi.spyOn(audit, 'append').mockImplementation((input, tx) => {
      if (input.record.action === 'TRANSACTION_ADJUSTED')
        throw new Error('MOCK_AUDIT_FAILURE');
      return original(input, tx);
    });
    try {
      await expect(
        transactions.processNextAdjustment(merchantId),
      ).rejects.toThrow('MOCK_AUDIT_FAILURE');
    } finally {
      spy.mockRestore();
    }
    expect(
      await prisma.paymentAdjustment.count({
        where: { sourceEventId: receipt.eventId },
      }),
    ).toBe(0);
    expect((await detail(row.id)).readiness.evidenceRevision).toBe(
      before.readiness.evidenceRevision,
    );
    expect((await detail(row.id)).status).toBe('COMPLETED');
    expect(
      await prisma.ingestionJob.findUniqueOrThrow({
        where: { id: receipt.jobId },
      }),
    ).toMatchObject({ status: 'QUEUED' });
    expect(await transactions.processNextAdjustment(merchantId)).toBe(
      'COMPLETED',
    );
    expect(await transactions.processNextAdjustment(merchantId)).toBe('EMPTY');
  });

  it('keeps adjustment storage inaccessible to non-owner database roles', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      expect(
        await tx.$queryRaw`SELECT count(*) FROM payment_adjustments`,
      ).toEqual([{ count: 0n }]);
    });
  });

  it('preserves all 24 significant digits when computing partial and full returned amounts', async () => {
    const capture = captureEvent(`MOCK-${randomUUID()}`);
    capture.resource.amount.value = '9999999999999999.99999999';
    await deliver(capture).expect(200);
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    const row = await prisma.transaction.findUniqueOrThrow({
      where: {
        merchantId_environment_paypalCaptureId: {
          merchantId,
          environment: 'sandbox',
          paypalCaptureId: capture.resource.id,
        },
      },
    });
    await adjust(
      paymentAdjustmentEvent(
        capture.resource.id,
        'MOCK-PRECISE-REFUND-1',
        '9999999999999999.99999998',
      ),
    );
    expect(await detail(row.id)).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      financialSummary: {
        returnedAmount: '9999999999999999.99999998',
        remainingAmount: '0.00000001',
      },
    });
    await adjust(
      paymentAdjustmentEvent(
        capture.resource.id,
        'MOCK-PRECISE-REFUND-2',
        '0.00000001',
        '9999999999999999.99999999',
      ),
    );
    expect(await detail(row.id)).toMatchObject({
      status: 'REFUNDED',
      financialSummary: {
        returnedAmount: '9999999999999999.99999999',
        remainingAmount: '0',
      },
    });
  });
});
