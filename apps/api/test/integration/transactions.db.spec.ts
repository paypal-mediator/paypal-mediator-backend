import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  TransactionListResponseSchema,
  TransactionResponseSchema,
} from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import {
  IngestionQueueService,
  IngestionRejection,
} from '../../src/modules/event-ingestion/index.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import {
  mockTransmissionHeaders,
  mockWebhookEvent,
} from '../fixtures/paypal-webhook.js';

describe('M03: verified M02 deliveries → captures → authorized HTTP (real PostgreSQL, MOCK PayPal/JWKS)', () => {
  const merchantId = randomUUID();
  const otherMerchantId = randomUUID();
  const userId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>;
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let prisma: PrismaService;
  let transactions: TransactionsService;
  let queue: IngestionQueueService;
  let token: string;
  let otherToken: string;

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
      if (url.endsWith('/v1/notifications/verify-webhook-signature'))
        return Response.json({ verification_status: 'SUCCESS' });
      throw new Error('Unexpected MOCK PayPal call');
    });
    issuer = await createMockAuth();
    context = await createApp(
      {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        MERCHANT_ID: merchantId,
        SUPABASE_URL: issuer.origin,
        PAYPAL_CLIENT_ID: 'MOCK_CLIENT',
        PAYPAL_CLIENT_SECRET: 'MOCK_SECRET',
        PAYPAL_WEBHOOK_ID: 'MOCK_WEBHOOK',
      },
      false,
    );
    await context.app.init();
    prisma = context.app.get(PrismaService);
    transactions = context.app.get(TransactionsService);
    queue = context.app.get(IngestionQueueService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'DEMO / MOCK M03',
        members: { create: { authUserId: userId, role: 'VIEWER' } },
      },
    });
    const otherUserId = randomUUID();
    await prisma.merchant.create({
      data: {
        id: otherMerchantId,
        displayName: 'DEMO / MOCK OTHER',
        members: { create: { authUserId: otherUserId } },
      },
    });
    token = await issuer.token(userId);
    otherToken = await issuer.token(otherUserId);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (prisma) {
      const where = { merchantId: { in: [merchantId, otherMerchantId] } };
      await prisma.evidenceItem.deleteMany({ where: { dossier: where } });
      await prisma.evidenceDossier.deleteMany({ where });
      await prisma.transaction.deleteMany({ where });
      await prisma.merchantOrder.deleteMany({ where });
      await prisma.ingestionJob.deleteMany({ where: { event: where } });
      await prisma.webhookEvent.deleteMany({ where });
      await prisma.merchantMember.deleteMany({ where });
      await prisma.merchant.deleteMany({
        where: { id: { in: [merchantId, otherMerchantId] } },
      });
    }
    await context?.app.close();
    await issuer?.close();
  });

  const deliver = async (event: object) => {
    const result = await request(context.app.getHttpServer())
      .post('/api/webhooks/paypal')
      .set(mockTransmissionHeaders)
      .send(event)
      .expect(200);
    return result.body as { eventId: string; jobId: string };
  };
  const next = () => transactions.processNextCapture(merchantId);

  it('consumes a verified event, exposes exact payment data to VIEWER, and reports missing documents', async () => {
    const receipt = await deliver(captureEvent());
    expect(await next()).toBe('COMPLETED');
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: receipt.jobId } }),
    ).toMatchObject({
      status: 'COMPLETED',
      errorCode: null,
      finishedAt: expect.any(Date),
    });
    const row = await prisma.transaction.findUniqueOrThrow({
      where: { sourceEventId: receipt.eventId },
    });
    const result = await request(context.app.getHttpServer())
      .get(`/api/transactions/${row.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const detail = TransactionResponseSchema.parse(result.body);
    expect(detail.amount).toEqual({ value: '10.25', currencyCode: 'USD' });
    expect(detail.sourceEventId).toBe(receipt.eventId);
    expect(detail.readiness).toMatchObject({
      status: 'INCOMPLETE',
      checks: [
        { code: 'PAYMENT_RECORD', status: 'PRESENT' },
        { code: 'ORDER_REFERENCE', status: 'PRESENT' },
        { code: 'ORDER_RECORD', status: 'MISSING' },
        { code: 'TRACKING', status: 'MISSING' },
        { code: 'PROOF_OF_DELIVERY', status: 'MISSING' },
      ],
    });
    expect(result.body).not.toHaveProperty('payload');
  });

  it('deduplicates both repeated delivery and new event IDs for the same capture under concurrency', async () => {
    const event = captureEvent('MOCK-CONCURRENT');
    await deliver(event);
    await deliver(event);
    await deliver({ ...event, id: `MOCK-${randomUUID()}` });
    expect(await Promise.all([next(), next()])).toEqual([
      'COMPLETED',
      'COMPLETED',
    ]);
    expect(
      await prisma.transaction.count({
        where: { merchantId, paypalCaptureId: 'MOCK-CONCURRENT' },
      }),
    ).toBe(1);
    expect(await next()).toBe('EMPTY');
  });

  it('rejects conflicting captures without overwriting originals', async () => {
    const event = captureEvent('MOCK-CONCURRENT');
    event.resource.amount.value = '99.99';
    const receipt = await deliver(event);
    expect(await next()).toBe('FAILED');
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: receipt.jobId } }),
    ).toMatchObject({ status: 'FAILED', errorCode: 'CAPTURE_CONFLICT' });
    const row = await prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: 'MOCK-CONCURRENT' },
    });
    expect(row.amount.toFixed()).toBe('10.25');
  });

  it('marks malformed capture jobs FAILED and continues with valid work', async () => {
    const bad = await deliver(mockWebhookEvent());
    await deliver(captureEvent('MOCK-AFTER-INVALID'));
    expect(await next()).toBe('FAILED');
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: bad.jobId } }),
    ).toMatchObject({ errorCode: 'INVALID_CAPTURE' });
    expect(await next()).toBe('COMPLETED');
    expect(
      await prisma.transaction.count({ where: { sourceEventId: bad.eventId } }),
    ).toBe(0);
  });

  it('rolls back payment and job together on unexpected failure and allows retry', async () => {
    const event = captureEvent('MOCK-ROLLBACK');
    const receipt = await deliver(event);
    await expect(
      queue.processNext(
        'TRANSACTION_CAPTURED',
        merchantId,
        async (delivery, tx) => {
          await tx.transaction.create({
            data: {
              merchantId,
              sourceEventId: delivery.eventId,
              paypalCaptureId: event.resource.id,
              currencyCode: 'USD',
              amount: '10.25',
              capturedAt: new Date(),
            },
          });
          throw new Error('MOCK_DATABASE_FAILURE');
        },
      ),
    ).rejects.toThrow('MOCK_DATABASE_FAILURE');
    expect(
      await prisma.transaction.count({
        where: { sourceEventId: receipt.eventId },
      }),
    ).toBe(0);
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: receipt.jobId } }),
    ).toMatchObject({ status: 'QUEUED', finishedAt: null });
    expect(await next()).toBe('COMPLETED');
  });

  it('leaves dispute jobs queued for M07', async () => {
    const receipt = await deliver(mockWebhookEvent('CUSTOMER.DISPUTE.CREATED'));
    expect(await next()).toBe('EMPTY');
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: receipt.jobId } }),
    ).toMatchObject({ kind: 'DISPUTE_CHANGED', status: 'QUEUED' });
  });

  it('rolls back consumer writes before recording a terminal rejection', async () => {
    const receipt = await deliver(captureEvent('MOCK-SAVEPOINT'));
    expect(
      await queue.processNext(
        'TRANSACTION_CAPTURED',
        merchantId,
        async (delivery, tx) => {
          await tx.transaction.create({
            data: {
              merchantId,
              sourceEventId: delivery.eventId,
              paypalCaptureId: 'MOCK-SAVEPOINT',
              currencyCode: 'USD',
              amount: '1',
              capturedAt: new Date(),
            },
          });
          throw new IngestionRejection('CAPTURE_CONFLICT');
        },
      ),
    ).toBe('FAILED');
    expect(
      await prisma.transaction.count({
        where: { sourceEventId: receipt.eventId },
      }),
    ).toBe(0);
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: receipt.jobId } }),
    ).toMatchObject({ status: 'FAILED', errorCode: 'CAPTURE_CONFLICT' });
  });

  it('isolates detail/list by merchant and validates pagination/IDs', async () => {
    const row = await prisma.transaction.findFirstOrThrow({
      where: { merchantId },
    });
    expect(
      await transactions.list(otherMerchantId, { page: 1, pageSize: 20 }),
    ).toMatchObject({ items: [], total: 0 });
    await expect(transactions.detail(otherMerchantId, row.id)).rejects.toThrow(
      'Transaction not found',
    );
    await request(context.app.getHttpServer())
      .get(`/api/transactions/${row.id}`)
      .auth(otherToken, { type: 'bearer' })
      .expect(403);
    await request(context.app.getHttpServer())
      .get(`/api/transactions/${randomUUID()}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    await request(context.app.getHttpServer())
      .get('/api/transactions/invalid')
      .auth(token, { type: 'bearer' })
      .expect(400);
    await request(context.app.getHttpServer())
      .get('/api/transactions?pageSize=101')
      .auth(token, { type: 'bearer' })
      .expect(400);
    const result = await request(context.app.getHttpServer())
      .get('/api/transactions?paypalCaptureId=MOCK-CAPTURE&pageSize=1')
      .auth(token, { type: 'bearer' })
      .expect(200);
    const page = TransactionListResponseSchema.parse(result.body);
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.paypalCaptureId).toBe('MOCK-CAPTURE');
  });

  it('enables RLS on M03 storage', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean }>
    >`SELECT relrowsecurity FROM pg_class WHERE oid = 'transactions'::regclass`;
    expect(rows).toEqual([{ relrowsecurity: true }]);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      const visible = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM transactions`;
      expect(visible[0]?.count).toBe(0n);
    });
  });
});
