import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  DisputeDetailSchema,
  DisputeListResponseSchema,
} from '@resolve-ai/contracts';
import { createApp } from '../../src/application.js';
import { PrismaService } from '../../src/common/database/prisma.service.js';
import { DisputesService } from '../../src/modules/disputes/index.js';
import { TransactionsService } from '../../src/modules/transactions/index.js';
import { createMockAuth } from '../fixtures/auth.js';
import { captureEvent } from '../fixtures/capture.js';
import { disputeEvent } from '../fixtures/dispute.js';
import { mockTransmissionHeaders } from '../fixtures/paypal-webhook.js';

describe('M07: verified dispute deliveries → linked transactions → authorized HTTP (real PostgreSQL, MOCK PayPal/JWKS)', () => {
  const merchantId = randomUUID();
  const otherMerchantId = randomUUID();
  const userId = randomUUID();
  let context: Awaited<ReturnType<typeof createApp>>;
  let issuer: Awaited<ReturnType<typeof createMockAuth>>;
  let prisma: PrismaService;
  let disputes: DisputesService;
  let transactions: TransactionsService;
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
    disputes = context.app.get(DisputesService);
    transactions = context.app.get(TransactionsService);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        displayName: 'DEMO / MOCK M07',
        members: { create: { authUserId: userId, role: 'VIEWER' } },
      },
    });
    const otherUserId = randomUUID();
    await prisma.merchant.create({
      data: {
        id: otherMerchantId,
        displayName: 'DEMO / MOCK M07 OTHER',
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
      await prisma.disputeEvent.deleteMany({ where: { dispute: where } });
      await prisma.dispute.deleteMany({ where });
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
  const nextDispute = () => disputes.processNextDispute(merchantId);

  it('consumes a dispute, links the captured transaction, and exposes exact states to VIEWER', async () => {
    await deliver(captureEvent('MOCK-CAPTURE'));
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    const transaction = await prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: 'MOCK-CAPTURE' },
    });

    const receipt = await deliver(disputeEvent());
    expect(await nextDispute()).toBe('COMPLETED');
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: receipt.jobId } }),
    ).toMatchObject({
      kind: 'DISPUTE_CHANGED',
      status: 'COMPLETED',
      errorCode: null,
      finishedAt: expect.any(Date),
    });

    const row = await prisma.dispute.findUniqueOrThrow({
      where: { sourceEventId: receipt.eventId },
    });
    expect(row).toMatchObject({
      merchantId,
      paypalDisputeId: 'PP-D-MOCK',
      paypalStatus: 'OPEN',
      paypalStage: 'INQUIRY',
      paypalOutcome: null,
      reasonCategory: 'ITEM_NOT_RECEIVED',
      internalState: 'LINKED',
      linkStatus: 'LINKED',
      linkReason: null,
      transactionId: transaction.id,
    });
    expect(row.amount?.toFixed()).toBe('10.25');
    expect(row.currencyCode).toBe('USD');

    const result = await request(context.app.getHttpServer())
      .get('/api/disputes')
      .auth(token, { type: 'bearer' })
      .expect(200);
    const list = DisputeListResponseSchema.parse(result.body);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: row.id,
      internalState: 'LINKED',
      link: { status: 'LINKED', transactionId: transaction.id },
    });
    expect(result.body).not.toHaveProperty('payload');

    const detail = await request(context.app.getHttpServer())
      .get(`/api/disputes/${row.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const parsed = DisputeDetailSchema.parse(detail.body);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      eventType: 'CUSTOMER.DISPUTE.CREATED',
      outcome: 'APPLIED',
      reason: null,
    });
  });

  it('is idempotent for repeated content and ignores older reordered updates', async () => {
    await deliver(
      disputeEvent({
        eventType: 'CUSTOMER.DISPUTE.UPDATED',
        eventId: 'MOCK-DISPUTE-UPDATED-1',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        occurredAt: '2026-11-07T00:00:00Z',
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');
    await deliver(
      disputeEvent({
        eventType: 'CUSTOMER.DISPUTE.UPDATED',
        eventId: 'MOCK-DISPUTE-UPDATED-2',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        occurredAt: '2026-11-08T00:00:00Z',
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');
    await deliver(
      disputeEvent({
        eventType: 'CUSTOMER.DISPUTE.UPDATED',
        eventId: 'MOCK-DISPUTE-STALE',
        status: 'UNDER_REVIEW',
        occurredAt: '2026-11-05T00:00:00Z',
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');

    const row = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId: 'PP-D-MOCK' },
    });
    expect(row.paypalStatus).toBe('WAITING_FOR_SELLER_RESPONSE');
    // Timeline order is by PayPal occurredAt, so the reordered event sorts
    // first; assert outcomes independently of that presentation order.
    const events = await prisma.disputeEvent.findMany({
      where: { disputeId: row.id },
    });
    expect(events).toHaveLength(4);
    expect(events.filter((event) => event.outcome === 'APPLIED')).toHaveLength(
      2,
    );
    expect(
      events.filter((event) => event.outcome === 'IGNORED_DUPLICATE'),
    ).toHaveLength(1);
    const stale = events.filter((event) => event.outcome === 'IGNORED_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toBe('EVENT_OLDER_THAN_LAST_APPLIED');
    expect(stale[0]?.occurredAt.toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('records the official resolution without guessing a winner', async () => {
    await deliver(
      disputeEvent({
        eventType: 'CUSTOMER.DISPUTE.RESOLVED',
        eventId: 'MOCK-DISPUTE-RESOLVED-1',
        status: 'RESOLVED',
        outcome: 'RESOLVED_SELLER_FAVOUR',
        occurredAt: '2026-11-09T00:00:00Z',
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');
    const row = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId: 'PP-D-MOCK' },
    });
    expect(row).toMatchObject({
      paypalStatus: 'RESOLVED',
      paypalOutcome: 'RESOLVED_SELLER_FAVOUR',
      internalState: 'RESOLVED_WON',
      linkStatus: 'LINKED',
    });
  });

  it('keeps unmatched disputes in NEEDS_REVIEW instead of inventing a link', async () => {
    await deliver(
      disputeEvent({
        disputeId: 'PP-D-UNMATCHED',
        eventId: 'MOCK-DISPUTE-UNMATCHED',
        sellerTransactionIds: ['MOCK-MISSING'],
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');
    const row = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId: 'PP-D-UNMATCHED' },
    });
    expect(row).toMatchObject({
      internalState: 'NEEDS_REVIEW',
      linkStatus: 'UNLINKED',
      linkReason: 'TRANSACTION_NOT_FOUND',
      transactionId: null,
    });

    const filtered = await disputes.list(merchantId, {
      page: 1,
      pageSize: 20,
      internalState: 'NEEDS_REVIEW',
    });
    expect(
      filtered.items.some((item) => item.paypalDisputeId === 'PP-D-UNMATCHED'),
    ).toBe(true);
  });

  it('flags a resolved event without an official outcome', async () => {
    await deliver(
      disputeEvent({
        disputeId: 'PP-D-NO-OUTCOME',
        eventId: 'MOCK-DISPUTE-NO-OUTCOME',
        eventType: 'CUSTOMER.DISPUTE.RESOLVED',
        status: 'RESOLVED',
        outcome: null,
        occurredAt: '2026-11-10T00:00:00Z',
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');
    const row = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId: 'PP-D-NO-OUTCOME' },
    });
    expect(row).toMatchObject({
      paypalStatus: 'RESOLVED',
      paypalOutcome: null,
      internalState: 'NEEDS_REVIEW',
      linkStatus: 'LINKED',
      linkReason: 'RESOLVED_WITHOUT_OUTCOME',
    });
  });

  it('refuses to replace an established link with a different capture', async () => {
    await deliver(
      disputeEvent({
        disputeId: 'PP-D-FLIP',
        eventId: 'MOCK-FLIP-CREATED',
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');
    const first = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId: 'PP-D-FLIP' },
    });
    const originalTransaction = await prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: 'MOCK-CAPTURE' },
    });
    expect(first.transactionId).toBe(originalTransaction.id);

    await deliver(captureEvent('MOCK-CAPTURE-2'));
    expect(await transactions.processNextCapture(merchantId)).toBe('COMPLETED');
    const secondTransaction = await prisma.transaction.findFirstOrThrow({
      where: { merchantId, paypalCaptureId: 'MOCK-CAPTURE-2' },
    });

    await deliver(
      disputeEvent({
        disputeId: 'PP-D-FLIP',
        eventId: 'MOCK-FLIP-UPDATED',
        eventType: 'CUSTOMER.DISPUTE.UPDATED',
        sellerTransactionIds: ['MOCK-CAPTURE-2'],
        occurredAt: '2026-11-11T00:00:00Z',
      }),
    );
    expect(await nextDispute()).toBe('COMPLETED');
    const flipped = await prisma.dispute.findFirstOrThrow({
      where: { merchantId, paypalDisputeId: 'PP-D-FLIP' },
    });
    expect(flipped).toMatchObject({
      internalState: 'NEEDS_REVIEW',
      linkStatus: 'CONFLICT',
      linkReason: 'TRANSACTION_REFERENCE_CHANGED',
      transactionId: originalTransaction.id,
    });
    expect(flipped.transactionId).not.toBe(secondTransaction.id);
  });

  it('marks malformed dispute jobs FAILED and continues with valid work', async () => {
    const malformed = disputeEvent({
      disputeId: 'PP-D-BAD',
      eventId: 'MOCK-DISPUTE-BAD',
    });
    (malformed as { resource: unknown }).resource = { dispute_id: 'PP-D-BAD' };
    const receipt = await deliver(malformed);
    expect(await nextDispute()).toBe('FAILED');
    expect(
      await prisma.ingestionJob.findUnique({ where: { id: receipt.jobId } }),
    ).toMatchObject({ status: 'FAILED', errorCode: 'INVALID_DISPUTE' });
    expect(
      await prisma.dispute.count({
        where: { merchantId, paypalDisputeId: 'PP-D-BAD' },
      }),
    ).toBe(0);
  });

  it('isolates list/detail by merchant and validates pagination/IDs', async () => {
    const row = await prisma.dispute.findFirstOrThrow({
      where: { merchantId },
    });
    expect(
      await disputes.list(otherMerchantId, { page: 1, pageSize: 20 }),
    ).toMatchObject({ items: [], total: 0 });
    await expect(disputes.detail(otherMerchantId, row.id)).rejects.toThrow(
      'Dispute not found',
    );
    await request(context.app.getHttpServer())
      .get(`/api/disputes/${row.id}`)
      .auth(otherToken, { type: 'bearer' })
      .expect(403);
    await request(context.app.getHttpServer())
      .get(`/api/disputes/${randomUUID()}`)
      .auth(token, { type: 'bearer' })
      .expect(404);
    await request(context.app.getHttpServer())
      .get('/api/disputes/invalid')
      .auth(token, { type: 'bearer' })
      .expect(400);
    await request(context.app.getHttpServer())
      .get('/api/disputes?pageSize=101')
      .auth(token, { type: 'bearer' })
      .expect(400);
    await request(context.app.getHttpServer()).get('/api/disputes').expect(401);

    const result = await request(context.app.getHttpServer())
      .get('/api/disputes?internalState=NEEDS_REVIEW&pageSize=1')
      .auth(token, { type: 'bearer' })
      .expect(200);
    const page = DisputeListResponseSchema.parse(result.body);
    expect(page.pageSize).toBe(1);
    expect(
      page.items.every((item) => item.internalState === 'NEEDS_REVIEW'),
    ).toBe(true);
  });

  it('enables RLS on M07 storage', async () => {
    for (const table of ['disputes', 'dispute_events']) {
      const rows = await prisma.$queryRaw<
        Array<{ relrowsecurity: boolean }>
      >`SELECT relrowsecurity FROM pg_class WHERE oid = ${table}::regclass`;
      expect(rows).toEqual([{ relrowsecurity: true }]);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      const visible = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM disputes`;
      expect(visible[0]?.count).toBe(0n);
    });
  });
});
